// Subtitle settings in the player: how subtitles look (font, size, colour, background,
// edge, position), kept for every video, and their timing, kept per title. The look is
// drawn by ARAN+ (the player never draws subtitles), so changing it costs nothing, and
// timing moves the subtitles already on the TV, so it never downloads them again.
//
// The Netflix and Prime Video fonts (Netflix Sans, Amazon Ember) belong to those
// companies, so their styles use free look-alikes: Inter and Roboto (assets/fonts).

import { loadPrefs, readJson, savePref, writeJson } from "./storage";
import { isObj, toInt } from "./utils";

export interface SubOption {
  id: string;
  label: string;
}

export interface SubFont extends SubOption {
  family: string;
  weight: number;
}

export const SUB_FONTS: SubFont[] = [
  { id: "aran", label: "ARAN+ rounded", family: '"Nunito", sans-serif', weight: 800 },
  { id: "netflix", label: "Netflix style", family: '"SubInter", sans-serif', weight: 600 },
  { id: "prime", label: "Prime Video style", family: '"SubRoboto", sans-serif', weight: 500 },
  { id: "tv", label: "Samsung TV", family: "sans-serif", weight: 700 },
  { id: "typewriter", label: "Typewriter", family: '"SubCourier", monospace', weight: 700 },
  { id: "casual", label: "Casual", family: '"SubComic", sans-serif', weight: 700 },
];

export const SUB_SIZES: (SubOption & { px: number })[] = [
  { id: "small", label: "Small", px: 36 },
  { id: "medium", label: "Medium", px: 44 },
  { id: "large", label: "Large", px: 54 },
  { id: "huge", label: "Extra large", px: 66 },
];

export const SUB_COLORS: (SubOption & { css: string })[] = [
  { id: "white", label: "White", css: "#ffffff" },
  { id: "yellow", label: "Yellow", css: "#ffe94d" },
  { id: "cyan", label: "Cyan", css: "#7ff3ff" },
  { id: "green", label: "Green", css: "#8dff8a" },
];

export const SUB_BACKGROUNDS: SubOption[] = [
  { id: "none", label: "None" },
  { id: "shade", label: "See-through box" },
  { id: "black", label: "Black box" },
];

export const SUB_EDGES: SubOption[] = [
  { id: "outline", label: "Outline" },
  { id: "shadow", label: "Drop shadow" },
  { id: "none", label: "None" },
];

export const SUB_POSITIONS: (SubOption & { bottom: number })[] = [
  { id: "bottom", label: "Bottom", bottom: 90 },
  { id: "higher", label: "Higher", bottom: 200 },
];

export interface SubStyle {
  font: string;
  size: string;
  color: string;
  background: string;
  edge: string;
  position: string;
}

// The look before anything is changed: as ARAN+ always drew them.
export const DEFAULT_SUB_STYLE: SubStyle = { font: "aran", size: "medium", color: "white", background: "none", edge: "outline", position: "bottom" };

const PREF_KEYS: { [field in keyof SubStyle]: string } = { font: "subFont", size: "subSize", color: "subColor", background: "subBackground", edge: "subEdge", position: "subPosition" };

export const SUB_CHOICES: { [field in keyof SubStyle]: SubOption[] } = {
  font: SUB_FONTS,
  size: SUB_SIZES,
  color: SUB_COLORS,
  background: SUB_BACKGROUNDS,
  edge: SUB_EDGES,
  position: SUB_POSITIONS,
};

function known(list: SubOption[], id: string, fallback: string): string {
  return list.some((o) => o.id === id) ? id : fallback;
}

export function loadSubStyle(): SubStyle {
  const prefs = loadPrefs();
  const style = { ...DEFAULT_SUB_STYLE };
  for (const field of Object.keys(PREF_KEYS) as (keyof SubStyle)[]) style[field] = known(SUB_CHOICES[field], prefs[PREF_KEYS[field]] || "", DEFAULT_SUB_STYLE[field]);
  return style;
}

export function saveSubStyle(style: SubStyle): void {
  for (const field of Object.keys(PREF_KEYS) as (keyof SubStyle)[]) savePref(PREF_KEYS[field], style[field]);
}

// The next choice for `field` in direction `dir` (-1 or 1): Left and Right stop at the
// ends; OK (`wrap`) goes round.
export function stepChoice(field: keyof SubStyle, current: string, dir: number, wrap = false): string {
  const list = SUB_CHOICES[field];
  const at = Math.max(0, list.findIndex((o) => o.id === current));
  let next = at + dir;
  if (wrap) next = (next + list.length) % list.length;
  return list[Math.max(0, Math.min(list.length - 1, next))].id;
}

export function choiceLabel(field: keyof SubStyle, id: string): string {
  const found = SUB_CHOICES[field].filter((o) => o.id === id)[0];
  return found ? found.label : "";
}

export function fontOf(style: SubStyle): SubFont {
  return SUB_FONTS.filter((f) => f.id === style.font)[0] || SUB_FONTS[0];
}

export function sizePx(style: SubStyle): number {
  return (SUB_SIZES.filter((s) => s.id === style.size)[0] || SUB_SIZES[1]).px;
}

export function colorCss(style: SubStyle): string {
  return (SUB_COLORS.filter((c) => c.id === style.color)[0] || SUB_COLORS[0]).css;
}

export function bottomPx(style: SubStyle): number {
  return (SUB_POSITIONS.filter((p) => p.id === style.position)[0] || SUB_POSITIONS[0]).bottom;
}

// --- Timing -------------------------------------------------------------------------

export const TIMING_STEP_MS = 100;
export const TIMING_FAST_MS = 500; // a step once Left or Right has been held a while
export const TIMING_MAX_MS = 60000;

// One step from `delayMs`: positive shows subtitles later. Held for long (`fast`), the
// steps are bigger. Kept on the 0.1 s grid and within a minute either way.
export function stepTiming(delayMs: number, dir: number, fast = false): number {
  const next = Math.round((delayMs + dir * (fast ? TIMING_FAST_MS : TIMING_STEP_MS)) / TIMING_STEP_MS) * TIMING_STEP_MS;
  return Math.max(-TIMING_MAX_MS, Math.min(TIMING_MAX_MS, next));
}

// "On time", "0.4 s later", "1.2 s earlier".
export function timingLabel(delayMs: number): string {
  if (Math.round(delayMs / TIMING_STEP_MS) === 0) return "On time";
  return (Math.abs(delayMs) / 1000).toFixed(1) + " s " + (delayMs > 0 ? "later" : "earlier");
}

// Timing remembered on this TV, per title and subtitles ("m:12|os:345" for online
// subtitles, "m:12|track:eng" for the file's own), the 60 set last.
const TIMINGS_KEPT = 60;

export function rememberedTiming(key: string): number | null {
  const all = readJson("subs", "timing");
  if (!isObj(all) || !(key in all)) return null;
  return toInt(all[key]);
}

export function rememberTiming(key: string, delayMs: number): void {
  const all = readJson("subs", "timing");
  const kept: { [key: string]: number } = {};
  if (isObj(all)) for (const k of Object.keys(all)) if (k !== key) kept[k] = toInt(all[k]);
  if (delayMs !== 0) kept[key] = delayMs;
  const keys = Object.keys(kept);
  const out: { [key: string]: number } = {};
  // Oldest first, as they were added: the newest stay.
  for (const k of keys.slice(Math.max(0, keys.length - TIMINGS_KEPT))) out[k] = kept[k];
  try {
    writeJson("subs", "timing", out);
  } catch {
    // Kept for next time only when there's room.
  }
}
