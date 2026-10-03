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
//   GET /v1/info?key&kind&id&ext&start[&hash=1&audio]
//                                 what the file holds and how it would be converted;
//                                 with hash=1 also its OpenSubtitles fingerprint
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
//   GET /p/<token>                a file as FFmpeg reads it (this computer only)
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
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_USER_AGENT,
  ENCODERS,
  askedRange,
  audioPlan,
  ffmpegArgs,
  masterPlaylist,
  osHash,
  outputSize,
  parseProbe,
  playlistState,
  providerUrl,
  readQuery,
  redactor,
  rewritePlaylist,
  sessionFile,
  shiftSubtitles,
  sizeFromAnswer,
  subtitleSource,
  videoPlan,
} from "./plan.mjs";

const VERSION = "1.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const DEFAULT_PORT = 8090;
const PROBE_TIMEOUT_MS = 30000;
const FIRST_BYTES_MS = 45000; // the provider can be slow to start a file
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

// When converting, the graphics card or Quick Sync decodes too, unless "hwaccel": false
// in "transcoder". Picture formats it failed on here are decoded by the processor from
// then on.
const hwaccelWanted = settings.hwaccel !== false;
const hwaccelFailed = new Set();

function useHwaccel(codec) {
  return hwaccelWanted && !hwaccelFailed.has(codec);
}

// --- The provider's file ---------------------------------------------------------------
//
// FFmpeg never talks to the provider itself. Opening an AVI costs it six requests (the
// start, the index at the end, back again, ...), and a provider takes a moment to start
// each one, so the helper fetches the file itself:
// - from the start, on one connection: the first 4 MB are read once, inspected, then
//   fed to FFmpeg, followed by the rest of the same connection;
// - from anywhere else, through a local address (/p/<token>) that answers FFmpeg's
//   requests from a memory cache of the parts it keeps going back to (the start, the
//   index) and asks the provider only for the rest.
// There is never more than one provider connection open.

const BLOCK = 1 << 20;
const HEAD_BYTES = 4 * BLOCK;
const HEAD_WAIT_MS = 20000;
const PROVIDER_WAIT_MS = 30000;
const CACHE_PER_READ = 8 * BLOCK; // an index sits within the first few MB of a read
const CACHE_PER_FILE = 32 * BLOCK;
const FILES_KEPT = 3;
const WARM_MS = 20000; // how long the connection that read the start waits for the stream
const SETTLE_MS = 300; // after closing a connection, before the next
const HASH_BYTES = 65536;
const USER_AGENT = String(settings.userAgent || "Lavf/61.1.100"); // as FFmpeg introduces itself

const files = new Map(); // "movie:123.avi" -> what the helper knows about the file
const byToken = new Map();
let provider = null; // the one provider connection
let active = null; // the FFmpeg run
let warmTimer = 0;
let lastError = { error: "", at: 0 };

function seconds(since) {
  return ((Date.now() - since) / 1000).toFixed(1) + " s";
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileFor(q) {
  const id = q.kind + ":" + q.id + "." + q.ext;
  let file = files.get(id);
  if (file) files.delete(id); // most recent last
  else {
    file = { id, name: q.kind + " " + q.id + "." + q.ext, url: providerUrl(login, q.kind, q.id, q.ext), size: 0, blocks: new Map(), cached: 0, token: randomBytes(16).toString("hex"), info: null, infoAt: 0, pipeOk: false };
    byToken.set(file.token, file);
  }
  files.set(id, file);
  while (files.size > FILES_KEPT) {
    const [oldest, old] = files.entries().next().value;
    files.delete(oldest);
    byToken.delete(old.token);
  }
  return file;
}

// The local address FFmpeg reads a file through (the provider's own when its size is
// unknown, since the cache needs it).
function localUrl(file) {
  return file.size > 0 ? `http://127.0.0.1:${port}/p/${file.token}` : file.url;
}

// Keeps whole blocks (or the file's last one) of what was read, within the budget.
function storeBlocks(file, offset, buf, always) {
  for (let at = 0; at < buf.length; at += BLOCK) {
    const piece = buf.subarray(at, at + BLOCK);
    const index = (offset + at) / BLOCK;
    const whole = piece.length === BLOCK || (file.size > 0 && offset + at + piece.length === file.size);
    if (!whole || file.blocks.has(index)) continue;
    if (!always && file.cached + piece.length > CACHE_PER_FILE) return;
    file.blocks.set(index, Buffer.from(piece));
    file.cached += piece.length;
  }
}

function closeProvider() {
  clearTimeout(warmTimer);
  if (!provider) return;
  provider.req.destroy();
  provider = null;
}

// Opens the file at `start` (or with the given `range`), following redirects; any
// other provider connection is closed first. `pos` is where the next byte from the
// provider sits in the file.
function openAt(file, start, range) {
  closeProvider();
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (target) => {
      const lib = target.startsWith("https:") ? https : http;
      const conn = { file, req: null, res: null, pos: start, skip: 0, pending: null, next: start };
      const req = lib.get(target, { headers: { "User-Agent": USER_AGENT, Accept: "*/*", Range: range || "bytes=" + start + "-" } }, (res) => {
        clearTimeout(timer);
        if (provider !== conn) {
          req.destroy();
          return reject(new Error("closed"));
        }
        const status = res.statusCode || 0;
        res.on("error", () => undefined);
        if (status >= 300 && status < 400 && res.headers.location && hops < 5) {
          hops++;
          req.destroy();
          provider = null;
          return go(new URL(res.headers.location, target).toString());
        }
        if (status !== 200 && status !== 206) {
          req.destroy();
          provider = null;
          return reject(new Error("The provider answered HTTP " + status + (res.statusMessage ? " " + res.statusMessage : "") + "."));
        }
        const size = sizeFromAnswer(status, res.headers);
        if (size > 0) file.size = size;
        // A provider that ignores the range sends the whole file: skip to `start`.
        if (status === 200) conn.skip = start;
        conn.res = res;
        resolve(conn);
      });
      conn.req = req;
      provider = conn;
      const timer = setTimeout(() => req.destroy(new Error("no answer in " + PROVIDER_WAIT_MS / 1000 + " seconds")), PROVIDER_WAIT_MS);
      req.on("error", (err) => {
        clearTimeout(timer);
        // Closed on purpose (a newer read took the connection): not a problem to report.
        if (provider !== conn) return reject(new Error("closed"));
        provider = null;
        reject(new Error("Couldn't reach the provider: " + err.message));
      });
    };
    go(file.url);
  });
}

// Sends what a provider connection brings to `out`, from byte `from` to byte `to` of
// the file, caching up to `cacheBytes` of it on the way. `done(ok)` when it ends.
function forward(conn, out, from, to, cacheBytes, done) {
  const file = conn.file;
  let blockStart = conn.pos;
  let acc = [];
  let accBytes = 0;
  let cachedHere = 0;
  const caching = cacheBytes > 0 && conn.pos % BLOCK === 0;
  let finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    conn.res.off("data", onData);
    done(ok);
  };
  function onData(data) {
    let chunk = data;
    if (conn.skip > 0) {
      if (chunk.length <= conn.skip) {
        conn.skip -= chunk.length;
        return;
      }
      chunk = chunk.subarray(conn.skip);
      conn.skip = 0;
    }
    const at = conn.pos;
    conn.pos += chunk.length;
    if (caching && cachedHere < cacheBytes) {
      acc.push(chunk);
      accBytes += chunk.length;
      while (accBytes >= BLOCK || (file.size > 0 && accBytes > 0 && blockStart + accBytes >= file.size)) {
        const all = Buffer.concat(acc);
        const take = Math.min(BLOCK, all.length);
        storeBlocks(file, blockStart, all.subarray(0, take), false);
        blockStart += take;
        cachedHere += take;
        acc = take < all.length ? [all.subarray(take)] : [];
        accBytes = all.length - take;
        if (take < BLOCK) break;
      }
    }
    const first = Math.max(0, from - at);
    const last = Math.min(chunk.length, to - at + 1);
    if (last > first && !out.write(chunk.subarray(first, last))) {
      conn.res.pause();
      out.once("drain", () => conn.res.resume());
    }
    if (conn.pos > to) finish(true);
  }
  conn.res.on("data", onData);
  conn.res.once("end", () => finish(true));
  conn.res.once("error", () => finish(false));
  conn.res.resume();
}

// Waits until `stream` takes more, or goes away.
function drained(stream) {
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
  });
}

// Reads the first 4 MB into the cache. The connection stays open just after them, so a
// stream from the start carries on with it.
async function readHead(file) {
  const since = Date.now();
  const conn = await openAt(file, 0);
  const chunks = [];
  let got = 0;
  let firstAt = 0;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      conn.res.off("data", onData);
      resolve();
    };
    const onData = (chunk) => {
      if (!firstAt) firstAt = Date.now();
      chunks.push(chunk);
      got += chunk.length;
      if (got >= HEAD_BYTES) {
        conn.res.pause();
        done();
      }
    };
    const timer = setTimeout(() => {
      conn.res.pause();
      done();
    }, HEAD_WAIT_MS);
    conn.res.on("data", onData);
    conn.res.once("end", done);
    conn.res.once("error", done);
  });
  const all = Buffer.concat(chunks);
  const head = all.subarray(0, Math.min(all.length, HEAD_BYTES));
  storeBlocks(file, 0, head, true);
  conn.pos = all.length;
  conn.next = head.length;
  conn.pending = all.subarray(head.length);
  say(`Opening ${file.name}: the provider started sending after ${firstAt ? seconds(since) : "-"}, the first ${(head.length / BLOCK).toFixed(1)} MB took ${seconds(since)}.`);
  return head;
}

// The last 64 KB, for the OpenSubtitles fingerprint the TV would otherwise fetch itself
// (two more requests before the video starts). Best effort.
async function readTail(file) {
  const conn = await openAt(file, 0, "bytes=-" + HASH_BYTES);
  if (conn.res.statusCode !== 206) return closeProvider(); // the whole file: not worth it
  const chunks = [];
  await new Promise((resolve) => {
    conn.res.on("data", (chunk) => chunks.push(chunk));
    conn.res.once("end", resolve);
    conn.res.once("error", resolve);
    conn.res.resume();
  });
  closeProvider();
  const tail = Buffer.concat(chunks);
  if (tail.length === HASH_BYTES) file.tail = tail;
}

// Stops FFmpeg on purpose, so its exit isn't reported as a problem.
function stopRun(child) {
  child.stoppedByHelper = true;
  child.kill();
}

// Frees the provider's one connection for something new.
async function takeSlot() {
  const busy = !!active || !!provider;
  if (active) {
    const old = active;
    active = null;
    stopRun(old);
  }
  closeProvider();
  if (busy) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
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

// FFmpeg's description of a file: from bytes handed to it, or from an address.
function probe(input, bytes) {
  return new Promise((resolve) => {
    // FFmpeg reads the provider itself only when the file's size is unknown.
    const agent = !bytes && input.indexOf("http://127.0.0.1:") !== 0 ? ["-user_agent", USER_AGENT] : [];
    const args = bytes ? ["-hide_banner", "-i", "pipe:0"] : ["-hide_banner", "-nostdin", ...agent, "-i", input];
    const child = spawn(ffmpeg.path, args, { windowsHide: true });
    let text = "";
    child.stderr.on("data", (d) => {
      text = (text + d).slice(-200000);
    });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.on("error", (err) => {
      text += "\n" + err.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!/Stream #/.test(text)) text += "\nFFmpeg stopped without saying why (" + (signal || "code " + code) + ").";
      resolve(text);
    });
    if (bytes) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(bytes);
    }
  });
}

// What the file holds, with each sound track's plan for what this TV asked (audio=aac).
function withPlans(file, q) {
  return { ...file.info, audio: file.info.audio.map((a) => ({ ...a, plan: audioPlan(a, q.audio) })), hash: file.hash || "" };
}

async function infoOf(q) {
  const file = fileFor(q);
  if (file.info && Date.now() - file.infoAt < INFO_TTL_MS && file.blocks.has(0)) return withPlans(file, q);
  await takeSlot();
  // The fingerprint's end first, so the connection that reads the start can stay open.
  if (q.hash && !file.tail) {
    try {
      await readTail(file);
    } catch (err) {
      say("  No fingerprint for online subtitles: " + err.message);
    }
  }
  const head = await readHead(file);
  if (file.tail && head.length >= HASH_BYTES && file.size >= 2 * HASH_BYTES) file.hash = osHash(file.size, head.subarray(0, HASH_BYTES), file.tail);
  let text = await probe("", head);
  let result = parseProbe(text);
  file.pipeOk = !!(result.video || result.audio.length);
  if (!file.pipeOk) {
    // Some files (MP4 with its index at the end) can't be read from their start alone.
    closeProvider();
    text = await probe(localUrl(file), null);
    result = parseProbe(text);
    if (!result.video && !result.audio.length) throw new Error(lastLines(text) || "FFmpeg couldn't read the file.");
  }
  file.info = {
    duration: result.duration,
    video: result.video,
    audio: result.audio.map((a) => ({ ...a, plan: audioPlan(a) })),
    videoPlan: result.video ? videoPlan(result.video.codec) : "copy",
    encoder,
  };
  file.infoAt = Date.now();
  // Keep the connection for a stream from the start, but not for long.
  if (q.start > 0 || !file.pipeOk) closeProvider();
  else {
    clearTimeout(warmTimer);
    const warm = provider;
    warmTimer = setTimeout(() => {
      if (provider === warm && !warm.inUse) closeProvider();
    }, WARM_MS);
  }
  return withPlans(file, q);
}

// Feeds a file to FFmpeg from the start: the cached first blocks, then the rest from
// the provider (on the connection that read them, when it's still open).
async function feedFromStart(child, file) {
  const stdin = child.stdin;
  stdin.on("error", () => undefined);
  let gone = false;
  child.once("close", () => {
    gone = true;
  });
  let pos = 0;
  for (;;) {
    const block = file.blocks.get(pos / BLOCK);
    if (!block) break;
    pos += block.length;
    if (!stdin.write(block)) await drained(stdin);
    if (gone) return;
  }
  if (file.size > 0 && pos >= file.size) return stdin.end();
  let conn = provider && provider.file === file && provider.next === pos ? provider : null;
  if (!conn) conn = await openAt(file, pos);
  if (gone) return closeProvider();
  conn.inUse = true;
  clearTimeout(warmTimer);
  if (conn.pending && conn.pending.length) stdin.write(conn.pending);
  conn.pending = null;
  const ownConn = conn;
  child.once("close", () => {
    if (provider === ownConn) closeProvider();
  });
  forward(conn, stdin, conn.pos, file.size > 0 ? file.size - 1 : Infinity, 0, () => stdin.end());
}

// The local address: answers FFmpeg's range requests from the cache, and the rest from
// the provider. Only this computer may ask.
async function serveFile(req, res, file) {
  const remote = req.socket.remoteAddress || "";
  if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) {
    res.writeHead(403);
    return res.end();
  }
  const want = askedRange(req.headers.range, file.size);
  if (want.start >= file.size) {
    res.writeHead(416, { "Content-Range": "bytes */" + file.size });
    return res.end();
  }
  const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": String(want.end - want.start + 1) };
  if (want.partial) headers["Content-Range"] = `bytes ${want.start}-${want.end}/${file.size}`;
  res.writeHead(want.partial ? 206 : 200, headers);
  if (req.method === "HEAD") return res.end();
  let closed = false;
  let conn = null;
  res.on("close", () => {
    closed = true;
    if (conn && provider === conn) closeProvider();
  });
  let pos = want.start;
  while (pos <= want.end && !closed) {
    const index = Math.floor(pos / BLOCK);
    const block = file.blocks.get(index);
    if (!block) break;
    const from = pos - index * BLOCK;
    const piece = block.subarray(from, Math.min(block.length, from + (want.end - pos + 1)));
    pos += piece.length;
    if (!res.write(piece)) await drained(res);
  }
  if (closed) return;
  if (pos > want.end) return res.end();
  // From the start of the block, so the whole block can be cached too.
  const aligned = Math.floor(pos / BLOCK) * BLOCK;
  try {
    conn = await openAt(file, aligned);
  } catch (err) {
    if (err.message !== "closed") noteError("Couldn't read " + file.name + " from the provider: " + err.message);
    return res.destroy();
  }
  if (closed) return closeProvider();
  forward(conn, res, pos, want.end, CACHE_PER_READ, () => {
    if (provider === conn) closeProvider();
    res.end();
  });
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

function describePlan(info, video, q) {
  let picture = "no picture";
  if (info.video && video === "convert") {
    const size = outputSize(info.video, video, q.height);
    picture = `picture ${info.video.codec} converted to H.264${size.height ? " at " + size.height + "p" : ""} with ${ENCODER_NAMES[encoder]}`;
  } else if (info.video) {
    picture = `picture ${info.video.codec} kept`;
  }
  const sound = info.audio.map((a) => (a.plan === "copy" ? a.codec + " kept" : a.codec + " to " + a.plan.toUpperCase())).join(", ") || "no sound";
  return picture + "; sound " + sound;
}

// Pictures that can't be repackaged are converted whatever the TV asked for.
function videoMode(q, info) {
  return q.video === "convert" || info.videoPlan === "convert" ? "convert" : "copy";
}

function videoCodec(info) {
  return info.video ? info.video.codec : "";
}

// From the start, the helper feeds FFmpeg itself; elsewhere FFmpeg reads the local
// address, which can jump.
function readsFromStart(q, file) {
  return q.start === 0 && file.pipeOk && file.blocks.has(0);
}

// Frees the provider's connection for a new run, but keeps the one that has just read
// the file's start, for a run from the start to carry on with.
async function slotFor(q, file) {
  if (readsFromStart(q, file) && provider && provider.file === file && !provider.inUse) {
    if (active) {
      const old = active;
      active = null;
      stopRun(old);
    }
  } else await takeSlot();
}

// Starts FFmpeg on the file (`hls` { dir } for HLS, otherwise a stream on stdout).
function startFfmpeg(q, file, info, video, hwaccel, hls) {
  const piped = readsFromStart(q, file);
  const input = piped ? "pipe:0" : localUrl(file);
  const args = ffmpegArgs({
    input,
    start: q.start,
    video,
    encoder,
    probe: info,
    height: q.height,
    audio: q.audio,
    track: q.track,
    hwaccel,
    userAgent: input === file.url ? USER_AGENT : "",
    hls,
  });
  if (process.env.ARANPLUS_HELPER_DEBUG) say("  reading " + (piped ? "from the start, fed by the helper" : input));
  const child = spawn(ffmpeg.path, args, { windowsHide: true });
  active = child;
  if (piped) {
    feedFromStart(child, file).catch((err) => {
      if (err.message !== "closed") noteError("Couldn't read " + file.name + " from the provider: " + err.message);
      stopRun(child);
    });
  }
  return child;
}

// The Samsung TV's stream: one endless MPEG-TS, ended when the TV closes it.
async function stream(req, res, q) {
  const since = Date.now();
  let info;
  try {
    info = await infoOf(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  const file = fileFor(q);
  const video = videoMode(q, info);
  await slotFor(q, file);
  if (res.destroyed) return;
  forgetNewestSession();
  say(`Playing ${file.name} from ${clock(q.start)}: ${describePlan(info, video, q)}`);
  runStream(res, q, file, info, video, video === "convert" && useHwaccel(videoCodec(info)), since);
}

function runStream(res, q, file, info, video, hwaccel, since) {
  const child = startFfmpeg(q, file, info, video, hwaccel, null);
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
    say(`  Sending to the TV after ${seconds(since)}.`);
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
        say("  Decoding on the graphics card didn't work (" + (lastLines(stderr) || "code " + code) + "); trying the processor.");
        hwaccelFailed.add(videoCodec(info));
        pause(SETTLE_MS).then(() => {
          if (!res.destroyed && !active) runStream(res, q, file, info, video, false, since);
          else if (!res.headersSent) sendJson(res, 502, { error: "Another request took over." });
        });
        return;
      }
      noteError((lastLines(stderr) || "FFmpeg stopped (" + code + ").") + " (" + file.name + ")");
      if (!res.headersSent) sendJson(res, 502, { error: lastError.error });
      else res.end();
      return;
    }
    if (code !== 0 && !child.stoppedByHelper && stderr.trim() !== "") noteError(lastLines(stderr));
    say(`  Stopped after ${clock(secs)}.`);
    res.end();
  });
  // The TV went away (Back, a jump, another title): free the provider's connection.
  res.on("close", () => {
    if (!res.writableEnded && active === child) {
      active = null;
      stopRun(child);
      closeProvider();
    }
  });
}

// --- HLS, for the Roku ----------------------------------------------------------------
//
// Each request for /v1/hls/index.m3u8 is a session: FFmpeg, reading through the helper
// like the stream above, writes numbered segments and a growing playlist into the
// session's own folder under the system's temp folder. The Roku gets a small master
// playlist naming the session's playlist, which it re-reads as it grows; re-reading
// never starts FFmpeg again. A request identical to the running session's (Roku asking
// again after a hiccup) gets that session back.

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

function startSession(q, file, info, video, hwaccel, sessionId) {
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
  const child = startFfmpeg(q, file, info, video, hwaccel, { dir });
  current.child = child;
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
      say(`  Stopped after ${clock(secs)}.`);
      return;
    }
    if (code === 0) {
      current.state = "done";
      say(`  Converted to the end in ${clock(secs)}.`);
      return;
    }
    // A graphics card that can't decode this picture: try once more on the processor.
    if (hwaccel && playlistState(readPlaylist(current)).segments === 0 && !active) {
      say("  Decoding on the graphics card didn't work (" + (lastLines(stderr) || "code " + code) + "); trying the processor.");
      hwaccelFailed.add(videoCodec(info));
      current.state = "retrying";
      pause(SETTLE_MS).then(() => {
        if (sessions.has(id) && current.state === "retrying" && !active) startSession(q, file, info, video, false, id);
        else if (current.state === "retrying") current.state = "stopped";
      });
      return;
    }
    current.state = "failed";
    current.error = (lastLines(stderr) || "FFmpeg stopped (" + code + ").") + " (" + file.name + ")";
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
  const since = Date.now();
  let info;
  try {
    info = await infoOf(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  const file = fileFor(q);
  const video = videoMode(q, info);
  const wanted = sessionKey(q, video);
  let session = null;
  for (const s of sessions.values()) {
    if (s.key === wanted && s.id === newestId && (s.state === "running" || s.state === "done" || s.state === "retrying")) session = s;
  }
  if (!session) {
    await slotFor(q, file);
    if (res.destroyed) return;
    say(`Playing ${file.name} from ${clock(q.start)} (HLS): ${describePlan(info, video, q)}`);
    session = startSession(q, file, info, video, video === "convert" && useHwaccel(videoCodec(info)), "");
    session.fresh = true;
  }
  session.seen = Date.now();
  const problem = await sessionReady(session, res);
  if (res.destroyed) return;
  if (problem) return sendJson(res, 502, { error: redact(problem) });
  // Says when the first segments were ready, as the stream says when it starts sending.
  if (session.fresh) say(`  The first segments were ready after ${seconds(since)}.`);
  session.fresh = false;
  session.seen = Date.now();
  res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...CORS });
  res.end(masterPlaylist(session.id, outputSize(info.video, video, q.height)));
}

// The session's own playlist (re-read by Roku as it grows) and its segments.
function serveSessionFile(req, res, sessionId, name) {
  const session = sessionFile(sessionId, name) ? sessions.get(sessionId) : null;
  if (!session) return sendJson(res, 404, { error: "Nothing here." });
  session.seen = Date.now();
  if (name === "index.m3u8") {
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
  const filePath = path.join(session.dir, name);
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

// Stops a run that nobody needs any more, and lets go of its provider connection.
function stopSessionRun(session) {
  if (!session.child) return;
  if (active === session.child) {
    active = null;
    closeProvider();
  }
  stopRun(session.child);
}

function removeSession(session) {
  stopSessionRun(session);
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
      stopSessionRun(session);
    }
    const keep = session.id === newestId ? NEWEST_KEEP_MS : IDLE_STOP_MS;
    if (idle > keep) removeSession(session);
  }
}

// The TV left the video: stop FFmpeg and the provider connection now, so the
// provider's one connection is free for whatever plays next. The files go with the
// usual tidying.
function stopAll() {
  if (active) {
    const old = active;
    active = null;
    stopRun(old);
  }
  closeProvider();
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
  if (url.pathname.indexOf("/p/") === 0) {
    const file = byToken.get(url.pathname.slice(3));
    if (!file || !file.size) return sendJson(res, 404, { error: "Nothing here." });
    return serveFile(req, res, file).catch(() => res.destroy());
  }
  if (!keyMatches(url.searchParams.get("key"))) return sendJson(res, 401, { error: "Wrong or missing key." });
  // "ago" (seconds) lets a TV tell a fresh reason from an old one.
  if (url.pathname === "/v1/last-error") return sendJson(res, 200, { ...lastError, ago: lastError.at ? Math.round((Date.now() - lastError.at) / 1000) : -1 });
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
    return infoOf(q).then(
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
  closeProvider();
  for (const session of [...sessions.values()]) removeSession(session);
  process.exit(0);
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
