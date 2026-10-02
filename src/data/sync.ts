// Continue Watching in step between devices (docs/features.md §9.4; the Roku app's
// SyncTask and MainScene.requestSync), through the small Cloudflare Worker in the Roku
// repo's sync/ folder. Only a personal build with "sync" in personal.json syncs.
//
// One round sends this TV's list and removals and gets back the merged state from every
// device, which is folded into the lists as they are *now* (never a blind replace, so a
// save made while the request was out isn't lost). Rounds run at launch and sign-in,
// right after leaving a video or removing a title, every 5 minutes while a video plays,
// and when Home comes back (at most once a minute). A round asked for while one is
// running runs once more after it.

import { log } from "../core/log";
import { mergeProgress, progressList, progressRemovedList, progressSave } from "../core/progress";
import { syncConfig } from "../core/personal";
import { sha256Hex } from "../core/sha256";
import { Creds, isObj, syncSpaceText } from "../core/utils";
import { send } from "../platform/http";

const SOON_MS = 60000;
const TIMEOUT_MS = 20000;

// This login's list on the sync service: 16 hex digits of SHA-256 of syncSpaceText.
export function syncSpace(creds: Creds): string {
  return sha256Hex(syncSpaceText(creds)).slice(0, 16);
}

export class ProgressSync {
  private running = false;
  private again = false;
  private lastAt = 0;
  private ended = false;
  private listeners: (() => void)[] = [];

  constructor(
    private creds: Creds,
    private config: { url: string; key: string },
  ) {}

  // A sync for this login, or null when this build has no sync service.
  static forCreds(creds: Creds | null): ProgressSync | null {
    const config = syncConfig();
    return creds && config ? new ProgressSync(creds, config) : null;
  }

  // Called after a round changed Continue Watching; returns an unsubscribe.
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  now(): void {
    if (this.ended) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.round();
  }

  // At most once a minute (Home coming back).
  soon(): void {
    if (Date.now() - this.lastAt >= SOON_MS) this.now();
  }

  stop(): void {
    this.ended = true;
    this.listeners = [];
  }

  private round(): void {
    this.running = true;
    this.lastAt = Date.now();
    const body = JSON.stringify({ entries: progressList(), removed: progressRemovedList() });
    send({
      method: "POST",
      url: this.config.url + "/v1/progress?space=" + syncSpace(this.creds),
      headers: { Authorization: "Bearer " + this.config.key, "Content-Type": "application/json" },
      body,
      timeoutMs: TIMEOUT_MS,
    })
      .promise.then((res) => {
        if (this.ended) return;
        if (res.timedOut) return log("sync: the sync service took too long to answer");
        if (res.code !== 200) return log("sync: the sync service answered HTTP " + res.code);
        let state: unknown;
        try {
          state = JSON.parse(res.text);
        } catch {
          state = undefined;
        }
        if (!isObj(state)) return log("sync: the sync service's answer wasn't readable");
        const before = JSON.stringify(progressList());
        const merged = mergeProgress(progressList(), progressRemovedList(), state);
        progressSave(merged.entries, merged.removed);
        if (JSON.stringify(merged.entries) !== before) {
          log("sync: Continue Watching changed on another device");
          for (const listener of this.listeners.slice()) listener();
        }
      })
      .then(() => {
        this.running = false;
        if (this.again && !this.ended) {
          this.again = false;
          this.round();
        }
      });
  }
}
