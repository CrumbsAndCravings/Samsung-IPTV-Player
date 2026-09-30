// Pure helpers for the player's seeking, ported from the Roku app's Playback.brs.

// Seconds per step while Left/Right is held: 10 for the first 1.5 seconds, 30 for the
// next 1.5, then doubling every 1.5 seconds, capped at 10 minutes.
export function holdStep(heldMs: number): number {
  if (heldMs < 1500) return 10;
  let step = 30;
  const stages = Math.floor((heldMs - 1500) / 1500);
  for (let i = 1; i <= stages; i++) {
    step *= 2;
    if (step >= 600) return 600;
  }
  return step;
}

// Keeps a seek target (seconds) inside the video. Duration 0 means unknown.
export function clampSeek(target: number, duration: number): number {
  let t = target;
  if (duration > 0 && t > duration - 3) t = duration - 3;
  if (t < 0) t = 0;
  return t;
}

// 0..1 share of the bar for a position.
export function barFraction(position: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(1, position / duration));
}
