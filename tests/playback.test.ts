// Ported from the Roku app's tests/utils_test.brs (seeking).
import { describe, expect, it } from "vitest";
import { barFraction, bufferPlan, clampSeek, helperStartMs, holdStep, providerServerTrouble, richThroughHelper } from "../src/core/playback";

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

describe("the provider's server failing", () => {
  it("is an HTTP 5xx, or FFmpeg's word for one", () => {
    expect(providerServerTrouble("Asked the server for the stream again: HTTP 502 from nginx")).toBe(true);
    expect(providerServerTrouble("Couldn't read movie 1.mkv from the provider: Server returned 5XX Server Error reply")).toBe(true);
    expect(providerServerTrouble("HTTP 503")).toBe(true);
    expect(providerServerTrouble("HTTP 404 from nginx")).toBe(false);
    expect(providerServerTrouble("PLAYER_ERROR_CONNECTION_FAILED")).toBe(false);
    expect(providerServerTrouble("")).toBe(false);
  });
});

describe("a helper stream's real start", () => {
  it("counts from the keyframe the helper started on", () => {
    expect(helperStartMs(754, 751.5)).toBe(751500);
    expect(helperStartMs(754, 754)).toBe(754000);
    // Unknown, later than asked or far too early: the time asked for stands.
    expect(helperStartMs(754, -1)).toBe(754000);
    expect(helperStartMs(754, 760)).toBe(754000);
    expect(helperStartMs(754, 600)).toBe(754000);
    expect(helperStartMs(0, 0)).toBe(0);
  });
});

describe("buffering for heavy files", () => {
  it("gathers more for 4K and rich files, and leaves the rest as they were", () => {
    expect(bufferPlan(25268, 3840)).toEqual({ play: 5, resume: 15 }); // Dune Part Two [4k]
    expect(bufferPlan(6400, 3840)).toEqual({ play: 5, resume: 15 }); // a light 4K copy
    expect(bufferPlan(15782, 1920)).toEqual({ play: 5, resume: 15 }); // a rich 1080p copy
    expect(bufferPlan(2797, 1920)).toBeNull();
    expect(bufferPlan(0, 0)).toBeNull();
  });
});

describe("rich films through the helper", () => {
  it("is on unless the account menu turned it off", () => {
    expect(richThroughHelper("")).toBe(true);
    expect(richThroughHelper("helper")).toBe(true);
    expect(richThroughHelper("direct")).toBe(false);
  });
});
