// Ported from the Roku app's tests/parse_test.brs (Continue Watching storage).
import { beforeEach, describe, expect, it } from "vitest";
import { continueWatchingRow, progressFind, progressList, progressPut, progressRemove, ProgressEntry } from "../src/core/progress";
import { MemoryStore, useStore } from "../src/core/storage";

const movie = (pos: number): ProgressEntry => ({ k: "m:1", kind: "movie", id: "1", name: "One", poster: "", bd: "", ext: "mp4", pos, dur: 6000 });
const episode: ProgressEntry = { k: "s:55", kind: "episode", sid: "55", id: "802", name: "Breaking Bad", poster: "", bd: "", ext: "mp4", season: 1, episode: 2, etitle: "Cat", pos: 100, dur: 2880 };

describe("Continue Watching", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("keeps one entry per title, newest first", () => {
    progressPut(movie(600));
    progressPut(episode);
    progressPut(movie(1200));
    const list = progressList();
    expect(list.length).toBe(2);
    expect(list[0].k).toBe("m:1");
    expect(list[0].pos).toBe(1200);
    expect(progressFind("s:55")?.id).toBe("802");
  });

  it("builds the row", () => {
    progressPut(episode);
    progressPut(movie(1200));
    const row = continueWatchingRow();
    expect(row?.title).toBe("Continue Watching");
    expect(row?.isContinue).toBe(true);
    expect(row?.items[1].caption).toBe("S1:E2");
    expect(row?.items[1].itemId).toBe("55");
    expect(row?.items[1].kind).toBe("series");
    expect(row?.items[0].progress).toBeCloseTo(0.2);
  });

  it("removes entries and keeps at most 20", () => {
    progressPut(movie(1200));
    progressPut(episode);
    progressRemove("m:1");
    expect(progressList().length).toBe(1);
    for (let i = 1; i <= 25; i++) progressPut({ ...movie(60), k: "m:x" + i, id: String(i), dur: 100 });
    expect(progressList().length).toBe(20);
  });

  it("has no row when empty", () => {
    expect(continueWatchingRow()).toBeNull();
  });
});
