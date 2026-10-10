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
// Reading ahead (`ahead` bytes, for FFmpeg's reads through the file): a provider's server
// starts a connection slowly and, once it has sat idle for a moment, starts it slowly
// again; on a long path to it the slow part lasts many seconds (12 to 24 Mbit/s for 13
// seconds, measured at home, then 300). A player reads in bursts, filling its buffer and
// then pausing, so every burst began slowly and a 25 Mbit/s film played ten seconds and
// buffered ten. So the helper reads on as fast as the provider sends, up to `ahead` bytes
// past where FFmpeg has got to, keeping the connection busy and fast, and FFmpeg reads
// from what's held; a jump inside it is answered at once. The connection is let go
// 30 seconds after nobody reads.
//
// No I/O of its own: the caller passes `fetch` (helper/http-get.mjs), so tests can stand in
// for the provider.

// Up to 8 MB from each end of the last 4 files: enough for FFmpeg's first look at a
// file and for the index of an MKV or MP4.
export const HEAD_BYTES = 8 * 1024 * 1024;
export const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;
const REDIRECT_KEEP_MS = 10 * 60 * 1000;
const BEHIND_BYTES = 16 * 1024 * 1024; // kept behind where FFmpeg is, for small jumps back
const SKIP_BYTES = 16 * 1024 * 1024; // a read this far past what's held waits for it
const LET_GO_MS = 30000; // the connection is let go this long after nobody reads (letGoMs)

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
  // ahead: bytes to read ahead of FFmpeg (0: none); onAhead({ key, held, received, ms,
  // waited }): told how reading ahead goes, every minute or so (`received` bytes in `ms`,
  // `waited` of them holding all it keeps).
  constructor({ fetch, userAgent = "", onRequest = () => undefined, ahead = 0, onAhead = () => undefined, letGoMs = LET_GO_MS }) {
    this.fetchImpl = fetch;
    this.userAgent = userAgent;
    this.onRequest = onRequest;
    this.ahead = ahead;
    this.onAhead = onAhead;
    this.letGoMs = letGoMs;
    this.files = new Map();
    this.exclusive = null; // the one request to the provider FFmpeg has open
    this.reading = null; // the ReadAhead holding the provider's connection, if any
  }

  // Lets go of the connection read ahead on, unless it's for `keep` (a file's key).
  stopReadAhead(keep = "") {
    if (this.reading && this.reading.file.key !== keep) {
      this.reading.stop();
      this.reading = null;
    }
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
      // FFmpeg reading through the file: from what's read ahead (see the top), which
      // starts anywhere but the very end (where FFmpeg only looks at the index).
      const held = this.reading && this.reading.file === file && this.reading.covers(pos);
      if (exclusive && end < 0 && this.ahead > 0 && (held || (file.size > 0 && pos < file.size - TAIL_BYTES))) {
        let reading = this.reading;
        if (!held) {
          this.stopReadAhead();
          if (this.exclusive) this.exclusive.abort();
          reading = this.reading = new ReadAhead(this, file, pos);
        }
        for await (const piece of reading.read(pos, signal)) {
          pos += piece.length;
          yield piece;
        }
        if (reading.error && !(signal && signal.aborted)) throw reading.error;
        return;
      }
      // Anything else that needs the connection takes it from reading ahead, which keeps
      // what it holds and goes on when it's read from again.
      if (exclusive && this.reading) this.reading.pause();
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

// Reading a file ahead of FFmpeg, from `start`, as fast as the provider sends, up to the
// owner's `ahead` bytes past the furthest FFmpeg has read (see the top). The bytes held
// run from `base` to `end`; FFmpeg reads them with read(), which waits for more.
class ReadAhead {
  constructor(owner, file, start) {
    this.owner = owner;
    this.file = file;
    this.chunks = []; // from index `first` on; `offsets` holds where each starts
    this.offsets = [];
    this.first = 0;
    this.end = start;
    this.reader = start; // the furthest FFmpeg has read
    this.readers = 0;
    this.done = false;
    this.error = null;
    this.waiters = [];
    this.room = null;
    this.abort = new AbortController();
    this.paused = false;
    this.runs = 0; // which run of the connection is current (pause and resume start another)
    this.letGo = 0;
    this.received = 0;
    this.waited = 0; // of the time since lastReport, how long it held all it keeps
    this.lastReport = Date.now();
    this.run(start);
  }

  // Lets go of the connection for something else, keeping what's held; reading from
  // further on than that goes on with a new request (resume).
  pause() {
    if (this.paused || this.done) return;
    this.paused = true;
    this.abort.abort();
    if (this.room) this.room();
  }

  resume() {
    if (!this.paused || this.done) return;
    this.paused = false;
    this.abort = new AbortController();
    this.run(this.end);
  }

  get base() {
    return this.first < this.chunks.length ? this.offsets[this.first] : this.end;
  }

  get held() {
    return this.end - this.reader;
  }

  // Whether a read from `pos` can come from here (now, or once reading has got there).
  covers(pos) {
    if (pos < this.base) return false;
    if (pos < this.end) return true;
    return !this.done && pos <= this.end + SKIP_BYTES;
  }

  async run(start) {
    let pos = start;
    let stalls = 0;
    const signal = this.abort.signal;
    const mine = ++this.runs;
    // An earlier run still winding down after a pause adds nothing, and decides nothing.
    const current = () => mine === this.runs && !signal.aborted;
    try {
      while (!signal.aborted && (this.file.size === 0 || pos < this.file.size)) {
        const answer = await this.owner.request(this.file, pos, -1, signal);
        const from = pos;
        let skip = answer.status === 200 ? pos : 0;
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
            if (!current()) break;
            // The start and the end of the file are kept for next time, as on other reads.
            this.file.recorder(pos)(chunk);
            this.push(chunk);
            pos += chunk.length;
            // Held enough: wait for FFmpeg to read on (the connection stays open).
            if (this.held > this.owner.ahead) {
              const since = Date.now();
              while (this.held > this.owner.ahead && !signal.aborted) await new Promise((resolve) => (this.room = resolve));
              this.waited += Date.now() - since;
            }
            if (signal.aborted) break;
          }
        } catch {
          if (signal.aborted) break;
          // The provider dropped the connection: asked again below.
        }
        await cancel(answer);
        if (signal.aborted || this.file.size === 0 || pos >= this.file.size) break;
        stalls = pos > from ? 0 : stalls + 1;
        if (stalls >= 2) throw new SourceError("The provider stopped sending " + this.file.key + " at byte " + pos);
      }
    } catch (err) {
      if (!signal.aborted) this.error = err;
    }
    // Paused for something else (not done: it goes on when read from again), or a newer
    // run has taken over.
    if (mine !== this.runs || (this.paused && signal.aborted && !this.error)) return;
    this.done = true;
    this.wake();
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.offsets.push(this.end);
    this.end += chunk.length;
    this.received += chunk.length;
    this.wake();
    const now = Date.now();
    if (now - this.lastReport >= 60000) {
      this.owner.onAhead({ key: this.file.key, held: this.held, received: this.received, ms: now - this.lastReport, waited: Math.min(this.waited, now - this.lastReport) });
      this.received = 0;
      this.waited = 0;
      this.lastReport = now;
    }
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  // The held bytes from `pos` (inside what's held), up to the end of their chunk.
  slice(pos) {
    let lo = this.first;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return this.chunks[lo].subarray(pos - this.offsets[lo]);
  }

  // FFmpeg has read up to `pos`: what's well behind goes, and reading may go on.
  advance(pos) {
    if (pos > this.reader) this.reader = pos;
    while (this.first < this.chunks.length - 1 && this.offsets[this.first + 1] <= this.reader - BEHIND_BYTES) {
      this.chunks[this.first] = null;
      this.first++;
    }
    if (this.first > 4096) {
      this.chunks = this.chunks.slice(this.first);
      this.offsets = this.offsets.slice(this.first);
      this.first = 0;
    }
    if (this.room && this.held <= this.owner.ahead) {
      const resolve = this.room;
      this.room = null;
      resolve();
    }
  }

  async *read(pos, signal) {
    this.readers++;
    clearTimeout(this.letGo);
    try {
      for (;;) {
        if (signal && signal.aborted) return;
        if (pos < this.end && pos >= this.base) {
          const piece = this.slice(pos);
          pos += piece.length;
          this.advance(pos);
          yield piece;
          continue;
        }
        if (this.done || pos < this.base) return;
        // Waiting further on than FFmpeg had got to: reading goes on to there.
        this.advance(pos);
        this.resume();
        await new Promise((resolve) => {
          this.waiters.push(resolve);
          if (signal) signal.addEventListener("abort", resolve, { once: true });
        });
      }
    } finally {
      this.readers--;
      // Nobody reading for a while (the TV went back): let the connection go.
      if (this.readers === 0) {
        this.letGo = setTimeout(() => {
          if (this.readers === 0 && this.owner.reading === this) this.owner.stopReadAhead();
        }, this.owner.letGoMs);
        if (this.letGo.unref) this.letGo.unref();
      }
    }
  }

  stop() {
    clearTimeout(this.letGo);
    this.paused = false;
    this.abort.abort();
    this.done = true;
    this.chunks = [];
    this.offsets = [];
    this.first = 0;
    if (this.room) this.room();
    this.wake();
  }
}
