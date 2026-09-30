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

// Adds a get_vod_streams or get_series response.
export function indexAdd(index: SearchIndex, data: Json, kind: "movie" | "series"): void {
  if (!isArr(data)) return;
  const letter = kind === "series" ? "s" : "m";
  const idField = kind === "series" ? "series_id" : "stream_id";
  const iconField = kind === "series" ? "cover" : "stream_icon";
  for (const raw of data) {
    if (!isObj(raw) || toInt(raw.is_adult) === 1) continue;
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
  for (let i = 0; i < names.length; i++) {
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
    if (matches.length >= 2000) break;
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
