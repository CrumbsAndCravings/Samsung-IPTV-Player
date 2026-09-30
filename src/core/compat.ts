// Will this file play on this TV? The Roku app asked the device (CanDecodeVideo);
// Tizen has no reliable equivalent, so this combines:
//   - what the M0 checks found on this TV (docs/m0-findings.md): HEVC and H.264 in MKV
//     and MP4 play; most AVIs fail to open, though some play;
//   - what the TV has learned since: each title's last result, and codec combinations
//     that have failed for several titles and never played.
// Never blocks outright: the screens offer "OK to try anyway", as on Roku.

import { readJson, writeJson } from "./storage";
import { describeCodecs, isObj } from "./utils";

export type Verdict = "ok" | "warn" | "blocked";

export interface PlayCheck {
  verdict: Verdict;
  reason: string; // plain English for the details screen and the player
}

export interface FileFacts {
  key: string; // "m:<streamId>" or "e:<episodeId>"
  ext: string;
  videoCodec: string;
  videoProfile: string;
  audioCodec: string;
}

interface Learned {
  ok: boolean;
  error: string;
  combo: string;
  at: number;
}

// Containers the M0 checks found unreliable here.
const CONTAINER_NOTES: { [ext: string]: string } = {
  avi: "AVI files often don't play on this TV.",
  divx: "DivX files often don't play on this TV.",
};

const MAX_LEARNED = 500;

function learned(): { [key: string]: Learned } {
  const saved = readJson("compat", "titles");
  return isObj(saved) ? (saved as unknown as { [key: string]: Learned }) : {};
}

// "mkv|hevc|main 10|eac3"; "" when the provider didn't report a video codec, since a
// combination that isn't known can't be judged.
export function comboOf(f: FileFacts): string {
  if (f.videoCodec === "") return "";
  return [f.ext, f.videoCodec, f.videoProfile, f.audioCodec].map((v) => v.trim().toLowerCase()).join("|");
}

// Only failures about the file itself teach anything; a dropped connection doesn't.
export function isFormatError(error: string): boolean {
  return /NOT_SUPPORTED|UNSUPPORTED/.test(error);
}

export function playCheck(f: FileFacts): PlayCheck {
  const all = learned();
  const mine = all[f.key];
  if (mine) {
    if (mine.ok) return { verdict: "ok", reason: "" };
    return { verdict: "blocked", reason: "This video didn't play on this TV last time" + (mine.error ? " (" + mine.error + ")" : "") + "." };
  }
  const combo = comboOf(f);
  if (combo !== "") {
    let failed = 0;
    let played = 0;
    for (const key of Object.keys(all)) {
      if (all[key].combo !== combo) continue;
      if (all[key].ok) played++;
      else failed++;
    }
    if (failed >= 2 && played === 0) {
      const what = describeCodecs(f.videoCodec, f.videoProfile, f.audioCodec);
      return { verdict: "blocked", reason: "Files like this (" + f.ext.toUpperCase() + ", " + what + ") haven't played on this TV." };
    }
  }
  const note = CONTAINER_NOTES[f.ext.toLowerCase()];
  if (note) return { verdict: "warn", reason: note };
  return { verdict: "ok", reason: "" };
}

// Records how a real attempt went. `played` means real progress, not just opening.
export function learnResult(f: FileFacts, played: boolean, error: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!played && !isFormatError(error)) return;
  const all = learned();
  all[f.key] = { ok: played, error: played ? "" : error, combo: comboOf(f), at: nowSeconds };
  const keys = Object.keys(all);
  if (keys.length > MAX_LEARNED) {
    keys.sort((a, b) => all[a].at - all[b].at);
    for (const key of keys.slice(0, keys.length - MAX_LEARNED)) delete all[key];
  }
  writeJson("compat", "titles", all);
}
