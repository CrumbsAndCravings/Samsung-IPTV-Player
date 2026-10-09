// Home, Movies and Series (plan 7.2; the Roku app's HomeScreen, docs/features.md §4.4
// and §5.1): a nav bar with a gliding highlight and the account button, a hero for the
// focused title, and rows of posters below. Only the rows and posters near the focus
// are in the page, and rows load a few at a time as you scroll, so a big library
// doesn't choke the TV.
//
// Home holds Continue Watching, then My List, Top picks for you and up to two "Because
// you watched" rows (picked from the stored library and what you watch, core/taste.ts),
// then up to 18 rows: new releases first, then the rest, movies and series taking turns
// and each language you watch taking turns, the categories you like moving up after the
// first two. Movies and Series list every wanted category, the ones you like after the
// first. Each row ends with a See all tile for its whole category. Holding OK on a
// poster offers My List, a rating, Account and, on Continue Watching, taking it off.

import type { App, Screen } from "../app";
import { languageTurns, organizeCategories, OrganizedCategory, takeTurns } from "../core/categories";
import { playCheck } from "../core/compat";
import { applyInfo, backdropPictures, Item, makeItem, metaLine } from "../core/items";
import { log } from "../core/log";
import { helperOn, languagePrefs } from "../core/personal";
import { listItem, myList, myListHas, myListToggle, titleKey } from "../core/mylist";
import { continueWatchingRow, progressList, progressRemove } from "../core/progress";
import { isRefusalCode } from "../core/refusals";
import { nowSeconds, Rating, ratingLabel, tasteBecause, tasteHistory, tasteNotForMe, tasteOrder, tasteRate, tasteRating, tasteSaveScores, tasteScores } from "../core/taste";
import { Json, sizedImage } from "../core/utils";
import { Category, POSTER_SIZE } from "../core/xtream";
import { ApiError } from "../data/api";
import { librarySaved } from "../data/library";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { COL_W, itemKey, posterEl } from "../ui/poster";
import { Backdrop } from "../ui/backdrop";
import { CategoriesScreen } from "./categories";
import { CategoryScreen } from "./category";
import { DetailsScreen } from "./details";
import { ServerScreen } from "./server";
import { SetupChecksScreen } from "./setup";
import { SearchScreen } from "./search";
import { SubtitleSetupScreen } from "./subtitle-setup";

const TABS = ["Home", "Movies", "Series", "Categories", "Search"];
const ACCOUNT = TABS.length; // nav cursor index of the account button

const ROW_H = 345; // title, poster and the gap below
const FULL_COLS = 9; // posters fully in view
const HERO_REST_MS = 600;
const ROW_BATCH = 5;
const HOME_ROWS = 18;
const HOLD_MS = 700; // holding OK this long on a poster opens its menu
const PICKS_AFTER_MS = 6000; // the rows picked for you come after Home's own

interface PlanEntry {
  kind: "movie" | "series";
  categoryId: string;
  label: string;
  title: string;
  lang: string;
  demoted: boolean;
}

// Plan entries for organized categories of one kind; with `wantNew` true or false, only
// the categories of new releases or only the others.
function planEntries(list: OrganizedCategory[], kind: "movie" | "series", wantNew: boolean | null): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const c of list) {
    if (wantNew === null || c.isNew === wantNew) entries.push({ kind, categoryId: c.id, label: c.label, title: c.label, lang: c.lang, demoted: c.demoted });
  }
  return entries;
}

// Every wanted category, organized (the Q60 is 4K, so 4K categories aren't demoted).
export function organized(list: Category[]): OrganizedCategory[] {
  return organizeCategories(list, languagePrefs(), new Date().getFullYear());
}

interface RowState {
  title: string;
  items: Item[];
  isContinue: boolean;
  // Rows picked for you: "list" (My List), "picks" (Top picks for you), or the key of the
  // title a "Because you watched" row is about.
  slot: string;
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
  private lastRefused = false;

  private rows: RowState[] = [];
  private rowIndex = 0;
  private plan: PlanEntry[] = [];
  private planIndex = 0;
  private generation = 0;

  private heroItem: Item | null = null;
  private heroTimer = 0;
  private heroDebounce = 0;
  private holdTimer = 0; // OK is down on a poster
  private unsubscribeSync: (() => void) | null = null;
  private picksTimer = 0;
  private picksStamp = ""; // what the rows picked for you were last picked from
  private unsubscribeLibrary: (() => void) | null = null;

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
    // Another device changed Continue Watching.
    if (app.sync) this.unsubscribeSync = app.sync.onChange(() => this.refreshContinueWatching());
  }

  // --- Loading ----------------------------------------------------------------------

  private loadCategories(): void {
    const api = this.app.api;
    if (!api) return;
    this.failed = false;
    this.lastError = "";
    this.lastRefused = false;
    setText(this.status, "Loading your library…");
    const note = (err: Error) => {
      this.noteError(err);
      return [] as Category[];
    };
    Promise.all([api.categories("movie").catch(note), api.categories("series").catch(note)]).then(([movies, series]) => {
      this.movieCats = movies;
      this.seriesCats = series;
      this.showTab(this.tab);
    });
  }

  private noteError(err: Error): void {
    this.lastError = err.message;
    this.lastRefused = err instanceof ApiError && (isRefusalCode(err.code) || err.cfBlock);
  }

  // Which category rows each tab shows. Categories in languages you don't watch are
  // left out, names are tidied ("EN | ACTION ★" becomes "Action"), and categories of
  // new releases come first.
  private buildPlan(tab: number): PlanEntry[] {
    const movies = organized(this.movieCats || []);
    const series = organized(this.seriesCats || []);
    // The categories you like move up (core/taste.ts): after the first row on Movies and
    // Series, after the first two (new releases) on Home.
    const scores = tasteScores();
    if (tab === 1) return tasteOrder(planEntries(movies, "movie", null), scores, 1);
    if (tab === 2) return tasteOrder(planEntries(series, "series", null), scores, 1);
    if (tab !== 0) return [];
    const langs = languagePrefs();
    const newest = takeTurns(planEntries(movies, "movie", true), planEntries(series, "series", true));
    const rest = languageTurns(takeTurns(planEntries(movies, "movie", false), planEntries(series, "series", false)), langs);
    return tasteOrder(newest.concat(rest), scores, 2)
      .slice(0, HOME_ROWS)
      .map((entry) => {
        entry.title = entry.label + (entry.kind === "series" ? "  ·  Series" : "  ·  Movies");
        return entry;
      });
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
      this.addPersonalRows();
    }
    this.appendRows(ROW_BATCH);
    this.styleNav();

    if (this.rows.length === 0) {
      if (this.lastError !== "") return this.showLoadError();
      setText(this.status, "Your provider didn't list anything here.");
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

  private rowState(title: string, items: Item[], isContinue = false, slot = ""): RowState {
    return { title, items, isContinue, slot, col: 0, scroll: 0, el: null, strip: null, posters: {} };
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
          if (loaded.items.length === 0) return this.dropRow(row, true);
          // A See all tile ends the row; its page lists the whole category.
          const title = this.tab === 1 ? entry.title + "  ·  Movies" : this.tab === 2 ? entry.title + "  ·  Series" : entry.title;
          row.items = loaded.items.concat([makeItem({ kind: "seeAll", title, categoryId: entry.categoryId, listKind: entry.kind })]);
          this.rebuildRow(row);
          if (this.focusedRow() === row) this.onFocusMoved();
          return undefined;
        })
        .catch((err: Error) => {
          if (generation !== this.generation) return;
          log("row failed:", entry.title, err.message);
          // The server is saying no or not answering. Asking for every other category
          // would look like a flood and could keep this connection blocked longer.
          this.noteError(err);
          this.planIndex = this.plan.length;
          this.dropRow(row, false);
        });
    }
  }

  // An empty category is dropped and the next one pulled in instead (`next`).
  private dropRow(row: RowState, next: boolean): void {
    const index = this.rows.indexOf(row);
    if (index < 0) return;
    if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
    this.rows.splice(index, 1);
    for (const r of this.rows) this.detachRow(r); // positions changed
    if (this.rowIndex > index || this.rowIndex >= this.rows.length) this.rowIndex = Math.max(0, Math.min(this.rowIndex - (this.rowIndex > index ? 1 : 0), this.rows.length - 1));
    if (next) this.appendRows(1);
    if (this.rows.length === 0) {
      if (this.lastError !== "") return this.showLoadError();
      setText(this.status, "Your provider didn't list anything here.");
      this.clearHero();
      this.focusNav();
    }
    this.renderRows();
    this.onFocusMoved();
  }

  // Wraps to three lines; refusals add the usual causes.
  private showLoadError(): void {
    this.failed = true;
    let text = "Couldn't load your library. " + this.lastError;
    if (this.lastRefused) {
      text += " The provider may have moved to a new address (ask them, then sign out from the account button and back in), the trial may have ended, or they may be blocking your connection for a while.";
    }
    setText(this.status, text + " Press OK to try again.");
    this.clearHero();
    this.focusNav();
    this.renderRows();
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
    // See all keeps the previous title in the hero.
    if (!item || item.placeholder || item.kind === "seeAll") return;
    this.showHero(item);
    window.clearTimeout(this.heroTimer);
    if (!item.hasInfo && item.kind === "movie") this.heroTimer = window.setTimeout(() => this.fetchInfo(item), HERO_REST_MS);
  }

  private showHero(item: Item): void {
    setText(this.heroTitle, item.title);
    let meta = item.caption ? "Resume  " + item.caption : metaLine(item);
    let blocked = false;
    if (item.kind !== "series" && !helperOn()) {
      const check = playCheck({ key: itemKey(item), ext: item.ext, videoCodec: item.videoCodec, videoProfile: item.videoProfile, audioCodec: item.audioCodec });
      if (check.verdict === "blocked") {
        blocked = true;
        meta = "Won't play on this TV (" + check.label + ")" + (meta ? "   ·   " + meta : "");
      }
    }
    if (titleKey(item) !== "") meta += "   ·   Hold OK for more";
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
    // The moving banner, once the details are in (straight away for series).
    if (item.hasInfo) this.backdrop.slides(backdropPictures(item));
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
      this.app.push(new SearchScreen(this.app));
      return;
    }
    if (this.failed) {
      this.loadCategories();
      return;
    }
    if (TABS[this.navCursor] === "Categories") {
      // Still loading the category lists: nothing to show yet.
      if (!this.movieCats || !this.seriesCats) return;
      this.app.push(new CategoriesScreen(this.app, organized(this.movieCats), organized(this.seriesCats)));
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
        { label: "Change server address", action: () => this.app.push(new ServerScreen(this.app)) },
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
      case "ok": {
        const item = this.focusedItem();
        if (item && titleKey(item) !== "") {
          // Held, it opens the title's menu; let go sooner and it opens the title.
          window.clearTimeout(this.holdTimer);
          this.holdTimer = window.setTimeout(() => {
            this.holdTimer = 0;
            this.showTitleMenu(item);
          }, HOLD_MS);
        } else this.open(item);
        break;
      }
      case "play":
        this.open(this.focusedItem());
        break;
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

  onKeyUp(key: Key): void {
    if (key !== "ok" || !this.holdTimer) return;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.open(this.focusedItem());
  }

  private open(item: Item | null): void {
    if (!item || item.placeholder) return;
    if (item.kind === "seeAll") {
      this.app.push(new CategoryScreen(this.app, { kind: item.listKind === "series" ? "series" : "movie", categoryId: item.categoryId, title: item.title }));
      return;
    }
    this.app.push(new DetailsScreen(this.app, item));
  }

  // --- Picked for you (the Roku app's 0.5.7 and 0.5.8; docs/features.md §5.1.1) -------
  //
  // My List, "Top picks for you" and "Because you watched" rows under Continue Watching,
  // from what you watch (core/taste.ts) and the library stored on the TV, so they cost
  // the provider nothing. They're laid out as placeholders straight away, so nothing
  // jumps when they arrive, and picked 6 s after Home's own rows. With no stored library
  // yet (it's built the first time Search, Categories or a See all page is used), they
  // wait for a launch that has one.

  private addPersonalRows(): void {
    // My List first, as name cards until the library brings their pictures.
    const list = myList();
    if (list.length > 0) this.rows.push(this.rowState("My List", list.map((e) => listItem(e, "")), false, "list"));
    if (librarySaved() && (tasteHistory().length > 0 || progressList().length > 0)) {
      this.rows.push(this.rowState("Top picks for you", placeholders(), false, "picks"));
      for (const title of tasteBecause(tasteHistory(), 2)) this.rows.push(this.rowState("Because you watched " + title.n, placeholders(), false, title.k));
    }
    this.picksStamp = "";
    window.clearTimeout(this.picksTimer);
    if (this.rows.some((r) => r.slot !== "")) this.picksTimer = window.setTimeout(() => this.askPicks(), PICKS_AFTER_MS);
  }

  // What the picks depend on; when it hasn't changed, they aren't picked again.
  private personalStamp(): string {
    return JSON.stringify([tasteHistory(), progressList().map((e) => e.k), myList().map((e) => e.k)]);
  }

  private askPicks(): void {
    const library = this.app.library;
    if (this.tab !== 0 || !library || !this.rows.some((r) => r.slot !== "")) return;
    // Only with a stored library: building one asks the provider for every category.
    if (!librarySaved() && !library.hasTitles) return;
    library.start();
    if (!library.hasTitles) {
      // The saved library is still being read: pick once it's in.
      if (!this.unsubscribeLibrary) {
        this.unsubscribeLibrary = library.onChange(() => {
          if (!library.hasTitles) return;
          if (this.unsubscribeLibrary) this.unsubscribeLibrary();
          this.unsubscribeLibrary = null;
          this.askPicks();
        });
      }
      return;
    }
    const stamp = this.personalStamp();
    if (stamp === this.picksStamp) return;
    this.picksStamp = stamp;
    const because = this.rows.filter((r) => r.slot !== "" && r.slot !== "list" && r.slot !== "picks").map((r) => ({ k: r.slot, n: r.title.replace(/^Because you watched /, "") }));
    const generation = this.generation;
    const started = Date.now();
    const picked = library.picks({ history: tasteHistory(), watching: progressList() as unknown as Json[], because, list: myList() }, nowSeconds());
    log("picks:", picked.rows.map((r) => r.slot + " " + r.items.length).join(", "), "in", Date.now() - started, "ms");
    if (generation !== this.generation) return;
    // Kept to order the rows next time.
    tasteSaveScores(picked.scores);
    for (const answer of picked.rows) {
      const row = this.rows.filter((r) => r.slot === answer.slot)[0];
      if (!row) continue;
      if (answer.items.length > 0) {
        row.items = answer.items;
        this.rebuildRow(row);
      } else if (answer.slot !== "list") this.dropRow(row, false); // nothing to pick: the row goes
    }
    if (!this.navFocused) this.onFocusMoved();
  }

  // My List changed (on Details, or from a poster's menu): its row follows, under
  // Continue Watching, keeping the pictures it had and the focus on the same poster.
  private syncListRow(): void {
    if (this.tab !== 0 || !this.movieCats) return;
    const list = myList();
    const at = this.rows.findIndex((r) => r.slot === "list");
    const old = at >= 0 ? this.rows[at] : null;
    if (list.length === 0) {
      if (old) {
        this.detachRow(old);
        this.rows.splice(at, 1);
        if (this.rowIndex > at || this.rowIndex >= this.rows.length) this.rowIndex = Math.max(0, this.rowIndex - 1);
        for (const row of this.rows) this.detachRow(row);
        this.renderRows();
      }
      return;
    }
    const posters: { [key: string]: string } = {};
    if (old) for (const item of old.items) posters[titleKey(item)] = item.poster;
    const items = list.map((e) => listItem(e, posters[e.k] || ""));
    if (old) {
      const focused = old.items[old.col];
      old.items = items;
      const keep = focused ? items.findIndex((i) => titleKey(i) === titleKey(focused)) : -1;
      old.col = keep >= 0 ? keep : Math.min(old.col, items.length - 1);
      this.rebuildRow(old);
      return;
    }
    const index = this.rows.length > 0 && this.rows[0].isContinue ? 1 : 0;
    this.rows.splice(index, 0, this.rowState("My List", items, false, "list"));
    if (this.rowIndex >= index && this.rows.length > 1 && !this.navFocused) this.rowIndex++;
    for (const row of this.rows) this.detachRow(row);
    this.renderRows();
  }

  // Holding OK on a poster: My List, a rating, and on Continue Watching taking it off;
  // Account last.
  private showTitleMenu(item: Item): void {
    const key = titleKey(item);
    const rating = tasteRating(key);
    const buttons: { label: string; action?: () => void }[] = [
      {
        label: myListHas(key) ? "Remove from My List" : "Add to My List",
        action: () => {
          myListToggle(key, item.title, item.kind === "series" ? "" : item.ext);
          this.syncListRow();
          this.askPicks();
        },
      },
      { label: rating === 0 ? "Rate it" : "Rated: " + ratingLabel(rating), action: () => this.showRateMenu(item) },
    ];
    if (this.continueItem() === item) {
      buttons.push({
        label: "Remove from Continue Watching",
        action: () => {
          // Taken off early, it counts against what it's like.
          tasteNotForMe(key, item.progress);
          progressRemove(key);
          this.refreshContinueWatching();
          if (this.app.sync) this.app.sync.now();
        },
      });
    }
    buttons.push({ label: "Account", action: () => this.accountMenu() });
    this.app.dialog({ title: item.title, buttons });
  }

  // "Not for me", "I like this" or "Love this!": shapes Top picks, Because you watched and
  // the order of the rows.
  private showRateMenu(item: Item): void {
    const key = titleKey(item);
    const choices: { label: string; rating: Rating }[] = [
      { label: "Not for me", rating: -1 },
      { label: "I like this", rating: 1 },
      { label: "Love this!", rating: 2 },
    ];
    if (tasteRating(key) !== 0) choices.push({ label: "Take my rating away", rating: 0 });
    this.app.dialog({
      title: item.title,
      message: "How was it? Your ratings shape Top picks for you and the rows you see first.",
      buttons: choices.map((c) => ({
        label: c.label,
        action: () => {
          tasteRate(key, item.title, c.rating);
          this.askPicks();
        },
      })),
    });
  }

  // --- Continue Watching --------------------------------------------------------------

  // The focused poster when it's in the Continue Watching row.
  private continueItem(): Item | null {
    if (this.navFocused || this.rowIndex !== 0 || !this.rows[0] || !this.rows[0].isContinue) return null;
    return this.focusedItem();
  }

  private refreshContinueWatching(): void {
    if (this.tab !== 0 || !this.movieCats) return;
    const cw = continueWatchingRow();
    const had = this.rows.length > 0 && this.rows[0].isContinue;
    if (had) this.detachRow(this.rows[0]);
    if (cw && had) {
      this.rows[0].items = cw.items;
      this.rows[0].col = Math.max(0, Math.min(this.rows[0].col, cw.items.length - 1));
    } else if (cw) {
      this.rows.unshift(this.rowState(cw.title, cw.items, true));
      if (this.rows.length > 1) this.rowIndex++;
    } else if (had) {
      this.rows.shift();
      this.rowIndex = Math.max(0, this.rowIndex - 1);
    }
    for (const row of this.rows) this.detachRow(row);
    if (this.rows.length > 0) setText(this.status, "");
    this.renderRows();
    if (!this.navFocused) this.onFocusMoved();
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
        if (this.navCursor === ACCOUNT || TABS[this.navCursor] === "Search" || TABS[this.navCursor] === "Categories") this.focusRows();
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
    // Back from Details or the player: Continue Watching, My List and what you've
    // watched may have changed.
    this.refreshContinueWatching();
    this.syncListRow();
    if (this.picksStamp !== "") this.askPicks();
    this.backdrop.pause(false);
    // Pick up what other devices watched (at most once a minute).
    if (this.app.sync) this.app.sync.soon();
    this.styleNav();
    if (!this.navFocused) this.onFocusMoved();
  }

  onHide(): void {
    this.backdrop.pause(true);
    window.clearTimeout(this.heroTimer);
    window.clearTimeout(this.heroDebounce);
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
  }

  destroy(): void {
    this.onHide();
    this.generation++;
    window.clearTimeout(this.picksTimer);
    if (this.unsubscribeSync) this.unsubscribeSync();
    if (this.unsubscribeLibrary) this.unsubscribeLibrary();
  }

  // For the screenshot script and tests.
  debugState(): { tab: number; rows: number; rowIndex: number; navFocused: boolean } {
    return { tab: this.tab, rows: this.rows.length, rowIndex: this.rowIndex, navFocused: this.navFocused };
  }
}
