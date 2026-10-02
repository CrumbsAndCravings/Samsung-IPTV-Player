// The stored library (docs/features.md §6.2, §6.3): what's asked for, in what order,
// what's saved, and the background refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonal } from "../src/core/personal";
import { MemoryStore, useStore } from "../src/core/storage";
import { LibrarySource, SearchLibrary } from "../src/data/library";
import { MemoryTextStore } from "../src/platform/files";

// Tests run in Node, which has no window; the library's timers live on it.
// eslint-disable-next-line no-restricted-globals
(globalThis as unknown as { window: unknown }).window = globalThis;

const creds = { server: "http://host.example", username: "jane", password: "pw" };
const seriesCats = [
  { id: "10", name: "EN | DRAMA" },
  { id: "11", name: "AR | DRAMA" },
];
const movieCats = [
  { id: "1", name: "EN | ACTION" },
  { id: "2", name: "FR | ACTION" },
  { id: "3", name: "PUNJABI MOVIES" },
];
const movies: { [id: string]: unknown[] } = {
  "1": [{ stream_id: 101, name: "EN ★ Alterity - 2026", category_id: "1", added: "200" }],
  "3": [{ stream_id: 301, name: "Jatt Brothers", category_id: "3", added: "100" }],
};
const allSeries = [
  { series_id: 501, name: "The Office", category_id: "10", last_modified: "50" },
  { series_id: 502, name: "Arabic Show", category_id: "11", last_modified: "60" },
];

class FakeSource implements LibrarySource {
  creds = creds;
  onList: LibrarySource["onList"] = null;
  asked: string[] = [];
  failing: { [key: string]: boolean } = {};
  categories(kind: "movie" | "series") {
    return Promise.resolve(kind === "series" ? seriesCats : movieCats);
  }
  list(kind: "movie" | "series", categoryId: string) {
    const key = kind + ":" + (categoryId || "all");
    this.asked.push(key);
    if (this.failing[key] || this.failing["*"]) return Promise.reject(new Error("HTTP 503"));
    if (kind === "series") return Promise.resolve(categoryId ? allSeries.filter((s) => s.category_id === categoryId) : allSeries);
    return Promise.resolve(movies[categoryId] || []);
  }
}

// Lets promises and paced timers run until the library settles.
async function settle(seconds = 30): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    await vi.advanceTimersByTimeAsync(250);
  }
}

describe("the stored library", () => {
  let store: MemoryTextStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    useStore(new MemoryStore());
    usePersonal({ languages: ["en", "hi", "pa"] });
    store = new MemoryTextStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    usePersonal(null);
  });

  it("loads only wanted languages, series in one request, then saves", async () => {
    const source = new FakeSource();
    const library = new SearchLibrary(source, store);
    library.start();
    await settle();
    expect(source.asked).toEqual(["series:all", "movie:1", "movie:3"]);
    expect(library.loading).toBe(false);
    expect(library.status).toMatchObject({ done: 3, total: 3, titles: 3, stopped: false });
    expect(library.search("office", 40)[0].items[0].title).toBe("The Office");
    expect(library.search("arabic", 40).length).toBe(0);
    expect(library.search("alterity", 40)[0].items[0].year).toBe("2026");
    expect(library.counts()["movie:3"]).toBe(1);
    expect(library.browse("movie", "1", 1000).total).toBe(1);
    expect(store.data["search-library"].indexOf("aranplus-search-4\thttp://host.example jane\t")).toBe(0);
  });

  it("searches a saved copy at once, and leaves a fresh one alone", async () => {
    await (async () => {
      const library = new SearchLibrary(new FakeSource(), store);
      library.start();
      await settle();
    })();
    const source = new FakeSource();
    const library = new SearchLibrary(source, store);
    library.start();
    await settle(1);
    expect(library.search("jatt", 40)[0].items[0].title).toBe("Jatt Brothers");
    expect(library.loading).toBe(false);
    await settle();
    expect(source.asked).toEqual([]);
  });

  it("refreshes a day-old copy in the background, one list at a time, and swaps it in", async () => {
    const first = new SearchLibrary(new FakeSource(), store);
    first.start();
    await settle();
    vi.setSystemTime(new Date("2026-10-03T13:00:00Z"));
    movies["3"].push({ stream_id: 302, name: "Jatt Again", category_id: "3", added: "400" });
    const source = new FakeSource();
    const library = new SearchLibrary(source, store);
    library.start();
    await settle(1);
    // The old copy answers while the new one loads, 2 s apart.
    expect(library.status).toMatchObject({ done: 1, total: 1 });
    expect(library.search("jatt", 40)[0].items.length).toBe(1);
    expect(source.asked.length).toBeLessThan(3);
    await settle();
    expect(source.asked).toEqual(["series:all", "movie:1", "movie:3"]);
    expect(library.search("jatt", 40)[0].items.map((i) => i.title)).toEqual(["Jatt Again", "Jatt Brothers"]);
    expect(store.data["search-library"].indexOf("Jatt Again")).toBeGreaterThan(0);
    movies["3"].pop();
  });

  it("falls back to series by category, and stops after three failures in a row", async () => {
    const source = new FakeSource();
    source.failing["series:all"] = true;
    const library = new SearchLibrary(source, store);
    library.start();
    await settle();
    expect(source.asked).toEqual(["series:all", "series:10", "movie:1", "movie:3"]);
    expect(library.search("office", 40).length).toBe(1);

    const blocked = new FakeSource();
    blocked.failing["*"] = true;
    const store2 = new MemoryTextStore();
    const stopped = new SearchLibrary(blocked, store2);
    stopped.start();
    await settle();
    expect(blocked.asked.length).toBe(3);
    expect(stopped.status.stopped).toBe(true);
    expect(store2.data["search-library"]).toBeUndefined();
  });

  it("indexes Home's rows instead of asking again", async () => {
    const source = new FakeSource();
    const library = new SearchLibrary(source, store);
    library.start();
    await vi.advanceTimersByTimeAsync(0);
    if (source.onList) source.onList("movie", "3", movies["3"]);
    await settle();
    expect(source.asked).toEqual(["series:all", "movie:1"]);
    expect(library.counts()["movie:3"]).toBe(1);
  });
});
