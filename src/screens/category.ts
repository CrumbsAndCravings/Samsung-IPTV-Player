// A category's page, "See all" (the Roku app's CategoryScreen, docs/features.md §5.3):
// every title in one category, newest first, from the stored library, so nothing is
// asked of the provider. A grid 9 across and 3 down, capped at the newest 1,000 with
// the count line saying so.
//
// "Search this category" sits at the top right, reached with Up from the first row. It
// opens the app's own keyboard over the left of the page, and the grid behind narrows
// as you type, with the same matching as Search. Done (or Back) keeps the results;
// Back from the grid clears a search before leaving. While the library is still
// loading, the page says so and asks again every 5 s as it grows.

import type { App, Screen } from "../app";
import type { Item } from "../core/items";
import { commas } from "../core/utils";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { applyKey, OnScreenKeyboard } from "../ui/keyboard";
import { COL_W, isBlocked, posterEl, POSTER_H, POSTER_GAP } from "../ui/poster";
import { DetailsScreen } from "./details";

export interface CategoryRef {
  kind: "movie" | "series";
  categoryId: string;
  title: string;
}

const COLS = 9;
const VISIBLE_ROWS = 3;
const ROW_H = POSTER_H + POSTER_GAP;
const LIMIT = 1000;
const DEBOUNCE_MS = 350;
const ASK_AGAIN_MS = 5000;

type Zone = "grid" | "search" | "keyboard" | "done";

export class CategoryScreen implements Screen {
  readonly el: HTMLElement;
  private countEl: HTMLElement;
  private focusTitle: HTMLElement;
  private messageEl: HTMLElement;
  private searchButton: HTMLElement;
  private grid: HTMLElement;
  private overlay: HTMLElement;
  private queryEl: HTMLElement;
  private doneEl: HTMLElement;
  private keyboard = new OnScreenKeyboard();

  private items: Item[] = [];
  private index = 0;
  private top = 0; // first row in view
  private posters: { [index: number]: HTMLElement } = {};
  private zone: Zone = "grid";
  private query = "";
  private typing = ""; // in the keyboard, not yet searched
  private allCount = -1;
  private loading = false;
  private lastAsked = 0;
  private debounce = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private app: App,
    private category: CategoryRef,
  ) {
    this.countEl = h("div", { class: "page-subheading" });
    this.focusTitle = h("div", { class: "category-focus-title" });
    this.messageEl = h("div", { class: "category-message", text: "Gathering titles…" });
    this.searchButton = h("div", { class: "pill category-search" });
    this.grid = h("div", { class: "category-grid" });
    this.queryEl = h("span", { class: "search-query-text" });
    this.doneEl = h("div", { class: "pill category-done", text: "Done" });
    this.overlay = h("div", { class: "category-keyboard is-hidden" }, [
      h("div", { class: "category-keyboard-heading", text: "Search " + category.title }),
      h("div", { class: "search-query" }, [this.queryEl, h("span", { class: "search-caret" })]),
      this.keyboard.el,
      this.doneEl,
    ]);
    this.el = h("div", { class: "screen category" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo home-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "page-heading category-heading", text: category.title }),
      this.countEl,
      this.searchButton,
      this.focusTitle,
      h("div", { class: "category-viewport" }, [this.grid]),
      this.messageEl,
      this.overlay,
    ]);
    this.styleSearch();
  }

  // --- Asking the library ---------------------------------------------------------------

  private ask(): void {
    const library = this.app.library;
    if (!library) return;
    this.lastAsked = Date.now();
    const found = library.browse(this.category.kind, this.category.categoryId, LIMIT, this.query);
    this.loading = found.loading;
    if (this.query === "") this.allCount = found.total;
    this.show(found.items, found.total);
  }

  private show(items: Item[], total: number): void {
    const focusedId = this.items[this.index] ? this.items[this.index].itemId : "";
    this.items = items;
    for (const key of Object.keys(this.posters)) {
      const el = this.posters[Number(key)];
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this.posters = {};
    // Keep the focus on the same title when the list grows behind it.
    const kept = focusedId ? items.findIndex((i) => i.itemId === focusedId) : -1;
    this.index = kept >= 0 ? kept : 0;
    if (kept < 0) this.top = 0;
    this.styleSearch();
    if (items.length === 0) {
      if (this.query !== "") setText(this.messageEl, "Nothing here matches “" + this.query + "”. Back clears the search.");
      else if (this.loading) setText(this.messageEl, "Your library is still loading. This category's titles will appear here as they arrive.");
      else setText(this.messageEl, "Nothing in this category yet.");
      setText(this.countEl, "");
      if (this.zone === "grid") this.zone = "search";
      this.styleSearch();
      this.renderGrid();
      return;
    }
    setText(this.messageEl, "");
    let text: string;
    if (this.query !== "") {
      text = commas(total) + " matching “" + this.query + "”";
      if (this.allCount >= 0) text += " of " + commas(this.allCount);
    } else {
      text = commas(total) + (total === 1 ? " title" : " titles") + ", newest first";
      if (items.length < total) text = "The newest " + commas(items.length) + " of " + commas(total) + " titles";
    }
    if (this.loading) text += ". Still loading your library.";
    setText(this.countEl, text);
    this.renderGrid();
  }

  // Asks again now and then while the library is still arriving.
  private onLibraryChange(): void {
    if (this.loading && Date.now() - this.lastAsked >= ASK_AGAIN_MS) this.ask();
  }

  // --- Grid ---------------------------------------------------------------------------

  private renderGrid(): void {
    const row = Math.floor(this.index / COLS);
    if (row < this.top) this.top = row;
    if (row >= this.top + VISIBLE_ROWS) this.top = row - VISIBLE_ROWS + 1;
    this.grid.style.transform = "translateY(" + -this.top * ROW_H + "px)";
    const from = Math.max(0, (this.top - 1) * COLS);
    const to = Math.min(this.items.length - 1, (this.top + VISIBLE_ROWS + 1) * COLS - 1);
    for (const key of Object.keys(this.posters)) {
      const i = Number(key);
      if (i < from || i > to) {
        const el = this.posters[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete this.posters[i];
      }
    }
    for (let i = from; i <= to; i++) {
      let el = this.posters[i];
      if (!el) {
        el = posterEl(this.items[i]);
        el.style.transform = "translate(" + (i % COLS) * COL_W + "px, " + Math.floor(i / COLS) * ROW_H + "px)";
        this.grid.appendChild(el);
        this.posters[i] = el;
      }
      toggle(el, "is-focused", this.zone === "grid" && i === this.index);
    }
    const item = this.zone === "grid" ? this.items[this.index] : null;
    const parts = item ? [item.title] : [];
    if (item && item.year) parts.push(item.year);
    if (item && isBlocked(item)) parts.push("Won't play on this TV");
    setText(this.focusTitle, parts.join("   ·   "));
  }

  private styleSearch(): void {
    const shown = this.query.length > 16 ? this.query.slice(0, 15) + "…" : this.query;
    setText(this.searchButton, this.query === "" ? "Search this category" : "“" + shown + "”  ·  Change");
    toggle(this.searchButton, "is-focused", this.zone === "search");
    toggle(this.overlay, "is-hidden", this.zone !== "keyboard" && this.zone !== "done");
    toggle(this.doneEl, "is-focused", this.zone === "done");
    this.keyboard.render(this.zone === "keyboard");
    setText(this.queryEl, this.typing);
  }

  // --- Search -------------------------------------------------------------------------

  private openKeyboard(): void {
    this.zone = "keyboard";
    this.typing = this.query;
    this.styleSearch();
    this.renderGrid();
  }

  private closeKeyboard(): void {
    window.clearTimeout(this.debounce);
    this.setQuery(this.typing);
    this.zone = this.items.length > 0 ? "grid" : "search";
    this.styleSearch();
    this.renderGrid();
  }

  private typed(): void {
    this.styleSearch();
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.setQuery(this.typing), DEBOUNCE_MS);
  }

  private setQuery(text: string): void {
    const query = text.trim();
    if (query === this.query) return;
    this.query = query;
    this.index = 0;
    this.top = 0;
    this.items = [];
    this.ask();
  }

  // --- Keys ---------------------------------------------------------------------------

  onKey(key: Key, event: KeyboardEvent): void {
    if (this.zone === "keyboard") return this.onKeyboardKey(key, event);
    if (this.zone === "done") {
      if (key === "ok" || key === "back") this.closeKeyboard();
      else if (key === "up") {
        this.zone = "keyboard";
        this.styleSearch();
      }
      return;
    }
    if (this.zone === "search") {
      if (key === "ok") this.openKeyboard();
      else if (key === "down" && this.items.length > 0) {
        this.zone = "grid";
        this.styleSearch();
        this.renderGrid();
      } else if (key === "back") {
        if (this.query !== "") this.setQuery("");
        else this.app.pop();
      }
      return;
    }
    const col = this.index % COLS;
    if (key === "left" && col > 0) this.index--;
    else if (key === "right" && col < COLS - 1 && this.index < this.items.length - 1) this.index++;
    else if (key === "down" && this.index + COLS < this.items.length) this.index += COLS;
    else if (key === "down" && Math.floor(this.index / COLS) < Math.floor((this.items.length - 1) / COLS)) this.index = this.items.length - 1;
    else if (key === "up") {
      if (this.index >= COLS) this.index -= COLS;
      else {
        this.zone = "search";
        this.styleSearch();
      }
    } else if (key === "ok" || key === "play") {
      const item = this.items[this.index];
      if (item) this.app.push(new DetailsScreen(this.app, item));
      return;
    } else if (key === "back") {
      if (this.query !== "") this.setQuery("");
      else this.app.pop();
      return;
    } else return;
    this.renderGrid();
  }

  private onKeyboardKey(key: Key, event: KeyboardEvent): void {
    // A USB keyboard, or the computer's in the harness, types directly.
    const char = event && event.key && event.key.length === 1 ? event.key : "";
    if (char || (event && event.key === "Backspace" && key === "other")) {
      this.typing = applyKey(this.typing, char === " " ? "space" : char || "delete");
      return this.typed();
    }
    if (key === "up" || key === "down" || key === "left" || key === "right") {
      if (!this.keyboard.move(key) && key === "down") this.zone = "done";
      this.styleSearch();
    } else if (key === "ok") {
      const pressed = this.keyboard.press();
      if (pressed !== null) {
        this.typing = applyKey(this.typing, pressed);
        this.typed();
      } else this.styleSearch();
    } else if (key === "back") this.closeKeyboard();
  }

  // --- Screen -------------------------------------------------------------------------

  onShow(): void {
    const library = this.app.library;
    if (library && !this.unsubscribe) this.unsubscribe = library.onChange(() => this.onLibraryChange());
    if (library) library.start();
    // Back from Details: "Won't play" marks may have changed.
    for (const key of Object.keys(this.posters)) {
      const el = this.posters[Number(key)];
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this.posters = {};
    this.ask();
  }

  destroy(): void {
    window.clearTimeout(this.debounce);
    if (this.unsubscribe) this.unsubscribe();
  }
}
