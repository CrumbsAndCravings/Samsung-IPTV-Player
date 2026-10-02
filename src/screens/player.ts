// The player (plan 7.5; the Roku app's PlayerScreen): Samsung's AVPlay underneath our
// own controls. Back and the title on top; play/pause, the bar and the times at the
// bottom; then Audio & subtitles, Episodes, Next episode and Restart. Left/Right preview
// a jump before it happens. Progress is saved for Continue Watching, episodes roll into
// the next one with Up Next, and a failure is retried once before the error screen
// explains it.
//
// Subtitles (plan 7.5 and 7.6): AVPlay never draws them, so ARAN+ does. A file's own
// tracks arrive cue by cue through onSubtitle; online ones are fetched from OpenSubtitles
// once and timed against the player's position, so nudging them costs no download.

import type { App, Screen } from "../app";
import { FileFacts, learnResult, playCheck, PlayCheck } from "../core/compat";
import type { Item } from "../core/items";
import { log, logError } from "../core/log";
import type { FindRequest } from "../core/opensubtitles";
import { barFraction } from "../core/playback";
import { progressPut, progressRemove } from "../core/progress";
import { redact } from "../core/redact";
import { httpDetail, isRefusalCode } from "../core/refusals";
import { COMMIT_AFTER_MS, JumpResult, SeekPreview, SeekRunner, TICK_MS } from "../core/seek";
import { cleanCueText, CueTrack, parseSubtitles } from "../core/srt";
import { loadOsAccount, loadPrefs, savePref } from "../core/storage";
import { activeSubtitle, audioPlan, freshOnline, NUDGE_MS, OnlineStatus, SubtitleSource, subtitleMenu, subtitlePlan, tracksNote } from "../core/subtitles";
import { audioNowText, audioOptions, audioRescue, fromAvplay, optionIndex, subtitleOptions, TrackOption } from "../core/tracks";
import { describeCodecs, episodeCode, formatClock, streamUrl } from "../core/utils";
import { currentOf, dueForSave, entryFor, finishedChange, hasNext, resumeFrom, saveAction, Watching } from "../core/watch";
import { knownHash, movieHash } from "../data/moviehash";
import { OsClient } from "../data/opensubtitles";
import { send } from "../platform/http";
import type { Key } from "../platform/keys";
import { errorLabel, PlayerEvents } from "../platform/player";
import { getPlayer } from "../platform/players";
import { append, clear, h, setText, toggle } from "../ui/dom";
import { SubtitleSetupScreen } from "./subtitle-setup";

type Row = "top" | "bar" | "buttons";
type ButtonAction = "tracks" | "episodes" | "next" | "restart";
type Mode = "playing" | "error" | "upnext";
type Panel = "" | "tracks" | "episodes";

const BAR_X = 342;
const BAR_W = 1344;
const HIDE_AFTER_MS = 5000;
const NEVER_STARTED_MS = 25000; // opened without an error but no progress (The Sweeney)
const RETRY_AFTER_MS = 1500; // lets the provider free the one connection first
const UP_NEXT_SECS = 8;
const PANEL_ROWS = 9;
const TRACK_ROWS = 7;
const AUTO_SUBTITLES_AFTER_MS = 2500; // Roku's autoSubTimer
const SUBTITLE_TICK_MS = 100;
const RESCUE_NOTE_MS = 9000;
const SYNC_EVERY_MS = 5 * 60000;
const CHECK_STREAM_MS = 10000;

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
  private subtitleEl: HTMLElement;
  private tracksEl: HTMLElement;
  private audioList: HTMLElement;
  private subsList: HTMLElement;
  private tracksNoteEl: HTMLElement;

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
  private seekError = "";
  private seeker: SeekRunner | null = null;
  private pendingSeekSecs = 0; // a resume the player refused before playing

  private controlsVisible = false;
  private row: Row = "bar";
  private buttons: { label: string; action: ButtonAction }[] = [];
  private buttonEls: HTMLElement[] = [];
  private buttonIndex = 0;
  private panel: Panel = "";
  private cursor = 0;

  // Audio & subtitles
  private column = 1; // 0 audio, 1 subtitles
  private audioCursor = 0;
  private subCursor = 0;
  private audioOpts: TrackOption[] = [];
  private embeddedOpts: TrackOption[] = subtitleOptions([]);
  private subMenu: TrackOption[] = [];
  private currentAudio = "";
  private chosenAudio = ""; // picked for this video, put back after a retry
  private tracksApplied = false;
  private source: SubtitleSource = { kind: "off" };
  private online: OnlineStatus = freshOnline(false);
  private cues: CueTrack | null = null;
  private osToken = 0;
  private hash = "";
  private timeAt = 0; // when positionMs last arrived

  private preview = new SeekPreview();
  private holdTimer = 0;
  private commitTimer = 0;
  private hideTimer = 0;
  private stallTimer = 0;
  private retryTimer = 0;
  private countdownTimer = 0;
  private noteTimer = 0;
  private subtitleTimer = 0;
  private subtitleTick = 0;
  private autoTimer = 0;
  private secondsLeft = 0;
  private syncTimer = 0;
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
    this.subtitleEl = h("div", { class: "player-subtitle" });
    this.audioList = h("div", { class: "tracks-list tracks-audio" });
    this.subsList = h("div", { class: "tracks-list tracks-subs" });
    this.tracksNoteEl = h("div", { class: "tracks-note" });
    this.tracksEl = h("div", { class: "player-panel player-tracks" }, [
      h("div", { class: "player-panel-title", text: "Audio & subtitles" }),
      h("div", { class: "tracks-heading tracks-heading-audio", text: "AUDIO" }),
      this.audioList,
      h("div", { class: "tracks-heading tracks-heading-subs", text: "SUBTITLES" }),
      this.subsList,
      this.tracksNoteEl,
    ]);
    this.el = h("div", { class: "screen player" }, [this.coverEl, this.subtitleEl, this.controlsEl, this.spinnerEl, this.upNextEl, this.errorEl, this.panelEl, this.tracksEl]);
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
    this.seekError = "";
    this.pendingSeekSecs = 0;
    setText(this.noteEl, "");
    this.resetSubtitles();

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
    this.hashThenLoad();
  }

  // Online subtitles "timed for this file" need the file's moviehash, read from its
  // first and last 64 KB. The provider allows one connection, so that happens before
  // the video opens (a moment's wait, once per title), and only when OpenSubtitles is
  // set up and subtitles weren't turned off.
  private hashThenLoad(): void {
    const api = this.app.api;
    const key = factsOf(this.item).key;
    this.hash = knownHash(key);
    const wanted = this.online.configured && loadPrefs().subtitles !== "off";
    if (this.hash || !wanted || !api) {
      this.loadStream();
      return;
    }
    const token = ++this.streamToken;
    const item = this.item;
    this.show(this.spinnerEl, true);
    movieHash(key, streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, (item.ext || "mp4").toLowerCase())).then((hash) => {
      if (token !== this.streamToken || this.closing) return;
      log("moviehash", hash ? "ready" : "unavailable");
      this.hash = hash;
      this.loadStream();
    });
  }

  private loadStream(): void {
    const api = this.app.api;
    if (!api) return this.close();
    const token = ++this.streamToken;
    this.seeker = this.newSeeker();
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
      onSubtitle: (text, durationMs) => mine() && this.onEmbeddedCue(text, durationMs),
      onEvent: (type, data) => log("avplay event", type, data),
    };
  }

  private onTime(ms: number): void {
    this.positionMs = ms;
    this.timeAt = Date.now();
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
    this.applyTracks();
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
    this.clearSubtitle();
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
    this.checkStream();
  }

  // Asks the server for the start of the stream, to say whether it refused it (a trial
  // that doesn't include it, one device at a time, an ended trial) rather than the TV
  // failing to play it. The player has let go of the connection by now.
  private checkStream(): void {
    const api = this.app.api;
    if (!api) return;
    const item = this.item;
    const token = this.streamToken;
    const url = streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, (item.ext || "mp4").toLowerCase());
    send({ url, headers: { Range: "bytes=0-1023" }, timeoutMs: CHECK_STREAM_MS, maxBytes: 65536 }).promise.then((res) => {
      if (token !== this.streamToken || this.closing || !this.failed) return;
      let line = "";
      if (res.timedOut) line = "Asked the server for the stream again: no answer in 10 seconds.";
      else if (res.code === 0) line = "Asked the server for the stream again: the connection failed.";
      else if (res.code >= 400) {
        line = "Asked the server for the stream again: " + redact(httpDetail(res.code, res.headers(), res.text)) + ".";
        if (isRefusalCode(res.code)) line += " The provider refused it. The trial may not include it, may allow one device at a time, or may have ended.";
      }
      log("stream check:", res.code, line);
      if (line) setText(this.errorDetail, this.diagnosis() + "\n" + line);
    });
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
    this.buttons = [{ label: "Audio & subtitles", action: "tracks" }];
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
    toggle(this.subtitleEl, "is-lifted", true);
    this.renderControls();
    this.restartHideTimer();
  }

  private hideControls(): void {
    this.controlsVisible = false;
    this.show(this.controlsEl, false);
    toggle(this.subtitleEl, "is-lifted", false);
    window.clearTimeout(this.hideTimer);
  }

  private restartHideTimer(): void {
    window.clearTimeout(this.hideTimer);
    if (this.paused) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.preview.active || this.panel || this.paused) return;
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

  private note(text: string, ms = 4000): void {
    setText(this.noteEl, text);
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => setText(this.noteEl, ""), ms);
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
      this.note("Jumping isn't working in this video (" + this.seekError + ").");
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
    this.timeAt = Date.now();
    this.renderBar();
    this.restartHideTimer();
    if (this.seeker) this.seeker.jump(targetSecs * 1000);
  }

  // Jumps for this stream go through here one at a time (core/seek.ts SeekRunner).
  private newSeeker(): SeekRunner {
    const runner: SeekRunner = new SeekRunner(
      (ms) =>
        this.player.seek(ms).catch((err: Error) => {
          throw new Error(errorLabel(err.name, err.message));
        }),
      (result: JumpResult) => {
        if (runner !== this.seeker || this.closing || result.ok) return;
        logError("jump failed:", result.error, result.gaveUp ? "(giving up on jumps)" : "");
        this.seekError = result.error;
        // The note lives in the controls, so bring them back to show it.
        if (this.mode === "playing" && !this.panel && !this.controlsVisible) this.showControls("bar");
        if (result.gaveUp) {
          this.seekBroken = true;
          this.note("Jumping isn't working in this video (" + result.error + ").");
        } else this.note("That jump didn't work (" + result.error + "). Try again in a moment.");
      },
    );
    return runner;
  }

  // --- Buttons, episodes, Up Next ---------------------------------------------------

  private runButton(): void {
    const button = this.buttons[this.buttonIndex];
    if (!button) return;
    if (button.action === "tracks") this.openTracks();
    else if (button.action === "episodes") this.openEpisodes();
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

  private openEpisodes(): void {
    this.cancelSeek();
    this.cursor = this.index;
    this.hideControls();
    this.panel = "episodes";
    this.show(this.panelEl, true);
    this.renderPanel();
  }

  private closePanel(backToControls: boolean): void {
    this.panel = "";
    this.show(this.panelEl, false);
    this.show(this.tracksEl, false);
    toggle(this.subtitleEl, "is-above", false);
    if (backToControls) this.showControls("buttons");
  }

  private renderPanel(): void {
    const labels = (this.watching.queue || []).map((ep) => episodeCode(ep.seasonNo, ep.episodeNo) + "   " + ep.title);
    this.renderOptions(this.panelList, labels, this.index, this.cursor, true, PANEL_ROWS);
  }

  // A window of options around the cursor; the active one gets a dot (Roku's renderOptions).
  private renderOptions(list: HTMLElement, labels: string[], active: number, cursor: number, focused: boolean, rows: number): void {
    clear(list);
    if (labels.length === 0) {
      list.appendChild(h("div", { class: "panel-empty", text: "Default" }));
      return;
    }
    let first = cursor - Math.floor(rows / 2);
    first = Math.max(0, Math.min(first, labels.length - rows));
    for (let i = first; i < Math.min(labels.length, first + rows); i++) {
      const row = h("div", { class: "panel-row" + (focused && i === cursor ? " is-focused" : "") + (i === active ? " is-active" : "") }, [
        h("span", { class: "panel-dot" }),
        h("span", { class: "panel-label", text: labels[i] }),
      ]);
      list.appendChild(row);
    }
  }

  private onEpisodesKey(key: Key): void {
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
    this.clearSubtitle();
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
    this.osToken++;
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
    window.clearTimeout(this.subtitleTimer);
    window.clearInterval(this.subtitleTick);
    this.subtitleTick = 0;
    window.clearTimeout(this.autoTimer);
  }

  // --- Keys -------------------------------------------------------------------------

  onKey(key: Key): void {
    if (this.panel === "episodes") return this.onEpisodesKey(key);
    if (this.panel === "tracks") return this.onTracksKey(key);
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
    if (this.app.library) this.app.library.hold(true);
    if (this.booted) {
      // Back from the online subtitles setup: pick up the account, panel still open.
      this.online.configured = loadOsAccount() !== null;
      this.refreshTracks();
      return;
    }
    this.booted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    // Continue Watching reaches other devices every few minutes while a video plays.
    this.syncTimer = window.setInterval(() => {
      if (this.app.sync && this.started && !this.paused) this.app.sync.now();
    }, SYNC_EVERY_MS);
    this.startItem(this.startSecs);
  }

  onHide(): void {
    document.body.classList.remove("playing");
    if (this.app.library) this.app.library.hold(false);
  }

  destroy(): void {
    this.closing = true;
    this.clearTimers();
    window.clearInterval(this.syncTimer);
    this.stopStream();
    document.removeEventListener("visibilitychange", this.onVisibility);
    // Right after leaving a video, so another device can pick up where this one stopped.
    if (this.app.sync) this.app.sync.now();
  }

  // --- Audio & subtitles ------------------------------------------------------------

  private resetSubtitles(): void {
    this.osToken++;
    this.online = freshOnline(loadOsAccount() !== null);
    this.cues = null;
    this.source = { kind: "off" };
    this.hash = "";
    this.audioOpts = [];
    this.embeddedOpts = subtitleOptions([]);
    this.currentAudio = "";
    this.chosenAudio = "";
    this.tracksApplied = false;
    window.clearTimeout(this.autoTimer);
    this.stopTick();
    this.clearSubtitle();
  }

  // Once the stream plays: read its tracks, then apply the choices remembered from
  // earlier videos (Roku's onTracksChanged), or after a retry, put back what was on.
  private applyTracks(): void {
    const tracks = this.player.tracks();
    this.audioOpts = audioOptions(fromAvplay(tracks, "AUDIO"));
    this.embeddedOpts = subtitleOptions(fromAvplay(tracks, "TEXT"));
    const playing = this.player.currentTracks().filter((t) => t.kind === "AUDIO")[0];
    this.currentAudio = playing ? String(playing.index) : this.audioOpts.length > 0 ? this.audioOpts[0].id : "";
    if (this.tracksApplied) {
      if (this.chosenAudio && this.chosenAudio !== this.currentAudio) this.selectAudio(this.chosenAudio);
      if (this.source.kind === "embedded") this.showEmbedded(this.source.id);
      else if (this.source.kind === "online") this.showOnline();
      else this.subtitlesOff();
    } else {
      this.tracksApplied = true;
      const prefs = loadPrefs();
      const audio = audioPlan(prefs.audio || "", this.audioOpts);
      if (audio && audio !== this.currentAudio) this.selectAudio(audio);
      // A track this TV can't decode (DTS, usually) would play silently.
      const rescue = audioRescue(this.audioOpts, this.currentAudio);
      if (rescue) {
        log("audio rescue:", rescue.note);
        if (rescue.id) this.selectAudio(rescue.id);
        this.note(rescue.note, RESCUE_NOTE_MS);
      }
      const plan = subtitlePlan(prefs.subtitles || "", this.embeddedOpts, this.online.configured);
      if (plan.kind === "embedded") this.showEmbedded(plan.id);
      else {
        this.subtitlesOff();
        if (plan.kind === "online") this.autoTimer = window.setTimeout(() => this.startOnlineSearch(true), AUTO_SUBTITLES_AFTER_MS);
      }
    }
    log("tracks: audio", this.audioOpts.length, "text", this.embeddedOpts.length - 1, "subtitles", this.source.kind);
    this.refreshTracks();
  }

  private selectAudio(id: string): void {
    try {
      this.player.selectTrack("AUDIO", Number(id));
      this.currentAudio = id;
    } catch (err) {
      logError("audio switch failed:", err);
      this.note("Couldn't switch the audio.");
    }
  }

  private showEmbedded(id: string): void {
    this.stopTick();
    this.clearSubtitle();
    try {
      this.player.selectTrack("TEXT", Number(id));
      this.player.setSubtitlesHidden(false);
      this.source = { kind: "embedded", id };
    } catch (err) {
      logError("subtitle switch failed:", err);
      this.note("Couldn't switch the subtitles.");
    }
  }

  private subtitlesOff(): void {
    this.stopTick();
    this.clearSubtitle();
    this.player.setSubtitlesHidden(true);
    this.source = { kind: "off" };
  }

  private showOnline(): void {
    if (!this.cues) return;
    this.clearSubtitle();
    this.player.setSubtitlesHidden(true); // the file's own track would talk over it
    this.source = { kind: "online", fileId: this.online.loadedFileId };
    this.stopTick();
    this.subtitleTick = window.setInterval(() => this.drawOnlineCue(), SUBTITLE_TICK_MS);
  }

  private stopTick(): void {
    window.clearInterval(this.subtitleTick);
    this.subtitleTick = 0;
  }

  private clearSubtitle(): void {
    window.clearTimeout(this.subtitleTimer);
    setText(this.subtitleEl, "");
  }

  // A cue from the file's own track; AVPlay says how long it stays.
  private onEmbeddedCue(text: string, durationMs: number): void {
    if (this.source.kind !== "embedded") return;
    setText(this.subtitleEl, cleanCueText(text));
    window.clearTimeout(this.subtitleTimer);
    if (durationMs > 0) this.subtitleTimer = window.setTimeout(() => setText(this.subtitleEl, ""), durationMs);
  }

  // The player reports its position every so often; in between, count on from there.
  private drawOnlineCue(): void {
    if (!this.cues || !this.started) {
      setText(this.subtitleEl, "");
      return;
    }
    let ms = this.positionMs;
    if (!this.paused && this.timeAt > 0) ms += Math.min(Date.now() - this.timeAt, 1000);
    setText(this.subtitleEl, this.cues.textAt(ms, this.online.delayMs));
  }

  private startOnlineSearch(auto: boolean): void {
    const account = loadOsAccount();
    if (!account || this.failed || this.closing) return;
    const token = ++this.osToken;
    const item = this.item;
    const w = this.watching;
    const req: FindRequest =
      w.kind === "movie"
        ? { kind: "movie", title: item.title, tmdbId: item.tmdbId, season: 0, episode: 0, hash: this.hash }
        : { kind: "episode", title: w.seriesName || "", tmdbId: w.tmdbId || "", season: item.seasonNo, episode: item.episodeNo, hash: this.hash };
    this.online.state = "searching";
    this.online.message = "";
    this.refreshTracks();
    new OsClient(account).find(req).then((result) => {
      if (token !== this.osToken) return;
      if (!result.ok) {
        this.online.state = "error";
        this.online.message = result.error;
      } else if (result.candidates.length === 0) this.online.state = "none";
      else {
        this.online.state = "results";
        this.online.candidates = result.candidates;
        if (auto) this.downloadSubtitle(result.candidates[0].fileId);
      }
      log("subtitle search:", this.online.state, result.candidates.length, "found", this.hash ? "with hash" : "without hash");
      this.refreshTracks();
    });
  }

  private downloadSubtitle(fileId: string): void {
    const account = loadOsAccount();
    if (!account || !fileId) return;
    const token = ++this.osToken;
    this.online.state = "downloading";
    this.refreshTracks();
    new OsClient(account).download(fileId).then((result) => {
      if (token !== this.osToken) return;
      const cues = result.ok ? parseSubtitles(result.text) : [];
      if (!result.ok || cues.length === 0) {
        this.online.state = "error";
        this.online.message = result.ok ? "The subtitle file was empty or unreadable." : result.error;
        this.refreshTracks();
        return;
      }
      this.online.state = "results";
      this.online.remaining = result.remaining;
      this.online.loadedFileId = fileId;
      this.online.delayMs = 0;
      this.cues = new CueTrack(cues);
      // Later videos without English subtitles of their own fetch the best match.
      savePref("subtitles", "online");
      this.showOnline();
      log("online subtitles:", cues.length, "cues");
      this.refreshTracks();
    });
  }

  private openTracks(): void {
    this.cancelSeek();
    this.hideControls();
    this.panel = "tracks";
    this.show(this.tracksEl, true);
    toggle(this.subtitleEl, "is-above", true);
    this.subMenu = subtitleMenu(this.embeddedOpts, this.online);
    this.column = 1;
    this.audioCursor = Math.max(0, optionIndex(this.audioOpts, "id", this.currentAudio));
    this.subCursor = Math.max(0, activeSubtitle(this.subMenu, this.source));
    this.renderTracks();
  }

  private refreshTracks(): void {
    if (this.panel !== "tracks") return;
    this.subMenu = subtitleMenu(this.embeddedOpts, this.online);
    this.subCursor = Math.min(this.subCursor, this.subMenu.length - 1);
    this.renderTracks();
  }

  private renderTracks(): void {
    const audioActive = optionIndex(this.audioOpts, "id", this.currentAudio);
    this.renderOptions(this.audioList, this.audioOpts.map((o) => o.label), audioActive, this.audioCursor, this.column === 0, TRACK_ROWS);
    this.renderOptions(this.subsList, this.subMenu.map((o) => o.label), activeSubtitle(this.subMenu, this.source), this.subCursor, this.column === 1, TRACK_ROWS);
    const notes = [audioNowText(this.audioOpts, this.currentAudio), tracksNote(this.online, this.embeddedOpts.length - 1)];
    setText(this.tracksNoteEl, notes.filter((n) => n !== "").join(" "));
  }

  private chooseTrack(): void {
    if (this.column === 0) {
      const option = this.audioOpts[this.audioCursor];
      if (!option) return;
      this.chosenAudio = option.id;
      this.selectAudio(option.id);
      if (option.language) savePref("audio", option.language);
      this.renderTracks();
      return;
    }
    const option = this.subMenu[this.subCursor];
    if (!option) return;
    const id = option.id;
    if (id === "os:busy") return;
    if (id === "os:setup") return this.openSetup();
    if (id === "os:search") this.startOnlineSearch(false);
    else if (id === "os:earlier" || id === "os:later") {
      this.online.delayMs += id === "os:later" ? NUDGE_MS : -NUDGE_MS;
      if (this.source.kind !== "online") this.showOnline();
    } else if (id.indexOf("os:file:") === 0) {
      const fileId = id.slice(8);
      if (fileId === this.online.loadedFileId && this.cues) {
        this.showOnline();
        savePref("subtitles", "online");
      } else this.downloadSubtitle(fileId);
    } else if (id === "") {
      this.subtitlesOff();
      savePref("subtitles", "off");
    } else {
      this.showEmbedded(id);
      if (option.language) savePref("subtitles", option.language);
    }
    this.refreshTracks();
  }

  // No OpenSubtitles account yet: pause and open the setup, then come back here.
  private openSetup(): void {
    if (this.started && !this.paused) {
      this.player.pause();
      this.paused = true;
      this.saveProgress();
    }
    this.app.push(new SubtitleSetupScreen(this.app));
  }

  private onTracksKey(key: Key): void {
    if (key === "back") return this.closePanel(true);
    if (key === "ok") return this.chooseTrack();
    if (key === "left" && this.audioOpts.length > 0) this.column = 0;
    else if (key === "right") this.column = 1;
    else if (key === "up") {
      if (this.column === 0 && this.audioCursor > 0) this.audioCursor--;
      if (this.column === 1 && this.subCursor > 0) this.subCursor--;
    } else if (key === "down") {
      if (this.column === 0 && this.audioCursor < this.audioOpts.length - 1) this.audioCursor++;
      if (this.column === 1 && this.subCursor < this.subMenu.length - 1) this.subCursor++;
    } else return;
    this.renderTracks();
  }
}
