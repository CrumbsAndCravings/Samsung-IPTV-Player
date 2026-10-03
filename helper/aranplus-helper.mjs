// The ARAN+ helper: runs on a computer at home and converts the videos a TV can't play
// (AVI files, DTS sound, HEVC on a Roku without it) into a stream it can, with FFmpeg,
// while you watch.
//
//   npm run helper        (or double-click helper\start-helper.cmd on Windows)
//
// It reads the provider login from personal.json, so the login never travels from the
// TV. The first run adds "transcoder" (this computer's address and a random key) to
// personal.json; build the TV app once more (npm run install:tv) so it knows them, and
// copy the same "transcoder" into the Roku app's src/source/account.json.
//
//   GET /                         is it running (no key needed)
//   GET /v1/info?key&kind&id&ext  what the file holds and how it would be converted
//   GET /v1/stream?key&kind&id&ext&start&video=copy|convert[&height&audio&track]
//                                 the file as one MPEG-TS stream, from `start` seconds
//                                 (the Samsung TV)
//   GET /v1/hls/index.m3u8?key&kind&id&ext&start&video[&height&audio&track]
//                                 the same as HLS (the Roku): a playlist naming the
//                                 session's own, s/<session>/index.m3u8
//   GET /v1/hls/s/<session>/<file>
//                                 a session's playlist and segments (no key needed:
//                                 the session's name is a random 32-digit secret)
//   GET /v1/subtitles.srt?key&src&start
//                                 an OpenSubtitles file (src) with its times moved
//                                 `start` seconds earlier, for a Roku stream from there
//   GET /v1/stop?key              the TV left: stop converting, free the provider
//   GET /v1/last-error?key        why the last stream failed, for the TV's error screen
//
// Options: height=<n> converts to at most n lines (the Roku's screen), audio=aac makes
// every sound track stereo AAC (a Roku without AC-3), track=<n> puts that sound track
// first (the viewer's language).
//
// The provider allows one connection at a time, so a new request stops the one before.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_USER_AGENT,
  ENCODERS,
  audioPlan,
  ffmpegArgs,
  masterPlaylist,
  outputSize,
  parseProbe,
  playlistState,
  providerUrl,
  readQuery,
  redactor,
  rewritePlaylist,
  sessionFile,
  shiftSubtitles,
  subtitleSource,
  videoPlan,
} from "./plan.mjs";

const VERSION = "1.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const DEFAULT_PORT = 8090;
const PROBE_TIMEOUT_MS = 30000;
const FIRST_BYTES_MS = 45000; // the provider can be slow to start a file
const FREE_SLOT_MS = 1200; // lets the provider notice the last connection closed
const INFO_TTL_MS = 6 * 3600 * 1000;
// HLS sessions: FFmpeg stops when nothing has asked for a session for 2 minutes. Its
// files go then too, except the newest session's, kept for 30 minutes so a long pause
// can pick up where it was.
const IDLE_STOP_MS = 2 * 60 * 1000;
const NEWEST_KEEP_MS = 30 * 60 * 1000;
const HLS_READY_SEGMENTS = 2;
const hlsRoot = path.join(os.tmpdir(), "aranplus-helper");
const ENCODER_NAMES = {
  h264_nvenc: "the NVIDIA graphics card",
  h264_qsv: "Intel Quick Sync",
  h264_amf: "the AMD graphics card",
  libx264: "the processor",
};

function fail(message) {
  console.error("\n" + message + "\n");
  process.exit(1);
}

// --- Settings -------------------------------------------------------------------------

function normalizeServer(raw) {
  let server = String(raw || "").trim();
  if (!server) return "";
  if (!/^https?:\/\//i.test(server)) server = "http://" + server;
  const slash = server.indexOf("/", server.indexOf("://") + 3);
  if (slash >= 0) server = server.slice(0, slash);
  return server.split("?")[0];
}

if (!existsSync(personalPath)) {
  fail(`There's no ${path.basename(personalPath)} in ${path.dirname(personalPath)}.\nCopy personal.example.json to personal.json and put your provider's login in it (server, username, password).`);
}
let personal;
try {
  personal = JSON.parse(readFileSync(personalPath, "utf8"));
} catch (err) {
  fail(`${path.basename(personalPath)} isn't valid JSON: ${err.message}`);
}
const login = {
  server: normalizeServer(personal.server),
  username: String(personal.username || "").trim(),
  password: String(personal.password || "").trim(),
};
if (!login.server || !login.username || !login.password) {
  fail(`${path.basename(personalPath)} needs your provider's login ("server", "username" and "password"); the helper fetches the videos with it.`);
}

// This computer's address on the home network, as the TV will reach it.
function lanAddress() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|wsl|hyper-v|loopback|docker/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      found.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || "127.0.0.1";
}

const address = lanAddress();
let settings = personal.transcoder && typeof personal.transcoder === "object" ? personal.transcoder : null;
let addedSettings = false;
if (!settings || !settings.url || !settings.key) {
  settings = { ...(settings || {}), url: `http://${address}:${DEFAULT_PORT}`, key: randomBytes(12).toString("hex") };
  personal.transcoder = settings;
  writeFileSync(personalPath, JSON.stringify(personal, null, 2) + "\n");
  addedSettings = true;
}
const port = Number(new URL(settings.url).port) || DEFAULT_PORT;
const key = String(settings.key);
const redact = redactor(login, key);
// How FFmpeg introduces itself to the provider: "userAgent" in "transcoder", "" for
// FFmpeg's own ("Lavf/..."), otherwise a desktop web browser.
const userAgent = typeof settings.userAgent === "string" ? settings.userAgent.trim() : BROWSER_USER_AGENT;
// "hwaccel": false keeps decoding on the processor.
const hwaccelWanted = settings.hwaccel !== false;

function say(...parts) {
  const time = new Date().toLocaleTimeString();
  console.log(time + "  " + redact(parts.join(" ")));
}

// --- FFmpeg ---------------------------------------------------------------------------

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, settings.ffmpeg, "ffmpeg"];
  // winget puts its links here, which a window opened before the install doesn't see.
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const run = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
    if (run.status === 0) return { path: candidate, version: (run.stdout || "").split("\n")[0].trim() };
  }
  return null;
}

const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  fail(
    "FFmpeg isn't installed (or this window started before it was).\n" +
      "On Windows: open PowerShell and run   winget install Gyan.FFmpeg\n" +
      "then open a new window and start the helper again.",
  );
}

// The fastest H.264 encoder that works here: a graphics card or Intel Quick Sync if
// there is one, otherwise the processor (fine for the standard-definition AVIs).
function pickEncoder() {
  const list = spawnSync(ffmpeg.path, ["-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true }).stdout || "";
  for (const name of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
    if (list.indexOf(" " + name + " ") < 0) continue;
    const test = spawnSync(
      ffmpeg.path,
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=25:d=1", ...ENCODERS[name], "-frames:v", "10", "-f", "null", "-"],
      { windowsHide: true, timeout: 20000 },
    );
    if (test.status === 0) return name;
  }
  return "libx264";
}

const encoder = settings.encoder && ENCODERS[settings.encoder] ? settings.encoder : pickEncoder();

// Picture formats whose decoding by the graphics card failed here once, so they are
// decoded by the processor from then on.
const hwaccelFailed = new Set();

function useHwaccel(codec) {
  return hwaccelWanted && !hwaccelFailed.has(codec);
}

// --- One connection at a time ---------------------------------------------------------

let active = null; // the FFmpeg run using the provider's connection
let lastError = { error: "", at: 0 };

// Stops FFmpeg on purpose, so its exit isn't reported as a problem.
function stopRun(child) {
  child.stoppedByHelper = true;
  child.kill();
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeSlot() {
  if (!active) return;
  const old = active;
  active = null;
  stopRun(old);
  await pause(FREE_SLOT_MS);
}

function lastLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+ @ [^\]]+\]\s*/, "").trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" ");
}

function noteError(message) {
  lastError = { error: redact(message), at: Date.now() };
  say("Problem:", message);
}

// --- What a file holds ----------------------------------------------------------------

const probeCache = new Map();

function probe(url) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin"];
    if (userAgent) args.push("-user_agent", userAgent);
    args.push("-i", url);
    const child = spawn(ffmpeg.path, args, { windowsHide: true });
    active = child;
    let text = "";
    child.stderr.on("data", (d) => {
      text = (text + d).slice(-200000);
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (active === child) active = null;
      const result = parseProbe(text);
      if (!result.video && result.audio.length === 0) reject(new Error(lastLines(text) || "FFmpeg stopped without saying why (" + (signal || "code " + code) + ")."));
      else resolve(result);
    });
  });
}

// What the file holds (asked once per 6 hours), with what would happen to each track.
async function info(q) {
  const cacheKey = q.kind + ":" + q.id;
  const cached = probeCache.get(cacheKey);
  let result;
  if (cached && Date.now() - cached.at < INFO_TTL_MS) {
    result = cached.result;
  } else {
    await takeSlot();
    result = await probe(providerUrl(login, q.kind, q.id, q.ext));
    probeCache.set(cacheKey, { at: Date.now(), result });
  }
  return {
    duration: result.duration,
    video: result.video,
    audio: result.audio.map((a) => ({ ...a, plan: audioPlan(a, q.audio) })),
    videoPlan: result.video ? videoPlan(result.video.codec) : "copy",
    encoder,
    probe: result,
  };
}

// What /v1/info answers: all but FFmpeg's raw description.
function publicInfo(described) {
  return { duration: described.duration, video: described.video, audio: described.audio, videoPlan: described.videoPlan, encoder: described.encoder };
}

// --- Requests -------------------------------------------------------------------------

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
}

function keyMatches(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clock(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (h > 0 ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

function describePlan(described, video, q) {
  let picture = "no picture";
  if (described.video && video === "convert") {
    const size = outputSize(described.video, video, q.height);
    picture = `picture ${described.video.codec} converted to H.264${size.height ? " at " + size.height + "p" : ""} with ${ENCODER_NAMES[encoder]}`;
  } else if (described.video) {
    picture = `picture ${described.video.codec} kept`;
  }
  const sound = described.audio.map((a) => (a.plan === "copy" ? a.codec + " kept" : a.codec + " to " + a.plan.toUpperCase())).join(", ") || "no sound";
  return picture + "; sound " + sound;
}

// Pictures that can't be repackaged are converted whatever the TV asked for.
function videoMode(q, described) {
  return q.video === "convert" || described.videoPlan === "convert" ? "convert" : "copy";
}

function argsFor(q, described, video, hwaccel, hls) {
  return ffmpegArgs({
    url: providerUrl(login, q.kind, q.id, q.ext),
    start: q.start,
    video,
    encoder,
    probe: described.probe,
    height: q.height,
    audio: q.audio,
    track: q.track,
    hwaccel,
    userAgent,
    hls,
  });
}

function videoCodec(described) {
  return described.video ? described.video.codec : "";
}

// The Samsung TV's stream: one endless MPEG-TS, ended when the TV closes it.
async function stream(req, res, q) {
  let described;
  try {
    described = await info(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  const video = videoMode(q, described);
  await takeSlot();
  if (res.destroyed) return;
  forgetNewestSession();
  say(`Playing ${q.kind} ${q.id}.${q.ext} from ${clock(q.start)}: ${describePlan(described, video, q)}`);
  runStream(res, q, described, video, video === "convert" && useHwaccel(videoCodec(described)));
}

function runStream(res, q, described, video, hwaccel) {
  const child = spawn(ffmpeg.path, argsFor(q, described, video, hwaccel, null), { windowsHide: true });
  active = child;
  const started = Date.now();
  let stderr = "";
  let sending = false;
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-20000);
  });
  const waiting = setTimeout(() => {
    if (!sending) {
      noteError("The provider sent nothing for " + FIRST_BYTES_MS / 1000 + " seconds.");
      stopRun(child);
    }
  }, FIRST_BYTES_MS);
  child.stdout.once("data", (chunk) => {
    sending = true;
    clearTimeout(waiting);
    // A plain stream with no length, the way IPTV servers send live video.
    res.removeHeader("Transfer-Encoding");
    res.writeHead(200, { "Content-Type": "video/mp2t", Connection: "close", "Cache-Control": "no-store", ...CORS });
    res.write(chunk);
    child.stdout.pipe(res);
  });
  child.on("error", (err) => noteError("FFmpeg didn't start: " + err.message));
  child.on("close", (code) => {
    clearTimeout(waiting);
    if (active === child) active = null;
    const secs = Math.round((Date.now() - started) / 1000);
    if (!sending) {
      // A graphics card that can't decode this picture: try once more on the processor.
      if (hwaccel && !child.stoppedByHelper && !res.destroyed && !res.headersSent) {
        say("Decoding on the graphics card didn't work (" + (lastLines(stderr) || "code " + code) + "); trying the processor.");
        hwaccelFailed.add(videoCodec(described));
        pause(FREE_SLOT_MS).then(() => {
          if (!res.destroyed && !active) runStream(res, q, described, video, false);
          else if (!res.headersSent) sendJson(res, 502, { error: "Another request took over." });
        });
        return;
      }
      noteError((lastLines(stderr) || "FFmpeg stopped (" + code + ").") + " (" + q.kind + " " + q.id + "." + q.ext + ")");
      if (!res.headersSent) sendJson(res, 502, { error: lastError.error });
      else res.end();
      return;
    }
    if (code !== 0 && !child.stoppedByHelper && stderr.trim() !== "") noteError(lastLines(stderr));
    say(`Stopped after ${clock(secs)}.`);
    res.end();
  });
  // The TV went away (Back, a jump, another title): free the provider's connection.
  res.on("close", () => {
    if (!res.writableEnded && active === child) {
      active = null;
      stopRun(child);
    }
  });
}

// --- HLS, for the Roku ----------------------------------------------------------------
//
// Each request for /v1/hls/index.m3u8 is a session: FFmpeg writes numbered segments
// and a growing playlist into its own folder under the system's temp folder. A request
// identical to the running session's (Roku asking again after a hiccup) gets that
// session back rather than a new FFmpeg.

const sessions = new Map();
let newestId = "";

function forgetNewestSession() {
  newestId = "";
}

function sessionKey(q, video) {
  return [q.kind, q.id, q.ext, q.start, video, q.height, q.audio, q.track].join("|");
}

function readPlaylist(session) {
  try {
    return readFileSync(path.join(session.dir, "index.m3u8"), "utf8");
  } catch {
    return "";
  }
}

function startSession(q, described, video, hwaccel, sessionId) {
  const session = sessionId ? sessions.get(sessionId) : null;
  const id = session ? session.id : randomBytes(16).toString("hex");
  const dir = path.join(hlsRoot, id);
  const current = session || { id, dir, key: sessionKey(q, video), state: "running", error: "", seen: Date.now(), child: null };
  current.state = "running";
  current.error = "";
  if (!session) {
    mkdirSync(dir, { recursive: true });
    sessions.set(id, current);
  }
  newestId = id;
  const child = spawn(ffmpeg.path, argsFor(q, described, video, hwaccel, { dir }), { windowsHide: true });
  current.child = child;
  active = child;
  const started = Date.now();
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-20000);
  });
  child.on("error", (err) => {
    current.state = "failed";
    current.error = "FFmpeg didn't start: " + err.message;
    noteError(current.error);
  });
  child.on("close", (code) => {
    if (active === child) active = null;
    if (current.child !== child) return;
    current.child = null;
    const secs = Math.round((Date.now() - started) / 1000);
    if (child.stoppedByHelper) {
      current.state = "stopped";
      say(`Stopped after ${clock(secs)}.`);
      return;
    }
    if (code === 0) {
      current.state = "done";
      say(`Converted to the end in ${clock(secs)}.`);
      return;
    }
    // A graphics card that can't decode this picture: try once more on the processor.
    if (hwaccel && playlistState(readPlaylist(current)).segments === 0 && !active) {
      say("Decoding on the graphics card didn't work (" + (lastLines(stderr) || "code " + code) + "); trying the processor.");
      hwaccelFailed.add(videoCodec(described));
      current.state = "retrying";
      pause(FREE_SLOT_MS).then(() => {
        if (sessions.has(id) && current.state === "retrying" && !active) startSession(q, described, video, false, id);
        else if (current.state === "retrying") current.state = "stopped";
      });
      return;
    }
    current.state = "failed";
    current.error = (lastLines(stderr) || "FFmpeg stopped (" + code + ").") + " (" + q.kind + " " + q.id + "." + q.ext + ")";
    noteError(current.error);
  });
  return current;
}

// Waits until the session's playlist lists a couple of segments, so Roku has something
// to play when it reads it. Resolves with "" when ready, or the reason it isn't.
async function sessionReady(session, res) {
  const until = Date.now() + FIRST_BYTES_MS;
  for (;;) {
    const state = playlistState(readPlaylist(session));
    if (state.segments >= HLS_READY_SEGMENTS || (state.ended && state.segments > 0)) return "";
    if (session.state === "failed") return session.error;
    if (session.state === "stopped" || (session.state === "done" && state.segments === 0)) return session.error || "FFmpeg stopped before any video was ready.";
    if (res.destroyed) return "The TV stopped waiting.";
    if (Date.now() > until) {
      if (session.child) stopRun(session.child);
      session.state = "failed";
      session.error = "No video was ready after " + FIRST_BYTES_MS / 1000 + " seconds. The provider may be slow to send the file, or this computer slow to convert it.";
      noteError(session.error);
      return session.error;
    }
    await pause(300);
  }
}

async function hls(res, q) {
  let described;
  try {
    described = await info(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  const video = videoMode(q, described);
  const wanted = sessionKey(q, video);
  let session = null;
  for (const s of sessions.values()) {
    if (s.key === wanted && s.id === newestId && (s.state === "running" || s.state === "done" || s.state === "retrying")) session = s;
  }
  if (!session) {
    await takeSlot();
    if (res.destroyed) return;
    say(`Playing ${q.kind} ${q.id}.${q.ext} from ${clock(q.start)} (HLS): ${describePlan(described, video, q)}`);
    session = startSession(q, described, video, video === "convert" && useHwaccel(videoCodec(described)), "");
  }
  session.seen = Date.now();
  const problem = await sessionReady(session, res);
  if (res.destroyed) return;
  if (problem) return sendJson(res, 502, { error: redact(problem) });
  session.seen = Date.now();
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...CORS });
  res.end(masterPlaylist(session.id, outputSize(described.video, video, q.height)));
}

// The session's own playlist (re-read by Roku as it grows) and its segments.
function serveSessionFile(req, res, sessionId, file) {
  const session = sessionFile(sessionId, file) ? sessions.get(sessionId) : null;
  if (!session) return sendJson(res, 404, { error: "Nothing here." });
  session.seen = Date.now();
  if (file === "index.m3u8") {
    let text = readPlaylist(session);
    if (!text) return sendJson(res, 404, { error: "Nothing here." });
    // Start at the beginning, not where a live stream's newest part is.
    text = rewritePlaylist(text, "");
    if (!/#EXT-X-START:/.test(text)) text = text.replace(/^#EXTM3U\r?\n/, "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");
    // FFmpeg was stopped (another request, or a long pause): say the list is complete,
    // so Roku ends where it stops rather than waiting for more. The app then opens the
    // video again from there.
    if ((session.state === "stopped" || session.state === "failed") && !playlistState(text).ended) text = text.replace(/\s*$/, "\n#EXT-X-ENDLIST\n");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...CORS });
    return res.end(req.method === "HEAD" ? undefined : text);
  }
  const filePath = path.join(session.dir, file);
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return sendJson(res, 404, { error: "Nothing here." });
  }
  res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": size, "Cache-Control": "no-store", ...CORS });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath)
    .on("error", () => res.destroy())
    .pipe(res);
}

function removeSession(session) {
  if (session.child) {
    if (active === session.child) active = null;
    stopRun(session.child);
  }
  sessions.delete(session.id);
  if (newestId === session.id) newestId = "";
  try {
    rmSync(session.dir, { recursive: true, force: true });
  } catch {
    // A file still open on Windows; the next start of the helper clears it.
  }
}

// Stops what nobody watches any more and clears its files.
function tidySessions() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    const idle = now - session.seen;
    if (session.child && idle > IDLE_STOP_MS) {
      say("Nothing has asked for the video for a while, so it stopped.");
      if (active === session.child) active = null;
      stopRun(session.child);
    }
    const keep = session.id === newestId ? NEWEST_KEEP_MS : IDLE_STOP_MS;
    if (idle > keep) removeSession(session);
  }
}

// The TV left the video: stop FFmpeg now, so the provider's one connection is free for
// whatever plays next, and let the files go with the usual tidying.
function stopAll() {
  if (active) {
    stopRun(active);
    active = null;
  }
  forgetNewestSession();
}

// --- Subtitles, for the Roku ----------------------------------------------------------

const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024;

// Roku times online subtitles from where the helper's stream starts, so they come
// through here, moved to match.
async function subtitles(res, params) {
  const src = params.get("src") || "";
  const start = Math.max(0, Math.floor(Number(params.get("start")) || 0));
  if (!subtitleSource(src)) return sendJson(res, 400, { error: "Only subtitle files from OpenSubtitles come through the helper." });
  let text;
  try {
    const answer = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": BROWSER_USER_AGENT } });
    if (!answer.ok) return sendJson(res, 502, { error: "OpenSubtitles answered HTTP " + answer.status + " for the subtitle file." });
    text = await answer.text();
  } catch (err) {
    return sendJson(res, 502, { error: "Couldn't fetch the subtitle file from OpenSubtitles: " + err.message });
  }
  if (text.length > SUBTITLE_MAX_BYTES) return sendJson(res, 502, { error: "The subtitle file is too big." });
  res.writeHead(200, { "Content-Type": "application/x-subrip; charset=utf-8", "Cache-Control": "no-store", ...CORS });
  res.end(shiftSubtitles(text, start));
}

// --- Server ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === "/") return sendJson(res, 200, { ok: true, service: "aranplus-helper", version: VERSION, encoder, hls: true });
  const sessionPath = /^\/v1\/hls\/s\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (sessionPath) return serveSessionFile(req, res, sessionPath[1], sessionPath[2]);
  if (!keyMatches(url.searchParams.get("key"))) return sendJson(res, 401, { error: "Wrong or missing key." });
  if (url.pathname === "/v1/last-error") return sendJson(res, 200, lastError);
  if (url.pathname === "/v1/subtitles.srt") {
    return subtitles(res, url.searchParams).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  }
  if (url.pathname === "/v1/stop") {
    stopAll();
    return sendJson(res, 200, { ok: true });
  }
  const q = readQuery(url.searchParams);
  if (!q) return sendJson(res, 400, { error: "Odd request." });
  if (url.pathname === "/v1/info") {
    return info(q).then(
      (described) => sendJson(res, 200, publicInfo(described)),
      (err) => {
        noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
        sendJson(res, 502, { error: lastError.error });
      },
    );
  }
  if (url.pathname === "/v1/stream") {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "video/mp2t", ...CORS });
      return res.end();
    }
    return stream(req, res, q).catch((err) => {
      noteError(err.message);
      if (!res.headersSent) sendJson(res, 500, { error: lastError.error });
    });
  }
  if (url.pathname === "/v1/hls/index.m3u8") {
    return hls(res, q).catch((err) => {
      noteError(err.message);
      if (!res.headersSent) sendJson(res, 500, { error: lastError.error });
    });
  }
  return sendJson(res, 404, { error: "Nothing here." });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") fail(`Port ${port} is already in use. Is the helper already running in another window?`);
  fail(err.message);
});

// Segments left over from the last run go first.
try {
  rmSync(hlsRoot, { recursive: true, force: true });
} catch {
  // Still open somewhere; each session uses its own new folder anyway.
}
mkdirSync(hlsRoot, { recursive: true });
setInterval(tidySessions, 15000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log("");
  console.log(`ARAN+ helper ${VERSION} is running.`);
  console.log(`  The TV reaches it at ${settings.url}`);
  const host = new URL(settings.url).hostname;
  if (host !== address && host !== "localhost" && host !== "127.0.0.1") {
    console.log(`  This computer's address looks like ${address} now. If the TV can't reach the helper,`);
    console.log(`  change "url" under "transcoder" in personal.json and run npm run install:tv again`);
    console.log(`  (and copy it into the Roku app's account.json).`);
  }
  console.log(`  ${ffmpeg.version}`);
  console.log(`  Pictures are converted with ${ENCODER_NAMES[encoder]} (${encoder}).`);
  if (addedSettings) {
    console.log("");
    console.log("  Added the helper's address and key to personal.json. Run npm run install:tv once");
    console.log("  so the TV knows them, and copy \"transcoder\" into the Roku app's account.json.");
    console.log("  If Windows asks whether Node.js may use the network, allow private networks.");
  }
  console.log("");
  console.log("Leave this window open while you watch. Ctrl+C stops the helper.");
  console.log("");
});

function shutDown() {
  if (active) stopRun(active);
  for (const session of [...sessions.values()]) removeSession(session);
  process.exit(0);
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
