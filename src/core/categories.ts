// Makes sense of provider category names like "EN | ACTION ★", "|IN| BOLLYWOOD 2024" or
// "PUNJABI MOVIES": which language a category is in, whether it holds new releases or
// kids' titles, and a tidy name to show ("Action", "Bollywood 2024", "Punjabi"). Ported
// from the Roku app's Categories.brs (docs/features.md §4), with its tests, which use
// the real category names of the provider in use.

export type Lang = "en" | "hi" | "pa" | "other" | "";

export interface CategoryInfo {
  lang: Lang;
  isNew: boolean;
  kids: boolean;
  label: string;
}

export interface OrganizedCategory {
  id: string;
  name: string;
  label: string;
  lang: Lang;
  isNew: boolean;
  demoted: boolean; // 4K on a screen that isn't 4K: last, and not a new release
  order: number;
}

const OTHER_CODES = [
  "CA", "EX", "SW", "AS", "AR", "ARA", "ARB", "FR", "FRA", "DE", "GER", "ES", "SPA", "IT", "ITA", "PT", "POR", "BR", "TR", "TUR", "NL", "PL",
  "RU", "RUS", "GR", "AL", "RO", "BG", "HU", "CZ", "SK", "SE", "NO", "DK", "FI", "IR", "PER", "KU", "AF", "AFR", "SO", "PH", "VN", "TH", "ID",
  "MY", "CN", "CHN", "KR", "KOR", "JP", "JAP", "PK", "BD", "LK", "NP", "TA", "TE", "ML", "KN", "LAT", "MX", "CO", "EXYU", "EX-YU", "QC", "IL",
  "AM", "UA", "LT", "LV", "EE", "HR", "RS", "BA", "MK", "SI", "CY", "MT", "IS", "ZA", "NG", "KE", "ET", "EG", "MA", "DZ", "TN", "LB", "SY", "IQ",
  "SA", "AE", "KW", "QA",
];

const CODES: { [code: string]: Lang } = {
  EN: "en", ENG: "en", UK: "en", GB: "en", US: "en", USA: "en", AU: "en", NZ: "en", IE: "en",
  IN: "hi", IND: "hi", HI: "hi", HIN: "hi",
  PB: "pa", PJ: "pa", PUN: "pa", PAN: "pa",
};
for (const code of OTHER_CODES) CODES[code] = "other";

const OTHER_WORDS = [
  "ARABIC", "ARAB", "FRENCH", "FRANCAIS", "GERMAN", "DEUTSCH", "SPANISH", "ESPANOL", "LATINO", "ITALIAN", "PORTUGUESE", "BRAZIL", "BRASIL",
  "TURKISH", "TURKCE", "DUTCH", "POLISH", "POLSKA", "RUSSIAN", "GREEK", "ALBANIAN", "ROMANIAN", "BULGARIAN", "HUNGARIAN", "CZECH", "SLOVAK",
  "SWEDISH", "NORWEGIAN", "DANISH", "FINNISH", "NORDIC", "SCANDINAVIAN", "PERSIAN", "FARSI", "IRANIAN", "KURDISH", "AFGHAN", "PASHTO", "SOMALI",
  "FILIPINO", "PINOY", "TAGALOG", "VIETNAMESE", "THAI", "INDONESIAN", "MALAY", "CHINESE", "MANDARIN", "CANTONESE", "KOREAN", "KDRAMA",
  "JAPANESE", "URDU", "PAKISTANI", "PAKISTAN", "BANGLA", "BENGALI", "NEPALI", "SINHALA", "TAMIL", "TELUGU", "MALAYALAM", "KANNADA", "MARATHI",
  "GUJARATI", "ODIA", "ASSAMESE", "BHOJPURI", "EXYU", "BALKAN", "SERBIAN", "CROATIAN", "BOSNIAN", "MACEDONIAN", "ARMENIAN", "GEORGIAN",
  "HEBREW", "ISRAELI", "AFRICAN", "AFRICA", "QUEBEC", "HAITIAN", "UKRAINIAN", "LITHUANIAN", "LATVIAN", "ESTONIAN", "GUJARTI", "QUEBECOISE",
  "QUEBECOIS", "SWEDEN", "DENMARK", "NORWAY", "FINLAND", "RUSSIA", "BULGARIA", "ROMANIA", "ALBANIA", "POLAND", "GREECE", "GERMANY", "FRANCE",
  "SPAIN", "ITALY", "PORTUGAL", "NETHERLANDS", "TURKEY", "CHINA", "JAPAN", "KOREA", "MALAYSIA", "THAILAND", "INDONESIA", "INDONISIA",
  "PHILIPPINES", "NOLLYWOOD",
];

const NEW_WORDS = ["NEW", "LATEST", "RECENT", "RECENTLY", "TRENDING", "POPULAR", "THEATRICAL"];
const NEW_PHRASES = ["JUST ADDED", "TOP 10", "THIS WEEK", "IN CINEMA", "IN THEATER", "IN THEATRE", "BOX OFFICE", "NOW PLAYING", "NOW SHOWING"];
const KIDS_WORDS = ["KIDS", "KID", "CHILDREN", "CHILD", "CARTOON", "CARTOONS", "JUNIOR"];

const GENERIC: { [word: string]: boolean } = {
  MOVIES: true, MOVIE: true, FILMS: true, FILM: true, SERIES: true, "TV SHOWS": true, SHOWS: true, VOD: true, "TV SERIES": true, VIP: true,
};
const KEEP_CASE: { [word: string]: boolean } = {
  TV: true, HD: true, FHD: true, UHD: true, UK: true, US: true, USA: true, HBO: true, BBC: true, ITV: true, AMC: true, MCU: true, DC: true,
  VIP: true, NBA: true, NFL: true, UFC: true, WWE: true, II: true, III: true, IV: true, AZ: true, IMDB: true, FIFA: true, "BET+": true, OSN: true,
  VIU: true,
};

export const LANGUAGE_NAMES: { [lang: string]: string } = { en: "English", hi: "Hindi", pa: "Punjabi", other: "Other languages" };

// "EN | ACTION ★" -> ["EN", "ACTION"]. Splits on the separators providers use; a hyphen
// only counts with spaces around it, so "SCI-FI" stays whole. Emoji and decorative
// symbols separate too; letters with accents are kept.
export function categorySegments(name: string): string[] {
  let clean = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) as number;
    clean += code < 128 || (code >= 192 && code <= 383) ? ch : " | ";
  }
  clean = clean.toUpperCase().replace(/\s+-\s+|[|[\]():*#=~]/g, "|");
  const segments: string[] = [];
  for (let part of clean.split("|")) {
    part = part.replace(/\s+/g, " ").trim();
    if (part !== "" && part !== "-") segments.push(part);
  }
  return segments;
}

function languageCode(segment: string): Lang {
  return Object.prototype.hasOwnProperty.call(CODES, segment) ? CODES[segment] : "";
}

function hasAnyWord(words: { [word: string]: boolean }, candidates: string[]): boolean {
  for (const candidate of candidates) if (words[candidate]) return true;
  return false;
}

// The language a name spells out in words: "PUNJABI", "BOLLYWOOD", "TAMIL", "ENGLISH".
function languageFromWords(words: { [word: string]: boolean }, upper: string): Lang {
  if (hasAnyWord(words, ["PUNJABI", "PUNJAB", "POLLYWOOD"])) return "pa";
  if (hasAnyWord(words, ["HINDI", "BOLLYWOOD"])) return "hi";
  if (hasAnyWord(words, OTHER_WORDS) || upper.indexOf("SOUTH INDIAN") >= 0 || upper.indexOf("K-DRAMA") >= 0) return "other";
  if (hasAnyWord(words, ["ENGLISH", "HOLLYWOOD"])) return "en";
  if (hasAnyWord(words, ["INDIAN", "INDIA", "DESI"])) return "hi";
  return "";
}

// Names written in another script: Devanagari is Hindi, Gurmukhi is Punjabi, and
// Arabic, Greek, Cyrillic, other Indian scripts, Thai, Chinese, Japanese or Korean
// count as other languages.
function scriptLanguage(name: string): Lang {
  for (const ch of name) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x0900 && c <= 0x097f) return "hi";
    if (c >= 0x0a00 && c <= 0x0a7f) return "pa";
    if ((c >= 0x0370 && c <= 0x08ff) || (c >= 0x0980 && c <= 0x0fff) || (c >= 0x10a0 && c <= 0x11ff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) {
      return "other";
    }
  }
  return "";
}

// "SCI-FI" -> "Sci-Fi", "CONCERTS/MUSICAL" -> "Concerts/Musical".
function capitalizeWord(word: string): string {
  let out = "";
  let capital = true;
  for (const lower of word.toLowerCase()) {
    out += capital ? lower.toUpperCase() : lower;
    capital = lower === "-" || lower === "/";
  }
  return out;
}

// "NETFLIX · SCI-FI 4K" -> "Netflix · Sci-Fi 4K". Short acronyms and words with digits
// stay as they are.
function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => (KEEP_CASE[word] || /\d/.test(word) ? word : capitalizeWord(word)))
    .join(" ");
}

// Segments without language codes, generic words or decoration, joined and title-cased.
// Hindi and Punjabi categories keep their language in the name, so "IN | ACTION" doesn't
// look the same as the English "Action".
function categoryLabel(segments: string[], lang: Lang): string {
  let named = segments.filter((s) => languageCode(s) === "" && !GENERIC[s]);
  if (named.length === 0) named = segments.filter((s) => languageCode(s) === "");
  // "ACTION MOVIES" -> "ACTION"; a lone "MOVIES" or "MOVIE SERIES" stays, and so do
  // "TV SHOWS", "UK SERIES" and "3D MOVIES": two letters alone say little.
  const last = named.length - 1;
  if (last >= 0) {
    const trailing = /^(.+?)\s+(?:MOVIES|MOVIE|FILMS|FILM|SERIES|TV SHOWS|TV SERIES|SHOWS)$/.exec(named[last]);
    if (trailing && !GENERIC[trailing[1]] && trailing[1].length > 2) named[last] = trailing[1];
  }
  let text = titleCase(named.join(" · "));
  // A category called just "SERIES" or "MOVIES" is named for its language instead.
  const plain: { [word: string]: boolean } = { MOVIES: true, MOVIE: true, FILMS: true, FILM: true, SERIES: true };
  if (plain[text.toUpperCase()] && (lang === "en" || lang === "hi" || lang === "pa")) text = LANGUAGE_NAMES[lang];
  const lower = text.toLowerCase();
  if (lang === "hi" && lower.indexOf("hindi") < 0 && lower.indexOf("bollywood") < 0 && lower.indexOf("indian") < 0) text = "Hindi " + text;
  if (lang === "pa" && lower.indexOf("punjab") < 0 && lower.indexOf("pollywood") < 0) text = "Punjabi " + text;
  return text.trim();
}

// `year` is the current year, since new-release categories often name it.
export function classifyCategory(name: string, year: number): CategoryInfo {
  const segments = categorySegments(name);
  const words: { [word: string]: boolean } = {};
  for (const segment of segments) for (const word of segment.split(/[^A-Z0-9+]+/)) if (word !== "") words[word] = true;
  const upper = name.toUpperCase();

  // A code like "EN ✪" or "|FR|" is the provider saying the language outright, so it
  // wins, except that "IN" covers all of India and the name says which language.
  let code: Lang = "";
  let codeText = "";
  for (const segment of segments) {
    code = languageCode(segment);
    if (code !== "") {
      codeText = segment;
      break;
    }
  }
  const named = languageFromWords(words, upper);
  let lang: Lang;
  if (code === "en" || code === "other" || code === "pa") lang = code;
  else if (code === "hi") lang = named === "pa" || named === "other" ? named : "hi";
  else lang = named !== "" ? named : scriptLanguage(name);

  let isNew = hasAnyWord(words, NEW_WORDS);
  for (const phrase of NEW_PHRASES) if (upper.indexOf(phrase) >= 0) isNew = true;
  if (words[String(year)] || words[String(year - 1)]) isNew = true;

  const kids = hasAnyWord(words, KIDS_WORDS);
  let label = categoryLabel(segments, lang);
  // Other languages keep their code, so French "Action" isn't mistaken for English.
  if (lang === "other" && codeText !== "") label = codeText + " · " + label;
  return { lang, isNew, kids, label };
}

// Whether a category belongs on screen. With no languages chosen, everything does;
// categories whose language we can't tell always do.
export function categoryWanted(info: { lang: Lang }, langs: string[]): boolean {
  if (langs.length === 0 || info.lang === "") return true;
  return langs.some((wanted) => wanted.toLowerCase() === info.lang);
}

function languageRank(lang: string, langs: string[]): number {
  for (let i = 0; i < langs.length; i++) if (langs[i].toLowerCase() === lang) return i;
  return 0;
}

export function is4KLabel(label: string): boolean {
  return /(?:^|\W)(?:4K|UHD)(?:\W|$)/i.test(label);
}

// The categories to show for one kind, each with a tidy label and a new-releases flag,
// ordered: new releases first, then by language in the order chosen (unknown counts as
// the first language), otherwise in the provider's order. With demote4K (a screen that
// isn't 4K), 4K categories go last. The Q60 is 4K, so Samsung passes false.
export function organizeCategories(list: { id: string; name: string }[], langs: string[], year: number, demote4K = false): OrganizedCategory[] {
  const shown: OrganizedCategory[] = [];
  list.forEach((category, position) => {
    const info = classifyCategory(category.name, year);
    if (!categoryWanted(info, langs)) return;
    const demoted = demote4K && is4KLabel(info.label);
    let rank = info.isNew ? 0 : languageRank(info.lang, langs) + 1;
    if (demoted) rank = langs.length + 2;
    shown.push({ id: category.id, name: category.name, label: info.label, lang: info.lang, isNew: info.isNew && !demoted, demoted, order: rank * 100000 + position });
  });
  return shown.sort((a, b) => a.order - b.order);
}

// a and b merged, taking turns: a1, b1, a2, b2, ...
export function takeTurns<T>(a: T[], b: T[]): T[] {
  const merged: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) merged.push(a[i]);
    if (i < b.length) merged.push(b[i]);
  }
  return merged;
}

// Entries grouped by language (in the order chosen; unknown counts as the first), then
// merged with each language taking a turn, so a Punjabi row isn't buried under fifty
// English ones. Demoted entries go last.
export function languageTurns<T extends { lang: string; demoted?: boolean }>(entries: T[], langs: string[]): T[] {
  const groups: T[][] = [];
  for (let i = 0; i <= langs.length; i++) groups.push([]);
  const last: T[] = [];
  for (const entry of entries) {
    if (entry.demoted) last.push(entry);
    else groups[languageRank(entry.lang, langs)].push(entry);
  }
  const merged: T[] = [];
  for (let round = 0; ; round++) {
    let added = false;
    for (const group of groups) {
      if (round < group.length) {
        merged.push(group[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return merged.concat(last);
}
