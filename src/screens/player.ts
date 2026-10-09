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
import { barFraction, providerServerTrouble, SERVER_TROUBLE_TEXT } from "../core/playback";
import { progressPut, progressRemove } from "../core/progress";
import { redact } from "../core/redact";
import { httpDetail, isRefusalCode } from "../core/refusals";
import { COMMIT_AFTER_MS, JumpResult, SeekPreview, SeekRunner, TICK_MS } from "../core/seek";
import { cleanCueText, CueTrack, parseSubtitles } from "../core/srt";
import { loadOsAccount, loadPrefs, savePref } from "../core/storage";
import { activeSubtitle, audioPlan, freshOnline, NUDGE_MS, OLD_SYNC_TEXT, OnlineStatus, SavedSubtitle, savedCandidate, showsSaved, SubtitleSource, subtitleMenu, subtitlePlan, subtitleSaveText, tracksNote } from "../core/subtitles";
import { audioNowText, audioOptions, audioRescue, fromAvplay, optionIndex, subtitleOptions, TrackOption } from "../core/tracks";
import { tasteEpisodeDone, tasteFinished, tasteWatched, tasteWeightFor } from "../core/taste";
import { codecLabel, describeCodecs, episodeCode, formatClock, streamUrl } from "../core/utils";
import { currentOf, dueForSave, entryFor, finishedChange, hasNext, resumeFrom, saveAction, Watching } from "../core/watch";
import { knownHash, rememberHash } from "../data/moviehash";
import { HELPER_NO_ANSWER, helperAddress, helperInfo, HelperInfo, helperLastError, helperStreamUrl, learnedMode, learnMode, needsHelper, rememberNeedsHelper, VideoMode } from "../data/transcoder";
import { helperOn } from "../core/personal";
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
const DELAY_SAVE_MS = 3000; // nudges reach other devices once they stop for this long
const SUBTITLE_TICK_MS = 100;
const RESCUE_NOTE_MS = 9000;
const SYNC_EVERY_MS = 5 * 60000;
const CHECK_STREAM_MS = 10000;
const HELPER_NEVER_STARTED_MS = 45000; // the provider, then FFmpeg, then the TV
const REOPEN_AFTER_MS = 300;
const SERVER_RETRY_MS = 5000; // the provider's server failing is often over in a moment
const RELEASE_AFTER_MS = 3 * 60000; // paused this long, a direct stream lets go of the provider

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
  // Through the helper on a computer at home (data/transcoder.ts): its stream starts
  // where asked, so the TV's time is added to offsetMs, and a jump reopens the stream.
  private route: "direct" | "helper" = "direct";
  private helper: HelperInfo | null = null;
  private helperVideo: VideoMode = "copy";
  private convertTried = false;
  private helperTried = false; // this title has already moved to the helper
  private helperFromStart = false; // it went to the helper without trying on its own
  private helperPlayed = false; // its stream has played, so a failure gets two reopens
  private offsetMs = 0;
  private jumpTo = -1; // reopen the helper's stream here
  // The provider's server failed (a 5xx): asked again once, then only after a minute of
  // playing since.
  private serverRetried = false;
  private retryFrom = 0;
  private serverTrouble = false;
  private directPlayed = false; // played straight from the provider at least once
  private tasteEpisode = -1; // the episode already counted as finished
  private checkLine = ""; // what the stream check before the error screen found
  // Paused for long, a direct stream lets go of the provider's connection
  // (releaseConnection); play opens it again at `releasedAt`.
  private released = false;
  private releasedAt = 0;
  private releaseTimer = 0;
  private restEl: HTMLElement;

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
  private subsGen = 0; // which video the saved subtitles below belong to
  private saved: SavedSubtitle | null = null; // saved for this title on the sync service
  private savedLookup: Promise<SavedSubtitle | null> = Promise.resolve(null);
  private subsProblem = ""; // why subtitles can't be saved for next time, when they can't
  private delaySave: { title: string; fileId: string; delayMs: number } | null = null;
  private delaySaveTimer = 0;
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
    this.restEl = h("div", { class: "player-rest" });
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
    this.el = h("div", { class: "screen player" }, [this.coverEl, this.restEl, this.subtitleEl, this.controlsEl, this.spinnerEl, this.upNextEl, this.errorEl, this.panelEl, this.tracksEl]);
  }

  private get item(): Item {
    return currentOf(this.watching, this.index);
  }

  // --- Starting a title -------------------------------------------------------------

  private startItem(startSecs: number): void {
    // The helper may still hold the provider's one connection for a moment.
    const afterHelper = this.route === "helper";
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
    this.route = "direct";
    this.helper = null;
    this.helperVideo = "copy";
    this.convertTried = false;
    this.helperTried = false;
    this.helperFromStart = false;
    this.helperPlayed = false;
    this.offsetMs = 0;
    this.jumpTo = -1;
    this.serverRetried = false;
    this.serverTrouble = false;
    this.directPlayed = false;
    this.checkLine = "";
    this.resetRelease();
    setText(this.noteEl, "");
    this.resetSubtitles();

    const item = this.item;
    const w = this.watching;
    setText(this.titleEl, w.kind === "movie" ? item.title : (w.seriesName || "") + "   ·   " + episodeCode(item.seasonNo, item.episodeNo) + "  " + item.title);
    this.buildButtons();

    // Files this TV can't play go through the helper on your computer when there is
    // one; without it they would only fail after a wait, so explain up front.
    this.check = playCheck(factsOf(item));
    if (helperOn() && (this.check.verdict === "blocked" || needsHelper(factsOf(item).key))) {
      this.route = "helper";
      this.helperTried = true;
      this.helperFromStart = true;
    } else if (this.check.verdict === "blocked" && !this.tryAnyway) {
      this.showUnplayable(this.check);
      return;
    }
    if (afterHelper && this.route === "direct") {
      this.show(this.spinnerEl, true);
      this.retryTimer = window.setTimeout(() => this.hashThenLoad(), RETRY_AFTER_MS);
      return;
    }
    this.hashThenLoad();
  }

  // Online subtitles "timed for this file" need the file's moviehash. The helper reads it
  // in the reads it makes anyway (loadHelperStream); a file played straight from the
  // provider gets none, since reading its start and end took the provider's one
  // connection (the Roku app's 0.5.15), and the search goes by TMDB id or name. One
  // remembered from an earlier play through the helper still counts.
  private hashThenLoad(): void {
    this.hash = knownHash(factsOf(this.item).key);
    this.loadStream();
  }

  private loadStream(): void {
    const api = this.app.api;
    if (!api) return this.close();
    if (this.route === "helper") return this.loadHelperStream();
    const token = ++this.streamToken;
    this.offsetMs = 0;
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

  // The helper's stream: first what the file holds (once per title), then the stream
  // from where to start. The picture is repackaged when the TV may play it (or did
  // before), and converted otherwise.
  private loadHelperStream(): void {
    const token = ++this.streamToken;
    this.seeker = null;
    this.show(this.spinnerEl, true);
    const item = this.item;
    if (this.helper) return this.openHelper(token);
    log("helper: asking about", factsOf(item).key);
    const from = this.jumpTo >= 0 ? this.jumpTo : resumeFrom(this.startSecs);
    // The fingerprint for online subtitles, from the reads the helper makes anyway.
    const wantHash = this.online.configured && loadPrefs().subtitles !== "off" && !this.hash;
    helperInfo(item, from, wantHash).then(
      (info) => {
        if (token !== this.streamToken || this.closing) return;
        this.helper = info;
        if (info.hash) {
          this.hash = info.hash;
          rememberHash(factsOf(item).key, info.hash);
        }
        if (info.duration > 0) this.durationMs = info.duration * 1000;
        const learned = learnedMode(info.videoCodec);
        this.helperVideo = info.videoPlan === "convert" ? "convert" : info.videoPlan === "copy" ? "copy" : learned || "copy";
        if (this.helperVideo === "convert") this.convertTried = true;
        log("helper:", info.videoCodec || "no picture", "->", this.helperVideo, "sound", info.audio.map((a) => a.codec + ":" + a.plan).join(","), "duration", info.duration);
        this.openHelper(token);
      },
      (err: Error) => {
        if (token !== this.streamToken) return;
        if (providerServerTrouble(err.message) && !this.serverRetried) {
          log("helper: the provider's server failed; asking again in a moment");
          this.retryLater();
          return;
        }
        this.handleError("HELPER: " + err.message);
      },
    );
  }

  private openHelper(token: number): void {
    const item = this.item;
    const from = this.jumpTo >= 0 ? this.jumpTo : resumeFrom(this.startSecs);
    this.jumpTo = -1;
    this.offsetMs = from * 1000;
    this.positionMs = from * 1000;
    const helper = this.helper;
    const uhd = !!helper && helper.width > 1920 && this.helperVideo === "copy";
    log("play via helper", factsOf(item).key, "from", from, this.helperVideo, "attempt", this.attempt + 1);
    this.player
      .open(helperStreamUrl(item, from, this.helperVideo), this.events(token), { uhd })
      .then(() => {
        if (token !== this.streamToken) return;
        this.stallTimer = window.setTimeout(() => {
          if (token === this.streamToken && !this.started) this.handleError("NO_PROGRESS (it opened but never started)");
        }, HELPER_NEVER_STARTED_MS);
        this.resume();
      })
      .catch((err: Error) => {
        if (token === this.streamToken) this.handleError(errorLabel(err.name, err.message));
      });
  }

  // Moves this title to the helper, from where it got to.
  private switchToHelper(reason: string): void {
    if (this.closing || this.route === "helper") return;
    log("helper: switching,", reason);
    this.route = "helper";
    this.helperTried = true;
    if (this.started) this.startSecs = Math.floor(this.positionMs / 1000);
    this.started = false;
    this.firstTimeMs = -1;
    this.attempt = 0;
    // The helper's stream numbers its tracks afresh, and has no subtitle tracks.
    this.tracksApplied = false;
    this.chosenAudio = "";
    window.clearTimeout(this.stallTimer);
    this.stopStream();
    this.clearSubtitle();
    this.show(this.errorEl, false);
    this.show(this.spinnerEl, true);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.loadStream(), RETRY_AFTER_MS);
  }

  // A jump through the helper: its stream starts again at the new time.
  private reopenAt(targetSecs: number): void {
    this.jumpTo = Math.max(0, Math.floor(targetSecs));
    this.startSecs = this.jumpTo;
    this.started = false;
    this.firstTimeMs = -1;
    window.clearTimeout(this.stallTimer);
    this.stopStream();
    this.clearSubtitle();
    this.show(this.spinnerEl, true);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.loadStream(), REOPEN_AFTER_MS);
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
    this.positionMs = this.offsetMs + ms;
    this.timeAt = Date.now();
    // A minute of playing since asking again after a server error: another may ask again.
    if (this.serverRetried && this.positionMs / 1000 - this.retryFrom > 60) this.serverRetried = false;
    if (this.firstTimeMs < 0 && ms > 0) {
      this.firstTimeMs = ms;
      this.show(this.coverEl, false);
    }
    // Only real progress counts as playing, not just opening (a Roku lesson).
    if (!this.started && this.firstTimeMs >= 0 && ms - this.firstTimeMs >= 1000) this.onStarted();
    if (this.started && dueForSave(Math.floor(this.positionMs / 1000), this.lastSavedSecs)) this.saveProgress();
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
    if (this.route === "helper") {
      // The helper's stream has no fixed length, so its duration comes from the file.
      if (this.helper && this.helper.videoPlan === "try") learnMode(this.helper.videoCodec, this.helperVideo);
      // It plays this way, so a later failure (after a jump, say) isn't the picture's fault.
      this.convertTried = true;
      this.helperPlayed = true;
    } else {
      const total = this.player.durationMs();
      if (total > 0) this.durationMs = total;
      learnResult(factsOf(this.item), true, "");
      this.directPlayed = true;
    }
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
    if ((!this.started && !this.released) || this.failed) return;
    const pos = Math.floor(this.positionMs / 1000);
    const dur = Math.floor(this.durationMs / 1000);
    const action = saveAction(pos, dur);
    if (action === "skip") return;
    this.lastSavedSecs = pos;
    this.noteTaste(pos, dur);
    if (action === "finished") this.applyFinished();
    else progressPut(entryFor(this.watching, this.index, pos, dur));
  }

  // What you're watching, for the rows picked for you (core/taste.ts): a movie by how far
  // you are, a series once you're 3 minutes into an episode.
  private noteTaste(pos: number, dur: number): void {
    const w = this.watching;
    if (w.kind === "movie") tasteWatched("m:" + this.item.itemId, this.item.title, tasteWeightFor(pos, dur));
    else if (pos >= 180) tasteWatched("s:" + w.seriesId, w.seriesName || "", 1);
  }

  // Movies drop out of Continue Watching; series move on to the next episode.
  private applyFinished(): void {
    // Watched to the end: a movie counts most, a series a little more each episode.
    const w = this.watching;
    if (w.kind === "movie") tasteFinished("m:" + this.item.itemId, this.item.title);
    else if (this.tasteEpisode !== this.index) {
      this.tasteEpisode = this.index;
      tasteEpisodeDone("s:" + w.seriesId, w.seriesName || "");
    }
    const change = finishedChange(this.watching, this.index);
    if (change.put) progressPut(change.put);
    if (change.remove) progressRemove(change.remove);
  }

  private onEnded(): void {
    // An error can be followed by "ended"; only a stream that really played counts.
    if (this.failed || !this.started) return;
    // The helper's stream also ends when the provider's connection drops.
    if (this.route === "helper" && this.durationMs > 0 && this.positionMs < this.durationMs - 60000) {
      this.handleError("HELPER: The stream from your computer stopped before the end.");
      return;
    }
    this.applyFinished();
    this.stopStream(); // frees the provider's one connection for the next episode
    if (hasNext(this.watching, this.index)) this.showUpNext();
    else this.close();
  }

  // --- Errors -----------------------------------------------------------------------

  private handleError(label: string): void {
    if (this.failed || this.closing) return;
    this.errors.push(label);
    logError("playback error:", label, "(" + this.route + ")");
    window.clearTimeout(this.stallTimer);
    this.stopStream();
    this.clearSubtitle();
    // The TV refused the repackaged picture: convert it instead, and remember that.
    const helper = this.helper;
    if (this.route === "helper" && !this.started && helper && this.helperVideo === "copy" && helper.videoPlan === "try" && !this.convertTried) {
      this.convertTried = true;
      this.helperVideo = "convert";
      learnMode(helper.videoCodec, "convert");
      log("helper: the TV refused the picture as it is; converting it");
      this.show(this.spinnerEl, true);
      this.retryTimer = window.setTimeout(() => this.loadStream(), RETRY_AFTER_MS);
      return;
    }
    // Once the helper's stream has played, a drop (the provider's connection, say) is
    // reopened from where it got to twice; anything else gets one more try.
    if (this.attempt < (this.route === "helper" && this.helperPlayed ? 2 : 1)) {
      this.attempt++;
      if (this.started) this.startSecs = Math.floor(this.positionMs / 1000);
      this.started = false;
      this.firstTimeMs = -1;
      this.show(this.spinnerEl, true);
      this.retryTimer = window.setTimeout(() => this.loadStream(), RETRY_AFTER_MS);
      return;
    }
    // Out of tries. First a word from whoever knows more than the TV's player.
    if (this.route === "direct") return this.afterDirectFailed();
    const last = this.errors[this.errors.length - 1] || "";
    if (last.indexOf("HELPER: ") === 0) return this.showError("");
    // The TV's player only says the stream failed; the helper knows why.
    const token = this.streamToken;
    this.show(this.spinnerEl, true);
    helperLastError().then((said) => {
      if (token !== this.streamToken || this.closing || this.failed) return;
      if (providerServerTrouble(said) && !this.serverRetried) {
        log("helper: the provider's server failed; asking again in a moment");
        this.retryLater();
        return;
      }
      this.showError(said);
    });
  }

  // The direct stream failed after its retry. One small request for the stream's start,
  // a moment later so the provider has let go of the player's connection, says whether
  // the provider's server is failing (asked again once, 5 s later), turned the stream
  // away (the helper would fare no better), or sent it (so this TV couldn't play it, and
  // the helper on your computer may).
  private afterDirectFailed(): void {
    const token = this.streamToken;
    this.show(this.spinnerEl, true);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.checkStream().then((check) => {
        if (token !== this.streamToken || this.closing || this.failed) return;
        this.checkLine = check.line;
        this.serverTrouble = check.code >= 500;
        // The provider sent the file, so this TV couldn't play it: remembered for next
        // time (a format error only). A server failing or refusing teaches nothing.
        if (!this.directPlayed && (check.code === 200 || check.code === 206)) learnResult(factsOf(this.item), false, this.errors[this.errors.length - 1] || "");
        if (this.serverTrouble && !this.serverRetried) {
          log("the provider's server failed; asking again in a moment");
          this.retryLater();
          return;
        }
        if (helperOn() && !this.helperTried && !isRefusalCode(check.code)) {
          this.switchToHelper("it didn't play on its own");
          return;
        }
        this.showError("");
      });
    }, RETRY_AFTER_MS);
  }

  // The provider's server failed (a 5xx), which is often over in a moment: the stream
  // is asked for again once, 5 s later, from where it was.
  private retryLater(): void {
    this.serverRetried = true;
    if (this.started) this.startSecs = Math.floor(this.positionMs / 1000);
    this.retryFrom = this.startSecs;
    this.started = false;
    this.firstTimeMs = -1;
    window.clearTimeout(this.stallTimer);
    this.stopStream();
    this.show(this.errorEl, false);
    this.show(this.spinnerEl, true);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.loadStream(), SERVER_RETRY_MS);
  }

  // `helperSaid`: why the helper's last stream failed (/v1/last-error), when asked.
  private showError(helperSaid: string): void {
    this.failed = true;
    this.mode = "error";
    if (providerServerTrouble(helperSaid)) this.serverTrouble = true;
    this.show(this.spinnerEl, false);
    this.show(this.coverEl, true);
    this.hideControls();
    this.closePanel(false);
    setText(this.errorTitle, "This video didn't play");
    setText(this.errorDetail, this.diagnosis(helperSaid));
    setText(this.errorHint, "OK to try again   ·   Back to return");
    this.show(this.errorEl, true);
  }

  // Asks the server for the start of the stream, to say whether it refused it (a trial
  // that doesn't include it, one device at a time, an ended trial) or its server failed,
  // rather than the TV failing to play it. The player has let go of the connection.
  private checkStream(): Promise<{ code: number; line: string }> {
    const api = this.app.api;
    if (!api) return Promise.resolve({ code: 0, line: "" });
    const item = this.item;
    const url = streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, (item.ext || "mp4").toLowerCase());
    return send({ url, headers: { Range: "bytes=0-1023" }, timeoutMs: CHECK_STREAM_MS, maxBytes: 65536 }).promise.then((res) => {
      let line = "";
      if (res.timedOut) line = "Asked the server for the stream again: no answer in 10 seconds.";
      else if (res.code === 0) line = "Asked the server for the stream again: the connection failed.";
      else if (res.code >= 400) {
        line = "Asked the server for the stream again: " + redact(httpDetail(res.code, res.headers(), res.text)) + ".";
        if (isRefusalCode(res.code)) line += " The provider refused it. The trial may not include it, may allow one device at a time, or may have ended.";
      }
      log("stream check:", res.code, line);
      return { code: res.timedOut ? 0 : res.code, line };
    });
  }

  // What went wrong, what the file is, and whether this TV plays files like it.
  // `helperSaid`: why the helper's last stream failed (/v1/last-error).
  private diagnosis(helperSaid = ""): string {
    const item = this.item;
    const last = this.errors[this.errors.length - 1] || "";
    const lines = [last.indexOf("HELPER: ") === 0 ? last.slice(8) : "Samsung's player says: " + last];
    // Plain words first when the provider's server is the trouble.
    if (this.serverTrouble || providerServerTrouble(last)) lines.unshift(SERVER_TROUBLE_TEXT);
    if (helperSaid) lines.push("Your computer says: " + helperSaid);
    const tries = this.errors.length === 2 ? "twice" : this.errors.length + " times";
    if (this.helperFromStart) lines.push("Tried " + tries + " through the helper on your computer.");
    else if (this.helperTried) lines.push("Tried " + tries + ", the last through the helper on your computer.");
    else if (this.errors.length > 1) lines.push("Tried " + tries + ", a moment apart.");
    lines.push(fileLine(item));
    if (this.route === "helper") lines.push(this.helperLine());
    const check = this.check;
    if (check && check.verdict === "blocked") lines.push(check.reason);
    else if (item.videoCodec && this.route === "direct") lines.push("This TV normally plays files like this, so the stream itself is the likely problem.");
    const api = this.app.api;
    if (this.route === "helper" && helperAddress()) {
      lines.push("Helper: " + helperAddress());
      if (last === "HELPER: " + HELPER_NO_ANSWER) lines.push("Often the computer is asleep or off, the helper's window was closed, or the computer's address has changed (a fixed address in the router keeps it).");
    } else if (api) {
      // Server, username and password are hidden, so a photo of the screen is safe.
      const ext = (item.ext || "mp4").toLowerCase();
      lines.push("Stream: " + redact(streamUrl(api.creds, item.kind === "episode" ? "series" : "movie", item.itemId, ext)));
    }
    if (this.checkLine && this.route === "direct") lines.push(this.checkLine);
    return lines.join("\n");
  }

  // What the helper was doing, for the error screen.
  private helperLine(): string {
    const helper = this.helper;
    if (!helper) return "Through the helper on your computer, which didn't describe the file.";
    const picture = this.helperVideo === "convert" ? "picture converted to H.264" : "picture kept as it is";
    const changed = helper.audio.filter((a) => a.plan !== "copy").map((a) => codecLabel(a.codec) + " sound converted");
    return "Through the helper on your computer: " + [picture].concat(changed).join(", ") + ".";
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
    if (this.released) return this.resumeReleased();
    window.clearTimeout(this.releaseTimer);
    this.player.play();
    this.paused = false;
    if (this.controlsVisible) {
      this.renderPlayButton();
      this.restartHideTimer();
    }
  }

  private togglePause(): void {
    if (this.released) return this.resumeReleased();
    if (!this.started) return;
    if (this.paused) {
      this.resume();
      return;
    }
    this.player.pause();
    this.paused = true;
    this.saveProgress();
    // Paused for long, a direct stream lets go of the provider (releaseConnection).
    window.clearTimeout(this.releaseTimer);
    if (this.route === "direct") this.releaseTimer = window.setTimeout(() => this.releaseConnection(), RELEASE_AFTER_MS);
    this.showControls(this.controlsVisible ? this.row : "bar");
  }

  // --- Long pauses (the Roku app's 0.5.15) --------------------------------------------
  //
  // A paused stream holds the provider's one connection, idle, and the provider may drop
  // it; resuming then stalls or is turned away. So after 3 minutes paused a direct stream
  // lets go of it, and play opens it again at the same spot, with the same sound and
  // subtitles. A helper stream is left alone: its connection is the helper's, which goes
  // on converting while you're paused.

  private releaseConnection(): void {
    if (this.closing || this.released || this.failed || this.route !== "direct" || !this.started || !this.paused) return;
    this.saveProgress();
    this.releasedAt = Math.floor(this.positionMs / 1000);
    this.chosenAudio = this.currentAudio; // put back when the stream opens again
    this.released = true;
    this.started = false;
    this.firstTimeMs = -1;
    window.clearTimeout(this.stallTimer);
    this.stopTick();
    this.clearSubtitle();
    this.stopStream();
    log("paused for long: let go of the provider's connection at", this.releasedAt);
    // The title's picture stands in for the paused frame.
    const picture = (this.watching.kind === "movie" ? this.item.backdrop : this.watching.backdrop) || "";
    this.restEl.style.backgroundImage = picture ? 'url("' + picture.replace(/"/g, "%22") + '")' : "";
    this.show(this.coverEl, true);
    this.show(this.restEl, picture !== "");
  }

  // Play after a long pause: the stream opens again where it was let go (or where a jump
  // since moved it).
  private resumeReleased(): void {
    const at = this.releasedAt;
    this.resetRelease();
    this.paused = false;
    this.startSecs = at;
    this.show(this.spinnerEl, true);
    if (this.controlsVisible) this.renderPlayButton();
    this.loadStream();
  }

  private resetRelease(): void {
    window.clearTimeout(this.releaseTimer);
    this.released = false;
    this.releasedAt = 0;
    this.show(this.restEl, false);
  }

  // --- Jump preview -----------------------------------------------------------------

  private beginHold(key: Key, direction: number): void {
    if (!this.started && !this.released) return;
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
    // Let go after a long pause: play opens the stream at the new spot.
    if (this.released) {
      this.releasedAt = Math.floor(targetSecs);
      return;
    }
    if (this.route === "helper") this.reopenAt(targetSecs);
    else if (this.seeker) this.seeker.jump(targetSecs * 1000);
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
    window.clearTimeout(this.releaseTimer);
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
    this.saveDelayNow();
    this.clearTimers();
    window.clearInterval(this.syncTimer);
    this.stopStream();
    document.removeEventListener("visibilitychange", this.onVisibility);
    // Right after leaving a video, so another device can pick up where this one stopped.
    if (this.app.sync) this.app.sync.now();
  }

  // --- Audio & subtitles ------------------------------------------------------------

  private resetSubtitles(): void {
    this.saveDelayNow();
    this.osToken++;
    this.online = freshOnline(loadOsAccount() !== null);
    this.lookUpSaved();
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
      if (rescue && !rescue.id && this.route === "direct" && helperOn()) {
        // No sound this TV can play: the helper converts it, now and next time.
        const current = this.audioOpts.filter((o) => o.id === this.currentAudio)[0];
        const format = current && current.format ? codecLabel(current.format) : "this";
        rememberNeedsHelper(factsOf(this.item).key);
        this.note("This file's sound is " + format + ", which this TV can't play, so your computer is converting it.", RESCUE_NOTE_MS);
        window.setTimeout(() => this.switchToHelper("its sound can't be played"), 0);
      } else if (rescue) {
        log("audio rescue:", rescue.note);
        if (rescue.id) this.selectAudio(rescue.id);
        this.note(rescue.note, RESCUE_NOTE_MS);
      }
      const pref = prefs.subtitles || "";
      const plan = subtitlePlan(pref, this.embeddedOpts, this.online.configured);
      if (plan.kind === "embedded") this.showEmbedded(plan.id);
      else {
        this.subtitlesOff();
        const search = plan.kind === "online";
        if (search || showsSaved(pref, plan)) this.autoTimer = window.setTimeout(() => this.autoSubtitles(search), AUTO_SUBTITLES_AFTER_MS);
      }
    }
    log("tracks: audio", this.audioOpts.length, "text", this.embeddedOpts.length - 1, "subtitles", this.source.kind);
    this.refreshTracks();
  }

  private selectAudio(id: string): void {
    if (this.released) {
      this.currentAudio = id;
      return;
    }
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
    if (this.released) {
      this.source = { kind: "embedded", id };
      return;
    }
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
      this.shareSubtitle(fileId, result.text);
    });
  }

  // --- Subtitles saved for every device (the sync service) ----------------------------

  private lookUpSaved(): void {
    const gen = ++this.subsGen;
    this.saved = null;
    const sync = this.app.sync;
    this.subsProblem = "";
    this.savedLookup = sync
      ? sync.savedSubtitle(factsOf(this.item).key).then((found) => {
          // A sync service from before saved subtitles: said in the panel, so the next
          // download isn't a surprise.
          if (found.code === 404 && gen === this.subsGen) {
            this.subsProblem = OLD_SYNC_TEXT;
            this.refreshTracks();
          }
          return found.saved;
        })
      : Promise.resolve(null);
    this.savedLookup.then((saved) => {
      if (gen !== this.subsGen || !saved) return;
      this.saved = saved;
      this.online.savedFileId = saved.fileId;
      this.online.candidates = [savedCandidate(saved)].concat(this.online.candidates);
      log("subtitles saved for this title:", saved.name || saved.fileId);
      this.refreshTracks();
    });
  }

  // Where this device would show subtitles by itself: the ones saved for this title, or
  // with `search`, the best match online.
  private autoSubtitles(search: boolean): void {
    const gen = this.subsGen;
    this.savedLookup.then((saved) => {
      if (gen !== this.subsGen || this.closing || this.failed || this.source.kind !== "off") return;
      if (saved) this.useSaved(saved);
      else if (search) this.startOnlineSearch(true);
    });
  }

  private useSaved(saved: SavedSubtitle): void {
    const cues = parseSubtitles(saved.text);
    if (cues.length === 0) return;
    this.osToken++; // a search or download still out is overtaken
    if (this.online.state === "searching" || this.online.state === "downloading") this.online.state = this.online.candidates.some((c) => !c.saved) ? "results" : "idle";
    this.online.loadedFileId = saved.fileId;
    this.online.delayMs = saved.delayMs;
    this.cues = new CueTrack(cues);
    this.showOnline();
    log("saved subtitles:", cues.length, "cues");
    this.refreshTracks();
  }

  // A download, saved for this title so other devices show it without one.
  private shareSubtitle(fileId: string, text: string): void {
    const sync = this.app.sync;
    if (!sync) return;
    const gen = this.subsGen;
    const found = this.online.candidates.filter((c) => c.fileId === fileId && !c.saved)[0];
    const subtitle: SavedSubtitle = { fileId, name: found ? found.release : "", delayMs: 0, text };
    sync.saveSubtitle(factsOf(this.item).key, subtitle).then((result) => {
      if (gen !== this.subsGen) return;
      if (!result.ok) {
        // Said straight away, and kept in the panel.
        this.subsProblem = subtitleSaveText(result.code, result.error);
        this.note(this.subsProblem, RESCUE_NOTE_MS);
        this.refreshTracks();
        return;
      }
      this.saved = subtitle;
      this.online.savedFileId = fileId;
      // What was saved before is replaced.
      this.online.candidates = this.online.candidates.filter((c) => !c.saved);
      this.refreshTracks();
    });
  }

  // Nudges of saved subtitles reach the other devices once they stop.
  private saveDelaySoon(): void {
    const fileId = this.online.loadedFileId;
    if (!this.app.sync || !fileId || fileId !== this.online.savedFileId) return;
    this.delaySave = { title: factsOf(this.item).key, fileId, delayMs: this.online.delayMs };
    if (this.saved && this.saved.fileId === fileId) this.saved.delayMs = this.online.delayMs;
    window.clearTimeout(this.delaySaveTimer);
    this.delaySaveTimer = window.setTimeout(() => this.saveDelayNow(), DELAY_SAVE_MS);
  }

  private saveDelayNow(): void {
    window.clearTimeout(this.delaySaveTimer);
    const pending = this.delaySave;
    this.delaySave = null;
    if (pending && this.app.sync) void this.app.sync.saveSubtitleDelay(pending.title, pending.fileId, pending.delayMs);
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
    const notes = [audioNowText(this.audioOpts, this.currentAudio), tracksNote(this.online, this.embeddedOpts.length - 1), this.subsProblem];
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
      this.saveDelaySoon();
    } else if (id.indexOf("os:file:") === 0) {
      const fileId = id.slice(8);
      if (fileId === this.online.loadedFileId && this.cues) {
        this.showOnline();
        savePref("subtitles", "online");
      } else if (this.saved && fileId === this.saved.fileId) {
        this.useSaved(this.saved);
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
