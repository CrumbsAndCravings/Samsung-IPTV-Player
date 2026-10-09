// Ported from the Roku app's tests/parse_test.brs: the watch history, ratings, likings,
// the picks from the stored library, and My List (docs/features.md §5.1.1, §5.1.2).
import { beforeEach, describe, expect, it } from "vitest";
import { Item, makeItem } from "../src/core/items";
import { listItem, myListToggle, myListWith, titleKey } from "../src/core/mylist";
import { categoriesFrom, indexAdd, indexFind, indexPersonal, indexSetCategories, listItems, newSearchIndex, titleStem } from "../src/core/search";
import { MemoryStore, useStore } from "../src/core/storage";
import { likingFrom, ratingLabel, savedPicks, savePicks, TASTE_MAX, tasteBecause, TasteEntry, tasteHistory, tasteOrder, tasteRated, tasteWeightFor, tasteWith } from "../src/core/taste";
import { normalizeSearch } from "../src/core/utils";

const now = 1790000000;
const titles = (items: Item[]) => items.map((i) => i.title).join(", ");

describe("the watch history", () => {
  it("weighs a movie by how far you got", () => {
    expect(tasteWeightFor(100, 6000)).toBe(0);
    expect(tasteWeightFor(200, 6000)).toBe(1);
    expect(tasteWeightFor(3000, 6000)).toBe(2);
  });

  it("keeps titles newest first, names short, and at most 30", () => {
    let list = tasteWith([], "m:1", "Carry On Jatta 3 And A Very Long Name Indeed", 1, "atLeast", now)!;
    expect(list.length).toBe(1);
    expect(list[0].n.length).toBe(32);
    expect(tasteWith(list, "m:1", "", 1, "atLeast", now)).toBeNull();
    list = tasteWith(list, "m:2", "Jawan", 2, "atLeast", now + 10)!;
    expect(list[0].k + " " + list[1].k).toBe("m:2 m:1");
    list = tasteWith(list, "m:1", "", 3, "atLeast", now + 20)!;
    expect(list[0].k + " " + list[0].n).toBe("m:1 Carry On Jatta 3 And A Very Long");
    let series: TasteEntry[] | null = tasteWith([], "s:9", "Panchayat", 0.5, "add", now)!;
    series = tasteWith(series, "s:9", "Panchayat", 0.5, "add", now)!;
    expect(series[0].w).toBe(1.5);
    for (let i = 0; i < 6 && series; i++) series = tasteWith(series, "s:9", "Panchayat", 0.5, "add", now);
    expect(series).toBeNull();
    expect(tasteWith(list, "m:2", "", -1, "set", now)![0].w).toBe(-1);
    let grown: TasteEntry[] = [];
    for (let i = 0; i < 40; i++) grown = tasteWith(grown, "m:" + i, "T", 1, "atLeast", now + i)!;
    expect(grown.length).toBe(TASTE_MAX);
  });

  it("puts the categories you like after the first rows", () => {
    const plan = [
      { kind: "movie" as const, categoryId: "1" },
      { kind: "movie" as const, categoryId: "2" },
      { kind: "series" as const, categoryId: "3" },
      { kind: "movie" as const, categoryId: "4" },
      { kind: "movie" as const, categoryId: "5" },
    ];
    expect(tasteOrder(plan, { "vod:4": 2.5, "series:3": 1, "vod:1": 9 }, 1).map((e) => e.categoryId).join(",")).toBe("1,4,3,2,5");
    expect(tasteOrder(plan, {}, 2).length).toBe(5);
  });

  it("turns into a liking for each category, halving every 30 days", () => {
    const history = [
      { k: "m:1", n: "Old", w: 3, t: now - 30 * 86400 },
      { k: "m:2", n: "New", w: 2, t: now },
      { k: "m:3", n: "Gone", w: -1, t: now },
    ];
    const watching = [
      { k: "s:5", at: now, pos: 100, dur: 1000 },
      { k: "m:2", at: now, pos: 10, dur: 100 },
    ];
    const liking = likingFrom(history, watching, { "m:1": "vod:7", "m:2": "vod:7", "m:3": "vod:8", "s:5": "series:4" }, now);
    expect(liking["vod:7"]).toBe(3.5);
    expect(liking["vod:8"]).toBe(-1);
    expect(liking["series:4"]).toBe(1);
  });

  it("picks what to build Because you watched on", () => {
    const at = { t: now };
    expect(tasteBecause([{ k: "m:1", n: "A", w: 1, ...at }, { k: "m:2", n: "B", w: 2, ...at }, { k: "m:3", n: "C", w: 3, ...at }], 2).map((b) => b.n).join("")).toBe("BC");
    expect(tasteBecause([{ k: "m:1", n: "A", w: 1, ...at }], 2)[0].n).toBe("A");
    expect(tasteBecause([{ k: "m:1", n: "A", w: -1, ...at }], 2).length).toBe(0);
  });
});

describe("ratings", () => {
  it("live on the history entry and count for more than watching", () => {
    const rated = tasteRated([{ k: "m:1", n: "Jawan", w: 2, t: now }], "m:1", "", 2, now + 5)!;
    expect(rated[0].n + " " + rated[0].w + " " + rated[0].r).toBe("Jawan 2 2");
    expect(tasteRated(rated, "m:1", "", 2, now)).toBeNull();
    expect(tasteRated(rated, "m:1", "", 0, now)![0].r).toBeUndefined();
    expect(tasteRated([], "m:9", "X", 0, now)).toBeNull();
    const fresh = tasteRated([], "m:9", "Pathaan", 1, now)!;
    expect(fresh[0].k + " " + fresh[0].r).toBe("m:9 1");
    expect(tasteWith(fresh, "m:9", "Pathaan", 2, "atLeast", now)![0].r).toBe(1);
    let full: TasteEntry[] = [{ k: "m:0", n: "Loved", w: 0, r: 2, t: now }];
    for (let i = 1; i <= TASTE_MAX + 5; i++) full = tasteWith(full, "m:" + (100 + i), "T", 1, "atLeast", now + i)!;
    expect(full.some((e) => e.k === "m:0") && full.length === TASTE_MAX).toBe(true);
    const liking = likingFrom(
      [
        { k: "m:1", n: "", w: 3, r: -1, t: now },
        { k: "m:2", n: "", w: 0, r: 2, t: now },
        { k: "m:3", n: "", w: 1, r: 1, t: now },
      ],
      [],
      { "m:1": "vod:1", "m:2": "vod:2", "m:3": "vod:3" },
      now,
    );
    expect([liking["vod:1"], liking["vod:2"], liking["vod:3"]]).toEqual([-3, 4, 2.5]);
    const because = tasteBecause(
      [
        { k: "m:1", n: "Watched", w: 3, t: now },
        { k: "m:2", n: "Hated", w: 3, r: -1, t: now },
        { k: "m:3", n: "Loved", w: 0, r: 2, t: now },
      ],
      2,
    );
    expect(because.map((b) => b.n).join(",")).toBe("Loved,Watched");
    expect([ratingLabel(-1), ratingLabel(2), ratingLabel(0)].join("|")).toBe("Not for me|Love this!|Rate");
  });
});

describe("picked for you, from the stored library", () => {
  const lib = newSearchIndex();
  indexSetCategories(lib, "movie", [{ id: "7", name: "PUNJABI MOVIES" }, { id: "8", name: "EN | ACTION" }], 2026);
  indexAdd(
    lib,
    [
      { name: "Carry On Jatta", stream_id: 1, category_id: "7", added: now - 400 * 86400 },
      { name: "Carry On Jatta 2", stream_id: 2, category_id: "7", added: now - 200 * 86400 },
      { name: "Carry On Jatta 3", stream_id: 3, category_id: "8", added: now - 10 * 86400 },
      { name: "Jatt & Juliet", stream_id: 4, category_id: "7", added: now - 5 * 86400 },
      { name: "Die Hard", stream_id: 5, category_id: "8", added: now },
      { name: "Carry On Jatta 2", stream_id: 6, category_id: "8", added: now },
    ],
    "movie",
  );
  indexAdd(lib, [{ name: "Panchayat", series_id: 1, category_id: "7" }], "series");

  it("finds the titles named and their categories", () => {
    const found = indexFind(lib, ["m:1", "m:5", "s:1", "m:99"]);
    const cats = categoriesFrom(found);
    expect([cats["m:1"], cats["m:5"], cats["s:1"], found["m:99"]]).toEqual(["vod:7", "vod:8", "series:7", undefined]);
  });

  it("picks liked and new titles, and the rest of a series of films", () => {
    const exclude: { [key: string]: boolean } = { "m:1": true };
    exclude[" " + normalizeSearch("Carry On Jatta")] = true;
    const personal = indexPersonal(lib, { "vod:7": 3, "vod:8": 0.5 }, exclude, [{ k: "m:1", n: "Carry On Jatta", category: "vod:7" }], now, 2026);
    expect(titles(personal.picks)).toBe("Jatt & Juliet, Carry On Jatta 2, Die Hard, Carry On Jatta 3");
    expect(titles(personal.because[0])).toBe("Carry On Jatta 2, Carry On Jatta 3, Jatt & Juliet");
    const nothing = indexPersonal(lib, {}, {}, [], now, 2026);
    expect(nothing.picks.length + nothing.because.length).toBe(0);
    expect([titleStem("The Carry On Jatta"), titleStem("Jawan"), titleStem("Up")].join("|")).toBe(" carry on| jawan|");
  });

  it("lists My List from the library, or as name cards", () => {
    const saved = [
      { k: "m:4", n: "Jatt & Juliet", t: 0 },
      { k: "m:77", n: "Not Here", x: "avi", t: 0 },
      { k: "s:1", n: "Panchayat", t: 0 },
    ];
    const items = listItems(saved, indexFind(lib, ["m:4", "m:77", "s:1"]), (entry) => listItem(entry as (typeof saved)[0], ""));
    expect(items[0].title + ", " + items[1].title + " " + items[1].ext + ", " + items[2].kind).toBe("Jatt & Juliet, Not Here avi, series");
  });
});

describe("the rows picked last time", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("come back as they were, for the next launch", () => {
    expect(savedPicks()).toEqual([]);
    savePicks([
      { slot: "picks", title: "Top picks for you", items: [makeItem({ kind: "movie", itemId: "4", title: "Jatt & Juliet", poster: "http://img/4.jpg", ext: "mkv", year: "2012" }), makeItem({ kind: "series", itemId: "1", seriesId: "1", title: "Panchayat" })] },
      { slot: "s:1", title: "Because you watched Panchayat", items: [] },
    ]);
    const back = savedPicks();
    expect(back.map((r) => r.slot + " " + r.title + " " + r.items.length)).toEqual(["picks Top picks for you 2", "s:1 Because you watched Panchayat 0"]);
    const [movie, series] = back[0].items;
    expect([movie.kind, movie.itemId, movie.title, movie.poster, movie.ext, movie.year].join("|")).toBe("movie|4|Jatt & Juliet|http://img/4.jpg|mkv|2012");
    expect([series.kind, series.itemId, series.seriesId, series.title].join("|")).toBe("series|1|1|Panchayat");
  });
});

describe("My List", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("keeps titles newest first, once each", () => {
    let saved = myListWith([], "m:1", "Jawan", "mkv", true, now);
    saved = myListWith(saved, "s:7", "Panchayat", "", true, now + 1);
    expect(saved[0].k + " " + saved[1].k + " " + saved[1].x).toBe("s:7 m:1 mkv");
    saved = myListWith(saved, "m:1", "Jawan", "mkv", true, now + 2);
    expect(saved.length).toBe(2);
    expect(saved[0].k).toBe("m:1");
    saved = myListWith(saved, "m:1", "", "", false, now);
    expect(saved.length + " " + saved[0].k).toBe("1 s:7");
  });

  it("makes name cards, and adding counts towards what you like", () => {
    const card = listItem({ k: "s:1", n: "Panchayat", t: 0 }, "");
    expect(card.kind + " " + card.seriesId + " " + titleKey(card)).toBe("series 1 s:1");
    expect(titleKey(listItem({ k: "m:5", n: "Die Hard", x: "mp4", t: 0 }, "http://p/5.jpg"))).toBe("m:5");
    expect(titleKey(null)).toBe("");
    expect(myListToggle("m:5", "Die Hard", "mp4")).toBe(true);
    expect(tasteHistory()[0].k).toBe("m:5");
    expect(myListToggle("m:5", "Die Hard", "mp4")).toBe(false);
  });
});
