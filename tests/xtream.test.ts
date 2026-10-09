// Ported from the Roku app's tests/parse_test.brs (auth, categories, VOD and series info).
import { describe, expect, it } from "vitest";
import { buildRow, cleanEpisodeTitle, parseAuth, parseCategories, parseList, parseSeriesInfo, parseVodInfo } from "../src/core/xtream";

describe("auth", () => {
  it("accepts active accounts only", () => {
    expect(parseAuth({ user_info: { auth: 1, status: "Active" } }).ok).toBe(true);
    expect(parseAuth({ user_info: { auth: 0 } }).ok).toBe(false);
    expect(parseAuth({ user_info: { auth: "1", status: "Expired" } })).toEqual({ ok: false, error: "The server says this account is expired." });
    expect(parseAuth([]).ok).toBe(false);
  });
});

describe("categories", () => {
  it("drops adult and blank categories", () => {
    const cats = parseCategories([
      { category_id: "12", category_name: "EN | Action" },
      { category_id: 13, category_name: "XXX Adult" },
      { category_id: "", category_name: "Blank" },
      { category_id: 14, category_name: "Cricket" },
    ]);
    expect(cats.length).toBe(2);
    expect(cats[0].id).toBe("12");
    expect(cats[1].id).toBe("14");
  });
});

describe("VOD info", () => {
  it("reads details, including codecs", () => {
    const vod = parseVodInfo({
      info: {
        plot: "Heist.",
        releasedate: "2019-05-24",
        duration: "01:30:00",
        genre: "Thriller",
        rating: "7.04",
        backdrop_path: ["https://image.tmdb.org/t/p/w1280/h.jpg"],
        cast: "A, B",
        tmdb_id: "603",
        video: { codec_name: "h264", profile: "High", width: 1920 },
        audio: { codec_name: "aac" },
      },
      movie_data: { stream_id: 9, container_extension: "mkv" },
    });
    expect(vod.description).toBe("Heist.");
    expect(vod.year).toBe("2019");
    expect(vod.durationSecs).toBe(5400);
    expect(vod.backdrop).toBe("https://image.tmdb.org/t/p/w1280/h.jpg");
    expect(vod.ext).toBe("mkv");
    expect(vod.videoCodec).toBe("h264");
    expect(vod.tmdbId).toBe("603");
    expect(vod.starring).toBe("A, B");
    expect(vod.width).toBe(1920);
  });
  it("survives the info: [] quirk", () => {
    expect(parseVodInfo({ info: [], movie_data: [] }).description).toBe("");
  });
});

describe("series info", () => {
  const info = parseSeriesInfo({
    seasons: [
      { season_number: 1, name: "Season 1" },
      { season_number: 2, name: "The Final Season" },
    ],
    info: { name: "Breaking Bad", tmdb: 1396, plot: "Chemistry.", backdrop_path: ["https://image.tmdb.org/t/p/original/s.jpg"] },
    episodes: {
      "2": [{ id: "902", episode_num: 1, title: "Breaking Bad - S02E01 - Seven Thirty-Seven", container_extension: "mkv", info: [] }],
      "1": [
        {
          id: "802",
          episode_num: "2",
          title: "Breaking Bad - S01E02 - Cat's in the Bag",
          container_extension: "mp4",
          info: { duration_secs: 2880, movie_image: "https://image.tmdb.org/t/p/w500/e2.jpg", video: { codec_name: "hevc", profile: "Main 10" }, audio: { codec_name: "eac3" } },
        },
        { id: 801, episode_num: 1, title: "Breaking Bad - S01E01", container_extension: "mp4", info: { name: "Pilot" } },
      ],
      "0": [{ id: "700", episode_num: 1, title: "Behind the scenes" }],
    },
  });

  it("reads the show", () => {
    expect(info.info.name).toBe("Breaking Bad");
    expect(info.info.tmdbId).toBe("1396");
    expect(info.info.backdrop).toBe("https://image.tmdb.org/t/p/w1280/s.jpg");
  });
  it("orders seasons and names them", () => {
    expect(info.seasons.length).toBe(3);
    expect(info.seasons[0].title).toBe("Specials");
    expect(info.seasons[1].title).toBe("Season 1");
    expect(info.seasons[2].title).toBe("The Final Season");
    expect(info.seasons[1].seasonNo).toBe(1);
  });
  it("orders and cleans episodes", () => {
    const s1 = info.seasons[1].episodes;
    expect(s1.length).toBe(2);
    expect(s1[0].id).toBe("801");
    expect(s1[0].title).toBe("Pilot");
    expect(s1[1].title).toBe("Cat's in the Bag");
    expect(s1[1].durationSecs).toBe(2880);
    expect(s1[1].episodeNo).toBe(2);
    expect(s1[1].seasonNo).toBe(1);
    expect(s1[1].videoCodec).toBe("hevc");
    expect(s1[1].videoProfile).toBe("Main 10");
    expect(s1[1].audioCodec).toBe("eac3");
    expect(s1[0].videoCodec).toBe("");
    expect(s1[1].still).toBe("https://image.tmdb.org/t/p/w300/e2.jpg");
    expect(info.seasons[2].episodes[0].title).toBe("Seven Thirty-Seven");
  });
  it("handles episodes sent as a plain array", () => {
    const arrayInfo = parseSeriesInfo({
      info: [],
      episodes: [[{ id: 1, episode_num: 1, season: 1, title: "S01E01" }], [{ id: 2, episode_num: 1, season: 2, title: "Two" }]],
    });
    expect(arrayInfo.seasons.length).toBe(2);
    expect(arrayInfo.seasons[0].episodes[0].title).toBe("Episode 1");
    expect(arrayInfo.seasons[1].title).toBe("Season 2");
    expect(parseSeriesInfo({ episodes: [] }).seasons.length).toBe(0);
  });
  it("strips title prefixes", () => {
    expect(cleanEpisodeTitle("Show - S01E02 - Title", "Show")).toBe("Title");
    expect(cleanEpisodeTitle("s1 e3: Name", "")).toBe("Name");
  });
});

describe("lists", () => {
  it("keeps what a list needs, without adult titles", () => {
    const items = parseList(
      [
        { name: "One", stream_id: 1, container_extension: "MKV", stream_icon: "https://image.tmdb.org/t/p/original/a.jpg" },
        { name: "Adult", stream_id: 2, is_adult: "1" },
        { name: "No id" },
      ],
      "movie",
    );
    expect(items).toEqual([{ kind: "movie", id: "1", name: "One", poster: "https://image.tmdb.org/t/p/w342/a.jpg", ext: "mkv" }]);
    expect(parseList([{ name: "Show", series_id: 7, cover: "" }], "series")[0].id).toBe("7");
    expect(parseList({}, "movie")).toEqual([]);
  });
});

// Ported from the Roku app's tests/parse_test.brs (new since 0.4.1).
describe("provider quirks found later", () => {
  it("ignores a poster picture reported as the video", () => {
    const cover = parseVodInfo({ info: { video: { codec_name: "mjpeg", profile: "Baseline" }, audio: { codec_name: "aac" } }, movie_data: { container_extension: "mkv" } });
    expect(cover.videoCodec).toBe("");
    expect(cover.videoProfile).toBe("");
    expect(cover.audioCodec).toBe("aac");
  });
  it("takes provider tags and years off row titles", () => {
    const tagged = buildRow([{ name: "EN ★ Alterity - 2026", stream_id: 1, added: "5" }], "movie", "Row", 40);
    expect(tagged.items[0].title).toBe("Alterity");
    expect(tagged.items[0].year).toBe("2026");
  });
});

describe("the moving banner's pictures", () => {
  it("keeps up to five backdrops, sized, each once", async () => {
    const { backdropList } = await import("../src/core/utils");
    const { backdropPictures, makeItem } = await import("../src/core/items");
    const tmdb = (n: number) => "https://image.tmdb.org/t/p/original/b" + n + ".jpg";
    const list = backdropList([tmdb(1), tmdb(2), tmdb(1), "", tmdb(3), tmdb(4), tmdb(5), tmdb(6)], "w1280");
    expect(list.length).toBe(5);
    expect(list[0]).toBe("https://image.tmdb.org/t/p/w1280/b1.jpg");
    expect(backdropList("https://img.example/one.jpg", "w1280")).toEqual(["https://img.example/one.jpg"]);
    expect(backdropList(undefined, "w1280")).toEqual([]);
    const item = makeItem({ backdrop: list[1], backdrops: list });
    expect(backdropPictures(item)[0]).toBe(list[1]);
    expect(backdropPictures(item).length).toBe(5);
    expect(backdropPictures(makeItem({}))).toEqual([]);
  });
});
