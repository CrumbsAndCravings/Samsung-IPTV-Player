// The network checks from section 2 of the plan: can the packaged app reach the Xtream
// server and OpenSubtitles, which headers survive, and do streams allow range requests.
// Results are plain data, kept in localStorage and summarised in the report.

import { APP_USER_AGENT, osBase, osErrorText, parseContentRangeTotal } from "../core/opensubtitles";
import type { OsAccount } from "../core/storage";
import { apiUrl, Creds, field, fieldStr, isObj, Json, toInt } from "../core/utils";
import { parseAuth, parseCategories } from "../core/xtream";
import { getJson, send } from "../platform/http";

export type Outcome = "ok" | "fail" | "warn";

export interface XtreamCheck {
  outcome: Outcome;
  code: number;
  ms: number;
  message: string;
  status: string;
  expires: string;
  maxConnections: string;
  movieCategories: number;
  seriesCategories: number;
  at: number;
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function xtreamCheck(creds: Creds): Promise<XtreamCheck> {
  const result: XtreamCheck = {
    outcome: "fail",
    code: 0,
    ms: 0,
    message: "",
    status: "",
    expires: "",
    maxConnections: "",
    movieCategories: -1,
    seriesCategories: -1,
    at: Date.now(),
  };
  return getJson(apiUrl(creds, ""))
    .then((res) => {
      result.code = res.code;
      result.ms = res.ms;
      if (!res.ok) {
        result.message = res.error;
        return result;
      }
      const auth = parseAuth(res.data);
      const user = field(res.data, "user_info");
      result.status = fieldStr(user, "status");
      const exp = toInt(field(user, "exp_date"));
      result.expires = exp > 0 ? isoDate(exp) : "no end date";
      result.maxConnections = fieldStr(user, "max_connections");
      if (!auth.ok) {
        result.message = auth.error;
        return result;
      }
      return Promise.all([getJson(apiUrl(creds, "get_vod_categories")), getJson(apiUrl(creds, "get_series_categories"))]).then(
        ([movies, series]) => {
          result.movieCategories = movies.ok ? parseCategories(movies.data).length : -1;
          result.seriesCategories = series.ok ? parseCategories(series.data).length : -1;
          result.outcome = movies.ok && series.ok ? "ok" : "warn";
          result.message = movies.ok && series.ok ? "" : "Signed in, but the category lists failed: " + (movies.error || series.error);
          return result;
        },
      );
    })
    .then((r) => {
      r.at = Date.now();
      return r;
    });
}

export interface RangeCheck {
  outcome: Outcome;
  code: number;
  bytes: number;
  total: number; // -1 when Content-Range was missing or unreadable
  tailCode: number;
  tailBytes: number;
  message: string;
  at: number;
}

const CHUNK = 65536;

function rangeRequest(url: string, from: number, to: number) {
  return send({
    url,
    headers: { Range: "bytes=" + from + "-" + to },
    responseType: "arraybuffer",
    timeoutMs: 8000,
    maxBytes: CHUNK * 2,
  }).promise;
}

// The two requests OpenSubtitles' moviehash needs: the first and last 64 KB.
export function rangeCheck(url: string): Promise<RangeCheck> {
  const result: RangeCheck = { outcome: "fail", code: 0, bytes: 0, total: -1, tailCode: 0, tailBytes: 0, message: "", at: Date.now() };
  return rangeRequest(url, 0, CHUNK - 1).then((head) => {
    result.code = head.code;
    result.bytes = head.buffer ? head.buffer.byteLength : 0;
    result.total = parseContentRangeTotal(head.header("Content-Range") || "");
    if (head.overflowed || head.code === 200) {
      result.message = "The server ignores Range and sends the whole file.";
      return result;
    }
    if (head.code !== 206 || result.bytes !== CHUNK) {
      result.message = head.timedOut ? "No answer within 8 s." : "Expected HTTP 206 with 65536 bytes.";
      return result;
    }
    if (result.total < CHUNK * 2) {
      result.outcome = "warn";
      result.message = "Range works, but the file size (Content-Range) couldn't be read.";
      return result;
    }
    return rangeRequest(url, result.total - CHUNK, result.total - 1).then((tail) => {
      result.tailCode = tail.code;
      result.tailBytes = tail.buffer ? tail.buffer.byteLength : 0;
      const tailOk = tail.code === 206 && result.tailBytes === CHUNK;
      result.outcome = tailOk ? "ok" : "warn";
      result.message = tailOk ? "" : "The first 64 KB worked but the last 64 KB didn't.";
      result.at = Date.now();
      return result;
    });
  });
}

export interface EchoCheck {
  outcome: Outcome;
  service: string;
  code: number;
  userAgentSeen: string;
  ourUserAgentArrived: boolean;
  xUserAgentArrived: boolean;
  refused: string[];
  message: string;
  at: number;
}

const ECHO_SERVICES = ["https://httpbin.org/headers", "https://postman-echo.com/headers"];

function headerValue(headers: Json, name: string): string {
  if (!isObj(headers)) return "";
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return fieldStr(headers, key);
  }
  return "";
}

// Asks a public echo service which headers actually left the TV. Browsers refuse to set
// User-Agent on XHR; this shows whether the TV's engine does too, and whether
// X-User-Agent gets through instead. No personal details are sent.
export function echoCheck(): Promise<EchoCheck> {
  const attempt = (i: number): Promise<EchoCheck> => {
    const service = ECHO_SERVICES[i];
    return send({
      url: service,
      headers: { "User-Agent": APP_USER_AGENT, "X-User-Agent": APP_USER_AGENT, Accept: "application/json" },
      timeoutMs: 15000,
    }).promise.then((res) => {
      let headers: Json;
      try {
        headers = field(JSON.parse(res.text) as Json, "headers");
      } catch {
        headers = undefined;
      }
      if (!res.ok || !isObj(headers)) {
        if (i + 1 < ECHO_SERVICES.length) return attempt(i + 1);
        return {
          outcome: "fail" as Outcome,
          service: service.replace(/^https:\/\//, "").replace(/\/.*$/, ""),
          code: res.code,
          userAgentSeen: "",
          ourUserAgentArrived: false,
          xUserAgentArrived: false,
          refused: res.headerErrors,
          message: res.code === 0 ? "Couldn't reach httpbin.org or postman-echo.com from the TV." : "The echo service answered HTTP " + res.code + ".",
          at: Date.now(),
        };
      }
      const seen = headerValue(headers, "User-Agent");
      const xSeen = headerValue(headers, "X-User-Agent");
      return {
        outcome: "ok" as Outcome,
        service: service.replace(/^https:\/\//, "").replace(/\/.*$/, ""),
        code: res.code,
        userAgentSeen: seen,
        ourUserAgentArrived: seen === APP_USER_AGENT,
        xUserAgentArrived: xSeen === APP_USER_AGENT,
        refused: res.headerErrors,
        message: "",
        at: Date.now(),
      };
    });
  };
  return attempt(0);
}

export interface OsCall {
  code: number;
  message: string; // OpenSubtitles' own words, or our explanation
}

export interface OsCheck {
  outcome: Outcome;
  keyOnly: OsCall | null;
  keyWithXua: OsCall | null;
  login: (OsCall & { allowed: number; level: string; baseUrl: string }) | null;
  message: string;
  at: number;
}

function osHeaders(account: OsAccount, withXua: boolean): { [name: string]: string } {
  const headers: { [name: string]: string } = {
    "Api-Key": account.apiKey,
    "User-Agent": APP_USER_AGENT,
    Accept: "application/json",
  };
  if (withXua) headers["X-User-Agent"] = APP_USER_AGENT;
  return headers;
}

function osCall(method: "GET" | "POST", url: string, headers: { [name: string]: string }, body?: Json) {
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return send({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 20000 }).promise.then((res) => {
    let data: Json;
    try {
      data = JSON.parse(res.text) as Json;
    } catch {
      data = undefined;
    }
    const message = res.ok ? "" : res.timedOut ? "OpenSubtitles took too long to answer." : osErrorText(res.code, data);
    return { res, data, call: { code: res.code, message } as OsCall };
  });
}

// Checks the key on its own (with and without X-User-Agent), then the login, so the
// message says which one failed. `onToken` saves the token and server as Roku does.
export function osCheck(account: OsAccount, onToken: (token: string, baseUrl: string) => void): Promise<OsCheck> {
  const result: OsCheck = { outcome: "fail", keyOnly: null, keyWithXua: null, login: null, message: "", at: Date.now() };
  if (account.apiKey === "") {
    result.outcome = "warn";
    result.message = "Enter your OpenSubtitles API key first.";
    return Promise.resolve(result);
  }
  const formats = osBase("") + "/infos/formats";
  return osCall("GET", formats, osHeaders(account, false))
    .then((plain) => {
      result.keyOnly = plain.call;
      return osCall("GET", formats, osHeaders(account, true));
    })
    .then((withXua) => {
      result.keyWithXua = withXua.call;
      const keyWorks = (result.keyOnly !== null && result.keyOnly.code === 200) || withXua.call.code === 200;
      if (!keyWorks) {
        result.message = "The API key didn't work.";
        return result;
      }
      if (account.username === "") {
        result.outcome = "warn";
        result.message = "The key works. Add your username and password to check the login.";
        return result;
      }
      const useXua = !(result.keyOnly && result.keyOnly.code === 200);
      return osCall("POST", osBase("") + "/login", osHeaders(account, useXua), { username: account.username, password: account.password }).then(
        (login) => {
          const user = field(login.data, "user");
          result.login = {
            code: login.call.code,
            message: login.call.message,
            allowed: toInt(field(user, "allowed_downloads")),
            level: fieldStr(user, "level"),
            baseUrl: fieldStr(login.data, "base_url"),
          };
          if (login.res.ok) {
            onToken(fieldStr(login.data, "token"), fieldStr(login.data, "base_url"));
            result.outcome = "ok";
          } else {
            result.message = "The key works, but the login didn't. Use your username, not your email.";
          }
          return result;
        },
      );
    })
    .then((r) => {
      r.at = Date.now();
      return r;
    });
}
