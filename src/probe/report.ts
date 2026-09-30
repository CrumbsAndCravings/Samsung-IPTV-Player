// Summarises every setup check, for the screen and for the report QR code. Pure: the
// caller passes everything in and redacts the result (core/redact.ts) before showing it.

import { describeModelYear } from "../core/device";
import { describeCodecs } from "../core/utils";
import type { DeviceInfo } from "../platform/tizen";
import type { EchoCheck, OsCheck, Outcome, RangeCheck, XtreamCheck } from "./checks";
import type { LibraryStats } from "./library";
import { SLOTS, SlotId } from "./samples";

export interface PlayResult {
  key: string;
  title: string;
  ext: string;
  videoCodec: string;
  videoProfile: string;
  audioCodec: string;
  width: number;
  slots: SlotId[];
  outcome: "played" | "failed" | "stalled" | "stopped";
  error: string; // the player's error name
  startMs: number; // from open to the first real progress; 0 if it never played
  seek: "" | "ok" | "failed";
  tracks: string;
  subtitleCues?: number; // embedded subtitle cues AVPlay handed over

  player: "avplay" | "html5";
  at: number;
}

export interface SampleSummary {
  titlesSeen: number;
  infoChecked: number;
  withCodecs: number;
  extCounts: { [ext: string]: number };
}

export interface ProbeState {
  device: DeviceInfo | null;
  xtream: XtreamCheck | null;
  range: RangeCheck | null;
  echo: EchoCheck | null;
  os: OsCheck | null;
  samples: SampleSummary | null;
  library: LibraryStats[];
  plays: PlayResult[]; // newest first
}

export interface ReportLine {
  outcome: Outcome | "todo";
  label: string;
  text: string;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + " s";
}

export function fileLabel(p: { ext: string; videoCodec: string; videoProfile: string; audioCodec: string }): string {
  const codecs = describeCodecs(p.videoCodec, p.videoProfile, p.audioCodec);
  return p.ext.toUpperCase() + (codecs !== "" ? " · " + codecs : " · codecs not reported");
}

export function playSummary(play: PlayResult): string {
  if (play.outcome === "played") {
    let text = "Played (started in " + seconds(play.startMs) + ")";
    if (play.seek === "ok") text += ", seeking works";
    if (play.seek === "failed") text += ", seeking failed";
    return text;
  }
  if (play.outcome === "failed") return "Didn't play: " + (play.error || "unknown error");
  if (play.outcome === "stalled") return "Never started (no progress in 30 s)";
  return "Stopped before it started";
}

function playOutcome(play: PlayResult): Outcome {
  return play.outcome === "played" ? "ok" : play.outcome === "stopped" ? "warn" : "fail";
}

export function reportLines(state: ProbeState): ReportLine[] {
  const lines: ReportLine[] = [];
  const d = state.device;
  if (d) {
    lines.push({
      outcome: d.chromium ? "ok" : "warn",
      label: "Web engine",
      text: (d.chromium ? "Chromium " + d.chromium : "unknown") + (d.tizenFromUa ? " · Tizen " + d.tizenFromUa : ""),
    });
    const model = d.realModel || d.model || d.modelCode;
    const year = describeModelYear(model);
    lines.push({ outcome: model ? "ok" : "todo", label: "Model", text: model ? model + (year ? " · " + year : "") : "Not on a Samsung TV" });
  }

  const x = state.xtream;
  if (!x) lines.push({ outcome: "todo", label: "IPTV server", text: "Not tested yet" });
  else if (x.outcome === "fail") lines.push({ outcome: "fail", label: "IPTV server", text: x.message + (x.code ? " (HTTP " + x.code + ")" : "") });
  else {
    const cats = x.movieCategories >= 0 ? " · " + x.movieCategories + " movie and " + x.seriesCategories + " series categories" : "";
    lines.push({ outcome: x.outcome, label: "IPTV server", text: "Works (HTTP " + x.code + " in " + x.ms + " ms) · " + (x.status || "signed in") + cats });
  }

  const r = state.range;
  if (!r) lines.push({ outcome: "todo", label: "Range requests", text: "Tested with the first video found" });
  else lines.push({ outcome: r.outcome, label: "Range requests", text: r.outcome === "ok" ? "Work (first and last 64 KB, file size readable)" : r.message + " (HTTP " + r.code + ")" });

  const e = state.echo;
  if (!e) lines.push({ outcome: "todo", label: "Headers", text: "Not tested yet" });
  else if (e.outcome === "fail") lines.push({ outcome: "fail", label: "Headers", text: e.message });
  else {
    const ua = e.ourUserAgentArrived ? "User-Agent arrives as ours" : "User-Agent is replaced by the TV's";
    const xua = e.xUserAgentArrived ? "X-User-Agent arrives" : "X-User-Agent is dropped";
    lines.push({ outcome: e.ourUserAgentArrived || e.xUserAgentArrived ? "ok" : "warn", label: "Headers", text: ua + " · " + xua });
  }

  const o = state.os;
  if (!o) lines.push({ outcome: "todo", label: "OpenSubtitles", text: "Not tested yet" });
  else {
    const parts: string[] = [];
    if (o.keyOnly) parts.push("key " + (o.keyOnly.code || "no answer"));
    if (o.keyWithXua) parts.push("key + X-User-Agent " + (o.keyWithXua.code || "no answer"));
    if (o.login) parts.push("login " + (o.login.code || "no answer") + (o.login.code === 200 ? " (" + o.login.allowed + " downloads a day)" : ""));
    const text = (o.message ? o.message + " " : "") + parts.join(" · ");
    lines.push({ outcome: o.outcome, label: "OpenSubtitles", text: text.trim() });
  }

  for (const slot of SLOTS) {
    const play = latestFor(state.plays, slot.id);
    lines.push(
      play
        ? { outcome: playOutcome(play), label: slot.label, text: playSummary(play) }
        : { outcome: "todo", label: slot.label, text: "Not tried yet" },
    );
  }
  return lines;
}

function latestFor(plays: PlayResult[], slot: SlotId): PlayResult | null {
  let best: PlayResult | null = null;
  for (const play of plays) {
    if (play.slots.indexOf(slot) < 0) continue;
    // A file that played says more than one that didn't; otherwise the newest.
    if (!best || (play.outcome === "played" && best.outcome !== "played")) best = play;
  }
  return best;
}

// Plain text for the QR code: short, but complete enough to plan from.
export function reportText(state: ProbeState, version: string): string {
  const out: string[] = ["ARAN+ " + version + " setup report"];
  const d = state.device;
  if (d) {
    out.push("ua: " + d.userAgent);
    out.push("tizen: " + (d.platformVersion || "?") + " | model: " + [d.realModel, d.model, d.modelCode].filter((v) => v).join(" / ") + " | fw: " + (d.firmware || "?"));
    out.push("screen: " + d.window + " | display " + (d.display || "?") + " | uhd " + (d.uhdPanel || "?") + " | avplay " + (d.avplayVersion || "?"));
  }
  const x = state.xtream;
  if (x) out.push("xtream: " + x.outcome + " " + x.code + " " + x.ms + "ms " + (x.status || "-") + " max " + (x.maxConnections || "?") + " cats " + x.movieCategories + "/" + x.seriesCategories + (x.message ? " | " + x.message : ""));
  const r = state.range;
  if (r) out.push("range: " + r.outcome + " " + r.code + " " + r.bytes + "B total " + r.total + " tail " + r.tailCode + " " + r.tailBytes + "B" + (r.message ? " | " + r.message : ""));
  const e = state.echo;
  if (e) out.push("echo: " + e.outcome + " " + e.service + " ours=" + e.ourUserAgentArrived + " x=" + e.xUserAgentArrived + (e.refused.length ? " refused " + e.refused.join(",") : "") + " seen " + e.userAgentSeen);
  const o = state.os;
  if (o) {
    const call = (c: { code: number; message: string } | null) => (c ? c.code + (c.message ? " " + c.message : "") : "-");
    out.push("os: " + o.outcome + (o.message ? " (" + o.message + ")" : "") + " | key " + call(o.keyOnly) + " | key+xua " + call(o.keyWithXua) + " | login " + (o.login ? call(o.login) + " allowed " + o.login.allowed + " " + o.login.level + " base " + (o.login.baseUrl || "-") : "-"));
  }
  const s = state.samples;
  if (s) {
    const exts = Object.keys(s.extCounts)
      .sort((a, b) => s.extCounts[b] - s.extCounts[a])
      .map((ext) => ext + ":" + s.extCounts[ext])
      .join(" ");
    out.push("samples: " + s.titlesSeen + " titles, " + s.infoChecked + " info, " + s.withCodecs + " with codecs | " + exts);
  }
  for (const lib of state.library) out.push("library " + lib.kind + ": " + lib.count + " via " + lib.method + " " + Math.round(lib.bytes / 1024) + "KB " + lib.ms + "ms");
  for (const play of state.plays.slice(0, 8)) {
    out.push(
      "play " +
        (play.slots.join(",") || "-") +
        ": " +
        play.outcome +
        (play.error ? " " + play.error : "") +
        (play.startMs ? " " + play.startMs + "ms" : "") +
        (play.seek ? " seek " + play.seek : "") +
        (play.subtitleCues ? " cues " + play.subtitleCues : "") +
        " | " +
        play.title.slice(0, 40) +
        " | " +
        [play.ext, play.videoCodec, play.videoProfile, play.audioCodec].filter((v) => v).join("/") +
        (play.width ? " w" + play.width : "") +
        " | " +
        play.tracks,
    );
  }
  return out.join("\n");
}
