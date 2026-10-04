// OpenSubtitles helpers with no network, ported from the Roku app's SubtitleTask.brs.
// The calls themselves are in data/opensubtitles.ts.

import { field, fieldStr, firstText, isArr, Json, toInt, toStr } from "./utils";

export const APP_USER_AGENT = "ARANplus v" + __APP_VERSION__;

export function osBase(baseUrl: string): string {
  const host = baseUrl.trim() === "" ? "api.opensubtitles.com" : baseUrl.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return "https://" + host + "/api/v1";
}

export function serverMessage(data: Json): string {
  const message = fieldStr(data, "message");
  if (message !== "") return message;
  const errors = field(data, "errors");
  if (isArr(errors)) {
    return errors
      .map((e) => toStr(e))
      .filter((text) => text !== "")
      .join(" ");
  }
  return "";
}

// Puts OpenSubtitles' own words and the HTTP code in the message, so a photo of the
// screen says exactly what went wrong.
export function osErrorText(code: number, data: Json): string {
  if (code <= 0) return "Couldn't reach OpenSubtitles. Check the TV's internet connection.";
  let said = "OpenSubtitles said HTTP " + code;
  const message = serverMessage(data);
  if (message !== "") said += ": " + message;
  if (code === 406 || code === 429) return said + ". Downloads reset within a day.";
  return said + ".";
}

// "bytes 0-65535/1234567890" -> 1234567890; -1 when unknown.
export function parseContentRangeTotal(header: string): number {
  const slash = header.indexOf("/");
  if (slash < 0) return -1;
  const digits = header.slice(slash + 1).trim();
  if (!/^\d+$/.test(digits)) return -1;
  return Number(digits);
}

// Provider titles carry tags and years: "EN - The Batman (2022)" -> { query: "The Batman", year: "2022" }.
export function cleanTitleForSearch(title: string): { query: string; year: string } {
  let text = title.trim();
  let year = "";
  const yearPattern = /\s*[([]?((19|20)\d\d)[)\]]?\s*$/;
  const found = yearPattern.exec(text);
  if (found && text.length > 6) {
    year = found[1];
    text = text.replace(yearPattern, "");
  }
  // Leading tags such as "EN - ", "|EN| ", "[4K] ", "FHD | ".
  const tag = /^\s*(\[[^\]]*\]|\|[^|]*\||[A-Z0-9]{2,3}\s*[-|]\s)\s*/;
  for (let i = 0; i < 3; i++) text = text.replace(tag, "");
  // Trailing tags such as "[MULTI-SUB]" or "(4K)".
  text = text.replace(/\s*(\[[^\]]*\]|\([^)]*\))\s*$/, "");
  return { query: text.trim(), year };
}

// OpenSubtitles wants parameters in alphabetical order with lowercase values; other
// orders get redirected.
export function osQuery(params: { [key: string]: string | number }): string {
  return Object.keys(params)
    .sort()
    .map((key) => ({ key: key.toLowerCase(), value: String(params[key]).toLowerCase() }))
    .filter((p) => p.value !== "")
    .map((p) => p.key + "=" + encodeURIComponent(p.value))
    .join("&");
}

export interface OsCandidate {
  fileId: string;
  release: string;
  hashMatch: boolean;
  machine: boolean;
  sdh: boolean;
  downloads: number;
  saved?: boolean; // saved for this title on the sync service, by any device
}

// /subtitles response -> the best six candidates, best first: made for this exact file,
// then human-made over machine-translated, then regular over SDH, then most downloaded.
export function parseOsResults(data: Json): OsCandidate[] {
  const list = field(data, "data");
  if (!isArr(list)) return [];
  const seen: { [id: string]: boolean } = {};
  const ranked: { candidate: OsCandidate; order: number; i: number }[] = [];
  list.forEach((entry, i) => {
    const attrs = field(entry, "attributes");
    const files = field(attrs, "files");
    if (!isArr(files) || files.length === 0) return;
    const fileId = fieldStr(files[0], "file_id");
    if (fileId === "" || seen[fileId]) return;
    seen[fileId] = true;
    const hashMatch = toStr(field(attrs, "moviehash_match")) === "true";
    const machine = toStr(field(attrs, "machine_translated")) === "true" || toStr(field(attrs, "ai_translated")) === "true";
    const sdh = toStr(field(attrs, "hearing_impaired")) === "true";
    const downloads = Math.min(toInt(field(attrs, "download_count")), 9999999);
    const rank = (hashMatch ? 0 : 4) + (machine ? 2 : 0) + (sdh ? 1 : 0);
    ranked.push({
      candidate: { fileId, release: firstText([field(attrs, "release"), field(files[0], "file_name")]), hashMatch, machine, sdh, downloads },
      order: rank * 10000000 + (9999999 - downloads),
      i,
    });
  });
  ranked.sort((a, b) => a.order - b.order || a.i - b.i);
  return ranked.slice(0, 6).map((r) => r.candidate);
}

export function subtitleLabel(candidate: OsCandidate): string {
  if (candidate.saved) return "English · saved for this title";
  let label: string;
  if (candidate.hashMatch) label = "English · matches this file";
  else {
    let release = candidate.release;
    if (release.length > 34) release = release.slice(0, 33) + "…";
    label = "English · " + (release === "" ? "online" : release);
  }
  if (candidate.sdh) label += " · SDH";
  if (candidate.machine) label += " · auto-translated";
  return label;
}

// What to search for: a movie by its TMDB id, or an episode by its series' TMDB id,
// season and number; by title when there's no id. `hash` is the file's moviehash, or "".
export interface FindRequest {
  kind: "movie" | "episode";
  title: string; // the movie's title or the series' name, as the provider has it
  tmdbId: string; // the movie's, or the series' for an episode
  season: number;
  episode: number;
  hash: string;
}

// The /subtitles queries to try in order: by TMDB id first, then by title when the id
// finds nothing (Roku's osFind).
export function findQueries(req: FindRequest): string[] {
  const base: { [key: string]: string | number } = { languages: "en" };
  if (req.hash) base.moviehash = req.hash;
  const byTitle = (): { [key: string]: string | number } => {
    const cleaned = cleanTitleForSearch(req.title);
    const params: { [key: string]: string | number } = { ...base, query: cleaned.query };
    if (req.kind === "movie" && cleaned.year) params.year = cleaned.year;
    return params;
  };
  const shape = (params: { [key: string]: string | number }) => {
    if (req.kind === "episode") {
      params.type = "episode";
      params.season_number = req.season;
      params.episode_number = req.episode;
    } else params.type = "movie";
    return osQuery(params);
  };
  const queries: string[] = [];
  if (req.tmdbId) {
    const params: { [key: string]: string | number } = { ...base };
    if (req.kind === "episode") params.parent_tmdb_id = req.tmdbId;
    else params.tmdb_id = req.tmdbId;
    queries.push(shape(params));
  }
  if (cleanTitleForSearch(req.title).query) queries.push(shape(byTitle()));
  return queries;
}
