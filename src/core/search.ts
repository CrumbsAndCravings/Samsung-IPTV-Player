// In-memory title index for Search, ported from the Roku app's SearchIndex.brs. Names
// and records are parallel arrays of plain strings (not objects) to keep memory low on
// catalogs of tens of thousands (this provider has about 28,000 titles).
//
//   names[i]    " " + normalizeSearch(title); the leading space marks a word start
//   records[i]  kind letter, id, ext, poster URL, title joined by \u001e; "-" for blanks

import { Item, makeItem, Row } from "./items";
import { fieldStr, isArr, isObj, Json, normalizeSearch, sizedImage, toInt } from "./utils";
import { POSTER_SIZE } from "./xtream";

const SEP = "\u001e";
const MATCH_CAP = 2000; // per kind, before ranking

export interface SearchIndex {
  names: string[];
  records: string[];
  seen: { [key: string]: boolean };
}

export function newSearchIndex(): SearchIndex {
  return { names: [], records: [], seen: {} };
}

function orDash(text: string): string {
  return text === "" ? "-" : text;
}

function fromDash(text: string): string {
  return text === "-" ? "" : text;
}

// Adds a get_vod_streams or get_series response. With `allowed`, only titles in those
// categories are kept (the whole-library answer includes the adult categories).
export function indexAdd(index: SearchIndex, data: Json, kind: "movie" | "series", allowed?: { [id: string]: boolean }): void {
  if (!isArr(data)) return;
  const letter = kind === "series" ? "s" : "m";
  const idField = kind === "series" ? "series_id" : "stream_id";
  const iconField = kind === "series" ? "cover" : "stream_icon";
  for (const raw of data) {
    if (!isObj(raw) || toInt(raw.is_adult) === 1) continue;
    if (allowed && !allowed[fieldStr(raw, "category_id")]) continue;
    const id = fieldStr(raw, idField);
    const key = letter + id;
    if (id === "" || index.seen[key]) continue;
    index.seen[key] = true;
    const title = fieldStr(raw, "name");
    index.names.push(" " + normalizeSearch(title));
    index.records.push([letter, id, orDash(fieldStr(raw, "container_extension")), orDash(fieldStr(raw, iconField)), orDash(title)].join(SEP));
  }
}

// Best matches as up to two rows, Movies and Series, of `limit` each. Every word typed
// must appear in the title. Titles starting with the query rank first, then titles
// where it starts a word, then the rest; shorter titles first within each.
export function indexSearch(index: SearchIndex, query: string, limit: number): Row[] {
  const q = normalizeSearch(query);
  if (q === "") return [];
  const words = q.split(" ").filter((w) => w !== "");
  const phrase = " " + q;
  const matches: { k: number; i: number }[] = [];
  const names = index.names;
  // Each kind gets its own cap, so a short query that matches thousands of movies
  // still finds series.
  let movieCount = 0;
  let seriesCount = 0;
  for (let i = 0; i < names.length; i++) {
    const isMovie = index.records[i].charCodeAt(0) === 109; // "m"
    if (isMovie ? movieCount >= MATCH_CAP : seriesCount >= MATCH_CAP) continue;
    const name = names[i];
    let matched = true;
    for (const word of words) {
      if (name.indexOf(word) < 0) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const rank = name.indexOf(phrase) === 0 ? 0 : name.indexOf(phrase) > 0 ? 1 : 2;
    matches.push({ k: rank * 100000 + name.length, i });
    if (isMovie) movieCount++;
    else seriesCount++;
    if (movieCount >= MATCH_CAP && seriesCount >= MATCH_CAP) break;
  }
  matches.sort((a, b) => a.k - b.k || a.i - b.i);

  const movies: Item[] = [];
  const series: Item[] = [];
  for (const match of matches) {
    const parts = index.records[match.i].split(SEP);
    if (parts.length < 5) continue;
    const target = parts[0] === "m" ? movies : series;
    if (target.length < limit) {
      const kind = parts[0] === "m" ? "movie" : "series";
      target.push(
        makeItem({
          kind,
          title: fromDash(parts[4]),
          poster: sizedImage(fromDash(parts[3]), POSTER_SIZE),
          itemId: parts[1],
          seriesId: kind === "series" ? parts[1] : "",
          ext: fromDash(parts[2]),
        }),
      );
    }
    if (movies.length >= limit && series.length >= limit) break;
  }
  const rows: Row[] = [];
  if (movies.length > 0) rows.push({ title: "Movies", items: movies });
  if (series.length > 0) rows.push({ title: "Series", items: series });
  return rows;
}

export interface LibraryStatus {
  done: number; // lists loaded (or given up on)
  total: number; // 0 until the categories are known
  failed: number;
  titles: number;
  error: string; // the categories couldn't be loaded
}

// The line under the keyboard (Roku's onStatus).
export function libraryStatusText(status: LibraryStatus): string {
  if (status.error) return "Couldn't load your library. " + status.error + " Leave Search and come back to try again.";
  if (status.total === 0) return "Getting your library ready for search…";
  const titles = String(status.titles).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (status.done < status.total) return "Loading your library: " + status.done + " of " + status.total + " lists (" + titles + " titles so far)";
  const missed = status.failed > 0 ? " (" + status.failed + (status.failed === 1 ? " list" : " lists") + " didn't load)" : "";
  return "Searching all " + titles + " titles" + missed;
}
