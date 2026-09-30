// Maps Tizen remote keys and desktop keys to the few names screens care about.
// Arrows, Enter and Back arrive without registration; media keys must be registered,
// and their codes are read from Tizen rather than hard-coded where possible.

import { log } from "../core/log";

export type Key =
  | "up"
  | "down"
  | "left"
  | "right"
  | "ok"
  | "back"
  | "playpause"
  | "play"
  | "pause"
  | "rew"
  | "ff"
  | "stop"
  | "imeDone"
  | "imeCancel"
  | "other";

const MEDIA_KEYS: [string, Key, number][] = [
  // Tizen key name, our name, the usual Samsung code (used until Tizen answers)
  ["MediaPlayPause", "playpause", 10252],
  ["MediaPlay", "play", 415],
  ["MediaPause", "pause", 19],
  ["MediaRewind", "rew", 412],
  ["MediaFastForward", "ff", 417],
  ["MediaStop", "stop", 413],
];

const codes: { [code: number]: Key } = {
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  13: "ok",
  10009: "back",
  65376: "imeDone", // system keyboard Done
  65385: "imeCancel", // system keyboard Cancel
};
for (const [, key, code] of MEDIA_KEYS) codes[code] = key;

export function registerKeys(): void {
  const tizen = window.tizen;
  if (!tizen) return;
  for (const [name, key] of MEDIA_KEYS) {
    try {
      tizen.tvinputdevice.registerKey(name);
      const info = tizen.tvinputdevice.getKey(name);
      if (info) codes[info.code] = key;
    } catch (err) {
      log("registerKey " + name + " failed:", err);
    }
  }
}

const desktop: { [key: string]: Key } = {
  Escape: "back",
  Backspace: "back",
  " ": "playpause",
  ",": "rew",
  ".": "ff",
};

export function keyOf(event: KeyboardEvent): Key {
  const byCode = codes[event.keyCode];
  if (byCode) return byCode;
  if (!window.tizen && Object.prototype.hasOwnProperty.call(desktop, event.key)) return desktop[event.key];
  return "other";
}
