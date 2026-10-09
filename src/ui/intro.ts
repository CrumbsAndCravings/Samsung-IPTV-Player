// The intro when ARAN+ opens (the Roku app's 0.5.5, after the iPhone app's src/ui/intro.ts),
// with its sting (sting.ts): a soft knock and the plus pulses; a boom and ARAN punches in
// out of a glow, light rays bursting out behind it; the plus spins and sparks with two
// pings; then, once the first screen has something to show (it loads underneath
// meanwhile), the intro flies through the plus into it, with a whoosh. About 2.5 s. Any
// key skips it; the account menu turns it off. While it plays it keeps the keys.

import { loadPrefs } from "../core/storage";
import { audioContext, hushSounds } from "../platform/sound";
import { h } from "./dom";
import { setKeyGuard } from "./focus";
import { playSting, playWhoosh } from "./sting";

export function introOn(): boolean {
  return loadPrefs().intro !== "off";
}

// The entrance (knock, boom, pings) takes this long; then the intro waits for the app,
// at most HOLD_MS more, and flies in (LEAVE_MS).
const ENTRANCE_MS = 1550;
const HOLD_MS = 4000;
const LEAVE_MS = 900;
const RAY_COLORS = ["#b9a3ff", "#ff9ecf", "#ffd98a", "#ffffff"];
const RAYS = 16;
const SPARKS = 6;

let appReady = false;
let onAppReady: (() => void) | null = null;

// The first screen has something to show (Home's rows, or the sign-in form): the intro
// may fly into it.
export function introReady(): void {
  if (appReady) return;
  appReady = true;
  if (onAppReady) onAppReady();
}

// Plays the intro over the app as it opens, unless it's turned off.
export function showIntro(host: HTMLElement): void {
  if (!introOn()) return;
  const letters = "ARAN".split("").map((letter, i) => h("span", { class: "intro-letter", text: letter, attrs: { style: "animation-delay:" + (500 + i * 32) + "ms" } }));
  const sparks: HTMLElement[] = [];
  for (let i = 0; i < SPARKS; i++) {
    // Each spark flies out along its own arm, so no keyframes need its angle.
    const spark = h("span", { class: "intro-spark", attrs: { style: "animation-delay:" + (680 + (i % 2) * 140) + "ms" } });
    sparks.push(h("span", { class: "intro-spark-arm", attrs: { style: "transform:rotate(" + Math.round((360 / SPARKS) * i + 15) + "deg)" } }, [spark]));
  }
  // Drawn, not typed: a drawn plus's middle is exactly the middle of its box, which the
  // flight through it centres on.
  const plus = h("span", { class: "intro-plus" }, [h("span", { class: "intro-plus-mark" }), ...sparks]);
  const logo = h("div", { class: "intro-logo" }, [...letters, plus]);
  const rays: HTMLElement[] = [];
  for (let i = 0; i < RAYS; i++) {
    const angle = Math.round((360 / RAYS) * i + (i % 2) * 7);
    const color = RAY_COLORS[i % RAY_COLORS.length];
    const ray = h("span", {
      class: "intro-ray",
      attrs: { style: "background:linear-gradient(90deg, rgba(255,255,255,0), " + color + " 30%, rgba(255,255,255,0));animation-delay:" + (500 + (i % 3) * 40) + "ms" },
    });
    rays.push(h("span", { class: "intro-ray-arm", attrs: { style: "transform:rotate(" + angle + "deg)" } }, [ray]));
  }
  const el = h("div", { class: "intro" }, [h("div", { class: "intro-glow" }), h("div", { class: "intro-rays" }, rays), logo]);
  host.appendChild(el);

  hushSounds(true);
  const ctx = audioContext();
  if (ctx) {
    try {
      if (ctx.state === "suspended") void ctx.resume();
      playSting(ctx);
    } catch {
      // The intro plays on without its sound.
    }
  }
  // Flying through the plus: the zoom centres on it.
  const box = logo.getBoundingClientRect();
  const mark = plus.getBoundingClientRect();
  if (box.width > 0) logo.style.transformOrigin = Math.round(mark.left + mark.width / 2 - box.left) + "px " + Math.round(mark.top + mark.height / 2 - box.top) + "px";
  el.classList.add("is-playing");

  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    onAppReady = null;
    setKeyGuard(null);
    if (ctx) {
      try {
        playWhoosh(ctx);
      } catch {
        // No whoosh, then.
      }
    }
    el.classList.add("is-leaving");
    window.setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      hushSounds(false);
    }, LEAVE_MS);
  };
  // Any key skips it.
  setKeyGuard(() => leave());
  // After the entrance: in as soon as the app is ready, or after HOLD_MS regardless.
  window.setTimeout(() => {
    if (appReady) return leave();
    onAppReady = leave;
    window.setTimeout(leave, HOLD_MS);
  }, ENTRANCE_MS);
}
