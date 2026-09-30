// Home, Movies and Series (plan 7.2; the Roku app's HomeScreen): a nav bar with a
// gliding highlight and the account button, a hero for the focused title, and rows of
// posters below. Only the rows and posters near the focus are in the page, and rows
// load a few at a time as you scroll, so a big library doesn't choke the TV.

import type { App, Screen } from "../app";
import { playCheck } from "../core/compat";
import { applyInfo, Item, makeItem, metaLine } from "../core/items";
import { log } from "../core/log";
import { continueWatchingRow } from "../core/progress";
import { sizedImage } from "../core/utils";
import { Category, POSTER_SIZE } from "../core/xtream";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { itemKey, posterEl } from "../ui/poster";
import { Backdrop } from "../ui/backdrop";
import { DetailsScreen } from "./details";
import { SetupChecksScreen } from "./setup";
import { SubtitleSetupScreen } from "./subtitle-setup";

const TABS = ["Home", "Movies", "Series", "Search"];
const ACCOUNT = TABS.length; // nav cursor index of the account button

const ROW_H = 366; // title, poster, caption and the gap below
const COL_W = 210; // poster width plus spacing
const FULL_COLS = 8; // posters fully in view
const HERO_REST_MS = 600;
const ROW_BATCH = 5;

interface PlanEntry {
  kind: "movie" | "series";
  categoryId: string;
  title: string;
}

interface RowState {
  title: string;
  items: Item[];
  isContinue: boolean;
  col: number; // focused poster
  scroll: number; // first poster in view
  el: HTMLElement | null;
  strip: HTMLElement | null;
  posters: { [index: number]: HTMLElement };
}

function placeholders(): Item[] {
  const list: Item[] = [];
  for (let i = 0; i < 8; i++) list.push(makeItem({ placeholder: true }));
  return list;
}

export class HomeScreen implements Screen {
  readonly el: HTMLElement;
  private tabEls: HTMLElement[];
  private navHighlight: HTMLElement;
  private accountEl: HTMLElement;
  private heroEl: HTMLElement;
  private heroTitle: HTMLElement;
  private heroMeta: HTMLElement;
  private heroPlot: HTMLElement;
  private backdrop: Backdrop;
  private track: HTMLElement;
  private status: HTMLElement;

  private tab = 0;
  private navCursor = 0;
  private navFocused = true;
  private firstLoad = true;
  private failed = false;
  private movieCats: Category[] | null = null;
  private seriesCats: Category[] | null = null;
  private lastError = "";

  private rows: RowState[] = [];
  private rowIndex = 0;
  private plan: PlanEntry[] = [];
  private planIndex = 0;
  private generation = 0;

  private heroItem: Item | null = null;
  private heroTimer = 0;
  private heroDebounce = 0;

  constructor(private app: App) {
    this.tabEls = TABS.map((name) => h("div", { class: "nav-tab", text: name }));
    this.navHighlight = h("div", { class: "nav-highlight" });
    this.accountEl = h("div", { class: "nav-account", attrs: { "aria-label": "Account" } });
    this.accountEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="8.5" r="4.2" fill="currentColor"/><path d="M3.8 20.5c1.2-4.1 4.4-6.2 8.2-6.2s7 2.1 8.2 6.2" fill="currentColor"/></svg>';
    this.heroTitle = h("div", { class: "hero-title" });
    this.heroMeta = h("div", { class: "hero-meta" });
    this.heroPlot = h("div", { class: "hero-plot" });
    this.heroEl = h("div", { class: "hero" }, [this.heroTitle, this.heroMeta, this.heroPlot]);
    this.backdrop = new Backdrop();
    this.track = h("div", { class: "rows-track" });
    this.status = h("div", { class: "home-status" });

    this.el = h("div", { class: "screen home" }, [
      this.backdrop.el,
      h("div", { class: "top-shade" }),
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo home-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "nav" }, [this.navHighlight].concat(this.tabEls)),
      this.accountEl,
      this.heroEl,
      h("div", { class: "rows-viewport" }, [this.track]),
      this.status,
    ]);
    this.styleNav();
    this.loadCategories();
  }

  // --- Loading ----------------------------------------------------------------------

  private loadCategories(): void {
    const api = this.app.api;
    if (!api) return;
    this.failed = false;
    this.lastError = "";
    setText(this.status, "Loading your library…");
    const note = (err: Error) => {
      this.lastError = err.message;
      return [] as Category[];
    };
    Promise.all([api.categories("movie").catch(note), api.categories("series").catch(note)]).then(([movies, series]) => {
      this.movieCats = movies;
      this.seriesCats = series;
      this.showTab(this.tab);
    });
  }

  private buildPlan(tab: number): PlanEntry[] {
    const movies = this.movieCats || [];
    const series = this.seriesCats || [];
    const plan: PlanEntry[] = [];
    if (tab === 0) {
      // Home mixes the provider's first six movie and first six series categories.
      for (let i = 0; i < 6; i++) {
        if (i < movies.length) plan.push({ kind: "movie", categoryId: movies[i].id, title: movies[i].name + "  ·  Movies" });
        if (i < series.length) plan.push({ kind: "series", categoryId: series[i].id, title: series[i].name + "  ·  Series" });
      }
    } else if (tab === 1) {
      for (const c of movies) plan.push({ kind: "movie", categoryId: c.id, title: c.name });
    } else if (tab === 2) {
      for (const c of series) plan.push({ kind: "series", categoryId: c.id, title: c.name });
    }
    return plan;
  }

  private showTab(tab: number): void {
    this.tab = tab;
    this.navCursor = tab;
    this.generation++;
    this.plan = this.buildPlan(tab);
    this.planIndex = 0;
    for (const row of this.rows) if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
    this.rows = [];
    this.rowIndex = 0;
    if (tab === 0) {
      const cw = continueWatchingRow();
      if (cw) this.rows.push(this.rowState(cw.title, cw.items, true));
    }
    this.appendRows(ROW_BATCH);
    this.styleNav();

    if (this.rows.length === 0) {
      this.failed = this.lastError !== "";
      setText(this.status, this.failed ? "Couldn't load your library. " + this.lastError + " Press OK to try again." : "Your provider didn't list anything here.");
      this.clearHero();
      this.focusNav();
      this.renderRows();
      return;
    }
    setText(this.status, "");
    if (this.firstLoad) {
      this.firstLoad = false;
      this.navFocused = false;
      this.styleNav();
    }
    this.renderRows();
    this.onFocusMoved();
  }

  private rowState(title: string, items: Item[], isContinue = false): RowState {
    return { title, items, isContinue, col: 0, scroll: 0, el: null, strip: null, posters: {} };
  }

  private appendRows(count: number): void {
    const api = this.app.api;
    if (!api) return;
    for (let added = 0; added < count && this.planIndex < this.plan.length; added++) {
      const entry = this.plan[this.planIndex++];
      const row = this.rowState(entry.title, placeholders());
      this.rows.push(row);
      const generation = this.generation;
      api
        .row(entry.kind, entry.categoryId, entry.title)
        .then((loaded) => {
          if (generation !== this.generation) return;
          if (loaded.items.length === 0) return this.dropRow(row);
          row.items = loaded.items;
          this.rebuildRow(row);
          if (this.focusedRow() === row) this.onFocusMoved();
          return undefined;
        })
        .catch((err: Error) => {
          if (generation !== this.generation) return;
          log("row failed:", entry.title, err.message);
          this.dropRow(row);
        });
    }
  }

  // An empty or failed category is dropped and the next one pulled in instead.
  private dropRow(row: RowState): void {
    const index = this.rows.indexOf(row);
    if (index < 0) return;
    if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
    this.rows.splice(index, 1);
    for (const r of this.rows) this.detachRow(r); // positions changed
    if (this.rowIndex > index || this.rowIndex >= this.rows.length) this.rowIndex = Math.max(0, Math.min(this.rowIndex - (this.rowIndex > index ? 1 : 0), this.rows.length - 1));
    this.appendRows(1);
    if (this.rows.length === 0) {
      setText(this.status, "Your provider didn't list anything here.");
      this.clearHero();
      this.focusNav();
    }
    this.renderRows();
    this.onFocusMoved();
  }

  // --- Rows -------------------------------------------------------------------------

  private focusedRow(): RowState | null {
    return this.rows[this.rowIndex] || null;
  }

  private focusedItem(): Item | null {
    const row = this.focusedRow();
    return row ? row.items[row.col] || null : null;
  }

  private detachRow(row: RowState): void {
    if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
    row.el = null;
    row.strip = null;
    row.posters = {};
  }

  private rebuildRow(row: RowState): void {
    if (row.col >= row.items.length) row.col = Math.max(0, row.items.length - 1);
    this.detachRow(row);
    this.renderRows();
  }

  // Keeps rows from one above to two below the focused row in the page.
  private renderRows(): void {
    this.track.style.transform = "translateY(" + -this.rowIndex * ROW_H + "px)";
    this.rows.forEach((row, i) => {
      const near = i >= this.rowIndex - 1 && i <= this.rowIndex + 2;
      if (!near) {
        this.detachRow(row);
        return;
      }
      if (!row.el) {
        row.strip = h("div", { class: "row-strip" });
        row.el = h("div", { class: "row" }, [h("div", { class: "row-title", text: row.title }), row.strip]);
        this.track.appendChild(row.el);
      }
      row.el.style.transform = "translateY(" + i * ROW_H + "px)";
      this.renderStrip(row, i === this.rowIndex && !this.navFocused);
    });
  }

  private renderStrip(row: RowState, hasFocus: boolean): void {
    if (!row.strip) return;
    if (row.col < row.scroll) row.scroll = row.col;
    if (row.col >= row.scroll + FULL_COLS) row.scroll = row.col - FULL_COLS + 1;
    row.strip.style.transform = "translateX(" + -row.scroll * COL_W + "px)";
    const from = Math.max(0, row.scroll - 2);
    const to = Math.min(row.items.length - 1, row.scroll + FULL_COLS + 2);
    for (const key of Object.keys(row.posters)) {
      const i = Number(key);
      if (i < from || i > to) {
        const el = row.posters[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete row.posters[i];
      }
    }
    for (let i = from; i <= to; i++) {
      let el = row.posters[i];
      if (!el) {
        el = posterEl(row.items[i]);
        el.style.transform = "translateX(" + i * COL_W + "px)";
        row.strip.appendChild(el);
        row.posters[i] = el;
      }
      toggle(el, "is-focused", hasFocus && i === row.col);
    }
  }

  private moveRow(delta: number): void {
    const next = this.rowIndex + delta;
    if (next < 0 || next >= this.rows.length) return;
    this.rowIndex = next;
    if (this.rowIndex >= this.rows.length - 3) this.appendRows(3);
    this.renderRows();
    this.onFocusMoved();
  }

  private moveCol(delta: number): boolean {
    const row = this.focusedRow();
    if (!row) return false;
    const next = row.col + delta;
    if (next < 0 || next >= row.items.length) return false;
    row.col = next;
    this.renderStrip(row, true);
    this.onFocusMoved();
    return true;
  }

  // --- Hero ---------------------------------------------------------------------------

  private onFocusMoved(): void {
    window.clearTimeout(this.heroDebounce);
    // A short wait keeps held arrow keys smooth; the hero catches up when they stop.
    this.heroDebounce = window.setTimeout(() => this.refreshHero(), 90);
  }

  private refreshHero(): void {
    const item = this.focusedItem();
    if (!item || item.placeholder) return;
    this.showHero(item);
    window.clearTimeout(this.heroTimer);
    if (!item.hasInfo && item.kind === "movie") this.heroTimer = window.setTimeout(() => this.fetchInfo(item), HERO_REST_MS);
  }

  private showHero(item: Item): void {
    setText(this.heroTitle, item.title);
    let meta = item.caption ? "Resume  " + item.caption : metaLine(item);
    let blocked = false;
    if (item.kind !== "series") {
      const check = playCheck({ key: itemKey(item), ext: item.ext, videoCodec: item.videoCodec, videoProfile: item.videoProfile, audioCodec: item.audioCodec });
      if (check.verdict === "blocked") {
        blocked = true;
        meta = "Won't play on this TV (" + check.label + ")" + (meta ? "   ·   " + meta : "");
      }
    }
    setText(this.heroMeta, meta);
    toggle(this.heroMeta, "is-warning", blocked);
    setText(this.heroPlot, item.description);
    // A new title floats in; details arriving for the same title don't replay it.
    if (this.heroItem !== item) {
      this.heroEl.classList.remove("hero-enter");
      void this.heroEl.offsetWidth;
      this.heroEl.classList.add("hero-enter");
    }
    this.heroItem = item;
    if (item.backdrop) this.backdrop.show(item.backdrop, 1);
    else if (item.poster) this.backdrop.show(sizedImage(item.poster, POSTER_SIZE), 0.35);
    else this.backdrop.show("", 0);
  }

  private clearHero(): void {
    setText(this.heroTitle, "");
    setText(this.heroMeta, "");
    setText(this.heroPlot, "");
    this.heroItem = null;
    this.backdrop.show("", 0);
  }

  // Movie lists have no plot or backdrop, so fetch them once the focus settles.
  private fetchInfo(item: Item): void {
    const api = this.app.api;
    if (!api || item.hasInfo) return;
    api
      .vodInfo(item.itemId)
      .then((info) => {
        applyInfo(item, info);
        if (!item.poster && info.poster) item.poster = sizedImage(info.poster, POSTER_SIZE);
        // Codecs may change the Won't play tag on its poster.
        for (const row of this.rows) if (row.items.indexOf(item) >= 0 && row.el) this.rebuildRow(row);
        if (this.focusedItem() === item) this.showHero(item);
      })
      .catch((err: Error) => log("vod info failed:", err.message));
  }

  // --- Nav ----------------------------------------------------------------------------

  private styleNav(): void {
    const target = this.navFocused ? this.navCursor : this.tab;
    this.tabEls.forEach((el, i) => {
      toggle(el, "is-current", i === this.tab);
      toggle(el, "is-focused", this.navFocused && i === this.navCursor);
    });
    toggle(this.accountEl, "is-focused", this.navFocused && this.navCursor === ACCOUNT);
    const tabEl = this.tabEls[Math.min(target, TABS.length - 1)];
    toggle(this.navHighlight, "is-active", this.navFocused);
    toggle(this.navHighlight, "is-hidden", this.navFocused && this.navCursor === ACCOUNT);
    this.navHighlight.style.transform = "translateX(" + tabEl.offsetLeft + "px)";
    this.navHighlight.style.width = tabEl.offsetWidth + "px";
  }

  private focusNav(): void {
    this.navFocused = true;
    this.navCursor = this.tab;
    this.styleNav();
    this.renderRows();
  }

  private focusRows(): void {
    if (this.rows.length === 0) {
      this.focusNav();
      return;
    }
    this.navFocused = false;
    this.styleNav();
    this.renderRows();
    this.onFocusMoved();
  }

  private activateNav(): void {
    if (this.navCursor === ACCOUNT) {
      this.accountMenu();
      return;
    }
    if (TABS[this.navCursor] === "Search") {
      this.app.dialog({
        title: "Search is on its way",
        message: "Searching your whole library arrives in a later update. For now, browse Movies and Series.",
        buttons: [{ label: "OK" }],
      });
      return;
    }
    if (this.failed) {
      this.loadCategories();
      return;
    }
    if (this.navCursor !== this.tab) this.showTab(this.navCursor);
    this.focusRows();
  }

  private accountMenu(): void {
    this.app.dialog({
      title: "Account",
      message: "Your IPTV login is saved on this TV only.",
      buttons: [
        { label: "Keep watching" },
        { label: "Online subtitles", action: () => this.app.push(new SubtitleSetupScreen(this.app)) },
        { label: "Setup checks", action: () => this.app.push(new SetupChecksScreen(this.app)) },
        { label: "Sign out", action: () => this.app.signOut() },
      ],
    });
  }

  // --- Keys ---------------------------------------------------------------------------

  onKey(key: Key): void {
    if (this.navFocused) {
      this.onNavKey(key);
      return;
    }
    switch (key) {
      case "up":
        if (this.rowIndex === 0) this.focusNav();
        else this.moveRow(-1);
        break;
      case "down":
        this.moveRow(1);
        break;
      case "left":
        if (!this.moveCol(-1)) this.focusNav();
        break;
      case "right":
        this.moveCol(1);
        break;
      case "ok":
      case "play": {
        const item = this.focusedItem();
        if (item && !item.placeholder) this.app.push(new DetailsScreen(this.app, item));
        break;
      }
      case "back":
        // Back jumps to the first row, then the nav bar, then asks to exit.
        if (this.rowIndex > 0) {
          this.rowIndex = 0;
          const first = this.rows[0];
          if (first) first.col = 0;
          this.renderRows();
          this.onFocusMoved();
        } else this.focusNav();
        break;
      default:
        break;
    }
  }

  private onNavKey(key: Key): void {
    switch (key) {
      case "left":
        if (this.navCursor > 0) this.navCursor--;
        this.styleNav();
        break;
      case "right":
        if (this.navCursor < ACCOUNT) this.navCursor++;
        this.styleNav();
        break;
      case "ok":
        this.activateNav();
        break;
      case "down":
        if (this.navCursor === ACCOUNT || TABS[this.navCursor] === "Search") this.focusRows();
        else this.activateNav();
        break;
      case "back":
        this.app.confirmExit();
        break;
      default:
        break;
    }
  }

  // --- Screen -------------------------------------------------------------------------

  onShow(): void {
    // Back from Details: Continue Watching may have changed.
    if (this.tab === 0 && this.movieCats) {
      const cw = continueWatchingRow();
      const had = this.rows.length > 0 && this.rows[0].isContinue;
      if (had) this.detachRow(this.rows[0]);
      if (cw && had) {
        this.rows[0].items = cw.items;
        this.rows[0].col = Math.min(this.rows[0].col, cw.items.length - 1);
      } else if (cw) {
        this.rows.unshift(this.rowState(cw.title, cw.items, true));
        this.rowIndex++;
      } else if (had) {
        this.rows.shift();
        this.rowIndex = Math.max(0, this.rowIndex - 1);
      }
      for (const row of this.rows) this.detachRow(row);
      this.renderRows();
    }
    this.styleNav();
    if (!this.navFocused) this.onFocusMoved();
  }

  onHide(): void {
    window.clearTimeout(this.heroTimer);
    window.clearTimeout(this.heroDebounce);
  }

  destroy(): void {
    this.onHide();
    this.generation++;
  }

  // For the screenshot script and tests.
  debugState(): { tab: number; rows: number; rowIndex: number; navFocused: boolean } {
    return { tab: this.tab, rows: this.rows.length, rowIndex: this.rowIndex, navFocused: this.navFocused };
  }
}
