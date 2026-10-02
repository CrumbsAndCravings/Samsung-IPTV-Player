// Ported from the Roku app's tests/parse_test.brs (removals and MergeProgress), plus
// SHA-256 checked against digests from Node's crypto module.
import { beforeEach, describe, expect, it } from "vitest";
import { mergeProgress, progressList, progressPut, progressRemove, progressRemovedList, ProgressEntry } from "../src/core/progress";
import { sha256Hex } from "../src/core/sha256";
import { MemoryStore, useStore } from "../src/core/storage";
import { syncSpaceText } from "../src/core/utils";

const entry = (k: string, at: number, pos: number) => ({ k, at, pos }) as unknown as ProgressEntry;

describe("removing from Continue Watching", () => {
  beforeEach(() => useStore(new MemoryStore()));
  it("remembers each removal for sync, newest first", () => {
    progressPut({ k: "m:1", kind: "movie", id: "1", name: "A", poster: "", bd: "", ext: "mkv", pos: 60, dur: 600 }, 10);
    progressPut({ k: "s:55", kind: "episode", id: "9", sid: "55", name: "B", poster: "", bd: "", ext: "mkv", pos: 60, dur: 600 }, 20);
    progressRemove("m:1", 30);
    progressRemove("s:55", 40);
    expect(progressList().length).toBe(0);
    expect(progressRemovedList()).toEqual([
      { k: "s:55", at: 40 },
      { k: "m:1", at: 30 },
    ]);
  });
});

describe("merging with other devices", () => {
  it("keeps the newest change per title; removals win ties", () => {
    const mine = [entry("m:1", 100, 10), entry("m:2", 300, 20)];
    const theirs = { entries: [entry("m:1", 200, 99), entry("m:3", 50, 5), entry("m:4", 400, 1)], removed: [{ k: "m:3", at: 60 }] };
    const merged = mergeProgress(mine, [{ k: "m:2", at: 250 }, { k: "m:4", at: 400 }], theirs);
    expect(merged.entries.map((e) => e.k).join(",")).toBe("m:2,m:1");
    expect(merged.entries[1].pos).toBe(99);
    expect(merged.removed.length).toBe(3);
    expect(merged.removed[0].k).toBe("m:4");
    expect(mergeProgress(mine, [], undefined).entries.length).toBe(2);
  });
});

describe("the sync space", () => {
  it("is standard SHA-256", () => {
    const known: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["http://host.example\nJane", "d22a4907c2ad4a7f4fc197435cec2c944b92c0c3b62210594923a4e85f464aa3"],
      ["é ★ ✪ 😀", "cec52b5c7075d694fafacd493c040c7a180da452265aaead9bda4d3ce86cbd7a"],
      ["x".repeat(1000), "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f"],
    ];
    for (const [text, digest] of known) expect(sha256Hex(text)).toBe(digest);
  });
  it("comes from the login, the same on every device", () => {
    expect(syncSpaceText({ server: "HTTP://Host.Example:80/", username: "Jane" })).toBe("http://host.example\nJane");
    expect(sha256Hex(syncSpaceText({ server: "host.example", username: "Jane" })).slice(0, 16)).toBe("d22a4907c2ad4a7f");
  });
});
