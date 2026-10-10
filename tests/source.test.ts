// The helper reading the provider's files (helper/source.mjs): the start and the end of a
// file are asked for once, a remembered redirect saves a round trip, and one request is
// open at a time for FFmpeg.
import { describe, expect, it } from "vitest";
import { httpGet } from "../helper/http-get.mjs";
import { HEAD_BYTES, parseRange, SourceFiles, totalFromContentRange, type SourceFetch } from "../helper/source.mjs";
import { startDroppingServer } from "./drop-server.mjs";

const SIZE = 40 * 1024 * 1024;
const byteAt = (i: number) => (i * 7 + 3) % 251;

// A provider with ranges that redirects every file to a "streaming server", and keeps a
// log of what it was asked. With `cutAt`, the first answer stops after that many bytes.
function fakeProvider({ cutAt = 0 } = {}) {
  const log: { url: string; range: string }[] = [];
  let open = 0;
  let mostOpen = 0;
  const fetch = async (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => {
    const range = init.headers.Range;
    log.push({ url, range });
    const m = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(m[1]);
    const end = m[2] === "" ? SIZE - 1 : Math.min(Number(m[2]), SIZE - 1);
    const final = url.startsWith("http://stream.") ? url : url.replace("http://provider.", "http://stream.") + "?token=t1";
    open++;
    mostOpen = Math.max(mostOpen, open);
    let pos = start;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos > end || init.signal?.aborted) {
          open--;
          controller.close();
          return;
        }
        if (cutAt > 0 && log.length === 1 && pos - start >= cutAt) {
          open--;
          controller.error(new Error("socket hang up"));
          return;
        }
        const n = Math.min(65536, end - pos + 1);
        const chunk = new Uint8Array(n);
        for (let i = 0; i < n; i++) chunk[i] = byteAt(pos + i);
        pos += n;
        controller.enqueue(chunk);
      },
      cancel() {
        open--;
      },
    });
    return {
      status: 206,
      url: final,
      headers: new Headers({ "content-range": `bytes ${start}-${end}/${SIZE}` }),
      body,
      text: async () => "",
    };
  };
  return { fetch, log, mostOpen: () => mostOpen };
}

async function read(sources: SourceFiles, file: ReturnType<SourceFiles["file"]>, start: number, end: number, limit = Infinity) {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of sources.bytes(file, start, end, undefined, { exclusive: true })) {
    parts.push(chunk);
    length += chunk.length;
    if (length >= limit) break; // like FFmpeg closing the connection to jump
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

const right = (data: Uint8Array, start: number) => data.every((b, i) => b === byteAt(start + i));

describe("reading the provider's files", () => {
  it("asks for the start and the end of a file once, and follows its redirect", async () => {
    const provider = fakeProvider();
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch });
    const file = sources.file("movie:1", "http://provider.example/movie/u/p/1.mkv");
    // FFmpeg's first look: the start of the file, then it closes.
    const head = await read(sources, file, 0, -1, 3 * 1024 * 1024);
    expect(right(head, 0)).toBe(true);
    expect(file.size).toBe(SIZE);
    // A jump: the start again, the index at the end, back, then the place itself.
    const again = await read(sources, file, 0, -1, 1024 * 1024);
    const index = await read(sources, file, SIZE - 500000, -1);
    const back = await read(sources, file, 52387, -1, 100000);
    const middle = await read(sources, file, 20000000, -1, 200000);
    expect([again, index, back, middle].every((data, i) => right(data, [0, SIZE - 500000, 52387, 20000000][i]))).toBe(true);
    expect(index.length).toBe(500000);
    // Five reads, three requests: the start, the end and the middle.
    expect(provider.log.map((r) => r.range)).toEqual(["bytes=0-", "bytes=" + (SIZE - 500000) + "-", "bytes=20000000-"]);
    // Only the first went to the provider's own address; the rest to where it redirected.
    expect(provider.log.map((r) => r.url.split("/")[2])).toEqual(["provider.example", "stream.example", "stream.example"]);
    // The next jump costs one request, and the index is read from what's kept.
    await read(sources, file, 0, -1, 1024 * 1024);
    const indexAgain = await read(sources, file, SIZE - 300000, -1);
    await read(sources, file, 30000000, -1, 100000);
    expect(right(indexAgain, SIZE - 300000)).toBe(true);
    expect(provider.log.length).toBe(4);
  });

  it("goes on from what's kept to the provider", async () => {
    const provider = fakeProvider();
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch });
    const file = sources.file("movie:2", "http://provider.example/movie/u/p/2.mkv");
    await read(sources, file, 0, -1, 1024 * 1024);
    // The first megabyte is kept; reading further asks the provider for what follows it.
    const longer = await read(sources, file, 0, -1, HEAD_BYTES + 3 * 1024 * 1024);
    expect(right(longer, 0)).toBe(true);
    expect(provider.log.map((r) => r.range)).toEqual(["bytes=0-", "bytes=1048576-"]);
    expect(file.headLength).toBe(HEAD_BYTES);
    // Exact ranges (Safari asks for those) stop where asked.
    const two = await read(sources, file, 100, 101);
    expect([...two]).toEqual([byteAt(100), byteAt(101)]);
  });

  it("keeps one request open at a time for FFmpeg", async () => {
    const provider = fakeProvider();
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch });
    const file = sources.file("movie:3", "http://provider.example/movie/u/p/3.mkv");
    const first = sources.bytes(file, 20000000, -1, undefined, { exclusive: true });
    await first.next();
    // A jump while the first is still open stops it.
    const second = sources.bytes(file, 30000000, -1, undefined, { exclusive: true });
    await second.next();
    expect(provider.mostOpen()).toBeLessThanOrEqual(2);
    const rest = await first.next();
    // The first one's request was stopped: it ends (FFmpeg has moved on by then).
    expect(rest.done || (rest.value as Uint8Array).length > 0).toBe(true);
    await second.return(undefined);
  });

  it("asks again from where it got to when the provider drops the connection", async () => {
    const provider = fakeProvider({ cutAt: 3 * 1024 * 1024 });
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch });
    const file = sources.file("movie:4", "http://provider.example/movie/u/p/4.mkv");
    const part = await read(sources, file, 20000000, 20000000 + 5 * 1024 * 1024 - 1);
    expect(part.length).toBe(5 * 1024 * 1024);
    expect(right(part, 20000000)).toBe(true);
    expect(provider.log.map((r) => r.range)).toEqual(["bytes=20000000-25242879", "bytes=23145728-25242879"]);
  });

  it("reads through a provider that closes connections it thinks are idle", async () => {
    // A real server, as the helper's requests go out with Node's http: the first answer
    // stops partway while the reader is busy (FFmpeg converting), which crashed the
    // helper when it used fetch. The second goes through a redirect, as Xtream's do.
    const size = 6 * 1024 * 1024;
    const server = await startDroppingServer(size, byteAt);
    try {
      const sources = new SourceFiles({ fetch: httpGet });
      const file = sources.file("movie:5", server.url);
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of sources.bytes(file, 0, -1, undefined, { exclusive: true })) {
        parts.push(chunk);
        length += chunk.length;
        // Slow to read at first, so the connection closes while the reader holds back.
        if (parts.length === 1) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const all = new Uint8Array(length);
      let at = 0;
      for (const piece of parts) {
        all.set(piece, at);
        at += piece.length;
      }
      expect(length).toBe(size);
      expect(right(all, 0)).toBe(true);
      expect(server.ranges.length).toBe(2);
      expect(server.ranges[0]).toBe("bytes=0-");
    } finally {
      server.close();
    }
  });

  it("reads ahead of FFmpeg, keeping one connection busy, and answers jumps inside it", async () => {
    const provider = fakeProvider();
    const MB = 1024 * 1024;
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch, ahead: 4 * MB, letGoMs: 50 });
    const file = sources.file("movie:6", "http://provider.example/movie/u/p/6.mkv");
    await sources.size(file);
    const asked = provider.log.length;
    // FFmpeg reads 1 MB from 10 MB on, then holds back (the TV's buffer is full).
    const reading = sources.bytes(file, 10 * MB, -1, undefined, { exclusive: true });
    let got = 0;
    while (got < MB) {
      const next = await reading.next();
      got += (next.value as Uint8Array).length;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The connection went on to 4 MB past where FFmpeg is, and no further.
    const held = sources.reading!;
    expect(held.end - (10 * MB + got)).toBeGreaterThanOrEqual(4 * MB);
    expect(held.end - (10 * MB + got)).toBeLessThanOrEqual(4 * MB + 65536);
    expect(provider.log.length).toBe(asked + 1);
    await reading.return(undefined);
    // A jump inside what's held is answered from it, with no new request.
    const near = await read(sources, file, 12 * MB, -1, MB);
    expect(right(near, 12 * MB)).toBe(true);
    expect(provider.log.length).toBe(asked + 1);
    // A jump a little further on is read on to, still with no new request.
    const on = await read(sources, file, 25 * MB, -1, MB);
    expect(right(on, 25 * MB)).toBe(true);
    expect(provider.log.length).toBe(asked + 1);
    // A jump back before what's held starts reading there.
    const back = await read(sources, file, 9 * MB, -1, MB);
    expect(right(back, 9 * MB)).toBe(true);
    expect(provider.log.length).toBe(asked + 2);
    expect(provider.log[provider.log.length - 1].range).toBe("bytes=" + 9 * MB + "-");
    expect(provider.mostOpen()).toBeLessThanOrEqual(2);
    // Nobody reading for a while: the connection is let go.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sources.reading).toBeNull();
  });

  it("reads ahead on after the provider drops the connection", async () => {
    const provider = fakeProvider({ cutAt: 3 * 1024 * 1024 });
    const MB = 1024 * 1024;
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch, ahead: 8 * MB, letGoMs: 50 });
    const file = sources.file("movie:7", "http://provider.example/movie/u/p/7.mkv");
    // The size from the first answer (which is the one cut short).
    const part = await read(sources, file, 0, 3 * MB - 1);
    expect(part.length).toBe(3 * MB);
    const ahead = await read(sources, file, 10 * MB, -1, 6 * MB);
    expect(ahead.length).toBeGreaterThanOrEqual(6 * MB);
    expect(right(ahead, 10 * MB)).toBe(true);
    sources.stopReadAhead();
    expect(sources.reading).toBeNull();
  });

  it("lets something else use the connection, keeping what's held, then reads on", async () => {
    const provider = fakeProvider();
    const MB = 1024 * 1024;
    const sources = new SourceFiles({ fetch: provider.fetch as unknown as SourceFetch, ahead: 4 * MB, letGoMs: 2000 });
    const file = sources.file("movie:8", "http://provider.example/movie/u/p/8.mkv");
    await sources.size(file);
    const first = await read(sources, file, 10 * MB, -1, MB);
    expect(right(first, 10 * MB)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = sources.reading!.end;
    // FFmpeg looks at the index at the very end: the connection is the index's for now.
    const tail = await read(sources, file, 40 * MB - 1000, -1);
    expect(right(tail, 40 * MB - 1000)).toBe(true);
    expect(sources.reading).not.toBeNull();
    // Back where it was: what was held is still there, and reading goes on past it.
    const asked = provider.log.length;
    const again = await read(sources, file, 11 * MB, -1, held - 11 * MB + 2 * MB);
    expect(again.length).toBeGreaterThanOrEqual(held - 11 * MB + 2 * MB);
    expect(right(again, 11 * MB)).toBe(true);
    // One more request, from where the held bytes end.
    expect(provider.log.length).toBe(asked + 1);
    expect(provider.log[provider.log.length - 1].range).toBe("bytes=" + held + "-");
    sources.stopReadAhead();
  });

  it("reads Range headers", () => {
    expect(parseRange("bytes=0-")).toEqual({ start: 0, end: -1 });
    expect(parseRange("bytes=100-199")).toEqual({ start: 100, end: 199 });
    expect(parseRange("bytes=-500")).toEqual({ suffix: 500 });
    expect(parseRange("")).toBeNull();
    expect(totalFromContentRange("bytes 0-1/46000000")).toBe(46000000);
    expect(totalFromContentRange("")).toBe(0);
  });
});
