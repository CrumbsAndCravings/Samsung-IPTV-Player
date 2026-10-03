// What the helper does to each file, kept free of I/O so it is tested
// (tests/helper.test.ts). FFmpeg reads the provider's file and writes an MPEG-TS
// stream the TV plays: H.264 or HEVC video, AAC or AC-3 sound.

// Picture formats the TV plays inside MPEG-TS, so they are only repackaged.
const VIDEO_COPY = ["h264", "hevc", "mpeg2video"];
// Ones MPEG-TS can carry that the TV may or may not play (DivX and Xvid are MPEG-4).
const VIDEO_TRY = ["mpeg4", "mpeg1video", "vc1"];
// Sound formats the TV plays; the rest (DTS, TrueHD, MP3 in AVI, ...) is converted.
const AUDIO_COPY = ["aac", "ac3", "eac3"];

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

// The provider's address for a file, as the app builds it (src/core/utils.ts streamUrl).
export function providerUrl(login, kind, id, ext) {
  return login.server + "/" + (kind === "series" ? "series" : "movie") + "/" + encodeURIComponent(login.username) + "/" + encodeURIComponent(login.password) + "/" + id + "." + ext;
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
