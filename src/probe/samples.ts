// Finds one file of each kind the plan wants tried on the TV (section 2.6): HEVC in
// MKV, AVI (DivX/Xvid), H.264 in MP4, and DTS audio. It walks a few movie categories
// and asks get_vod_info for codecs until each slot has a title.

import { log } from "../core/log";
import { apiUrl, Creds } from "../core/utils";
import { Category, ListItem, parseCategories, parseList, parseVodInfo } from "../core/xtream";
import { eachLimited, getJson } from "../platform/http";

export type SlotId = "hevc-mkv" | "avi" | "h264-mp4" | "dts";

export interface Sample {
  key: string; // "m:<streamId>" or "e:<episodeId>"
  kind: "movie" | "episode";
  id: string;
  title: string;
  ext: string;
  poster: string;
  videoCodec: string;
  videoProfile: string;
  audioCodec: string;
  width: number;
}

export const SLOTS: { id: SlotId; label: string }[] = [
  { id: "hevc-mkv", label: "HEVC in MKV" },
  { id: "avi", label: "AVI (DivX/Xvid)" },
  { id: "h264-mp4", label: "H.264 in MP4" },
  { id: "dts", label: "DTS audio" },
];

// Which slots a file fits. Without codec details from the provider only the container
// can be judged, so `strict` false lets an MP4 of unknown codec stand in for H.264.
export function slotsFor(sample: Sample, strict = true): SlotId[] {
  const ext = sample.ext.toLowerCase();
  const video = sample.videoCodec.toLowerCase();
  const audio = sample.audioCodec.toLowerCase();
  const slots: SlotId[] = [];
  if (ext === "mkv" && (video === "hevc" || video === "h265")) slots.push("hevc-mkv");
  if (ext === "avi") slots.push("avi");
  if ((ext === "mp4" || ext === "m4v") && (video === "h264" || video === "avc" || (!strict && video === ""))) slots.push("h264-mp4");
  if (audio.indexOf("dts") === 0 || audio === "dca") slots.push("dts");
  return slots;
}

export type Slots = { [id in SlotId]?: Sample };

export interface FindResult {
  slots: Slots;
  extCounts: { [ext: string]: number };
  categoriesScanned: number;
  titlesSeen: number;
  infoChecked: number;
  withCodecs: number;
  moreAvi: Sample[]; // other AVI titles to try (container known, codecs not checked)
  message: string;
}

const MAX_CATEGORIES = 20;
const MAX_INFO_CALLS = 40;

// Order in which titles get a get_vod_info call: rare containers first.
export function infoQueue(items: ListItem[]): ListItem[] {
  const byExt: { [ext: string]: ListItem[] } = {};
  for (const item of items) (byExt[item.ext] = byExt[item.ext] || []).push(item);
  const take = (ext: string, n: number) => (byExt[ext] || []).slice(0, n);
  const others = Object.keys(byExt)
    .filter((ext) => ["avi", "mp4", "mkv"].indexOf(ext) < 0)
    .map((ext) => byExt[ext][0]);
  return take("avi", 2).concat(take("mp4", 4), others.slice(0, 4), take("mkv", 30));
}

export function findSamples(creds: Creds, progress: (text: string) => void, cancelled: () => boolean): Promise<FindResult> {
  const result: FindResult = { slots: {}, extCounts: {}, categoriesScanned: 0, titlesSeen: 0, infoChecked: 0, withCodecs: 0, moreAvi: [], message: "" };
  const items: ListItem[] = [];
  const seen: { [id: string]: boolean } = {};
  const haveContainers = () => (result.extCounts.avi || 0) > 0 && (result.extCounts.mkv || 0) >= 15 && (result.extCounts.mp4 || 0) > 0;

  progress("Reading movie categories…");
  return getJson(apiUrl(creds, "get_vod_categories"))
    .then((res) => {
      if (!res.ok) throw new Error(res.error);
      const categories = parseCategories(res.data).slice(0, MAX_CATEGORIES);
      if (categories.length === 0) throw new Error("The server listed no movie categories.");
      return eachLimited(
        categories,
        3,
        (category: Category) =>
          getJson(apiUrl(creds, "get_vod_streams", { category_id: category.id })).then((list) => {
            result.categoriesScanned++;
            progress("Looking through category " + result.categoriesScanned + " of " + categories.length + "…");
            if (!list.ok) return;
            for (const item of parseList(list.data, "movie")) {
              if (seen[item.id]) continue;
              seen[item.id] = true;
              items.push(item);
              const ext = item.ext || "?";
              result.extCounts[ext] = (result.extCounts[ext] || 0) + 1;
            }
          }),
        () => cancelled() || (result.categoriesScanned >= 8 && haveContainers()),
      );
    })
    .then(() => {
      result.titlesSeen = items.length;
      const queue = infoQueue(items).slice(0, MAX_INFO_CALLS);
      const allFilled = () => SLOTS.every((slot) => result.slots[slot.id] !== undefined);
      return eachLimited(
        queue,
        3,
        (item) =>
          getJson(apiUrl(creds, "get_vod_info", { vod_id: item.id })).then((res) => {
            result.infoChecked++;
            progress("Checking codecs: " + result.infoChecked + " of " + queue.length + "…");
            if (!res.ok) return;
            const info = parseVodInfo(res.data);
            const sample: Sample = {
              key: "m:" + item.id,
              kind: "movie",
              id: item.id,
              title: item.name,
              ext: (info.ext || item.ext).toLowerCase(),
              poster: item.poster,
              videoCodec: info.videoCodec,
              videoProfile: info.videoProfile,
              audioCodec: info.audioCodec,
              width: info.width,
            };
            if (sample.videoCodec !== "" || sample.audioCodec !== "") result.withCodecs++;
            for (const slot of slotsFor(sample, false)) {
              const current = result.slots[slot];
              // An MP4 with known H.264 beats one whose codec is unknown.
              if (!current || (slot === "h264-mp4" && current.videoCodec === "" && sample.videoCodec !== "")) result.slots[slot] = sample;
            }
          }),
        () => cancelled() || allFilled(),
      );
    })
    .then(() => {
      const chosen = result.slots.avi ? result.slots.avi.id : "";
      result.moreAvi = items
        .filter((item) => item.ext === "avi" && item.id !== chosen)
        .slice(0, 6)
        .map((item) => ({
          key: "m:" + item.id,
          kind: "movie" as const,
          id: item.id,
          title: item.name,
          ext: "avi",
          poster: item.poster,
          videoCodec: "",
          videoProfile: "",
          audioCodec: "",
          width: 0,
        }));
      if (result.infoChecked > 0 && result.withCodecs === 0) result.message = "Your provider doesn't report codecs, so only containers could be matched.";
      log("samples:", result.titlesSeen, "titles,", result.infoChecked, "checked,", result.withCodecs, "with codecs");
      return result;
    });
}
