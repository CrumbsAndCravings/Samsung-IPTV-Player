// Desktop stand-in for AVPlay, for the development harness. <video> plays MP4 (H.264,
// AAC) in desktop Chrome; everything else fails with the browser's error.

import type { OpenOptions, Player, PlayerEvents, Track } from "./player";
import { PlayerError } from "./player";

const MEDIA_ERRORS: { [code: number]: string } = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

export class Html5Player implements Player {
  readonly kind = "html5" as const;
  private video: HTMLVideoElement | null = null;
  private opened = false;

  open(url: string, events: PlayerEvents, _options: OpenOptions = {}): Promise<void> {
    this.close();
    const video = document.createElement("video");
    video.className = "html5-player";
    video.preload = "auto";
    document.body.insertBefore(video, document.body.firstChild);
    this.video = video;
    this.opened = true;
    const errorName = () => (video.error ? MEDIA_ERRORS[video.error.code] || "MEDIA_ERR_" + video.error.code : "MEDIA_ERR");
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      video.addEventListener("loadedmetadata", () => {
        ready = true;
        resolve();
      });
      video.addEventListener("error", () => {
        if (!ready) reject(new PlayerError(errorName(), "The browser couldn't open this video."));
        else if (events.onError) events.onError(errorName());
      });
      video.addEventListener("timeupdate", () => events.onTime && events.onTime(Math.floor(video.currentTime * 1000)));
      video.addEventListener("waiting", () => events.onBuffering && events.onBuffering("start", 0));
      video.addEventListener("playing", () => events.onBuffering && events.onBuffering("end", 100));
      video.addEventListener("ended", () => events.onEnded && events.onEnded());
      video.src = url;
      video.load();
    });
  }

  play(): void {
    if (this.video) this.video.play().catch(() => undefined);
  }

  pause(): void {
    if (this.video) this.video.pause();
  }

  seek(ms: number): Promise<void> {
    if (this.video) this.video.currentTime = Math.max(0, ms) / 1000;
    return Promise.resolve();
  }

  close(): void {
    if (!this.video) return;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
    this.video = null;
    this.opened = false;
  }

  state(): string {
    if (!this.video || !this.opened) return "NONE";
    if (this.video.readyState < 1) return "IDLE";
    return this.video.paused ? "PAUSED" : "PLAYING";
  }

  currentMs(): number {
    return this.video ? Math.floor(this.video.currentTime * 1000) : 0;
  }

  durationMs(): number {
    return this.video && isFinite(this.video.duration) ? Math.floor(this.video.duration * 1000) : 0;
  }

  tracks(): Track[] {
    return [];
  }

  selectTrack(): void {
    // Desktop Chrome has no audio track switching.
  }

  setSubtitlesHidden(): void {
    // No embedded subtitles in the desktop player.
  }

  suspend(): void {
    this.pause();
  }

  restore(): void {
    // Nothing to restore on a desktop.
  }
}
