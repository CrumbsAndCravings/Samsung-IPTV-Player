// The Search keyboard (plan section 6.3): a grid of our own rather than the TV's
// keyboard, so results update as you type and focus stays where you expect. a to z and
// 0 to 9 in six columns, then Space, Delete and Clear across the bottom.

import { h, toggle } from "./dom";

export const KEY_ROWS: string[][] = [
  ["a", "b", "c", "d", "e", "f"],
  ["g", "h", "i", "j", "k", "l"],
  ["m", "n", "o", "p", "q", "r"],
  ["s", "t", "u", "v", "w", "x"],
  ["y", "z", "1", "2", "3", "4"],
  ["5", "6", "7", "8", "9", "0"],
  ["space", "space", "delete", "delete", "clear", "clear"],
];
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

// What pressing a key does to the text.
export function applyKey(text: string, id: string): string {
  if (id === "delete") return text.slice(0, -1);
  if (id === "clear") return "";
  if (text.length >= MAX_LENGTH) return text;
  if (id === "space") return text === "" || text.slice(-1) === " " ? text : text + " ";
  return text + id;
}

const LABELS: { [id: string]: string } = { space: "Space", delete: "Delete", clear: "Clear" };

export class OnScreenKeyboard {
  readonly el: HTMLElement;
  private keys: { [key: string]: HTMLElement } = {};
  pos: KeyPos = { row: 0, col: 0 };

  constructor() {
    const els: HTMLElement[] = [];
    KEY_ROWS.forEach((row, r) => {
      row.forEach((id, c) => {
        if (c > 0 && row[c - 1] === id) return;
        const wide = id.length > 1;
        const el = h("div", { class: "key" + (wide ? " key-wide" : ""), text: LABELS[id] || id });
        el.style.left = c * 97 + "px";
        el.style.top = r * 85 + "px";
        this.keys[r + ":" + c] = el;
        els.push(el);
      });
    });
    this.el = h("div", { class: "keyboard" }, els);
  }

  get current(): string {
    return KEY_ROWS[this.pos.row][this.pos.col];
  }

  // Moves the focus; false when the arrow leaves the keyboard.
  move(dir: "up" | "down" | "left" | "right"): boolean {
    const next = moveKey(this.pos, dir);
    if (!next) return false;
    this.pos = next;
    return true;
  }

  render(focused: boolean): void {
    for (const key of Object.keys(this.keys)) toggle(this.keys[key], "is-focused", focused && key === this.pos.row + ":" + this.pos.col);
  }
}
