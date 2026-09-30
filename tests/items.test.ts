// Ported from the Roku app's tests/parse_test.brs (rows, MetaLine, ApplyInfo). Image
// sizes differ on purpose: w342 posters and w1280 backdrops for 1080p (Roku: w185, w780).
import { describe, expect, it } from "vitest";
import { applyInfo, makeItem, metaLine } from "../src/core/items";
import { buildRow, parseVodInfo } from "../src/core/xtream";

const streams = [
  { name: "Older", stream_id: 101, stream_icon: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/old.jpg", added: "1690000000", container_extension: "mkv", rating: "6.1" },
  { name: "Newest", stream_id: 102, stream_icon: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/new.jpg", added: "1700000000", container_extension: "mp4", rating: 7.4 },
  { name: "Adult", stream_id: 103, added: "1710000000", is_adult: "1" },
  { name: "Oldest", stream_id: 104, added: "1680000000", container_extension: "avi" },
];

describe("movie rows", () => {
  const row = buildRow(streams, "movie", "Action", 2);
  const first = row.items[0];
  it("keeps the newest titles, without adult ones", () => {
    expect(row.title).toBe("Action");
    expect(row.items.length).toBe(2);
    expect(first.title).toBe("Newest");
    expect(row.items[1].title).toBe("Older");
    expect(buildRow(streams, "movie", "Action", 10).items.map((i) => i.title)).toEqual(["Newest", "Older", "Oldest"]);
  });
  it("reads each movie", () => {
    expect(first.itemId).toBe("102");
    expect(first.kind).toBe("movie");
    expect(first.ext).toBe("mp4");
    expect(first.score).toBe("7.4");
    expect(first.poster).toBe("https://image.tmdb.org/t/p/w342/new.jpg");
    expect(first.placeholder).toBe(false);
  });
  it("survives a non-list answer", () => {
    expect(buildRow({}, "movie", "Empty", 40).items).toEqual([]);
  });
});

describe("series rows", () => {
  const shows = [
    {
      name: "Breaking Bad",
      series_id: 55,
      cover: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/bb.jpg",
      plot: "A teacher turns.",
      releaseDate: "2008-01-20",
      genre: "Drama, Crime",
      rating: "9.5",
      backdrop_path: ["https://image.tmdb.org/t/p/w1280/bd.jpg"],
      last_modified: "1600000000",
    },
  ];
  const show = buildRow(shows, "series", "Drama", 40).items[0];
  it("reads each show", () => {
    expect(show.kind).toBe("series");
    expect(show.itemId).toBe("55");
    expect(show.seriesId).toBe("55");
    expect(show.backdrop).toBe("https://image.tmdb.org/t/p/w1280/bd.jpg");
    expect(show.year).toBe("2008");
    expect(show.hasInfo).toBe(true);
  });
  it("writes the meta line", () => {
    expect(metaLine(show)).toBe("2008   ·   Drama, Crime   ·   Rated 9.5");
  });
});

describe("details", () => {
  it("applies get_vod_info to an item", () => {
    const vod = parseVodInfo({
      info: {
        plot: "Heist.",
        releasedate: "2019-05-24",
        duration: "01:30:00",
        genre: "Thriller",
        rating: "7.04",
        cast: "A, B",
        video: { codec_name: "h264", profile: "High" },
        audio: { codec_name: "aac" },
      },
      movie_data: { container_extension: "mkv" },
    });
    const item = makeItem({ title: "Heist", kind: "movie" });
    applyInfo(item, vod);
    expect(metaLine(item)).toBe("2019   ·   1h 30m   ·   Thriller   ·   Rated 7.0");
    expect(item.hasInfo).toBe(true);
    expect(item.videoCodec).toBe("h264");
    expect(item.starring).toBe("A, B");
  });
  it("doesn't blank what the list already had", () => {
    const item = makeItem({ genre: "Drama", ext: "mp4" });
    applyInfo(item, { genre: "", ext: "", durationSecs: 0 });
    expect(item.genre).toBe("Drama");
    expect(item.ext).toBe("mp4");
  });
});
