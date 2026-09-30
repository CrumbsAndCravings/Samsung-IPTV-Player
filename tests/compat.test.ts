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

  it("warns before AVI, but doesn't block it", () => {
    expect(playCheck(file("m:3", "AVI", "mpeg4", "mp3"))).toEqual({ verdict: "warn", reason: "AVI files often don't play on this TV." });
  });

  it("remembers a title that failed, and one that played", () => {
    learnResult(file("m:4", "avi", "mpeg4", "mp3"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:4", "avi", "mpeg4", "mp3"))).toEqual({
      verdict: "blocked",
      reason: "This video didn't play on this TV last time (PLAYER_ERROR_NOT_SUPPORTED_FORMAT).",
    });
    learnResult(file("m:5", "avi"), true, "");
    expect(playCheck(file("m:5", "avi")).verdict).toBe("ok");
  });

  it("blocks a combination only after two titles failed and none played", () => {
    learnResult(file("m:6", "avi", "mpeg4", "mp3"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:7", "avi", "mpeg4", "mp3")).verdict).toBe("warn");
    learnResult(file("m:8", "avi", "mpeg4", "mp3"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:7", "avi", "mpeg4", "mp3"))).toEqual({
      verdict: "blocked",
      reason: "Files like this (AVI, MPEG-4 (DivX/Xvid) video, MP3 audio) haven't played on this TV.",
    });
    learnResult(file("m:9", "avi", "mpeg4", "mp3"), true, "");
    expect(playCheck(file("m:7", "avi", "mpeg4", "mp3")).verdict).toBe("warn");
  });

  it("doesn't learn from connection trouble or judge unknown codecs as a group", () => {
    learnResult(file("m:10", "mkv", "hevc", "aac"), false, "PLAYER_ERROR_CONNECTION_FAILED");
    expect(playCheck(file("m:10", "mkv", "hevc", "aac")).verdict).toBe("ok");
    learnResult(file("m:11", "avi"), false, NOT_SUPPORTED);
    learnResult(file("m:12", "avi"), false, NOT_SUPPORTED);
    expect(playCheck(file("m:13", "avi")).verdict).toBe("warn");
    expect(comboOf(file("m:13", "avi"))).toBe("");
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
