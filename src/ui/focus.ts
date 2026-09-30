// The one keyboard listener. It swallows every key (preventDefault) and hands it to the
// active screen only, following the plan's focus rules (section 4.1):
// - act on OK when the key goes down, but ignore auto-repeat for OK and Back;
// - swallow keys for 150 ms after the active screen changes;
// - key-up is passed on too (seeking holds need it).
// While a text box is being edited, keys belong to the system keyboard, except its
// Done/Cancel keys (and Back), which end the edit.

import { Key, keyOf } from "../platform/keys";

export interface KeyTarget {
  onKey(key: Key, event: KeyboardEvent): void;
  onKeyUp?(key: Key, event: KeyboardEvent): void;
}

let active: KeyTarget | null = null;
let changedAt = 0;

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
      if (Date.now() - changedAt < 150) return;
      if (event.repeat && (key === "ok" || key === "back")) return;
      if (active) active.onKey(key, event);
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (editingInput()) return;
      event.preventDefault();
      if (active && active.onKeyUp) active.onKeyUp(keyOf(event), event);
    },
    true,
  );
}
