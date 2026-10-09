// A personal build's own settings (personal.json, git-ignored, baked in by
// tools/build.mjs), ported from the Roku app's Registry.brs (BuiltInCreds,
// LanguagePrefs, SyncConfig) and MainScene.brs. docs/features.md §2.2, §4.2, §9.4.

import { noteMovedFrom } from "./account";
import { sha256Hex } from "./sha256";
import { loadCreds, readJson, readOsFields, regDelete, regRead, regWrite, saveCreds, saveOsAccount } from "./storage";
import { Creds, field, fieldStr, isArr, Json, normalizeServer, toStr } from "./utils";

let data: Json = typeof __PERSONAL__ === "undefined" ? null : __PERSONAL__;

// For tests.
export function usePersonal(value: Json): void {
  data = value;
}

// The login built into this package, or null.
export function builtInCreds(): Creds | null {
  const creds = { server: normalizeServer(fieldStr(data, "server")), username: fieldStr(data, "username").trim(), password: fieldStr(data, "password").trim() };
  if (creds.server === "" || creds.username === "" || creds.password === "") return null;
  return creds;
}

// Languages whose categories to show, like ["en", "hi", "pa"]; empty means all of them.
// A choice saved on the TV ("prefs:languages") comes first, then the personal build's.
export function languagePrefs(): string[] {
  const saved = readJson("prefs", "languages");
  if (isArr(saved)) return saved.map(toStr);
  const builtIn = field(data, "languages");
  if (isArr(builtIn)) return builtIn.map(toStr);
  return [];
}

// Where Continue Watching syncs to, or null when there's no sync service.
export function syncConfig(): { url: string; key: string } | null {
  const sync = field(data, "sync");
  let url = fieldStr(sync, "url").trim();
  const key = fieldStr(sync, "key").trim();
  if (url === "" || key === "") return null;
  if (url.charAt(url.length - 1) === "/") url = url.slice(0, -1);
  return { url, key };
}

// When this build carries a different login from the one the TV last saw, the saved
// login and Continue Watching (whose IDs belong to the old provider) are cleared, so
// the new one signs in by itself. Online subtitles are kept. Returns true when it did.
// A saved login for the same account is kept with its Continue Watching (unlike the
// Roku app, which clears it too), taking the build's password if that changed, or the
// build's server when only that changed (the provider's new address: same username and
// password).
export function applyBuiltInLogin(): boolean {
  const builtIn = builtInCreds();
  if (!builtIn) return false;
  const stamp = builtIn.server + " " + builtIn.username;
  const oldStamp = regRead("account", "builtIn") || "";
  if (oldStamp === stamp) return false;
  regWrite("account", "builtIn", stamp);
  // The build's address moved (the provider changed its domain): Continue Watching
  // follows from the old one at the next sync.
  const old = oldStamp.split(" ");
  if (old.length === 2 && old[1] === builtIn.username && old[0].toLowerCase() !== builtIn.server.toLowerCase()) noteMovedFrom(old[0], builtIn);
  const saved = loadCreds();
  const sameServer = !!saved && normalizeServer(saved.server).toLowerCase() === builtIn.server.toLowerCase();
  if (saved && saved.username === builtIn.username && (sameServer || saved.password === builtIn.password)) {
    if (!sameServer) noteMovedFrom(normalizeServer(saved.server), builtIn);
    if (!sameServer || saved.password !== builtIn.password) saveCreds(builtIn);
    return false;
  }
  regDelete("account", "creds");
  regDelete("progress", "items");
  regDelete("progress", "removed");
  return true;
}

// The helper on a computer at home that converts what this TV can't play (helper/),
// or null. The helper writes these into personal.json the first time it runs.
export function transcoderConfig(): { url: string; key: string } | null {
  const settings = field(data, "transcoder");
  let url = fieldStr(settings, "url").trim();
  const key = fieldStr(settings, "key").trim();
  if (url === "" || key === "") return null;
  if (url.charAt(url.length - 1) === "/") url = url.slice(0, -1);
  return { url, key };
}

export function helperOn(): boolean {
  return transcoderConfig() !== null;
}

// OpenSubtitles details built into this package ("opensubtitles": { apiKey, username,
// password }), or null. The API key alone is enough to search; a username needs its
// password, as in the setup screen.
export function builtInSubtitles(): { apiKey: string; username: string; password: string } | null {
  const os = field(data, "opensubtitles");
  const apiKey = fieldStr(os, "apiKey").trim();
  if (apiKey === "") return null;
  const username = fieldStr(os, "username").trim();
  const password = fieldStr(os, "password").trim();
  return username !== "" && password !== "" ? { apiKey, username, password } : { apiKey, username: "", password: "" };
}

// Sets up online subtitles with the build's OpenSubtitles details when the TV has none
// (a first start, or after signing out), or when the build's details changed since the
// TV last saw them. Details typed on the TV after that are kept. Returns true when it
// set them.
export function applyBuiltInSubtitles(): boolean {
  const builtIn = builtInSubtitles();
  if (!builtIn) return false;
  const stamp = sha256Hex(builtIn.apiKey + "\n" + builtIn.username + "\n" + builtIn.password).slice(0, 16);
  const saved = readOsFields();
  // Removed on the TV on purpose: the build's own stays off too, until sign-out or a build
  // with other details.
  const removed = field(readJson("opensubtitles", "account"), "removed") === true;
  if ((saved.apiKey !== "" || removed) && regRead("opensubtitles", "builtIn") === stamp) return false;
  regWrite("opensubtitles", "builtIn", stamp);
  if (saved.apiKey === builtIn.apiKey && saved.username === builtIn.username && saved.password === builtIn.password) return false;
  saveOsAccount({ ...builtIn, token: "", baseUrl: "" });
  return true;
}
