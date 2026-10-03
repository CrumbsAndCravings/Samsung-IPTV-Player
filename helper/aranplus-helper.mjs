// The ARAN+ helper: runs on a computer at home and converts the videos this TV can't
// play (AVI files, DTS sound) into a stream it can, with FFmpeg, while you watch. It
// also serves ARAN+ for the iPhone (the web-iptv-player repo), which can't reach the
// provider by itself and plays almost nothing as the provider sends it.
//
//   npm run helper        (or double-click helper\start-helper.cmd on Windows)
//
// It reads the provider login from personal.json, so the login never travels from the
// TV or the phone. The first run adds "transcoder" (this computer's address and a
// random key) to personal.json; build the TV app once more (npm run install:tv) so it
// knows them. The phone gets the key from the link the helper prints.
//
// For the TV:
//   GET /                         is it running (no key needed; a browser goes to /app/)
//   GET /v1/info?key&kind&id&ext  what the file holds and how it would be converted
//   GET /v1/stream?key&kind&id&ext&start&video=copy|convert
//                                 the file as MPEG-TS, from `start` seconds
//   GET /v1/last-error?key        why the last stream failed, for the TV's error screen
//
// For the iPhone:
//   GET /app/...                  the web app's files (no key needed; they hold no secrets)
//   GET /v1/app?key               the account (server and username, never the password),
//                                 languages and sync settings from personal.json
//   GET /v1/xtream?key&action&... the provider's player_api.php, with the login added
//   GET /v1/file/<kind>/<id>.<ext>?key
//                                 the file as the provider sends it (MP4s play as they are)
//   GET /v1/hash?key&kind&id&ext  the file's OpenSubtitles moviehash
//   GET|POST /v1/fetch?key&url    OpenSubtitles, which a web page can't call itself
//   GET /v1/hls/start?key&kind&id&ext&start&video&hevc&a|alang&audio&height&format&subs
//                                 starts HLS from `start` seconds; answers once the first
//                                 pieces are ready, with the playlist's address
//   GET /v1/hls/index.m3u8?...    the same, answered with a redirect to the playlist
//   GET /v1/hls/s/<session>/<file> the playlist, its pieces and subtitle files (the
//                                 session's random name is its key)
//   GET /v1/stop?key&session      stops that session's FFmpeg (the phone left the player)
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
  ENCODERS,
  MAX_SUBTITLES,
  audioPlan,
  ffmpegArgs,
  hlsArgs,
  hlsVideoPlan,
  movieHash,
  parseProbe,
  playlistForPlayer,
  playlistState,
  providerUrl,
  redactor,
  sessionFile,
  sessionFileType,
  videoPlan,
  xtreamQuery,
  fetchAllowed,
} from "./plan.mjs";
import { parseRange, SourceFiles } from "./source.mjs";

const VERSION = "1.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const DEFAULT_PORT = 8090;
const PROBE_TIMEOUT_MS = 30000;
const FIRST_BYTES_MS = 45000; // the provider can be slow to start a file
const FREE_SLOT_MS = 1200; // lets the provider notice the last connection closed
const INFO_TTL_MS = 6 * 3600 * 1000;
const API_TIMEOUT_MS = 45000;
const HLS_ROOT = path.join(os.tmpdir(), "aranplus-helper");
const HLS_READY_SEGMENTS = 1; // pieces in the playlist before the phone is told to play
const SESSION_IDLE_MS = 2 * 60000; // an older session nobody asks for any more
const SESSION_KEEP_MS = 3 * 3600000; // the newest one, kept through long pauses
// How the helper introduces itself when it asks the provider for lists and files
// (FFmpeg keeps its own name unless "userAgent" is set under "transcoder"): the same
// desktop browser as the Roku app's BrowserUserAgent().
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
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
const ffmpegAgent = String(settings.userAgent || "").trim();
const fetchAgent = ffmpegAgent || BROWSER_UA;

// --- The provider's files ----------------------------------------------------------------
//
// FFmpeg reads the provider's files through the helper itself (/v1/source, helper/source.mjs),
// which keeps the start and the end of each file and the provider's redirect, so a jump
// costs one request to the provider instead of four or five. The window says how long
// the provider takes to answer, the usual reason a video is slow to start.

const requestTally = { count: 0, slowest: 0 };

const sources = new SourceFiles({
  fetch,
  userAgent: fetchAgent,
  onRequest: ({ ms }) => {
    requestTally.count++;
    requestTally.slowest = Math.max(requestTally.slowest, ms);
  },
});

function sourceFile(q) {
  return sources.file(q.kind + ":" + q.id + "." + q.ext, providerUrl(login, q.kind, q.id, q.ext));
}

// The address FFmpeg reads a file from: the helper itself, on this computer only.
function sourceUrl(q) {
  return "http://127.0.0.1:" + port + "/v1/source/" + q.kind + "/" + encodeURIComponent(q.id) + "." + q.ext + "?key=" + encodeURIComponent(key);
}

// "2 requests to the provider, the slowest answered in 4.1 s" since `since`.
function tallySince(since) {
  const count = requestTally.count - since.count;
  if (count <= 0) return "nothing asked of the provider";
  return count + (count === 1 ? " request" : " requests") + " to the provider, the slowest answered in " + (requestTally.slowest / 1000).toFixed(1) + " s";
}

function startTally() {
  requestTally.slowest = 0;
  return { count: requestTally.count, at: Date.now() };
}

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

// --- One connection at a time ---------------------------------------------------------

let active = null; // the FFmpeg run using the provider's connection
let lastError = { error: "", at: 0 };

// Stops FFmpeg on purpose, so its exit isn't reported as a problem.
function stopRun(child) {
  child.stoppedByHelper = true;
  child.kill();
}

async function takeSlot() {
  if (!active) return;
  const old = active;
  active = null;
  stopRun(old);
  await new Promise((resolve) => setTimeout(resolve, FREE_SLOT_MS));
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

const infoCache = new Map();

function probe(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, ["-hide_banner", "-nostdin", "-i", url], { windowsHide: true });
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

async function info(q) {
  const cacheKey = q.kind + ":" + q.id;
  const cached = infoCache.get(cacheKey);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;
  await takeSlot();
  const tally = startTally();
  const result = await probe(sourceUrl(q));
  say(`Read what ${q.kind} ${q.id}.${q.ext} holds in ${((Date.now() - tally.at) / 1000).toFixed(1)} s (${tallySince(tally)}).`);
  const described = {
    duration: result.duration,
    video: result.video,
    audio: result.audio.map((a) => ({ ...a, plan: audioPlan(a) })),
    subtitles: result.subtitles,
    videoPlan: result.video ? videoPlan(result.video.codec) : "copy",
    hlsVideoPlan: result.video ? hlsVideoPlan(result.video.codec) : "copy",
    encoder,
  };
  infoCache.set(cacheKey, { at: Date.now(), info: described });
  return described;
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

function readQuery(url) {
  const p = url.searchParams;
  const q = {
    kind: p.get("kind") === "series" ? "series" : "movie",
    id: p.get("id") || "",
    ext: (p.get("ext") || "").toLowerCase(),
    start: Math.max(0, Math.floor(Number(p.get("start")) || 0)),
    video: p.get("video") === "convert" ? "convert" : "copy",
    // HLS only: which sound track, what to do with it, the tallest picture when
    // converting, the kind of pieces, and whether to write the subtitle files.
    audioTrack: Math.max(0, Math.floor(Number(p.get("a")) || 0)),
    // Without "a": the first sound track in this language, when there is one.
    audioLanguage: p.has("a") ? "" : (p.get("alang") || "").toLowerCase(),
    audio: p.get("audio") === "keep" ? "keep" : "aac",
    height: Math.max(0, Math.floor(Number(p.get("height")) || 0)),
    format: p.get("format") === "ts" ? "ts" : "fmp4",
    subs: p.get("subs") === "1",
    // Whether the player decodes HEVC; without it, HEVC is converted too.
    hevc: p.get("hevc") !== "0",
  };
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(q.id) || !/^[0-9a-z]{1,5}$/.test(q.ext) || q.start > 86400 || q.audioTrack > 50 || q.height > 4320) return null;
  if (q.audioLanguage && !/^[a-z]{2,3}$/.test(q.audioLanguage)) return null;
  return q;
}

function clock(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (h > 0 ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

function describePlan(described, video) {
  const picture = !described.video ? "no picture" : video === "convert" ? `picture ${described.video.codec} converted to H.264 with ${ENCODER_NAMES[encoder]}` : `picture ${described.video.codec} kept`;
  const sound = described.audio.map((a) => (a.plan === "copy" ? a.codec + " kept" : a.codec + " to " + a.plan.toUpperCase())).join(", ") || "no sound";
  return picture + "; sound " + sound;
}

async function stream(req, res, q) {
  let described;
  try {
    described = await info(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  // Pictures that can't be repackaged are converted whatever the TV asked for.
  const video = q.video === "convert" || described.videoPlan === "convert" ? "convert" : "copy";
  const args = ffmpegArgs({ url: sourceUrl(q), start: q.start, video, encoder, probe: described });
  await takeSlot();
  if (res.destroyed) return;
  say(`Playing ${q.kind} ${q.id}.${q.ext} from ${clock(q.start)}: ${describePlan(described, video)}`);
  const tally = startTally();
  const child = spawn(ffmpeg.path, args, { windowsHide: true });
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
    say(`Sending to the TV after ${((Date.now() - tally.at) / 1000).toFixed(1)} s (${tallySince(tally)}).`);
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

// --- The provider, for the phone ------------------------------------------------------
//
// A web page can't call the provider itself (the provider doesn't allow other sites to
// read its answers, and the phone would need the password), so the helper asks for it.

// What the provider said, passed on as it is, with the headers the app reads to explain
// a refusal (who answered, and whether Cloudflare blocked it).
const PASSED_HEADERS = ["server", "cf-ray", "cf-mitigated", "content-type"];

function providerFailure(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "Your provider didn't answer the helper within " + API_TIMEOUT_MS / 1000 + " seconds.";
  const cause = err && err.cause ? err.cause.code || err.cause.message : "";
  return "The helper couldn't reach your provider" + (cause ? " (" + cause + ")" : "") + ".";
}

// The helper's own trouble (not the provider's answer) says so in a header, so the app
// can tell "the provider refused" from "nobody answered".
function sendHelperError(res, code, message) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-ARANplus-Helper": "error", ...CORS });
  res.end(JSON.stringify({ error: redact(message) }));
}

async function xtream(res, url) {
  const target = xtreamQuery(login, url.searchParams);
  if (!target) return sendJson(res, 400, { error: "Odd request." });
  let answer;
  let body;
  try {
    answer = await fetch(target, { headers: { "User-Agent": fetchAgent, Accept: "application/json" }, signal: AbortSignal.timeout(API_TIMEOUT_MS), redirect: "follow" });
    body = Buffer.from(await answer.arrayBuffer());
  } catch (err) {
    return sendHelperError(res, 504, providerFailure(err));
  }
  const headers = { "Cache-Control": "no-store", ...CORS };
  for (const name of PASSED_HEADERS) {
    const value = answer.headers.get(name);
    if (value) headers[name] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  res.writeHead(answer.status, headers);
  res.end(body);
}

const FILE_TYPES = { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", ts: "video/mp2t" };

// Files being passed on to the phone, so a new title stops the last one's connection.
const fileRuns = new Set();

// The provider's file as it is, with ranges (Safari plays MP4s this way and jumps by
// asking for the part it needs).
async function passFile(req, res, q) {
  const title = q.kind + ":" + q.id;
  for (const run of fileRuns) if (run.title !== title) run.abort.abort();
  await takeSlot();
  const abort = new AbortController();
  const run = { title, abort };
  fileRuns.add(run);
  res.on("close", () => fileRuns.delete(run));
  // Safari decides what a file is from its type, which providers often leave vague.
  await serveSource(req, res, sourceFile(q), { exclusive: false, abort, type: FILE_TYPES[q.ext] || "application/octet-stream", what: q.kind + " " + q.id + "." + q.ext });
}

function writeChunk(res, chunk) {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve(!res.destroyed);
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

// A provider file with ranges, from what the helper keeps where it can (helper/source.mjs).
// For FFmpeg (`exclusive`: one request to the provider at a time) and Safari's MP4s.
async function serveSource(req, res, file, { exclusive, abort = new AbortController(), type, what }) {
  res.on("close", () => abort.abort());
  const asked = parseRange(req.headers.range);
  try {
    let start = 0;
    let end = -1;
    if (asked && "suffix" in asked) start = Math.max(0, (await sources.size(file, abort.signal)) - asked.suffix);
    else if (asked) ({ start, end } = asked);
    if (req.method === "HEAD") {
      const size = await sources.size(file, abort.signal);
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", ...CORS });
      return res.end();
    }
    if (file.size > 0 && start >= file.size) {
      res.writeHead(416, { "Content-Range": "bytes */" + file.size, ...CORS });
      return res.end();
    }
    const chunks = sources.bytes(file, start, end, abort.signal, { exclusive });
    const first = await chunks.next();
    const size = file.size;
    const last = end >= 0 ? Math.min(end, size - 1) : size - 1;
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...CORS };
    if (size > 0) {
      headers["Content-Length"] = last - start + 1;
      if (asked) headers["Content-Range"] = "bytes " + start + "-" + last + "/" + size;
    }
    res.writeHead(asked && size > 0 ? 206 : 200, headers);
    let sent = 0;
    if (!first.done) {
      sent += first.value.length;
      if (!(await writeChunk(res, first.value))) return chunks.return();
    }
    for await (const chunk of chunks) {
      sent += chunk.length;
      if (!(await writeChunk(res, chunk))) break;
    }
    // Cut short (the provider's connection dropped): say so, so the reader asks again.
    if (size > 0 && sent < last - start + 1) res.destroy();
    else res.end();
  } catch (err) {
    if (abort.signal.aborted) return; // the reader went away (a jump, or Back)
    const status = err && err.status >= 400 ? err.status : 502;
    if (status >= 400 && err.status) noteError("The provider refused " + what + ": HTTP " + err.status);
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...CORS });
      res.end(redact(err && err.message ? err.message : providerFailure(err)));
    } else res.destroy();
  }
}

// --- The file's fingerprint, for OpenSubtitles -------------------------------------------

const CHUNK = 65536;
const hashes = new Map();

// Bytes `from` to `to` of a file, through what the helper keeps (the start and the end of
// a file are kept, so FFmpeg won't ask for these again).
async function rangeOf(file, from, to) {
  const parts = [];
  for await (const chunk of sources.bytes(file, from, to, AbortSignal.timeout(15000), { exclusive: true })) parts.push(chunk);
  const bytes = Buffer.concat(parts);
  return bytes.length === to - from + 1 ? bytes : null;
}

async function fileHash(q) {
  const cacheKey = q.kind + ":" + q.id;
  if (hashes.has(cacheKey)) return hashes.get(cacheKey);
  await takeSlot();
  const file = sourceFile(q);
  let result = { hash: "", size: 0 };
  try {
    const head = await rangeOf(file, 0, CHUNK - 1);
    if (head && file.size >= CHUNK * 2) {
      const tail = await rangeOf(file, file.size - CHUNK, file.size - 1);
      if (tail) result = { hash: movieHash(head, tail, file.size), size: file.size };
    }
  } catch {
    // No fingerprint; the search goes on without it.
  }
  if (result.hash) hashes.set(cacheKey, result);
  return result;
}

// --- OpenSubtitles, for the phone --------------------------------------------------------

const FETCH_HEADERS = ["api-key", "authorization", "content-type", "accept"];
const FETCH_MAX_BYTES = 5 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > limit) {
        reject(new Error("too big"));
        req.destroy();
      } else parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function passFetch(req, res, url) {
  const target = url.searchParams.get("url") || "";
  if (!fetchAllowed(target)) return sendJson(res, 400, { error: "The helper only passes on requests to OpenSubtitles." });
  const headers = { "User-Agent": String(req.headers["x-user-agent"] || "ARANplus v" + VERSION) };
  for (const name of FETCH_HEADERS) if (req.headers[name]) headers[name] = String(req.headers[name]);
  let body;
  if (req.method === "POST") {
    try {
      body = await readBody(req, 65536);
    } catch {
      return sendJson(res, 413, { error: "Too much to pass on." });
    }
  }
  let answer;
  let data;
  try {
    answer = await fetch(target, { method: req.method === "POST" ? "POST" : "GET", headers, body, signal: AbortSignal.timeout(20000), redirect: "follow" });
    data = Buffer.from(await answer.arrayBuffer());
  } catch (err) {
    const cause = err && err.cause ? err.cause.code || err.cause.message : "";
    return sendHelperError(res, 504, err && err.name === "TimeoutError" ? "OpenSubtitles didn't answer the helper in time." : "The helper couldn't reach OpenSubtitles" + (cause ? " (" + cause + ")" : "") + ".");
  }
  if (data.length > FETCH_MAX_BYTES) return sendHelperError(res, 502, "OpenSubtitles sent more than the helper passes on.");
  res.writeHead(answer.status, { "Content-Type": answer.headers.get("content-type") || "application/octet-stream", "Cache-Control": "no-store", ...CORS });
  res.end(data);
}

// --- HLS, for the phone ------------------------------------------------------------------
//
// FFmpeg writes numbered pieces and a playlist into a folder of its own under the
// computer's temp folder, as fast as it can; Safari plays them as they arrive and can
// jump anywhere FFmpeg has already reached. A jump further on starts a new session from
// there. Old sessions are deleted once nothing asks for them, and all of them when the
// helper starts.

const sessions = new Map();
let newestSession = "";

function dropSession(session) {
  sessions.delete(session.id);
  if (session.child) {
    if (active === session.child) active = null;
    stopRun(session.child);
  }
  // Windows keeps a file FFmpeg still has open, so wait for it to go.
  setTimeout(() => {
    try {
      rmSync(session.dir, { recursive: true, force: true });
    } catch {
      // Removed when the helper next starts.
    }
  }, 3000);
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    const limit = session.id === newestSession ? SESSION_KEEP_MS : SESSION_IDLE_MS;
    if (now - session.lastUsed > limit) dropSession(session);
  }
}, 30000).unref();

function playlistText(session) {
  try {
    return readFileSync(path.join(session.dir, "index.m3u8"), "utf8");
  } catch {
    return "";
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHls(q) {
  let described;
  try {
    described = await info(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    throw new Error(lastError.error, { cause: err });
  }
  const plan = q.format === "fmp4" ? described.hlsVideoPlan : described.videoPlan;
  const hevcRefused = !q.hevc && described.video && described.video.codec === "hevc";
  const video = q.video === "convert" || plan === "convert" || hevcRefused ? "convert" : "copy";
  await takeSlot();
  const id = randomBytes(16).toString("hex");
  const dir = path.join(HLS_ROOT, id);
  mkdirSync(dir, { recursive: true });
  let audioTrack = q.audioTrack < described.audio.length ? q.audioTrack : 0;
  if (q.audioLanguage) {
    const found = described.audio.findIndex((a) => a.language === q.audioLanguage);
    if (found >= 0) audioTrack = found;
  }
  const args = hlsArgs({
    url: sourceUrl(q),
    start: q.start,
    video,
    encoder,
    probe: described,
    dir,
    audioTrack,
    audio: q.audio,
    height: q.height,
    format: q.format,
    subtitles: q.subs,
    userAgent: ffmpegAgent,
  });
  const sound = described.audio[audioTrack];
  const soundPlan = !sound ? "" : q.audio === "aac" ? (sound.codec === "aac" ? "copy" : "aac") : audioPlan(sound);
  const soundText = !sound ? "no sound" : soundPlan === "copy" ? sound.codec + " kept" : sound.codec + " to " + soundPlan.toUpperCase();
  const picture = !described.video ? "no picture" : video === "convert" ? `picture ${described.video.codec} converted to H.264 with ${ENCODER_NAMES[encoder]}` : `picture ${described.video.codec} kept`;
  say(`Playing ${q.kind} ${q.id}.${q.ext} for the phone from ${clock(q.start)}: ${picture}; sound ${soundText}`);
  const tally = startTally();
  const child = spawn(ffmpeg.path, args, { windowsHide: true });
  active = child;
  const session = { id, dir, child, lastUsed: Date.now(), ended: false, error: "", stderr: "", started: Date.now() };
  sessions.set(id, session);
  newestSession = id;
  child.stderr.on("data", (d) => {
    session.stderr = (session.stderr + d).slice(-20000);
  });
  child.on("error", (err) => {
    session.ended = true;
    session.error = "FFmpeg didn't start: " + err.message;
  });
  child.on("close", (code) => {
    session.ended = true;
    session.child = null;
    if (active === child) active = null;
    if (code !== 0 && !child.stoppedByHelper) {
      session.error = lastLines(session.stderr) || "FFmpeg stopped (" + code + ").";
      noteError(session.error + " (" + q.kind + " " + q.id + "." + q.ext + ")");
    } else if (code === 0) say(`Finished converting ${q.kind} ${q.id}.${q.ext} in ${clock(Math.round((Date.now() - session.started) / 1000))}.`);
  });
  // Ready once the playlist lists a couple of pieces (or all of a short file).
  const deadline = Date.now() + FIRST_BYTES_MS;
  for (;;) {
    const state = playlistState(playlistText(session));
    if (state.segments >= HLS_READY_SEGMENTS || (state.ended && state.segments > 0)) break;
    if (session.ended) {
      const reason = session.error || "FFmpeg stopped before the first piece was ready.";
      if (!session.error) noteError(reason);
      dropSession(session);
      throw new Error(reason);
    }
    if (Date.now() > deadline) {
      noteError("The provider sent too little for " + FIRST_BYTES_MS / 1000 + " seconds to start (" + q.kind + " " + q.id + "." + q.ext + ").");
      dropSession(session);
      throw new Error(lastError.error);
    }
    await wait(300);
  }
  say(`Ready to play after ${((Date.now() - tally.at) / 1000).toFixed(1)} s (${tallySince(tally)}).`);
  const base = "/v1/hls/s/" + id + "/";
  const subtitles = [];
  described.subtitles.slice(0, MAX_SUBTITLES).forEach((sub, n) => {
    if (sub.text && q.subs) subtitles.push({ index: n, language: sub.language, title: sub.title || "", forced: sub.forced, url: base + "sub" + n + ".vtt" });
  });
  return {
    session: id,
    url: base + "index.m3u8",
    start: q.start,
    duration: described.duration,
    video,
    videoCodec: described.video ? described.video.codec : "",
    audioTrack,
    audioPlan: soundPlan,
    audio: described.audio.map((a) => ({ codec: a.codec, channels: a.channels, language: a.language, title: a.title || "" })),
    subtitles,
  };
}

async function serveSessionFile(res, id, name) {
  const session = sessions.get(id);
  if (!session || !sessionFile(name)) return sendJson(res, 404, { error: "That stream has ended. Play it again." });
  session.lastUsed = Date.now();
  const file = path.join(session.dir, name);
  const type = sessionFileType(name);
  const headers = { "Content-Type": type, "Cache-Control": "no-store", ...CORS };
  if (name === "index.m3u8") {
    res.writeHead(200, headers);
    return res.end(playlistForPlayer(playlistText(session)));
  }
  // A subtitle file that has nothing yet is an empty one.
  if (name.endsWith(".vtt") && !existsSync(file)) {
    res.writeHead(200, headers);
    return res.end("WEBVTT\n\n");
  }
  // A piece FFmpeg is still writing is waited for, briefly.
  for (let i = 0; i < 60 && !existsSync(file) && !session.ended; i++) await wait(250);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return sendJson(res, 404, { error: "No such piece." });
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

// The phone left the player. With its session's name, only that session's FFmpeg stops
// (the TV may have started something since); without, everything does.
function stopFor(id) {
  if (id) {
    const session = sessions.get(id);
    if (session && session.child) {
      if (active === session.child) active = null;
      stopRun(session.child);
    }
    return;
  }
  for (const run of fileRuns) run.abort.abort();
  if (active) {
    stopRun(active);
    active = null;
  }
}

// --- The web app -------------------------------------------------------------------------
//
// Served from the web-iptv-player repo's build: "webApp" under "transcoder" in
// personal.json, or the dist folder of a web-iptv-player checkout next to this repo
// (or inside it, where a clone made from this folder lands).

function webAppPlaces() {
  const places = [process.env.ARANPLUS_WEB_APP, settings.webApp ? path.resolve(root, String(settings.webApp)) : ""];
  places.push(path.resolve(root, "..", "web-iptv-player", "dist"), path.resolve(root, "web-iptv-player", "dist"));
  return places.filter((dir) => dir);
}

function findWebApp() {
  for (const dir of webAppPlaces()) if (existsSync(path.join(dir, "index.html"))) return dir;
  return "";
}

// Where the helper looked, in its window: a checkout that isn't built yet says so.
let lastMissingNote = 0;
function explainMissingWebApp() {
  if (Date.now() - lastMissingNote < 60000) return;
  lastMissingNote = Date.now();
  console.log("");
  console.log("The iPhone app isn't built where the helper looks. It looked in:");
  for (const dir of webAppPlaces()) {
    const repo = path.dirname(dir);
    const state = existsSync(path.join(repo, "package.json")) ? "the repo is there, but not built: run npm install, then npm run build, in " + repo : "nothing there";
    console.log("  " + dir + "  (" + state + ")");
  }
  console.log('Build it in one of those places, or set "webApp" under "transcoder" in personal.json to its dist folder.');
  console.log("");
}

let webApp = findWebApp();

const APP_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

const NO_APP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ARAN+</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#151028;color:#F7F3FF;padding:24px;max-width:640px;margin:auto}code{color:#FFD98A}</style></head>
<body><h1>ARAN+ isn't on this computer yet</h1><p>The helper is running and this phone reached it, but the helper can't find the iPhone app's build. The helper's window on the computer now lists the folders it looked in.</p>
<p>On the computer, put the <code>web-iptv-player</code> repo next to the <code>Samsung-IPTV-Player</code> folder, and in it run:</p>
<p><code>npm install</code><br><code>npm run build</code></p><p>Then reload this page; the helper needn't restart. (Or set <code>"webApp"</code> under <code>"transcoder"</code> in personal.json to the app's <code>dist</code> folder.)</p></body></html>`;

function serveApp(res, pathname) {
  if (!webApp) {
    webApp = findWebApp();
    if (webApp) console.log("Found the iPhone app in " + webApp);
  }
  if (!webApp) {
    explainMissingWebApp();
    res.writeHead(200, { "Content-Type": APP_TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(NO_APP_PAGE);
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice("/app/".length)) || "index.html";
  } catch {
    return sendJson(res, 400, { error: "Odd request." });
  }
  const file = path.resolve(webApp, relative);
  if (!file.startsWith(webApp + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  // Small files on the home network: always check for a newer build.
  res.writeHead(200, { "Content-Type": APP_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}

// The account and settings the app needs; the password stays here.
function appSettings() {
  const sync = personal.sync && typeof personal.sync === "object" ? personal.sync : null;
  return {
    ok: true,
    service: "aranplus-helper",
    version: VERSION,
    encoder,
    account: { server: login.server, username: login.username },
    languages: Array.isArray(personal.languages) ? personal.languages.map(String) : [],
    sync: sync && sync.url && sync.key ? { url: String(sync.url), key: String(sync.key) } : null,
  };
}

// --- Routes ------------------------------------------------------------------------------

function failed(res, err) {
  if (res.headersSent) return res.destroy();
  sendHelperError(res, 502, err && err.message ? err.message : String(err));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  const pathname = url.pathname;
  if (pathname === "/") {
    // A browser goes to the app; the TV's check gets the usual answer.
    if (String(req.headers.accept || "").indexOf("text/html") >= 0) {
      res.writeHead(302, { Location: "/app/" + url.search });
      return res.end();
    }
    return sendJson(res, 200, { ok: true, service: "aranplus-helper", version: VERSION, encoder });
  }
  if (pathname === "/app") {
    res.writeHead(301, { Location: "/app/" + url.search });
    return res.end();
  }
  if (pathname.startsWith("/app/")) return serveApp(res, pathname);
  const piece = /^\/v1\/hls\/s\/([0-9a-f]{32})\/([^/]+)$/.exec(pathname);
  if (piece) return serveSessionFile(res, piece[1], piece[2]).catch((err) => failed(res, err));
  if (!keyMatches(url.searchParams.get("key"))) return sendHelperError(res, 401, "Wrong or missing key.");
  if (pathname === "/v1/last-error") return sendJson(res, 200, lastError);
  if (pathname === "/v1/app") return sendJson(res, 200, appSettings());
  if (pathname === "/v1/xtream") return xtream(res, url).catch((err) => failed(res, err));
  if (pathname === "/v1/fetch") return passFetch(req, res, url).catch((err) => failed(res, err));
  if (pathname === "/v1/stop") {
    stopFor(/^[0-9a-f]{32}$/.test(url.searchParams.get("session") || "") ? url.searchParams.get("session") : "");
    return sendJson(res, 200, { ok: true });
  }
  const source = /^\/v1\/source\/(movie|series)\/([0-9A-Za-z_-]{1,40})\.([0-9a-z]{1,5})$/.exec(pathname);
  if (source) {
    // For FFmpeg on this computer only.
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "")) return sendHelperError(res, 403, "Only for this computer.");
    const q = { kind: source[1], id: source[2], ext: source[3] };
    return serveSource(req, res, sourceFile(q), { exclusive: true, type: FILE_TYPES[q.ext] || "application/octet-stream", what: q.kind + " " + q.id + "." + q.ext }).catch((err) => failed(res, err));
  }
  const file = /^\/v1\/file\/(movie|series)\/([0-9A-Za-z_-]{1,40})\.([0-9a-z]{1,5})$/.exec(pathname);
  if (file) return passFile(req, res, { kind: file[1], id: file[2], ext: file[3] }).catch((err) => failed(res, err));
  const q = readQuery(url);
  if (!q) return sendJson(res, 400, { error: "Odd request." });
  if (pathname === "/v1/info") {
    return info(q).then(
      (described) => sendJson(res, 200, described),
      (err) => {
        noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
        sendJson(res, 502, { error: lastError.error });
      },
    );
  }
  if (pathname === "/v1/hash") return fileHash(q).then((result) => sendJson(res, 200, result), (err) => failed(res, err));
  if (pathname === "/v1/hls/start") {
    // The phone may give up before the first pieces are ready (it left the player): then
    // the session it never heard about is stopped, not left converting the whole film.
    let gone = false;
    res.on("close", () => {
      if (!res.writableEnded) gone = true;
    });
    return startHls(q).then(
      (started) => {
        const session = sessions.get(started.session);
        if (gone && session) return dropSession(session);
        sendJson(res, 200, started);
      },
      (err) => failed(res, err),
    );
  }
  if (pathname === "/v1/hls/index.m3u8") {
    // For players that take a playlist's address and nothing else (the Roku): MPEG-TS
    // pieces unless asked otherwise, then a redirect to the playlist.
    if (url.searchParams.get("format") !== "fmp4") q.format = "ts";
    if (url.searchParams.get("audio") !== "aac") q.audio = "keep";
    return startHls(q).then(
      (started) => {
        res.writeHead(302, { Location: "s/" + started.session + "/index.m3u8", "Cache-Control": "no-store", ...CORS });
        res.end();
      },
      (err) => failed(res, err),
    );
  }
  if (pathname === "/v1/stream") {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "video/mp2t", ...CORS });
      return res.end();
    }
    return stream(req, res, q).catch((err) => {
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

// A QR code drawn with block characters, light on the terminal's dark background, so a
// phone's camera opens the link. Nothing when the qrcode-generator package (installed
// by npm install) isn't there.
async function qrLines(text) {
  let qrcode;
  try {
    qrcode = (await import("qrcode-generator")).default;
  } catch {
    return [];
  }
  const code = qrcode(0, "L");
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const margin = 2;
  const light = (row, col) => row < 0 || col < 0 || row >= size || col >= size || !code.isDark(row, col);
  const lines = [];
  for (let row = -margin; row < size + margin; row += 2) {
    let line = "  ";
    for (let col = -margin; col < size + margin; col++) {
      const top = light(row, col);
      const bottom = row + 1 >= size + margin ? false : light(row + 1, col);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines;
}

// The temp folder of earlier runs' HLS pieces.
try {
  rmSync(HLS_ROOT, { recursive: true, force: true });
} catch {
  // In use by an FFmpeg still running from before; it goes next time.
}
mkdirSync(HLS_ROOT, { recursive: true });

server.listen(port, "0.0.0.0", async () => {
  console.log("");
  console.log(`ARAN+ helper ${VERSION} is running.`);
  console.log(`  The TV reaches it at ${settings.url}`);
  const host = new URL(settings.url).hostname;
  if (host !== address && host !== "localhost" && host !== "127.0.0.1") {
    console.log(`  This computer's address looks like ${address} now. If the TV can't reach the helper,`);
    console.log(`  change "url" under "transcoder" in personal.json and run npm run install:tv again.`);
  }
  console.log(`  ${ffmpeg.version}`);
  console.log(`  Pictures are converted with ${ENCODER_NAMES[encoder]} (${encoder}).`);
  if (addedSettings) {
    console.log("");
    console.log("  Added the helper's address and key to personal.json. Run npm run install:tv once");
    console.log("  so the TV knows them. If Windows asks whether Node.js may use the network, allow");
    console.log("  private networks.");
  }
  // The phone needs this computer's address now, not the one the TV was built with.
  const phoneLink = `http://${address}:${port}/app/?key=${encodeURIComponent(key)}`;
  console.log("");
  console.log("On your iPhone (on the same Wi-Fi), open this link in Safari, or point the camera");
  console.log("at the code. Then Share > Add to Home Screen. The link holds the helper's key, so");
  console.log("keep it to yourself.");
  console.log(`  ${phoneLink}`);
  if (webApp) console.log("  (The iPhone app is in " + webApp + ")");
  for (const line of await qrLines(phoneLink)) console.log(line);
  if (!webApp) explainMissingWebApp();
  console.log("");
  console.log("Leave this window open while you watch. Ctrl+C stops the helper.");
  console.log("");
});

process.on("SIGINT", () => {
  if (active) stopRun(active);
  try {
    rmSync(HLS_ROOT, { recursive: true, force: true });
  } catch {
    // FFmpeg may still hold a file; it goes next time.
  }
  process.exit(0);
});
