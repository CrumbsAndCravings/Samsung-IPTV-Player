// Ported from the Roku app's tests/parse_test.brs (search index).
import { describe, expect, it } from "vitest";
import { indexAdd, indexSearch, newSearchIndex } from "../src/core/search";

function buildIndex() {
  const index = newSearchIndex();
  indexAdd(
    index,
    [
      { name: "EN - The Batman (2022)", stream_id: 1, stream_icon: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/b.jpg", container_extension: "mkv" },
      { name: "Batman Begins", stream_id: 2, stream_icon: "", container_extension: "mp4" },
      { name: "Lego Batman Movie", stream_id: 3, container_extension: "avi" },
      { name: "Superbatmania", stream_id: 4 },
      { name: "Adult Batman", stream_id: 5, is_adult: "1" },
      { name: "Batman Begins", stream_id: 2 },
    ],
    "movie",
  );
  indexAdd(index, [{ name: "Batman: The Animated Series", series_id: 77, cover: "http://x/c.jpg" }], "series");
  indexAdd(index, {}, "movie");
  return index;
}

describe("search index", () => {
  const index = buildIndex();
  it("skips adult titles and duplicates", () => {
    expect(index.names.length).toBe(5);
  });
  it("returns Movies and Series rows, best matches first", () => {
    const found = indexSearch(index, "batman", 40);
    expect(found.length).toBe(2);
    const movies = found[0];
    expect(movies.title).toBe("Movies");
    expect(movies.items.map((i) => i.title)).toEqual(["Batman Begins", "Lego Batman Movie", "EN - The Batman (2022)", "Superbatmania"]);
    expect(movies.items[0].itemId).toBe("2");
    expect(movies.items[0].poster).toBe("");
    expect(movies.items[2].poster).toBe("https://image.tmdb.org/t/p/w342/b.jpg");
    expect(movies.items[1].ext).toBe("avi");
    expect(found[1].title).toBe("Series");
    expect(found[1].items[0].kind).toBe("series");
    expect(found[1].items[0].seriesId).toBe("77");
  });
  it("needs every word, ignoring order and punctuation", () => {
    expect(indexSearch(index, "batman begins", 40)[0].items.length).toBe(1);
    expect(indexSearch(index, "begins batman", 40)[0].items.length).toBe(1);
    expect(indexSearch(index, "the-batman", 40)[0].items.length).toBe(1);
    expect(indexSearch(index, "superman", 40).length).toBe(0);
    expect(indexSearch(index, "  ", 40).length).toBe(0);
    expect(indexSearch(index, "bat", 2)[0].items.length).toBe(2);
  });
});

describe("the whole-library answer", () => {
  it("keeps only titles from categories the app shows", () => {
    const index = newSearchIndex();
    indexAdd(
      index,
      [
        { series_id: "1", name: "Kept Show", category_id: "10" },
        { series_id: "2", name: "Hidden Show", category_id: "99" },
      ],
      "series",
      { "10": true },
    );
    expect(index.names).toEqual([" kept show"]);
  });
});

describe("short queries on a big library", () => {
  it("still find series when thousands of movies match first", () => {
    const index = newSearchIndex();
    const movies = [];
    for (let i = 0; i < 2500; i++) movies.push({ stream_id: i, name: "Summer " + i });
    indexAdd(index, movies, "movie");
    indexAdd(index, [{ series_id: 1, name: "Summer Heights" }], "series");
    const rows = indexSearch(index, "s", 40);
    expect(rows.map((r) => r.title)).toEqual(["Movies", "Series"]);
    expect(rows[1].items[0].title).toBe("Summer Heights");
  });
});
