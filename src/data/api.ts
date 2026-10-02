// Every call to the Xtream server goes through here: the Roku app's XtreamTask with a
// session cache, so going back to Home never refetches, and a gentle queue. The real
// provider seemed to stop answering after a burst of requests (docs/m0-findings.md), so
// at most three run at once and each starts a little after the one before.

import { Creds, apiUrl } from "../core/utils";
import { Category, parseAuth, parseCategories, parseSeriesInfo, parseVodInfo, buildRow, SeriesInfo, Season, VodInfo } from "../core/xtream";
import type { Row } from "../core/items";
import { log } from "../core/log";
import { signInErrorText } from "../core/refusals";
import { getJson, JsonResult } from "../platform/http";

const MAX_IN_FLIGHT = 3;
const SPACING_MS = 120;

// A failed request, with the HTTP status (0 when there was no answer) so screens can
// tell a refusal from a hiccup.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    readonly cfBlock = false,
  ) {
    super(message);
  }
}

type Job = { url: string; timeoutMs: number; resolve: (r: JsonResult) => void };

export class XtreamApi {
  private queue: Job[] = [];
  private inFlight = 0;
  private lastStart = 0;
  private timer = 0;
  private cache: { [key: string]: Promise<unknown> } = {};
  // Every whole category that arrives is handed here too, so Search can index what
  // Home already loaded instead of asking for it again.
  onList: ((kind: "movie" | "series", categoryId: string, data: unknown) => void) | null = null;

  constructor(readonly creds: Creds) {}

  private fetch(url: string, timeoutMs = 20000): Promise<JsonResult> {
    return new Promise((resolve) => {
      this.queue.push({ url, timeoutMs, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.inFlight >= MAX_IN_FLIGHT || this.queue.length === 0) return;
    const wait = this.lastStart + SPACING_MS - Date.now();
    if (wait > 0) {
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        this.pump();
      }, wait);
      return;
    }
    const job = this.queue.shift() as Job;
    this.inFlight++;
    this.lastStart = Date.now();
    getJson(job.url, job.timeoutMs).then((res) => {
      this.inFlight--;
      job.resolve(res);
      this.pump();
    });
    this.pump();
  }

  // Cached for the session; a failed request isn't cached, so it can be retried.
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.cache[key]) {
      this.cache[key] = load().catch((err: Error) => {
        delete this.cache[key];
        throw err;
      });
    }
    return this.cache[key] as Promise<T>;
  }

  private json(action: string, params?: { [key: string]: string }, timeoutMs?: number): Promise<unknown> {
    return this.fetch(apiUrl(this.creds, action, params), timeoutMs).then((res) => {
      if (!res.ok) {
        log("api", action, "failed:", res.error);
        throw new ApiError(res.error, res.code, res.cfBlock);
      }
      return res.data;
    });
  }

  categories(kind: "movie" | "series"): Promise<Category[]> {
    const action = kind === "series" ? "get_series_categories" : "get_vod_categories";
    return this.cached("cats:" + kind, () => this.json(action).then(parseCategories));
  }

  // The newest `limit` titles of one category.
  row(kind: "movie" | "series", categoryId: string, title: string, limit = 40): Promise<Row> {
    const action = kind === "series" ? "get_series" : "get_vod_streams";
    return this.cached("row:" + kind + ":" + categoryId, () =>
      this.json(action, { category_id: categoryId }).then((data) => {
        if (this.onList) this.onList(kind, categoryId, data);
        return buildRow(data, kind, title, limit);
      }),
    );
  }

  // A whole category, or the whole library when `categoryId` is "", uncached (for the
  // search index, which keeps only what it needs).
  list(kind: "movie" | "series", categoryId: string, timeoutMs: number): Promise<unknown> {
    const action = kind === "series" ? "get_series" : "get_vod_streams";
    return this.json(action, categoryId ? { category_id: categoryId } : undefined, timeoutMs);
  }

  vodInfo(id: string): Promise<VodInfo> {
    return this.cached("vod:" + id, () => this.json("get_vod_info", { vod_id: id }).then(parseVodInfo));
  }

  seriesInfo(id: string): Promise<{ info: SeriesInfo; seasons: Season[] }> {
    return this.cached("series:" + id, () => this.json("get_series_info", { series_id: id }).then(parseSeriesInfo));
  }
}

// Checks a login before it is saved. Resolves with "" when it works, otherwise the
// error with the address used and the usual causes (docs/features.md §2.3).
export function checkLogin(creds: Creds): Promise<string> {
  return getJson(apiUrl(creds, "")).then((res) => {
    if (!res.ok) return signInErrorText(res.error, creds.server, res.code, res.cfBlock);
    const auth = parseAuth(res.data);
    return auth.ok ? "" : auth.error;
  });
}
