// Plays one file full screen with AVPlay and records what happened: whether it really
// started (progress, not just "opened"), how long that took, the player's error name if
// it failed, whether seeking works, and which audio and subtitle tracks the file has.

import { log, logError } from "../core/log";
import { formatClock } from "../core/utils";
import type { Key } from "../platform/keys";
import type { Player, Track } from "../platform/player";
import { getPlayer } from "../platform/players";
import { h, setText, toggle } from "../ui/dom";
import type { KeyTarget } from "../ui/focus";
import type { PlayResult } from "./report";
import { Sample, slotsFor } from "./samples";

const STALL_MS = 30000;
const REAL_PLAYBACK_MS = 2000;
const JUMP_MS = 30000;

function detailValue(track: Track, names: string[]): string {
  for (const key of Object.keys(track.detail)) {
    if (names.indexOf(key.toLowerCase()) >= 0) return track.detail[key];
  }
  return "";
}

export function describeTracks(tracks: Track[]): string {
  const video = tracks
    .filter((t) => t.kind === "VIDEO")
    .map((t) => {
      const w = detailValue(t, ["width"]);
      const hgt = detailValue(t, ["height"]);
      return (t.codec || "?") + (w && hgt ? " " + w + "x" + hgt : "");
    });
  const audio = tracks
    .filter((t) => t.kind === "AUDIO")
    .map((t) => {
      const ch = detailValue(t, ["channels"]);
      return [t.language || "und", t.codec, ch ? ch + "ch" : ""].filter((v) => v).join(" ");
    });
  const text = tracks.filter((t) => t.kind === "TEXT").map((t) => [t.language || "und", t.codec].filter((v) => v).join(" "));
  const parts: string[] = [];
  if (video.length) parts.push("V: " + video.join(", "));
  if (audio.length) parts.push("A: " + audio.join(", "));
  parts.push("T: " + (text.length ? text.join(", ") : "none"));
  return parts.join(" · ");
}

// AVPlay reports failures as a generic WebAPIException name (TypeMismatchError,
// UnknownError…) with the real reason, PLAYER_ERROR_*, in the message.
export function errorLabel(name: string, detail: string): string {
  const code = /PLAYER_ERROR_[A-Z_]+/.exec(detail);
  if (code) return code[0];
  return detail ? name + ": " + detail : name;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "");
}

export class PlayTest implements KeyTarget {
  private player: Player = getPlayer();
  private root: HTMLElement;
  private stateEl: HTMLElement;
  private tracksEl: HTMLElement;
  private noteEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private cardEl: HTMLElement;
  private hintEl: HTMLElement;
  private result: PlayResult;
  private openedAt = 0;
  private firstTime = -1;
  private firstTimeAt = 0;
  private played = false;
  private buffering = "";
  private ticker = 0;
  private subtitleTimer = 0;
  private stallTimer = 0;
  private tracks: Track[] = [];
  private audioPick = -1;
  private textPick = -1; // -1 = off
  private finished = false;

  constructor(
    host: HTMLElement,
    private sample: Sample,
    private url: string,
    private done: (result: PlayResult) => void,
  ) {
    this.result = {
      key: sample.key,
      title: sample.title,
      ext: sample.ext,
      videoCodec: sample.videoCodec,
      videoProfile: sample.videoProfile,
      audioCodec: sample.audioCodec,
      width: sample.width,
      slots: slotsFor(sample),
      outcome: "stopped",
      error: "",
      startMs: 0,
      seek: "",
      tracks: "",
      player: this.player.kind,
      at: Date.now(),
    };
    this.stateEl = h("div", { class: "pt-line", text: "Opening…" });
    this.tracksEl = h("div", { class: "pt-line" });
    this.noteEl = h("div", { class: "pt-line pt-error" });
    this.cardEl = h("div", { class: "pt-card" }, [
      h("div", { class: "pt-title", text: sample.title }),
      h("div", { class: "pt-meta", text: sample.ext.toUpperCase() + " · as reported by your provider: " + (sample.videoCodec || "?") + (sample.videoProfile ? " " + sample.videoProfile : "") + " / " + (sample.audioCodec || "?") }),
      this.stateEl,
      this.tracksEl,
      this.noteEl,
    ]);
    this.subtitleEl = h("div", { class: "pt-subtitle" });
    this.hintEl = h("div", {
      class: "pt-hint",
      text: "OK pause · Left/Right jump 30 s · Up next audio · Down next subtitles · Back stop and save",
    });
    this.root = h("div", { class: "playtest" }, [this.subtitleEl, this.cardEl, this.hintEl]);
    host.appendChild(this.root);
  }

  start(): void {
    document.body.classList.add("playing");
    this.open();
    this.ticker = window.setInterval(() => this.render(), 500);
  }

  private open(): void {
    this.finished = false;
    this.played = false;
    this.firstTime = -1;
    this.result.outcome = "stopped";
    this.result.error = "";
    setText(this.noteEl, "");
    this.openedAt = Date.now();
    log("play", this.sample.key, this.sample.ext, this.sample.videoCodec, this.sample.audioCodec);
    this.player
      .open(
        this.url,
        {
          onTime: (ms) => this.onTime(ms),
          onBuffering: (phase, percent) => {
            this.buffering = phase === "end" ? "" : "buffering " + percent + "%";
          },
          onEnded: () => log("stream completed"),
          onError: (name) => this.fail(name, ""),
          onSubtitle: (text, duration) => this.showSubtitle(text, duration),
          onEvent: (type, data) => log("avplay event", type, data),
        },
        { uhd: this.sample.width > 1920 },
      )
      .then(() => {
        this.tracks = this.player.tracks();
        this.result.tracks = describeTracks(this.tracks);
        log("tracks", this.result.tracks);
        this.player.play();
        window.clearTimeout(this.stallTimer);
        this.stallTimer = window.setTimeout(() => {
          if (!this.played && !this.finished) {
            this.result.outcome = "stalled";
            setText(this.noteEl, "No progress after 30 s.");
          }
        }, STALL_MS);
      })
      .catch((err: Error) => this.fail(err.name, err.message));
  }

  private onTime(ms: number): void {
    if (this.firstTime < 0 && ms > 0) {
      this.firstTime = ms;
      this.firstTimeAt = Date.now();
    }
    // Only real progress counts as playing, not opening (lesson from the Roku build).
    if (!this.played && this.firstTime >= 0 && ms - this.firstTime >= REAL_PLAYBACK_MS) {
      this.played = true;
      this.result.outcome = "played";
      this.result.error = "";
      this.result.startMs = this.firstTimeAt - this.openedAt;
      setText(this.noteEl, "");
      log("playing after", this.result.startMs, "ms");
    }
  }

  private fail(name: string, detail: string): void {
    if (this.finished) return;
    logError("playback error:", name, detail);
    // Errors after real playback (and the "ended" that can follow them) don't undo it.
    if (!this.played) {
      this.result.outcome = "failed";
      this.result.error = errorLabel(name, detail);
    }
    setText(this.noteEl, "Error: " + name + (detail ? " (" + detail + ")" : "") + (this.played ? "" : " · OK to try again"));
    this.player.close();
  }

  private showSubtitle(text: string, durationMs: number): void {
    setText(this.subtitleEl, stripTags(text));
    window.clearTimeout(this.subtitleTimer);
    if (durationMs > 0) this.subtitleTimer = window.setTimeout(() => setText(this.subtitleEl, ""), durationMs);
  }

  private render(): void {
    const state = this.player.state();
    const now = this.player.currentMs();
    const total = this.player.durationMs();
    const parts = [state, formatClock(now / 1000) + " / " + (total > 0 ? formatClock(total / 1000) : "?")];
    if (this.buffering) parts.push(this.buffering);
    if (this.played) parts.push("started in " + (this.result.startMs / 1000).toFixed(1) + " s");
    if (this.result.seek) parts.push("seek " + this.result.seek);
    setText(this.stateEl, parts.join(" · "));
    setText(this.tracksEl, this.result.tracks);
  }

  private jump(deltaMs: number): void {
    const now = this.player.currentMs();
    const total = this.player.durationMs();
    let target = Math.max(0, now + deltaMs);
    if (total > 0) target = Math.min(target, total - 3000);
    this.player
      .seek(target)
      .then(() => {
        window.setTimeout(() => {
          const landed = this.player.currentMs();
          this.result.seek = Math.abs(landed - target) < 8000 ? "ok" : "failed";
          log("seek to", target, "landed at", landed);
        }, 1500);
      })
      .catch((err: Error) => {
        this.result.seek = "failed";
        logError("seek failed:", err.name, err.message);
      });
  }

  private nextTrack(kind: "AUDIO" | "TEXT"): void {
    const list = this.tracks.filter((t) => t.kind === kind);
    if (list.length === 0) {
      setText(this.noteEl, kind === "AUDIO" ? "This file has one audio track." : "This file has no subtitle tracks.");
      return;
    }
    try {
      if (kind === "AUDIO") {
        this.audioPick = (this.audioPick + 1) % list.length;
        const track = list[this.audioPick];
        this.player.selectTrack("AUDIO", track.index);
        setText(this.noteEl, "Audio: " + (track.language || "track " + track.index) + " " + track.codec);
      } else {
        // Cycles through the tracks, then off.
        this.textPick = this.textPick + 1 >= list.length ? -1 : this.textPick + 1;
        if (this.textPick < 0) {
          this.player.setSubtitlesHidden(true);
          setText(this.subtitleEl, "");
          setText(this.noteEl, "Subtitles off");
        } else {
          const track = list[this.textPick];
          this.player.selectTrack("TEXT", track.index);
          this.player.setSubtitlesHidden(false);
          setText(this.noteEl, "Subtitles: " + (track.language || "track " + track.index) + " " + track.codec);
        }
      }
    } catch (err) {
      const e = err as Error;
      setText(this.noteEl, "Couldn't switch tracks: " + e.name);
      logError("track switch failed:", e);
    }
  }

  onKey(key: Key): void {
    const state = this.player.state();
    toggle(this.cardEl, "is-hidden", false);
    toggle(this.hintEl, "is-hidden", false);
    switch (key) {
      case "back":
      case "stop":
        this.finish();
        break;
      case "ok":
      case "playpause":
        if (state === "NONE" || state === "IDLE") this.open();
        else if (state === "PLAYING") this.player.pause();
        else this.player.play();
        break;
      case "play":
        this.player.play();
        break;
      case "pause":
        this.player.pause();
        break;
      case "left":
      case "rew":
        this.jump(-JUMP_MS);
        break;
      case "right":
      case "ff":
        this.jump(JUMP_MS);
        break;
      case "up":
        this.nextTrack("AUDIO");
        break;
      case "down":
        this.nextTrack("TEXT");
        break;
      default:
        break;
    }
  }

  private finish(): void {
    this.finished = true;
    window.clearInterval(this.ticker);
    window.clearTimeout(this.stallTimer);
    window.clearTimeout(this.subtitleTimer);
    this.player.close();
    document.body.classList.remove("playing");
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.result.at = Date.now();
    this.done(this.result);
  }
}
