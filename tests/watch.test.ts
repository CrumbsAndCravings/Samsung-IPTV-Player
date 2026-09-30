// Continue Watching rules from the Roku player (PlayerScreen.brs), and the jump preview.
import { describe, expect, it } from "vitest";
import { makeItem } from "../src/core/items";
import { SeekPreview } from "../src/core/seek";
import { dueForSave, entryFor, finishedChange, hasNext, resumeFrom, saveAction, Watching } from "../src/core/watch";

const movie: Watching = { kind: "movie", movie: makeItem({ kind: "movie", itemId: "9", title: "Heist", poster: "p", backdrop: "b", ext: "mkv" }) };
const show: Watching = {
  kind: "episode",
  seriesId: "55",
  seriesName: "Breaking Bad",
  poster: "sp",
  backdrop: "sb",
  queue: [
    makeItem({ kind: "episode", itemId: "801", seasonNo: 1, episodeNo: 1, title: "Pilot", ext: "mp4" }),
    makeItem({ kind: "episode", itemId: "802", seasonNo: 1, episodeNo: 2, title: "Cat", ext: "mkv" }),
  ],
};

describe("resume and saving", () => {
  it("resumes 5 s early once past 10 s", () => {
    expect(resumeFrom(0)).toBe(0);
    expect(resumeFrom(10)).toBe(0);
    expect(resumeFrom(11)).toBe(6);
    expect(resumeFrom(600)).toBe(595);
  });
  it("saves every 15 s, never under 10 s, and finishes at 95 %", () => {
    expect(dueForSave(29, 15)).toBe(false);
    expect(dueForSave(30, 15)).toBe(true);
    expect(dueForSave(0, 600)).toBe(true); // a jump back counts too
    expect(saveAction(9, 100)).toBe("skip");
    expect(saveAction(94, 100)).toBe("save");
    expect(saveAction(95, 100)).toBe("finished");
    expect(saveAction(5000, 0)).toBe("save"); // unknown length
  });
});

describe("Continue Watching entries", () => {
  it("keys movies by stream id with the movie's details", () => {
    expect(entryFor(movie, 0, 600, 6000)).toEqual({ k: "m:9", kind: "movie", id: "9", name: "Heist", poster: "p", bd: "b", ext: "mkv", pos: 600, dur: 6000 });
  });
  it("keys series by series id with the episode", () => {
    expect(entryFor(show, 1, 100, 2880)).toEqual({
      k: "s:55",
      kind: "episode",
      sid: "55",
      id: "802",
      ext: "mkv",
      name: "Breaking Bad",
      poster: "sp",
      bd: "sb",
      season: 1,
      episode: 2,
      etitle: "Cat",
      pos: 100,
      dur: 2880,
    });
  });
  it("drops a finished movie, and moves a series on or drops it after the last episode", () => {
    expect(finishedChange(movie, 0)).toEqual({ remove: "m:9" });
    expect(finishedChange(show, 0).put).toMatchObject({ k: "s:55", id: "802", pos: 0, dur: 0 });
    expect(finishedChange(show, 1)).toEqual({ remove: "s:55" });
    expect(hasNext(show, 0)).toBe(true);
    expect(hasNext(show, 1)).toBe(false);
    expect(hasNext(movie, 0)).toBe(false);
  });
});

describe("jump preview", () => {
  it("steps 10 s on a tap and jumps 0.8 s after release", () => {
    const s = new SeekPreview();
    s.press("right", 1, 100, 3600, 0);
    expect(s.target).toBe(110);
    s.tick(3600, 250); // under half a second: no extra step
    s.release("right", 300);
    expect(s.due(1000)).toBe(-1);
    expect(s.due(1100)).toBe(110);
    expect(s.active).toBe(false);
  });
  it("ignores the remote's own key repeat and grows the step while held", () => {
    const s = new SeekPreview();
    s.press("right", 1, 0, 36000, 0);
    let now = 0;
    for (let i = 0; i < 12; i++) {
      now += 250;
      s.press("right", 1, 0, 36000, now); // repeats: no extra steps
      s.tick(36000, now);
    }
    // 10 on press; ticks at 500..1250 ms add 10 each (4 x 10), 1500..2750 ms add 30 each
    // (6 x 30), and at 3000 ms the step doubles to 60.
    expect(s.target).toBe(10 + 40 + 180 + 60);
  });
  it("keeps adding across taps and goes backwards too", () => {
    const s = new SeekPreview();
    s.press("left", -1, 100, 3600, 0);
    s.release("left", 100);
    s.press("left", -1, 100, 3600, 400);
    s.release("left", 450);
    expect(s.target).toBe(80);
    expect(s.due(1100)).toBe(-1);
    expect(s.due(1250)).toBe(80);
  });
  it("stays inside the video", () => {
    const s = new SeekPreview();
    s.press("left", -1, 4, 3600, 0);
    expect(s.target).toBe(0);
    s.cancel();
    s.press("right", 1, 3595, 3600, 0);
    expect(s.target).toBe(3597);
  });
  it("counts a hold without a key release as released", () => {
    const s = new SeekPreview();
    s.press("right", 1, 0, 3600, 0);
    s.tick(3600, 1000); // no key event for a second: released
    expect(s.holding).toBe(false);
    expect(s.due(1800)).toBe(10);
  });
  it("can be applied at once or cancelled", () => {
    const s = new SeekPreview();
    s.press("right", 1, 50, 3600, 0);
    expect(s.commit()).toBe(60);
    s.press("right", 1, 50, 3600, 0);
    s.cancel();
    expect(s.active).toBe(false);
    expect(s.due(5000)).toBe(-1);
  });
});
