// What screens show: a movie, series or episode, and rows of them. Ported from the
// Roku app's ItemDefaults/MakeItem/ApplyInfo/MetaLine (Utils.brs), with plain objects
// in place of ContentNodes.

import { formatRuntime, toInt, toStr } from "./utils";

// "category" and "seeAll" are cards that open a category's page (Categories tab, search
// results, and the tile at the end of every row).
export type ItemKind = "movie" | "series" | "episode" | "category" | "seeAll";

export interface Item {
  kind: ItemKind;
  itemId: string; // stream id (movie), series id (series) or episode id
  seriesId: string;
  title: string;
  description: string;
  poster: string;
  backdrop: string;
  ext: string;
  year: string;
  genre: string;
  score: string;
  starring: string;
  directedBy: string;
  durationSecs: number;
  seasonNo: number;
  episodeNo: number;
  videoCodec: string;
  videoProfile: string;
  audioCodec: string;
  width: number;
  tmdbId: string;
  hasInfo: boolean; // details from get_vod_info / get_series_info are in
  placeholder: boolean; // a pulsing poster while a row loads
  progress: number; // 0..1, Continue Watching
  caption: string; // "S1:E4" under a Continue Watching poster; "Movies · 104" on a category
  categoryId: string; // category and See all cards
  listKind: "movie" | "series" | ""; // what a category card's page lists
}

export interface Row {
  title: string;
  items: Item[];
  isContinue?: boolean;
}

export function makeItem(values: Partial<Item>): Item {
  const item: Item = {
    kind: "movie",
    itemId: "",
    seriesId: "",
    title: "",
    description: "",
    poster: "",
    backdrop: "",
    ext: "",
    year: "",
    genre: "",
    score: "",
    starring: "",
    directedBy: "",
    durationSecs: 0,
    seasonNo: 0,
    episodeNo: 0,
    videoCodec: "",
    videoProfile: "",
    audioCodec: "",
    width: 0,
    tmdbId: "",
    hasInfo: false,
    placeholder: false,
    progress: 0,
    caption: "",
    categoryId: "",
    listKind: "",
  };
  return Object.assign(item, values);
}

const INFO_TEXT_FIELDS: (keyof Item)[] = [
  "description",
  "year",
  "genre",
  "score",
  "starring",
  "directedBy",
  "backdrop",
  "ext",
  "videoCodec",
  "videoProfile",
  "audioCodec",
  "tmdbId",
];

// Copies details fetched from get_vod_info / get_series_info onto an item; blanks
// don't overwrite what the list already had.
export function applyInfo(item: Item, info: Partial<Record<keyof Item, unknown>>): void {
  const target = item as unknown as { [key: string]: unknown };
  for (const key of INFO_TEXT_FIELDS) {
    const value = toStr(info[key] as string).trim();
    if (value !== "") target[key] = value;
  }
  const duration = toInt(info.durationSecs as number);
  if (duration > 0) item.durationSecs = duration;
  const width = toInt(info.width as number);
  if (width > 0) item.width = width;
  item.hasInfo = true;
}

// "2019   ·   1h 30m   ·   Thriller   ·   Rated 7.0"
export function metaLine(item: Pick<Item, "year" | "durationSecs" | "genre" | "score">): string {
  const parts: string[] = [];
  if (item.year !== "") parts.push(item.year);
  if (item.durationSecs > 0) parts.push(formatRuntime(item.durationSecs));
  if (item.genre !== "") {
    const genres = item.genre.split(",");
    let text = genres[0].trim();
    if (genres.length > 1) text += ", " + genres[1].trim();
    parts.push(text);
  }
  const tenths = Math.floor(parseFloat(item.score || "0") * 10 + 0.5);
  if (tenths > 0) parts.push("Rated " + Math.floor(tenths / 10) + "." + (tenths % 10));
  return parts.join("   ·   ");
}
