// The player (plan 7.5; the Roku app's PlayerScreen): Samsung's AVPlay underneath our
// own controls. Back and the title on top; play/pause, the bar and the times at the
// bottom; then Episodes, Next episode and Restart. Left/Right preview a jump before it
// happens. Progress is saved for Continue Watching, episodes roll into the next one
// with Up Next, and a failure is retried once before the error screen explains it.

import type { App, Screen } from "../app";
import { FileFacts, learnResult, playCheck, PlayCheck } from "../core/compat";
import type { Item } from "../core/items";
import { log, logError } from "../core/log";
import { barFraction } from "../core/playback";
import { progressPut, progressRemove } from "../core/progress";
import { redact } from "../core/redact";
import { COMMIT_AFTER_MS, SeekPreview, TICK_MS } from "../core/seek";
import { describeCodecs, episodeCode, formatClock, streamUrl } from "../core/utils";
import { currentOf, dueForSave, entryFor, finishedChange, hasNext, resumeFrom, saveAction, Watching } from "../core/watch";
import type { Key } from "../platform/keys";
import { errorLabel, PlayerEvents } from "../platform/player";
import { getPlayer } from "../platform/players";
import { append, clear, h, setText, toggle } from "../ui/dom";

type Row = "top" | "bar" | "buttons";
type ButtonAction = "episodes" | "next" | "restart";
type Mode = "playing" | "error" | "upnext";

const BAR_X = 342;
const BAR_W = 1344;
const HIDE_AFTER_MS = 5000;
const NEVER_STARTED_MS = 25000; // opened without an error but no progress (The Sweeney)
const RETRY_AFTER_MS = 1500; // lets the provider free the one connection first
const UP_NEXT_SECS = 8;
const PANEL_ROWS = 9;

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/><rect x="14" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/></svg>';

function factsOf(item: Item): FileFacts {
  return {
    key: (item.kind === "episode" ? "e:" : "m:") + item.itemId,
    ext: item.ext,
    videoCodec: item.videoCodec,
    videoProfile: item.videoProfile,
    audioCodec: item.audioCodec,
  };
}

function fileLine(item: Item): string {
  const codecs = describeCodecs(item.videoCodec, item.videoProfile, item.audioCodec);
  return "File: " + (item.ext || "?").toUpperCase() + (codecs ? ", " + codecs + "." : ". Your provider didn't list its codecs.");
}

export class PlayerScreen implements Screen {
  readonly el: HTMLElement;
  private player = getPlayer();

  private coverEl: HTMLElement;
  private controlsEl: HTMLElement;
  private backEl: HTMLElement;
  private titleEl: HTMLElement;
  private playEl: HTMLElement;
  private elapsedEl: HTMLElement;
  private remainingEl: HTMLElement;
  private fillEl: HTMLElement;
  private previewEl: HTMLElement;
  private knobEl: HTMLElement;
  private bubbleEl: HTMLElement;
  private noteEl: HTMLElement;
  private buttonsEl: HTMLElement;
  private spinnerEl: HTMLElement;
  private upNextEl: HTMLElement;
  private upNextTitle: HTMLElement;
  private upNextHint: HTMLElement;
  private errorEl: HTMLElement;
  private errorTitle: HTMLElement;
  private errorDetail: HTMLElement;
  private errorHint: HTMLElement;
  private panelEl: HTMLElement;
  private panelList: HTMLElement;

  private mode: Mode = "playing";
  private streamToken = 0;
  private booted = false;
  private closing = false;
  private attempt = 0;
  private errors: string[] = [];
  private started = false;
  private failed = false;
  private check: PlayCheck | null = null;
  private firstTimeMs = -1;
  private positionMs = 0;
  private durationMs = 0;
  private lastSavedSecs = 0;
  private paused = false;
  private introShown = false;
  private seekBroken = false;
  private pendingSeekSecs = 0; // a resume the player refused before playing

  private controlsVisible = false;
  private row: Row = "bar";
  private buttons: { label: string; action: ButtonAction }[] = [];
  private buttonEls: HTMLElement[] = [];
  private buttonIndex = 0;
  private panelOpen = false;
  private cursor = 0;

  private preview = new SeekPreview();
  private holdTimer = 0;
  private commitTimer = 0;
  private hideTimer = 0;
  private stallTimer = 0;
  private retryTimer = 0;
  private countdownTimer = 0;
  private noteTimer = 0;
  private secondsLeft = 0;
  // Samsung asks apps to suspend AVPlay while hidden (the Home button) and restore it
  // when they come back.
  private onVisibility = () => {
    if (this.mode !== "playing" || this.closing) return;
    if (document.hidden) {
      this.saveProgress();
      try {
        this.player.suspend();
      } catch (err) {
        log("suspend failed:", err);
      }
      return;
    }
    try {
      this.player.restore();
    } catch (err) {
      const e = err as Error;
      this.handleError(errorLabel(e.name || "RESTORE_FAILED", e.message || ""));
    }
  };

  constructor(
    private app: App,
    private watching: Watching,
    private index: number,
    private startSecs: number,
    private tryAnyway: boolean,
  ) {
    this.backEl = h("div", { class: "player-back", text: "‹  Back" });
    this.titleEl = h("div", { class: "player-title" });
    this.playEl = h("div", { class: "player-play" });
    this.elapsedEl = h("div", { class: "player-elapsed" });
    this.remainingEl = h("div", { class: "player-remaining" });
    this.fillEl = h("div", { class: "bar-fill" });
    this.previewEl = h("div", { class: "bar-preview" });
    this.knobEl = h("div", { class: "bar-knob" });
    this.bubbleEl = h("div", { class: "player-bubble" });
    this.noteEl = h("div", { class: "player-note" });
    this.buttonsEl = h("div", { class: "player-buttons" });
    this.controlsEl = h("div", { class: "player-controls" }, [
      h("div", { class: "player-top-fade" }),
      h("div", { class: "player-bottom-fade" }),
      this.backEl,
      this.titleEl,
      this.playEl,
      this.elapsedEl,
      h("div", { class: "player-bar" }, [h("div", { class: "bar-track" }), this.fillEl, this.previewEl]),
      this.knobEl,
      this.bubbleEl,
      this.remainingEl,
      this.noteEl,
      this.buttonsEl,
    ]);
    this.coverEl = h("div", { class: "player-cover is-visible" });
    this.spinnerEl = h("div", { class: "player-spinner" });
    this.upNextTitle = h("div", { class: "upnext-title" });
    this.upNextHint = h("div", { class: "upnext-hint" });
    this.upNextEl = h("div", { class: "upnext" }, [h("div", { class: "upnext-eyebrow", text: "UP NEXT" }), this.upNextTitle, this.upNextHint]);
    this.errorTitle = h("div", { class: "player-error-title" });
    this.errorDetail = h("div", { class: "player-error-detail" });
    this.errorHint = h("div", { class: "player-error-hint" });
    this.errorEl = h("div", { class: "player-error" }, [this.errorTitle, this.errorDetail, this.errorHint]);
    this.panelList = h("div", { class: "player-panel-list" });
    this.panelEl = h("div", { class: "player-panel" }, [h("div", { class: "player-panel-title", text: "Episodes" }), this.panelList]);
    this.el = h("div", { class: "screen player" }, [this.coverEl, this.controlsEl, this.spinnerEl, this.upNextEl, this.errorEl, this.panelEl]);
  }

  private get item(): Item {
    return currentOf(this.watching, this.index);
  }

  // --- Starting a title -------------------------------------------------------------

  private startItem(startSecs: number): void {
    this.clearTimers();
    this.preview.cancel();
    this.closePanel(false);
    this.hideControls();
    this.show(this.upNextEl, false);
    this.show(this.errorEl, false);
    this.show(this.coverEl, true);
    this.mode = "playing";
    this.startSecs = startSecs;
    this.attempt = 0;
    this.errors = [];
    this.started = false;
    this.failed = false;
    this.firstTimeMs = -1;
    this.positionMs = startSecs * 1000;
    this.durationMs = this.item.durationSecs * 1000;
    this.lastSavedSecs = startSecs;
    this.paused = false;
    this.introShown = false;
    this.seekBroken = false;
    this.pendingSeekSecs = 0;
    setText(this.noteEl, "");

    const item = this.item;
    const w = this.watching;
    setText(this.titleEl, w.kind === "movie" ? item.title : (w.seriesName || "") + "   ·   " + episodeCode(item.seasonNo, item.episodeNo) + "  " + item.title);
    this.buildButtons();

    // Files this TV can't play would only fail after a wait, so explain up front.
    this.check = playCheck(factsOf(item));
    if (this.check.verdict === "blocked" && !this.tryAnyway) {
      this.showUnplayable(this.check);
      return;
    }
    this.loadStream();
  }

  private loadStream(): void {
    const api = this.app.api;
    if (!api) return this.close();
    const token = ++this.streamToken;
    const item = this.item;
    const ext = (item.ext || "mp4").toLowerCase();
    const url = streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, ext);
    this.show(this.spinnerEl, true);
    log("play", factsOf(item).key, ext, item.videoCodec, item.audioCodec, "attempt", this.attempt + 1);
    this.player
      .open(url, this.events(token), { uhd: item.width > 1920 })
      .then(() => {
        if (token !== this.streamToken) return undefined;
        const total = this.player.durationMs();
        if (total > 0) this.durationMs = total;
        this.stallTimer = window.setTimeout(() => {
          if (token === this.streamToken && !this.started) this.handleError("NO_PROGRESS (it opened but never started)");
        }, NEVER_STARTED_MS);
        const from = resumeFrom(this.startSecs);
        if (from > 0) {
          this.positionMs = from * 1000;
          return this.player.seek(from * 1000).then(
            () => this.resume(),
            (err: Error) => {
              // Some files only seek once playing; try again when it starts.
              log("seek before play failed:", err.name, err.message);
              this.pendingSeekSecs = from;
              this.resume();
            },
          );
        }
        this.resume();
        return undefined;
      })
      .catch((err: Error) => {
        if (token === this.streamToken) this.handleError(errorLabel(err.name, err.message));
      });
  }

  // Closes the stream; anything it still reports afterwards is ignored.
  private stopStream(): void {
    this.streamToken++;
    this.player.close();
  }

  private events(token: number): PlayerEvents {
    const mine = () => token === this.streamToken && !this.closing;
    return {
      onTime: (ms) => mine() && this.onTime(ms),
      onBuffering: (phase) => mine() && this.show(this.spinnerEl, phase !== "end" || !this.started),
      onEnded: () => mine() && this.onEnded(),
      onError: (name) => mine() && this.handleError(name),
      onEvent: (type, data) => log("avplay event", type, data),
    };
  }

  private onTime(ms: number): void {
    this.positionMs = ms;
    if (this.firstTimeMs < 0 && ms > 0) {
      this.firstTimeMs = ms;
      this.show(this.coverEl, false);
    }
    // Only real progress counts as playing, not just opening (a Roku lesson).
    if (!this.started && this.firstTimeMs >= 0 && ms - this.firstTimeMs >= 1000) this.onStarted();
    if (this.started && dueForSave(Math.floor(ms / 1000), this.lastSavedSecs)) this.saveProgress();
    // After a good stretch, a new failure gets its own retry.
    if (this.attempt > 0 && this.started && ms - this.firstTimeMs > 60000) {
      this.attempt = 0;
      this.errors = [];
    }
    if (this.controlsVisible) this.renderBar();
  }

  private onStarted(): void {
    this.started = true;
    window.clearTimeout(this.stallTimer);
    this.show(this.spinnerEl, false);
    const total = this.player.durationMs();
    if (total > 0) this.durationMs = total;
    learnResult(factsOf(this.item), true, "");
    if (this.pendingSeekSecs > 0) {
      const target = this.pendingSeekSecs;
      this.pendingSeekSecs = 0;
      this.applySeek(target);
    }
    // Show the controls briefly the first time, so the buttons are discoverable.
    if (!this.introShown) {
      this.introShown = true;
      this.showControls("bar");
    }
  }

  // --- Progress ---------------------------------------------------------------------

  private saveProgress(): void {
    if (!this.started || this.failed) return;
    const pos = Math.floor(this.positionMs / 1000);
    const dur = Math.floor(this.durationMs / 1000);
    const action = saveAction(pos, dur);
    if (action === "skip") return;
    this.lastSavedSecs = pos;
    if (action === "finished") this.applyFinished();
    else progressPut(entryFor(this.watching, this.index, pos, dur));
  }

  // Movies drop out of Continue Watching; series move on to the next episode.
  private applyFinished(): void {
    const change = finishedChange(this.watching, this.index);
    if (change.put) progressPut(change.put);
    if (change.remove) progressRemove(change.remove);
  }

  private onEnded(): void {
    // An error can be followed by "ended"; only a stream that really played counts.
    if (this.failed || !this.started) return;
    this.applyFinished();
    this.stopStream(); // frees the provider's one connection for the next episode
    if (hasNext(this.watching, this.index)) this.showUpNext();
    else this.close();
  }

  // --- Errors -----------------------------------------------------------------------

  private handleError(label: string): void {
    if (this.failed || this.closing) return;
    this.errors.push(label);
    logError("playback error:", label);
    window.clearTimeout(this.stallTimer);
    if (!this.started) learnResult(factsOf(this.item), false, label);
    this.stopStream();
    if (this.attempt === 0) {
      this.attempt = 1;
      if (this.started) this.startSecs = Math.floor(this.positionMs / 1000);
      this.started = false;
      this.firstTimeMs = -1;
      this.show(this.spinnerEl, true);
      this.retryTimer = window.setTimeout(() => this.loadStream(), RETRY_AFTER_MS);
      return;
    }
    this.failed = true;
    this.mode = "error";
    this.show(this.spinnerEl, false);
    this.show(this.coverEl, true);
    this.hideControls();
    this.closePanel(false);
    setText(this.errorTitle, "This video didn't play");
    setText(this.errorDetail, this.diagnosis());
    setText(this.errorHint, "OK to try again   ·   Back to return");
    this.show(this.errorEl, true);
  }

  // What went wrong, what the file is, and whether this TV plays files like it.
  private diagnosis(): string {
    const item = this.item;
    const lines = ["Samsung's player says: " + this.errors[this.errors.length - 1]];
    if (this.errors.length > 1) lines.push("Tried twice, a moment apart.");
    lines.push(fileLine(item));
    const check = this.check;
    if (check && check.verdict === "blocked") lines.push(check.reason);
    else if (item.videoCodec) lines.push("This TV normally plays files like this, so the stream itself is the likely problem.");
    const api = this.app.api;
    if (api) {
      // Server, username and password are hidden, so a photo of the screen is safe.
      const ext = (item.ext || "mp4").toLowerCase();
      lines.push("Stream: " + redact(streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, ext)));
    }
    return lines.join("\n");
  }

  private showUnplayable(check: PlayCheck): void {
    this.failed = true;
    this.mode = "error";
    this.show(this.spinnerEl, false);
    this.show(this.coverEl, true);
    setText(this.errorTitle, "This TV can't play this file");
    setText(this.errorDetail, check.reason + "\n\n" + fileLine(this.item));
    setText(this.errorHint, "OK to try anyway   ·   Back to return");
    this.show(this.errorEl, true);
  }

  // --- Controls ---------------------------------------------------------------------

  private buildButtons(): void {
    this.buttons = [];
    if (this.watching.kind === "episode") {
      this.buttons.push({ label: "Episodes", action: "episodes" });
      if (hasNext(this.watching, this.index)) this.buttons.push({ label: "Next episode", action: "next" });
    }
    this.buttons.push({ label: "Restart", action: "restart" });
    this.buttonEls = this.buttons.map((b) => h("div", { class: "pill", text: b.label }));
    clear(this.buttonsEl);
    append(this.buttonsEl, this.buttonEls);
    this.buttonIndex = 0;
  }

  private show(el: HTMLElement, on: boolean): void {
    toggle(el, "is-visible", on);
  }

  private showControls(row: Row): void {
    this.controlsVisible = true;
    this.row = row;
    this.show(this.controlsEl, true);
    this.renderControls();
    this.restartHideTimer();
  }

  private hideControls(): void {
    this.controlsVisible = false;
    this.show(this.controlsEl, false);
    window.clearTimeout(this.hideTimer);
  }

  private restartHideTimer(): void {
    window.clearTimeout(this.hideTimer);
    if (this.paused) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.preview.active || this.panelOpen || this.paused) return;
      this.hideControls();
    }, HIDE_AFTER_MS);
  }

  private setRow(row: Row): void {
    this.row = row;
    this.renderControls();
    this.restartHideTimer();
  }

  private renderControls(): void {
    toggle(this.backEl, "is-focused", this.row === "top");
    this.buttonEls.forEach((el, i) => toggle(el, "is-focused", this.row === "buttons" && i === this.buttonIndex));
    this.renderPlayButton();
    this.renderBar();
  }

  private renderPlayButton(): void {
    this.playEl.innerHTML = this.paused ? PLAY_ICON : PAUSE_ICON;
    toggle(this.playEl, "is-focused", this.row === "bar");
  }

  private renderBar(): void {
    const duration = this.durationMs / 1000;
    const position = this.positionMs / 1000;
    const shown = this.preview.active ? this.preview.target : position;
    setText(this.elapsedEl, formatClock(shown));
    setText(this.remainingEl, duration > 0 ? "-" + formatClock(Math.max(0, duration - shown)) : "");
    const played = barFraction(position, duration);
    const target = barFraction(shown, duration);
    this.fillEl.style.width = Math.round(BAR_W * played) + "px";
    const previewing = this.preview.active && duration > 0;
    toggle(this.previewEl, "is-visible", previewing);
    if (previewing) {
      const low = Math.min(played, target);
      this.previewEl.style.transform = "translateX(" + Math.round(BAR_W * low) + "px)";
      this.previewEl.style.width = Math.round(BAR_W * Math.abs(target - played)) + "px";
    }
    const knobX = BAR_X + BAR_W * target;
    this.knobEl.style.transform = "translateX(" + Math.round(knobX - 14) + "px)";
    toggle(this.knobEl, "is-visible", this.row === "bar");
    toggle(this.bubbleEl, "is-visible", this.preview.active);
    if (this.preview.active) {
      setText(this.bubbleEl, formatClock(shown));
      const x = Math.max(BAR_X - 60, Math.min(1848 - 156, knobX - 78));
      this.bubbleEl.style.transform = "translateX(" + Math.round(x) + "px)";
    }
  }

  private note(text: string): void {
    setText(this.noteEl, text);
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => setText(this.noteEl, ""), 4000);
  }

  private resume(): void {
    this.player.play();
    this.paused = false;
    if (this.controlsVisible) {
      this.renderPlayButton();
      this.restartHideTimer();
    }
  }

  private togglePause(): void {
    if (!this.started) return;
    if (this.paused) {
      this.resume();
      return;
    }
    this.player.pause();
    this.paused = true;
    this.saveProgress();
    this.showControls(this.controlsVisible ? this.row : "bar");
  }

  // --- Jump preview -----------------------------------------------------------------

  private beginHold(key: Key, direction: number): void {
    if (!this.started) return;
    if (this.seekBroken) {
      if (!this.controlsVisible) this.showControls("bar");
      this.note("Jumping isn't available in this video.");
      return;
    }
    window.clearTimeout(this.commitTimer);
    const fresh = this.preview.press(key, direction, this.positionMs / 1000, this.durationMs / 1000, Date.now());
    if (fresh && !this.holdTimer) {
      this.holdTimer = window.setInterval(() => {
        this.preview.tick(this.durationMs / 1000, Date.now());
        this.renderBar();
        if (!this.preview.holding) this.stopHoldTimer();
      }, TICK_MS);
    }
    if (!this.controlsVisible) this.showControls("bar");
    else this.renderBar();
    this.restartHideTimer();
  }

  private stopHoldTimer(): void {
    window.clearInterval(this.holdTimer);
    this.holdTimer = 0;
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      const target = this.preview.due(Date.now());
      if (target >= 0) this.applySeek(target);
    }, COMMIT_AFTER_MS + 20);
  }

  private cancelSeek(): void {
    this.preview.cancel();
    window.clearInterval(this.holdTimer);
    this.holdTimer = 0;
    window.clearTimeout(this.commitTimer);
  }

  private applySeek(targetSecs: number): void {
    this.cancelSeek();
    this.lastSavedSecs = Math.floor(targetSecs);
    this.positionMs = targetSecs * 1000;
    this.renderBar();
    this.restartHideTimer();
    this.player.seek(targetSecs * 1000).catch((err: Error) => {
      logError("seek failed:", err.name, err.message);
      this.seekBroken = true;
      this.note("Jumping isn't available in this video.");
    });
  }

  // --- Buttons, episodes, Up Next ---------------------------------------------------

  private runButton(): void {
    const button = this.buttons[this.buttonIndex];
    if (!button) return;
    if (button.action === "episodes") this.openPanel();
    else if (button.action === "next") this.goToEpisode(this.index + 1);
    else if (button.action === "restart") {
      this.applySeek(0);
      this.lastSavedSecs = 0;
      if (this.paused) this.resume();
      this.setRow("bar");
    }
  }

  // Another episode from the queue; Continue Watching follows.
  private goToEpisode(index: number): void {
    this.saveProgress();
    progressPut(entryFor(this.watching, index, 0, 0));
    this.index = index;
    this.tryAnyway = false;
    this.stopStream();
    this.startItem(0);
  }

  private openPanel(): void {
    this.cancelSeek();
    this.cursor = this.index;
    this.hideControls();
    this.panelOpen = true;
    this.show(this.panelEl, true);
    this.renderPanel();
  }

  private closePanel(backToControls: boolean): void {
    this.panelOpen = false;
    this.show(this.panelEl, false);
    if (backToControls) this.showControls("buttons");
  }

  private renderPanel(): void {
    const queue = this.watching.queue || [];
    clear(this.panelList);
    let first = this.cursor - Math.floor(PANEL_ROWS / 2);
    first = Math.max(0, Math.min(first, queue.length - PANEL_ROWS));
    for (let i = first; i < Math.min(queue.length, first + PANEL_ROWS); i++) {
      const ep = queue[i];
      const row = h("div", { class: "panel-row" + (i === this.cursor ? " is-focused" : "") + (i === this.index ? " is-active" : "") }, [
        h("span", { class: "panel-dot" }),
        h("span", { class: "panel-label", text: episodeCode(ep.seasonNo, ep.episodeNo) + "   " + ep.title }),
      ]);
      this.panelList.appendChild(row);
    }
  }

  private onPanelKey(key: Key): void {
    const count = (this.watching.queue || []).length;
    if (key === "back") this.closePanel(true);
    else if (key === "up" && this.cursor > 0) {
      this.cursor--;
      this.renderPanel();
    } else if (key === "down" && this.cursor < count - 1) {
      this.cursor++;
      this.renderPanel();
    } else if (key === "ok") {
      if (this.cursor === this.index) this.closePanel(true);
      else {
        this.closePanel(false);
        this.goToEpisode(this.cursor);
      }
    }
  }

  private showUpNext(): void {
    const next = currentOf(this.watching, this.index + 1);
    this.mode = "upnext";
    this.hideControls();
    this.closePanel(false);
    this.show(this.coverEl, true);
    setText(this.upNextTitle, episodeCode(next.seasonNo, next.episodeNo) + "  " + next.title);
    this.secondsLeft = UP_NEXT_SECS;
    this.updateCountdown();
    this.show(this.upNextEl, true);
    this.countdownTimer = window.setInterval(() => {
      this.secondsLeft--;
      if (this.secondsLeft <= 0) this.playNext();
      else this.updateCountdown();
    }, 1000);
  }

  private updateCountdown(): void {
    setText(this.upNextHint, "Starts in " + this.secondsLeft + "   ·   OK to play now");
  }

  private playNext(): void {
    window.clearInterval(this.countdownTimer);
    this.index++;
    this.tryAnyway = false;
    this.startItem(0);
  }

  // --- Leaving ----------------------------------------------------------------------

  private leave(): void {
    if (!this.failed) this.saveProgress();
    this.close();
  }

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    this.clearTimers();
    this.stopStream();
    this.app.pop();
  }

  private clearTimers(): void {
    this.cancelSeek();
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.stallTimer);
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.noteTimer);
    window.clearInterval(this.countdownTimer);
  }

  // --- Keys -------------------------------------------------------------------------

  onKey(key: Key): void {
    if (this.panelOpen) return this.onPanelKey(key);
    if (this.mode === "error") {
      if (key === "ok") {
        if (this.check && this.check.verdict === "blocked") this.tryAnyway = true;
        this.startItem(this.startSecs);
      } else if (key === "back" || key === "stop") this.close();
      return;
    }
    if (this.mode === "upnext") {
      if (key === "ok" || key === "play" || key === "playpause") this.playNext();
      else if (key === "back" || key === "stop") this.close();
      return;
    }

    // Back cancels a jump preview, then hides the controls, then leaves.
    if (key === "back") {
      if (this.preview.active) {
        this.cancelSeek();
        this.renderBar();
        this.restartHideTimer();
      } else if (this.controlsVisible) this.hideControls();
      else this.leave();
      return;
    }
    if (key === "stop") return this.leave();
    if (key === "playpause") return this.togglePause();
    if (key === "play") {
      if (this.paused) this.togglePause();
      return;
    }
    if (key === "pause") {
      if (!this.paused) this.togglePause();
      return;
    }
    if (key === "rew" || key === "ff") {
      if (this.controlsVisible && this.row !== "bar") this.setRow("bar");
      return this.beginHold(key, key === "rew" ? -1 : 1);
    }

    if (!this.controlsVisible) {
      if (key === "ok") {
        if (!this.paused) this.togglePause();
        else this.showControls("bar");
      } else if (key === "up" || key === "down") this.showControls("bar");
      else if (key === "left" || key === "right") this.beginHold(key, key === "left" ? -1 : 1);
      return;
    }

    this.restartHideTimer();
    if (this.row === "bar") {
      if (key === "ok") {
        if (this.preview.active) this.applySeek(this.preview.commit());
        else this.togglePause();
      } else if (key === "left" || key === "right") this.beginHold(key, key === "left" ? -1 : 1);
      else if (key === "up") this.setRow("top");
      else if (key === "down") this.setRow("buttons");
    } else if (this.row === "top") {
      if (key === "ok") this.leave();
      else if (key === "down") this.setRow("bar");
    } else if (this.row === "buttons") {
      if (key === "left" && this.buttonIndex > 0) {
        this.buttonIndex--;
        this.renderControls();
      } else if (key === "right" && this.buttonIndex < this.buttons.length - 1) {
        this.buttonIndex++;
        this.renderControls();
      } else if (key === "ok") this.runButton();
      else if (key === "up") this.setRow("bar");
    }
  }

  // Releasing Left/Right ends a hold; the jump follows 0.8 s later.
  onKeyUp(key: Key): void {
    if (key === "left" || key === "right" || key === "rew" || key === "ff") {
      this.preview.release(key, Date.now());
      if (!this.preview.holding && this.preview.active) {
        window.clearInterval(this.holdTimer);
        this.holdTimer = 0;
        this.scheduleCommit();
      }
    }
  }

  // --- Screen -----------------------------------------------------------------------

  onShow(): void {
    document.body.classList.add("playing");
    if (this.booted) return;
    this.booted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.startItem(this.startSecs);
  }

  onHide(): void {
    document.body.classList.remove("playing");
  }

  destroy(): void {
    this.closing = true;
    this.clearTimers();
    this.stopStream();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}
