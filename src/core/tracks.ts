// Audio and subtitle choices for the player's track panel, ported from the Roku app's
// Tracks.brs. Each option is { id, label, language }. On Samsung the tracks come from
// AVPlay's getTotalTrackInfo (see fromAvplay).

import type { Track } from "../platform/player";

export interface TrackInput {
  id: string;
  language: string;
  description: string;
}

export interface TrackOption {
  id: string;
  label: string;
  language: string;
}

const NAMES: { [code: string]: string } = {
  eng: "English", en: "English", hin: "Hindi", hi: "Hindi", urd: "Urdu", ur: "Urdu",
  pan: "Punjabi", pa: "Punjabi", ara: "Arabic", ar: "Arabic", ben: "Bengali", bn: "Bengali",
  tam: "Tamil", ta: "Tamil", tel: "Telugu", te: "Telugu", mal: "Malayalam", ml: "Malayalam",
  kan: "Kannada", kn: "Kannada", mar: "Marathi", mr: "Marathi", guj: "Gujarati", gu: "Gujarati",
  per: "Persian", fas: "Persian", fa: "Persian", tur: "Turkish", tr: "Turkish",
  fre: "French", fra: "French", fr: "French", spa: "Spanish", es: "Spanish",
  ger: "German", deu: "German", de: "German", ita: "Italian", it: "Italian",
  por: "Portuguese", pt: "Portuguese", rus: "Russian", ru: "Russian", pol: "Polish", pl: "Polish",
  dut: "Dutch", nld: "Dutch", nl: "Dutch", swe: "Swedish", sv: "Swedish", dan: "Danish", da: "Danish",
  nor: "Norwegian", nob: "Norwegian", fin: "Finnish", fi: "Finnish", gre: "Greek", ell: "Greek", el: "Greek",
  heb: "Hebrew", he: "Hebrew", rum: "Romanian", ron: "Romanian", ro: "Romanian", hun: "Hungarian", hu: "Hungarian",
  cze: "Czech", ces: "Czech", cs: "Czech", jpn: "Japanese", ja: "Japanese", kor: "Korean", ko: "Korean",
  chi: "Chinese", zho: "Chinese", zh: "Chinese", tha: "Thai", th: "Thai", vie: "Vietnamese", vi: "Vietnamese",
  ind: "Indonesian", may: "Malay", msa: "Malay", ms: "Malay", fil: "Filipino", tgl: "Tagalog",
};

export function languageName(code: string): string {
  const c = code.trim().toLowerCase();
  if (c === "" || c === "und" || c === "unk") return "";
  return Object.prototype.hasOwnProperty.call(NAMES, c) ? NAMES[c] : c.toUpperCase();
}

// "English" + "Commentary" -> "English · Commentary"; skips a description that just
// repeats the language.
export function trackLabel(language: string, detail: string, fallback: string): string {
  let label = languageName(language);
  if (detail !== "" && detail.toLowerCase() !== label.toLowerCase()) label = label === "" ? detail : label + " · " + detail;
  return label === "" ? fallback : label;
}

export function audioOptions(tracks: TrackInput[] | null | undefined): TrackOption[] {
  const options: TrackOption[] = [];
  for (const track of tracks || []) {
    if (track.id === "") continue;
    options.push({
      id: track.id,
      label: trackLabel(track.language, track.description, "Track " + (options.length + 1)),
      language: track.language.toLowerCase(),
    });
  }
  return options;
}

// Always starts with "Off".
export function subtitleOptions(tracks: TrackInput[] | null | undefined): TrackOption[] {
  const options: TrackOption[] = [{ id: "", label: "Off", language: "off" }];
  for (const track of tracks || []) {
    if (track.id === "") continue;
    options.push({
      id: track.id,
      label: trackLabel(track.language, track.description, "Subtitles " + options.length),
      language: track.language.toLowerCase(),
    });
  }
  return options;
}

export function optionIndex(options: TrackOption[], key: keyof TrackOption, value: string): number {
  for (let i = 0; i < options.length; i++) if (options[i][key] === value) return i;
  return -1;
}

// AVPlay tracks -> inputs for audioOptions/subtitleOptions. The id is AVPlay's track
// index, which setSelectTrack takes.
export function fromAvplay(tracks: Track[], kind: "AUDIO" | "TEXT"): TrackInput[] {
  return tracks
    .filter((t) => t.kind === kind)
    .map((t) => ({ id: String(t.index), language: t.language, description: "" }));
}
