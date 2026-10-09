// The player's Audio & subtitles panel, without the screen: which options to list, which
// one is on, the note underneath, and what a remembered choice means for a new video.
// Ported from the Roku PlayerScreen (buildSubtitleOptions, updateTracksNote,
// onTracksChanged, autoSubtitles). The Samsung difference: online subtitles are drawn
// by ARAN+ from a file fetched once, so timing nudges are local and cost no download.

import { OsCandidate, subtitleLabel } from "./opensubtitles";
import { optionIndex, TrackOption } from "./tracks";
import { field, fieldStr, toInt } from "./utils";

export type OnlineState = "idle" | "searching" | "downloading" | "none" | "error" | "results";

export interface OnlineStatus {
  configured: boolean; // an OpenSubtitles key is saved
  state: OnlineState;
  candidates: OsCandidate[];
  message: string; // the error, when state is "error"
  loadedFileId: string; // the online subtitle being shown, or ""
  delayMs: number; // positive shows them later
  remaining: number; // downloads left today, -1 when unknown
  savedFileId: string; // the online subtitle saved for this title on the sync service, or ""
}

export function freshOnline(configured: boolean): OnlineStatus {
  return { configured, state: "idle", candidates: [], message: "", loadedFileId: "", delayMs: 0, remaining: -1, savedFileId: "" };
}

// Online subtitles saved for a title on the sync service (the Roku repo's sync/), so a
// download on one device shows on every device without another download.
export interface SavedSubtitle {
  fileId: string;
  name: string; // the release it came from
  delayMs: number; // as nudged, positive shows them later
  text: string; // the file
}

// The sync service's answer, or null when nothing is saved (or it's unreadable).
export function readSavedSubtitle(data: unknown): SavedSubtitle | null {
  if (field(data, "found") !== true) return null;
  const fileId = fieldStr(data, "fileId");
  const text = fieldStr(data, "text");
  if (fileId === "" || text === "") return null;
  return { fileId, name: fieldStr(data, "name"), delayMs: toInt(field(data, "delayMs")), text };
}

// Saved subtitles as a choice in the Subtitles column.
export function savedCandidate(saved: SavedSubtitle): OsCandidate {
  return { fileId: saved.fileId, release: saved.name, hashMatch: false, machine: false, sdh: false, downloads: 0, saved: true };
}

// What is on screen: nothing, one of the file's own tracks, or an online subtitle.
export type SubtitleSource = { kind: "off" } | { kind: "embedded"; id: string } | { kind: "online"; fileId: string };

export const NUDGE_MS = 1000;

// The Subtitles column: `embedded` is subtitleOptions() for the file (Off first, then
// its own tracks), then subtitles saved for this title (which need no OpenSubtitles
// account), followed by the online choices for the current state.
export function subtitleMenu(embedded: TrackOption[], online: OnlineStatus): TrackOption[] {
  const options = embedded.slice();
  const file = (candidate: OsCandidate) => ({ id: "os:file:" + candidate.fileId, label: subtitleLabel(candidate), language: "eng" });
  const saved = online.candidates.filter((c) => c.saved);
  const found = online.candidates.filter((c) => !c.saved && !saved.some((s) => s.fileId === c.fileId));
  for (const candidate of saved) options.push(file(candidate));
  if (!online.configured) options.push({ id: "os:setup", label: "Find English subtitles online", language: "" });
  else if (online.state === "searching") options.push({ id: "os:busy", label: "Searching online…", language: "" });
  else if (online.state === "downloading") options.push({ id: "os:busy", label: "Downloading subtitles…", language: "" });
  else if (found.length === 0) {
    const again = online.state === "none" || online.state === "error";
    options.push({ id: "os:search", label: again ? "Search online again" : "Find English subtitles online", language: "" });
  }
  if (online.configured) for (const candidate of found) options.push(file(candidate));
  if (online.loadedFileId) {
    options.push({ id: "os:earlier", label: "Show subtitles 1s earlier", language: "" });
    options.push({ id: "os:later", label: "Show subtitles 1s later", language: "" });
  }
  return options;
}

// The option to mark as on.
export function activeSubtitle(menu: TrackOption[], source: SubtitleSource): number {
  if (source.kind === "off") return 0;
  if (source.kind === "embedded") return optionIndex(menu, "id", source.id);
  return optionIndex(menu, "id", "os:file:" + source.fileId);
}

function seconds(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return (s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)) + "s";
}

export function delayText(delayMs: number): string {
  if (delayMs === 0) return "";
  return "Showing them " + seconds(delayMs) + (delayMs > 0 ? " later." : " earlier.");
}

// The note under the columns. `embeddedCount` excludes Off.
export function tracksNote(online: OnlineStatus, embeddedCount: number): string {
  const notes: string[] = [];
  if (!online.configured && !online.loadedFileId) notes.push("To search online, connect OpenSubtitles first: press OK on “Find English subtitles online”.");
  else if (online.state === "searching") notes.push("Searching OpenSubtitles for English subtitles…");
  else if (online.state === "downloading") notes.push("Downloading…");
  else if (online.state === "none") notes.push("OpenSubtitles has no English subtitles for this title.");
  else if (online.state === "error") notes.push(online.message);
  else if (online.loadedFileId) {
    const moved = delayText(online.delayMs);
    const on = online.loadedFileId === online.savedFileId ? "Online subtitles on, saved for all your devices." : "Online subtitles on.";
    notes.push(on + (moved ? " " + moved : "") + " If they're out of sync, nudge them earlier or later.");
  } else if (online.candidates.some((c) => !c.saved)) notes.push("“Matches this file” means timed for your exact video.");
  else if (online.candidates.length > 0) notes.push("“Saved for this title” came from an earlier download, on this or another device.");
  else if (embeddedCount === 0) notes.push("This file has no subtitles of its own.");
  if (online.configured && online.remaining >= 0) notes.push("Downloads left today: " + online.remaining + ".");
  return notes.join(" ");
}

function englishTrack(embedded: TrackOption[]): number {
  const eng = optionIndex(embedded, "language", "eng");
  return eng >= 0 ? eng : optionIndex(embedded, "language", "en");
}

// What a remembered choice means for a new video (Roku's onTracksChanged and
// autoSubtitles): a language picks the file's own track in it; "online" prefers the
// file's own English track, else searches online; "off" and no choice show nothing.
export type SubtitlePlan = { kind: "off" } | { kind: "embedded"; id: string } | { kind: "online" };

export function subtitlePlan(pref: string, embedded: TrackOption[], configured: boolean): SubtitlePlan {
  if (pref === "online") {
    const index = englishTrack(embedded);
    if (index > 0) return { kind: "embedded", id: embedded[index].id };
    return configured ? { kind: "online" } : { kind: "off" };
  }
  if (pref === "" || pref === "off") return { kind: "off" };
  const index = optionIndex(embedded, "language", pref);
  return index > 0 ? { kind: "embedded", id: embedded[index].id } : { kind: "off" };
}

// Subtitles saved for this title (downloaded on any device) show by themselves where
// this device would look online, or hasn't been told what to show yet; never over "off",
// a language of the file's own, or the file's own English track.
export function showsSaved(pref: string, plan: SubtitlePlan): boolean {
  return plan.kind !== "embedded" && (pref === "online" || pref === "");
}

// The audio track for a remembered language, or "" to leave the file's default.
export function audioPlan(pref: string, audio: TrackOption[]): string {
  if (!pref) return "";
  const index = optionIndex(audio, "language", pref);
  return index >= 0 ? audio[index].id : "";
}

// Saved subtitles need the sync service from October 2026 on; an older one answers 404.
export const OLD_SYNC_TEXT = "Subtitles can't be saved for next time, because your sync service is an older version. Update it in Cloudflare: see “Update it” in the Roku repo's sync/README.md.";

// Why downloaded subtitles weren't saved for next time.
export function subtitleSaveText(code: number, error: string): string {
  if (code === 404) return OLD_SYNC_TEXT;
  return "These subtitles couldn't be saved for next time." + (error ? " " + error : "");
}
