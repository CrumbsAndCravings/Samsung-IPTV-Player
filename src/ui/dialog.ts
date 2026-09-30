// A small modal: title, optional message, and a row of pill buttons. Left/Right move,
// OK chooses, Back cancels. It takes the keys while open and hands them back after.

import type { Key } from "../platform/keys";
import { h } from "./dom";
import { KeyTarget, setKeyTarget } from "./focus";

export interface DialogButton {
  label: string;
  action?: () => void;
}

export interface DialogOptions {
  title: string;
  message?: string;
  buttons: DialogButton[];
  focus?: number; // index of the button focused first
  onCancel?: () => void; // Back
}

export class Dialog implements KeyTarget {
  private root: HTMLElement;
  private pills: HTMLElement[];
  private index: number;
  private previous: KeyTarget | null;

  constructor(
    private host: HTMLElement,
    private options: DialogOptions,
    previous: KeyTarget | null,
  ) {
    this.previous = previous;
    this.index = options.focus || 0;
    this.pills = options.buttons.map((b) => h("div", { class: "pill", text: b.label }));
    this.root = h("div", { class: "dialog-scrim" }, [
      h("div", { class: "dialog" + (options.message ? " dialog-wide" : "") }, [
        h("div", { class: "dialog-title", text: options.title }),
        options.message ? h("p", { class: "dialog-message", text: options.message }) : null,
        h("div", { class: "dialog-buttons" }, this.pills),
      ]),
    ]);
  }

  open(): void {
    this.host.appendChild(this.root);
    this.style();
    setKeyTarget(this);
  }

  private close(): void {
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    setKeyTarget(this.previous);
  }

  private style(): void {
    this.pills.forEach((pill, i) => pill.classList.toggle("is-focused", i === this.index));
  }

  onKey(key: Key): void {
    if (key === "left" && this.index > 0) this.index--;
    else if (key === "right" && this.index < this.pills.length - 1) this.index++;
    else if (key === "ok") {
      const button = this.options.buttons[this.index];
      this.close();
      if (button.action) button.action();
      return;
    } else if (key === "back") {
      this.close();
      if (this.options.onCancel) this.options.onCancel();
      return;
    }
    this.style();
  }
}
