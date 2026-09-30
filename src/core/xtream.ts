// Turns Xtream Codes API responses into plain data. Ported from the Roku app's
// XtreamParse.brs; no network or DOM here, so tests can feed in sample responses.

import { Item, makeItem, Row } from "./items";
import {
  clockToSeconds,
  field,
  fieldStr,
  firstText,
  firstUrl,
  isArr,
  isObj,
  Json,
  JsonObject,
  sizedImage,
  toInt,
  yearOf,
} from "./utils";

// TMDB sizes for a 1920x1080 screen (Roku used w185 posters and w780 backdrops at 720p).
export const POSTER_SIZE = "w342";
export const BACKDROP_SIZE = "w1280";
export const STILL_SIZE = "w300";

export type AuthResult = { ok: true } | { ok: false; error: string };

export function parseAuth(data: Json): AuthResult {
  const user = field(data, "user_info");
  if (!isObj(user) || toInt(user.auth) !== 1) return { ok: false, error: "That username or password wasn't accepted." };
  const status = fieldStr(user, "status").toLowerCase();
  if (status !== "" && status !== "active") return { ok: false, error: "The server says this account is " + status + "." };
  return { ok: true };
}

export interface Category {
  id: string;
  name: string;
}

export function parseCategories(data: Json): Category[] {
  const list: Category[] = [];
  if (!isArr(data)) return list;
  for (const raw of data) {
    const name = fieldStr(raw, "category_name");
    const id = fieldStr(raw, "category_id");
    if (id !== "" && name !== "" && !isAdultName(name)) list.push({ id, name });
  }
  return list;
}

export function isAdultName(name: string): boolean {
  const n = name.toLowerCase();
  return ["xxx", "adult", "18+", "porn"].some((word) => n.indexOf(word) >= 0);
}

export function isAdultItem(raw: Json): boolean {
  return toInt(field(raw, "is_adult")) === 1;
}

export interface CodecInfo {
  videoCodec: string;
  videoProfile: string;
  audioCodec: string;
}

// The provider's ffprobe summary of the file, when it has one.
export function codecFields(info: Json): CodecInfo {
  const video = field(info, "video");
  const audio = field(info, "audio");
  return {
    videoCodec: fieldStr(video, "codec_name"),
    videoProfile: fieldStr(video, "profile"),
    audioCodec: fieldStr(audio, "codec_name"),
  };
}

// Frame size from the same summary (0 when unknown); decides AVPlay's 4K mode.
export function videoWidth(info: Json): number {
  return toInt(field(field(info, "video"), "width"));
}

export interface VodInfo extends CodecInfo {
  description: string;
  year: string;
  genre: string;
  score: string;
  starring: string;
  directedBy: string;
  durationSecs: number;
  backdrop: string;
  poster: string;
  ext: string;
  tmdbId: string;
  width: number;
}

// get_vod_info -> details for a movie.
export function parseVodInfo(data: Json): VodInfo {
  const raw = field(data, "info");
  const info: JsonObject = isObj(raw) ? raw : {};
  const movie = field(data, "movie_data");
  let duration = toInt(info.duration_secs);
  if (duration === 0) duration = clockToSeconds(fieldStr(info, "duration"));
  const codecs = codecFields(info);
  return {
    description: firstText([info.plot, info.description]),
    year: yearOf(firstText([info.releasedate, info.release_date, info.year])),
    genre: fieldStr(info, "genre"),
    score: fieldStr(info, "rating"),
    starring: firstText([info.cast, info.actors]),
    directedBy: fieldStr(info, "director"),
    durationSecs: duration,
    backdrop: sizedImage(firstUrl(info.backdrop_path), BACKDROP_SIZE),
    poster: firstText([info.movie_image, info.cover_big]),
    ext: fieldStr(movie, "container_extension"),
    tmdbId: firstText([info.tmdb_id, info.tmdb]),
    width: videoWidth(info),
    videoCodec: codecs.videoCodec,
    videoProfile: codecs.videoProfile,
    audioCodec: codecs.audioCodec,
  };
}

export interface Episode extends CodecInfo {
  id: string;
  title: string;
  description: string;
  still: string;
  ext: string;
  seasonNo: number;
  episodeNo: number;
  durationSecs: number;
  width: number;
}

export interface Season {
  seasonNo: number;
  title: string;
  episodes: Episode[];
}

export interface SeriesInfo {
  name: string;
  description: string;
  year: string;
  genre: string;
  score: string;
  starring: string;
  directedBy: string;
  backdrop: string;
  poster: string;
  tmdbId: string;
}

// Strips "Show Name - S01E02 - " style prefixes from episode titles.
const EPISODE_PREFIX = /^.*?S\d+\s*E\d+\s*[-:.]*\s*/i;

// "Show Name - S01E02 - The Title" -> "The Title". Returns "" when nothing is left.
export function cleanEpisodeTitle(raw: string, seriesName: string): string {
  let title = raw.trim();
  if (seriesName !== "" && title.indexOf(seriesName) === 0) title = title.slice(seriesName.length);
  title = title.replace(EPISODE_PREFIX, "").trim();
  if (title.charAt(0) === "-") title = title.slice(1);
  return title.trim();
}

// get_series_info -> the show's details and its seasons in order, each with its episodes.
export function parseSeriesInfo(data: Json): { info: SeriesInfo; seasons: Season[] } {
  const rawInfo = field(data, "info");
  const info: JsonObject = isObj(rawInfo) ? rawInfo : {};
  const seriesName = fieldStr(info, "name");

  // "episodes" is normally {"1": [...], "2": [...]}, but PHP turns it into a
  // plain array when the season keys happen to be sequential.
  const bySeason: { [key: string]: Json[] } = {};
  let seasonCount = 0;
  const raw = field(data, "episodes");
  if (isObj(raw)) {
    for (const key of Object.keys(raw)) {
      const list = raw[key];
      if (isArr(list)) {
        bySeason[key] = list;
        seasonCount++;
      }
    }
  } else if (isArr(raw)) {
    for (const list of raw) {
      if (isArr(list) && list.length > 0) {
        let seasonKey = fieldStr(list[0], "season");
        if (seasonKey === "") seasonKey = String(seasonCount + 1);
        if (!(seasonKey in bySeason)) seasonCount++;
        bySeason[seasonKey] = list;
      }
    }
  }

  const seasonNames: { [key: string]: string } = {};
  const seasonsMeta = field(data, "seasons");
  if (isArr(seasonsMeta)) {
    for (const season of seasonsMeta) {
      const name = fieldStr(season, "name");
      if (name !== "") seasonNames[fieldStr(season, "season_number")] = name;
    }
  }

  const numbers = Object.keys(bySeason).map((key) => toInt(key));
  numbers.sort((a, b) => a - b);

  const seasons: Season[] = [];
  for (const number of numbers) {
    const key = String(number);
    const episodes = (bySeason[key] || []).filter(isObj);
    const sorted = episodes
      .map((ep, i) => ({ ep, order: toInt(ep.episode_num), i }))
      .sort((a, b) => a.order - b.order || a.i - b.i)
      .map((entry) => entry.ep);
    if (sorted.length === 0) continue;
    let title = Object.prototype.hasOwnProperty.call(seasonNames, key) ? seasonNames[key] : "Season " + key;
    if (number === 0) title = "Specials";
    seasons.push({ seasonNo: number, title, episodes: sorted.map((ep) => parseEpisode(ep, number, seriesName)) });
  }

  return {
    seasons,
    info: {
      name: seriesName,
      description: fieldStr(info, "plot"),
      year: yearOf(firstText([info.releaseDate, info.release_date, info.year])),
      genre: fieldStr(info, "genre"),
      score: fieldStr(info, "rating"),
      starring: fieldStr(info, "cast"),
      directedBy: fieldStr(info, "director"),
      backdrop: sizedImage(firstUrl(info.backdrop_path), BACKDROP_SIZE),
      poster: fieldStr(info, "cover"),
      tmdbId: firstText([info.tmdb_id, info.tmdb]),
    },
  };
}

function parseEpisode(ep: JsonObject, seasonNo: number, seriesName: string): Episode {
  const rawInfo = field(ep, "info");
  const info: JsonObject = isObj(rawInfo) ? rawInfo : {};
  const number = toInt(ep.episode_num);
  let title = cleanEpisodeTitle(firstText([info.name, ep.title]), seriesName);
  if (title === "") title = "Episode " + number;
  let duration = toInt(info.duration_secs);
  if (duration === 0) duration = clockToSeconds(fieldStr(info, "duration"));
  const codecs = codecFields(info);
  return {
    id: fieldStr(ep, "id"),
    title,
    description: fieldStr(info, "plot"),
    still: sizedImage(fieldStr(info, "movie_image"), STILL_SIZE),
    ext: fieldStr(ep, "container_extension"),
    seasonNo,
    episodeNo: number,
    durationSecs: duration,
    width: videoWidth(info),
    videoCodec: codecs.videoCodec,
    videoProfile: codecs.videoProfile,
    audioCodec: codecs.audioCodec,
  };
}

// One entry from get_vod_streams or get_series, reduced to what a list needs.
export interface ListItem {
  kind: "movie" | "series";
  id: string;
  name: string;
  poster: string;
  ext: string;
}

export function parseList(data: Json, kind: "movie" | "series"): ListItem[] {
  const items: ListItem[] = [];
  if (!isArr(data)) return items;
  for (const raw of data) {
    if (!isObj(raw) || isAdultItem(raw)) continue;
    const id = fieldStr(raw, kind === "series" ? "series_id" : "stream_id");
    if (id === "") continue;
    items.push({
      kind,
      id,
      name: fieldStr(raw, "name"),
      poster: sizedImage(fieldStr(raw, kind === "series" ? "cover" : "stream_icon"), POSTER_SIZE),
      ext: fieldStr(raw, "container_extension").toLowerCase(),
    });
  }
  return items;
}

// One home-screen row: the newest `limit` titles from get_vod_streams or get_series
// (by "added" for movies, "last_modified" for series), without adult titles.
export function buildRow(data: Json, kind: "movie" | "series", title: string, limit: number): Row {
  const sortField = kind === "series" ? "last_modified" : "added";
  const list: { raw: JsonObject; key: number; i: number }[] = [];
  if (isArr(data)) {
    data.forEach((raw, i) => {
      if (isObj(raw) && !isAdultItem(raw)) list.push({ raw, key: toInt(raw[sortField]), i });
    });
  }
  list.sort((a, b) => b.key - a.key || a.i - b.i);
  const items = list.slice(0, limit).map((entry) => (kind === "series" ? seriesItem(entry.raw) : movieItem(entry.raw)));
  return { title, items };
}

function movieItem(raw: JsonObject): Item {
  return makeItem({
    kind: "movie",
    title: fieldStr(raw, "name"),
    poster: sizedImage(fieldStr(raw, "stream_icon"), POSTER_SIZE),
    itemId: fieldStr(raw, "stream_id"),
    ext: fieldStr(raw, "container_extension"),
    tmdbId: firstText([raw.tmdb, raw.tmdb_id]),
    score: fieldStr(raw, "rating"),
    year: yearOf(firstText([raw.year, raw.releaseDate])),
    description: fieldStr(raw, "plot"),
    genre: fieldStr(raw, "genre"),
  });
}

function seriesItem(raw: JsonObject): Item {
  return makeItem({
    kind: "series",
    title: fieldStr(raw, "name"),
    poster: sizedImage(fieldStr(raw, "cover"), POSTER_SIZE),
    itemId: fieldStr(raw, "series_id"),
    seriesId: fieldStr(raw, "series_id"),
    tmdbId: firstText([raw.tmdb, raw.tmdb_id]),
    backdrop: sizedImage(firstUrl(raw.backdrop_path), BACKDROP_SIZE),
    description: fieldStr(raw, "plot"),
    year: yearOf(firstText([raw.releaseDate, raw.release_date, raw.year])),
    genre: fieldStr(raw, "genre"),
    score: fieldStr(raw, "rating"),
    starring: fieldStr(raw, "cast"),
    directedBy: fieldStr(raw, "director"),
    hasInfo: true,
  });
}

// An episode as an item, for the episode list and the player.
export function episodeItem(ep: Episode, seriesId: string): Item {
  return makeItem({
    kind: "episode",
    itemId: ep.id,
    seriesId,
    title: ep.title,
    description: ep.description,
    poster: ep.still,
    ext: ep.ext,
    seasonNo: ep.seasonNo,
    episodeNo: ep.episodeNo,
    durationSecs: ep.durationSecs,
    width: ep.width,
    videoCodec: ep.videoCodec,
    videoProfile: ep.videoProfile,
    audioCodec: ep.audioCodec,
    hasInfo: true,
  });
}
