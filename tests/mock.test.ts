// The fake server must look like a real provider: the parsers should handle every quirk
// it sends, the same way they handle the real one.
import { describe, expect, it } from "vitest";
import { playerApi } from "../dev/mock-xtream.mjs";
import { buildRow, parseAuth, parseCategories, parseSeriesInfo, parseVodInfo } from "../src/core/xtream";
import type { Json } from "../src/core/utils";

const call = (query: string): Json => playerApi(new URLSearchParams("username=demo&password=demo&" + query)) as Json;

describe("fake Xtream server", () => {
  it("signs in demo, refuses others, and reports an expired account", () => {
    expect(parseAuth(call("")).ok).toBe(true);
    expect(parseAuth(playerApi(new URLSearchParams("username=demo&password=nope")) as Json).ok).toBe(false);
    expect(parseAuth(playerApi(new URLSearchParams("username=expired&password=demo")) as Json)).toEqual({
      ok: false,
      error: "The server says this account is expired.",
    });
  });

  it("lists categories without the adult ones", () => {
    const movies = parseCategories(call("action=get_vod_categories"));
    const series = parseCategories(call("action=get_series_categories"));
    expect(movies.length).toBe(8);
    expect(series.length).toBe(5);
    expect(movies.every((c) => c.name.indexOf("XXX") < 0)).toBe(true);
  });

  it("builds rows newest first", () => {
    const row = buildRow(call("action=get_vod_streams&category_id=1"), "movie", "Action", 40);
    expect(row.items.length).toBeGreaterThan(20);
    expect(row.items[0].poster).toMatch(/^\/mock-art\/poster\/m\d+\.svg$/);
    const all = call("action=get_vod_streams") as unknown[];
    expect(all.length).toBeGreaterThan(200);
  });

  it("sends movie details, sometimes with info: []", () => {
    const all = call("action=get_vod_streams&category_id=2") as { stream_id: number | string }[];
    const infos = all.map((m) => parseVodInfo(call("action=get_vod_info&vod_id=" + m.stream_id)));
    expect(infos.some((i) => i.videoCodec === "")).toBe(true);
    expect(infos.some((i) => i.videoCodec === "hevc" && i.durationSecs > 0)).toBe(true);
  });

  it("sends series whose episodes parse in order, keyed or as a plain array", () => {
    const shows = call("action=get_series") as { series_id: number | string }[];
    let sawArray = false;
    for (const show of shows.slice(0, 20)) {
      const raw = call("action=get_series_info&series_id=" + show.series_id) as { episodes: unknown };
      if (Array.isArray(raw.episodes)) sawArray = true;
      const parsed = parseSeriesInfo(raw);
      expect(parsed.seasons.length).toBeGreaterThan(0);
      for (const season of parsed.seasons) {
        const numbers = season.episodes.map((e) => e.episodeNo);
        expect(numbers).toEqual(numbers.slice().sort((a, b) => a - b));
        expect(season.episodes.every((e) => !/S\d+E\d+/i.test(e.title))).toBe(true);
      }
    }
    expect(sawArray).toBe(true);
  });
});
