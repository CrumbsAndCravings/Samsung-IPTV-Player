// A video file's OpenSubtitles moviehash, for subtitles timed for this exact file. The
// helper on a computer at home reads it from the parts of the file it keeps anyway
// (data/transcoder.ts, /v1/info?hash=1). A file played straight from the provider gets
// none: reading its first and last 64 KB took the provider's one connection, so the
// search goes by TMDB id or name (the Roku app's 0.5.15). Hashes are remembered on the
// TV for the titles played last.

import { readJson, writeJson } from "../core/storage";
import { isObj, toStr } from "../core/utils";

const KEEP = 40;

function remembered(): { [key: string]: string } {
  const saved = readJson("oshash", "items");
  const out: { [key: string]: string } = {};
  if (isObj(saved)) for (const key of Object.keys(saved)) out[key] = toStr(saved[key]);
  return out;
}

// `key` names the title ("m:123", "e:456"); the URL itself holds the login.
export function knownHash(key: string): string {
  return remembered()[key] || "";
}

// Keeps a title's hash, newest last, for the titles played last.
export function rememberHash(key: string, hash: string): void {
  if (!hash) return;
  const all = remembered();
  delete all[key];
  all[key] = hash;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[old];
  writeJson("oshash", "items", all);
}
