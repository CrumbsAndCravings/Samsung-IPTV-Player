// The Search keyboard (plan section 6.3): a grid of our own rather than the TV's
// keyboard, so results update as you type and focus stays where you expect. Letters
// and digits in six columns, or symbols on a second page; then Shift (the next letter
// only), Caps (stays on) and the page switch; then Space, Delete and Clear.

import { h, toggle } from "./dom";

const LETTERS: string[][] = [
  ["a", "b", "c", "d", "e", "f"],
  ["g", "h", "i", "j", "k", "l"],
  ["m", "n", "o", "p", "q", "r"],
  ["s", "t", "u", "v", "w", "x"],
  ["y", "z", "1", "2", "3", "4"],
  ["5", "6", "7", "8", "9", "0"],
];
const SYMBOLS: string[][] = [
  ["!", "?", "&", "'", '"', "-"],
  [":", ";", ",", ".", "(", ")"],
  ["@", "#", "$", "%", "*", "+"],
  ["/", "\\", "_", "=", "<", ">"],
  ["[", "]", "{", "}", "|", "~"],
  ["^", "`", "€", "£", "°", "¿"],
];
const BOTTOM: string[][] = [
  ["shift", "shift", "caps", "caps", "symbols", "symbols"],
  ["space", "space", "delete", "delete", "clear", "clear"],
];

// The grid's shape: both pages share it, and the wide keys sit at the bottom.
export const KEY_ROWS: string[][] = LETTERS.concat(BOTTOM);
const COLS = 6;
const MAX_LENGTH = 40;

export interface KeyPos {
  row: number;
  col: number;
}

// The first column of the key under `pos` (the bottom keys are two columns wide).
function keyStart(pos: KeyPos): number {
  const id = KEY_ROWS[pos.row][pos.col];
  let col = pos.col;
  while (col > 0 && KEY_ROWS[pos.row][col - 1] === id) col--;
  return col;
}

// Where an arrow goes from `pos`, or null when it leaves the keyboard.
export function moveKey(pos: KeyPos, dir: "up" | "down" | "left" | "right"): KeyPos | null {
  const start = keyStart(pos);
  const id = KEY_ROWS[pos.row][start];
  if (dir === "left") return start > 0 ? { row: pos.row, col: keyStart({ row: pos.row, col: start - 1 }) } : null;
  if (dir === "right") {
    let col = start;
    while (col < COLS && KEY_ROWS[pos.row][col] === id) col++;
    return col < COLS ? { row: pos.row, col } : null;
  }
  const row = pos.row + (dir === "down" ? 1 : -1);
  if (row < 0 || row >= KEY_ROWS.length) return null;
  const col = keyStart({ row, col: pos.col });
  return { row, col };
}

// What a key does to the text: "space", "delete", "clear", or a character to add.
export function applyKey(text: string, key: string): string {
  if (key === "delete") return text.slice(0, -1);
  if (key === "clear") return "";
  if (text.length >= MAX_LENGTH) return text;
  if (key === "space") return text === "" || text.slice(-1) === " " ? text : text + " ";
  return text + key;
}

// Which page shows, Shift and Caps, and what pressing OK types. No DOM, so it's tested.
export class KeyboardState {
  pos: KeyPos = { row: 0, col: 0 };
  shift = false; // the next letter only
  caps = false; // every letter until turned off
  symbols = false; // the symbols page

  // The key at a grid position on the page showing now.
  keyAt(pos: KeyPos): string {
    const page = this.symbols ? SYMBOLS : LETTERS;
    return pos.row < page.length ? page[pos.row][pos.col] : BOTTOM[pos.row - page.length][pos.col];
  }

  get current(): string {
    return this.keyAt(this.pos);
  }

  label(key: string): string {
    if (key === "shift") return "Shift";
    if (key === "caps") return "Caps";
    if (key === "symbols") return this.symbols ? "abc" : "#+=";
    if (key === "space") return "Space";
    if (key === "delete") return "Delete";
    if (key === "clear") return "Clear";
    return this.upper ? key.toUpperCase() : key;
  }

  private get upper(): boolean {
    return !this.symbols && (this.shift || this.caps);
  }

  move(dir: "up" | "down" | "left" | "right"): boolean {
    const next = moveKey(this.pos, dir);
    if (!next) return false;
    this.pos = next;
    return true;
  }

  // OK on the focused key: what to pass to applyKey, or null for Shift, Caps and the
  // page switch, which only change the keyboard.
  press(): string | null {
    const key = this.current;
    if (key === "shift") {
      this.shift = !this.shift;
      return null;
    }
    if (key === "caps") {
      this.caps = !this.caps;
      this.shift = false;
      return null;
    }
    if (key === "symbols") {
      this.symbols = !this.symbols;
      return null;
    }
    if (key.length > 1) return key; // space, delete, clear
    const typed = this.upper ? key.toUpperCase() : key;
    if (/[a-z]/.test(key) && !this.symbols) this.shift = false;
    return typed;
  }
}

export class OnScreenKeyboard {
  readonly el: HTMLElement;
  readonly state = new KeyboardState();
  private keys: { [key: string]: HTMLElement } = {};

  constructor() {
    const els: HTMLElement[] = [];
    KEY_ROWS.forEach((row, r) => {
      row.forEach((id, c) => {
        if (c > 0 && row[c - 1] === id) return;
        const el = h("div", { class: "key" + (id.length > 1 ? " key-wide" : "") });
        el.style.left = c * 97 + "px";
        el.style.top = r * 85 + "px";
        this.keys[r + ":" + c] = el;
        els.push(el);
      });
    });
    this.el = h("div", { class: "keyboard" }, els);
    this.render(false);
  }

  get current(): string {
    return this.state.current;
  }

  move(dir: "up" | "down" | "left" | "right"): boolean {
    return this.state.move(dir);
  }

  press(): string | null {
    return this.state.press();
  }

  render(focused: boolean): void {
    const s = this.state;
    for (const at of Object.keys(this.keys)) {
      const [row, col] = at.split(":").map(Number);
      const key = s.keyAt({ row, col });
      const el = this.keys[at];
      const label = s.label(key);
      if (el.textContent !== label) el.textContent = label;
      toggle(el, "is-focused", focused && row === s.pos.row && col === s.pos.col);
      toggle(el, "is-on", (key === "shift" && s.shift) || (key === "caps" && s.caps) || (key === "symbols" && s.symbols));
    }
  }
}
