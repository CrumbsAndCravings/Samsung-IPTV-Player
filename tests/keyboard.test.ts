import { describe, expect, it } from "vitest";
import { applyKey, moveKey } from "../src/ui/keyboard";
import { libraryStatusText } from "../src/core/search";

describe("the Search keyboard", () => {
  it("moves around the letter grid and says when an arrow leaves it", () => {
    expect(moveKey({ row: 0, col: 0 }, "right")).toEqual({ row: 0, col: 1 });
    expect(moveKey({ row: 0, col: 0 }, "left")).toBeNull();
    expect(moveKey({ row: 0, col: 5 }, "right")).toBeNull();
    expect(moveKey({ row: 0, col: 3 }, "up")).toBeNull();
    expect(moveKey({ row: 2, col: 3 }, "down")).toEqual({ row: 3, col: 3 });
  });
  it("treats the wide bottom keys as one each", () => {
    expect(moveKey({ row: 5, col: 3 }, "down")).toEqual({ row: 6, col: 2 }); // Delete
    expect(moveKey({ row: 6, col: 2 }, "right")).toEqual({ row: 6, col: 4 }); // Clear
    expect(moveKey({ row: 6, col: 4 }, "right")).toBeNull();
    expect(moveKey({ row: 6, col: 2 }, "left")).toEqual({ row: 6, col: 0 }); // Space
    expect(moveKey({ row: 6, col: 4 }, "up")).toEqual({ row: 5, col: 4 });
    expect(moveKey({ row: 6, col: 0 }, "down")).toBeNull();
  });
  it("types, spaces, deletes and clears", () => {
    expect(applyKey("the", "m")).toBe("them");
    expect(applyKey("", "space")).toBe("");
    expect(applyKey("the ", "space")).toBe("the ");
    expect(applyKey("the", "space")).toBe("the ");
    expect(applyKey("them", "delete")).toBe("the");
    expect(applyKey("", "delete")).toBe("");
    expect(applyKey("them", "clear")).toBe("");
    expect(applyKey("x".repeat(40), "a")).toBe("x".repeat(40));
  });
});

describe("the library status line", () => {
  it("counts lists while loading, then titles", () => {
    expect(libraryStatusText({ done: 0, total: 0, failed: 0, titles: 0, error: "" })).toBe("Getting your library ready for search…");
    expect(libraryStatusText({ done: 5, total: 34, failed: 0, titles: 12345, error: "" })).toBe("Loading your library: 5 of 34 lists (12,345 titles so far)");
    expect(libraryStatusText({ done: 34, total: 34, failed: 0, titles: 28494, error: "" })).toBe("Searching all 28,494 titles");
    expect(libraryStatusText({ done: 34, total: 34, failed: 2, titles: 900, error: "" })).toBe("Searching all 900 titles (2 lists didn't load)");
    expect(libraryStatusText({ done: 0, total: 0, failed: 0, titles: 0, error: "The server took too long to answer." })).toBe(
      "Couldn't load your library. The server took too long to answer. Leave Search and come back to try again.",
    );
  });
});
