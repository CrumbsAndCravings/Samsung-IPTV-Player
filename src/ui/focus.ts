// The one keyboard listener. It swallows every key (preventDefault) and hands it to the
// active screen only, following the plan's focus rules (section 4.1):
// - act on OK when the key goes down, but ignore auto-repeat for OK and Back;
// - swallow keys for 150 ms after the active screen changes;
// - key-up is passed on too (seeking holds need it).
// While a text box is being edited, keys belong to the system keyboard, except its
// Done/Cancel keys (and Back), which end the edit.
//
// Each key a screen gets plays its click sound (platform/sound.ts): a tick for the arrows,
// a pop for OK, a falling pop for Back. A guard (the intro) can take every key first.

import { Key, keyOf } from "../platform/keys";
import { playSound } from "../platform/sound";

export interface KeyTarget {
  onKey(key: Key, event: KeyboardEvent): void;
  onKeyUp?(key: Key, event: KeyboardEvent): void;
}

let active: KeyTarget | null = null;
let changedAt = 0;
let guard: ((key: Key) => void) | null = null;

// Every key goes to `take` instead of the screens until it's cleared (null).
export function setKeyGuard(take: ((key: Key) => void) | null): void {
  guard = take;
}

function soundFor(key: Key): void {
  if (key === "up" || key === "down" || key === "left" || key === "right") playSound("move");
  else if (key === "ok") playSound("select");
  else if (key === "back") playSound("back");
}

export function setKeyTarget(target: KeyTarget | null): void {
  active = target;
  changedAt = Date.now();
}

function editingInput(): HTMLInputElement | null {
  const el = document.activeElement;
  return el instanceof HTMLInputElement ? el : null;
}

export function startKeys(): void {
  document.addEventListener(
    "keydown",
    (event) => {
      const key = keyOf(event);
      const input = editingInput();
      if (input) {
        // On a desktop Enter finishes typing; on the TV Enter belongs to the keyboard.
        const desktopDone = !window.tizen && (event.key === "Enter" || event.key === "Escape");
        if (key === "imeDone" || key === "imeCancel" || key === "back" || desktopDone) {
          if (key === "back" && event.key === "Backspace") return; // deleting a character
          event.preventDefault();
          input.blur();
        }
        return;
      }
      event.preventDefault();
      if (guard) {
        if (!event.repeat) guard(key);
        return;
      }
      if (Date.now() - changedAt < 150) return;
      if (event.repeat && (key === "ok" || key === "back")) return;
      if (active) {
        active.onKey(key, event);
        soundFor(key);
      }
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (editingInput()) return;
      event.preventDefault();
      if (guard) return;
      if (active && active.onKeyUp) active.onKeyUp(keyOf(event), event);
    },
    true,
  );
}
