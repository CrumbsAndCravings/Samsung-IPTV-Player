import { describe, expect, it } from "vitest";
import { applyKey, KeyboardState, moveKey } from "../src/ui/keyboard";
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
    expect(moveKey({ row: 5, col: 3 }, "down")).toEqual({ row: 6, col: 2 }); // Caps
    expect(moveKey({ row: 6, col: 2 }, "right")).toEqual({ row: 6, col: 4 }); // symbols
    expect(moveKey({ row: 6, col: 4 }, "right")).toBeNull();
    expect(moveKey({ row: 6, col: 2 }, "left")).toEqual({ row: 6, col: 0 }); // Shift
    expect(moveKey({ row: 6, col: 2 }, "down")).toEqual({ row: 7, col: 2 }); // Delete
    expect(moveKey({ row: 7, col: 4 }, "up")).toEqual({ row: 6, col: 4 });
    expect(moveKey({ row: 6, col: 4 }, "up")).toEqual({ row: 5, col: 4 });
    expect(moveKey({ row: 7, col: 0 }, "down")).toBeNull();
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
    expect(applyKey("Spider", "-")).toBe("Spider-");
  });

  // Puts the focus on a key by its grid position and presses OK.
  const pressAt = (state: KeyboardState, row: number, col: number) => {
    state.pos = { row, col };
    return state.press();
  };

  it("capitalises the next letter after Shift, then goes back to lower case", () => {
    const k = new KeyboardState();
    expect(pressAt(k, 6, 0)).toBeNull(); // Shift
    expect(k.label("a")).toBe("A");
    expect(pressAt(k, 0, 0)).toBe("A");
    expect(k.shift).toBe(false);
    expect(pressAt(k, 0, 1)).toBe("b");
  });

  it("keeps capitals on with Caps until it's pressed again", () => {
    const k = new KeyboardState();
    pressAt(k, 6, 2); // Caps
    expect(pressAt(k, 0, 0)).toBe("A");
    expect(pressAt(k, 0, 1)).toBe("B");
    expect(pressAt(k, 4, 2)).toBe("1");
    pressAt(k, 6, 2);
    expect(pressAt(k, 0, 2)).toBe("c");
  });

  it("switches to symbols and back", () => {
    const k = new KeyboardState();
    expect(k.label("symbols")).toBe("#+=");
    pressAt(k, 6, 4);
    expect(k.label("symbols")).toBe("abc");
    expect(pressAt(k, 0, 0)).toBe("!");
    expect(pressAt(k, 0, 5)).toBe("-");
    expect(pressAt(k, 7, 0)).toBe("space");
    pressAt(k, 6, 4);
    expect(pressAt(k, 0, 0)).toBe("a");
  });

  it("leaves Shift waiting while symbols are typed", () => {
    const k = new KeyboardState();
    pressAt(k, 6, 0); // Shift
    pressAt(k, 6, 4); // symbols
    expect(pressAt(k, 0, 2)).toBe("&");
    expect(k.shift).toBe(true);
    pressAt(k, 6, 4); // letters
    expect(pressAt(k, 1, 0)).toBe("G");
  });
});

describe("the library status line", () => {
  it("counts lists while loading, then titles", () => {
    expect(libraryStatusText({ done: 0, total: 0, failed: 0, titles: 0, error: "", stopped: false })).toBe("Getting your library ready for search…");
    expect(libraryStatusText({ done: 5, total: 34, failed: 0, titles: 12345, error: "", stopped: false })).toBe("Loading your library: 5 of 34 lists (12,345 titles so far)");
    expect(libraryStatusText({ done: 34, total: 34, failed: 0, titles: 28494, error: "", stopped: false })).toBe("Searching all 28,494 titles");
    expect(libraryStatusText({ done: 34, total: 34, failed: 2, titles: 900, error: "", stopped: false })).toBe("Searching all 900 titles (2 lists didn't load)");
    expect(libraryStatusText({ done: 0, total: 0, failed: 0, titles: 0, error: "The server took too long to answer.", stopped: false })).toBe(
      "Couldn't load your library. The server took too long to answer. Leave Search and come back to try again.",
    );
  });
});
