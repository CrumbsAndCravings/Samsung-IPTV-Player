// Rules for what counts as watched, ported from the Roku app's PlayerScreen.brs so they
// can be tested off the TV:
//   - resume 5 s before the saved position, when that is past 10 s;
//   - save every 15 s of playback, on pause and on leaving; nothing under 10 s;
//   - at 95 % a movie leaves Continue Watching and a series moves on to the next
//     episode at 0, or leaves after its last one.

import type { Item } from "./items";
import { ProgressEntry } from "./progress";

export const SAVE_EVERY_SECS = 15;
export const MIN_SAVE_SECS = 10;
export const FINISHED_AT = 0.95;

export function resumeFrom(savedSecs: number): number {
  return savedSecs > 10 ? savedSecs - 5 : 0;
}

export function dueForSave(positionSecs: number, lastSavedSecs: number): boolean {
  return Math.abs(positionSecs - lastSavedSecs) >= SAVE_EVERY_SECS;
}

export type SaveAction = "skip" | "save" | "finished";

export function saveAction(positionSecs: number, durationSecs: number): SaveAction {
  if (positionSecs < MIN_SAVE_SECS) return "skip";
  if (durationSecs > 0 && positionSecs >= durationSecs * FINISHED_AT) return "finished";
  return "save";
}

// What is being played: a movie, or a series with its episodes in play order.
export interface Watching {
  kind: "movie" | "episode";
  movie?: Item;
  seriesId?: string;
  seriesName?: string;
  poster?: string;
  backdrop?: string;
  tmdbId?: string;
  queue?: Item[];
}

export function currentOf(w: Watching, index: number): Item {
  return w.kind === "movie" ? (w.movie as Item) : (w.queue as Item[])[index];
}

export function hasNext(w: Watching, index: number): boolean {
  return w.kind === "episode" && !!w.queue && index + 1 < w.queue.length;
}

export function entryFor(w: Watching, index: number, positionSecs: number, durationSecs: number): ProgressEntry {
  if (w.kind === "movie") {
    const m = w.movie as Item;
    return { k: "m:" + m.itemId, kind: "movie", id: m.itemId, name: m.title, poster: m.poster, bd: m.backdrop, ext: m.ext, pos: positionSecs, dur: durationSecs };
  }
  const ep = (w.queue as Item[])[index];
  return {
    k: "s:" + w.seriesId,
    kind: "episode",
    sid: w.seriesId,
    id: ep.itemId,
    ext: ep.ext,
    name: w.seriesName || "",
    poster: w.poster || "",
    bd: w.backdrop || "",
    season: ep.seasonNo,
    episode: ep.episodeNo,
    etitle: ep.title,
    pos: positionSecs,
    dur: durationSecs,
  };
}

// What a finished title does to Continue Watching.
export function finishedChange(w: Watching, index: number): { put?: ProgressEntry; remove?: string } {
  if (w.kind === "movie") return { remove: "m:" + (w.movie as Item).itemId };
  if (hasNext(w, index)) return { put: entryFor(w, index + 1, 0, 0) };
  return { remove: "s:" + w.seriesId };
}
