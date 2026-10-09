// Ported from the Roku app's tests/parse_test.brs (search index).
import { describe, expect, it } from "vitest";
import { indexAdd, indexBrowse, indexSearch, indexSetCategories, newSearchIndex, parseIndex, serializeIndex } from "../src/core/search";

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

// Ported from the Roku app's tests/parse_test.brs (new since 0.4.1).
describe("the library index", () => {
  const titles = (rows: { title: string; items: { title: string }[] }[], row: number) => rows[row].items.map((i) => i.title);

  it("leaves out hidden categories but keeps titles that don't say", () => {
    const whole = newSearchIndex();
    indexAdd(whole, [{ name: "Kept Show", series_id: 1, category_id: "10" }, { name: "Hidden Show", series_id: 2, category_id: "99" }, { name: "Loose Show", series_id: 3 }], "series", { "10": true });
    expect(whole.names.length).toBe(2);
    expect(indexSearch(whole, "hidden", 40).length).toBe(0);
    expect(indexSearch(whole, "show", 40)[0].items.length).toBe(2);
  });

  it("matches one or two letters at word starts only", () => {
    const short = newSearchIndex();
    indexAdd(short, [{ name: "The Show", series_id: 1 }, { name: "Other Life", series_id: 2 }, { name: "Big Thing", series_id: 3 }], "series");
    expect(indexSearch(short, "th", 40)[0].items.length).toBe(2);
    expect(indexSearch(short, "th", 40)[0].items[0].title).toBe("The Show");
    expect(indexSearch(short, "the", 40)[0].items.length).toBe(2);
  });

  it("is saved for one login and loads again", () => {
    const short = newSearchIndex();
    indexAdd(short, [{ name: "The Show", series_id: 1 }, { name: "Other Life", series_id: 2 }, { name: "Big Thing", series_id: 3 }], "series");
    const text = serializeIndex(short, "http://a.b jane", 1000);
    const back = parseIndex(text, "http://a.b jane", 2026);
    expect(back && back.names.length).toBe(3);
    expect(back && back.savedAt).toBe(1000);
    expect(back && indexSearch(back, "big", 40)[0].items[0].title).toBe("Big Thing");
    expect(parseIndex(text, "http://a.b joe", 2026)).toBeNull();
    // The provider moved: the same username's library still counts.
    expect(parseIndex(text, "http://new.b jane", 2026)).not.toBeNull();
    expect(parseIndex("", "http://a.b jane", 2026)).toBeNull();
  });

  it("takes provider tags and years off titles", () => {
    const plain = newSearchIndex();
    indexAdd(plain, [{ name: "EN ★ Alterity - 2026", stream_id: 1 }], "movie");
    const found = indexSearch(plain, "alterity", 40)[0].items[0];
    expect(found.title).toBe("Alterity");
    expect(found.year).toBe("2026");
  });

  it("counts, offers and browses categories", () => {
    const lib = newSearchIndex();
    indexSetCategories(lib, "movie", [{ id: "7", name: "PUNJABI MOVIES" }, { id: "8", name: "EN | ACTION" }], 2026);
    indexSetCategories(lib, "series", [{ id: "9", name: "PUNJABI SERIES" }], 2026);
    indexAdd(lib, [{ name: "Carry On Jatta", stream_id: 1, category_id: "7", added: "1700000000" }, { name: "Jatt & Juliet", stream_id: 2, category_id: "7", added: "1800000000" }, { name: "Mad Max", stream_id: 3, category_id: "8", added: "1750000000" }], "movie");
    indexAdd(lib, [{ name: "Some Show", series_id: 4, last_modified: "1600000000" }], "series", undefined, "9");
    const found = indexSearch(lib, "punjabi", 40);
    expect(found.length).toBe(1);
    expect(found[0].title).toBe("Categories");
    expect(found[0].items.map((i) => [i.title, i.caption, i.listKind])).toEqual([
      ["Punjabi", "Movies · 2", "movie"],
      ["Punjabi", "Series · 1", "series"],
    ]);
    const browsed = indexBrowse(lib, "movie", "7", 1000);
    expect(browsed.items.map((i) => i.title)).toEqual(["Jatt & Juliet", "Carry On Jatta"]);
    expect(browsed.total).toBe(2);
    expect(indexBrowse(lib, "series", "9", 1000).items[0].title).toBe("Some Show");
    expect(indexBrowse(lib, "movie", "7", 1).items.length).toBe(1);
    expect(indexBrowse(lib, "movie", "7", 1).total).toBe(2);
    const within = indexBrowse(lib, "movie", "7", 1000, "jatt");
    expect(within.total).toBe(2);
    expect(within.items[0].title).toBe("Jatt & Juliet");
    expect(indexBrowse(lib, "movie", "7", 1000, "juliet").total).toBe(1);
    expect(indexBrowse(lib, "movie", "7", 1000, "zz").total).toBe(0);
    expect(indexBrowse(lib, "movie", "7", 1000, "ca").total).toBe(1);
    expect(indexBrowse(lib, "movie", "8", 1000, "jatt").total).toBe(0);
    const again = parseIndex(serializeIndex(lib, "owner", 5), "owner", 2026);
    expect(again && again.categories.length).toBe(3);
    expect(again && indexBrowse(again, "movie", "7", 10).items[0].title).toBe("Jatt & Juliet");
    expect(again && indexSearch(again, "punjabi", 40)[0].items.length).toBe(2);
  });

  it("ranks every match: thousands of movies can't crowd out the series", () => {
    const big = newSearchIndex();
    const films = [];
    for (let n = 1; n <= 2500; n++) films.push({ name: "The Long Movie Number " + n, stream_id: n });
    indexAdd(big, films, "movie");
    indexAdd(big, [{ name: "The Show", series_id: 1 }, { name: "The Other Show", series_id: 2 }], "series");
    indexAdd(big, [{ name: "The", stream_id: 9999 }], "movie");
    const crowd = indexSearch(big, "the", 40);
    expect(crowd.length).toBe(2);
    expect(crowd[1].title).toBe("Series");
    expect(titles(crowd, 1)).toEqual(["The Show", "The Other Show"]);
    expect(crowd[0].items[0].title).toBe("The");
    expect(crowd[0].items.length).toBe(40);
    expect(crowd[0].items[1].title).toBe("The Long Movie Number 1");
  });
});
