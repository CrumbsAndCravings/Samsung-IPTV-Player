// The jump preview (plan 7.5): Left/Right move a marker and a time bubble, not the
// video. Holding steps every 250 ms with HoldStep's growing size (the remote's own key
// repeat is ignored), and the video jumps 0.8 s after the last release. Times are passed
// in, so this is tested without timers.

import { clampSeek, holdStep } from "./playback";

export const TICK_MS = 250;
export const COMMIT_AFTER_MS = 800;
const TAP_MS = 500; // shorter than this is a single step
const RELEASE_GUARD_MS = 900; // no key event for this long counts as a release
const MAX_HOLD_MS = 20000;

export class SeekPreview {
  active = false;
  target = 0; // seconds
  private holdKey = "";
  private direction = 1;
  private holdStart = 0;
  private lastKeyAt = 0;
  private commitAt = 0;

  get holding(): boolean {
    return this.holdKey !== "";
  }

  // A key went down (or repeated). Returns true when it started a new hold.
  press(key: string, direction: number, positionSecs: number, durationSecs: number, now: number): boolean {
    this.lastKeyAt = now;
    if (this.holdKey === key) return false; // a repeat: the tick does the stepping
    if (!this.active) {
      this.active = true;
      this.target = positionSecs;
    }
    this.holdKey = key;
    this.direction = direction;
    this.holdStart = now;
    this.commitAt = 0;
    this.step(10, durationSecs);
    return true;
  }

  // Called every TICK_MS while holding.
  tick(durationSecs: number, now: number): void {
    if (!this.holding) return;
    const held = now - this.holdStart;
    // A missed key release shouldn't leave the target running away.
    if (held > MAX_HOLD_MS || now - this.lastKeyAt > RELEASE_GUARD_MS) {
      this.release(this.holdKey, now);
      return;
    }
    if (held >= TAP_MS) this.step(holdStep(held), durationSecs);
  }

  release(key: string, now: number): void {
    if (key !== this.holdKey) return;
    this.holdKey = "";
    if (this.active) this.commitAt = now + COMMIT_AFTER_MS;
  }

  // Seconds to jump to when the preview should be applied now, else -1.
  due(now: number): number {
    if (!this.active || this.holding || this.commitAt === 0 || now < this.commitAt) return -1;
    return this.commit();
  }

  // OK on the bar applies the preview at once.
  commit(): number {
    const target = this.target;
    this.cancel();
    return target;
  }

  cancel(): void {
    this.active = false;
    this.holdKey = "";
    this.commitAt = 0;
  }

  private step(seconds: number, durationSecs: number): void {
    this.target = clampSeek(this.target + seconds * this.direction, durationSecs);
  }
}
