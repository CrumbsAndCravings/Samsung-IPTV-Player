// Title search for the setup checks, so a specific show (say, one the Roku couldn't
// play) can be tried. Loads the whole movie or series list once per session: first in a
// single call, falling back to one call per category. The size and time of that single
// call are logged, which tells the M5 search index what this provider can take.

import { log } from "../core/log";
import { apiUrl, Creds, normalizeSearch } from "../core/utils";
import { ListItem, parseCategories, parseList } from "../core/xtream";
import { eachLimited, getJson } from "../platform/http";

export interface LibraryStats {
  kind: "movie" | "series";
  count: number;
  method: "single" | "categories";
  bytes: number;
  ms: number;
}

const cache: { [kind: string]: ListItem[] } = {};
export const libraryStats: LibraryStats[] = [];

export function loadLibrary(creds: Creds, kind: "movie" | "series", progress: (text: string) => void): Promise<ListItem[]> {
  if (cache[kind]) return Promise.resolve(cache[kind]);
  const action = kind === "series" ? "get_series" : "get_vod_streams";
  const noun = kind === "series" ? "series" : "movies";
  const started = Date.now();
  progress("Loading all " + noun + " in one request…");
  return getJson(apiUrl(creds, action), 45000).then((all) => {
    if (all.ok) {
      const items = parseList(all.data, kind);
      libraryStats.push({ kind, count: items.length, method: "single", bytes: all.bytes, ms: all.ms });
      log("library", kind, "single call:", items.length, "titles,", Math.round(all.bytes / 1024), "KB in", all.ms, "ms");
      cache[kind] = items;
      return items;
    }
    log("library", kind, "single call failed:", all.error, "- trying per category");
    return loadByCategory(creds, kind, progress).then((items) => {
      libraryStats.push({ kind, count: items.length, method: "categories", bytes: 0, ms: Date.now() - started });
      cache[kind] = items;
      return items;
    });
  });
}

function loadByCategory(creds: Creds, kind: "movie" | "series", progress: (text: string) => void): Promise<ListItem[]> {
  const listAction = kind === "series" ? "get_series" : "get_vod_streams";
  const catAction = kind === "series" ? "get_series_categories" : "get_vod_categories";
  const items: ListItem[] = [];
  const seen: { [id: string]: boolean } = {};
  return getJson(apiUrl(creds, catAction)).then((res) => {
    const categories = res.ok ? parseCategories(res.data) : [];
    let done = 0;
    return eachLimited(categories, 3, (category) =>
      getJson(apiUrl(creds, listAction, { category_id: category.id })).then((list) => {
        done++;
        progress("Loading category " + done + " of " + categories.length + "…");
        if (!list.ok) return;
        for (const item of parseList(list.data, kind)) {
          if (!seen[item.id]) {
            seen[item.id] = true;
            items.push(item);
          }
        }
      }),
    ).then(() => items);
  });
}

// Every typed word must appear. Titles starting with the query come first, then titles
// where it starts a word, then the rest; shorter titles first within each (as on Roku).
export function matchTitles(items: ListItem[], query: string, limit: number): ListItem[] {
  const q = normalizeSearch(query);
  if (q === "") return [];
  const words = q.split(" ").filter((w) => w !== "");
  const phrase = " " + q;
  const matches: { item: ListItem; order: number }[] = [];
  for (const item of items) {
    const name = " " + normalizeSearch(item.name);
    if (!words.every((word) => name.indexOf(word) >= 0)) continue;
    const rank = name.indexOf(phrase) === 0 ? 0 : name.indexOf(phrase) > 0 ? 1 : 2;
    matches.push({ item, order: rank * 100000 + name.length });
  }
  matches.sort((a, b) => a.order - b.order);
  return matches.slice(0, limit).map((m) => m.item);
}
