// Subtitle settings (src/core/substyle.ts): the look kept for every video, and timing
// in tenths of a second, remembered per title.
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, savePref, useStore } from "../src/core/storage";
import {
  choiceLabel,
  DEFAULT_SUB_STYLE,
  fontOf,
  loadSubStyle,
  rememberedTiming,
  rememberTiming,
  saveSubStyle,
  sizePx,
  stepChoice,
  stepTiming,
  SUB_FONTS,
  timingLabel,
} from "../src/core/substyle";

describe("the subtitle look", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("starts as ARAN+ always drew them, and keeps what's chosen", () => {
    expect(loadSubStyle()).toEqual(DEFAULT_SUB_STYLE);
    saveSubStyle({ ...DEFAULT_SUB_STYLE, font: "netflix", size: "large", background: "shade" });
    const style = loadSubStyle();
    expect(style.font + " " + style.size + " " + style.background).toBe("netflix large shade");
    expect(fontOf(style).family).toContain("SubInter");
    expect(sizePx(style)).toBe(54);
  });

  it("forgets choices it doesn't know", () => {
    savePref("subFont", "comic-sans-forever");
    savePref("subSize", "");
    expect(loadSubStyle().font).toBe("aran");
    expect(loadSubStyle().size).toBe("medium");
  });

  it("offers Netflix and Prime Video styles", () => {
    expect(SUB_FONTS.map((f) => f.label)).toContain("Netflix style");
    expect(SUB_FONTS.map((f) => f.label)).toContain("Prime Video style");
  });

  it("steps through the choices: arrows stop at the ends, OK goes round", () => {
    expect(stepChoice("size", "medium", 1)).toBe("large");
    expect(stepChoice("size", "huge", 1)).toBe("huge");
    expect(stepChoice("size", "small", -1)).toBe("small");
    expect(stepChoice("position", "higher", 1, true)).toBe("bottom");
    expect(stepChoice("font", "unknown", 1)).toBe("netflix");
    expect(choiceLabel("background", "black")).toBe("Black box");
  });
});

describe("subtitle timing", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("moves a tenth of a second at a time, half a second when held", () => {
    expect(stepTiming(0, 1)).toBe(100);
    expect(stepTiming(100, -1)).toBe(0);
    expect(stepTiming(0, -1)).toBe(-100);
    expect(stepTiming(1000, 1, true)).toBe(1500);
    // Back on the 0.1 s grid, and within a minute either way.
    expect(stepTiming(1234, 1)).toBe(1300);
    expect(stepTiming(60000, 1, true)).toBe(60000);
    expect(stepTiming(-60000, -1)).toBe(-60000);
  });

  it("says how far they've moved", () => {
    expect(timingLabel(0)).toBe("On time");
    expect(timingLabel(1000)).toBe("1.0 s later");
    expect(timingLabel(-300)).toBe("0.3 s earlier");
    expect(timingLabel(40)).toBe("On time");
  });

  it("is remembered per title and subtitles, the newest 60", () => {
    expect(rememberedTiming("m:1|os:9")).toBeNull();
    rememberTiming("m:1|os:9", 1100);
    rememberTiming("m:1|track:eng", -400);
    expect(rememberedTiming("m:1|os:9")).toBe(1100);
    expect(rememberedTiming("m:1|track:eng")).toBe(-400);
    // Back on time: nothing to remember.
    rememberTiming("m:1|os:9", 0);
    expect(rememberedTiming("m:1|os:9")).toBeNull();
    for (let i = 0; i < 70; i++) rememberTiming("m:" + i + "|os:1", 100);
    expect(rememberedTiming("m:0|os:1")).toBeNull();
    expect(rememberedTiming("m:69|os:1")).toBe(100);
  });
});
