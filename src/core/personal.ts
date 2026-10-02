// A personal build's own settings (personal.json, git-ignored, baked in by
// tools/build.mjs), ported from the Roku app's Registry.brs (BuiltInCreds,
// LanguagePrefs, SyncConfig) and MainScene.brs. docs/features.md §2.2, §4.2, §9.4.

import { readJson, regDelete, regRead, regWrite } from "./storage";
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
export function applyBuiltInLogin(): boolean {
  const builtIn = builtInCreds();
  if (!builtIn) return false;
  const stamp = builtIn.server + " " + builtIn.username;
  if (regRead("account", "builtIn") === stamp) return false;
  regDelete("account", "creds");
  regDelete("progress", "items");
  regDelete("progress", "removed");
  regWrite("account", "builtIn", stamp);
  return true;
}
