// Reading where an MKV file's keyframes are from its own index (helper/mkv.mjs), for the
// phone's films with the picture kept: the files here are built element by element, as
// MKVToolNix and FFmpeg lay them out (the Cues at the end, found through the SeekHead).
import { describe, expect, it } from "vitest";
import { CUES, element, mkvCuesLength, mkvCueTimes, mkvSeekHeadCues, mkvStart } from "../helper/mkv.mjs";

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// An ID's bytes as written (the length marker is part of the ID).
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

// A size in `length` bytes, the marker bit first; -1 is "unknown" (all ones).
function size(value: number, length = 4): number[] {
  const out: number[] = [];
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value < 0 ? 0xff : v % 256;
    v = Math.floor(v / 256);
  }
  if (value < 0) out[0] = 0xff >> (length - 1);
  else out[0] |= 0x80 >> (length - 1);
  return out;
}

function el(id: number, ...children: Uint8Array[]): Uint8Array {
  const data = join(children);
  return join([new Uint8Array([...idBytes(id), ...size(data.length)]), data]);
}

function uint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = value; v > 0 || bytes.length === 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return el(id, new Uint8Array(bytes));
}

const EBML_HEADER = el(0x1a45dfa3, el(0x4282, new Uint8Array([109, 97, 116, 114, 111, 115, 107, 97])));

const cuePoint = (time: number, ...tracks: number[]) => el(0xbb, uint(0xb3, time), ...tracks.map((t) => el(0xb7, uint(0xf7, t), uint(0xf1, 1234))));

// Track 1 sound, track 2 the picture; cues for the picture at 0, 4.004 and 8.008 s (the
// one at 5 s is the sound's), one listed twice, out of order.
const CUE_ELEMENT = el(CUES, cuePoint(0, 2), cuePoint(5000, 1), cuePoint(8008, 1, 2), cuePoint(4004, 2), cuePoint(4004, 2));

// A file: the SeekHead (pointing at the Cues, or at a second SeekHead at the end that
// does), Info with `scale`, Tracks, a Cluster, the Cues. `unknown`: the Segment's size
// unknown, as in a file written as it was recorded.
function mkvFile({ scale = 1000000, cues = CUE_ELEMENT, secondSeekHead = false, unknown = false } = {}) {
  const info = el(0x1549a966, uint(0x2ad7b1, scale));
  const tracks = el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x83, 2)), el(0xae, uint(0xd7, 2), uint(0x83, 1)));
  const cluster = el(0x1f43b675, uint(0xe7, 0), new Uint8Array(500).fill(7));
  const seek = (id: number, pos: number) => el(0x4dbb, el(0x53ab, new Uint8Array(idBytes(id))), uint(0x53ac, pos));
  // SeekPosition is written in 4 bytes here, so the SeekHead's length doesn't depend on it.
  const seekHeadFor = (id: number, pos: number) => el(0x114d9b74, el(0x4dbb, el(0x53ab, new Uint8Array(idBytes(id))), el(0x53ac, new Uint8Array([pos >>> 24, (pos >>> 16) & 255, (pos >>> 8) & 255, pos & 255]))));
  const first = seekHeadFor(CUES, 0); // its length, before the positions are known
  const body = (head: Uint8Array, tail: Uint8Array[]) => join([head, info, tracks, cluster, ...tail]);
  const cuesAt = first.length + info.length + tracks.length + cluster.length;
  let segmentData: Uint8Array;
  if (secondSeekHead) {
    const second = el(0x114d9b74, seek(CUES, cuesAt));
    segmentData = body(seekHeadFor(0x114d9b74, cuesAt + cues.length), [cues, second]);
  } else segmentData = body(seekHeadFor(CUES, cuesAt), [cues]);
  const segmentHeader = new Uint8Array([0x18, 0x53, 0x80, 0x67, ...size(unknown ? -1 : segmentData.length, 8)]);
  const file = join([EBML_HEADER, segmentHeader, segmentData]);
  const segment = EBML_HEADER.length + segmentHeader.length;
  return { file, segment, cuesAt: segment + cuesAt, secondAt: segment + cuesAt + cues.length };
}

describe("the MKV index", () => {
  it("finds the picture's track, the tick and the Cues from the start of the file", () => {
    const { file, segment, cuesAt } = mkvFile();
    expect(mkvStart(file.subarray(0, cuesAt))).toEqual({ segment, scale: 1000000, video: 2, cues: cuesAt, seekHeads: [] });
    // The start alone is enough, cut anywhere after Tracks.
    expect(mkvStart(file.subarray(0, cuesAt - 300))!.video).toBe(2);
  });

  it("lists the picture's keyframes from the Cues, once each, in order", () => {
    const { file, cuesAt } = mkvFile();
    const cues = file.subarray(cuesAt);
    expect(mkvCuesLength(cues)).toBe(CUE_ELEMENT.length);
    expect(mkvCueTimes(cues.subarray(0, mkvCuesLength(cues)), 2, 1000000)).toEqual([0, 4.004, 8.008]);
    // The sound's cues are left out.
    expect(mkvCueTimes(cues, 1, 1000000)).toEqual([5, 8.008]);
    // Ticks of a tenth of a millisecond.
    expect(mkvCueTimes(el(CUES, cuePoint(40040, 2)), 2, 100000)).toEqual([4.004]);
  });

  it("follows a SeekHead that points to another at the end", () => {
    const { file, segment, cuesAt, secondAt } = mkvFile({ secondSeekHead: true });
    const start = mkvStart(file.subarray(0, cuesAt))!;
    expect(start.cues).toBe(-1);
    expect(start.seekHeads).toEqual([secondAt]);
    expect(mkvSeekHeadCues(file.subarray(secondAt), segment)).toBe(cuesAt);
    expect(mkvSeekHeadCues(file.subarray(cuesAt), segment)).toBe(-1);
  });

  it("reads a Segment of unknown size", () => {
    const { file, cuesAt } = mkvFile({ unknown: true });
    expect(element(file, EBML_HEADER.length)!.end).toBe(-1);
    expect(mkvStart(file.subarray(0, cuesAt))!.cues).toBe(cuesAt);
  });

  it("says nothing for what isn't MKV, or a Cues element cut short", () => {
    expect(mkvStart(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0, 0, 0]))).toBeNull();
    expect(mkvStart(new Uint8Array(0))).toBeNull();
    expect(element(new Uint8Array([0, 0, 0]), 0)).toBeNull();
    expect(mkvCueTimes(CUE_ELEMENT.subarray(0, CUE_ELEMENT.length - 3), 2, 1000000)).toBeNull();
    expect(mkvCuesLength(EBML_HEADER)).toBe(0);
    expect(mkvCueTimes(EBML_HEADER, 2, 1000000)).toBeNull();
  });
});
