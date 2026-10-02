// The Categories tab (the Roku app's CategoriesScreen, docs/features.md §5.2): every
// category in your languages as cards, in rows. New releases first, then for each
// language in the order you chose its movies and its series, or one row for both when
// a language has 8 categories or fewer. A card shows its tidy name and how many titles
// it holds ("Movies · 104", from the stored library, so just "Movies" until that has
// loaded); OK opens the category's page.

import type { App, Screen } from "../app";
import { LANGUAGE_NAMES, OrganizedCategory, takeTurns } from "../core/categories";
import { languagePrefs } from "../core/personal";
import { commas } from "../core/utils";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { CategoryScreen } from "./category";

const TILE_COL = 330; // a 315 px card and the gap
const ROW_H = 228;
const FULL_COLS = 5;
const VISIBLE_ROWS = 4;
const COUNTS_MS = 3000; // how often card counts catch up while the library loads

type Kind = "movie" | "series";

interface Tile {
  kind: Kind;
  id: string;
  label: string;
}

interface CardRow {
  title: string;
  tiles: Tile[];
  col: number;
  scroll: number;
  el: HTMLElement | null;
  strip: HTMLElement | null;
  cards: { [index: number]: HTMLElement };
}

function languageName(lang: string): string {
  return LANGUAGE_NAMES[lang] || lang.toUpperCase();
}

// The rows, from the organized category lists Home already has.
export function categoryRows(movies: OrganizedCategory[], series: OrganizedCategory[], langs: string[]): { title: string; tiles: Tile[] }[] {
  const tile = (c: OrganizedCategory, kind: Kind): Tile => ({ kind, id: c.id, label: c.label });
  const rows: { title: string; tiles: Tile[] }[] = [];
  const add = (title: string, tiles: Tile[]) => {
    if (tiles.length > 0) rows.push({ title, tiles });
  };
  add(
    "New releases",
    takeTurns(
      movies.filter((c) => c.isNew).map((c) => tile(c, "movie")),
      series.filter((c) => c.isNew).map((c) => tile(c, "series")),
    ),
  );
  const order: string[] = langs.map((l) => l.toLowerCase());
  for (const lang of ["en", "hi", "pa", "other"]) if (order.indexOf(lang) < 0) order.push(lang);
  // Categories that don't say count as your first language.
  const first = order.length > 0 ? order[0] : "";
  const byLanguage = (list: OrganizedCategory[], kind: Kind, lang: string) => list.filter((c) => !c.isNew && (c.lang || first) === lang).map((c) => tile(c, kind));
  for (const lang of order) {
    const m = byLanguage(movies, "movie", lang);
    const s = byLanguage(series, "series", lang);
    if (m.length + s.length <= 8) add(languageName(lang), m.concat(s));
    else {
      add(languageName(lang) + " movies", m);
      add(languageName(lang) + " series", s);
    }
  }
  return rows;
}

export class CategoriesScreen implements Screen {
  readonly el: HTMLElement;
  private track: HTMLElement;
  private rows: CardRow[];
  private rowIndex = 0;
  private counts: { [key: string]: number } = {};
  private countsTimer = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private app: App,
    movies: OrganizedCategory[],
    series: OrganizedCategory[],
  ) {
    this.rows = categoryRows(movies, series, languagePrefs()).map((r) => ({ title: r.title, tiles: r.tiles, col: 0, scroll: 0, el: null, strip: null, cards: {} }));
    this.track = h("div", { class: "rows-track categories-track" });
    const total = movies.length + series.length;
    this.el = h("div", { class: "screen categories" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo home-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "page-heading", text: "Categories" }),
      h("div", { class: "page-subheading", text: total > 0 ? commas(total) + " categories in your languages. OK opens one." : "Your provider didn't list any categories in your languages." }),
      h("div", { class: "categories-viewport" }, [this.track]),
    ]);
    this.readCounts();
    this.render();
  }

  private readCounts(): void {
    if (this.app.library) this.counts = this.app.library.counts();
  }

  private caption(t: Tile): string {
    const kindName = t.kind === "series" ? "Series" : "Movies";
    const count = this.counts[t.kind + ":" + t.id];
    return count > 0 ? kindName + " · " + commas(count) : kindName;
  }

  private card(t: Tile): HTMLElement {
    return h("div", { class: "category-card" }, [h("div", { class: "category-card-name", text: t.label }), h("div", { class: "category-card-caption", text: this.caption(t) })]);
  }

  private detach(row: CardRow): void {
    if (row.el && row.el.parentNode) row.el.parentNode.removeChild(row.el);
    row.el = null;
    row.strip = null;
    row.cards = {};
  }

  // Only the rows and cards near the focus are in the page.
  private render(): void {
    const top = Math.max(0, Math.min(this.rowIndex - 1, this.rows.length - VISIBLE_ROWS));
    this.track.style.transform = "translateY(" + -top * ROW_H + "px)";
    this.rows.forEach((row, i) => {
      if (i < top - 1 || i > top + VISIBLE_ROWS) return this.detach(row);
      if (!row.el) {
        row.strip = h("div", { class: "row-strip" });
        row.el = h("div", { class: "row category-row" }, [h("div", { class: "row-title", text: row.title }), row.strip]);
        row.el.style.transform = "translateY(" + i * ROW_H + "px)";
        this.track.appendChild(row.el);
      }
      this.renderStrip(row, i === this.rowIndex);
    });
  }

  private renderStrip(row: CardRow, hasFocus: boolean): void {
    if (!row.strip) return;
    if (row.col < row.scroll) row.scroll = row.col;
    if (row.col >= row.scroll + FULL_COLS) row.scroll = row.col - FULL_COLS + 1;
    row.strip.style.transform = "translateX(" + -row.scroll * TILE_COL + "px)";
    const from = Math.max(0, row.scroll - 1);
    const to = Math.min(row.tiles.length - 1, row.scroll + FULL_COLS + 1);
    for (const key of Object.keys(row.cards)) {
      const i = Number(key);
      if (i < from || i > to) {
        const el = row.cards[i];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete row.cards[i];
      }
    }
    for (let i = from; i <= to; i++) {
      let el = row.cards[i];
      if (!el) {
        el = this.card(row.tiles[i]);
        el.style.transform = "translateX(" + i * TILE_COL + "px)";
        row.strip.appendChild(el);
        row.cards[i] = el;
      }
      toggle(el, "is-focused", hasFocus && i === row.col);
    }
  }

  // The library grew: refresh the counts on the cards in view, now and then.
  private onLibraryChange(): void {
    if (this.countsTimer) return;
    this.countsTimer = window.setTimeout(() => {
      this.countsTimer = 0;
      this.readCounts();
      for (const row of this.rows) {
        for (const key of Object.keys(row.cards)) {
          const caption = row.cards[Number(key)].lastChild as HTMLElement;
          setText(caption, this.caption(row.tiles[Number(key)]));
        }
      }
    }, COUNTS_MS);
  }

  onKey(key: Key): void {
    const row = this.rows[this.rowIndex];
    if (key === "back") return this.app.pop();
    if (!row) return;
    if (key === "left" && row.col > 0) row.col--;
    else if (key === "right" && row.col < row.tiles.length - 1) row.col++;
    else if (key === "up" && this.rowIndex > 0) this.rowIndex--;
    else if (key === "down" && this.rowIndex < this.rows.length - 1) this.rowIndex++;
    else if (key === "ok") {
      const t = row.tiles[row.col];
      if (t) this.app.push(new CategoryScreen(this.app, { kind: t.kind, categoryId: t.id, title: t.label + "  ·  " + (t.kind === "series" ? "Series" : "Movies") }));
      return;
    } else return;
    this.render();
  }

  onShow(): void {
    const library = this.app.library;
    if (library && !this.unsubscribe) this.unsubscribe = library.onChange(() => this.onLibraryChange());
    // Title counts come from the stored library.
    if (library) library.start();
    this.readCounts();
    for (const row of this.rows) this.detach(row);
    this.render();
  }

  destroy(): void {
    window.clearTimeout(this.countsTimer);
    if (this.unsubscribe) this.unsubscribe();
  }
}
