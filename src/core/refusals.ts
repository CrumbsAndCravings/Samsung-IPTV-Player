// What a refused request says, in words a photo of the screen can carry: who answered,
// what they said, and whether Cloudflare itself blocked it. Ported from the Roku app's
// Utils.brs (HttpDetail and friends, docs/features.md §2.3). Headers are passed with
// lower-case names.

import { field, firstText, Json } from "./utils";

export type Headers = { [name: string]: string };

// One short line from an error page: scripts, tags and extra spaces removed.
export function briefText(body: string, limit: number): string {
  let text = body.replace(/<(script|style)[^>]*>[\s\S]*?<\/(script|style)>/gi, " ");
  text = text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  // Error pages often repeat their title as a heading: "404 Not Found 404 Not Found".
  const repeated = /^(.{4,60}?) \1(?: |$)/.exec(text);
  if (repeated) text = (repeated[1] + " " + text.slice(repeated[0].length)).trim();
  if (text.length > limit) text = text.slice(0, limit - 1).trim() + "…";
  return text;
}

// True when the answer passed through Cloudflare (it may still come from the provider).
export function isCloudflare(headers: Headers): boolean {
  return (headers.server || "").toLowerCase().indexOf("cloudflare") >= 0 || (headers["cf-ray"] || "") !== "";
}

// What kind of Cloudflare refusal it was: a browser check (it needs JavaScript, so no TV
// app can pass it), a numbered error, or a plain block. "" when Cloudflare didn't say.
export function cloudflareKind(headers: Headers, body: string): string {
  const text = briefText(body, 4000);
  const lower = text.toLowerCase();
  if ((headers["cf-mitigated"] || "").toLowerCase() === "challenge") return " (browser check)";
  if (lower.indexOf("just a moment") >= 0 || body.toLowerCase().indexOf("challenge-platform") >= 0) return " (browser check)";
  const found = /(?:error code:?|error)\s*(1\d{3})/i.exec(text);
  if (found) return " (error " + found[1] + ")";
  if (lower.indexOf("you have been blocked") >= 0) return " (blocked)";
  return "";
}

// True when Cloudflare itself turned the request away, with one of its own pages.
// Every answer from a site behind Cloudflare carries its name, so the headers alone
// don't mean that (an early Roku build blamed Cloudflare wrongly).
export function isCloudflareBlock(headers: Headers, body: string): boolean {
  return isCloudflare(headers) && cloudflareKind(headers, body) !== "";
}

// Statuses that mean "not you, not now", where asking again only makes it worse.
export function isRefusalCode(code: number): boolean {
  return code === 401 || code === 403 || code === 429;
}

// Sums up a failed response, like: HTTP 403 from nginx: "Forbidden".
export function httpDetail(code: number, headers: Headers, body: string): string {
  let detail = "HTTP " + code;
  if (isCloudflare(headers)) {
    const kind = cloudflareKind(headers, body);
    if (kind !== "") return detail + " from Cloudflare" + kind;
    detail += " via Cloudflare";
  } else {
    const software = (headers.server || "").split(/[/ (]/)[0];
    if (software) detail += " from " + software;
  }
  const trimmed = body.trim();
  let said = "";
  if (trimmed.charAt(0) === "{") {
    let data: Json;
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = undefined;
    }
    said = firstText([field(data, "message"), field(data, "error")]);
  }
  if (said === "") said = trimmed;
  said = briefText(said, 70);
  if (said === "") return detail + ", no reason given";
  return detail + ': "' + said + '"';
}

// The sentence for a failed API request (Roku's fetchJson, with "this TV").
export function refusalText(code: number, headers: Headers, body: string): string {
  const detail = httpDetail(code, headers, body);
  if (isCloudflareBlock(headers, body)) return "Cloudflare, the provider's firewall, turned this TV away: " + detail + ".";
  if (isRefusalCode(code)) return "The server refused the request: " + detail + ".";
  return "The server answered " + detail + ".";
}

// The sign-in error: what happened, the address used (a missing port or http/https
// mix-up shows at a glance), then the usual causes for that status.
export function signInErrorText(error: string, server: string, code: number, cfBlock: boolean): string {
  let text = error + "\nAddress: " + server;
  if (cfBlock) text += "\nOnly the provider can allow it, or give you another address.";
  else if (isRefusalCode(code)) {
    text += "\nOften a typo in the login, an old address the provider has retired, a trial that has ended, or a block on your internet connection after too many attempts.";
  } else if (code === 404) {
    text += "\nNothing at this address answers as an Xtream server. Ask the provider for the Xtream or API address (often with a port like :8080), or paste their whole M3U link into Server.";
  }
  return text;
}
