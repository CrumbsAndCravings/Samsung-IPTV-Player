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
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENCODERS, askedRange, audioPlan, ffmpegArgs, osHash, parseProbe, providerUrl, redactor, sizeFromAnswer, videoPlan } from "./plan.mjs";

const VERSION = "1.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const DEFAULT_PORT = 8090;
const PROBE_TIMEOUT_MS = 30000;
const FIRST_BYTES_MS = 45000; // the provider can be slow to start a file
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
        if (provider === conn) provider = null;
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
    const args = bytes ? ["-hide_banner", "-i", "pipe:0"] : ["-hide_banner", "-nostdin", "-i", input];
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

async function info(q) {
  const file = fileFor(q);
  if (file.info && Date.now() - file.infoAt < INFO_TTL_MS && file.blocks.has(0)) return { ...file.info, hash: file.hash || "" };
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
  return { ...file.info, hash: file.hash || "" };
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

function readQuery(url) {
  const p = url.searchParams;
  const q = {
    kind: p.get("kind") === "series" ? "series" : "movie",
    id: p.get("id") || "",
    ext: (p.get("ext") || "").toLowerCase(),
    start: Math.max(0, Math.floor(Number(p.get("start")) || 0)),
    video: p.get("video") === "convert" ? "convert" : "copy",
    hash: p.get("hash") === "1",
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
  const since = Date.now();
  let described;
  try {
    described = await info(q);
  } catch (err) {
    noteError("Couldn't read " + q.kind + " " + q.id + "." + q.ext + " from the provider: " + err.message);
    return sendJson(res, 502, { error: lastError.error });
  }
  if (res.destroyed) return;
  const file = fileFor(q);
  // Pictures that can't be repackaged are converted whatever the TV asked for.
  const video = q.video === "convert" || described.videoPlan === "convert" ? "convert" : "copy";
  // From the start, the helper feeds FFmpeg itself; elsewhere FFmpeg reads the local
  // address, which can jump.
  const piped = q.start === 0 && file.pipeOk && file.blocks.has(0);
  if (piped && provider && provider.file === file && !provider.inUse) {
    if (active) {
      const old = active;
      active = null;
      stopRun(old);
    }
  } else await takeSlot();
  if (res.destroyed) return;
  const args = ffmpegArgs({ input: piped ? "pipe:0" : localUrl(file), start: q.start, video, encoder, probe: described });
  say(`Playing ${file.name} from ${clock(q.start)}: ${describePlan(described, video)}`);
  if (process.env.ARANPLUS_HELPER_DEBUG) say("  reading " + (piped ? "from the start, fed by the helper" : localUrl(file)));
  const child = spawn(ffmpeg.path, args, { windowsHide: true });
  active = child;
  if (piped) {
    feedFromStart(child, file).catch((err) => {
      noteError("Couldn't read " + file.name + " from the provider: " + err.message);
      stopRun(child);
    });
  }
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === "/") return sendJson(res, 200, { ok: true, service: "aranplus-helper", version: VERSION, encoder });
  if (url.pathname.indexOf("/p/") === 0) {
    const file = byToken.get(url.pathname.slice(3));
    if (!file || !file.size) return sendJson(res, 404, { error: "Nothing here." });
    return serveFile(req, res, file).catch(() => res.destroy());
  }
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
  closeProvider();
  process.exit(0);
});
