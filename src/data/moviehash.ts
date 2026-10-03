// A video file's OpenSubtitles moviehash, from two range requests for its first and last
// 64 KB. The provider allows one connection, so this runs before the video opens, never
// while it plays (docs/m0-findings.md). Best effort: any trouble means no hash, and the
// search goes on without it. Hashes are remembered on the TV for the titles played last.

import { parseContentRangeTotal } from "../core/opensubtitles";
import { osHashHex } from "../core/oshash";
import { readJson, writeJson } from "../core/storage";
import { isObj, toStr } from "../core/utils";
import { send } from "../platform/http";

const CHUNK = 65536;
const KEEP = 40;

function chunk(url: string, from: number, to: number): Promise<{ bytes: Uint8Array; total: number } | null> {
  return send({ url, headers: { Range: "bytes=" + from + "-" + to }, responseType: "arraybuffer", timeoutMs: 8000, maxBytes: CHUNK * 2 }).promise.then((res) => {
    if (res.code !== 206 || !res.buffer || res.buffer.byteLength !== CHUNK) return null;
    return { bytes: new Uint8Array(res.buffer), total: parseContentRangeTotal(res.header("Content-Range") || "") };
  });
}

function computeHash(url: string): Promise<string> {
  return chunk(url, 0, CHUNK - 1).then((head) => {
    if (!head || head.total < CHUNK * 2) return "";
    return chunk(url, head.total - CHUNK, head.total - 1).then((tail) => (tail ? osHashHex(head.bytes, tail.bytes, head.total) : ""));
  });
}

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

export function movieHash(key: string, url: string): Promise<string> {
  const known = knownHash(key);
  if (known) return Promise.resolve(known);
  return computeHash(url)
    .catch(() => "")
    .then((hash) => {
      rememberHash(key, hash);
      return hash;
    });
}
