// The ARAN+ helper: runs on a computer at home and converts the videos this TV can't
// play (AVI files, DTS sound) into a stream it can, with FFmpeg, while you watch.
//
//   npm run helper        (or double-click helper\start-helper.cmd on Windows)
//
// It reads the provider login from personal.json, so the login never travels from the
// TV. The first run adds "transcoder" (this computer's address and a random key) to
// personal.json; build the TV app once more (npm run install:tv) so it knows them.
//
//   GET /                         is it running (no key needed)
//   GET /v1/info?key&kind&id&ext  what the file holds and how it would be converted
//   GET /v1/stream?key&kind&id&ext&start&video=copy|convert
//                                 the file as MPEG-TS, from `start` seconds
//   GET /v1/last-error?key        why the last stream failed, for the TV's error screen
//
// The provider allows one connection at a time, so a new request stops the one before.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENCODERS, audioPlan, ffmpegArgs, parseProbe, providerUrl, redactor, videoPlan } from "./plan.mjs";

const VERSION = "1.0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const DEFAULT_PORT = 8090;
const PROBE_TIMEOUT_MS = 30000;
const FIRST_BYTES_MS = 45000; // the provider can be slow to start a file
const FREE_SLOT_MS = 1200; // lets the provider notice the last connection closed
const INFO_TTL_MS = 6 * 3600 * 1000;
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
  const result = await probe(providerUrl(login, q.kind, q.id, q.ext));
  const described = {
    duration: result.duration,
    video: result.video,
    audio: result.audio.map((a) => ({ ...a, plan: audioPlan(a) })),
    videoPlan: result.video ? videoPlan(result.video.codec) : "copy",
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
  };
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(q.id) || !/^[0-9a-z]{1,5}$/.test(q.ext) || q.start > 86400) return null;
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
  const args = ffmpegArgs({ url: providerUrl(login, q.kind, q.id, q.ext), start: q.start, video, encoder, probe: described });
  await takeSlot();
  if (res.destroyed) return;
  say(`Playing ${q.kind} ${q.id}.${q.ext} from ${clock(q.start)}: ${describePlan(described, video)}`);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === "/") return sendJson(res, 200, { ok: true, service: "aranplus-helper", version: VERSION, encoder });
  if (!keyMatches(url.searchParams.get("key"))) return sendJson(res, 401, { error: "Wrong or missing key." });
  if (url.pathname === "/v1/last-error") return sendJson(res, 200, lastError);
  const q = readQuery(url);
  if (!q) return sendJson(res, 400, { error: "Odd request." });
  if (url.pathname === "/v1/info") {
    return info(q).then(
      (described) => sendJson(res, 200, described),
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
  return sendJson(res, 404, { error: "Nothing here." });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") fail(`Port ${port} is already in use. Is the helper already running in another window?`);
  fail(err.message);
});

server.listen(port, "0.0.0.0", () => {
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
  console.log("");
  console.log("Leave this window open while you watch. Ctrl+C stops the helper.");
  console.log("");
});

process.on("SIGINT", () => {
  if (active) stopRun(active);
  process.exit(0);
});
