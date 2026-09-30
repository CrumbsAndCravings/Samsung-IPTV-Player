// Ported from the Roku app's tests/utils_test.brs (seeking).
import { describe, expect, it } from "vitest";
import { barFraction, clampSeek, holdStep } from "../src/core/playback";

describe("hold to seek", () => {
  it("steps 10 s, then 30 s, then doubles every 1.5 s up to 10 min", () => {
    expect(holdStep(0)).toBe(10);
    expect(holdStep(1499)).toBe(10);
    expect(holdStep(1500)).toBe(30);
    expect(holdStep(2999)).toBe(30);
    expect(holdStep(3000)).toBe(60);
    expect(holdStep(4500)).toBe(120);
    expect(holdStep(6000)).toBe(240);
    expect(holdStep(7500)).toBe(480);
    expect(holdStep(9000)).toBe(600);
    expect(holdStep(60000)).toBe(600);
  });
  it("keeps targets inside the video", () => {
    expect(Math.floor(clampSeek(-25, 3600))).toBe(0);
    expect(Math.floor(clampSeek(4000, 3600))).toBe(3597);
    expect(Math.floor(clampSeek(4000, 0))).toBe(4000);
  });
  it("fills the bar", () => {
    expect(Math.floor(barFraction(1800, 3600) * 100)).toBe(50);
    expect(Math.floor(barFraction(10, 0) * 100)).toBe(0);
    expect(Math.floor(barFraction(4000, 3600) * 100)).toBe(100);
  });
});
