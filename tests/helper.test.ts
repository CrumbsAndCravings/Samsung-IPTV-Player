// The helper's conversion plan (helper/plan.mjs): what FFmpeg is told for each kind of
// file. The text below is what `ffmpeg -i` prints for real files.
import { describe, expect, it } from "vitest";
import {
  ac3Args,
  audioPlan,
  bifFile,
  compressible,
  convertedRanges,
  fetchAllowed,
  ffmpegArgs,
  firstFrameSecs,
  hashedAsset,
  hlsArgs,
  hlsVideoPlan,
  homeAddress,
  hwaccelFor,
  keptArgs,
  keptPieceName,
  keptPieces,
  keptPlaylist,
  keptPreroll,
  mergeVtt,
  movieHash,
  parseProbe,
  phoneKeeps,
  pieceName,
  playlistForPlayer,
  playlistState,
  providerUrl,
  redactor,
  sessionFile,
  speedVerdict,
  sessionFileType,
  tailscaleIp,
  tailscaleRoute,
  videoPlan,
  vodArgs,
  vodPieces,
  vodPlaylist,
  wantsGzip,
  x264Args,
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

// A rich 4K film as FFmpeg 6 describes it: HDR10 with Dolby Vision on top (profile 8.1,
// which has an HDR10 picture underneath), its clock starting a little before 0.
const UHD = `Input #0, matroska,webm, from 'http://127.0.0.1:8090/v1/source/movie/9.mkv?key=k':
  Duration: 03:00:22.85, start: -0.005000, bitrate: 25311 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr, 1k tbn (default)
    Side data:
      DOVI configuration record: version: 1.0, profile: 8, level: 6, rpu flag: 1, el flag: 0, bl flag: 1, compatibility id: 1
  Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 768 kb/s (default)`;

describe("the helper", () => {
  it("reads what a file holds", () => {
    expect(parseProbe(AVI)).toEqual({
      duration: 6133,
      start: 0,
      video: { codec: "mpeg4", width: 640, height: 272, profile: "Advanced Simple Profile", pixels: "yuv420p", dvOnly: false },
      audio: [{ codec: "mp3", channels: 2, language: "" }],
      subtitles: [],
    });
    const mkv = parseProbe(MKV);
    expect(mkv.video).toEqual({ codec: "hevc", width: 1920, height: 1080, profile: "Main 10", pixels: "yuv420p10le", dvOnly: false });
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
    // Where the clock starts, and Dolby Vision with an HDR10 picture underneath.
    const uhd = parseProbe(UHD);
    expect(uhd.start).toBe(-0.005);
    expect(uhd.duration).toBe(10823);
    expect(uhd.video).toEqual({ codec: "hevc", width: 3840, height: 2160, profile: "Main 10", pixels: "yuv420p10le", dvOnly: false });
    // Profile 5 has nothing underneath.
    expect(parseProbe(UHD.replace("profile: 8", "profile: 5").replace("compatibility id: 1", "compatibility id: 0")).video!.dvOnly).toBe(true);
    // An MP4's picture says its tag after the profile.
    expect(parseProbe("  Stream #0:0[0x1](und): Video: h264 (High 10) (avc1 / 0x31637661), yuv420p10le(tv, bt709, progressive), 1920x1080").video).toEqual({
      codec: "h264",
      width: 1920,
      height: 1080,
      profile: "High 10",
      pixels: "yuv420p10le",
      dvOnly: false,
    });
  });

  it("keeps the picture the phone plays as it is, and converts the rest", () => {
    const video = (codec: string, profile: string, pixels: string, dvOnly = false) => ({ codec, width: 3840, height: 2160, profile, pixels, dvOnly });
    expect(phoneKeeps(video("hevc", "Main 10", "yuv420p10le"), true)).toBe(true);
    expect(phoneKeeps(video("hevc", "Main", "yuv420p"), true)).toBe(true);
    // Unless the phone says it doesn't play HEVC (a desktop browser, or learned).
    expect(phoneKeeps(video("hevc", "Main 10", "yuv420p10le"), false)).toBe(false);
    expect(phoneKeeps(video("hevc", "Main 10", "yuv420p10le", true), true)).toBe(false);
    expect(phoneKeeps(video("hevc", "Rext", "yuv422p10le"), true)).toBe(false);
    expect(phoneKeeps(video("h264", "High", "yuv420p"), false)).toBe(true);
    expect(phoneKeeps(video("h264", "Constrained Baseline", "yuv420p"), false)).toBe(true);
    // 10-bit H.264 is beyond the phone's decoder.
    expect(phoneKeeps(video("h264", "High 10", "yuv420p10le"), true)).toBe(false);
    expect(phoneKeeps(video("mpeg4", "Advanced Simple Profile", "yuv420p"), true)).toBe(false);
    expect(phoneKeeps(null, true)).toBe(false);
    // An unknown profile is tried (the app asks for a conversion if it doesn't play).
    expect(phoneKeeps(video("h264", "", ""), true)).toBe(true);
  });

  it("cuts a kept picture at the file's own keyframes, about six seconds apart", () => {
    // Keyframes every two seconds, one at 6.1 right after 6.011 (FFmpeg asked to start just
    // past 6.011 could land on 6.1, so that one isn't a piece's start), one at 12.0 just
    // short of 6 s after 6.1, then sparse ones.
    const keyframes = [0.005, 2.007, 4.009, 6.011, 6.1, 8.013, 10.015, 12.0, 14.1, 20, 33, 39.8];
    const starts = keptPieces(keyframes, 40);
    expect(starts).toEqual([0, 6.1, 14.1, 33]);
    expect(keptPieceName(3)).toBe("seg00003.m4s");
    // A run that makes piece n starts on a keyframe at least a second before it.
    expect(keptPreroll(keyframes, starts, 0)).toBe(0);
    expect(keptPreroll(keyframes, starts, 1)).toBe(4.009);
    expect(keptPreroll(keyframes, starts, 2)).toBe(12.0);
    expect(keptPreroll(keyframes, starts, 3)).toBe(20);
    const list = keptPlaylist({ starts, duration: 40, start: 15 }).split("\n");
    expect(list.slice(0, 8)).toEqual([
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:19",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-START:TIME-OFFSET=15,PRECISE=YES",
      '#EXT-X-MAP:URI="init.mp4"',
    ]);
    expect(list.slice(8)).toEqual(["#EXTINF:6.100,", "seg00000.m4s", "#EXTINF:8.000,", "seg00001.m4s", "#EXTINF:18.900,", "seg00002.m4s", "#EXTINF:7.000,", "seg00003.m4s", "#EXT-X-ENDLIST", ""]);
    expect(keptPlaylist({ starts, duration: 40 })).not.toContain("EXT-X-START");
  });

  it("copies a kept picture into fragmented MP4 on the film's own clock", () => {
    const probe = parseProbe(UHD);
    const first = keptArgs({ url: "http://127.0.0.1:8090/v1/source/movie/9.mkv?key=k", probe, dir: "/tmp/s/r1", subtitles: true, previews: true, atomic: true, userAgent: "Lavf" });
    const text = first.join(" ");
    expect(text).toContain("-copyts -start_at_zero -user_agent Lavf -reconnect 1");
    expect(text).not.toContain("-ss");
    expect(text).toContain("-skip_frame:v nokey -i http://127.0.0.1:8090/v1/source/movie/9.mkv?key=k -map 0:V:0 -map 0:a:0?");
    expect(text).toContain("-c:v copy -tag:v hvc1");
    // The sound on one grid of AAC frames for every run, converted to stereo.
    expect(text).toContain("-af aresample=48000:first_pts=0 -c:a aac -b:a 192k -ac 2 -sn -dn");
    expect(text).toContain("-avoid_negative_ts disabled -output_ts_offset 1");
    expect(text).toContain("-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets+skip_trailer pipe:1");
    // Pictures for choosing a jump, from keyframes, as for the TV.
    expect(text).toContain("-vf fps=1/10,scale=-2:180 -q:v 5 -f image2 -frame_pts 1 -atomic_writing 1 /tmp/s/r1/p%05d.jpg");
    // From a keyframe at 61.2 s: just past it, the sound from where FFmpeg lands, its
    // frames on the grid from a little before.
    const later = keptArgs({ url: "u", from: 61.2, probe: parseProbe(MKV), dir: "/d", audioTrack: 1 }).join(" ");
    expect(later).toContain("-ss 61.400 -noaccurate_seek -i u -map 0:V:0 -map 0:a:1?");
    expect(later).toContain("first_pts=" + (Math.floor((61.2 * 48000) / 1024) - 1) * 1024);
    expect(later).not.toContain("skip_frame");
    expect(keptArgs({ url: "u", probe: parseProbe("  Stream #0:0: Video: h264 (High), yuv420p, 1280x720"), dir: "/d" }).join(" ")).toContain("-tag:v avc1");
  });

  it("tells the phone at home from the phone away", () => {
    for (const ip of ["192.168.1.23", "10.0.0.8", "172.20.1.1", "127.0.0.1", "::1", "::ffff:192.168.1.5", "fe80::1c2b:3aff:fe11:2233%en0", "fd12:3456::9"]) expect(homeAddress(ip)).toBe(true);
    for (const ip of ["100.101.102.103", "fd7a:115c:a1e0::53", "8.8.8.8", "172.32.0.1", "2607:f8b0::1"]) expect(homeAddress(ip)).toBe(false);
    // A public IPv6 address on this computer's own /64 is the home network.
    expect(homeAddress("2600:1700:abcd:1230::77", ["192.168.1.10", "2600:1700:abcd:1230:5d2e::1"])).toBe(true);
    expect(homeAddress("2600:1700:abcd:9999::77", ["2600:1700:abcd:1230:5d2e::1"])).toBe(false);
    expect(tailscaleIp("100.64.0.1")).toBe(true);
    expect(tailscaleIp("100.128.0.1")).toBe(false);
    expect(tailscaleIp("fd7a:115c:a1e0:ab12::1")).toBe(true);
    // What Tailscale says of the phone: straight over the home Wi-Fi, through the
    // internet, or through its relays.
    const status = {
      Self: { TailscaleIPs: ["100.64.0.2"] },
      Peer: {
        "nodekey:a": { TailscaleIPs: ["100.101.1.2", "fd7a:115c:a1e0::1"], CurAddr: "192.168.1.23:41641", Relay: "tor" },
        "nodekey:b": { TailscaleIPs: ["100.101.1.3"], CurAddr: "[2607:fb90::5]:41641", Relay: "tor" },
        "nodekey:c": { TailscaleIPs: ["100.101.1.4"], CurAddr: "", Relay: "tor" },
      },
    };
    expect(tailscaleRoute(status, "100.101.1.2")).toBe("192.168.1.23");
    expect(tailscaleRoute(status, "fd7a:115c:a1e0::1")).toBe("192.168.1.23");
    expect(tailscaleRoute(status, "100.101.1.3")).toBe("2607:fb90::5");
    expect(tailscaleRoute(status, "100.101.1.4")).toBe("");
    expect(tailscaleRoute(status, "100.101.1.9")).toBe("");
    expect(tailscaleRoute(null, "100.101.1.2")).toBe("");
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
    expect(text).toContain("-c:a:0 ac3 -b:a:0 640k -c:a:1 copy");
    expect(text).toContain("-f mpegts");
    expect(copy[copy.length - 1]).toBe("pipe:1");
    const avi = ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "copy", encoder: "libx264", probe: parseProbe(AVI) }).join(" ");
    expect(avi).not.toContain("-ss");
    expect(avi).toContain("-bsf:v mpeg4_unpack_bframes");
    const converted = ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "convert", encoder: "h264_qsv", probe: parseProbe(AVI) }).join(" ");
    expect(converted).toContain("-c:v h264_qsv");
    expect(converted).toContain("-c:a:0 aac");
  });

  it("writes a picture every six seconds of the film for choosing a jump, when asked", () => {
    const mkv = parseProbe(MKV);
    const args = ffmpegArgs({ url: "http://p/1.mkv", start: 754, video: "copy", encoder: "libx264", probe: mkv, previews: { dir: "/tmp/pv", atomic: true } });
    const text = args.join(" ");
    // The stream comes first, then the pictures, named by the film's own time.
    expect(text.indexOf("pipe:1")).toBeLessThan(text.indexOf("-f image2"));
    expect(text).toContain("-map 0:V:0 -an -sn -dn -vf setpts=PTS+754/TB,fps=1/6,scale=-2:180");
    expect(text).toContain("-frame_pts 1 -atomic_writing 1");
    expect(args[args.length - 1]).toMatch(/pv.p%05d\.jpg$/);
    const fromStart = ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "libx264", probe: mkv, previews: { dir: "/tmp/pv", atomic: false } }).join(" ");
    expect(fromStart).toContain("-vf fps=1/6,scale=-2:180");
    expect(fromStart).not.toContain("atomic_writing");
    expect(ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "libx264", probe: mkv }).join(" ")).not.toContain("image2");
  });

  it("makes the pictures from keyframes only when the picture is kept", () => {
    const mkv = parseProbe(MKV);
    const kept = ffmpegArgs({ url: "http://p/1.mkv", start: 754, video: "copy", encoder: "libx264", probe: mkv, previews: { dir: "/tmp/pv", atomic: true } }).join(" ");
    // A decoder option, so it goes before the input; the stream itself is copied whole.
    expect(kept).toContain("-skip_frame:v nokey -i http://p/1.mkv");
    expect(kept).toContain("-c:v copy");
    // Converted, every frame is decoded for the encoder, so nothing is skipped.
    const avi = parseProbe(AVI);
    expect(ffmpegArgs({ url: "http://p/1.avi", start: 0, video: "convert", encoder: "libx264", probe: avi, previews: { dir: "/tmp/pv", atomic: true } }).join(" ")).not.toContain("skip_frame");
    expect(ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "libx264", probe: mkv }).join(" ")).not.toContain("skip_frame");
  });

  it("notes where a kept picture really starts, for the TV's clock", () => {
    const mkv = parseProbe(MKV);
    const kept = ffmpegArgs({ url: "http://p/1.mkv", start: 754, video: "copy", encoder: "libx264", probe: mkv, startFile: "/tmp/start-1.txt" }).join(" ");
    expect(kept).toContain("pipe:1 -map 0:V:0 -c:v copy -frames:v 1 -flush_packets 1 -f framemd5 /tmp/start-1.txt");
    // From the start, or converted (which starts exactly where asked): nothing to note.
    expect(ffmpegArgs({ url: "http://p/1.mkv", start: 0, video: "copy", encoder: "libx264", probe: mkv, startFile: "/tmp/s.txt" }).join(" ")).not.toContain("framemd5");
    expect(ffmpegArgs({ url: "http://p/1.avi", start: 60, video: "convert", encoder: "libx264", probe: parseProbe(AVI), startFile: "/tmp/s.txt" }).join(" ")).not.toContain("framemd5");
    // What FFmpeg 7 wrote for a stream asked for at 14.5 s, from a keyframe at 12 s.
    const md5 = "#format: frame checksums\n#version: 2\n#hash: MD5\n#tb 0: 1/1000\n#media_type 0: video\n#codec_id 0: h264\n#dimensions 0: 640x360\n#sar 0: 1/1\n#stream#, dts,        pts, duration,     size, hash\n0,      -2500,      -2500,       41,    19788, 3aad364d6be07a438ca19bbf5ce90c57\n";
    expect(firstFrameSecs(md5)).toBe(-2.5);
    expect(firstFrameSecs("#tb 0: 1/90000\n0, -180000, -171000, 3750, 100, ab\n")).toBe(-1.9);
    expect(firstFrameSecs("#tb 0: 1/1000\n")).toBeNull();
    expect(firstFrameSecs("")).toBeNull();
  });

  it("keeps surround sound surround, 7.1 as 5.1 with its subwoofer", () => {
    // Dolby Digital, Dolby Digital Plus (Atmos included) and AAC pass as they are.
    expect(audioPlan({ codec: "eac3", channels: 6 })).toBe("copy");
    expect(audioPlan({ codec: "ac3", channels: 6 })).toBe("copy");
    expect(audioPlan({ codec: "truehd", channels: 8 })).toBe("ac3");
    expect(audioPlan({ codec: "dts", channels: 2 })).toBe("aac");
    // TrueHD 7.1 and DTS-HD 7.1: Dolby Digital 5.1 at its highest rate.
    const atmos = parseProbe(`Input #0, matroska,webm, from 'x.mkv':
  Duration: 02:10:00.00, start: 0.000000, bitrate: 40000 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 3840x2160, 23.98 fps (default)
  Stream #0:1(eng): Audio: truehd, 48000 Hz, 7.1, s32 (24 bit) (default)
  Stream #0:2(eng): Audio: dts (DTS-HD MA), 48000 Hz, 5.1(side), s32p (24 bit)
  Stream #0:3(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 768 kb/s`);
    expect(atmos.audio.map((a) => a.channels)).toEqual([8, 6, 6]);
    const text = ffmpegArgs({ url: "u", start: 0, video: "copy", encoder: "libx264", probe: atmos }).join(" ");
    expect(text).toContain("-c:a:0 ac3 -b:a:0 640k -ac:a:0 6 -c:a:1 ac3 -b:a:1 640k -c:a:2 copy");
    expect(ac3Args(6).join(" ")).toBe("-c:a ac3 -b:a 640k");
    expect(ac3Args(8).join(" ")).toBe("-c:a ac3 -b:a 640k -ac:a 6");
  });

  it("judges the provider's speed against what the film needs", () => {
    const mb = (mbit: number) => (mbit * 1e6) / 8; // bytes in a second at `mbit`
    const steady = Array(20).fill(mb(60));
    expect(speedVerdict(26000, steady)).toMatchObject({ avg: 60, low: 60, need: 26, verdict: "fast", slowSecs: 0 });
    // Plenty on average, but five slow seconds in a row.
    const dipping = Array(15).fill(mb(60)).concat(Array(5).fill(mb(10)));
    expect(speedVerdict(26000, dipping).verdict).toBe("dips");
    expect(Math.round(speedVerdict(26000, dipping).low)).toBe(10);
    expect(speedVerdict(26000, Array(20).fill(mb(18))).verdict).toBe("slow");
    // A slow start (the test at home: 13 seconds at 12 to 24, then 250 to 330).
    const slowStart = [12, 15, 18, 20, 24, 16, 14, 22, 19, 23, 17, 21, 13, 250, 300, 330, 320, 310, 290, 300].map(mb);
    const found = speedVerdict(25000, slowStart);
    expect(found.verdict).toBe("slowstart");
    expect(found.slowSecs).toBe(13);
    expect([found.startLow, found.startHigh]).toEqual([12, 24]);
    expect(Math.round(found.afterAvg)).toBe(300);
    expect(speedVerdict(0, steady).verdict).toBe("");
  });

  it("converts on the processor with quicker settings on a small computer", () => {
    expect(x264Args("veryfast").join(" ")).toBe("-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -profile:v high -level:v 4.1");
    expect(x264Args("superfast").join(" ")).toContain("-preset superfast -crf 23");
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
    expect(ts).toContain("-c:a ac3 -b:a 640k");
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
    // No pictures unless asked; with them, one for every ten seconds of the film, named by
    // the film's time over ten.
    expect(text).not.toContain("p%05d.jpg");
    const pictures = vodArgs({ url: "u", piece: 36, encoder: "libx264", probe, dir: "/d", previews: true, atomic: true }).join(" ");
    expect(pictures).toContain("-map 0:V:0 -an -sn -dn -vf fps=1/10,scale=-2:180 -q:v 5 -f image2 -frame_pts 1 -atomic_writing 1 /d/p%05d.jpg");
    expect(vodArgs({ url: "u", piece: 0, encoder: "libx264", probe, dir: "/d", previews: true }).join(" ")).not.toContain("atomic_writing");
    expect(sessionFile("p00036.jpg")).toBe(true);
    expect(sessionFileType("p00036.jpg")).toBe("image/jpeg");
    expect(sessionFile("previews.json")).toBe(true);
    expect(sessionFile("previews.bif")).toBe(true);
    expect(sessionFile("previews.txt")).toBe(false);
    expect(sessionFileType("previews.json")).toBe("application/json; charset=utf-8");
    const first = vodArgs({ url: "u", piece: 0, encoder: "libx264", probe, dir: "/d" });
    expect(first).not.toContain("-ss");
    expect(first).not.toContain("-forced-idr");
    expect(first.join(" ")).not.toContain("webvtt");
  });

  it("reads the file with the graphics card that converts it", () => {
    const probe = parseProbe(MKV);
    const card = vodArgs({ url: "u", piece: 36, encoder: "h264_nvenc", probe, dir: "/d", hwaccel: "cuda" });
    // An input option: after the jump, before the file.
    expect(card.join(" ")).toContain("-ss 216 -hwaccel cuda -i u");
    expect(vodArgs({ url: "u", piece: 0, encoder: "libx264", probe, dir: "/d" })).not.toContain("-hwaccel");
    expect(hwaccelFor("h264_nvenc", "win32")).toBe("cuda");
    expect(hwaccelFor("h264_nvenc", "linux")).toBe("cuda");
    expect(hwaccelFor("h264_qsv", "win32")).toBe("d3d11va");
    expect(hwaccelFor("h264_qsv", "linux")).toBe("qsv");
    expect(hwaccelFor("h264_amf", "win32")).toBe("d3d11va");
    expect(hwaccelFor("libx264", "win32")).toBe("");
  });

  it("packs pictures into one BIF the Roku reads", () => {
    const one = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const two = new Uint8Array([0xff, 0xd8, 4, 5]);
    const bif = bifFile([
      { seconds: 30, data: one },
      { seconds: 40, data: two },
    ]);
    const u32 = (at: number) => new DataView(bif.buffer, bif.byteOffset, bif.byteLength).getUint32(at, true);
    expect([...bif.subarray(0, 8)]).toEqual([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([u32(8), u32(12), u32(16)]).toEqual([0, 2, 1000]);
    expect([...bif.subarray(20, 64)].every((b) => b === 0)).toBe(true);
    // The index: each picture's seconds and where it starts, then the end.
    const start = 64 + 3 * 8;
    expect([u32(64), u32(68)]).toEqual([30, start]);
    expect([u32(72), u32(76)]).toEqual([40, start + 5]);
    expect([u32(80), u32(84)]).toEqual([0xffffffff, start + 9]);
    expect([...bif.subarray(start, start + 5)]).toEqual([...one]);
    expect([...bif.subarray(start + 5)]).toEqual([...two]);
    expect(bif.length).toBe(start + 9);
    // None yet is a header and the end entry.
    const none = bifFile([]);
    expect(none.length).toBe(72);
    expect(new DataView(none.buffer, none.byteOffset, none.byteLength).getUint32(68, true)).toBe(72);
  });

  it("tells the TV which stretches of the film are converted", () => {
    expect(convertedRanges([])).toEqual([]);
    expect(convertedRanges(new Set([3, 0, 1, 2, 10, 11]).values())).toEqual([
      [0, 24],
      [60, 72],
    ]);
    expect(convertedRanges([5], 10)).toEqual([[50, 60]]);
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
