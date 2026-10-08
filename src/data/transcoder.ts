// Talks to the ARAN+ helper (helper/aranplus-helper.mjs), which runs on a computer at
// home and turns files this TV can't play (AVI, DTS sound) into a stream it can. The
// helper holds the provider login; the TV only says which title, from when, and
// whether to repackage the picture ("copy") or convert it ("convert").

import type { Item } from "../core/items";
import { transcoderConfig } from "../core/personal";
import { readJson, writeJson } from "../core/storage";
import { field, fieldStr, isArr, isObj, toInt } from "../core/utils";
import { send } from "../platform/http";

export type VideoMode = "copy" | "convert";

export interface HelperInfo {
  duration: number; // seconds; 0 when the file doesn't say
  videoCodec: string;
  width: number;
  videoPlan: "copy" | "try" | "convert";
  audio: { codec: string; plan: string }[];
  hash: string; // the OpenSubtitles moviehash, when asked for ("" otherwise)
}

const TITLES_MAX = 200;

function params(item: Item): string {
  const kind = item.kind === "episode" ? "series" : "movie";
  return "kind=" + kind + "&id=" + encodeURIComponent(item.itemId) + "&ext=" + encodeURIComponent((item.ext || "mp4").toLowerCase());
}

function base(): { url: string; key: string } {
  const config = transcoderConfig();
  if (!config) throw new Error("No helper is set up.");
  return config;
}

export const HELPER_NO_ANSWER = "The helper on your computer didn't answer. Is the computer on, with the helper running?";

// Why a request to the helper failed, in words for the error screen (the Roku app's
// HelperFailure). code 0 means no answer.
export function helperFailure(code: number, timedOut: boolean, text: string): string {
  if (code === 0 || timedOut) return HELPER_NO_ANSWER;
  if (code === 401) return "The helper turned this TV away: its key doesn't match. Build the TV app again (npm run install:tv) with the helper's personal.json.";
  if (code === 404) return "The helper on your computer doesn't know this request, so it may be older than this app. Update it (git pull) and start it again.";
  let said: string;
  try {
    said = fieldStr(JSON.parse(text), "error");
  } catch {
    said = "";
  }
  return said ? "Your computer says: " + said : "The helper on your computer answered HTTP " + code + ".";
}

// Where the helper is, for the error screen ("" without one). Its key stays hidden.
export function helperAddress(): string {
  const config = transcoderConfig();
  return config ? config.url : "";
}

// What the file holds and how the helper would treat it. `startSecs` lets it keep its
// connection to the provider for a stream from the start; with `wantHash` it also
// fingerprints the file for online subtitles, in the same reads.
export function helperInfo(item: Item, startSecs = 0, wantHash = false): Promise<HelperInfo> {
  const config = base();
  const extra = "&start=" + Math.max(0, Math.floor(startSecs)) + (wantHash ? "&hash=1" : "");
  return send({ url: config.url + "/v1/info?key=" + encodeURIComponent(config.key) + "&" + params(item) + extra, timeoutMs: 45000 }).promise.then((res) => {
    if (res.code !== 200) throw new Error(helperFailure(res.code, res.timedOut, res.text));
    const data: unknown = JSON.parse(res.text);
    const video = field(data, "video");
    const audio = field(data, "audio");
    const plan = fieldStr(data, "videoPlan");
    return {
      duration: toInt(field(data, "duration")),
      videoCodec: fieldStr(video, "codec"),
      width: toInt(field(video, "width")),
      videoPlan: plan === "try" || plan === "convert" ? plan : "copy",
      audio: isArr(audio) ? audio.filter(isObj).map((a) => ({ codec: fieldStr(a, "codec"), plan: fieldStr(a, "plan") })) : [],
      hash: /^[0-9a-f]{16}$/.test(fieldStr(data, "hash")) ? fieldStr(data, "hash") : "",
    };
  });
}

// The converted stream, from `startSecs`.
export function helperStreamUrl(item: Item, startSecs: number, video: VideoMode): string {
  const config = base();
  return config.url + "/v1/stream?key=" + encodeURIComponent(config.key) + "&" + params(item) + "&start=" + Math.max(0, Math.floor(startSecs)) + "&video=" + video;
}

// Why the helper's last stream failed ("" when it doesn't say).
export function helperLastError(): Promise<string> {
  const config = base();
  return send({ url: config.url + "/v1/last-error?key=" + encodeURIComponent(config.key), timeoutMs: 8000 }).promise.then(
    (res) => {
      if (res.code !== 200) return "";
      try {
        return fieldStr(JSON.parse(res.text), "error");
      } catch {
        return "";
      }
    },
    () => "",
  );
}

// Whether this TV played DivX-style pictures repackaged ("copy") or only converted, by
// picture format, so the next file starts the right way.
export function learnedMode(codec: string): VideoMode | "" {
  const mode = fieldStr(readJson("helper", "modes"), codec);
  return mode === "copy" || mode === "convert" ? mode : "";
}

export function learnMode(codec: string, mode: VideoMode): void {
  if (!codec) return;
  const modes = readJson("helper", "modes");
  const next: { [codec: string]: string } = {};
  if (isObj(modes)) for (const k of Object.keys(modes)) next[k] = fieldStr(modes, k);
  next[codec] = mode;
  writeJson("helper", "modes", next);
}

// Titles that play but not properly on their own (only DTS sound, say), so they go
// through the helper from the start next time.
export function needsHelper(key: string): boolean {
  const list = readJson("helper", "titles");
  return isArr(list) && list.indexOf(key) >= 0;
}

export function rememberNeedsHelper(key: string): void {
  const list = readJson("helper", "titles");
  const keys = isArr(list) ? list.filter((k) => typeof k === "string" && k !== key) : [];
  writeJson("helper", "titles", [key].concat(keys as string[]).slice(0, TITLES_MAX));
}
