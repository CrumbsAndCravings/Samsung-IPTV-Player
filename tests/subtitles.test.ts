import { describe, expect, it } from "vitest";
import { findQueries, FindRequest, OsCandidate } from "../src/core/opensubtitles";
import { cleanCueText } from "../src/core/srt";
import { activeSubtitle, audioPlan, delayText, freshOnline, OnlineStatus, subtitleMenu, subtitlePlan, tracksNote } from "../src/core/subtitles";
import { audioOptions, subtitleOptions } from "../src/core/tracks";

const movie: FindRequest = { kind: "movie", title: "EN - The Batman (2022)", tmdbId: "414906", season: 0, episode: 0, hash: "" };
const episode: FindRequest = { kind: "episode", title: "That '70s Show", tmdbId: "52", season: 1, episode: 2, hash: "8e245d9679d31e12" };

describe("subtitle searches", () => {
  it("tries the TMDB id, then the cleaned title and year", () => {
    expect(findQueries(movie)).toEqual(["languages=en&tmdb_id=414906&type=movie", "languages=en&query=the%20batman&type=movie&year=2022"]);
  });
  it("searches episodes by the series' id, season and number, with the file's hash", () => {
    expect(findQueries(episode)).toEqual([
      "episode_number=2&languages=en&moviehash=8e245d9679d31e12&parent_tmdb_id=52&season_number=1&type=episode",
      "episode_number=2&languages=en&moviehash=8e245d9679d31e12&query=that%20'70s%20show&season_number=1&type=episode",
    ]);
  });
  it("searches by title alone when there's no TMDB id", () => {
    expect(findQueries({ ...movie, tmdbId: "" })).toEqual(["languages=en&query=the%20batman&type=movie&year=2022"]);
  });
});

describe("embedded subtitle text", () => {
  it("drops tags, overrides and blank lines", () => {
    expect(cleanCueText("<i>Where are you?</i>\r\n{\\an8}Up here &amp; there\n\n")).toBe("Where are you?\nUp here & there");
    expect(cleanCueText("")).toBe("");
  });
});

const embedded = subtitleOptions([
  { id: "2", language: "eng", description: "" },
  { id: "3", language: "hin", description: "" },
]);
const candidate = (fileId: string, hashMatch = false): OsCandidate => ({ fileId, release: "The.Batman.1080p", hashMatch, machine: false, sdh: false, downloads: 10 });
const online = (patch: Partial<OnlineStatus>): OnlineStatus => ({ ...freshOnline(true), ...patch });
const ids = (options: { id: string }[]) => options.map((o) => o.id);

describe("the Subtitles column", () => {
  it("offers to connect OpenSubtitles when there's no account", () => {
    expect(ids(subtitleMenu(embedded, freshOnline(false)))).toEqual(["", "2", "3", "os:setup"]);
  });
  it("offers a search, then shows progress", () => {
    expect(ids(subtitleMenu(embedded, online({})))).toEqual(["", "2", "3", "os:search"]);
    expect(subtitleMenu(embedded, online({ state: "searching" }))[3].label).toBe("Searching online…");
    expect(subtitleMenu(embedded, online({ state: "downloading", candidates: [candidate("7")] })).map((o) => o.label)).toContain("Downloading subtitles…");
    expect(subtitleMenu(embedded, online({ state: "none" }))[3].label).toBe("Search online again");
  });
  it("lists the results, and timing nudges once one is on", () => {
    const results = online({ state: "results", candidates: [candidate("7", true), candidate("8")] });
    expect(ids(subtitleMenu(embedded, results))).toEqual(["", "2", "3", "os:file:7", "os:file:8"]);
    expect(subtitleMenu(embedded, results)[3].label).toBe("English · matches this file");
    expect(ids(subtitleMenu(embedded, { ...results, loadedFileId: "8" }))).toEqual(["", "2", "3", "os:file:7", "os:file:8", "os:earlier", "os:later"]);
  });
  it("marks what is showing", () => {
    const menu = subtitleMenu(embedded, online({ state: "results", candidates: [candidate("7")], loadedFileId: "7" }));
    expect(activeSubtitle(menu, { kind: "off" })).toBe(0);
    expect(activeSubtitle(menu, { kind: "embedded", id: "3" })).toBe(2);
    expect(activeSubtitle(menu, { kind: "online", fileId: "7" })).toBe(3);
  });
});

describe("the note under the columns", () => {
  it("explains each state", () => {
    expect(tracksNote(freshOnline(false), 2)).toMatch(/connect OpenSubtitles/);
    expect(tracksNote(online({ state: "none" }), 0)).toBe("OpenSubtitles has no English subtitles for this title.");
    expect(tracksNote(online({ state: "error", message: "OpenSubtitles said HTTP 406." }), 0)).toBe("OpenSubtitles said HTTP 406.");
    expect(tracksNote(online({}), 0)).toBe("This file has no subtitles of its own.");
    expect(tracksNote(online({ state: "results", candidates: [candidate("7")], remaining: 18 }), 0)).toBe(
      "“Matches this file” means timed for your exact video. Downloads left today: 18.",
    );
  });
  it("says how far the timing has moved", () => {
    expect(tracksNote(online({ state: "results", candidates: [candidate("7")], loadedFileId: "7", delayMs: -2000 }), 0)).toBe(
      "Online subtitles on. Showing them 2s earlier. If they're out of sync, nudge them earlier or later.",
    );
    expect(delayText(0)).toBe("");
    expect(delayText(1500)).toBe("Showing them 1.5s later.");
  });
});

describe("remembered choices", () => {
  it("picks the file's own track in the chosen language", () => {
    expect(subtitlePlan("hin", embedded, true)).toEqual({ kind: "embedded", id: "3" });
    expect(subtitlePlan("fre", embedded, true)).toEqual({ kind: "off" });
    expect(subtitlePlan("off", embedded, true)).toEqual({ kind: "off" });
    expect(subtitlePlan("", embedded, true)).toEqual({ kind: "off" });
  });
  it("prefers the file's own English track to a download", () => {
    expect(subtitlePlan("online", embedded, true)).toEqual({ kind: "embedded", id: "2" });
    expect(subtitlePlan("online", subtitleOptions([]), true)).toEqual({ kind: "online" });
    expect(subtitlePlan("online", subtitleOptions([]), false)).toEqual({ kind: "off" });
  });
  it("picks the audio language, or leaves the default", () => {
    const audio = audioOptions([
      { id: "0", language: "eng", description: "" },
      { id: "1", language: "hin", description: "" },
    ]);
    expect(audioPlan("hin", audio)).toBe("1");
    expect(audioPlan("", audio)).toBe("");
    expect(audioPlan("tam", audio)).toBe("");
  });
});
