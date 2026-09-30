// OpenSubtitles helpers with no network, ported from the Roku app's SubtitleTask.brs.
// The rest (search, ranking, download, moviehash) arrives in M4.

import { field, fieldStr, isArr, Json, toStr } from "./utils";

export const APP_USER_AGENT = "ARANplus v" + __APP_VERSION__;

export function osBase(baseUrl: string): string {
  const host = baseUrl.trim() === "" ? "api.opensubtitles.com" : baseUrl.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return "https://" + host + "/api/v1";
}

export function serverMessage(data: Json): string {
  const message = fieldStr(data, "message");
  if (message !== "") return message;
  const errors = field(data, "errors");
  if (isArr(errors)) {
    return errors
      .map((e) => toStr(e))
      .filter((text) => text !== "")
      .join(" ");
  }
  return "";
}

// Puts OpenSubtitles' own words and the HTTP code in the message, so a photo of the
// screen says exactly what went wrong.
export function osErrorText(code: number, data: Json): string {
  if (code <= 0) return "Couldn't reach OpenSubtitles. Check the TV's internet connection.";
  let said = "OpenSubtitles said HTTP " + code;
  const message = serverMessage(data);
  if (message !== "") said += ": " + message;
  if (code === 406 || code === 429) return said + ". Downloads reset within a day.";
  return said + ".";
}

// "bytes 0-65535/1234567890" -> 1234567890; -1 when unknown.
export function parseContentRangeTotal(header: string): number {
  const slash = header.indexOf("/");
  if (slash < 0) return -1;
  const digits = header.slice(slash + 1).trim();
  if (!/^\d+$/.test(digits)) return -1;
  return Number(digits);
}
