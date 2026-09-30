// Continue Watching, ported from the Roku app's Progress.brs. One entry per movie
// ("m:<streamId>") or per series ("s:<seriesId>"), newest first, at most 20, stored
// under "progress:items".

import { Item, makeItem, Row } from "./items";
import { readJson, writeJson } from "./storage";
import { episodeCode, fieldStr, isObj, toInt } from "./utils";

export interface ProgressEntry {
  k: string; // "m:<streamId>" or "s:<seriesId>"
  kind: "movie" | "episode";
  id: string; // stream or episode id to play
  name: string; // movie or series name
  poster: string;
  bd: string; // backdrop
  ext: string;
  pos: number; // seconds watched
  dur: number; // total seconds
  sid?: string; // series id (episodes)
  season?: number;
  episode?: number;
  etitle?: string; // episode title
  at?: number; // when it was saved (seconds)
}

export const PROGRESS_MAX = 20;

export function progressList(): ProgressEntry[] {
  const list = readJson("progress", "items");
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => isObj(entry) && fieldStr(entry, "k") !== "") as ProgressEntry[];
}

export function progressFind(key: string): ProgressEntry | null {
  for (const entry of progressList()) if (entry.k === key) return entry;
  return null;
}

export function progressPut(entry: ProgressEntry, nowSeconds = Math.floor(Date.now() / 1000)): void {
  const fresh: ProgressEntry = Object.assign({}, entry, { at: nowSeconds });
  const list = [fresh].concat(progressList().filter((item) => item.k !== entry.k)).slice(0, PROGRESS_MAX);
  writeJson("progress", "items", list);
}

export function progressRemove(key: string): void {
  writeJson("progress", "items", progressList().filter((item) => item.k !== key));
}

export function progressFraction(entry: ProgressEntry | null): number {
  if (!entry) return 0;
  const dur = toInt(entry.dur);
  if (dur <= 0) return 0;
  return Math.min(1, toInt(entry.pos) / dur);
}

// The Continue Watching row, or null when there is nothing to show. A series entry
// opens the show, captioned with the episode ("S1:E2").
export function continueWatchingRow(): Row | null {
  const list = progressList();
  if (list.length === 0) return null;
  const items: Item[] = list.map((entry) => {
    const episode = entry.kind === "episode";
    const seriesId = episode ? fieldStr(entry, "sid") : "";
    return makeItem({
      kind: episode ? "series" : "movie",
      title: fieldStr(entry, "name"),
      poster: fieldStr(entry, "poster"),
      itemId: episode ? seriesId : fieldStr(entry, "id"),
      seriesId,
      ext: fieldStr(entry, "ext"),
      backdrop: fieldStr(entry, "bd"),
      progress: progressFraction(entry),
      caption: episode ? episodeCode(entry.season, entry.episode) : "",
    });
  });
  return { title: "Continue Watching", items, isContinue: true };
}
