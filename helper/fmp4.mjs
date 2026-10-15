// Reading FFmpeg's fragmented MP4 as it comes, for the phone's films with the picture kept
// as it is (aranplus-helper.mjs, "Kept pieces"): FFmpeg writes the header (ftyp and
// moov, the playlist's init.mp4) and then one fragment (moof and mdat) for each
// keyframe, and the helper puts the fragments into the playlist's pieces by their time.
// Kept free of I/O so it is tested (tests/fmp4.test.ts). Bytes are Uint8Arrays (Node's
// Buffers are those too).
//
// An MP4 file is a row of boxes: a 32-bit size (1: a 64-bit size follows the type), a
// four-letter type, then the box's data, which for some boxes is more boxes.

const u24 = (b, at) => (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
const u32 = (b, at) => b[at] * 0x1000000 + u24(b, at + 1);
const i32 = (b, at) => (b[at] << 24) | u24(b, at + 1);
const fourcc = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Splits bytes arriving in chunks into the top-level boxes. push() returns what's
// complete: { type, bytes } for a whole box, except the mdat, which can be tens of
// megabytes and is passed on as it comes, in parts: { type: "mdat", bytes, last }, the
// first part starting with the box's header.
export class TopBoxes {
  constructor() {
    this.pending = new Uint8Array(0); // the start of a box not complete yet
    this.mdatLeft = 0; // bytes of an mdat still to come
  }

  push(chunk) {
    const out = [];
    let data = this.pending.length ? concat(this.pending, chunk) : chunk;
    this.pending = new Uint8Array(0);
    for (;;) {
      if (this.mdatLeft > 0) {
        if (data.length === 0) break;
        const part = data.subarray(0, Math.min(this.mdatLeft, data.length));
        this.mdatLeft -= part.length;
        out.push({ type: "mdat", bytes: part, last: this.mdatLeft === 0 });
        data = data.subarray(part.length);
        continue;
      }
      if (data.length < 8) break;
      let size = u32(data, 0);
      const type = fourcc(data, 4);
      if (size === 1) {
        if (data.length < 16) break;
        size = u32(data, 8) * 4294967296 + u32(data, 12);
      }
      // A size this small (or 0, "to the end of the file") isn't something FFmpeg writes here.
      if (size < 8) throw new Error("FFmpeg's MP4 has a box of size " + size + " (" + type + ").");
      if (type === "mdat") {
        // The header and whatever of the data has come, now; the rest as it arrives.
        const part = data.subarray(0, Math.min(size, data.length));
        this.mdatLeft = size - part.length;
        out.push({ type, bytes: part, last: this.mdatLeft === 0 });
        data = data.subarray(part.length);
        continue;
      }
      if (data.length < size) break;
      out.push({ type, bytes: data.subarray(0, size) });
      data = data.subarray(size);
    }
    if (data.length) this.pending = data.slice();
    return out;
  }
}

// The boxes inside [start, end) of `bytes`: their type, where their data starts, and end.
function* boxes(bytes, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(bytes, pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = u32(bytes, pos + 8) * 4294967296 + u32(bytes, pos + 12);
      header = 16;
    }
    if (size < header || pos + size > end) return;
    yield { type: fourcc(bytes, pos + 4), data: pos + header, end: pos + size };
    pos += size;
  }
}

function find(bytes, box, type) {
  for (const inner of boxes(bytes, box.data, box.end)) if (inner.type === type) return inner;
  return null;
}

// The tracks in the header's moov: { id, timescale, video }, in order.
export function moovTracks(moov) {
  const tracks = [];
  for (const trak of boxes(moov, 8, moov.length)) {
    if (trak.type !== "trak") continue;
    const tkhd = find(moov, trak, "tkhd");
    const mdia = find(moov, trak, "mdia");
    const mdhd = mdia && find(moov, mdia, "mdhd");
    const hdlr = mdia && find(moov, mdia, "hdlr");
    if (!tkhd || !mdhd || !hdlr) continue;
    // Version 1 holds 64-bit times before these.
    const id = u32(moov, tkhd.data + (moov[tkhd.data] === 1 ? 20 : 12));
    const timescale = u32(moov, mdhd.data + (moov[mdhd.data] === 1 ? 20 : 12));
    tracks.push({ id, timescale, video: fourcc(moov, hdlr.data + 8) === "vide" });
  }
  return tracks;
}

// When a fragment's picture starts: the first picture sample's presentation time in
// seconds (its decode time, tfdt, plus its composition offset), or null when the
// fragment has no picture (the sound after the film's last frame, say).
export function fragmentStart(moof, tracks) {
  for (const traf of boxes(moof, 8, moof.length)) {
    if (traf.type !== "traf") continue;
    const tfhd = find(moof, traf, "tfhd");
    const tfdt = find(moof, traf, "tfdt");
    const trun = find(moof, traf, "trun");
    if (!tfhd || !tfdt || !trun) continue;
    const track = tracks.find((t) => t.id === u32(moof, tfhd.data + 4));
    if (!track || !track.video || !track.timescale) continue;
    if (u32(moof, trun.data + 4) === 0) continue;
    const decode = moof[tfdt.data] === 1 ? u32(moof, tfdt.data + 4) * 4294967296 + u32(moof, tfdt.data + 8) : u32(moof, tfdt.data + 4);
    const flags = u24(moof, trun.data + 1);
    let at = trun.data + 8;
    if (flags & 0x1) at += 4; // data offset
    if (flags & 0x4) at += 4; // first sample's flags
    if (flags & 0x100) at += 4; // duration
    if (flags & 0x200) at += 4; // size
    if (flags & 0x400) at += 4; // flags
    // Version 1 offsets are signed (FFmpeg's negative_cts_offsets): a keyframe's is 0.
    const offset = flags & 0x800 ? (moof[trun.data] === 1 ? i32(moof, at) : u32(moof, at)) : 0;
    return (decode + offset) / track.timescale;
  }
  return null;
}

// Numbers a fragment (its mfhd), so numbers go up through the film whichever run made
// the fragment. Changes `moof` in place.
export function numberFragment(moof, n) {
  const mfhd = find(moof, { data: 8, end: moof.length }, "mfhd");
  if (!mfhd) return;
  const at = mfhd.data + 4;
  moof[at] = (n >>> 24) & 0xff;
  moof[at + 1] = (n >>> 16) & 0xff;
  moof[at + 2] = (n >>> 8) & 0xff;
  moof[at + 3] = n & 0xff;
}
