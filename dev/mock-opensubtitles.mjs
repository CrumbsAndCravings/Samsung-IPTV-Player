// A fake OpenSubtitles for the desktop harness (npm run dev), so online subtitles can be
// tried without a real account. The app uses it when the API key is "demo" and it isn't
// running on a TV. Username "demo", password "demo"; anything else is refused.
//
// Searches return a few made-up results (one "matches this file" when a moviehash is
// sent, none for titles containing "nothing"), and every file has a line every 3 s that
// says when it should appear, so timing nudges are easy to check against the sample
// video's clock.

const PREFIX = "/mock-os/api/v1";
let remaining = 20;

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function clock(ms) {
  const pad = (n, w) => String(n).padStart(w, "0");
  const s = Math.floor(ms / 1000);
  return pad(Math.floor(s / 3600), 2) + ":" + pad(Math.floor(s / 60) % 60, 2) + ":" + pad(s % 60, 2) + "," + pad(ms % 1000, 3);
}

// A cue every 3 s for two hours, each saying when it belongs.
function srt(fileId) {
  const blocks = [];
  for (let i = 1; i <= 2400; i++) {
    const start = i * 3000;
    const s = start / 1000;
    const when = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    blocks.push(i + "\n" + clock(start) + " --> " + clock(start + 2000) + "\n<i>File " + fileId + "</i>\nThis line belongs at " + when);
  }
  return "﻿" + blocks.join("\n\n") + "\n";
}

function results(params) {
  const query = params.get("query") || "";
  if (query.indexOf("nothing") >= 0) return [];
  const name = query || "tmdb " + (params.get("tmdb_id") || params.get("parent_tmdb_id") || "?");
  const episode = params.get("type") === "episode" ? ".S" + String(params.get("season_number")).padStart(2, "0") + "E" + String(params.get("episode_number")).padStart(2, "0") : "";
  const release = (tag) => name.replace(/\s+/g, ".") + episode + "." + tag;
  const list = [
    { id: 9101, release: release("1080p.WEB-DL"), downloads: 52000 },
    { id: 9102, release: release("720p.BluRay"), downloads: 81000, sdh: true },
    { id: 9103, release: release("HDTV"), downloads: 99000, machine: true },
    { id: 9104, release: release("2160p.WEB"), downloads: 12000 },
  ];
  if (params.get("moviehash")) list.push({ id: 9100, release: release("this.exact.file"), downloads: 300, hash: true });
  return list.map((r) => ({
    id: String(r.id),
    type: "subtitle",
    attributes: {
      language: "en",
      release: r.release,
      download_count: r.downloads,
      hearing_impaired: !!r.sdh,
      machine_translated: !!r.machine,
      ai_translated: false,
      moviehash_match: !!r.hash,
      files: [{ file_id: r.id, file_name: r.release + ".srt" }],
    },
  }));
}

// Handles a request if it belongs to the fake OpenSubtitles; returns false otherwise.
export function handleMockOs(req, res) {
  const url = new URL(req.url, "http://localhost");
  const file = /^\/mock-os\/file\/(\d+)\.srt$/.exec(url.pathname);
  if (file) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(srt(file[1]));
    return true;
  }
  if (!url.pathname.startsWith(PREFIX)) return false;
  const path = url.pathname.slice(PREFIX.length);
  setTimeout(() => {
    if (req.headers["api-key"] !== "demo") return json(res, 403, { message: "You cannot consume this service" });
    if (path === "/infos/formats") return json(res, 200, { data: { output_formats: ["srt", "webvtt"] } });
    if (path === "/login" && req.method === "POST") {
      return readBody(req).then((body) => {
        if (body.username !== "demo" || body.password !== "demo") return json(res, 401, { message: "Error, invalid username/password" });
        json(res, 200, { user: { allowed_downloads: 20, level: "Sub leecher" }, base_url: "", token: "mock-token", status: 200 });
      });
    }
    if (path === "/subtitles") {
      const data = results(url.searchParams);
      return json(res, 200, { total_count: data.length, data });
    }
    if (path === "/download" && req.method === "POST") {
      return readBody(req).then((body) => {
        if (remaining <= 0) return json(res, 406, { message: "You have downloaded your allowed 20 subtitles for 24h" });
        remaining--;
        const host = req.headers.host || "localhost";
        json(res, 200, { link: "http://" + host + "/mock-os/file/" + body.file_id + ".srt", remaining });
      });
    }
    json(res, 404, { message: "Not found" });
  }, 150);
  return true;
}
