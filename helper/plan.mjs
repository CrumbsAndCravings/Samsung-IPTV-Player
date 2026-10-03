// What the helper does to each file, kept free of I/O so it is tested
// (tests/helper.test.ts). FFmpeg reads the provider's file and writes an MPEG-TS
// stream the TV plays: H.264 or HEVC video, AAC or AC-3 sound. For the Roku the same
// stream is cut into HLS segments, since Roku doesn't play an endless MPEG-TS stream.

// Picture formats the TV plays inside MPEG-TS, so they are only repackaged.
const VIDEO_COPY = ["h264", "hevc", "mpeg2video"];
// Ones MPEG-TS can carry that the TV may or may not play (DivX and Xvid are MPEG-4).
const VIDEO_TRY = ["mpeg4", "mpeg1video", "vc1"];
// Sound formats the TV plays; the rest (DTS, TrueHD, MP3 in AVI, ...) is converted.
const AUDIO_COPY = ["aac", "ac3", "eac3"];

// Seconds of video in each HLS segment.
export const HLS_SEGMENT_SECS = 6;

// The Roku app's desktop-browser identity (BrowserUserAgent). The helper fetches
// subtitle files from OpenSubtitles with it; for the provider it is one choice of
// "userAgent" in "transcoder" (the helper introduces itself as FFmpeg otherwise).
export const BROWSER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Reads FFmpeg's own description of a file (the text `ffmpeg -i <file>` prints), which
// every FFmpeg build has, unlike ffprobe.
export function parseProbe(text) {
  const out = { duration: 0, video: null, audio: [] };
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (duration) out.duration = Math.round(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]));
  const streamLine = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{2,3})\))?[^:]*:\s*(Video|Audio):\s*([a-z0-9_]+)([^\n]*)/gi;
  let match;
  while ((match = streamLine.exec(text))) {
    const rest = match[5];
    if (match[3] === "Video") {
      // Cover pictures in MKV and MP4 files are "video" too; the first real one counts.
      if (out.video || /attached pic/.test(rest) || /^(mjpeg|png|bmp|gif|webp|tiff)$/.test(match[4])) continue;
      const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(rest);
      out.video = { codec: match[4].toLowerCase(), width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0 };
    } else {
      out.audio.push({ codec: match[4].toLowerCase(), channels: channelsOf(rest), language: match[2] || "" });
    }
  }
  return out;
}

function channelsOf(text) {
  if (/\bmono\b/.test(text)) return 1;
  if (/\bstereo\b/.test(text)) return 2;
  const layout = /\b(\d)\.(\d)(?:\([a-z]+\))?/.exec(text);
  if (layout) return Number(layout[1]) + Number(layout[2]);
  const count = /\b(\d+) channels\b/.exec(text);
  return count ? Number(count[1]) : 2;
}

// "copy" when the TV plays the picture as it is; "try" when it might once repackaged
// (DivX and Xvid in AVI), so the app asks for a copy first and a conversion if refused;
// "convert" for the rest (WMV, VP8, ...).
export function videoPlan(codec) {
  if (VIDEO_COPY.indexOf(codec) >= 0) return "copy";
  return VIDEO_TRY.indexOf(codec) >= 0 ? "try" : "convert";
}

// What happens to each sound track: kept, or converted to AC-3 (surround) or AAC.
// With `audio` "aac" (a Roku that can't decode AC-3), all but stereo AAC becomes
// stereo AAC.
export function audioPlan(stream, audio = "") {
  if (audio === "aac") return stream.codec === "aac" && stream.channels <= 2 ? "copy" : "aac";
  if (AUDIO_COPY.indexOf(stream.codec) >= 0) return "copy";
  return stream.channels > 2 ? "ac3" : "aac";
}

// H.264 encoders, best first: NVIDIA, Intel Quick Sync, AMD, then the processor.
export const ENCODERS = {
  h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"],
  h264_qsv: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-pix_fmt", "nv12"],
  h264_amf: ["-c:v", "h264_amf", "-quality", "speed", "-pix_fmt", "yuv420p"],
  libx264: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1"],
};

// Makes the keyframes forced at segment boundaries full restarts (IDR), so each HLS
// segment plays on its own. Not every AMF build has the switch, so AMF is left alone.
const FORCED_IDR = {
  h264_nvenc: ["-forced-idr", "1"],
  h264_qsv: ["-forced_idr", "1"],
  libx264: ["-forced-idr", "1"],
};

// The picture's filter: even sizes (H.264 needs them) and, with `height`, no taller than
// that, keeping the shape. Converting 1080p or 4K down to a 720p screen saves the
// computer most of the work.
export function scaleFilter(height) {
  if (height > 0) return "scale=-2:trunc(min(ih\\," + height + ")/2)*2";
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

// The FFmpeg arguments for one run.
//   input      what FFmpeg reads: "pipe:0" when the helper feeds it the file from the
//              start (on one provider connection), otherwise an address
//   start      seconds into the file (0 with "pipe:0")
//   video      "copy" or "convert"
//   encoder    a key of ENCODERS
//   probe      parseProbe's result, or null
//   height     when converting, the tallest picture wanted (0: as it is)
//   audio      "aac" for stereo AAC only (a Roku without AC-3), otherwise ""
//   track      the sound track to put first (the viewer's language), or -1
//   hwaccel    when converting, let a graphics card or Quick Sync decode too
//   userAgent  how FFmpeg introduces itself, when it reads the provider directly
//   hls        { dir } to write HLS segments and a playlist there instead of a stream
export function ffmpegArgs({ input, start, video, encoder, probe, height = 0, audio = "", track = -1, hwaccel = false, userAgent = "", hls = null }) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  const piped = input === "pipe:0";
  // Picks up again if a connection drops for a moment.
  if (!piped) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  if (userAgent && !piped) args.push("-user_agent", userAgent);
  // AVI files often lack timestamps; make them up so the stream stays in step.
  args.push("-fflags", "+genpts");
  if (video === "convert" && hwaccel) args.push("-hwaccel", "auto");
  if (start > 0 && !piped) args.push("-ss", String(start));
  // "V" leaves out cover pictures, which some files carry as a second video stream.
  args.push("-i", input, "-map", "0:V:0?");
  const tracks = probe ? probe.audio : [];
  // Every sound track, in the file's order unless one is asked for first.
  const order = [];
  if (track >= 0 && track < tracks.length) {
    order.push(track);
    tracks.forEach((_, i) => {
      if (i !== track) order.push(i);
    });
    order.forEach((i) => args.push("-map", "0:a:" + i + "?"));
  } else {
    tracks.forEach((_, i) => order.push(i));
    args.push("-map", "0:a?");
  }
  args.push("-sn", "-dn");
  const codec = probe && probe.video ? probe.video.codec : "";
  if (video === "convert") {
    args.push(...(ENCODERS[encoder] || ENCODERS.libx264));
    args.push("-vf", scaleFilter(height));
    if (hls) {
      // A keyframe at every segment boundary, so the segments come out even.
      args.push("-force_key_frames", "expr:gte(t,n_forced*" + HLS_SEGMENT_SECS + ")", ...(FORCED_IDR[encoder] || []));
    } else {
      // A keyframe every two seconds or so.
      args.push("-g", "50");
    }
  } else {
    args.push("-c:v", "copy");
    // DivX often packs frames together, which MPEG-TS can't carry as they are.
    if (codec === "mpeg4") args.push("-bsf:v", "mpeg4_unpack_bframes");
  }
  order.forEach((source, i) => {
    const plan = audioPlan(tracks[source], audio);
    if (plan === "copy") args.push("-c:a:" + i, "copy");
    else if (plan === "ac3") args.push("-c:a:" + i, "ac3", "-b:a:" + i, "448k");
    else {
      args.push("-c:a:" + i, "aac", "-b:a:" + i, "192k");
      if (audio === "aac") args.push("-ac:a:" + i, "2");
    }
  });
  if (order.length === 0) {
    args.push("-c:a", "aac", "-b:a", "192k");
    if (audio === "aac") args.push("-ac", "2");
  }
  if (hls) {
    const dir = hls.dir.replace(/[\\/]+$/, "");
    // Timestamps from 0, so Roku's clock and the subtitles line up with the file's.
    args.push("-muxdelay", "0", "-muxpreload", "0");
    args.push("-f", "hls", "-hls_time", String(HLS_SEGMENT_SECS), "-hls_list_size", "0", "-hls_playlist_type", "event");
    args.push("-hls_flags", "independent_segments+temp_file", "-hls_segment_filename", dir + "/seg%05d.ts", dir + "/index.m3u8");
  } else {
    args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  }
  return args;
}

// The provider's address for a file, as the app builds it (src/core/utils.ts streamUrl).
export function providerUrl(login, kind, id, ext) {
  return login.server + "/" + (kind === "series" ? "series" : "movie") + "/" + encodeURIComponent(login.username) + "/" + encodeURIComponent(login.password) + "/" + id + "." + ext;
}

// What the TV asked for, from a request's query string; null when it makes no sense.
export function readQuery(params) {
  const height = Math.floor(Number(params.get("height")) || 0);
  const track = params.get("track") || "";
  const q = {
    kind: params.get("kind") === "series" ? "series" : "movie",
    id: params.get("id") || "",
    ext: (params.get("ext") || "").toLowerCase(),
    start: Math.max(0, Math.floor(Number(params.get("start")) || 0)),
    video: params.get("video") === "convert" ? "convert" : "copy",
    height: height >= 144 && height <= 4320 ? height : 0,
    audio: params.get("audio") === "aac" ? "aac" : "",
    track: /^\d{1,2}$/.test(track) ? Number(track) : -1,
    hash: params.get("hash") === "1",
  };
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(q.id) || !/^[0-9a-z]{1,5}$/.test(q.ext) || q.start > 86400) return null;
  return q;
}

// --- HLS ------------------------------------------------------------------------------
//
// The Roku asks for /v1/hls/index.m3u8 and gets a small master playlist naming the
// session's own playlist (s/<session>/index.m3u8). Roku re-reads that one while it
// plays, and it grows as FFmpeg goes, so re-reading never starts FFmpeg again. The
// session name is 32 random hex digits, so it works as the key for its own files.

// The master playlist for a session. `size` is the picture's size once converted.
export function masterPlaylist(session, size) {
  const width = size && size.width > 0 ? size.width : 0;
  const height = size && size.height > 0 ? size.height : 0;
  let attributes = "BANDWIDTH=" + (height > 720 ? 8000000 : 4000000);
  if (width > 0 && height > 0) attributes += ",RESOLUTION=" + width + "x" + height;
  return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:" + attributes + "\ns/" + session + "/index.m3u8\n";
}

// FFmpeg's playlist with each segment named by its file name alone, after `prefix`,
// whatever folder FFmpeg wrote. Tags (#EXT...) stay as they are.
export function rewritePlaylist(text, prefix) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.charAt(0) === "#") return line;
      return prefix + trimmed.split(/[\\/]/).pop();
    })
    .join("\n");
}

// How many segments a playlist lists so far, and whether FFmpeg has finished it.
export function playlistState(text) {
  const segments = (String(text).match(/^#EXTINF:/gm) || []).length;
  return { segments, ended: /^#EXT-X-ENDLIST/m.test(String(text)) };
}

// A file a session may serve: its playlist or one of its segments, nothing else.
export function sessionFile(session, file) {
  return /^[0-9a-f]{32}$/.test(session) && /^(index\.m3u8|seg\d{5,6}\.ts)$/.test(file);
}

// The picture's size as it comes out, for the master playlist.
export function outputSize(source, video, height) {
  if (!source || !source.width || !source.height) return { width: 0, height: 0 };
  if (video !== "convert") return { width: source.width, height: source.height };
  let h = height > 0 && source.height > height ? height : source.height;
  h -= h % 2;
  let w = Math.round((source.width * h) / source.height);
  w -= w % 2;
  return { width: w, height: h };
}

// --- Subtitles ------------------------------------------------------------------------
//
// Roku times online subtitles against its own clock, which starts at 0 where the
// helper's stream starts. So for a stream from 40:00 the helper fetches the subtitle
// file and moves every line 40 minutes earlier.

// Only OpenSubtitles' files are fetched, so the helper can't be used to reach anything
// else.
export function subtitleSource(src) {
  let url;
  try {
    url = new URL(String(src));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return /(^|\.)opensubtitles\.(com|org)$/i.test(url.hostname);
}

function subtitleMs(text) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(text);
  if (!m) return -1;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));
}

function subtitleTime(ms, separator) {
  const two = (n) => String(n).padStart(2, "0");
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return two(h) + ":" + two(m) + ":" + two(s) + separator + String(ms % 1000).padStart(3, "0");
}

// An SRT or WebVTT file with every line `seconds` earlier. Lines that would end before
// 0 are dropped, and SRT's numbers start again at 1.
export function shiftSubtitles(text, seconds) {
  const shift = Math.round(Number(seconds) * 1000) || 0;
  const source = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (shift === 0) return source;
  const blocks = [];
  let number = 0;
  for (const raw of source.split(/\n{2,}/)) {
    const block = raw.replace(/\n+$/, "");
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.indexOf("-->") >= 0);
    const timing = at >= 0 ? /^\s*(\S+)\s*-->\s*(\S+)(.*)$/.exec(lines[at]) : null;
    const from = timing ? subtitleMs(timing[1]) : -1;
    const to = timing ? subtitleMs(timing[2]) : -1;
    if (!timing || from < 0 || to < 0) {
      if (block.trim() !== "") blocks.push(block);
      continue;
    }
    if (to - shift <= 0) continue;
    const separator = timing[1].indexOf(",") >= 0 ? "," : ".";
    lines[at] = subtitleTime(Math.max(0, from - shift), separator) + " --> " + subtitleTime(to - shift, separator) + timing[3];
    if (at === 1 && /^\d+$/.test(lines[0].trim())) lines[0] = String(++number);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

// Hides the login and the helper's key in anything printed or sent back.
export function redactor(login, key) {
  const secrets = [];
  const add = (value, label) => {
    if (value && String(value).length >= 3) secrets.push([String(value), label]);
  };
  add(login.server, "<server>");
  add(String(login.server || "").replace(/^https?:\/\//i, "").replace(/:\d+$/, ""), "<server>");
  add(login.username, "<user>");
  add(encodeURIComponent(login.username || ""), "<user>");
  add(login.password, "<password>");
  add(encodeURIComponent(login.password || ""), "<password>");
  add(key, "<key>");
  secrets.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = String(text);
    for (const [value, label] of secrets) out = out.split(value).join(label);
    return out;
  };
}

// The file's full size from a provider's answer: Content-Range "bytes 0-99/12345" for
// a range, Content-Length for the whole file; 0 when it doesn't say.
export function sizeFromAnswer(status, headers) {
  const range = /\/(\d+)\s*$/.exec(String(headers["content-range"] || ""));
  if (status === 206 && range) return Number(range[1]);
  if (status === 200 && headers["content-length"]) return Number(headers["content-length"]) || 0;
  return 0;
}

// The byte range a request asks for ("bytes=100-" or "bytes=100-199"), within `size`.
export function askedRange(header, size) {
  const match = /bytes=(\d*)-(\d*)/.exec(String(header || ""));
  if (!match || (match[1] === "" && match[2] === "")) return { start: 0, end: size - 1, partial: false };
  if (match[1] === "") return { start: Math.max(0, size - Number(match[2])), end: size - 1, partial: true };
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return { start, end, partial: true };
}

// OpenSubtitles' fingerprint of a file (the app's src/core/oshash.ts): its size plus
// the first and last 64 KB read as little-endian 64-bit words, summed modulo 2^64.
export function osHash(size, head, tail) {
  const mask = (1n << 64n) - 1n;
  let sum = BigInt(size);
  for (const part of [head, tail]) {
    const buf = Buffer.from(part);
    for (let i = 0; i + 8 <= buf.length; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & mask;
  }
  return sum.toString(16).padStart(16, "0");
}
