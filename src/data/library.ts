// The search index for the whole library (plan 7.4; the Roku app's SearchTask). Xtream
// has no search call, so the first search of a session loads every list in the
// background: series in one call (about 3 s for 7,000 on this provider), movies one
// category at a time, since the all-movies call timed out (docs/m0-findings.md). Two
// lists at a time with a pause between, because the provider seemed to stop answering
// after bursts, and nothing new starts while a video plays. Categories Home has
// already loaded are indexed as they arrive and not asked for again.

import { log } from "../core/log";
import type { Row } from "../core/items";
import { indexAdd, indexSearch, LibraryStatus, newSearchIndex } from "../core/search";
import type { XtreamApi } from "./api";

type Kind = "movie" | "series";

interface Job {
  kind: Kind;
  id: string; // "" for the whole library
}

const IN_FLIGHT = 2;
const PAUSE_MS = 250;
const LIST_TIMEOUT_MS = 45000;

export class SearchLibrary {
  private index = newSearchIndex();
  private jobs: Job[] = [];
  private covered: { [key: string]: boolean } = {};
  private running = 0;
  private started = false;
  private held = false;
  private timer = 0;
  private listeners: (() => void)[] = [];
  readonly status: LibraryStatus = { done: 0, total: 0, failed: 0, titles: 0, error: "" };

  constructor(private api: XtreamApi) {
    api.onList = (kind, categoryId, data) => {
      this.covered[kind + ":" + categoryId] = true;
      indexAdd(this.index, data, kind);
      this.changed();
    };
  }

  get loading(): boolean {
    return this.status.total === 0 || this.status.done < this.status.total;
  }

  // Starts loading, once per session.
  start(): void {
    if (this.started) return;
    this.started = true;
    this.status.error = "";
    log("search: loading the library");
    Promise.all([this.api.categories("series"), this.api.categories("movie")])
      .then(([seriesCats, movieCats]) => {
        const allowed: { [id: string]: boolean } = {};
        for (const c of seriesCats) allowed[c.id] = true;
        this.status.total = 1 + movieCats.length;
        this.changed();
        // All series at once; if that fails, category by category.
        this.run({ kind: "series", id: "" }, allowed, () => {
          this.status.total += seriesCats.length;
          for (const c of seriesCats) this.jobs.push({ kind: "series", id: c.id });
        });
        for (const c of movieCats) this.jobs.push({ kind: "movie", id: c.id });
        this.pump();
      })
      .catch((err: Error) => {
        log("search: categories failed:", err.message);
        this.started = false; // the next search tries again
        this.status.total = 0;
        this.status.error = err.message;
        this.changed();
      });
  }

  // No new downloads while a video plays (they compete for the TV's attention).
  hold(on: boolean): void {
    this.held = on;
    if (!on) this.pump();
  }

  search(query: string, limit: number): Row[] {
    return indexSearch(this.index, query, limit);
  }

  // Called whenever titles arrive or the status changes; returns an unsubscribe.
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private changed(): void {
    this.status.titles = this.index.names.length;
    for (const listener of this.listeners.slice()) listener();
  }

  private pump(): void {
    if (this.timer || this.held) return;
    while (this.running < IN_FLIGHT && this.jobs.length > 0) {
      const job = this.jobs.shift() as Job;
      if (this.covered[job.kind + ":" + job.id]) {
        this.status.done++;
        continue;
      }
      this.run(job);
      if (this.jobs.length > 0) {
        // One at a time from here, a moment apart.
        this.timer = window.setTimeout(() => {
          this.timer = 0;
          this.pump();
        }, PAUSE_MS);
        break;
      }
    }
    this.changed();
  }

  private run(job: Job, allowed?: { [id: string]: boolean }, onFail?: () => void): void {
    this.running++;
    this.api
      .list(job.kind, job.id, LIST_TIMEOUT_MS)
      .then(
        (data) => {
          this.covered[job.kind + ":" + job.id] = true;
          indexAdd(this.index, data, job.kind, allowed);
        },
        (err: Error) => {
          log("search: list failed:", job.kind, job.id || "(all)", err.message);
          if (onFail) onFail();
          else this.status.failed++;
        },
      )
      .then(() => {
        this.running--;
        this.status.done++;
        if (!this.loading) log("search: library loaded,", this.index.names.length, "titles");
        this.pump();
      });
  }
}
