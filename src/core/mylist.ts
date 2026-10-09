// My List: titles you've saved to watch later (+ My List on Details, or holding OK on a
// poster on Home), kept on the TV (mylist/items), newest first, at most MY_LIST_MAX. No
// pictures, which the stored library supplies (core/search.ts, listItems). The Roku app's
// MyList.brs; docs/features.md §5.1.2.
//
// Entries: { k: "m:<streamId>" | "s:<seriesId>", n: name, x: container extension
// (movies), t: when added (seconds) }

import { Item, makeItem } from "./items";
import { readJson, writeJson } from "./storage";
import { nowSeconds, tasteWatched } from "./taste";
import { fieldStr, isArr, isObj, Json } from "./utils";

export const MY_LIST_MAX = 40;

export interface ListEntry {
  k: string;
  n: string;
  x?: string;
  t: number;
}

export function myList(): ListEntry[] {
  const raw = readJson("mylist", "items");
  if (!isArr(raw)) return [];
  const out: ListEntry[] = [];
  for (const entry of raw) {
    if (!isObj(entry) || fieldStr(entry, "k") === "") continue;
    const item: ListEntry = { k: fieldStr(entry, "k"), n: fieldStr(entry, "n"), t: Math.floor(Number(entry.t) || 0) };
    if (fieldStr(entry, "x")) item.x = fieldStr(entry, "x");
    out.push(item);
  }
  return out;
}

export function myListHas(key: string): boolean {
  return myList().some((entry) => entry.k === key);
}

// `list` with `key` added first (`add`) or taken out.
export function myListWith(list: ListEntry[], key: string, name: string, ext: string, add: boolean, now: number): ListEntry[] {
  const out: ListEntry[] = [];
  if (add) {
    const entry: ListEntry = { k: key, n: name.length > 40 ? name.slice(0, 40) : name, t: now };
    if (ext) entry.x = ext;
    out.push(entry);
  }
  for (const entry of list) if (entry.k !== key && out.length < MY_LIST_MAX) out.push(entry);
  return out;
}

// Adds a title, or takes it out when it's there already. Returns whether it's in now.
// Adding one counts towards what you like (core/taste.ts), as starting it would.
export function myListToggle(key: string, name: string, ext: string): boolean {
  const adding = !myListHas(key);
  writeJson("mylist", "items", myListWith(myList(), key, name, ext, adding, nowSeconds()) as unknown as Json);
  if (adding) tasteWatched(key, name, 1);
  return adding;
}

// One title's name card, with `poster` when it's known.
export function listItem(entry: ListEntry, poster: string): Item {
  const id = entry.k.slice(2);
  const series = entry.k.charAt(0) === "s";
  return makeItem({ kind: series ? "series" : "movie", title: entry.n, itemId: id, seriesId: series ? id : "", ext: entry.x || "", poster });
}

// The key of a poster's title ("m:123" or "s:45"), or "" for anything else (a category
// card, See all, a placeholder, an episode).
export function titleKey(item: Item | null): string {
  if (!item || item.placeholder) return "";
  if (item.kind === "movie") return "m:" + item.itemId;
  if (item.kind === "series") return "s:" + (item.seriesId || item.itemId);
  return "";
}
