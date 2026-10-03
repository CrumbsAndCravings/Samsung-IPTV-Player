// The helper's conversion plan (helper/plan.mjs): what FFmpeg is told for each kind of
// file. The text below is what `ffmpeg -i` prints for real files.
import { describe, expect, it } from "vitest";
import { audioPlan, ffmpegArgs, parseProbe, providerUrl, redactor, videoPlan } from "../helper/plan.mjs";

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

  it("builds the provider's address and hides the login", () => {
    const login = { server: "http://host.example:8080", username: "jane doe", password: "pw/1" };
    const url = providerUrl(login, "series", "77", "mkv");
    expect(url).toBe("http://host.example:8080/series/jane%20doe/pw%2F1/77.mkv");
    expect(redactor(login, "k3y123")(url + "?key=k3y123")).toBe("<server>/series/<user>/<password>/77.mkv?key=<key>");
  });
});
