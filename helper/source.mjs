// Reading the provider's files for FFmpeg (and for Safari's MP4s), so a jump costs one
// request to the provider instead of four or five.
//
// FFmpeg reads a file over HTTP in pieces: from the start (the file's header), from near
// the end (MKV and MP4 files keep their index there), back to the start, then from
// wherever a jump lands. Every one of those is a new request, and an IPTV provider can
// take seconds to answer each. So FFmpeg reads through the helper instead, which keeps
// the start and the end of each file it has seen and answers those parts itself, so
// only the jump's own request reaches the provider. It also remembers where the
// provider redirected a file to (Xtream servers send each one on to a streaming
// server), saving a round trip per request, and keeps one request to the provider open
// at a time, as providers allowing one connection need.
//
// When the provider drops a connection partway, the reader asks again from where it got
// to, so FFmpeg and Safari don't notice.
//
// No I/O of its own: the caller passes `fetch` (helper/http-get.mjs), so tests can stand in
// for the provider.

// Up to 8 MB from each end of the last 4 files: enough for FFmpeg's first look at a
// file and for the index of an MKV or MP4.
export const HEAD_BYTES = 8 * 1024 * 1024;
export const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;
const REDIRECT_KEEP_MS = 10 * 60 * 1000;

export class SourceError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// "bytes 0-1023/46000000" -> 46000000; 0 when it doesn't say.
export function totalFromContentRange(header) {
  const match = /\/(\d+)\s*$/.exec(header || "");
  return match ? Number(match[1]) : 0;
}

// A Range header's first range: { start, end } (end -1 for "to the end"), or null.
export function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)/.exec(header || "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") return { suffix: Number(match[2]) };
  return { start: Number(match[1]), end: match[2] === "" ? -1 : Number(match[2]) };
}

class SourceFile {
  constructor(key, url) {
    this.key = key;
    this.url = url;
    this.size = 0; // 0 until the provider says
    this.head = []; // chunks from byte 0
    this.headLength = 0;
    this.tail = null; // { start, chunks, length }, up to the end of the file
    this.redirect = ""; // where the provider sent this file last
    this.redirectAt = 0;
    this.joined = { head: null, tail: null };
  }

  // Cached bytes from `pos` (at most up to `end`, inclusive), or null.
  cachedAt(pos, end) {
    if (pos < this.headLength) {
      if (!this.joined.head) this.joined.head = Buffer.concat(this.head);
      return this.joined.head.subarray(pos, Math.min(this.headLength, end + 1));
    }
    const tail = this.tail;
    if (tail && pos >= tail.start && pos < tail.start + tail.length) {
      if (!this.joined.tail) this.joined.tail = Buffer.concat(tail.chunks);
      return this.joined.tail.subarray(pos - tail.start, Math.min(tail.length, end + 1 - tail.start));
    }
    return null;
  }

  // Keeps what arrives from `pos` when it continues the start, or lies near the end.
  recorder(pos) {
    if (pos === this.headLength && pos < HEAD_BYTES) {
      return (chunk) => {
        if (this.headLength >= HEAD_BYTES) return;
        const piece = chunk.subarray(0, HEAD_BYTES - this.headLength);
        this.head.push(piece);
        this.headLength += piece.length;
        this.joined.head = null;
      };
    }
    if (this.size > 0 && pos >= this.size - TAIL_BYTES) {
      const tail = this.tail;
      if (!tail || pos < tail.start || pos > tail.start + tail.length) this.tail = { start: pos, chunks: [], length: 0 };
      else if (pos < tail.start + tail.length) return () => undefined; // already kept
      const kept = this.tail;
      return (chunk) => {
        if (this.tail !== kept) return;
        kept.chunks.push(chunk);
        kept.length += chunk.length;
        this.joined.tail = null;
      };
    }
    return () => undefined;
  }
}

export class SourceFiles {
  // fetch: httpGet from helper/http-get.mjs (or a stand-in); userAgent: how to introduce ourselves;
  // onRequest({ key, start, ms, status }): told about each request to the provider.
  constructor({ fetch, userAgent = "", onRequest = () => undefined }) {
    this.fetchImpl = fetch;
    this.userAgent = userAgent;
    this.onRequest = onRequest;
    this.files = new Map();
    this.exclusive = null; // the one request to the provider FFmpeg has open
  }

  file(key, url) {
    let file = this.files.get(key);
    if (!file || file.url !== url) {
      file = new SourceFile(key, url);
      this.files.set(key, file);
      while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value);
    } else {
      // Most recently used last.
      this.files.delete(key);
      this.files.set(key, file);
    }
    return file;
  }

  // One request to the provider for bytes from `pos` (to `end`, or the end of the file
  // when -1), following and remembering its redirect.
  async request(file, pos, end, signal) {
    const headers = { Range: "bytes=" + pos + "-" + (end >= 0 ? end : ""), "Accept-Encoding": "identity" };
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    const fresh = file.redirect && Date.now() - file.redirectAt < REDIRECT_KEEP_MS;
    const started = Date.now();
    let answer = await this.fetchImpl(fresh ? file.redirect : file.url, { headers, signal, redirect: "follow" });
    // A remembered redirect that has gone stale: ask the provider again.
    if (fresh && (answer.status === 401 || answer.status === 403 || answer.status === 404 || answer.status === 410)) {
      await cancel(answer);
      file.redirect = "";
      answer = await this.fetchImpl(file.url, { headers, signal, redirect: "follow" });
    }
    this.onRequest({ key: file.key, start: pos, ms: Date.now() - started, status: answer.status });
    if (answer.status >= 400) {
      const text = await answer.text().catch(() => "");
      throw new SourceError("The provider answered HTTP " + answer.status + (text.trim() ? ": " + text.trim().slice(0, 120) : ""), answer.status);
    }
    if (answer.url && answer.url !== file.url) {
      file.redirect = answer.url;
      file.redirectAt = Date.now();
    }
    if (answer.status === 206) {
      const total = totalFromContentRange(answer.headers.get("content-range"));
      if (total > 0) file.size = total;
    } else {
      const length = Number(answer.headers.get("content-length") || 0);
      if (length > 0) file.size = length;
    }
    return answer;
  }

  // The file's size, asking the provider for its first bytes if it isn't known yet.
  async size(file, signal) {
    if (file.size > 0) return file.size;
    for await (const chunk of this.bytes(file, 0, 0, signal)) void chunk;
    return file.size;
  }

  // Bytes `start` to `end` (inclusive; -1 for the end of the file), as they come: from
  // what's kept where possible, otherwise from the provider (keeping the start and the
  // end of the file for next time). With `exclusive`, a request still open from an
  // earlier call is stopped first.
  async *bytes(file, start, end, signal, { exclusive = false } = {}) {
    let pos = start;
    let stalls = 0; // requests in a row that brought nothing
    // The last byte wanted, once the provider has said how big the file is.
    const lastByte = () => (end >= 0 ? end : file.size > 0 ? file.size - 1 : Infinity);
    for (;;) {
      if (pos > lastByte()) return;
      const cached = file.cachedAt(pos, lastByte());
      if (cached && cached.length > 0) {
        pos += cached.length;
        yield cached;
        continue;
      }
      const abort = new AbortController();
      const stop = () => abort.abort();
      if (signal) {
        if (signal.aborted) return;
        signal.addEventListener("abort", stop, { once: true });
      }
      if (exclusive) {
        if (this.exclusive) this.exclusive.abort();
        this.exclusive = abort;
      }
      try {
        const answer = await this.request(file, pos, end, abort.signal);
        const record = file.recorder(pos);
        const from = pos;
        // A provider that ignores ranges sends the whole file: skip to `pos`.
        let skip = answer.status === 200 ? pos : 0;
        if (!answer.body) return;
        try {
          for await (const raw of answer.body) {
            let chunk = Buffer.from(raw);
            if (skip > 0) {
              if (chunk.length <= skip) {
                skip -= chunk.length;
                continue;
              }
              chunk = chunk.subarray(skip);
              skip = 0;
            }
            const room = lastByte() - pos + 1;
            if (chunk.length > room) chunk = chunk.subarray(0, room);
            record(chunk);
            pos += chunk.length;
            yield chunk;
            if (pos > lastByte()) break;
          }
        } catch (err) {
          // Stopped on purpose (a jump, or the reader went away): pass that on.
          if (abort.signal.aborted) throw err;
          // Otherwise the provider dropped the connection; asked again below.
        }
        await cancel(answer);
        // All there, stopped on purpose, or no way to tell what's missing (no size given).
        if (pos > lastByte() || abort.signal.aborted || file.size === 0) return;
        // The provider stopped early, often because it closes a connection the helper is
        // slow to read while FFmpeg is busy converting: ask again from where it got to.
        stalls = pos > from ? 0 : stalls + 1;
        if (stalls >= 2) throw new SourceError("The provider stopped sending " + file.key + " at byte " + pos);
        continue;
      } finally {
        if (signal) signal.removeEventListener("abort", stop);
        if (this.exclusive === abort) this.exclusive = null;
        abort.abort();
      }
    }
  }
}

function cancel(answer) {
  try {
    return answer.body ? answer.body.cancel().catch(() => undefined) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}
