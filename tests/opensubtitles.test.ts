import { describe, expect, it } from "vitest";
import {
  APP_USER_AGENT,
  cleanTitleForSearch,
  osBase,
  osErrorText,
  osQuery,
  parseContentRangeTotal,
  parseOsResults,
  serverMessage,
  subtitleLabel,
} from "../src/core/opensubtitles";

describe("OpenSubtitles helpers", () => {
  it("names the app in the user agent", () => {
    expect(APP_USER_AGENT).toMatch(/^ARANplus v/);
  });
  it("uses the server login hands back", () => {
    expect(osBase("")).toBe("https://api.opensubtitles.com/api/v1");
    expect(osBase("vip-api.opensubtitles.com")).toBe("https://vip-api.opensubtitles.com/api/v1");
    expect(osBase("https://vip-api.opensubtitles.com/")).toBe("https://vip-api.opensubtitles.com/api/v1");
  });
  it("quotes OpenSubtitles' own words", () => {
    expect(serverMessage({ message: "Invalid API key" })).toBe("Invalid API key");
    expect(serverMessage({ errors: ["one", "", "two"] })).toBe("one two");
    expect(osErrorText(401, { message: "invalid username/password" })).toBe("OpenSubtitles said HTTP 401: invalid username/password.");
    expect(osErrorText(406, {})).toBe("OpenSubtitles said HTTP 406. Downloads reset within a day.");
    expect(osErrorText(0, undefined)).toBe("Couldn't reach OpenSubtitles. Check the TV's internet connection.");
  });
  it("reads the file size from Content-Range", () => {
    expect(parseContentRangeTotal("bytes 0-65535/1234567890")).toBe(1234567890);
    expect(parseContentRangeTotal("bytes 0-65535/*")).toBe(-1);
    expect(parseContentRangeTotal("")).toBe(-1);
    expect(parseContentRangeTotal("bytes 0-1/6148914691236517")).toBe(6148914691236517);
  });
});

// Ported from the Roku app's tests/utils_test.brs (title cleanup, queries, ranking).

describe("title cleanup for text searches", () => {
  it("drops tags and years", () => {
    const cleaned = cleanTitleForSearch("EN - The Batman (2022)");
    expect(cleaned.query).toBe("The Batman");
    expect(cleaned.year).toBe("2022");
    expect(cleanTitleForSearch("|EN| Supernatural").query).toBe("Supernatural");
    expect(cleanTitleForSearch("[4K] Dune: Part Two [MULTI-SUB]").query).toBe("Dune: Part Two");
  });
  it("keeps real titles intact", () => {
    expect(cleanTitleForSearch("Spider-Man: No Way Home (2021)").query).toBe("Spider-Man: No Way Home");
    expect(cleanTitleForSearch("1917").query).toBe("1917");
    expect(cleanTitleForSearch("CSI: Miami").query).toBe("CSI: Miami");
  });
});

describe("OpenSubtitles queries", () => {
  it("sorts keys and lowercases values", () => {
    expect(osQuery({ type: "episode", languages: "en", parent_tmdb_id: 1622, season_number: 1, episode_number: 2, moviehash: "ABCDEF0123456789" })).toBe(
      "episode_number=2&languages=en&moviehash=abcdef0123456789&parent_tmdb_id=1622&season_number=1&type=episode",
    );
    expect(osQuery({ query: "That '70s Show", type: "movie" })).toBe("query=that%20'70s%20show&type=movie");
  });
});

describe("picking the best subtitles", () => {
  const result = (fileId: number, release: string, downloads: number, hashMatch: boolean, machine: boolean, sdh: boolean) => ({
    attributes: { release, download_count: downloads, moviehash_match: hashMatch, machine_translated: machine, hearing_impaired: sdh, files: [{ file_id: fileId }] },
  });
  const results = parseOsResults({
    data: [
      result(11, "Popular.Release", 5000, false, false, false),
      result(12, "Exact.Match", 10, true, false, false),
      result(13, "Machine", 90000, false, true, false),
      result(14, "SDH.Release", 6000, false, false, true),
      result(11, "Duplicate", 1, false, false, false),
    ],
  });
  it("ranks exact file, then human, then non-SDH, then downloads", () => {
    expect(results.length).toBe(4);
    expect(results.map((r) => r.fileId)).toEqual(["12", "11", "14", "13"]);
  });
  it("labels candidates", () => {
    expect(subtitleLabel(results[0])).toBe("English · matches this file");
    expect(subtitleLabel(results[2])).toBe("English · SDH.Release · SDH");
    expect(subtitleLabel(results[3])).toBe("English · Machine · auto-translated");
  });
  it("survives empty and bad answers", () => {
    expect(parseOsResults({ data: [] }).length).toBe(0);
    expect(parseOsResults(undefined).length).toBe(0);
  });
});
