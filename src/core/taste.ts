// What you watch, so Home puts what you like first, as Netflix does (the Roku app's
// Taste.brs; docs/features.md §5.1.1 and §5.1.2). A short history lives on the TV
// (taste/history). The stored library knows every title's category, so the history
// turns into a liking for each category (likingFrom) and titles are picked from there
// (core/search.ts, indexPersonal) without asking the provider for anything. Home keeps
// the likings (taste/scores) to order its rows.
//
// History entries, newest first, at most TASTE_MAX:
//   k   "m:<streamId>" or "s:<seriesId>"
//   n   the name, for "Because you watched" (its first 32 characters)
//   w   how much you liked it: 1 started (3 minutes in), 2 half watched, 3 finished; a
//       series gains half a point an episode, up to 4; -1 taken off Continue Watching
//       before a fifth of it
//   r   your rating, when you gave one: -1 "Not for me", 1 "I like this", 2 "Love
//       this!". It counts for more than watching, and rated titles are the last to drop
//       off the history.
//   t   when (seconds)

import { readJson, writeJson } from "./storage";
import { fieldStr, isArr, isObj, Json } from "./utils";

export const TASTE_MAX = 30;

export interface TasteEntry {
  k: string;
  n: string;
  w: number;
  r?: number;
  t: number;
}

export type Rating = -1 | 0 | 1 | 2;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// A number from JSON (a number or text), 0 otherwise.
export function tasteNumber(value: Json): number {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function entryOf(raw: Json): TasteEntry | null {
  if (!isObj(raw) || fieldStr(raw, "k") === "") return null;
  const entry: TasteEntry = { k: fieldStr(raw, "k"), n: fieldStr(raw, "n"), w: tasteNumber(raw.w), t: Math.floor(tasteNumber(raw.t)) };
  const r = Math.round(tasteNumber(raw.r));
  if (r === -1 || r === 1 || r === 2) entry.r = r;
  return entry;
}

export function tasteHistory(): TasteEntry[] {
  const list = readJson("taste", "history");
  if (!isArr(list)) return [];
  const out: TasteEntry[] = [];
  for (const raw of list) {
    const entry = entryOf(raw);
    if (entry) out.push(entry);
  }
  return out;
}

function saveHistory(list: TasteEntry[]): void {
  writeJson("taste", "history", list as unknown as Json);
}

// How much a movie watched so far counts: 0 under 3 minutes (a peek), then 1, and 2 from
// half way. A finished one counts 3 (tasteFinished).
export function tasteWeightFor(position: number, duration: number): number {
  if (position < 180) return 0;
  if (duration > 0 && position >= duration / 2) return 2;
  return 1;
}

// `entry` first, then the rest of `list` without its title, at most TASTE_MAX: when there
// are too many, the oldest title without a rating goes first.
function tasteFront(list: TasteEntry[], entry: TasteEntry): TasteEntry[] {
  const out = [entry].concat(list.filter((item) => item.k !== entry.k));
  while (out.length > TASTE_MAX) {
    let drop = out.length - 1;
    for (let i = out.length - 1; i >= 1; i--) {
      if (!out[i].r) {
        drop = i;
        break;
      }
    }
    out.splice(drop, 1);
  }
  return out;
}

// `list` with `key` first and its weight changed by `mode`: "atLeast" raises it to
// `weight`, "add" adds `weight` (from 1 for a new title, at most 4), "set" sets it. null
// when nothing would change, so nothing is written.
export function tasteWith(list: TasteEntry[], key: string, name: string, weight: number, mode: "atLeast" | "add" | "set", now: number): TasteEntry[] | null {
  const old = list.filter((entry) => entry.k === key)[0] || null;
  const before = old ? old.w : 0;
  let after = weight;
  if (mode === "atLeast") {
    if (old && before >= weight) return null;
  } else if (mode === "add") {
    after = old && before > 0 ? before + weight : 1;
    if (after > 4) after = 4;
    if (old && after === before) return null;
  } else if (old && before === weight) return null;
  let n = name === "" && old ? old.n : name;
  if (n.length > 32) n = n.slice(0, 32);
  const entry: TasteEntry = { k: key, n, w: after, t: now };
  if (old && old.r) entry.r = old.r;
  return tasteFront(list, entry);
}

// `list` with your rating of `key` (-1, 1 or 2; 0 takes it away), the title first.
// Watching it counts as before. null when nothing would change.
export function tasteRated(list: TasteEntry[], key: string, name: string, rating: Rating, now: number): TasteEntry[] | null {
  const old = list.filter((entry) => entry.k === key)[0] || null;
  if (old && (old.r || 0) === rating) return null;
  if (!old && rating === 0) return null;
  let n = name === "" && old ? old.n : name;
  if (n.length > 32) n = n.slice(0, 32);
  const entry: TasteEntry = { k: key, n, w: old ? old.w : 0, t: now };
  if (rating !== 0) entry.r = rating;
  return tasteFront(list, entry);
}

// Your rating of a title: -1, 1, 2, or 0 for none.
export function tasteRating(key: string): Rating {
  const entry = tasteHistory().filter((e) => e.k === key)[0];
  return entry && entry.r ? (entry.r as Rating) : 0;
}

// Rates a title (Details, or holding OK on a poster on Home).
export function tasteRate(key: string, name: string, rating: Rating): void {
  if (key === "") return;
  const list = tasteRated(tasteHistory(), key, name, rating, nowSeconds());
  if (list) saveHistory(list);
}

// The words for a rating, as the buttons say it.
export function ratingLabel(rating: Rating): string {
  if (rating === -1) return "Not for me";
  if (rating === 1) return "I like this";
  if (rating === 2) return "Love this!";
  return "Rate";
}

// How much a title counts towards its category: "Not for me" counts against it, more
// than leaving early does; a like adds 1.5 and a love 3 to what watching it counted (at
// least 1, so a title rated before it's watched counts too).
export function tasteWeight(entry: TasteEntry): number {
  let w = entry.w;
  if (entry.r === -1) return -3;
  if (entry.r === 1 || entry.r === 2) {
    if (w < 1) w = 1;
    return entry.r === 1 ? w + 1.5 : w + 3;
  }
  return w;
}

function tasteChange(key: string, name: string, weight: number, mode: "atLeast" | "add" | "set"): void {
  if (key === "") return;
  const list = tasteWith(tasteHistory(), key, name, weight, mode, nowSeconds());
  if (list) saveHistory(list);
}

// A movie or series you've been watching (`weight` from tasteWeightFor; a series counts
// 1 while you watch it).
export function tasteWatched(key: string, name: string, weight: number): void {
  if (weight > 0) tasteChange(key, name, weight, "atLeast");
}

// A movie watched to the end.
export function tasteFinished(key: string, name: string): void {
  tasteChange(key, name, 3, "atLeast");
}

// An episode watched to the end: its series counts half a point more.
export function tasteEpisodeDone(key: string, name: string): void {
  tasteChange(key, name, 0.5, "add");
}

// Taken off Continue Watching before a fifth of it was watched: not for you.
export function tasteNotForMe(key: string, fraction: number): void {
  if (fraction < 0.2) tasteChange(key, "", -1, "set");
}

// How much you like each category, as last worked out: { "vod:12": 3.2, "series:7": 1.5 }.
export function tasteScores(): { [key: string]: number } {
  const raw = readJson("taste", "scores");
  const out: { [key: string]: number } = {};
  if (isObj(raw)) for (const key of Object.keys(raw)) out[key] = tasteNumber(raw[key]);
  return out;
}

// Keeps the categories liked most (at most 12), so it stays small.
export function tasteSaveScores(scores: { [key: string]: number }): void {
  const ranked = Object.keys(scores)
    .filter((key) => scores[key] > 0)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, 12);
  const kept: { [key: string]: number } = {};
  for (const key of ranked) kept[key] = Math.floor(scores[key] * 100) / 100;
  writeJson("taste", "scores", kept);
}

// The likings key of a category: "vod:12" or "series:7".
export function likingKey(kind: "movie" | "series", categoryId: string): string {
  return (kind === "series" ? "series:" : "vod:") + categoryId;
}

// Rows (each with kind and categoryId) with the categories you like moved up: after the
// first `keepFirst` (new releases, so there's always something new near the top), those
// you like, most liked first, then the rest as they were.
export function tasteOrder<T extends { kind: "movie" | "series"; categoryId: string }>(plan: T[], scores: { [key: string]: number }, keepFirst: number): T[] {
  if (Object.keys(scores).length === 0) return plan;
  const head: T[] = [];
  const liked: { score: number; at: number; entry: T }[] = [];
  const rest: T[] = [];
  plan.forEach((entry, i) => {
    const score = scores[likingKey(entry.kind, entry.categoryId)] || 0;
    if (i < keepFirst) head.push(entry);
    else if (score > 0) liked.push({ score, at: i, entry });
    else rest.push(entry);
  });
  // Ties keep their order.
  liked.sort((a, b) => b.score - a.score || a.at - b.at);
  return head.concat(liked.map((l) => l.entry)).concat(rest);
}

// How much you like each category ("vod:12" -> 3.2): every title's weight, halving every
// 30 days, added to its category. `watching` is Continue Watching ({ k, at, pos, dur }),
// which also holds what you watched on your other devices: a title there and not in the
// history counts 1 (2 from half way). `categories` says each title's category
// ({ "m:123": "vod:12" }, categoriesFrom).
export function likingFrom(history: TasteEntry[], watching: Json[], categories: { [key: string]: string }, now: number): { [key: string]: number } {
  const weights: { k: string; w: number; t: number }[] = [];
  const known: { [key: string]: boolean } = {};
  for (const entry of history) {
    known[entry.k] = true;
    weights.push({ k: entry.k, w: tasteWeight(entry), t: entry.t });
  }
  for (const raw of watching) {
    const key = fieldStr(raw, "k");
    if (key === "" || known[key]) continue;
    const dur = tasteNumber(isObj(raw) ? raw.dur : 0);
    const pos = tasteNumber(isObj(raw) ? raw.pos : 0);
    weights.push({ k: key, w: dur > 0 && pos >= dur / 2 ? 2 : 1, t: tasteNumber(isObj(raw) ? raw.at : 0) });
  }
  const scores: { [key: string]: number } = {};
  for (const item of weights) {
    const category = categories[item.k];
    if (!category) continue;
    const days = Math.max(0, (now - item.t) / 86400);
    scores[category] = (scores[category] || 0) + item.w * Math.pow(0.5, days / 30);
  }
  return scores;
}

// The titles to build "Because you watched" rows on, at most `count`: the latest ones you
// loved, then liked, then watched at least half of, then started; never one you said
// wasn't for you.
export function tasteBecause(history: TasteEntry[], count: number): { k: string; n: string }[] {
  const picked: { k: string; n: string }[] = [];
  const chosen: { [key: string]: boolean } = {};
  const stages: ((e: TasteEntry) => boolean)[] = [(e) => e.r === 2, (e) => e.r === 1, (e) => e.r !== -1 && e.w >= 2, (e) => e.r !== -1 && e.w >= 1];
  for (const fits of stages) {
    for (const entry of history) {
      if (picked.length >= count) break;
      if (fits(entry) && entry.n !== "" && !chosen[entry.k]) {
        chosen[entry.k] = true;
        picked.push({ k: entry.k, n: entry.n });
      }
    }
  }
  return picked;
}
