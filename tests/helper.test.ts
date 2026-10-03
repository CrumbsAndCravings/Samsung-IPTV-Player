// The helper's conversion plan (helper/plan.mjs): what FFmpeg is told for each kind of
// file. The text below is what `ffmpeg -i` prints for real files.
import { describe, expect, it } from "vitest";
import {
  BROWSER_USER_AGENT,
  audioPlan,
  ffmpegArgs,
  masterPlaylist,
  outputSize,
  parseProbe,
  playlistState,
  providerUrl,
  readQuery,
  redactor,
  rewritePlaylist,
  scaleFilter,
  sessionFile,
  videoPlan,
} from "../helper/plan.mjs";

const AVI = `Input #0, avi, from 'http://host.example/movie/u/p/1.avi':
  Duration: 01:42:13.04, start: 0.000000, bitrate: 1191 kb/s
  Stream #0:0: Video: mpeg4 (Advanced Simple Profile) (XVID / 0x44495658), yuv420p, 640x272 [SAR 1:1 DAR 40:17], 1051 kb/s, 23.98 fps, 23.98 tbr, 23.98 tbn
  Stream #0:1: Audio: mp3 (mp3float) (U[0][0][0] / 0x0055), 48000 Hz, stereo, fltp, 128 kb/s`;

const MKV = `Input #0, matroska,webm, from 'x.mkv':
  Duration: 00:58:01.50, start: 0.000000, bitrate: 6013 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 1920x1080, SAR 1:1 DAR 16:9, 23.98 fps (default)
  Stream #0:1(eng): Audio: dts (dca) (DTS-HD MA), 48000 Hz, 5.1(side), s32p (24 bit) (default)
  Stream #0:2(hin): Audio: ac3, 48000 Hz, stereo, fltp, 192 kb/s
  Stream #0:3(eng): Subtitle: subrip
  Stream #0:4: Video: mjpeg (Baseline), yuvj420p(pc), 600x900, 90k tbr, 90k tbn (attached pic)`;

describe("the helper", () => {
  it("reads what a file holds", () => {
    expect(parseProbe(AVI)).toEqual({ duration: 6133, video: { codec: "mpeg4", width: 640, height: 272 }, audio: [{ codec: "mp3", channels: 2, language: "" }] });
    const mkv = parseProbe(MKV);
    expect(mkv.video).toEqual({ codec: "hevc", width: 1920, height: 1080 });
    expect(mkv.audio).toEqual([
      { codec: "dts", channels: 6, language: "eng" },
      { codec: "ac3", channels: 2, language: "hin" },
    ]);
    expect(parseProbe("Server returned 403 Forbidden").video).toBeNull();
    // Newer FFmpeg prints stream ids too.
    expect(parseProbe("  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720").video!.codec).toBe("h264");
  });

  it("keeps what the TV plays and converts the rest", () => {
    expect(videoPlan("h264")).toBe("copy");
    expect(videoPlan("hevc")).toBe("copy");
    expect(videoPlan("mpeg4")).toBe("try");
    expect(videoPlan("wmv3")).toBe("convert");
    expect(audioPlan({ codec: "eac3", channels: 6 })).toBe("copy");
    expect(audioPlan({ codec: "dts", channels: 6 })).toBe("ac3");
    expect(audioPlan({ codec: "mp3", channels: 2 })).toBe("aac");
  });

  it("tells FFmpeg where to start and what to do with each track", () => {
    const mkv = parseProbe(MKV);
    const copy = ffmpegArgs({ url: "http://p/1.mkv", start: 754, video: "copy", encoder: "libx264", probe: mkv });
    const text = copy.join(" ");
    expect(text).toContain("-ss 754 -i http://p/1.mkv -map 0:V:0? -map 0:a?");
    expect(text).toContain("-c:v copy");
    expect(text).toContain("-c:a:0 ac3 -b:a:0 448k -c:a:1 copy");
    expect(text).toContain("-f mpegts");
    expect(copy[copy.length - 1]).toBe("pipe:1");
    const avi = ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "copy", encoder: "libx264", probe: parseProbe(AVI) }).join(" ");
    expect(avi).not.toContain("-ss");
    expect(avi).toContain("-bsf:v mpeg4_unpack_bframes");
    const converted = ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "convert", encoder: "h264_qsv", probe: parseProbe(AVI) }).join(" ");
    expect(converted).toContain("-c:v h264_qsv");
    expect(converted).toContain("-c:a:0 aac");
  });

  it("converts for the Roku: smaller pictures, stereo AAC, the viewer's track first", () => {
    const mkv = parseProbe(MKV);
    const args = ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "convert", encoder: "libx264", probe: mkv, height: 720, audio: "aac", track: 1 });
    const text = args.join(" ");
    // Scaled to at most 720 lines, keeping the shape, sizes even.
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:trunc(min(ih\\,720)/2)*2");
    expect(scaleFilter(0)).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    // The Hindi AC-3 track (the second) goes first; every track becomes stereo AAC.
    expect(text).toContain("-map 0:V:0? -map 0:a:1? -map 0:a:0? -sn");
    expect(text).toContain("-c:a:0 aac -b:a:0 192k -ac:a:0 2 -c:a:1 aac -b:a:1 192k -ac:a:1 2");
    expect(audioPlan({ codec: "aac", channels: 2 }, "aac")).toBe("copy");
    expect(audioPlan({ codec: "aac", channels: 6 }, "aac")).toBe("aac");
    expect(audioPlan({ codec: "ac3", channels: 2 }, "aac")).toBe("aac");
    // Without the options, nothing changes for the Samsung TV.
    const plain = ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "convert", encoder: "libx264", probe: mkv }).join(" ");
    expect(plain).toContain("-map 0:a? -sn");
    expect(plain).toContain("-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -g 50");
    expect(plain).not.toContain("-hwaccel");
    expect(plain).not.toContain("-user_agent");
    // A track number the file doesn't have is ignored.
    expect(ffmpegArgs({ url: "u", start: 0, video: "copy", encoder: "libx264", probe: mkv, track: 7 }).join(" ")).toContain("-map 0:a? -sn");
  });

  it("decodes on the graphics card only when converting, and introduces itself as a browser", () => {
    const avi = parseProbe(AVI);
    const converted = ffmpegArgs({ url: "http://p/1.avi", start: 30, video: "convert", encoder: "h264_nvenc", probe: avi, hwaccel: true, userAgent: BROWSER_USER_AGENT });
    // Both are input options, so they come before -i.
    expect(converted.indexOf("-hwaccel")).toBeGreaterThan(-1);
    expect(converted.indexOf("-hwaccel")).toBeLessThan(converted.indexOf("-i"));
    expect(converted[converted.indexOf("-user_agent") + 1]).toBe(BROWSER_USER_AGENT);
    expect(converted.indexOf("-user_agent")).toBeLessThan(converted.indexOf("-i"));
    const copied = ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "h264_nvenc", probe: parseProbe(MKV), hwaccel: true });
    expect(copied).not.toContain("-hwaccel");
  });

  it("writes HLS for the Roku: 6-second segments, a keyframe at each boundary", () => {
    const avi = parseProbe(AVI);
    const args = ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "convert", encoder: "libx264", probe: avi, hls: { dir: "/tmp/aranplus-helper/abc/" } });
    const text = args.join(" ");
    expect(text).toContain("-force_key_frames expr:gte(t,n_forced*6) -forced-idr 1");
    expect(text).not.toContain("-g 50");
    expect(text).toContain("-f hls -hls_time 6 -hls_list_size 0 -hls_playlist_type event");
    expect(text).toContain("-hls_flags independent_segments+temp_file -hls_segment_filename /tmp/aranplus-helper/abc/seg%05d.ts");
    expect(args[args.length - 1]).toBe("/tmp/aranplus-helper/abc/index.m3u8");
    expect(text).not.toContain("pipe:1");
    // Quick Sync spells the switch differently; copied pictures need none.
    expect(ffmpegArgs({ url: "u", start: 0, video: "convert", encoder: "h264_qsv", probe: avi, hls: { dir: "d" } }).join(" ")).toContain("-forced_idr 1");
    expect(ffmpegArgs({ url: "u", start: 0, video: "copy", encoder: "libx264", probe: parseProbe(MKV), hls: { dir: "d" } }).join(" ")).not.toContain("force_key_frames");
  });

  it("reads what the TV asked for", () => {
    const q = readQuery(new URLSearchParams("kind=series&id=77&ext=MKV&start=754.6&video=convert&height=720&audio=aac&track=1"));
    expect(q).toEqual({ kind: "series", id: "77", ext: "mkv", start: 754, video: "convert", height: 720, audio: "aac", track: 1 });
    const plain = readQuery(new URLSearchParams("id=5&ext=avi"));
    expect(plain).toEqual({ kind: "movie", id: "5", ext: "avi", start: 0, video: "copy", height: 0, audio: "", track: -1 });
    expect(readQuery(new URLSearchParams("id=5&ext=avi&height=99999&audio=dts&track=x"))).toMatchObject({ height: 0, audio: "", track: -1 });
    expect(readQuery(new URLSearchParams("id=../x&ext=avi"))).toBeNull();
    expect(readQuery(new URLSearchParams("id=5&ext=a/b"))).toBeNull();
  });

  it("names segments by file only, under the session", () => {
    const ffmpegPlaylist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:6.000000,\nC:\\Users\\me\\AppData\\Local\\Temp\\aranplus-helper\\abc\\seg00000.ts\n#EXTINF:6.000000,\n/tmp/aranplus-helper/abc/seg00001.ts\n#EXTINF:4.200000,\nseg00002.ts\n";
    const rewritten = rewritePlaylist(ffmpegPlaylist, "s/abc/");
    expect(rewritten).toContain("#EXTINF:6.000000,\ns/abc/seg00000.ts\n#EXTINF:6.000000,\ns/abc/seg00001.ts\n#EXTINF:4.200000,\ns/abc/seg00002.ts");
    expect(rewritten.split("\n").slice(0, 6).join("\n")).toBe("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS");
    expect(rewritePlaylist(ffmpegPlaylist, "")).toContain("\nseg00001.ts\n");
    expect(playlistState(ffmpegPlaylist)).toEqual({ segments: 3, ended: false });
    expect(playlistState(ffmpegPlaylist + "#EXT-X-ENDLIST\n")).toEqual({ segments: 3, ended: true });
    expect(playlistState("")).toEqual({ segments: 0, ended: false });
  });

  it("serves only a session's own files", () => {
    const session = "0123456789abcdef0123456789abcdef";
    expect(sessionFile(session, "index.m3u8")).toBe(true);
    expect(sessionFile(session, "seg00042.ts")).toBe(true);
    expect(sessionFile(session, "../personal.json")).toBe(false);
    expect(sessionFile(session, "seg00042.ts.tmp")).toBe(false);
    expect(sessionFile("..", "index.m3u8")).toBe(false);
    expect(sessionFile(session.toUpperCase(), "index.m3u8")).toBe(false);
  });

  it("points Roku at the session's playlist", () => {
    const master = masterPlaylist("abc", outputSize({ width: 1920, height: 1080 }, "convert", 720));
    expect(master).toBe("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\ns/abc/index.m3u8\n");
    expect(outputSize({ width: 640, height: 272 }, "convert", 720)).toEqual({ width: 640, height: 272 });
    expect(outputSize({ width: 3840, height: 1600 }, "convert", 720)).toEqual({ width: 1728, height: 720 });
    expect(outputSize({ width: 1920, height: 1080 }, "copy", 720)).toEqual({ width: 1920, height: 1080 });
    expect(masterPlaylist("abc", outputSize(null, "copy", 0))).toContain("BANDWIDTH=4000000\ns/abc/index.m3u8");
  });

  it("builds the provider's address and hides the login", () => {
    const login = { server: "http://host.example:8080", username: "jane doe", password: "pw/1" };
    const url = providerUrl(login, "series", "77", "mkv");
    expect(url).toBe("http://host.example:8080/series/jane%20doe/pw%2F1/77.mkv");
    expect(redactor(login, "k3y123")(url + "?key=k3y123")).toBe("<server>/series/<user>/<password>/77.mkv?key=<key>");
  });
});
