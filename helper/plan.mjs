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

// Sound converted to AC-3 (Dolby Digital): at its highest rate, as on Blu-ray. AC-3
// carries at most 5.1, so 6.1 and 7.1 (TrueHD and DTS-HD on 4K films) are mixed down to
// 5.1 with the subwoofer kept and the back channels folded into the surrounds; left to
// itself, FFmpeg picked 5.0 and dropped the subwoofer. `n` is the output stream's index
// among the sound tracks, or -1 when there's one.
export function ac3Args(channels, n = -1) {
  const at = n >= 0 ? ":a:" + n : ":a";
  const args = ["-c" + at, "ac3", "-b" + at, "640k"];
  if (channels > 6) args.push("-ac" + at, "6");
  return args;
}

// H.264 encoders, best first: NVIDIA, Intel Quick Sync, AMD, then the processor.
// The processor's settings for `preset`: "veryfast" on a PC; "superfast" on a small
// computer such as a Raspberry Pi, about half as fast again for a little more data at
// the same look (so a notch less fine, crf 23).
export function x264Args(preset) {
  return ["-c:v", "libx264", "-preset", preset, "-crf", preset === "veryfast" ? "21" : "23", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1"];
}

export const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"];

export const ENCODERS = {
  h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"],
  h264_qsv: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-pix_fmt", "nv12"],
  h264_amf: ["-c:v", "h264_amf", "-quality", "speed", "-pix_fmt", "yuv420p"],
  // The helper swaps in other settings on a small computer (x264Args).
  libx264: x264Args("veryfast"),
};

// The FFmpeg arguments for one stream. `start` in seconds; `video` "copy" or "convert".
// With `previews` ({ dir, atomic }), FFmpeg also writes a small picture every six seconds
// of the film into `dir` (p<n>.jpg, n being the film's own time over six, as the whole
// film's playlists name theirs), for the TV to show while choosing a jump.
//
// A kept picture can only start on a keyframe, so a stream from `start` really begins
// at the keyframe before it, up to a few seconds earlier, and the TV counts from there.
// With `startFile`, FFmpeg writes the first frame's time into it (framemd5, read by
// firstFrameSecs), so the helper can tell the TV where its stream begins.
export function ffmpegArgs({ url, start, video, encoder, probe, previews = null, startFile = "" }) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // Picks up again if the provider's connection drops for a moment.
  args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  // AVI files often lack timestamps; make them up so the stream stays in step.
  args.push("-fflags", "+genpts");
  if (start > 0) args.push("-ss", String(start));
  // With the picture kept, the pictures for choosing a jump come from keyframes only
  // (one every few seconds), so FFmpeg doesn't decode the whole film just for them:
  // about a seventeenth of the work, which keeps a Raspberry Pi up with a 4K film. A
  // converted picture is decoded in full anyway.
  const keyframes = !!previews && video !== "convert" && !!probe && !!probe.video;
  if (keyframes) args.push("-skip_frame:v", "nokey");
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
    else if (plan === "ac3") args.push(...ac3Args(stream.channels, i));
    else args.push("-c:a:" + i, "aac", "-b:a:" + i, "192k");
  });
  if (audio.length === 0) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  if (startFile && video !== "convert" && start > 0 && probe && probe.video) {
    args.push("-map", "0:V:0", "-c:v", "copy", "-frames:v", "1", "-f", "framemd5", startFile);
  }
  if (previews && probe && probe.video) {
    // The stream starts at `start`, so its frames are moved on by that much first: the
    // pictures are named by the film's own time wherever the stream began.
    const shift = start > 0 ? "setpts=PTS+" + start + "/TB," : "";
    args.push("-map", "0:V:0", "-an", "-sn", "-dn", "-vf", shift + "fps=1/" + VOD_SECONDS + ",scale=-2:" + PREVIEW_HEIGHT, "-q:v", "5");
    args.push("-f", "image2", "-frame_pts", "1", ...(previews.atomic ? ["-atomic_writing", "1"] : []), path.join(previews.dir, "p%05d.jpg"));
  }
  return args;
}

// The first frame's time from FFmpeg's framemd5 lines, in seconds from where the stream
// was asked to start (0 or less: a kept picture starts on the keyframe before), or null
// before FFmpeg has written it.
export function firstFrameSecs(text) {
  const base = /^#tb 0: (\d+)\/(\d+)/m.exec(String(text || ""));
  if (!base) return null;
  for (const line of String(text).split("\n")) {
    if (line.charAt(0) === "#" || line.trim() === "") continue;
    const parts = line.split(",").map((part) => part.trim());
    const pts = Number(parts[2]);
    if (parts[0] !== "0" || !isFinite(pts)) return null;
    return (pts * Number(base[1])) / Number(base[2]);
  }
  return null;
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
    else if (plan === "ac3") args.push(...ac3Args(sound.channels));
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

// Pieces cut where the file's own keyframes fall (the picture kept as it is) can run
// past HLS_SECONDS; the playlist promises this much, so its promise needn't change.
export const TARGET_SECONDS = 12;

// The playlist as FFmpeg writes it, made ready for the player: start at the beginning (a
// growing playlist otherwise starts at its end, like live TV), and keep the longest-piece
// promise (EXT-X-TARGETDURATION) the same as the playlist grows, as Apple's players
// expect; FFmpeg raises it whenever a longer piece arrives.
export function playlistForPlayer(text) {
  let longest = 0;
  for (const match of text.matchAll(/^#EXTINF:([\d.]+)/gm)) longest = Math.max(longest, Math.ceil(Number(match[1])));
  const target = Math.max(TARGET_SECONDS, longest);
  let out = text.replace(/^#EXT-X-TARGETDURATION:\d+/m, "#EXT-X-TARGETDURATION:" + target);
  if (out.indexOf("#EXT-X-START:") < 0) out = out.replace(/^#EXTM3U[^\n]*\n/, (first) => first + "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");
  return out;
}

// How many pieces a playlist lists, and whether FFmpeg has finished it.
export function playlistState(text) {
  return { segments: (text.match(/^#EXTINF:/gm) || []).length, ended: /^#EXT-X-ENDLIST/m.test(text) };
}

// Files a session may serve: the playlist, its pieces, and the subtitle files.
export function sessionFile(name) {
  return /^(index\.m3u8|init\.mp4|seg\d{5}\.(?:m4s|ts)|sub\d\.vtt|p\d{5}\.jpg)$/.test(name);
}

// fMP4 pieces as plain MP4, the type Apple's own tools serve them with.
const CONTENT_TYPES = { m3u8: "application/vnd.apple.mpegurl", mp4: "video/mp4", m4s: "video/mp4", ts: "video/mp2t", vtt: "text/vtt; charset=utf-8", jpg: "image/jpeg" };

export function sessionFileType(name) {
  return CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)] || "application/octet-stream";
}

// --- Whole films, for the iPhone ----------------------------------------------------------
//
// Safari is at its best with a playlist for the whole film from the start, as for any
// film online: it knows the length, starts at once, and jumps by itself. Every piece is
// six seconds of the film at a fixed place (piece n starts at 6n s), whether or not
// FFmpeg has made it yet; the helper makes pieces as they're asked for, and a jump past
// where FFmpeg has got to starts FFmpeg again from there. That works because every run
// cuts at the same places and keeps the film's own timestamps, so pieces from different
// runs fit together. The picture is always converted to H.264 (only a picture made here
// has keyframes exactly every six seconds) and the sound to AAC, in MPEG-TS pieces, the
// HLS Apple's players have played longest.

export const VOD_SECONDS = 6;

// How many pieces a film of `duration` seconds has.
export function vodPieces(duration, seconds = VOD_SECONDS) {
  return Math.max(1, Math.ceil(duration / seconds));
}

export function pieceName(n) {
  return "seg" + String(n).padStart(5, "0") + ".ts";
}

// The whole film's playlist; with `start`, where the player begins (resuming).
export function vodPlaylist({ duration, start = 0, seconds = VOD_SECONDS }) {
  const count = vodPieces(duration, seconds);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:" + seconds, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS"];
  if (start > 0) lines.push("#EXT-X-START:TIME-OFFSET=" + start + ",PRECISE=YES");
  for (let n = 0; n < count; n++) {
    const length = n < count - 1 ? seconds : Math.max(0.1, duration - seconds * (count - 1));
    lines.push("#EXTINF:" + length.toFixed(3) + ",", pieceName(n));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// Keyframes asked for must start a piece cleanly (IDR), which graphics cards only do
// when told.
const IDR = { h264_nvenc: ["-forced-idr", "1"], h264_qsv: ["-forced_idr", "1"] };

// The preview pictures' height (the phone shows them about 160 points wide, 3 pixels a
// point would be sharper but three times the bytes over 5G).
export const PREVIEW_HEIGHT = 180;

// The FFmpeg arguments for a run from piece `piece` on, into `dir`: the pieces
// (seg<n>.ts, numbered as in the playlist); with `subtitles`, each text subtitle track
// as WebVTT (sub<n>.vtt, with the film's own times); with `previews`, a small picture of
// each piece (p<n>.jpg, numbered as the pieces), shown above the bar while dragging it.
// `atomic`: this FFmpeg writes pictures whole before they appear (image2's
// atomic_writing, FFmpeg 5.1 and newer).
export function vodArgs({ url, piece, encoder, probe, dir, audioTrack = 0, height = 0, subtitles = false, previews = false, atomic = false, userAgent = "", seconds = VOD_SECONDS }) {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // The film's own timestamps (from 0 at its start), so every run's pieces fit together.
  args.push("-copyts", "-start_at_zero");
  if (userAgent) args.push("-user_agent", userAgent);
  args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  args.push("-fflags", "+genpts");
  if (piece > 0) args.push("-ss", String(piece * seconds));
  const tracks = probe ? probe.audio : [];
  const track = audioTrack >= 0 && audioTrack < tracks.length ? audioTrack : 0;
  args.push("-i", url, "-map", "0:V:0", "-map", "0:a:" + track + "?");
  args.push(...(ENCODERS[encoder] || ENCODERS.libx264), ...(IDR[encoder] || []));
  const size = height > 0 ? "scale=-2:min(ih\\," + Math.floor(height) + ")" : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  // A keyframe every `seconds` from where this run starts, which is on a piece's start.
  args.push("-vf", size, "-force_key_frames", "expr:gte(t,n_forced*" + seconds + ")");
  args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2", "-sn", "-dn");
  args.push("-avoid_negative_ts", "disabled", "-max_muxing_queue_size", "2048");
  // Each piece is its own MPEG-TS file, left with the timestamps it has: by default the
  // first piece of a run from the start would be shifted a frame or two later.
  args.push("-f", "segment", "-segment_format", "mpegts", "-segment_format_options", "avoid_negative_ts=disabled");
  args.push("-segment_time", String(seconds), "-segment_time_delta", "0.05");
  args.push("-segment_start_number", String(piece), path.join(dir, "seg%05d.ts"));
  if (subtitles && probe) {
    probe.subtitles.slice(0, MAX_SUBTITLES).forEach((sub, n) => {
      if (sub.text) args.push("-map", "0:s:" + n, "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", path.join(dir, "sub" + n + ".vtt"));
    });
  }
  if (previews) {
    // One picture a piece: the run starts on a piece, so the pictures land on the same
    // places whichever run makes them, each named by its time over `seconds` (the
    // piece's number), from inside its piece.
    args.push("-map", "0:V:0", "-an", "-sn", "-dn", "-vf", "fps=1/" + seconds + ",scale=-2:" + PREVIEW_HEIGHT, "-q:v", "5");
    args.push("-f", "image2", "-frame_pts", "1", ...(atomic ? ["-atomic_writing", "1"] : []), path.join(dir, "p%05d.jpg"));
  }
  return args;
}

// WebVTT files from several runs as one: each line once, in order of time.
export function mergeVtt(texts) {
  const cues = new Map();
  for (const text of texts) {
    for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
      const lines = block.split("\n").filter((line) => line !== "");
      const at = lines.findIndex((line) => line.indexOf("-->") >= 0);
      if (at < 0) continue;
      const timing = lines[at].trim();
      const body = lines.slice(at + 1).join("\n");
      const key = timing + "\n" + body;
      if (!cues.has(key)) cues.set(key, { start: vttSeconds(timing.split("-->")[0]), text: key });
    }
  }
  const sorted = [...cues.values()].sort((a, b) => a.start - b.start);
  return "WEBVTT\n\n" + sorted.map((cue) => cue.text + "\n\n").join("");
}

// "01:02:03.500" or "02:03.500" in seconds.
function vttSeconds(text) {
  const parts = text.trim().split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0) || 0;
}

// --- Sending less ------------------------------------------------------------------------
//
// Over Tailscale on 5G every byte counts: text (the app, the provider's lists, which are
// JSON) is sent gzipped when the phone takes it, and the app's files are checked rather
// than sent again.

// Whether an Accept-Encoding header takes gzip.
export function wantsGzip(header) {
  return /(^|,)\s*gzip\s*(;\s*q\s*=\s*(0*\.?0*[1-9]|1)[\d.]*)?\s*(,|$)/i.test(String(header || ""));
}

// Whether a Content-Type is text worth compressing (pictures, fonts and video already are).
export function compressible(type) {
  return /^(text\/|application\/(json|javascript|manifest\+json|vnd\.apple\.mpegurl)|image\/svg)/i.test(String(type || ""));
}

// The build's files named with their content's hash ("Nunito-Bold-AB12CD34.ttf") never
// change, so the phone may keep them for good.
export function hashedAsset(name) {
  return /-[A-Z0-9]{8}\.[a-z0-9]+$/.test(name);
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
// What the speed test found (helper/speed.mjs): `samples` are the bytes received in
// each second, `needKbps` the film's average rate (0 when unknown). Megabits per second
// on average and at the slowest five seconds in a row (a dip the TV's buffer has to ride
// over), and the verdict: "fast" (never below the film's rate), "dips" (enough on
// average, not always), "slow" (less than the film needs) or "" (no rate to compare).
export function speedVerdict(needKbps, samples) {
  const per = samples.map((bytes) => (bytes * 8) / 1e6);
  const avg = per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
  let low = per.length >= 5 ? Infinity : avg;
  for (let i = 0; i + 5 <= per.length; i++) low = Math.min(low, per.slice(i, i + 5).reduce((a, b) => a + b, 0) / 5);
  const need = needKbps / 1000;
  const verdict = need <= 0 ? "" : avg < need ? "slow" : low < need ? "dips" : "fast";
  return { avg, low, need, verdict };
}

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
