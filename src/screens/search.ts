// Search (plan 7.4; the Roku app's SearchScreen): the keyboard on the left, results on
// the right as a Movies row and a Series row that update as you type. The library
// loads in the background on the first search of a session (data/library.ts), and
// results fill in as it arrives. Right past the keyboard (or Fast forward) reaches the
// results; Left from a row's first poster, Back or Rewind returns to the keyboard.

import type { App, Screen } from "../app";
import type { Item, Row } from "../core/items";
import { libraryStatusText } from "../core/search";
import type { SearchLibrary } from "../data/library";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { applyKey, OnScreenKeyboard } from "../ui/keyboard";
import { isBlocked, posterEl } from "../ui/poster";
import { DetailsScreen } from "./details";

const LIMIT = 40; // per row, as on Roku
const DEBOUNCE_MS = 250;
const COL_W = 210;
const ROW_H = 366;
const FULL_COLS = 5;
const REFRESH_MS = 1500; // how often results catch up while the library loads

// The last search, so coming back to Search picks up where you were.
let lastQuery = "";

interface ResultRow {
  row: Row;
  col: number;
  scroll: number;
  el: HTMLElement;
  strip: HTMLElement;
  posters: { [index: number]: HTMLElement };
}

export class SearchScreen implements Screen {
  readonly el: HTMLElement;
  private keyboard = new OnScreenKeyboard();
  private queryBox: HTMLElement;
  private queryEl: HTMLElement;
  private statusEl: HTMLElement;
  private messageEl: HTMLElement;
  private focusTitle: HTMLElement;
  private track: HTMLElement;

  private query = lastQuery;
  private shownQuery = "";
  private zone: "keyboard" | "results" = "keyboard";
  private rows: ResultRow[] = [];
  private rowIndex = 0;
  private pending = false; // results changed while browsing them
  private debounce = 0;
  private refreshTimer = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private app: App) {
    this.queryEl = h("span", { class: "search-query-text" });
    this.queryBox = h("div", { class: "search-query" }, [this.queryEl, h("span", { class: "search-caret" }), h("span", { class: "search-hint", text: "Movies and series" })]);
    this.statusEl = h("div", { class: "search-status" });
    this.messageEl = h("div", { class: "search-message" });
    this.focusTitle = h("div", { class: "search-focus-title" });
    this.track = h("div", { class: "search-results" });
    this.el = h("div", { class: "screen search" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo home-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "search-heading", text: "Search" }),
      this.queryBox,
      this.keyboard.el,
      this.statusEl,
      this.messageEl,
      this.track,
      this.focusTitle,
    ]);
    this.renderQuery();
  }

  private get library(): SearchLibrary | null {
    return this.app.library;
  }

  // --- Typing and results -------------------------------------------------------------

  private renderQuery(): void {
    setText(this.queryEl, this.query);
    toggle(this.queryBox, "is-empty", this.query === "");
  }

  private typed(): void {
    lastQuery = this.query;
    this.renderQuery();
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.runSearch(), DEBOUNCE_MS);
  }

  private runSearch(): void {
    const library = this.library;
    const q = this.query.trim();
    this.shownQuery = this.query;
    if (!library || q === "") {
      this.showRows([]);
      this.say(q === "" ? "Type a title. Results appear as you type." : "");
      return;
    }
    const rows = library.search(q, LIMIT);
    this.showRows(rows);
    if (rows.length > 0) this.say("");
    else if (library.loading) this.say("No matches for “" + q + "” yet. Still loading your library.");
    else this.say("No matches for “" + q + "”.");
  }

  private say(text: string): void {
    setText(this.messageEl, text);
  }

  // New titles arrived: refresh the results now and then, but never reshuffle the rows
  // while someone is browsing them.
  private onLibraryChange(): void {
    this.renderStatus();
    if (this.refreshTimer || this.query.trim() === "") return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      if (this.zone === "results") this.pending = true;
      else this.runSearch();
    }, REFRESH_MS);
  }

  private renderStatus(): void {
    const library = this.library;
    setText(this.statusEl, library ? libraryStatusText(library.status) : "");
  }

  private showRows(rows: Row[]): void {
    for (const r of this.rows) if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
    this.rows = rows.map((row, i) => {
      const strip = h("div", { class: "row-strip" });
      const el = h("div", { class: "row search-row" }, [h("div", { class: "row-title", text: row.title }), strip]);
      el.style.transform = "translateY(" + i * ROW_H + "px)";
      this.track.appendChild(el);
      return { row, col: 0, scroll: 0, el, strip, posters: {} };
    });
    this.rowIndex = 0;
    this.pending = false;
    this.rows.forEach((r) => this.renderStrip(r, false));
    this.renderFocusTitle();
  }

  // Only the posters near the scroll position are in the page.
  private renderStrip(r: ResultRow, hasFocus: boolean): void {
    if (r.col < r.scroll) r.scroll = r.col;
    if (r.col >= r.scroll + FULL_COLS) r.scroll = r.col - FULL_COLS + 1;
    r.strip.style.transform = "translateX(" + -r.scroll * COL_W + "px)";
    const from = Math.max(0, r.scroll - 1);
    const to = Math.min(r.row.items.length - 1, r.scroll + FULL_COLS + 1);
    for (const key of Object.keys(r.posters)) {
      const i = Number(key);
      if (i < from || i > to) {
        const el = r.posters[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete r.posters[i];
      }
    }
    for (let i = from; i <= to; i++) {
      let el = r.posters[i];
      if (!el) {
        el = posterEl(r.row.items[i]);
        el.style.transform = "translateX(" + i * COL_W + "px)";
        r.strip.appendChild(el);
        r.posters[i] = el;
      }
      toggle(el, "is-focused", hasFocus && i === r.col);
    }
  }

  private focusedItem(): Item | null {
    const r = this.rows[this.rowIndex];
    return r ? r.row.items[r.col] || null : null;
  }

  private renderFocusTitle(): void {
    const item = this.zone === "results" ? this.focusedItem() : null;
    setText(this.focusTitle, item ? item.title + (isBlocked(item) ? "   ·   Won't play on this TV" : "") : "");
  }

  private renderFocus(): void {
    this.keyboard.render(this.zone === "keyboard");
    this.rows.forEach((r, i) => this.renderStrip(r, this.zone === "results" && i === this.rowIndex));
    this.renderFocusTitle();
  }

  // --- Focus --------------------------------------------------------------------------

  private focusKeyboard(): void {
    this.zone = "keyboard";
    if (this.pending) this.runSearch();
    this.renderFocus();
  }

  private focusResults(): void {
    if (this.rows.length === 0) return;
    this.zone = "results";
    this.renderFocus();
  }

  private onKeyboardKey(key: Key, event: KeyboardEvent): void {
    // A USB keyboard plugged into the TV (or a computer's, in the harness), and a
    // remote's number keys: any single character types itself, Backspace deletes.
    const char = event && event.key && event.key.length === 1 ? event.key : "";
    if (char || (event && event.key === "Backspace" && key === "other")) {
      this.query = applyKey(this.query, char === " " ? "space" : char || "delete");
      this.typed();
      return;
    }
    if (key === "up" || key === "down" || key === "left" || key === "right") {
      if (!this.keyboard.move(key) && key === "right") this.focusResults();
      this.renderFocus();
    } else if (key === "ok") {
      // Shift, Caps and the symbols page only change the keyboard.
      const pressed = this.keyboard.press();
      if (pressed !== null) {
        this.query = applyKey(this.query, pressed);
        this.typed();
      }
      this.renderFocus();
    } else if (key === "ff") this.focusResults();
    else if (key === "back") this.app.pop();
  }


  private onResultsKey(key: Key): void {
    const r = this.rows[this.rowIndex];
    if (!r) return this.focusKeyboard();
    if (key === "left") {
      if (r.col === 0) return this.focusKeyboard();
      r.col--;
    } else if (key === "right") {
      if (r.col < r.row.items.length - 1) r.col++;
    } else if (key === "up") {
      if (this.rowIndex > 0) this.rowIndex--;
    } else if (key === "down") {
      if (this.rowIndex < this.rows.length - 1) this.rowIndex++;
    } else if (key === "ok") {
      const item = this.focusedItem();
      if (item) this.app.push(new DetailsScreen(this.app, item));
      return;
    } else if (key === "back" || key === "rew") return this.focusKeyboard();
    else return;
    this.renderFocus();
  }

  onKey(key: Key, event: KeyboardEvent): void {
    if (this.zone === "keyboard") this.onKeyboardKey(key, event);
    else this.onResultsKey(key);
  }

  // --- Screen -------------------------------------------------------------------------

  onShow(): void {
    const library = this.library;
    if (library && !this.unsubscribe) this.unsubscribe = library.onChange(() => this.onLibraryChange());
    if (library) library.start(); // once per session; again after a failure
    this.renderStatus();
    // Back from Details: "Won't play" marks may have changed.
    if (this.shownQuery !== this.query || this.rows.length === 0) this.runSearch();
    else this.rows.forEach((r) => {
      for (const key of Object.keys(r.posters)) {
        const el = r.posters[Number(key)];
        if (el.parentNode) el.parentNode.removeChild(el);
      }
      r.posters = {};
    });
    this.renderFocus();
  }

  destroy(): void {
    window.clearTimeout(this.debounce);
    window.clearTimeout(this.refreshTimer);
    if (this.unsubscribe) this.unsubscribe();
  }
}
