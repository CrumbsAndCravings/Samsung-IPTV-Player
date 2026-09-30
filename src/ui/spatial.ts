// Geometric focus movement: picks the nearest element in the pressed direction. Good
// for simple form-like screens (the setup checks); Home and the player get zones (M2).

export type Direction = "up" | "down" | "left" | "right";

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function gap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (bEnd < aStart) return aStart - bEnd;
  if (bStart > aEnd) return bStart - aEnd;
  return 0;
}

// Lower is better; null when `to` is not in that direction from `from`.
export function directionScore(from: Box, to: Box, dir: Direction): number | null {
  const fromCx = (from.left + from.right) / 2;
  const fromCy = (from.top + from.bottom) / 2;
  const toCx = (to.left + to.right) / 2;
  const toCy = (to.top + to.bottom) / 2;
  let primary: number;
  let cross: number;
  let align: number;
  if (dir === "down" || dir === "up") {
    const ahead = dir === "down" ? toCy > fromCy + 4 && to.top >= from.top + 4 : toCy < fromCy - 4 && to.bottom <= from.bottom - 4;
    if (!ahead) return null;
    primary = dir === "down" ? Math.max(0, to.top - from.bottom) : Math.max(0, from.top - to.bottom);
    cross = gap(from.left, from.right, to.left, to.right);
    align = Math.abs(to.left - from.left);
  } else {
    const ahead = dir === "right" ? toCx > fromCx + 4 && to.left >= from.left + 4 : toCx < fromCx - 4 && to.right <= from.right - 4;
    if (!ahead) return null;
    primary = dir === "right" ? Math.max(0, to.left - from.right) : Math.max(0, from.left - to.right);
    cross = gap(from.top, from.bottom, to.top, to.bottom);
    align = Math.abs(toCy - fromCy);
  }
  return primary + cross * 3 + align * 0.05;
}

export function nearest(from: HTMLElement, candidates: HTMLElement[], dir: Direction): HTMLElement | null {
  const a = from.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    const score = directionScore(a, b, dir);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

// Scrolls `container` just enough to show `el` with some room around it.
export function scrollIntoContainer(container: HTMLElement, el: HTMLElement, margin = 120): void {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < c.top + margin) container.scrollTop -= c.top + margin - r.top;
  else if (r.bottom > c.bottom - margin) container.scrollTop += r.bottom - (c.bottom - margin);
}
