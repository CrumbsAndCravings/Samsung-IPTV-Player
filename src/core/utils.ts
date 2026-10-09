// Shared helpers, ported from the Roku app's Utils.brs. Xtream servers are loose with
// types (numbers arrive as strings, empty objects arrive as []), so everything read from
// the API goes through these. No DOM here.

export type Json = unknown;
export type JsonObject = { [key: string]: Json };

export interface Creds {
  server: string;
  username: string;
  password: string;
}

export function isObj(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isArr(value: Json): value is Json[] {
  return Array.isArray(value);
}

export function toStr(value: Json): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

export function toInt(value: Json): number {
  if (typeof value === "number") return isFinite(value) ? Math.floor(value) : 0;
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    return isNaN(n) ? 0 : n;
  }
  if (value === true) return 1;
  return 0;
}

// Reads obj[key] without crashing when obj is not an object.
export function field(obj: Json, key: string): Json {
  return isObj(obj) ? obj[key] : undefined;
}

export function fieldStr(obj: Json, key: string): string {
  return toStr(field(obj, key)).trim();
}

export function firstText(values: Json[]): string {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text !== "") return text;
  }
  return "";
}

// backdrop_path is usually an array of URLs, sometimes a single string.
export function firstUrl(value: Json): string {
  if (isArr(value)) {
    for (const entry of value) {
      const url = toStr(entry).trim();
      if (url !== "") return url;
    }
    return "";
  }
  return toStr(value).trim();
}

// Up to 5 backdrops from backdrop_path (a list, or one URL), sized and each once: the
// pictures of a title's moving banner (ui/backdrop.ts; the Roku app's BackdropList).
export function backdropList(value: Json, size: string): string[] {
  const list = isArr(value) ? value : [value];
  const urls: string[] = [];
  for (const entry of list) {
    const url = sizedImage(toStr(entry).trim(), size);
    if (url !== "" && urls.indexOf(url) < 0 && urls.length < 5) urls.push(url);
  }
  return urls;
}

// TMDB serves every size from the same path, so ask for one that fits the screen.
export function sizedImage(url: string, size: string): string {
  const marker = "image.tmdb.org/t/p/";
  const found = url.indexOf(marker);
  if (found < 0) return url;
  const start = found + marker.length;
  const slash = url.indexOf("/", start);
  if (slash < 0) return url;
  return url.slice(0, start) + size + url.slice(slash);
}

export function yearOf(dateText: string): string {
  const year = dateText.trim().slice(0, 4);
  if (year.length === 4 && toInt(year) > 1900) return year;
  return "";
}

// "01:45:30" or "45:30" -> seconds
export function clockToSeconds(clock: string): number {
  let total = 0;
  for (const part of clock.trim().split(":")) total = total * 60 + toInt(part);
  return total;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

// 5234 -> "1:27:14"
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (h > 0) return h + ":" + pad2(mins) + ":" + pad2(secs);
  return mins + ":" + pad2(secs);
}

// 5234 -> "1h 27m"
export function formatRuntime(seconds: number): string {
  const totalMins = Math.floor((seconds + 30) / 60);
  const h = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (h > 0 && mins > 0) return h + "h " + mins + "m";
  if (h > 0) return h + "h";
  return mins + "m";
}

// --- Search -------------------------------------------------------------------

const FOLDS: [RegExp, string][] = [
  [/[áàâäãåÁÀÂÄÃÅ]/g, "a"],
  [/[éèêëÉÈÊË]/g, "e"],
  [/[íìîïÍÌÎÏ]/g, "i"],
  [/[óòôöõøÓÒÔÖÕØ]/g, "o"],
  [/[úùûüÚÙÛÜ]/g, "u"],
  [/[ñÑ]/g, "n"],
  [/[çÇ]/g, "c"],
  [/[‘’]/g, "'"],
];
const NON_ASCII = /[\u0080-￿]/;
const APOSTROPHES = /['`]/g;
const PUNCTUATION = /[\s\-_.:,;!?"()[\]{}|/\\&+*#@~<>=]+/g;

// Lowercases and simplifies text for matching: accents folded, apostrophes dropped,
// other punctuation turned into single spaces.
export function normalizeSearch(text: string): string {
  let t = text.toLowerCase();
  if (NON_ASCII.test(t)) {
    for (const [pattern, plain] of FOLDS) t = t.replace(pattern, plain);
  }
  t = t.replace(APOSTROPHES, "");
  t = t.replace(PUNCTUATION, " ");
  return t.trim();
}

// --- Xtream URLs --------------------------------------------------------------

// Accepts "example.com:8080", "http://example.com:8080/" or a pasted M3U link,
// and returns just the scheme, host and port.
export function normalizeServer(raw: string): string {
  let server = raw.trim();
  if (server === "") return "";
  const lower = server.toLowerCase();
  if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) server = "http://" + server;
  const schemeEnd = server.indexOf("://");
  const slash = server.indexOf("/", schemeEnd + 3);
  if (slash >= 0) server = server.slice(0, slash);
  const question = server.indexOf("?");
  if (question >= 0) server = server.slice(0, question);
  return server;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Pulls server, username and password out of a pasted link: get.php or player_api.php
// with ?username=&password=, or a path like /playlist/<user>/<pass>/m3u_plus (also
// /live/, /movie/ and /series/ stream links).
export function parseProviderLink(raw: string): Creds {
  const text = raw.trim();
  const result: Creds = { server: normalizeServer(text), username: "", password: "" };
  const path = /^[a-z]+:\/\/[^/?]+\/(playlist|live|movie|series)\/([^/?]+)\/([^/?]+)/i.exec(text);
  if (path) {
    result.username = decode(path[2]);
    result.password = decode(path[3]);
    return result;
  }
  const question = text.indexOf("?");
  if (question < 0) return result;
  for (const pair of text.slice(question + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = pair.slice(0, eq).toLowerCase();
      const value = decode(pair.slice(eq + 1));
      if (key === "username") result.username = value;
      if (key === "password") result.password = value;
    }
  }
  return result;
}

export function apiUrl(creds: Creds, action: string, params?: { [key: string]: string | number }): string {
  let url =
    creds.server +
    "/player_api.php?username=" +
    encodeURIComponent(creds.username) +
    "&password=" +
    encodeURIComponent(creds.password);
  if (action !== "") url += "&action=" + action;
  if (params) {
    for (const key of Object.keys(params)) url += "&" + key + "=" + encodeURIComponent(toStr(params[key]));
  }
  return url;
}

export type StreamKind = "movie" | "series" | "live";

export function streamUrl(creds: Creds, kind: StreamKind, id: string, ext: string): string {
  return (
    creds.server +
    "/" +
    kind +
    "/" +
    encodeURIComponent(creds.username) +
    "/" +
    encodeURIComponent(creds.password) +
    "/" +
    id +
    "." +
    ext
  );
}

// --- Labels -------------------------------------------------------------------

// "S1:E2"
export function episodeCode(seasonNo: Json, episodeNo: Json): string {
  return "S" + toInt(seasonNo) + ":E" + toInt(episodeNo);
}

const CODEC_NAMES: { [codec: string]: string } = {
  h264: "H.264",
  avc: "H.264",
  hevc: "HEVC (H.265)",
  h265: "HEVC (H.265)",
  mpeg4: "MPEG-4 (DivX/Xvid)",
  mpeg2video: "MPEG-2",
  vp9: "VP9",
  av1: "AV1",
  wmv3: "Windows Media",
  vc1: "VC-1",
  aac: "AAC",
  ac3: "Dolby AC-3",
  eac3: "Dolby E-AC-3",
  dts: "DTS",
  dca: "DTS",
  mp4a: "AAC",
  mp3: "MP3",
  truehd: "Dolby TrueHD",
  opus: "Opus",
  flac: "FLAC",
  vorbis: "Vorbis",
};

// Provider codec name (ffprobe style) -> "HEVC (H.265)"
export function codecLabel(codec: string): string {
  const key = codec.toLowerCase();
  return Object.prototype.hasOwnProperty.call(CODEC_NAMES, key) ? CODEC_NAMES[key] : codec.toUpperCase();
}

// "HEVC (H.265) Main 10 video, Dolby E-AC-3 audio"
export function describeCodecs(videoCodec: string, videoProfile: string, audioCodec: string): string {
  const parts: string[] = [];
  if (videoCodec !== "") {
    let label = codecLabel(videoCodec);
    if (videoProfile !== "") label += " " + videoProfile;
    parts.push(label + " video");
  }
  if (audioCodec !== "") parts.push(codecLabel(audioCodec) + " audio");
  return parts.join(", ");
}

// "EN ★ Alterity - 2026" -> { title: "Alterity", year: "2026" }. Some providers put a
// language tag in front of every title (2 to 4 capitals and a symbol like ★ or |) and
// the year at the end. "UFO - 2018", "M3GAN" and "DC: ..." keep their names.
export function splitTitle(name: string): { title: string; year: string } {
  let title = name.trim();
  let letters = 0;
  while (letters < title.length && letters < 5) {
    const c = title.charCodeAt(letters);
    if (c < 65 || c > 90) break;
    letters++;
  }
  if (letters >= 2 && letters <= 4) {
    let rest = title.slice(letters).trim();
    const mark = rest.codePointAt(0) || 0;
    if (rest.charAt(0) === "|" || mark > 383) {
      rest = rest.slice(mark > 0xffff ? 2 : 1).trim();
      if (rest !== "") title = rest;
    }
  }
  let year = "";
  const found = /^(.*\S)\s+-\s+((?:19|20)\d\d)$/.exec(title);
  if (found) {
    title = found[1];
    year = found[2];
  }
  return { title, year };
}

// 1234567 -> "1,234,567"
export function commas(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// The text behind a login's sync "space": the server in lower case without a default
// port, a newline, then the username. Every device signed in to the same provider
// account gets the same text, so the same Continue Watching list (Roku's SyncSpaceText;
// every platform must build it exactly the same way).
export function syncSpaceText(creds: { server: string; username: string }): string {
  let server = normalizeServer(creds.server).toLowerCase();
  if (server.indexOf("http://") === 0 && /:80$/.test(server)) server = server.slice(0, -3);
  if (server.indexOf("https://") === 0 && /:443$/.test(server)) server = server.slice(0, -4);
  return server + "\n" + creds.username;
}
