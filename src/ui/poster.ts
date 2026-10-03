// A poster tile for rows, grids and search: sharp corners, a 6% lift and a lavender ring
// when focused, a pink progress strip along the bottom edge for Continue Watching, and
// badges ("S1:E4", "Won't play") on a dark band at the bottom of the poster, so rows
// need no caption space. Titles this TV can't play are dimmed, and placeholders pulse
// while a row loads. Category and See all cards are the name on a tinted card.

import { playCheck } from "../core/compat";
import { helperOn } from "../core/personal";
import type { Item } from "../core/items";
import { h } from "./dom";

export const POSTER_W = 180;
export const POSTER_H = 270;
export const POSTER_GAP = 15; // the Roku app's 10 px, at 1080p
export const COL_W = POSTER_W + POSTER_GAP;

export function itemKey(item: Item): string {
  return (item.kind === "episode" ? "e:" : "m:") + item.itemId;
}

// Movies can be judged from the list; series only once their episodes are known. With
// the helper on your computer, everything plays (it converts what the TV can't).
export function isBlocked(item: Item): boolean {
  if (item.kind !== "movie" && item.kind !== "episode") return false;
  if (item.placeholder || helperOn()) return false;
  return playCheck({ key: itemKey(item), ext: item.ext, videoCodec: item.videoCodec, videoProfile: item.videoProfile, audioCodec: item.audioCodec }).verdict === "blocked";
}

function frame(card: HTMLElement): HTMLElement {
  return h("div", { class: "poster-frame" }, [card, h("div", { class: "poster-ring" })]);
}

export function posterEl(item: Item): HTMLElement {
  if (item.placeholder) {
    return h("div", { class: "poster is-placeholder" }, [h("div", { class: "poster-frame" }, [h("div", { class: "poster-card" })])]);
  }
  if (item.kind === "seeAll") {
    const card = h("div", { class: "poster-card" }, [h("div", { class: "poster-see-all", text: "See all ›" })]);
    return h("div", { class: "poster is-see-all" }, [frame(card)]);
  }
  if (item.kind === "category") {
    const card = h("div", { class: "poster-card" }, [h("div", { class: "poster-category-name", text: item.title }), h("div", { class: "poster-category-caption", text: item.caption })]);
    return h("div", { class: "poster is-category" }, [frame(card)]);
  }
  const blocked = isBlocked(item);
  const img = h("img", { class: "poster-img", attrs: { alt: "" } });
  if (item.poster) {
    img.onerror = () => img.parentNode && img.parentNode.removeChild(img);
    img.src = item.poster;
  }
  const card = h("div", { class: "poster-card" }, [h("div", { class: "poster-fallback", text: item.title }), item.poster ? img : null]);
  const badge = blocked ? "Won't play" : item.caption;
  if (badge) card.appendChild(h("div", { class: "poster-badge" + (item.progress > 0 ? " has-progress" : ""), text: badge }));
  if (item.progress > 0) {
    card.appendChild(h("div", { class: "poster-progress" }, [h("div", { class: "poster-fill", attrs: { style: "width:" + Math.round(item.progress * 100) + "%" } })]));
  }
  return h("div", { class: "poster" + (blocked ? " is-blocked" : "") }, [frame(card)]);
}
