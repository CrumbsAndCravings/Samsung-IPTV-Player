// Where an MKV file's keyframes are, from the file's own index (its Cues), without
// reading the film: the phone's whole-film playlist cuts the picture as it is at those
// places, so nothing has to be converted (plan.mjs, "Whole films, the picture kept").
// Kept free of I/O so it is tested (tests/mkv.test.ts).
//
// An MKV file is EBML: each element is an ID, a size and its data, nested. The file
// starts with the EBML header, then one Segment holding the rest: the SeekHead (where
// the other parts are), Info (the length of a tick), Tracks (which track is the
// picture), the Clusters (the film itself) and the Cues (each keyframe's time and the
// Cluster it's in), which muxers put at the end, or at the start.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CLUSTER = 0x1f43b675;
export const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;

// The element starting at `pos` of `bytes`: its ID, where its data starts, and where it
// ends (-1 for an element of unknown size); null when its header runs past `bytes` or
// isn't one.
export function element(bytes, pos) {
  if (pos < 0 || pos >= bytes.length) return null;
  const first = bytes[pos];
  let idLength = 1;
  while (idLength <= 4 && !(first & (0x100 >> idLength))) idLength++;
  if (idLength > 4 || pos + idLength >= bytes.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[pos + i];
  const at = pos + idLength;
  const lead = bytes[at];
  let sizeLength = 1;
  while (sizeLength <= 8 && !(lead & (0x100 >> sizeLength))) sizeLength++;
  if (sizeLength > 8 || at + sizeLength > bytes.length) return null;
  const mask = 0xff >> sizeLength;
  let size = lead & mask;
  // All ones means "unknown" (a file written as it was recorded).
  let unknown = size === mask;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  const start = at + sizeLength;
  return { id, start, end: unknown ? -1 : start + size };
}

// The elements inside [start, end) of `bytes`, as far as they are whole.
function* children(bytes, start, end) {
  let pos = start;
  while (pos < end) {
    const el = element(bytes, pos);
    if (!el || el.end < 0 || el.end > end) return;
    yield el;
    pos = el.end;
  }
}

function uint(bytes, el) {
  let value = 0;
  for (let i = el.start; i < el.end; i++) value = value * 256 + bytes[i];
  return value;
}

function child(bytes, parent, id) {
  for (const el of children(bytes, parent.start, parent.end)) if (el.id === id) return el;
  return null;
}

// What the file's first bytes say: where the Segment's data starts (the SeekHead counts
// from there), how long a tick is (nanoseconds), the picture's track number (0 when the
// start doesn't say), and where the Cues are and any further SeekHead (in the file;
// -1 and none when the start doesn't say). Null for a file that isn't MKV.
export function mkvStart(head) {
  const header = element(head, 0);
  if (!header || header.id !== EBML || header.end < 0) return null;
  const segment = element(head, header.end);
  if (!segment || segment.id !== SEGMENT) return null;
  const out = { segment: segment.start, scale: 1000000, video: 0, cues: -1, seekHeads: [] };
  let pos = segment.start;
  for (;;) {
    const el = element(head, pos);
    // The film itself, or past what's here: the parts before it are what's needed.
    if (!el || el.id === CLUSTER || el.end < 0) break;
    if (el.end <= head.length) {
      if (el.id === SEEK_HEAD) readSeekHead(head, el, out);
      else if (el.id === INFO) {
        const scale = child(head, el, TIMESTAMP_SCALE);
        if (scale) out.scale = uint(head, scale) || 1000000;
      } else if (el.id === TRACKS && !out.video) out.video = videoTrack(head, el);
    }
    pos = el.end;
  }
  return out;
}

// A SeekHead's entries for the Cues (and other SeekHeads), as places in the file.
// `bytes` holds the SeekHead from `seekHead.start`; `out.segment` is where the
// Segment's data starts.
function readSeekHead(bytes, seekHead, out) {
  for (const seek of children(bytes, seekHead.start, seekHead.end)) {
    if (seek.id !== SEEK) continue;
    const idEl = child(bytes, seek, SEEK_ID);
    const posEl = child(bytes, seek, SEEK_POSITION);
    if (!idEl || !posEl) continue;
    const id = uint(bytes, idEl);
    const at = out.segment + uint(bytes, posEl);
    if (id === CUES && out.cues < 0) out.cues = at;
    else if (id === SEEK_HEAD && out.seekHeads.indexOf(at) < 0) out.seekHeads.push(at);
  }
}

// Where a further SeekHead (one the first points to, usually at the end) says the Cues
// are: `bytes` holds it from its start, `segment` is where the Segment's data starts.
// -1 when it doesn't say.
export function mkvSeekHeadCues(bytes, segment) {
  const el = element(bytes, 0);
  if (!el || el.id !== SEEK_HEAD || el.end < 0 || el.end > bytes.length) return -1;
  const out = { segment, cues: -1, seekHeads: [] };
  readSeekHead(bytes, el, out);
  return out.cues;
}

// The first picture track's number in Tracks (TrackType 1 is video).
function videoTrack(bytes, tracks) {
  for (const entry of children(bytes, tracks.start, tracks.end)) {
    if (entry.id !== TRACK_ENTRY) continue;
    const type = child(bytes, entry, TRACK_TYPE);
    const number = child(bytes, entry, TRACK_NUMBER);
    if (type && number && uint(bytes, type) === 1) return uint(bytes, number);
  }
  return 0;
}

// How many bytes the Cues element at the start of `bytes` takes, header and all; 0 when
// that isn't a Cues element, or its size is unknown.
export function mkvCuesLength(bytes) {
  const el = element(bytes, 0);
  return el && el.id === CUES && el.end > 0 ? el.end : 0;
}

// The picture's keyframes from the Cues element at the start of `bytes`: their times in
// seconds on the file's own clock, in order, each once. Null when `bytes` doesn't hold
// a whole Cues element.
export function mkvCueTimes(bytes, video, scale) {
  const cues = element(bytes, 0);
  if (!cues || cues.id !== CUES || cues.end < 0 || cues.end > bytes.length) return null;
  const times = [];
  for (const point of children(bytes, cues.start, cues.end)) {
    if (point.id !== CUE_POINT) continue;
    let time = -1;
    let picture = false;
    for (const part of children(bytes, point.start, point.end)) {
      if (part.id === CUE_TIME) time = uint(bytes, part);
      else if (part.id === CUE_TRACK_POSITIONS) {
        const track = child(bytes, part, CUE_TRACK);
        if (track && uint(bytes, track) === video) picture = true;
      }
    }
    // To the microsecond, so 29613 ticks of a millisecond are 29.613 exactly.
    if (time >= 0 && picture) times.push(Math.round((time * scale) / 1000) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times.filter((t, i) => i === 0 || t !== times[i - 1]);
}
