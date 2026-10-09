// Soft click sounds (the Roku app's 0.5.5; docs/features.md §10): a glassy tick for
// moving, a little rising pop with a ping for choosing, the pop falling for going back.
// The same files as the Roku's (its tools/make_sounds.py), quiet by design. Played
// through Web Audio, which starts them at once; none while a video plays (Web Audio
// sleeps through it) or the intro runs, and none when turned off in the account menu.
// Moves closer than 60 ms apart (a key held down) tick once.

import backUrl from "../../assets/sounds/back.wav";
import moveUrl from "../../assets/sounds/move.wav";
import selectUrl from "../../assets/sounds/select.wav";
import { log } from "../core/log";
import { loadPrefs } from "../core/storage";

export type SoundName = "move" | "select" | "back";

const FILES: { [name in SoundName]: string } = { move: moveUrl, select: selectUrl, back: backUrl };
const MOVE_GAP_MS = 60;

let ctx: AudioContext | null = null;
const buffers: { [name: string]: AudioBuffer } = {};
let quiet = 0; // things keeping the sounds off for now (a video, the intro)
let lastMove = 0;

export function soundsOn(): boolean {
  return loadPrefs().sounds !== "off";
}

// The app's one AudioContext, made on first use (the intro's sting shares it), or null
// where there's no Web Audio.
export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    ctx = new Context();
  } catch (err) {
    log("sounds: no Web Audio:", String(err));
    ctx = null;
  }
  return ctx;
}

// Loads the three sounds once, at launch.
export function loadSounds(): void {
  const audio = audioContext();
  if (!audio) return;
  for (const name of Object.keys(FILES) as SoundName[]) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", FILES[name]);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      if (!xhr.response) return;
      // The callback form, which every engine has.
      audio.decodeAudioData(
        xhr.response as ArrayBuffer,
        (buffer) => {
          buffers[name] = buffer;
        },
        () => log("sounds: couldn't read", name),
      );
    };
    xhr.send();
  }
}

// Keeps the sounds off while something plays (`on`), and on again after. A video also
// puts Web Audio to sleep (`sleep`), so it doesn't hold the TV's sound output while the
// player opens and plays.
export function hushSounds(on: boolean, sleep = false): void {
  quiet = Math.max(0, quiet + (on ? 1 : -1));
  if (!sleep || !ctx) return;
  try {
    if (on && ctx.state === "running") void ctx.suspend();
    else if (!on && ctx.state === "suspended") void ctx.resume();
  } catch {
    // Asleep or not, never worth an error.
  }
}

export function playSound(name: SoundName): void {
  if (!ctx || quiet > 0 || !buffers[name] || !soundsOn()) return;
  const now = Date.now();
  if (name === "move") {
    if (now - lastMove < MOVE_GAP_MS) return;
    lastMove = now;
  }
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffers[name];
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // A sound is never worth an error.
  }
}
