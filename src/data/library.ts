// The whole library, for Search, category pages and the Categories tab (the Roku app's
// SearchTask; docs/features.md §6.2, §6.3). Xtream has no search call, so every list
// is indexed: series in one request (about 3 s for 7,000 on the provider in use),
// movies one category at a time, and only categories in the languages you watch.
//
// A finished library is saved on the TV and searched straight away on every later
// launch, whatever its age. Once the saved copy is a day old, a fresh one loads slowly
// in the background while searches keep using the old one, and replaces it when
// complete. Only the very first load makes you wait.
//
// Gentle on the provider, which stopped answering after bursts of requests (§3): two
// lists at a time at most one start a second for the first load, one list every two
// seconds for a refresh, nothing new while a video plays, and a stop after three
// failures in a row.

import { categoryWanted, classifyCategory, takeTurns } from "../core/categories";
import type { Item, Row } from "../core/items";
import { log } from "../core/log";
import { languagePrefs } from "../core/personal";
import { indexAdd, indexBrowse, indexCounts, indexSearch, indexSetCategories, LibraryStatus, newSearchIndex, parseIndex, SearchIndex, serializeIndex } from "../core/search";
import type { Creds } from "../core/utils";
import type { Category } from "../core/xtream";
import { files, TextStore } from "../platform/files";

type Kind = "movie" | "series";

interface Job {
  kind: Kind;
  id: string; // "" with `all`
  all: boolean; // the whole series library in one request
}

// What the library needs from the API (data/api.ts), so tests can stand in for it.
export interface LibrarySource {
  readonly creds: Creds;
  onList: ((kind: Kind, categoryId: string, data: unknown) => void) | null;
  categories(kind: Kind): Promise<Category[]>;
  list(kind: Kind, categoryId: string, timeoutMs: number): Promise<unknown>;
}

const FILE = "search-library";
const DAY_SECONDS = 86400;
const FIRST_LOAD = { inFlight: 2, spacingMs: 1000 };
const REFRESH = { inFlight: 1, spacingMs: 2000 };
const HELD_CHECK_MS = 2000; // while a video plays
const LIST_TIMEOUT_MS = 45000;
const HUNG_MS = LIST_TIMEOUT_MS + 15000; // a list can wait in the API's queue first
const STOP_AFTER_FAILURES = 3;
const BROKEN_LISTS_ALLOWED = 3; // a few broken categories don't spoil a library

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Forgets the saved library (signing out).
export function deleteStoredLibrary(store: TextStore = files): Promise<void> {
  return store.remove(FILE);
}

export class SearchLibrary {
  private live: SearchIndex = newSearchIndex(); // what searches use
  private building: SearchIndex = this.live; // what's loading (the same on a first load)
  private refreshing = false;
  private complete = false; // nothing more will load this session
  private jobs: Job[] = [];
  private seriesJobs: Job[] = [];
  private seriesAllowed: { [id: string]: boolean } = {};
  private covered: { [key: string]: boolean } = {};
  private running = 0;
  private lastStart = 0;
  private failures = 0; // in a row
  private brokenLists = 0;
  private missingKind = false; // a category list didn't load; don't save
  private done = 0;
  private total = 0;
  private stopped = false;
  private started = false;
  private ended = false;
  private held = false;
  private timer = 0;
  private listeners: (() => void)[] = [];
  readonly status: LibraryStatus = { done: 0, total: 0, failed: 0, titles: 0, error: "", stopped: false };

  constructor(
    private api: LibrarySource,
    private store: TextStore = files,
  ) {
    // Whole categories Home has loaded are indexed as they arrive, not asked for again.
    api.onList = (kind, categoryId, data) => {
      const key = (kind === "series" ? "s:" : "m:") + categoryId;
      if (this.complete || this.ended || this.covered[key] || this.building.catIndex[key] === undefined) return;
      this.covered[key] = true;
      indexAdd(this.building, data, kind, undefined, categoryId);
      if (!this.refreshing) this.report();
    };
  }

  private get owner(): string {
    return this.api.creds.server + " " + this.api.creds.username;
  }

  // Still filling in (the first load); a refresh behind a saved copy doesn't count.
  get loading(): boolean {
    return !this.complete && !this.refreshing;
  }

  // Starts once per session, on the first search, category page or Categories tab; again
  // after the provider's category lists couldn't be loaded.
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.status.error = "";
    this.store
      .load(FILE)
      .catch(() => null)
      .then((text) => {
        if (this.ended) return;
        const saved = text ? parseIndex(text, this.owner, new Date().getFullYear()) : null;
        if (saved) {
          this.live = saved;
          this.refreshing = true;
          this.report();
          log("search: using the saved library,", saved.names.length, "titles");
          if (nowSeconds() - saved.savedAt < DAY_SECONDS) {
            this.complete = true;
            return;
          }
          log("search: the saved library is a day old; refreshing it in the background");
          this.building = newSearchIndex();
        }
        this.loadCategories();
      });
  }

  // Signing out: nothing more loads, and nothing late is kept.
  stop(): void {
    this.ended = true;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.jobs = [];
    this.listeners = [];
    if (this.api.onList) this.api.onList = null;
  }

  // No new downloads while a video plays (they compete for the TV's attention).
  hold(on: boolean): void {
    this.held = on;
    if (!on) this.pump();
  }

  search(query: string, limit: number): Row[] {
    return indexSearch(this.live, query, limit);
  }

  // A category's titles, newest first (or best matches for `query`), from the library
  // only. `loading` says more may arrive, so the page can ask again.
  browse(kind: Kind, categoryId: string, limit: number, query = ""): { items: Item[]; total: number; loading: boolean } {
    const found = indexBrowse(this.live, kind, categoryId, limit, query);
    return { items: found.items, total: found.total, loading: this.loading };
  }

  // How many titles each category holds ("movie:123" -> 104).
  counts(): { [key: string]: number } {
    return indexCounts(this.live);
  }

  // Called whenever titles arrive or the status changes; returns an unsubscribe.
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private report(): void {
    if (this.refreshing) {
      this.status.done = 1;
      this.status.total = 1;
      this.status.failed = 0;
      this.status.stopped = false;
    } else {
      this.status.done = this.done;
      this.status.total = this.total;
      this.status.failed = this.brokenLists;
      this.status.stopped = this.stopped;
    }
    this.status.titles = this.live.names.length;
    for (const listener of this.listeners.slice()) listener();
  }

  // Both category lists, keeping the languages you watch (all of them when none are set):
  // fewer requests, and no French or Arabic titles crowding the results.
  private loadCategories(): void {
    const year = new Date().getFullYear();
    const langs = languagePrefs();
    let lastError = "";
    const wanted = (kind: Kind) =>
      this.api.categories(kind).then(
        (list) => list.filter((c) => categoryWanted(classifyCategory(c.name, year), langs)),
        (err: Error) => {
          log("search:", kind, "categories failed:", err.message);
          lastError = err.message;
          return null;
        },
      );
    Promise.all([wanted("series"), wanted("movie")]).then(([series, movies]) => {
      if (this.ended) return;
      if (!series && !movies) {
        if (this.refreshing) {
          log("search: the refresh couldn't start; keeping the saved library");
          this.complete = true;
        } else {
          this.started = false; // the next visit tries again
          this.status.error = lastError;
          this.report();
        }
        return;
      }
      this.missingKind = !series || !movies;
      if (series) {
        indexSetCategories(this.building, "series", series, year);
        for (const c of series) {
          this.seriesJobs.push({ kind: "series", id: c.id, all: false });
          this.seriesAllowed[c.id] = true;
        }
        if (series.length > 0) this.jobs.push({ kind: "series", id: "", all: true });
      }
      if (movies) {
        indexSetCategories(this.building, "movie", movies, year);
        for (const c of movies) this.jobs.push({ kind: "movie", id: c.id, all: false });
      }
      this.total = this.jobs.length;
      if (this.missingKind) this.brokenLists++;
      log("search: loading", this.total, "lists", this.refreshing ? "in the background" : "");
      if (this.jobs.length === 0) this.finishIfDone();
      this.report();
      this.pump();
    });
  }

  private later(ms: number): void {
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.pump();
    }, ms);
  }

  private pump(): void {
    if (this.timer || this.ended) return;
    const pace = this.refreshing ? REFRESH : FIRST_LOAD;
    while (this.running < pace.inFlight && this.jobs.length > 0) {
      if (this.held) return this.later(HELD_CHECK_MS);
      const job = this.jobs[0];
      if (!job.all && this.covered[(job.kind === "series" ? "s:" : "m:") + job.id]) {
        // Home already brought this one.
        this.jobs.shift();
        this.done++;
        this.finishIfDone();
        this.report();
        continue;
      }
      const wait = this.lastStart + pace.spacingMs - Date.now();
      if (wait > 0) return this.later(wait);
      this.jobs.shift();
      this.lastStart = Date.now();
      this.run(job);
    }
  }

  private run(job: Job): void {
    this.running++;
    let settled = false;
    const settle = (data: unknown, error: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(hung);
      this.running--;
      this.arrived(job, data, error);
    };
    const hung = window.setTimeout(() => settle(null, "no answer"), HUNG_MS);
    this.api.list(job.kind, job.id, LIST_TIMEOUT_MS).then(
      (data) => settle(data, ""),
      (err: Error) => settle(null, err.message || "failed"),
    );
  }

  private arrived(job: Job, data: unknown, error: string): void {
    if (this.ended) return;
    let failed = false;
    if (Array.isArray(data)) {
      // The whole-series answer includes adult categories: keep the wanted ones only.
      if (job.all) indexAdd(this.building, data, job.kind, this.seriesAllowed);
      else indexAdd(this.building, data, job.kind, undefined, job.id);
      if (!job.all) this.covered[(job.kind === "series" ? "s:" : "m:") + job.id] = true;
    } else if (error !== "" || job.all) {
      // An empty category can answer {} instead of [], which isn't a failure.
      failed = true;
      log("search: list failed:", job.kind, job.id || "(all)", error);
    }
    this.done++;
    if (job.all && failed) {
      // Series category by category instead, taking turns with the movies still to come.
      this.jobs = takeTurns(this.seriesJobs, this.jobs);
      this.total += this.seriesJobs.length;
    } else if (failed) this.brokenLists++;
    // A provider that keeps failing may be counting requests; stop asking.
    this.failures = failed ? this.failures + 1 : 0;
    if (this.failures >= STOP_AFTER_FAILURES && this.jobs.length > 0) {
      log("search: the provider stopped answering; the rest wait until next time");
      this.jobs = [];
      this.stopped = true;
      this.total = this.done + this.running;
    }
    this.finishIfDone();
    this.report();
    this.pump();
  }

  private finishIfDone(): void {
    if (this.complete || this.jobs.length > 0 || this.running > 0) return;
    this.complete = true;
    // Kept only when complete. A refresh that stopped early keeps the saved copy and
    // tries again next time; a first load stays searchable for this session.
    if (this.stopped || this.missingKind || this.brokenLists > BROKEN_LISTS_ALLOWED || this.building.names.length === 0) {
      log("search: library incomplete,", this.building.names.length, "titles; not saved");
      return;
    }
    const savedAt = nowSeconds();
    this.building.savedAt = savedAt;
    this.live = this.building;
    this.refreshing = false;
    log("search: library loaded,", this.live.names.length, "titles; saving it");
    this.store.save(FILE, serializeIndex(this.live, this.owner, savedAt)).then((ok) => {
      if (!ok) log("search: the library couldn't be saved");
    });
  }
}
