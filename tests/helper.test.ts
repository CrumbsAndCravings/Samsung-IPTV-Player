// The helper's conversion plan (helper/plan.mjs): what FFmpeg is told for each kind of
// file. The text below is what `ffmpeg -i` prints for real files.
import { describe, expect, it } from "vitest";
import {
  audioPlan,
  compressible,
  fetchAllowed,
  ffmpegArgs,
  hashedAsset,
  hlsArgs,
  hlsVideoPlan,
  mergeVtt,
  movieHash,
  parseProbe,
  pieceName,
  playlistForPlayer,
  playlistState,
  providerUrl,
  redactor,
  sessionFile,
  sessionFileType,
  videoPlan,
  vodArgs,
  vodPieces,
  vodPlaylist,
  wantsGzip,
  xtreamQuery,
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
    Metadata:
      title           : DTS-HD MA 5.1
  Stream #0:3(eng): Subtitle: subrip
  Stream #0:4: Video: mjpeg (Baseline), yuvj420p(pc), 600x900, 90k tbr, 90k tbn (attached pic)
  Stream #0:5(eng): Subtitle: hdmv_pgs_subtitle (pgssub), 1920x1080
  Stream #0:6(eng): Subtitle: ass (default) (forced)
    Metadata:
      title           : Signs`;

describe("the helper", () => {
  it("reads what a file holds", () => {
    expect(parseProbe(AVI)).toEqual({ duration: 6133, video: { codec: "mpeg4", width: 640, height: 272 }, audio: [{ codec: "mp3", channels: 2, language: "" }], subtitles: [] });
    const mkv = parseProbe(MKV);
    expect(mkv.video).toEqual({ codec: "hevc", width: 1920, height: 1080 });
    expect(mkv.audio).toEqual([
      { codec: "dts", channels: 6, language: "eng" },
      { codec: "ac3", channels: 2, language: "hin", title: "DTS-HD MA 5.1" },
    ]);
    // Text subtitles can be written out for the phone; pictures (PGS) can't.
    expect(mkv.subtitles).toEqual([
      { codec: "subrip", language: "eng", text: true, forced: false },
      { codec: "hdmv_pgs_subtitle", language: "eng", text: false, forced: false },
      { codec: "ass", language: "eng", text: true, forced: true, title: "Signs" },
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

  it("writes HLS the iPhone plays", () => {
    const mkv = parseProbe(MKV);
    const args = hlsArgs({ url: "http://p/1.mkv", start: 754, video: "copy", encoder: "libx264", probe: mkv, dir: "/tmp/s1", audioTrack: 1, subtitles: true, userAgent: "Browser/1" });
    const text = args.join(" ");
    expect(text).toContain("-user_agent Browser/1 -reconnect 1");
    expect(text).toContain("-ss 754 -i http://p/1.mkv -map 0:V:0? -map 0:a:1?");
    // HEVC is kept, labelled the way Apple's players want it; AC-3 becomes AAC stereo.
    expect(text).toContain("-c:v copy -tag:v hvc1");
    expect(text).toContain("-c:a aac -b:a 192k -ac 2");
    expect(text).toContain("-hls_playlist_type event");
    expect(text).toContain("-hls_segment_type fmp4");
    expect(text).toContain("/tmp/s1/seg%05d.m4s /tmp/s1/index.m3u8");
    // Each text subtitle track becomes its own growing WebVTT file; PGS is left out.
    expect(text).toContain("-map 0:s:0 -c:s webvtt -flush_packets 1 -f webvtt /tmp/s1/sub0.vtt");
    expect(text).not.toContain("sub1.vtt");
    expect(text).toContain("/tmp/s1/sub2.vtt");

    // DivX can't go into fMP4 for Safari, so it is converted, and kept short enough.
    const avi = hlsArgs({ url: "http://p/1.avi", start: 0, video: "copy", encoder: "libx264", probe: parseProbe(AVI), dir: "/tmp/s2", height: 720 }).join(" ");
    expect(hlsVideoPlan("mpeg4")).toBe("convert");
    expect(hlsVideoPlan("h264")).toBe("copy");
    expect(avi).not.toContain("-ss");
    expect(avi).not.toContain("-user_agent");
    expect(avi).toContain("-c:v libx264");
    expect(avi).toContain("-vf scale=-2:min(ih\\,720) -force_key_frames expr:gte(t,n_forced*6)");
    expect(avi).toContain("-c:a aac");

    // MPEG-TS pieces, sound as the TV would have it (for the Roku later).
    const ts = hlsArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "libx264", probe: mkv, dir: "/tmp/s3", audio: "keep", format: "ts" }).join(" ");
    expect(ts).not.toContain("hvc1");
    expect(ts).toContain("-c:a ac3 -b:a 448k");
    expect(ts).toContain("/tmp/s3/seg%05d.ts /tmp/s3/index.m3u8");
    expect(ts).not.toContain("webvtt");
  });

  it("serves the playlist ready to play from the start", () => {
    const written = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.000000,\nseg00000.m4s\n#EXTINF:6.000000,\nseg00001.m4s\n";
    const served = playlistForPlayer(written);
    expect(served.split("\n").slice(0, 3)).toEqual(["#EXTM3U", "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES", "#EXT-X-VERSION:7"]);
    expect(playlistForPlayer(served)).toBe(served);
    // The longest-piece promise stays put as the playlist grows, unless a piece outruns it.
    const growing = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000000,\nseg00000.m4s\n";
    expect(playlistForPlayer(growing)).toContain("#EXT-X-TARGETDURATION:12\n");
    expect(playlistForPlayer(growing.replace("6.000000", "14.500000").replace("DURATION:6", "DURATION:15"))).toContain("#EXT-X-TARGETDURATION:15\n");
    expect(playlistState(written)).toEqual({ segments: 2, ended: false });
    expect(playlistState(written + "#EXT-X-ENDLIST\n")).toEqual({ segments: 2, ended: true });
    expect(playlistState("")).toEqual({ segments: 0, ended: false });
    expect(sessionFile("seg00012.m4s")).toBe(true);
    expect(sessionFile("sub3.vtt")).toBe(true);
    expect(sessionFile("../personal.json")).toBe(false);
    expect(sessionFile("index.m3u8.tmp")).toBe(false);
    expect(sessionFileType("index.m3u8")).toBe("application/vnd.apple.mpegurl");
    expect(sessionFileType("seg00001.ts")).toBe("video/mp2t");
  });

  it("lists the whole film for the phone, in six-second pieces", () => {
    expect(vodPieces(3481.5)).toBe(581);
    expect(vodPieces(12)).toBe(2);
    expect(pieceName(37)).toBe("seg00037.ts");
    const list = vodPlaylist({ duration: 15.5, start: 217 }).split("\n");
    expect(list.slice(0, 7)).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-START:TIME-OFFSET=217,PRECISE=YES",
    ]);
    expect(list.slice(7)).toEqual(["#EXTINF:6.000,", "seg00000.ts", "#EXTINF:6.000,", "seg00001.ts", "#EXTINF:3.500,", "seg00002.ts", "#EXT-X-ENDLIST", ""]);
    expect(vodPlaylist({ duration: 6 })).not.toContain("EXT-X-START");
  });

  it("makes the phone's pieces at the same places whichever run makes them", () => {
    const probe = parseProbe(MKV);
    const args = vodArgs({ url: "http://127.0.0.1:8090/v1/source/movie/7.mkv?key=k", piece: 36, encoder: "h264_nvenc", probe, dir: "/tmp/s/r2", audioTrack: 1, height: 1080, subtitles: true });
    const text = args.join(" ");
    // The film's own clock, from where piece 36 starts.
    expect(text).toContain("-copyts -start_at_zero");
    expect(text).toContain("-ss 216 -i http://127.0.0.1:8090/v1/source/movie/7.mkv?key=k -map 0:V:0 -map 0:a:1?");
    // Converted, with an IDR keyframe every six seconds, sound to AAC stereo.
    expect(text).toContain("-c:v h264_nvenc");
    expect(text).toContain("-forced-idr 1");
    expect(text).toContain("-force_key_frames expr:gte(t,n_forced*6)");
    expect(text).toContain("-c:a aac -b:a 192k -ac 2");
    // Pieces numbered as in the playlist.
    expect(text).toContain("-f segment -segment_format mpegts -segment_format_options avoid_negative_ts=disabled -segment_time 6");
    expect(text).toContain("-segment_start_number 36 /tmp/s/r2/seg%05d.ts");
    // Text subtitles only (not the PGS one), with their own times.
    expect(text).toContain("-map 0:s:0 -c:s webvtt -flush_packets 1 -f webvtt /tmp/s/r2/sub0.vtt");
    expect(text).toContain("/tmp/s/r2/sub2.vtt");
    expect(text).not.toContain("sub1.vtt");
    const first = vodArgs({ url: "u", piece: 0, encoder: "libx264", probe, dir: "/d" });
    expect(first).not.toContain("-ss");
    expect(first).not.toContain("-forced-idr");
    expect(first.join(" ")).not.toContain("webvtt");
  });

  it("puts the subtitle lines of several runs together", () => {
    const one = "WEBVTT\n\n00:01:10.006 --> 00:01:14.006\nSeventy seconds in.\n\n00:00:20.006 --> 00:00:24.006\nTwenty\nseconds in.\n";
    const two = "WEBVTT\r\n\r\n00:01:10.006 --> 00:01:14.006\r\nSeventy seconds in.\r\n\r\n00:02:00.000 --> 00:02:01.000\r\nLater.\r\n";
    expect(mergeVtt([one, two])).toBe(
      "WEBVTT\n\n00:00:20.006 --> 00:00:24.006\nTwenty\nseconds in.\n\n00:01:10.006 --> 00:01:14.006\nSeventy seconds in.\n\n00:02:00.000 --> 00:02:01.000\nLater.\n\n",
    );
    expect(mergeVtt([])).toBe("WEBVTT\n\n");
  });

  it("sends the phone less: text gzipped, built files kept", () => {
    expect(wantsGzip("gzip, deflate, br")).toBe(true);
    expect(wantsGzip("br, gzip;q=0")).toBe(false);
    expect(wantsGzip("gzip;q=0.5")).toBe(true);
    expect(wantsGzip("deflate")).toBe(false);
    expect(wantsGzip(undefined)).toBe(false);
    expect(compressible("application/json")).toBe(true);
    expect(compressible("text/javascript; charset=utf-8")).toBe(true);
    expect(compressible("font/ttf")).toBe(false);
    expect(compressible("video/mp2t")).toBe(false);
    expect(hashedAsset("Nunito-SemiBold-YSI2M6QZ.ttf")).toBe(true);
    expect(hashedAsset("app.js")).toBe(false);
  });

  it("asks the provider only what the app needs", () => {
    const login = { server: "http://host.example:8080", username: "jane doe", password: "pw&1" };
    expect(xtreamQuery(login, new URLSearchParams("key=k&action=get_vod_streams&category_id=12"))).toBe(
      "http://host.example:8080/player_api.php?username=jane%20doe&password=pw%261&action=get_vod_streams&category_id=12",
    );
    expect(xtreamQuery(login, new URLSearchParams("key=k"))).toBe("http://host.example:8080/player_api.php?username=jane%20doe&password=pw%261");
    expect(xtreamQuery(login, new URLSearchParams("action=get_live_streams"))).toBeNull();
    expect(xtreamQuery(login, new URLSearchParams("action=get_vod_info&vod_id=1%26x=2"))).toBeNull();
    expect(fetchAllowed("https://api.opensubtitles.com/api/v1/subtitles?query=x")).toBe(true);
    expect(fetchAllowed("https://www.opensubtitles.com/download/abc/file.srt")).toBe(true);
    expect(fetchAllowed("https://opensubtitles.com.evil.example/")).toBe(false);
    expect(fetchAllowed("file:///etc/passwd")).toBe(false);
    expect(fetchAllowed("not a url")).toBe(false);
  });

  it("fingerprints a file the way OpenSubtitles does", () => {
    // Every 64-bit word is 1, so the sum is the size plus 2 x 8192.
    const words = new Uint8Array(65536);
    for (let i = 0; i < words.length; i += 8) words[i] = 1;
    expect(movieHash(words, words, 1000000)).toBe((1000000 + 16384).toString(16).padStart(16, "0"));
    // It wraps at 64 bits.
    const full = new Uint8Array(65536).fill(255);
    expect(movieHash(full, full, 1)).toBe("ffffffffffffc001");
  });

  it("builds the provider's address and hides the login", () => {
    const login = { server: "http://host.example:8080", username: "jane doe", password: "pw/1" };
    const url = providerUrl(login, "series", "77", "mkv");
    expect(url).toBe("http://host.example:8080/series/jane%20doe/pw%2F1/77.mkv");
    expect(redactor(login, "k3y123")(url + "?key=k3y123")).toBe("<server>/series/<user>/<password>/77.mkv?key=<key>");
  });
});
