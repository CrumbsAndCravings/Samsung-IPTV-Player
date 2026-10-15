// Reading FFmpeg's fragmented MP4 as it comes (helper/fmp4.mjs), for the phone's films
// with the picture kept: the boxes here are built the way FFmpeg writes them with
// negative_cts_offsets (version 1 tfdt and trun, a keyframe's offset 0).
import { describe, expect, it } from "vitest";
import { fragmentStart, moovTracks, numberFragment, TopBoxes } from "../helper/fmp4.mjs";

function join(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of arrays) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(Math.floor(n / 4294967296)), ...u32(n >>> 0)];
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const data = join(parts);
  return join([u32(data.length + 8), text(type), data]);
}

// A box with a version and flags.
const full = (type: string, version: number, flags: number, ...parts: (Uint8Array | number[])[]) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

// A track: version 0 or 1 tkhd and mdhd, and its handler ("vide" or "soun").
function trak(id: number, timescale: number, handler: string, version = 0) {
  const times = version === 1 ? [...u64(0), ...u64(0)] : [...u32(0), ...u32(0)];
  return box(
    "trak",
    full("tkhd", version, 3, times, u32(id), u32(0), new Array(60).fill(0)),
    box("mdia", full("mdhd", version, 0, times, u32(timescale), u32(0), [0x55, 0xc4, 0, 0]), full("hdlr", 0, 0, u32(0), text(handler), new Array(13).fill(0))),
  );
}

const MOOV = box("moov", full("mvhd", 0, 0, new Array(96).fill(0)), trak(1, 16000, "vide", 1), trak(2, 48000, "soun"));

// A track's run in a fragment: `decode` (tfdt), and samples with their composition offsets
// (version 1: signed), as FFmpeg writes them (data offset, then duration, size, flags and
// offset for each sample).
function traf(id: number, decode: number, offsets: number[], trunVersion = 1) {
  const samples = offsets.map((offset) => [...u32(667), ...u32(100), ...u32(0), ...u32(offset)]);
  return box("traf", full("tfhd", 0, 0x020000, u32(id)), full("tfdt", 1, 0, u64(decode)), full("trun", trunVersion, 0xf01, u32(offsets.length), u32(0), ...samples));
}

const moof = (...trafs: Uint8Array[]) => box("moof", full("mfhd", 0, 0, u32(1)), ...trafs);

describe("FFmpeg's fragmented MP4", () => {
  it("knows the tracks from the header", () => {
    expect(moovTracks(MOOV)).toEqual([
      { id: 1, timescale: 16000, video: true },
      { id: 2, timescale: 48000, video: false },
    ]);
  });

  it("says when a fragment's picture starts, from its decode time and first offset", () => {
    const tracks = moovTracks(MOOV);
    // 61 s plus the one-second offset every kept piece has; a keyframe's offset is 0, the
    // B-frames after it negative.
    const keyframe = moof(traf(2, 48000 * 62, [0, 0, 0]), traf(1, 16000 * 62, [0, -1334, -667]));
    expect(fragmentStart(keyframe, tracks)).toBe(62);
    expect(fragmentStart(moof(traf(1, 16000 * 62 - 1334, [1334, 0])), tracks)).toBe(62);
    // Version 0 offsets aren't signed.
    expect(fragmentStart(moof(traf(1, 16000, [1334], 0)), tracks)).toBeCloseTo(1.0834, 4);
    // Sound alone: no picture to say.
    expect(fragmentStart(moof(traf(2, 48000, [0])), tracks)).toBeNull();
  });

  it("numbers fragments through the film", () => {
    const fragment = moof(traf(1, 0, [0]));
    numberFragment(fragment, 4007);
    expect(Array.from(fragment.subarray(20, 24))).toEqual(u32(4007));
  });

  it("splits the stream into boxes however it arrives, passing the mdat on as it comes", () => {
    const ftyp = box("ftyp", text("isom"), u32(512), text("isomiso6"));
    const fragment = moof(traf(1, 16000, [0, -667]));
    const data = new Uint8Array(70000).map((_, i) => i % 251);
    const mdat = box("mdat", data);
    // An mdat with a 64-bit size, as FFmpeg may write a big one.
    const bigMdat = join([u32(1), text("mdat"), u64(16 + 300), new Array(300).fill(9)]);
    const stream = join([ftyp, MOOV, fragment, mdat, fragment, bigMdat]);
    for (const step of [1, 7, 4096, 65536, stream.length]) {
      const boxes = new TopBoxes();
      const seen: { type: string; bytes: Uint8Array; last?: boolean }[] = [];
      for (let at = 0; at < stream.length; at += step) seen.push(...boxes.push(stream.slice(at, at + step)));
      const whole = seen.filter((b) => b.type !== "mdat");
      expect(whole.map((b) => b.type)).toEqual(["ftyp", "moov", "moof", "moof"]);
      expect(Array.from(whole[1].bytes)).toEqual(Array.from(MOOV));
      const parts = seen.filter((b) => b.type === "mdat");
      const lasts = parts.filter((b) => b.last).length;
      expect(lasts).toBe(2);
      const first = join(parts.slice(0, parts.findIndex((b) => b.last) + 1).map((b) => b.bytes));
      expect(first.length).toBe(mdat.length);
      expect(first.every((b, i) => b === mdat[i])).toBe(true);
    }
  });

  it("stops at a box FFmpeg wouldn't write", () => {
    expect(() => new TopBoxes().push(join([u32(4), text("free")]))).toThrow(/size 4/);
  });
});
