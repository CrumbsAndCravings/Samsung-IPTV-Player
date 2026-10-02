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

// Takes a title off Continue Watching and remembers when, so the removal reaches other
// devices through sync instead of their older copy bringing it back.
export function progressRemove(key: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  writeJson("progress", "items", progressList().filter((item) => item.k !== key));
  const removed = [{ k: key, at: nowSeconds }].concat(progressRemovedList().filter((gone) => gone.k !== key)).slice(0, REMOVED_MAX);
  writeJson("progress", "removed", removed);
}

export interface Removal {
  k: string;
  at: number;
}

export const REMOVED_MAX = 100;

// Titles taken off Continue Watching, newest first.
export function progressRemovedList(): Removal[] {
  const list = readJson("progress", "removed");
  if (!Array.isArray(list)) return [];
  return list.filter((gone) => isObj(gone) && fieldStr(gone, "k") !== "").map((gone) => ({ k: fieldStr(gone, "k"), at: toInt((gone as { at?: unknown }).at) }));
}

export function progressSave(entries: ProgressEntry[], removed: Removal[]): void {
  writeJson("progress", "items", entries);
  writeJson("progress", "removed", removed);
}

// Folds the synced state ({ entries, removed } from the sync service) into this
// device's lists. For each title the newest change wins, an entry or a removal;
// removals win ties. Returns entries newest first (at most PROGRESS_MAX) and removals
// newest first (at most REMOVED_MAX). Mirrors `merge` in the Roku repo's sync/worker.js.
export function mergeProgress(local: ProgressEntry[], localRemoved: Removal[], remote: unknown): { entries: ProgressEntry[]; removed: Removal[] } {
  const best: { [key: string]: ProgressEntry } = {};
  const remoteEntries = isObj(remote) && Array.isArray(remote.entries) ? (remote.entries as unknown[]) : [];
  for (const source of [local as unknown[], remoteEntries]) {
    for (const entry of source) {
      const key = fieldStr(entry, "k");
      if (key === "" || !isObj(entry)) continue;
      const known = best[key];
      if (!known || toInt(entry.at) > toInt(known.at)) best[key] = entry as unknown as ProgressEntry;
    }
  }
  const gone: { [key: string]: number } = {};
  const remoteRemoved = isObj(remote) && Array.isArray(remote.removed) ? (remote.removed as unknown[]) : [];
  for (const source of [localRemoved as unknown[], remoteRemoved]) {
    for (const removal of source) {
      const key = fieldStr(removal, "k");
      const at = toInt(isObj(removal) ? removal.at : 0);
      if (key !== "" && (gone[key] === undefined || at > gone[key])) gone[key] = at;
    }
  }
  const entries = Object.keys(best)
    .map((key) => best[key])
    .filter((entry) => gone[entry.k] === undefined || toInt(entry.at) > gone[entry.k])
    .sort((a, b) => toInt(b.at) - toInt(a.at))
    .slice(0, PROGRESS_MAX);
  const removed = Object.keys(gone)
    .map((k) => ({ k, at: gone[k] }))
    .sort((a, b) => b.at - a.at)
    .slice(0, REMOVED_MAX);
  return { entries, removed };
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
