// A movie or a series (plan 7.3; the Roku app's DetailsScreen): backdrop, title, meta
// line, plot, cast and director, and a butter note when this TV can't play it.
// Movies get Resume / Play from start (or just Play). Series get Resume S1:E4 (or Play
// S1:E1), a row of season pills and the episode list; moving down scrolls the page up.
//
// The full player arrives in M3. Until then Play opens the setup checks' test player,
// and what happens teaches the playability check (core/compat.ts).

import type { App, Screen } from "../app";
import { FileFacts, learnResult, playCheck } from "../core/compat";
import { applyInfo, Item, metaLine } from "../core/items";
import { log } from "../core/log";
import { progressFind, progressFraction, ProgressEntry } from "../core/progress";
import { episodeCode, formatClock, formatRuntime, sizedImage, streamUrl, toInt } from "../core/utils";
import { episodeItem, POSTER_SIZE, Season } from "../core/xtream";
import type { Key } from "../platform/keys";
import { PlayTest } from "../probe/playtest";
import type { PlayResult } from "../probe/report";
import type { Sample } from "../probe/samples";
import { Backdrop } from "../ui/backdrop";
import { append, clear, h, setText, toggle } from "../ui/dom";
import { setKeyTarget } from "../ui/focus";

type Zone = "buttons" | "seasons" | "episodes";
type ButtonAction = "play" | "restart" | "resume" | "playFirst" | "resumeEpisode" | "episodes";

const EPISODE_H = 171; // row height plus spacing
const EPISODES_SHOWN = 5;
const SCROLL_Y = 588; // how far the page moves up to show the episodes

function factsOf(item: Item): FileFacts {
  return {
    key: (item.kind === "episode" ? "e:" : "m:") + item.itemId,
    ext: item.ext,
    videoCodec: item.videoCodec,
    videoProfile: item.videoProfile,
    audioCodec: item.audioCodec,
  };
}

export class DetailsScreen implements Screen {
  readonly el: HTMLElement;
  private backdrop = new Backdrop();
  private body: HTMLElement;
  private dim: HTMLElement;
  private titleEl: HTMLElement;
  private metaEl: HTMLElement;
  private plotEl: HTMLElement;
  private creditsEl: HTMLElement;
  private buttonsEl: HTMLElement;
  private compatEl: HTMLElement;
  private statusEl: HTMLElement;
  private panel: HTMLElement;
  private seasonStrip: HTMLElement;
  private episodeTrack: HTMLElement;

  private zone: Zone = "buttons";
  private buttons: { label: string; action: ButtonAction }[] = [];
  private buttonEls: HTMLElement[] = [];
  private buttonIndex = 0;

  private seasons: Season[] = [];
  private seasonEls: HTMLElement[] = [];
  private seasonIndex = 0;
  private episodes: Item[] = []; // the shown season
  private episodeEls: { [index: number]: HTMLElement } = {};
  private episodeIndex = 0;
  private episodeTop = 0; // first episode in view
  private entry: ProgressEntry | null = null;
  private alive = true;

  constructor(
    private app: App,
    private item: Item,
  ) {
    this.titleEl = h("div", { class: "details-title" });
    this.metaEl = h("div", { class: "details-meta" });
    this.plotEl = h("div", { class: "details-plot" });
    this.creditsEl = h("div", { class: "details-credits" });
    this.buttonsEl = h("div", { class: "details-buttons" });
    this.compatEl = h("div", { class: "details-compat" });
    this.statusEl = h("div", { class: "details-status" });
    this.seasonStrip = h("div", { class: "season-strip" });
    this.episodeTrack = h("div", { class: "episodes-track" });
    this.panel = h("div", { class: "episodes-panel is-hidden" }, [
      h("div", { class: "season-viewport" }, [this.seasonStrip]),
      h("div", { class: "episodes-viewport" }, [this.episodeTrack]),
    ]);
    this.dim = h("div", { class: "details-dim" });
    this.body = h("div", { class: "details-body" }, [
      h("div", { class: "details-info" }, [this.titleEl, this.metaEl, this.plotEl, this.creditsEl]),
      this.buttonsEl,
      this.compatEl,
      this.statusEl,
      this.panel,
    ]);
    this.el = h("div", { class: "screen details" }, [
      this.backdrop.el,
      h("div", { class: "top-shade" }),
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      this.dim,
      this.body,
    ]);

    this.showInfo();
    if (item.kind === "series") this.loadSeries();
    else this.loadMovie();
  }

  // --- Info -----------------------------------------------------------------------

  private showInfo(): void {
    const item = this.item;
    setText(this.titleEl, item.title);
    setText(this.metaEl, metaLine(item));
    setText(this.plotEl, item.description);
    const credits: string[] = [];
    if (item.starring) credits.push("Starring " + item.starring);
    if (item.directedBy) credits.push("Directed by " + item.directedBy);
    setText(this.creditsEl, credits.join("   ·   "));
    if (item.backdrop) this.backdrop.show(item.backdrop, 1);
    else if (item.poster) this.backdrop.show(sizedImage(item.poster, POSTER_SIZE), 0.35);
  }

  // --- Movies ---------------------------------------------------------------------

  private loadMovie(): void {
    this.movieButtons();
    this.movieCompat();
    const api = this.app.api;
    if (!api || this.item.hasInfo) return;
    api
      .vodInfo(this.item.itemId)
      .then((info) => {
        if (!this.alive) return;
        applyInfo(this.item, info);
        if (!this.item.poster && info.poster) this.item.poster = sizedImage(info.poster, POSTER_SIZE);
        this.showInfo();
        this.movieCompat();
      })
      .catch((err: Error) => log("vod info failed:", err.message));
  }

  private movieCompat(): void {
    const check = playCheck(factsOf(this.item));
    setText(this.compatEl, check.verdict === "blocked" ? "Won't play on this TV. " + check.reason : "");
  }

  private movieButtons(): void {
    this.entry = progressFind("m:" + this.item.itemId);
    if (this.entry && toInt(this.entry.pos) > 0) {
      this.setButtons([
        { label: "Resume from " + formatClock(toInt(this.entry.pos)), action: "resume" },
        { label: "Play from start", action: "restart" },
      ]);
    } else this.setButtons([{ label: "Play", action: "play" }]);
  }

  // --- Series ---------------------------------------------------------------------

  private loadSeries(): void {
    const api = this.app.api;
    if (!api) return;
    setText(this.statusEl, "Loading episodes…");
    api
      .seriesInfo(this.item.itemId)
      .then(({ info, seasons }) => {
        if (!this.alive) return;
        applyInfo(this.item, info);
        if (!this.item.backdrop && !this.item.poster && info.poster) this.item.poster = sizedImage(info.poster, POSTER_SIZE);
        this.showInfo();
        if (seasons.length === 0) {
          setText(this.statusEl, "Your provider hasn't listed any episodes for this show.");
          return;
        }
        setText(this.statusEl, "");
        this.seasons = seasons;
        this.seasonEls = seasons.map((s) => h("div", { class: "pill", text: s.title }));
        clear(this.seasonStrip);
        append(this.seasonStrip, this.seasonEls);
        this.panel.classList.remove("is-hidden");
        this.seriesCompat();
        this.seriesProgress(true);
      })
      .catch((err: Error) => setText(this.statusEl, err.message));
  }

  // Episodes in play order: the regular seasons, then specials.
  private playOrder(): Item[] {
    const regular = this.seasons.filter((s) => s.seasonNo > 0);
    const specials = this.seasons.filter((s) => s.seasonNo === 0);
    const order: Item[] = [];
    for (const season of regular.concat(specials)) for (const ep of season.episodes) order.push(episodeItem(ep, this.item.itemId));
    return order;
  }

  private seriesCompat(): void {
    let blocked = 0;
    let total = 0;
    let reason = "";
    for (const season of this.seasons) {
      for (const ep of season.episodes) {
        total++;
        const check = playCheck(factsOf(episodeItem(ep, this.item.itemId)));
        if (check.verdict === "blocked") {
          blocked++;
          reason = check.reason;
        }
      }
    }
    if (blocked === 0) setText(this.compatEl, "");
    else if (blocked === total) setText(this.compatEl, "Won't play on this TV. " + reason);
    else setText(this.compatEl, blocked + " of " + total + " episodes won't play on this TV. They're marked in the list.");
  }

  // Reads Continue Watching and sets the buttons, the season shown and progress bars.
  private seriesProgress(pickSeason: boolean): void {
    this.entry = progressFind("s:" + this.item.itemId);
    const entryId = this.entry ? this.entry.id : "";
    let entrySeason = -1;
    this.seasons.forEach((season, s) => {
      if (season.episodes.some((ep) => ep.id === entryId)) entrySeason = s;
    });
    if (pickSeason) {
      const firstRegular = this.seasons.findIndex((s) => s.seasonNo > 0);
      this.showSeason(entrySeason >= 0 ? entrySeason : Math.max(0, firstRegular));
    } else this.renderEpisodes();
    const order = this.playOrder();
    if (entrySeason >= 0 && this.entry) {
      const verb = toInt(this.entry.pos) > 0 ? "Resume " : "Play ";
      this.setButtons([
        { label: verb + episodeCode(this.entry.season, this.entry.episode), action: "resumeEpisode" },
        { label: "Episodes", action: "episodes" },
      ]);
    } else if (order.length > 0) {
      this.setButtons([
        { label: "Play " + episodeCode(order[0].seasonNo, order[0].episodeNo), action: "playFirst" },
        { label: "Episodes", action: "episodes" },
      ]);
    }
  }

  private showSeason(index: number): void {
    this.seasonIndex = index;
    const season = this.seasons[index];
    this.episodes = season ? season.episodes.map((ep) => episodeItem(ep, this.item.itemId)) : [];
    this.episodeIndex = 0;
    this.episodeTop = 0;
    for (const key of Object.keys(this.episodeEls)) {
      const el = this.episodeEls[Number(key)];
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this.episodeEls = {};
    this.styleSeasons();
    this.renderEpisodes();
  }

  private episodeEl(ep: Item, number: number): HTMLElement {
    const check = playCheck(factsOf(ep));
    const blocked = check.verdict === "blocked";
    const img = h("img", { class: "episode-img", attrs: { alt: "" } });
    if (ep.poster) {
      img.onerror = () => img.parentNode && img.parentNode.removeChild(img);
      img.src = ep.poster;
    }
    const progress = this.entry && this.entry.id === ep.itemId ? progressFraction(this.entry) : 0;
    const still = h("div", { class: "episode-still" }, [
      ep.poster ? img : null,
      progress > 0 ? h("div", { class: "poster-progress" }, [h("div", { class: "poster-fill", attrs: { style: "width:" + Math.round(progress * 100) + "%" } })]) : null,
    ]);
    const runtime = blocked ? "Won't play" : ep.durationSecs > 0 ? formatRuntime(ep.durationSecs) : "";
    return h("div", { class: "episode" + (blocked ? " is-blocked" : "") }, [
      still,
      h("div", { class: "episode-title", text: number + ".  " + ep.title }),
      h("div", { class: "episode-runtime", text: runtime }),
      h("div", { class: "episode-plot", text: ep.description }),
    ]);
  }

  // Only the episodes near the focus are in the page (daily shows have hundreds).
  private renderEpisodes(): void {
    if (this.episodeIndex < this.episodeTop) this.episodeTop = this.episodeIndex;
    if (this.episodeIndex >= this.episodeTop + EPISODES_SHOWN) this.episodeTop = this.episodeIndex - EPISODES_SHOWN + 1;
    this.episodeTrack.style.transform = "translateY(" + -this.episodeTop * EPISODE_H + "px)";
    const from = Math.max(0, this.episodeTop - 2);
    const to = Math.min(this.episodes.length - 1, this.episodeTop + EPISODES_SHOWN + 1);
    for (const key of Object.keys(this.episodeEls)) {
      const i = Number(key);
      if (i < from || i > to) {
        const el = this.episodeEls[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete this.episodeEls[i];
      }
    }
    for (let i = from; i <= to; i++) {
      let el = this.episodeEls[i];
      if (!el) {
        el = this.episodeEl(this.episodes[i], this.episodes[i].episodeNo || i + 1);
        el.style.transform = "translateY(" + i * EPISODE_H + "px)";
        this.episodeTrack.appendChild(el);
        this.episodeEls[i] = el;
      }
      toggle(el, "is-focused", this.zone === "episodes" && i === this.episodeIndex);
    }
  }

  // --- Buttons and seasons ----------------------------------------------------------

  private setButtons(buttons: { label: string; action: ButtonAction }[]): void {
    this.buttons = buttons;
    this.buttonEls = buttons.map((b) => h("div", { class: "pill", text: b.label }));
    clear(this.buttonsEl);
    append(this.buttonsEl, this.buttonEls);
    if (this.buttonIndex >= buttons.length) this.buttonIndex = 0;
    this.styleButtons();
  }

  private styleButtons(): void {
    this.buttonEls.forEach((el, i) => toggle(el, "is-focused", this.zone === "buttons" && i === this.buttonIndex));
  }

  private styleSeasons(): void {
    this.seasonEls.forEach((el, i) => {
      toggle(el, "is-focused", this.zone === "seasons" && i === this.seasonIndex);
      toggle(el, "is-selected", i === this.seasonIndex);
    });
    // Keep the chosen season in view when there are more than fit.
    const chosen = this.seasonEls[this.seasonIndex];
    if (chosen) {
      const right = chosen.offsetLeft + chosen.offsetWidth;
      this.seasonStrip.style.transform = "translateX(" + -Math.max(0, right - 1740) + "px)";
    }
  }

  private enterZone(zone: Zone): void {
    this.zone = zone;
    const scrolled = zone !== "buttons";
    toggle(this.body, "is-scrolled", scrolled);
    toggle(this.dim, "is-on", scrolled);
    this.body.style.transform = scrolled ? "translateY(" + -SCROLL_Y + "px)" : "";
    this.styleButtons();
    this.styleSeasons();
    this.renderEpisodes();
  }

  private activateButton(): void {
    const button = this.buttons[this.buttonIndex];
    if (!button) return;
    const entry = this.entry;
    switch (button.action) {
      case "play":
      case "restart":
        this.play(this.item, 0);
        break;
      case "resume":
        this.play(this.item, entry ? toInt(entry.pos) * 1000 : 0);
        break;
      case "playFirst": {
        const first = this.playOrder()[0];
        if (first) this.play(first, 0);
        break;
      }
      case "resumeEpisode": {
        const ep = this.playOrder().filter((e) => entry && e.itemId === entry.id)[0] || this.playOrder()[0];
        if (ep) this.play(ep, entry && entry.id === ep.itemId ? toInt(entry.pos) * 1000 : 0);
        break;
      }
      case "episodes":
        this.enterZone("episodes");
        if (entry) {
          const index = this.episodes.findIndex((e) => e.itemId === entry.id);
          if (index >= 0) this.episodeIndex = index;
        }
        this.renderEpisodes();
        break;
    }
  }

  // --- Playing (a stand-in until the M3 player) -------------------------------------

  private play(target: Item, startMs: number): void {
    const check = playCheck(factsOf(target));
    const go = () => this.launch(target, startMs);
    if (check.verdict === "blocked") {
      this.app.dialog({
        title: "This may not play",
        message: check.reason,
        buttons: [{ label: "Try anyway", action: go }, { label: "Back" }],
        focus: 1,
      });
      return;
    }
    go();
  }

  private launch(target: Item, startMs: number): void {
    const api = this.app.api;
    if (!api) return;
    const ext = (target.ext || "mp4").toLowerCase();
    const sample: Sample = {
      key: factsOf(target).key,
      kind: target.kind === "episode" ? "episode" : "movie",
      id: target.itemId,
      title: target.kind === "episode" ? this.item.title + " " + episodeCode(target.seasonNo, target.episodeNo) + " " + target.title : target.title,
      ext,
      poster: target.poster,
      videoCodec: target.videoCodec,
      videoProfile: target.videoProfile,
      audioCodec: target.audioCodec,
      width: target.width,
    };
    const url = streamUrl(api.creds, target.kind === "episode" ? "series" : "movie", target.itemId, ext);
    const test = new PlayTest(this.app.root, sample, url, (result: PlayResult) => this.afterPlay(target, result), startMs);
    setKeyTarget(test);
    test.start();
  }

  private afterPlay(target: Item, result: PlayResult): void {
    learnResult(factsOf(target), result.outcome === "played", result.error);
    setKeyTarget(this);
    if (this.item.kind === "series") {
      this.seriesCompat();
      for (const key of Object.keys(this.episodeEls)) {
        const el = this.episodeEls[Number(key)];
        if (el.parentNode) el.parentNode.removeChild(el);
      }
      this.episodeEls = {};
      this.renderEpisodes();
    } else this.movieCompat();
  }

  // --- Keys -------------------------------------------------------------------------

  onKey(key: Key): void {
    if (this.zone === "episodes") return this.onEpisodesKey(key);
    if (this.zone === "seasons") return this.onSeasonsKey(key);
    switch (key) {
      case "left":
        if (this.buttonIndex > 0) this.buttonIndex--;
        this.styleButtons();
        break;
      case "right":
        if (this.buttonIndex < this.buttons.length - 1) this.buttonIndex++;
        this.styleButtons();
        break;
      case "ok":
        this.activateButton();
        break;
      case "play":
        this.buttonIndex = 0;
        this.styleButtons();
        this.activateButton();
        break;
      case "down":
        if (this.seasons.length > 0) this.enterZone("seasons");
        break;
      case "back":
        this.app.pop();
        break;
      default:
        break;
    }
  }

  private onSeasonsKey(key: Key): void {
    switch (key) {
      case "left":
        if (this.seasonIndex > 0) this.showSeason(this.seasonIndex - 1);
        break;
      case "right":
        if (this.seasonIndex < this.seasons.length - 1) this.showSeason(this.seasonIndex + 1);
        break;
      case "down":
      case "ok":
        if (this.episodes.length > 0) this.enterZone("episodes");
        break;
      case "up":
      case "back":
        this.enterZone("buttons");
        break;
      default:
        break;
    }
  }

  private onEpisodesKey(key: Key): void {
    switch (key) {
      case "up":
        if (this.episodeIndex === 0) this.enterZone("seasons");
        else {
          this.episodeIndex--;
          this.renderEpisodes();
        }
        break;
      case "down":
        if (this.episodeIndex < this.episodes.length - 1) {
          this.episodeIndex++;
          this.renderEpisodes();
        }
        break;
      case "ok":
      case "play": {
        const ep = this.episodes[this.episodeIndex];
        if (ep) this.play(ep, this.entry && this.entry.id === ep.itemId ? toInt(this.entry.pos) * 1000 : 0);
        break;
      }
      case "back":
        this.enterZone("buttons");
        break;
      default:
        break;
    }
  }

  // --- Screen -----------------------------------------------------------------------

  onShow(): void {
    if (this.item.kind === "movie") this.movieButtons();
    else if (this.seasons.length > 0) this.seriesProgress(false);
    this.enterZone(this.zone);
  }

  destroy(): void {
    this.alive = false;
  }
}
