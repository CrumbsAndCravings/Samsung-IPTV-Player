// What the helper does to each file, kept free of I/O so it is tested
// (tests/helper.test.ts). FFmpeg reads the provider's file and writes an MPEG-TS
// stream the TV plays: H.264 or HEVC video, AAC or AC-3 sound. For the iPhone (and
// later the Roku) it writes HLS instead: numbered pieces and a playlist that grows as
// FFmpeg works, the only way Safari plays a stream like this.

import path from "node:path";

// Picture formats the TV plays inside MPEG-TS, so they are only repackaged.
const VIDEO_COPY = ["h264", "hevc", "mpeg2video"];
// Ones MPEG-TS can carry that the TV may or may not play (DivX and Xvid are MPEG-4).
const VIDEO_TRY = ["mpeg4", "mpeg1video", "vc1"];
// Sound formats the TV plays; the rest (DTS, TrueHD, MP3 in AVI, ...) is converted.
const AUDIO_COPY = ["aac", "ac3", "eac3"];
// Subtitle formats FFmpeg turns into WebVTT text; picture ones (PGS, DVD) can't be.
const TEXT_SUBTITLES = ["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"];
// At most this many of a file's own subtitle tracks are written out for the phone.
export const MAX_SUBTITLES = 6;

// Reads FFmpeg's own description of a file (the text `ffmpeg -i <file>` prints), which
// every FFmpeg build has, unlike ffprobe. Sound and subtitle tracks keep their order in
// the file, so track n of each is "0:a:n" or "0:s:n" to FFmpeg; a track's title (from
// the Metadata lines under it) is kept when it has one.
export function parseProbe(text) {
  const out = { duration: 0, video: null, audio: [], subtitles: [] };
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (duration) out.duration = Math.round(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]));
  const streamLine = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{2,3})\))?[^:]*:\s*(Video|Audio|Subtitle):\s*([a-z0-9_]+)(.*)/i;
  let last = null; // the track the next "title" line belongs to
  for (const line of text.split(/\r?\n/)) {
    const match = streamLine.exec(line);
    if (!match) {
      const title = /^\s+title\s*:\s*(.*\S)\s*$/.exec(line);
      if (title && last && !last.title) last.title = title[1];
      if (/^\s*(Input|Output) #/.test(line)) last = null;
      continue;
    }
    const kind = match[3].toLowerCase();
    const codec = match[4].toLowerCase();
    const rest = match[5];
    last = null;
    if (kind === "video") {
      // Cover pictures in MKV and MP4 files are "video" too; the first real one counts.
      if (out.video || /attached pic/.test(rest) || /^(mjpeg|png|bmp|gif|webp|tiff)$/.test(codec)) continue;
      const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(rest);
      out.video = { codec, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0 };
    } else if (kind === "audio") {
      last = { codec, channels: channelsOf(rest), language: match[2] || "" };
      out.audio.push(last);
    } else {
      last = { codec, language: match[2] || "", text: TEXT_SUBTITLES.indexOf(codec) >= 0, forced: /\(forced\)/.test(rest) };
      out.subtitles.push(last);
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
export function audioPlan(stream) {
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

// The FFmpeg arguments for one stream. `start` in seconds; `video` "copy" or "convert".
export function ffmpegArgs({ url, start, video, encoder, probe }) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // Picks up again if the provider's connection drops for a moment.
  args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  // AVI files often lack timestamps; make them up so the stream stays in step.
  args.push("-fflags", "+genpts");
  if (start > 0) args.push("-ss", String(start));
  // "V" leaves out cover pictures, which some files carry as a second video stream.
  args.push("-i", url, "-map", "0:V:0?", "-map", "0:a?", "-sn", "-dn");
  const codec = probe && probe.video ? probe.video.codec : "";
  if (video === "convert") {
    args.push(...(ENCODERS[encoder] || ENCODERS.libx264));
    // Even sizes (H.264 needs them) and a keyframe every two seconds or so.
    args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-g", "50");
  } else {
    args.push("-c:v", "copy");
    // DivX often packs frames together, which MPEG-TS can't carry as they are.
    if (codec === "mpeg4") args.push("-bsf:v", "mpeg4_unpack_bframes");
  }
  const audio = probe ? probe.audio : [];
  audio.forEach((stream, i) => {
    const plan = audioPlan(stream);
    if (plan === "copy") args.push("-c:a:" + i, "copy");
    else if (plan === "ac3") args.push("-c:a:" + i, "ac3", "-b:a:" + i, "448k");
    else args.push("-c:a:" + i, "aac", "-b:a:" + i, "192k");
  });
  if (audio.length === 0) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  return args;
}

// --- HLS, for the iPhone ---------------------------------------------------------------

// Safari only takes H.264 and HEVC pictures in HLS (HEVC inside fMP4 pieces); the rest
// is converted.
export function hlsVideoPlan(codec) {
  return codec === "h264" || codec === "hevc" ? "copy" : "convert";
}

export const HLS_SECONDS = 6;

// The FFmpeg arguments for an HLS run into `dir`, from `start` seconds:
//   video      "copy" or "convert" (to H.264, at most `height` lines high)
//   audioTrack which of the file's sound tracks (HLS here carries one; another is a
//              new run)
//   audio      "aac": AAC kept, anything else to AAC stereo (phones); "keep": as for the
//              TV (audioPlan)
//   format     "fmp4" (Safari; needed for HEVC) or "ts"
//   subtitles  also write each of the file's text subtitle tracks as WebVTT
//              (sub<n>.vtt, n counting subtitle tracks), growing as FFmpeg goes
//   userAgent  how FFmpeg introduces itself to the provider ("" for its own)
export function hlsArgs({ url, start, video, encoder, probe, dir, audioTrack = 0, audio = "aac", height = 0, format = "fmp4", subtitles = false, userAgent = "" }) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (userAgent) args.push("-user_agent", userAgent);
  args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  args.push("-fflags", "+genpts");
  if (start > 0) args.push("-ss", String(start));
  const tracks = probe ? probe.audio : [];
  const track = audioTrack >= 0 && audioTrack < tracks.length ? audioTrack : 0;
  args.push("-i", url, "-map", "0:V:0?", "-map", "0:a:" + track + "?");
  const codec = probe && probe.video ? probe.video.codec : "";
  const convert = video === "convert" || (format === "fmp4" && hlsVideoPlan(codec) === "convert");
  if (convert) {
    args.push(...(ENCODERS[encoder] || ENCODERS.libx264));
    const size = height > 0 ? "scale=-2:min(ih\\," + Math.floor(height) + ")" : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    // A keyframe at every piece's start, so the pieces are even.
    args.push("-vf", size, "-force_key_frames", "expr:gte(t,n_forced*" + HLS_SECONDS + ")");
  } else {
    args.push("-c:v", "copy");
    // Apple's players only take HEVC labelled "hvc1".
    if (codec === "hevc" && format === "fmp4") args.push("-tag:v", "hvc1");
    if (codec === "mpeg4") args.push("-bsf:v", "mpeg4_unpack_bframes");
  }
  const sound = tracks[track];
  if (!sound) args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  else if (audio === "aac") {
    if (sound.codec === "aac") args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  } else {
    const plan = audioPlan(sound);
    if (plan === "copy") args.push("-c:a", "copy");
    else if (plan === "ac3") args.push("-c:a", "ac3", "-b:a", "448k");
    else args.push("-c:a", "aac", "-b:a", "192k");
  }
  args.push("-sn", "-dn", "-f", "hls", "-hls_time", String(HLS_SECONDS), "-hls_list_size", "0", "-hls_playlist_type", "event");
  args.push("-hls_flags", "independent_segments+temp_file");
  if (format === "fmp4") {
    args.push("-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", path.join(dir, "seg%05d.m4s"));
  } else {
    args.push("-hls_segment_filename", path.join(dir, "seg%05d.ts"));
  }
  args.push(path.join(dir, "index.m3u8"));
  if (subtitles && probe) {
    probe.subtitles.slice(0, MAX_SUBTITLES).forEach((sub, n) => {
      // Written as each line arrives, so the phone can read it while FFmpeg works.
      if (sub.text) args.push("-map", "0:s:" + n, "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", path.join(dir, "sub" + n + ".vtt"));
    });
  }
  return args;
}

// The playlist as FFmpeg writes it, made ready for the player: start at the beginning
// (a growing playlist otherwise starts at its end, like live TV).
export function playlistForPlayer(text) {
  if (text.indexOf("#EXT-X-START:") >= 0) return text;
  return text.replace(/^#EXTM3U[^\n]*\n/, (first) => first + "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");
}

// How many pieces a playlist lists, and whether FFmpeg has finished it.
export function playlistState(text) {
  return { segments: (text.match(/^#EXTINF:/gm) || []).length, ended: /^#EXT-X-ENDLIST/m.test(text) };
}

// Files a session may serve: the playlist, its pieces, and the subtitle files.
export function sessionFile(name) {
  return /^(index\.m3u8|init\.mp4|seg\d{5}\.(?:m4s|ts)|sub\d\.vtt)$/.test(name);
}

const CONTENT_TYPES = { m3u8: "application/vnd.apple.mpegurl", mp4: "video/mp4", m4s: "video/iso.segment", ts: "video/mp2t", vtt: "text/vtt; charset=utf-8" };

export function sessionFileType(name) {
  return CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)] || "application/octet-stream";
}

// OpenSubtitles' moviehash: the file's size plus the 64-bit little-endian words of its
// first and last 64 KB, wrapping at 64 bits; 16 hex digits.
export function movieHash(head, tail, size) {
  let sum = BigInt(size);
  for (const bytes of [head, tail]) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 8 <= bytes.byteLength; i += 8) sum += view.getBigUint64(i, true);
  }
  return BigInt.asUintN(64, sum).toString(16).padStart(16, "0");
}

// The provider's address for a file, as the app builds it (src/core/utils.ts streamUrl).
export function providerUrl(login, kind, id, ext) {
  return login.server + "/" + (kind === "series" ? "series" : "movie") + "/" + encodeURIComponent(login.username) + "/" + encodeURIComponent(login.password) + "/" + id + "." + ext;
}

// The provider's API address for what the phone asked: an action the app uses and its
// ids, with the login added here. Anything else is left out; null for an odd request.
const XTREAM_ACTIONS = ["", "get_vod_categories", "get_series_categories", "get_vod_streams", "get_series", "get_vod_info", "get_series_info"];
const XTREAM_PARAMS = ["category_id", "vod_id", "series_id"];

export function xtreamQuery(login, params) {
  const action = params.get("action") || "";
  if (XTREAM_ACTIONS.indexOf(action) < 0) return null;
  let url = login.server + "/player_api.php?username=" + encodeURIComponent(login.username) + "&password=" + encodeURIComponent(login.password);
  if (action) url += "&action=" + action;
  for (const name of XTREAM_PARAMS) {
    const value = params.get(name);
    if (value === null) continue;
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(value)) return null;
    url += "&" + name + "=" + encodeURIComponent(value);
  }
  return url;
}

// Addresses /v1/fetch passes on: OpenSubtitles' API and its download servers only.
export function fetchAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return /(^|\.)opensubtitles\.(com|org)$/i.test(url.hostname);
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
