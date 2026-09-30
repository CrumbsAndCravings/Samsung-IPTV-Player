import { describe, expect, it } from "vitest";
import { CueTrack, parseSubtitles, parseTimestamp } from "../src/core/srt";

const SRT = [
  "﻿1",
  "00:00:01,000 --> 00:00:03,500",
  "<i>Hello</i> there.",
  "",
  "2",
  "00:00:03,000 --> 00:00:05,000",
  "{\\an8}Overlapping &amp; on top",
  "",
  "3",
  "00:01:00,5 --> 00:01:02,000",
  "",
  "4",
  "00:00:10,000 --> 00:00:12,000",
  "Two",
  "lines",
  "",
].join("\r\n");

describe("SRT", () => {
  const cues = parseSubtitles(SRT);
  it("reads cues through a BOM and CRLF line ends", () => {
    expect(cues.length).toBe(3);
    expect(cues[0]).toEqual({ start: 1000, end: 3500, text: "Hello there." });
  });
  it("removes tags and decodes entities", () => {
    expect(cues[1].text).toBe("Overlapping & on top");
  });
  it("keeps line breaks and drops empty cues", () => {
    expect(cues[2].text).toBe("Two\nlines");
    expect(cues.some((c) => c.start === 60500)).toBe(false);
  });
});

describe("WebVTT", () => {
  const vtt = "WEBVTT\n\nNOTE made by hand\n\n00:05.250 --> 00:07.000 align:start position:10%\n<v Roger>Short times\n\n01:00:00.000 --> 01:00:01.000\nAn hour in\n";
  it("reads hour-less times and ignores cue settings and notes", () => {
    const cues = parseSubtitles(vtt);
    expect(cues).toEqual([
      { start: 5250, end: 7000, text: "Short times" },
      { start: 3600000, end: 3601000, text: "An hour in" },
    ]);
  });
});

describe("timestamps", () => {
  it("reads both separators and short fractions", () => {
    expect(parseTimestamp("01:02:03,450")).toBe(3723450);
    expect(parseTimestamp("02:03.45")).toBe(123450);
    expect(parseTimestamp("00:00:01,5")).toBe(1500);
    expect(parseTimestamp("nonsense")).toBe(-1);
  });
  it("skips broken and backwards cues, and sorts the rest", () => {
    const cues = parseSubtitles("00:00:09,000 --> 00:00:10,000\nLater\n\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n00:00:02,000 --> 00:00:03,000\nEarlier\n");
    expect(cues.map((c) => c.text)).toEqual(["Earlier", "Later"]);
  });
});

describe("finding the cue on screen", () => {
  const track = new CueTrack(parseSubtitles(SRT));
  it("shows nothing between cues", () => {
    expect(track.textAt(500)).toBe("");
    expect(track.textAt(7000)).toBe("");
  });
  it("shows the cue at a moment, end excluded", () => {
    expect(track.textAt(1000)).toBe("Hello there.");
    expect(track.textAt(3499)).toBe("Hello there.\nOverlapping & on top");
    expect(track.textAt(3500)).toBe("Overlapping & on top");
    expect(track.textAt(12000)).toBe("");
  });
  it("shifts subtitles earlier or later without reparsing", () => {
    // 1 s earlier: what was due at 1.0 s shows at 0.0 s.
    expect(track.textAt(0, -1000)).toBe("Hello there.");
    // 1 s later: at 1.5 s nothing yet, since the first cue now starts at 2.0 s.
    expect(track.textAt(1500, 1000)).toBe("");
    expect(track.textAt(2000, 1000)).toBe("Hello there.");
  });
  it("copes with an empty file", () => {
    expect(new CueTrack([]).textAt(1000)).toBe("");
  });
});
