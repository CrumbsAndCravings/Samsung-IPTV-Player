// The library index for Search and category pages, ported from the Roku app's
// SearchIndex.brs (docs/features.md §6). Names and records are parallel arrays of plain
// strings (not objects) to keep memory low on catalogs of tens of thousands.
//
//   names[i]    " " + normalizeSearch(title); the leading space marks a word start
//   records[i]  kind letter, id, ext, poster URL, title, category id, date added
//               (seconds), year, joined by \u001e; "-" for blanks
//
// `categories` holds the provider's categories with their title counts, so search can
// offer them and a category's page can list all its titles from here, without asking
// the provider.

import { classifyCategory } from "./categories";
import { Item, makeItem, Row } from "./items";
import { commas, fieldStr, firstText, isArr, isObj, Json, normalizeSearch, sizedImage, splitTitle, toInt, yearOf } from "./utils";
import { POSTER_SIZE } from "./xtream";

const SEP = "\u001e";
const SCALE = 10000000; // positions in the index stay below this
export const FILE_FORMAT = "aranplus-search-4";

type Kind = "movie" | "series";

export interface IndexCategory {
  key: string; // "m:<id>" or "s:<id>"
  kind: Kind;
  id: string;
  name: string; // as the provider has it
  label: string; // tidied ("Action · 4K")
  norm: string; // " " + normalizeSearch(label)
  count: number;
}

export interface SearchIndex {
  names: string[];
  records: string[];
  seen: { [key: string]: boolean };
  savedAt: number; // seconds; 0 until saved
  categories: IndexCategory[];
  catIndex: { [key: string]: number };
}

export function newSearchIndex(): SearchIndex {
  return { names: [], records: [], seen: {}, savedAt: 0, categories: [], catIndex: {} };
}

function letterOf(kind: Kind): string {
  return kind === "series" ? "s" : "m";
}

function orDash(text: string): string {
  return text === "" ? "-" : text;
}

function fromDash(text: string): string {
  return text === "-" ? "" : text;
}

function addCategory(index: SearchIndex, key: string, kind: Kind, id: string, name: string, count: number, year: number): void {
  if (id === "" || Object.prototype.hasOwnProperty.call(index.catIndex, key)) return;
  const label = classifyCategory(name, year).label;
  index.catIndex[key] = index.categories.length;
  index.categories.push({ key, kind, id, name, label, norm: " " + normalizeSearch(label), count });
}

// Records the provider's categories for one kind, as parseCategories returns them.
export function indexSetCategories(index: SearchIndex, kind: Kind, list: { id: string; name: string }[], year: number): void {
  for (const category of list) addCategory(index, letterOf(kind) + ":" + category.id, kind, category.id, category.name, 0, year);
}

// Adds a get_vod_streams or get_series response. With `allowed`, only titles in those
// categories are kept (the whole-library answer includes the adult categories).
// `fallbackCategory` is the category the list was asked for, for titles that don't say.
export function indexAdd(index: SearchIndex, data: Json, kind: Kind, allowed?: { [id: string]: boolean }, fallbackCategory = ""): void {
  if (!isArr(data)) return;
  const letter = letterOf(kind);
  const idField = kind === "series" ? "series_id" : "stream_id";
  const iconField = kind === "series" ? "cover" : "stream_icon";
  const addedField = kind === "series" ? "last_modified" : "added";
  for (const raw of data) {
    if (!isObj(raw) || toInt(raw.is_adult) === 1) continue;
    const ownCategory = fieldStr(raw, "category_id");
    if (allowed && ownCategory !== "" && !allowed[ownCategory]) continue;
    const id = fieldStr(raw, idField);
    if (id === "" || index.seen[letter + id]) continue;
    index.seen[letter + id] = true;
    const named = splitTitle(fieldStr(raw, "name"));
    const year = yearOf(firstText([raw.year, raw.releaseDate, raw.release_date])) || named.year;
    const category = ownCategory || fallbackCategory;
    index.names.push(" " + normalizeSearch(named.title));
    index.records.push(
      [letter, id, orDash(fieldStr(raw, "container_extension")), orDash(fieldStr(raw, iconField)), orDash(named.title), orDash(category), String(toInt(raw[addedField])), orDash(year)].join(SEP),
    );
    const position = index.catIndex[letter + ":" + category];
    if (position !== undefined) index.categories[position].count++;
  }
}

function toItem(parts: string[], kind: Kind): Item {
  return makeItem({
    kind,
    title: fromDash(parts[4]),
    poster: sizedImage(fromDash(parts[3]), POSTER_SIZE),
    itemId: parts[1],
    seriesId: kind === "series" ? parts[1] : "",
    ext: fromDash(parts[2]),
    year: parts.length >= 8 ? fromDash(parts[7]) : "",
  });
}

function wordsOf(q: string): string[] {
  return q.split(" ").filter((w) => w !== "");
}

// Every word typed appears in the name; one or two letters only at the start of a word.
function nameMatches(name: string, words: string[], phrase: string): boolean {
  if (words.length === 0) return true;
  if (phrase.length < 4) return name.indexOf(phrase) >= 0;
  for (const word of words) if (name.indexOf(word) < 0) return false;
  return true;
}

// 0 when the name starts with the query, 1 when a word does, 2 otherwise.
function matchRank(name: string, phrase: string): number {
  if (name.indexOf(phrase) === 0) return 0;
  return name.indexOf(phrase) > 0 ? 1 : 2;
}

// A card for a category: its tidy name and what it holds ("Movies · 104").
export function categoryItem(category: { id: string; kind: Kind; label: string; count: number }): Item {
  const kindName = category.kind === "series" ? "Series" : "Movies";
  return makeItem({
    kind: "category",
    title: category.label,
    caption: category.count > 0 ? kindName + " · " + commas(category.count) : kindName,
    categoryId: category.id,
    listKind: category.kind,
  });
}

// Categories whose tidy name matches, like "Punjabi" for "punj": names starting with
// the query first, then the biggest. At most 20, and only categories that hold titles.
function categoryRow(index: SearchIndex, words: string[], phrase: string): Row | null {
  const matches: { order: number; category: IndexCategory }[] = [];
  for (const category of index.categories) {
    if (category.count <= 0 || !nameMatches(category.norm, words, phrase)) continue;
    const rank = category.norm.indexOf(phrase) === 0 ? 0 : 1;
    matches.push({ order: rank * 1000000 + (999999 - Math.min(category.count, 999999)), category });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.order - b.order);
  return { title: "Categories", items: matches.slice(0, 20).map((m) => categoryItem(m.category)) };
}

// Best matches as rows: Categories, Movies, Series (each up to `limit`). Every word
// typed must appear in the title. Titles starting with the query rank first, then
// titles where it starts a word, then the rest; shorter titles first within each.
//
// Every match in the whole library is ranked (there is no cap on how many are looked
// at), and movies and series are ranked separately, so a short query that matches
// thousands of movies can't push the series out. One or two letters only match the
// start of a word: "th" finds "The Office" but not "Other", which keeps typing quick.
export function indexSearch(index: SearchIndex, query: string, limit: number): Row[] {
  const q = normalizeSearch(query);
  if (q === "") return [];
  const words = wordsOf(q);
  const phrase = " " + q;
  // One number per match (rank, then title length, then position in the index), which
  // sorts the right way and takes far less memory than an object per match.
  const movieKeys: number[] = [];
  const seriesKeys: number[] = [];
  const names = index.names;
  const records = index.records;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!nameMatches(name, words, phrase)) continue;
    const key = (matchRank(name, phrase) * 1000 + Math.min(name.length, 999)) * SCALE + i;
    if (records[i].charCodeAt(0) === 115) seriesKeys.push(key); // "s"
    else movieKeys.push(key);
  }
  const rows: Row[] = [];
  const categories = categoryRow(index, words, phrase);
  if (categories) rows.push(categories);
  const build = (keys: number[], title: string, kind: Kind) => {
    keys.sort((a, b) => a - b);
    const items: Item[] = [];
    for (const key of keys) {
      if (items.length >= limit) break;
      const parts = records[key % SCALE].split(SEP);
      if (parts.length >= 5) items.push(toItem(parts, kind));
    }
    if (items.length > 0) rows.push({ title, items });
  };
  build(movieKeys, "Movies", "movie");
  build(seriesKeys, "Series", "series");
  return rows;
}

// All titles of one category, newest first (up to `limit`), and how many it has. With a
// query, only titles whose name holds every word typed, best matches first (names
// starting with it, then words starting with it), newest first among equals; `total`
// is then the number of matches.
export function indexBrowse(index: SearchIndex, kind: Kind, categoryId: string, limit: number, query = ""): { items: Item[]; total: number } {
  const letter = letterOf(kind);
  const marker = SEP + categoryId + SEP;
  const q = normalizeSearch(query);
  const words = wordsOf(q);
  const phrase = " " + q;
  const found: { order: number; parts: string[] }[] = [];
  const records = index.records;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // A quick look for the id before splitting keeps big libraries fast.
    if (record.charAt(0) !== letter || record.indexOf(marker) < 0 || !nameMatches(index.names[i], words, phrase)) continue;
    const parts = record.split(SEP);
    if (parts.length < 7 || parts[5] !== categoryId) continue;
    // Newest first; with a query, the match's rank comes before the date.
    let order = -toInt(parts[6]);
    if (q !== "") order += matchRank(index.names[i], phrase) * 1e10;
    found.push({ order, parts });
  }
  found.sort((a, b) => a.order - b.order);
  return { items: found.slice(0, limit).map((f) => toItem(f.parts, kind)), total: found.length };
}

// How many titles each category holds ("movie:123" -> 104).
export function indexCounts(index: SearchIndex): { [key: string]: number } {
  const counts: { [key: string]: number } = {};
  for (const category of index.categories) counts[category.kind + ":" + category.id] = category.count;
  return counts;
}

// --- Picked for you ------------------------------------------------------------------
//
// Home's My List, "Top picks for you" and "Because you watched" rows, from the stored
// library and what you watch (core/taste.ts), so nothing is asked of the provider. Two
// passes over the library, as on the Roku: one to find the titles named (indexFind), one
// to pick (indexPersonal).

// The records of the titles in `keys` ("m:<id>" or "s:<id>"): { "m:123": parts }. Titles
// the library doesn't hold (other languages) are left out.
export function indexFind(index: SearchIndex, keys: string[]): { [key: string]: string[] } {
  const wanted: { [prefix: string]: string } = {};
  for (const key of keys) if (key.length > 2) wanted[key.charAt(0) + SEP + key.slice(2) + SEP] = key;
  const found: { [key: string]: string[] } = {};
  if (Object.keys(wanted).length === 0) return found;
  for (const record of index.records) {
    const cut = record.indexOf(SEP, 2);
    if (cut < 0) continue;
    const key = wanted[record.slice(0, cut + 1)];
    if (key !== undefined && !found[key]) found[key] = record.split(SEP);
  }
  return found;
}

// Each found title's category, as a likings key: { "m:123": "vod:12" }.
export function categoriesFrom(found: { [key: string]: string[] }): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const key of Object.keys(found)) {
    const parts = found[key];
    if (parts.length >= 6 && parts[5] !== "-") out[key] = (parts[0] === "s" ? "series:" : "vod:") + parts[5];
  }
  return out;
}

// My List's row in its order: from the library when it holds the title, else its name
// card (`fallback`).
export function listItems(list: { k: string }[], found: { [key: string]: string[] }, fallback: (entry: { k: string }) => Item): Item[] {
  return list.map((entry) => {
    const parts = found[entry.k];
    return parts && parts.length >= 5 ? toItem(parts, parts[0] === "s" ? "series" : "movie") : fallback(entry);
  });
}

// The start of a title that its sequels share: its first two words (a leading "the", "a"
// or "an" aside), or its one word when it has only one of four letters or more, as the
// index writes names (" carry on"); "" when there's nothing distinctive.
export function titleStem(name: string): string {
  const words = normalizeSearch(name)
    .split(" ")
    .filter((w) => w !== "");
  if (words.length > 1 && (words[0] === "the" || words[0] === "a" || words[0] === "an")) words.shift();
  if (words.length >= 2) return " " + words[0] + " " + words[1];
  if (words.length === 1 && words[0].length >= 4) return " " + words[0];
  return "";
}

// How new a title is, from 1 (just added) down towards 0: halving every 90 days since it
// was added, or by its year when the date is missing.
function freshness(parts: string[], now: number, thisYear: number): number {
  const added = parseInt(parts[6], 10) || 0;
  if (added > 0) return Math.pow(0.5, Math.max(0, (now - added) / 86400) / 90);
  const year = parts.length >= 8 ? parseInt(fromDash(parts[7]), 10) || 0 : 0;
  return year >= thisYear - 1 ? 0.5 : 0.1;
}

export interface BecauseTitle {
  k: string;
  n: string;
  category: string; // its likings key, "vod:12"
}

// "Top picks for you" and the "Because you watched" rows, in one pass over the library:
// { picks, because } (one list for each of `because`).
//
// Top picks: titles from the 6 categories you like most (`scores`, likingFrom), the more
// liked and the newer the higher, at most 8 from one category, 30 in all.
// Because you watched: first the same series of films (titles starting with the same
// words, like "Carry On Jatta 2" after "Carry On Jatta"), then the newest from its
// category, 20 in all.
// Each title once in a row, and none you've watched: `exclude` holds their keys ("m:123")
// and their names as the index writes them (" carry on jatta"), for their other copies.
export function indexPersonal(index: SearchIndex, scores: { [key: string]: number }, exclude: { [key: string]: boolean }, because: BecauseTitle[], now: number, thisYear: number): { picks: Item[]; because: Item[][] } {
  // The liked categories, each as a share of the most liked one.
  const ranked = Object.keys(scores)
    .filter((key) => scores[key] > 0)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, 6);
  const top: { [key: string]: number } = {};
  const markers: { [letter: string]: string[] } = { m: [], s: [] };
  if (ranked.length > 0) {
    const best = scores[ranked[0]];
    for (const key of ranked) {
      top[key] = scores[key] / best;
      const cut = key.indexOf(":");
      markers[key.slice(0, cut) === "series" ? "s" : "m"].push(SEP + key.slice(cut + 1) + SEP);
    }
  }
  const titles = because.map((title) => {
    const id = title.category.slice(title.category.indexOf(":") + 1);
    return { k: title.k, letter: title.k.charAt(0), id, marker: SEP + id + SEP, stem: titleStem(title.n), own: " " + normalizeSearch(title.n), found: [] as { order: number; at: number }[] };
  });

  const picked: { order: number; at: number; category: string }[] = [];
  const records = index.records;
  const names = index.names;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const letter = record.charAt(0);
    let parts: string[] | null = null;
    // A quick look for an id before splitting keeps big libraries fast.
    const wanted = markers[letter];
    if (wanted) {
      for (const marker of wanted) {
        if (record.indexOf(marker) > 0) {
          parts = record.split(SEP);
          break;
        }
      }
      if (parts && parts.length >= 7) {
        const category = (letter === "s" ? "series:" : "vod:") + parts[5];
        const liking = top[category];
        if (liking !== undefined && !exclude[letter + ":" + parts[1]]) picked.push({ order: -liking * freshness(parts, now, thisYear), at: i, category });
      }
    }
    for (const title of titles) {
      if (title.letter !== letter) continue;
      const family = title.stem !== "" && names[i].slice(0, title.stem.length) === title.stem;
      if (!family && record.indexOf(title.marker) < 0) continue;
      if (!parts) parts = record.split(SEP);
      if (parts.length < 7) continue;
      const key = letter + ":" + parts[1];
      if (key !== title.k && !exclude[key] && (family || parts[5] === title.id)) {
        // The family first (in tens of billions), then the newest.
        let order = -(parseInt(parts[6], 10) || 0);
        if (!family) order += 10000000000;
        title.found.push({ order, at: i });
      }
    }
  }

  const itemAt = (at: number): Item => {
    const parts = records[at].split(SEP);
    return toItem(parts, parts[0] === "s" ? "series" : "movie");
  };
  const out: { picks: Item[]; because: Item[][] } = { picks: [], because: [] };
  picked.sort((a, b) => a.order - b.order || a.at - b.at);
  const perCategory: { [key: string]: number } = {};
  let seen: { [name: string]: boolean } = {};
  for (const match of picked) {
    if (out.picks.length >= 30) break;
    const name = names[match.at];
    const taken = perCategory[match.category] || 0;
    if (taken < 8 && !seen[name] && !exclude[name]) {
      seen[name] = true;
      perCategory[match.category] = taken + 1;
      out.picks.push(itemAt(match.at));
    }
  }
  for (const title of titles) {
    const items: Item[] = [];
    title.found.sort((a, b) => a.order - b.order || a.at - b.at);
    seen = {};
    seen[title.own] = true;
    for (const match of title.found) {
      if (items.length >= 20) break;
      const name = names[match.at];
      if (!seen[name] && !exclude[name]) {
        seen[name] = true;
        items.push(itemAt(match.at));
      }
    }
    out.because.push(items);
  }
  return out;
}

// --- Keeping the index between launches ---------------------------------------------
//
// Loading a whole library from the provider takes minutes, so a finished index is saved
// and searched straight away on later launches (data/library.ts refreshes it in the
// background once it's a day old). The text is a header line (format, owner, time
// saved, title count, category count), then every name, then every record, then every
// category (key, kind, id, title count, name; tab-separated), one per line.

export function serializeIndex(index: SearchIndex, owner: string, savedAt: number): string {
  const tab = "\t";
  const flat = (text: string) => text.replace(/[\r\n\t]/g, " ");
  const lines = [FILE_FORMAT + tab + flat(owner) + tab + savedAt + tab + index.names.length + tab + index.categories.length];
  for (const name of index.names) lines.push(flat(name));
  for (const record of index.records) lines.push(flat(record));
  for (const c of index.categories) lines.push([c.key, c.kind, c.id, c.count, flat(c.name)].join(tab));
  return lines.join("\n");
}

// Whether a saved library belongs to this account: the same username ("<server>
// <username>"), wherever the server is now, since a provider that moves to a new address
// keeps its titles and their ids. The next daily refresh brings anything new.
export function sameOwner(saved: string, owner: string): boolean {
  if (saved === owner) return true;
  const a = saved.split(" ");
  const b = owner.split(" ");
  return a.length === 2 && b.length === 2 && a[1] !== "" && a[1] === b[1];
}

// The saved index for `owner` (with savedAt set), or null.
export function parseIndex(text: string, owner: string, year: number): SearchIndex | null {
  if (!text) return null;
  const lines = text.split("\n");
  const header = lines[0].split("\t");
  if (header.length < 5 || header[0] !== FILE_FORMAT || !sameOwner(header[1], owner.replace(/[\r\n\t]/g, " "))) return null;
  const count = toInt(header[3]);
  const catCount = toInt(header[4]);
  if (count <= 0 || lines.length !== 1 + count * 2 + catCount) return null;
  const index = newSearchIndex();
  index.savedAt = toInt(header[2]);
  index.names = lines.slice(1, 1 + count);
  index.records = lines.slice(1 + count, 1 + count * 2);
  for (let i = 0; i < catCount; i++) {
    const fields = lines[1 + count * 2 + i].split("\t");
    if (fields.length >= 5 && (fields[1] === "movie" || fields[1] === "series")) addCategory(index, fields[0], fields[1], fields[2], fields[4], toInt(fields[3]), year);
  }
  return index;
}

export interface LibraryStatus {
  done: number; // lists loaded (or given up on)
  total: number; // 0 until the categories are known
  failed: number;
  titles: number;
  error: string; // the categories couldn't be loaded
  stopped: boolean; // the provider stopped answering; the rest wait for next time
}

// The line under the keyboard (Roku's onStatus).
export function libraryStatusText(status: LibraryStatus): string {
  if (status.error) return "Couldn't load your library. " + status.error + " Leave Search and come back to try again.";
  if (status.stopped && status.total === 0) return "Your provider isn't answering, so search can't load your library. Try again later.";
  if (status.total === 0) return "Getting your library ready for search…";
  const titles = commas(status.titles);
  if (status.stopped) return "Searching " + titles + " titles. Your provider stopped answering, so the rest wait until you open ARAN+ again.";
  if (status.done < status.total) return "Loading your library: " + status.done + " of " + status.total + " lists (" + titles + " titles so far)";
  const missed = status.failed > 0 ? " (" + status.failed + (status.failed === 1 ? " list" : " lists") + " didn't load)" : "";
  return "Searching all " + titles + " titles" + missed;
}
