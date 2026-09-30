import { beforeEach, describe, expect, it } from "vitest";
import { comboOf, isFormatError, learnResult, playCheck } from "../src/core/compat";
import { MemoryStore, readJson, useStore } from "../src/core/storage";

const file = (key: string, ext: string, video = "", audio = "") => ({ key, ext, videoCodec: video, videoProfile: "", audioCodec: audio });
const NOT_SUPPORTED = "PLAYER_ERROR_NOT_SUPPORTED_FORMAT";

describe("playability on this TV", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("passes the formats the M0 checks played", () => {
    expect(playCheck(file("m:1", "mkv", "hevc", "aac")).verdict).toBe("ok");
    expect(playCheck(file("m:2", "mp4", "h264", "aac")).verdict).toBe("ok");
  });

  it("marks AVI as won't play, since none played in M0", () => {
    expect(playCheck(file("m:3", "AVI", "mpeg4", "mp3"))).toEqual({
      verdict: "blocked",
      reason: "This is an AVI file. AVI files don't play on this TV. Your provider may have another version of this title.",
      label: "AVI file",
    });
  });

  it("remembers a title that failed, and one that played", () => {
    learnResult(file("m:4", "avi", "mpeg4", "mp3"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:4", "avi", "mpeg4", "mp3"))).toEqual({
      verdict: "blocked",
      reason: "This video didn't play on this TV last time (PLAYER_ERROR_NOT_SUPPORTED_FORMAT).",
      label: "didn't play last time",
    });
    learnResult(file("m:5", "avi"), true, "");
    expect(playCheck(file("m:5", "avi")).verdict).toBe("ok");
  });

  it("blocks a combination only after two titles failed and none played", () => {
    learnResult(file("m:6", "mkv", "vc1", "dts"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:7", "mkv", "vc1", "dts")).verdict).toBe("ok");
    learnResult(file("m:8", "mkv", "vc1", "dts"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:7", "mkv", "vc1", "dts"))).toEqual({
      verdict: "blocked",
      reason: "Files like this (MKV, VC-1 video, DTS audio) haven't played on this TV.",
      label: "files like this haven't played",
    });
    learnResult(file("m:9", "mkv", "vc1", "dts"), true, "");
    expect(playCheck(file("m:7", "mkv", "vc1", "dts")).verdict).toBe("ok");
  });

  it("lets an AVI that did play here through", () => {
    learnResult(file("m:14", "avi", "h264", "aac"), true, "");
    expect(playCheck(file("m:14", "avi", "h264", "aac")).verdict).toBe("ok");
  });

  it("doesn't learn from connection trouble or judge unknown codecs as a group", () => {
    learnResult(file("m:10", "mkv", "hevc", "aac"), false, "PLAYER_ERROR_CONNECTION_FAILED");
    expect(playCheck(file("m:10", "mkv", "hevc", "aac")).verdict).toBe("ok");
    learnResult(file("m:11", "mkv"), false, NOT_SUPPORTED);
    learnResult(file("m:12", "mkv"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:13", "mkv")).verdict).toBe("ok");
    expect(comboOf(file("m:13", "mkv"))).toBe("");
  });

  it("recognises format errors", () => {
    expect(isFormatError("PLAYER_ERROR_NOT_SUPPORTED_FILE")).toBe(true);
    expect(isFormatError(NOT_SUPPORTED)).toBe(true);
    expect(isFormatError("PLAYER_ERROR_CONNECTION_FAILED")).toBe(false);
  });

  it("keeps the newest 500 results", () => {
    for (let i = 0; i < 505; i++) learnResult(file("m:x" + i, "mkv", "hevc"), true, "", 1000 + i);
    learnResult(file("m:x0", "mkv", "hevc"), false, NOT_SUPPORTED, 5000);
    const saved = readJson("compat", "titles") as { [key: string]: unknown };
    expect(Object.keys(saved).length).toBe(500);
    expect("m:x0" in saved).toBe(true); // updated, so now the newest
    expect("m:x1" in saved).toBe(false); // the oldest went first
    expect("m:x6" in saved).toBe(true);
    expect(playCheck(file("m:x0", "mkv", "hevc")).verdict).toBe("blocked");
  });
});
