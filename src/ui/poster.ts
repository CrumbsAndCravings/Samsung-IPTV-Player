// A poster tile for the rows: rounded, grows with a lavender ring when focused, a pink
// progress bar for Continue Watching, "S1:E4" under series in progress, dimmed with a
// butter "Won't play" tag when this TV can't play it, and a soft pulse while loading.

import { playCheck } from "../core/compat";
import type { Item } from "../core/items";
import { h } from "./dom";

export const POSTER_W = 180;
export const POSTER_H = 270;

export function itemKey(item: Item): string {
  return (item.kind === "episode" ? "e:" : "m:") + item.itemId;
}

// Movies can be judged from the list; series only once their episodes are known.
export function isBlocked(item: Item): boolean {
  if (item.kind === "series" || item.placeholder) return false;
  return playCheck({ key: itemKey(item), ext: item.ext, videoCodec: item.videoCodec, videoProfile: item.videoProfile, audioCodec: item.audioCodec }).verdict === "blocked";
}

export function posterEl(item: Item): HTMLElement {
  if (item.placeholder) {
    return h("div", { class: "poster is-placeholder" }, [h("div", { class: "poster-frame" }, [h("div", { class: "poster-card" })])]);
  }
  const blocked = isBlocked(item);
  const img = h("img", { class: "poster-img", attrs: { alt: "" } });
  if (item.poster) {
    img.onerror = () => img.parentNode && img.parentNode.removeChild(img);
    img.src = item.poster;
  }
  const card = h("div", { class: "poster-card" }, [h("div", { class: "poster-fallback", text: item.title }), item.poster ? img : null]);
  if (item.progress > 0) {
    card.appendChild(h("div", { class: "poster-progress" }, [h("div", { class: "poster-fill", attrs: { style: "width:" + Math.round(item.progress * 100) + "%" } })]));
  }
  const caption = blocked ? "Won't play" : item.caption;
  return h("div", { class: "poster" + (blocked ? " is-blocked" : "") }, [
    h("div", { class: "poster-frame" }, [card, h("div", { class: "poster-ring" })]),
    caption ? h("div", { class: "poster-caption", text: caption }) : null,
  ]);
}
