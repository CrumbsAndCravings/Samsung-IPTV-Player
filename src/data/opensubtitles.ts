// OpenSubtitles calls (the Roku app's SubtitleTask): check an account, search, download
// and fetch the subtitle file. Every call sends the API key and X-User-Agent (the TV
// replaces User-Agent with its own, docs/m0-findings.md). The login's token and server
// are saved on the TV, and a download that is refused signs in again once.

import { findQueries, FindRequest, osBase, osErrorText, OsCandidate, parseOsResults, APP_USER_AGENT } from "../core/opensubtitles";
import { OsAccount, readOsFields, saveOsAccount } from "../core/storage";
import { field, fieldStr, Json, toInt } from "../core/utils";
import { send } from "../platform/http";

interface Answer {
  ok: boolean;
  code: number;
  data: Json;
  error: string;
}

export interface CheckResult {
  ok: boolean;
  keyOk: boolean;
  error: string;
  name: string; // the username, when the login worked
  allowed: number; // downloads a day, 0 when unknown
}

export interface FindResult {
  ok: boolean;
  error: string;
  candidates: OsCandidate[];
}

export interface DownloadResult {
  ok: boolean;
  error: string;
  text: string; // the subtitle file
  remaining: number; // downloads left today, -1 when unknown
}

// The desktop harness talks to the fake OpenSubtitles in dev/mock-opensubtitles.mjs
// when the key is "demo"; the TV always talks to the real one.
function root(account: OsAccount): string {
  if (!window.tizen && account.apiKey === "demo") return window.location.origin + "/mock-os/api/v1";
  return osBase(account.baseUrl);
}

export class OsClient {
  constructor(private account: OsAccount) {}

  private request(method: "GET" | "POST", path: string, body?: Json): Promise<Answer> {
    const headers: { [name: string]: string } = {
      "Api-Key": this.account.apiKey,
      "X-User-Agent": APP_USER_AGENT,
      Accept: "application/json",
    };
    if (this.account.token) headers.Authorization = "Bearer " + this.account.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return send({ method, url: root(this.account) + path, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 20000 }).promise.then((res) => {
      let data: Json;
      try {
        data = JSON.parse(res.text) as Json;
      } catch {
        data = undefined;
      }
      const error = res.ok ? "" : res.timedOut ? "OpenSubtitles took too long to answer." : osErrorText(res.code, data);
      return { ok: res.ok, code: res.code, data, error };
    });
  }

  // Signs in, keeping the token and the server OpenSubtitles says to use (VIP accounts
  // get their own). Saved straight away so the next video doesn't sign in again.
  private login(): Promise<Answer> {
    this.account.token = "";
    return this.request("POST", "/login", { username: this.account.username, password: this.account.password }).then((res) => {
      if (res.ok) {
        this.account.token = fieldStr(res.data, "token");
        const baseUrl = fieldStr(res.data, "base_url");
        if (baseUrl) this.account.baseUrl = baseUrl;
        this.save();
      }
      return res;
    });
  }

  // Keeps the fields as typed now (the setup screen may have changed them since).
  private save(): void {
    const current = readOsFields();
    if (current.apiKey !== this.account.apiKey || current.username !== this.account.username) return;
    saveOsAccount({ ...current, token: this.account.token, baseUrl: this.account.baseUrl });
  }

  // The key on its own first, then the login, so the message says which one failed.
  check(): Promise<CheckResult> {
    const result: CheckResult = { ok: false, keyOk: false, error: "", name: "", allowed: 0 };
    if (!this.account.apiKey) return Promise.resolve({ ...result, error: "Enter your API key first." });
    this.account.baseUrl = "";
    this.account.token = "";
    return this.request("GET", "/infos/formats").then((key) => {
      if (!key.ok) return { ...result, error: "The API key didn't work. " + key.error };
      if (!this.account.username) return { ...result, ok: true, keyOk: true, allowed: 5 };
      return this.login().then((login) => {
        if (!login.ok) return { ...result, keyOk: true, error: "The key works, but the login didn't. " + login.error + " Use your username, not your email." };
        return { ...result, ok: true, keyOk: true, name: this.account.username, allowed: toInt(field(field(login.data, "user"), "allowed_downloads")) };
      });
    });
  }

  // By TMDB id first, then by title when that finds nothing.
  find(req: FindRequest): Promise<FindResult> {
    const queries = findQueries(req);
    const next = (i: number): Promise<FindResult> => {
      if (i >= queries.length) return Promise.resolve({ ok: true, error: "", candidates: [] });
      return this.request("GET", "/subtitles?" + queries[i]).then((res) => {
        if (!res.ok) return i === 0 ? { ok: false, error: res.error, candidates: [] } : { ok: true, error: "", candidates: [] };
        const candidates = parseOsResults(res.data);
        return candidates.length > 0 ? { ok: true, error: "", candidates } : next(i + 1);
      });
    };
    return next(0);
  }

  // Asks for the file's link (signing in first, and again once if refused), then
  // fetches the file itself.
  download(fileId: string): Promise<DownloadResult> {
    const failed = (error: string): DownloadResult => ({ ok: false, error, text: "", remaining: -1 });
    const ask = () => this.request("POST", "/download", { file_id: toInt(fileId) });
    const signIn = this.account.username && !this.account.token ? this.login() : Promise.resolve(null);
    return signIn
      .then(() => ask())
      .then((res) => {
        if ((res.code === 401 || res.code === 403) && this.account.username) return this.login().then((login) => (login.ok ? ask() : res));
        return res;
      })
      .then((res) => {
        if (!res.ok) return failed(res.error);
        const link = fieldStr(res.data, "link");
        if (!link) return failed("OpenSubtitles didn't send a subtitle file.");
        const remaining = field(res.data, "remaining") === undefined ? -1 : toInt(field(res.data, "remaining"));
        return send({ url: link, timeoutMs: 20000, maxBytes: 3 * 1024 * 1024 }).promise.then((file) => {
          if (!file.ok || file.text === "") return failed(file.timedOut ? "The subtitle file took too long to arrive." : "The subtitle file didn't arrive (HTTP " + file.code + ").");
          return { ok: true, error: "", text: file.text, remaining };
        });
      });
  }
}
