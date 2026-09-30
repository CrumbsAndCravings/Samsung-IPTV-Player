// The setup checks' pure parts: which slot a file fills, title matching, the report.
import { describe, expect, it } from "vitest";
import type { ListItem } from "../src/core/xtream";
import { matchTitles } from "../src/probe/library";
import { PlayResult, ProbeState, reportLines, reportText } from "../src/probe/report";
import { infoQueue, Sample, slotsFor } from "../src/probe/samples";

function sample(ext: string, video: string, audio: string): Sample {
  return { key: "m:1", kind: "movie", id: "1", title: "T", ext, poster: "", videoCodec: video, videoProfile: "", audioCodec: audio, width: 0 };
}

describe("slots", () => {
  it("matches the files the plan asks for", () => {
    expect(slotsFor(sample("mkv", "hevc", "eac3"))).toEqual(["hevc-mkv"]);
    expect(slotsFor(sample("avi", "mpeg4", "mp3"))).toEqual(["avi"]);
    expect(slotsFor(sample("mp4", "h264", "aac"))).toEqual(["h264-mp4"]);
    expect(slotsFor(sample("mkv", "h264", "dts"))).toEqual(["dts"]);
    expect(slotsFor(sample("MKV", "HEVC", "DTS"))).toEqual(["hevc-mkv", "dts"]);
  });
  it("lets an MP4 of unknown codec stand in only when not strict", () => {
    expect(slotsFor(sample("mp4", "", ""))).toEqual([]);
    expect(slotsFor(sample("mp4", "", ""), false)).toEqual(["h264-mp4"]);
  });
  it("checks rare containers first", () => {
    const item = (id: string, ext: string): ListItem => ({ kind: "movie", id, name: id, poster: "", ext });
    const queue = infoQueue([item("1", "mkv"), item("2", "mp4"), item("3", "avi"), item("4", "ts"), item("5", "mkv")]);
    expect(queue.map((i) => i.id)).toEqual(["3", "2", "4", "1", "5"]);
  });
});

describe("title matching (as Roku's search)", () => {
  const item = (id: string, name: string): ListItem => ({ kind: "movie", id, name, poster: "", ext: "" });
  const items = [item("1", "EN - The Batman (2022)"), item("2", "Batman Begins"), item("3", "Lego Batman Movie"), item("4", "Superbatmania")];
  it("ranks starts, then word starts, then the rest", () => {
    expect(matchTitles(items, "batman", 40).map((i) => i.name)).toEqual(["Batman Begins", "Lego Batman Movie", "EN - The Batman (2022)", "Superbatmania"]);
  });
  it("needs every word, in any order", () => {
    expect(matchTitles(items, "begins batman", 40).length).toBe(1);
    expect(matchTitles(items, "the-batman", 40).length).toBe(1);
    expect(matchTitles(items, "superman", 40).length).toBe(0);
    expect(matchTitles(items, "  ", 40).length).toBe(0);
    expect(matchTitles(items, "bat", 2).length).toBe(2);
  });
});

function play(outcome: PlayResult["outcome"], slots: PlayResult["slots"], error = ""): PlayResult {
  return {
    key: "m:1",
    title: "Title",
    ext: "mkv",
    videoCodec: "hevc",
    videoProfile: "Main 10",
    audioCodec: "eac3",
    width: 3840,
    slots,
    outcome,
    error,
    startMs: outcome === "played" ? 2100 : 0,
    seek: outcome === "played" ? "ok" : "",
    tracks: "V: HEVC 3840x2160 · A: eng EAC3 6ch · T: none",
    player: "avplay",
    at: 1,
  };
}

const empty: ProbeState = { device: null, xtream: null, range: null, echo: null, os: null, samples: null, library: [], plays: [] };

describe("report", () => {
  it("lists every check as not done yet at first", () => {
    const lines = reportLines(empty);
    expect(lines.map((l) => l.label)).toEqual(["IPTV server", "Range requests", "Headers", "OpenSubtitles", "HEVC in MKV", "AVI (DivX/Xvid)", "H.264 in MP4", "DTS audio"]);
    expect(lines.every((l) => l.outcome === "todo")).toBe(true);
  });
  it("prefers a file that played over a newer failure", () => {
    const state = { ...empty, plays: [play("failed", ["hevc-mkv"], "PLAYER_ERROR_NOT_SUPPORTED_FILE"), play("played", ["hevc-mkv"])] };
    const hevc = reportLines(state).filter((l) => l.label === "HEVC in MKV")[0];
    expect(hevc.outcome).toBe("ok");
    expect(hevc.text).toBe("Played (started in 2.1 s), seeking works");
  });
  it("shows the player's error name for failures", () => {
    const avi = reportLines({ ...empty, plays: [play("failed", ["avi"], "PLAYER_ERROR_NOT_SUPPORTED_FILE")] }).filter((l) => l.label === "AVI (DivX/Xvid)")[0];
    expect(avi).toEqual({ outcome: "fail", label: "AVI (DivX/Xvid)", text: "Didn't play: PLAYER_ERROR_NOT_SUPPORTED_FILE" });
  });
  it("writes a compact text report", () => {
    const text = reportText({ ...empty, plays: [play("played", ["hevc-mkv"])] }, "0.1.0");
    expect(text.split("\n")[0]).toBe("ARAN+ 0.1.0 setup report");
    expect(text).toContain("play hevc-mkv: played 2100ms seek ok | Title | mkv/hevc/Main 10/eac3 w3840 | V: HEVC 3840x2160");
  });
});
