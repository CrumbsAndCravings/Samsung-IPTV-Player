// Samsung AVPlay (webapis.avplay). Video is drawn on a plane underneath the page, into
// the <object type="application/avplayer"> in index.html; the page must be transparent
// wherever the video should show.

import { log } from "../core/log";
import type { OpenOptions, Player, PlayerEvents, Track } from "./player";
import { PlayerError } from "./player";

function parseExtra(text: string): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object") {
      const obj = data as { [key: string]: unknown };
      for (const key of Object.keys(obj)) out[key] = String(obj[key]);
    }
  } catch {
    // Some firmware sends plain text; keep it for the diagnostics screen.
    if (text) out.raw = text;
  }
  return out;
}

export function toTrack(info: AVPlayTrackInfo): Track {
  const detail = parseExtra(info.extra_info);
  const kind = info.type === "VIDEO" || info.type === "AUDIO" ? info.type : "TEXT";
  return {
    index: info.index,
    kind,
    language: (detail.language || detail.track_lang || "").trim(),
    codec: (detail.fourCC || "").trim(),
    detail,
  };
}

export class AvPlayer implements Player {
  readonly kind = "avplay" as const;

  constructor(private av: AVPlay) {}

  open(url: string, events: PlayerEvents, options: OpenOptions = {}): Promise<void> {
    this.close();
    return new Promise<void>((resolve, reject) => {
      try {
        this.av.open(url);
        this.av.setDisplayRect(0, 0, 1920, 1080);
        try {
          this.av.setDisplayMethod("PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO");
        } catch (err) {
          log("setDisplayMethod failed:", err);
        }
        this.av.setListener({
          onbufferingstart: () => events.onBuffering && events.onBuffering("start", 0),
          onbufferingprogress: (percent) => events.onBuffering && events.onBuffering("progress", percent),
          onbufferingcomplete: () => events.onBuffering && events.onBuffering("end", 100),
          oncurrentplaytime: (ms) => events.onTime && events.onTime(ms),
          onstreamcompleted: () => events.onEnded && events.onEnded(),
          onerror: (type) => events.onError && events.onError(String(type)),
          onsubtitlechange: (duration, text) => events.onSubtitle && events.onSubtitle(String(text || ""), Number(duration) || 0),
          onevent: (type, data) => events.onEvent && events.onEvent(String(type), String(data)),
        });
        if (options.uhd) {
          try {
            this.av.setStreamingProperty("SET_MODE_4K", "TRUE");
          } catch (err) {
            log("SET_MODE_4K failed:", err);
          }
        }
        this.av.prepareAsync(
          () => resolve(),
          (err) => reject(new PlayerError((err && err.name) || "PREPARE_FAILED", (err && err.message) || "")),
        );
      } catch (err) {
        const e = err as { name?: string; message?: string };
        reject(new PlayerError(e.name || "OPEN_FAILED", e.message || ""));
      }
    });
  }

  play(): void {
    this.av.play();
  }

  pause(): void {
    this.av.pause();
  }

  seek(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.av.seekTo(
          Math.max(0, Math.floor(ms)),
          () => resolve(),
          (err) => reject(new PlayerError((err && err.name) || "SEEK_FAILED", (err && err.message) || "")),
        );
      } catch (err) {
        const e = err as { name?: string; message?: string };
        reject(new PlayerError(e.name || "SEEK_FAILED", e.message || ""));
      }
    });
  }

  close(): void {
    const state = this.state();
    if (state === "NONE") return;
    try {
      if (state === "PLAYING" || state === "PAUSED" || state === "READY") this.av.stop();
    } catch (err) {
      log("avplay stop failed:", err);
    }
    try {
      this.av.close();
    } catch (err) {
      log("avplay close failed:", err);
    }
  }

  state(): string {
    try {
      return this.av.getState();
    } catch {
      return "NONE";
    }
  }

  currentMs(): number {
    try {
      return this.av.getCurrentTime() || 0;
    } catch {
      return 0;
    }
  }

  durationMs(): number {
    try {
      return this.av.getDuration() || 0;
    } catch {
      return 0;
    }
  }

  tracks(): Track[] {
    try {
      return (this.av.getTotalTrackInfo() || []).map(toTrack);
    } catch (err) {
      log("getTotalTrackInfo failed:", err);
      return [];
    }
  }

  currentTracks(): Track[] {
    try {
      return (this.av.getCurrentStreamInfo() || []).map(toTrack);
    } catch (err) {
      log("getCurrentStreamInfo failed:", err);
      return [];
    }
  }

  selectTrack(kind: "AUDIO" | "TEXT", index: number): void {
    this.av.setSelectTrack(kind, index);
  }

  setSubtitlesHidden(hidden: boolean): void {
    try {
      this.av.setSilentSubtitle(hidden);
    } catch (err) {
      log("setSilentSubtitle failed:", err);
    }
  }

  suspend(): void {
    const state = this.state();
    if (state === "READY" || state === "PLAYING" || state === "PAUSED") this.av.suspend();
  }

  restore(): void {
    const state = this.state();
    if (state === "NONE" || state === "PLAYING" || state === "PAUSED") this.av.restore();
  }
}
