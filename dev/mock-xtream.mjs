// A fake Xtream Codes server for the desktop harness (npm run dev) and tests. Made-up
// titles and generated artwork only; no real provider data, no real logins.
//
// Sign in with server "localhost:8080", username "demo", password "demo". The username
// "expired" (password "demo") gets an expired account; anything else is refused.
//
// It reproduces the provider quirks the Roku app met (plan section 10): numbers as
// strings, empty objects as [], episodes as a plain array when season keys are
// sequential, "tmdb" or "tmdb_id", backdrop_path as a list, codecs under info.video and
// info.audio, "Show - S01E02 - " title prefixes, is_adult "1", Season 0 specials. And
// what the M0 checks found on the real one: MKV 79 %, MP4 19 %, AVI 2 %, one
// connection per account.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(here, "media");

// --- Deterministic made-up library ------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ADJECTIVES = ["Lavender", "Midnight", "Silver", "Hidden", "Last", "Golden", "Quiet", "Electric", "Paper", "Velvet", "Northern", "Crimson", "Sleeping", "Wild", "Glass", "Lucky", "Distant", "Burning", "Frozen", "Secret"];
const NOUNS = ["Lighthouse", "Orchard", "Harbour", "Signal", "Garden", "Kingdom", "Letters", "Station", "Horizon", "Machine", "Summer", "Island", "Circus", "Frontier", "Library", "River", "Parade", "Comet", "Bakery", "Detective"];
const GENRES = ["Action", "Comedy", "Drama", "Family", "Science Fiction", "Thriller", "Adventure", "Romance", "Mystery", "Animation"];
const PEOPLE = ["Ada Brooks", "Ravi Menon", "Lena Ortiz", "Sam Okafor", "Mia Chen", "Tom Keller", "Nora Walsh", "Omar Haddad", "Ivy Laurent", "Ben Adler"];
const PLOTS = [
  "A retired cartographer finds a map that redraws itself every night.",
  "Two rival bakers are snowed in together on the eve of a national contest.",
  "A small-town radio host starts receiving calls from next week.",
  "An orchestra on tour discovers its conductor has vanished mid-concert.",
  "A lighthouse keeper's letters reach a girl sixty years too late.",
  "A detective with no sense of direction has to cross a city of mazes.",
];

function pick(r, list) {
  return list[Math.floor(r() * list.length)];
}

function title(r) {
  const base = (r() < 0.5 ? "The " : "") + pick(r, ADJECTIVES) + " " + pick(r, NOUNS);
  return r() < 0.15 ? base + " " + (2 + Math.floor(r() * 3)) : base;
}

function ext(r) {
  const x = r();
  return x < 0.79 ? "mkv" : x < 0.98 ? "mp4" : "avi";
}

// Named the way real providers name them (docs/features.md §4.1): language codes, odd
// symbols, new-release and 4K categories, India split by language, and a few other
// languages that a personal build's language choice hides.
const VOD_CATEGORIES = [
  ["1", "EN ✪ ACTION"],
  ["2", "EN ✪ COMEDY"],
  [3, "EN ✪ DRAMA"],
  ["4", "EN ✪ FAMILY"],
  ["5", "EN ✪ SCI-FI"],
  ["6", "EN ✪ ACTION [4K]"],
  ["7", "DOCUMENTARIES"],
  ["8", "EN ✪ THRILLER"],
  ["9", "NEW RELEASES 2026"],
  ["10", "IN ✪ BOLLYWOOD"],
  ["11", "IN ✪ PUNJABI"],
  ["12", "FR ✪ ACTION"],
  ["13", "AR ✪ أفلام"],
  ["99", "XXX Adult"],
];

const SERIES_CATEGORIES = [
  ["21", "EN ◉ COMEDY SERIES"],
  ["22", "EN ◉ DRAMA SERIES"],
  [23, "EN ◉ CRIME"],
  ["24", "KIDS"],
  ["25", "DOCUSERIES"],
  ["26", "|UK| TOP 10 THIS WEEK"],
  ["27", "IN ◉ INDIAN"],
  ["28", "TR ◉ DIZI"],
  ["98", "Adult 18+"],
];

const BASE_TIME = 1760000000; // fixed, so the fixtures never change

function buildLibrary() {
  const movies = [];
  const moviesByCategory = {};
  let nextId = 1000;
  for (const [catId, catName] of VOD_CATEGORIES) {
    const r = rng(Number(catId) * 7919);
    const count = 28 + Math.floor(r() * 30);
    const list = [];
    for (let i = 0; i < count; i++) {
      const id = nextId++;
      const name = title(r);
      const year = 1985 + Math.floor(r() * 41);
      const container = ext(r);
      // Some providers tag titles with a language and end them with the year.
      const tagged = r() < 0.2 ? "EN ★ " + name + " - " + year : name;
      const m = {
        num: list.length + 1,
        name: tagged + (tagged === name && r() < 0.4 ? " (" + year + ")" : ""),
        stream_type: "movie",
        stream_id: r() < 0.5 ? id : String(id),
        stream_icon: "/mock-art/poster/m" + id + ".svg",
        rating: r() < 0.5 ? (5 + r() * 4).toFixed(1) : Math.round((5 + r() * 4) * 10) / 10,
        added: String(BASE_TIME - Math.floor(r() * 400) * 86400),
        category_id: String(catId),
        container_extension: container,
        is_adult: catName.indexOf("XXX") >= 0 || r() < 0.02 ? "1" : "0",
        year: String(year),
        genre: pick(r, GENRES),
        plot: pick(r, PLOTS),
      };
      if (r() < 0.5) m.tmdb = String(10000 + id);
      else m.tmdb_id = 10000 + id;
      list.push(m);
      movies.push(m);
    }
    moviesByCategory[String(catId)] = list;
  }

  const series = [];
  const seriesByCategory = {};
  let nextSeries = 500;
  for (const [catId, catName] of SERIES_CATEGORIES) {
    const r = rng(Number(catId) * 104729);
    const count = 14 + Math.floor(r() * 14);
    const list = [];
    for (let i = 0; i < count; i++) {
      const id = nextSeries++;
      const s = {
        num: list.length + 1,
        name: title(r),
        series_id: r() < 0.5 ? id : String(id),
        cover: "/mock-art/poster/s" + id + ".svg",
        plot: pick(r, PLOTS),
        cast: pick(r, PEOPLE) + ", " + pick(r, PEOPLE),
        director: pick(r, PEOPLE),
        genre: pick(r, GENRES) + ", " + pick(r, GENRES),
        releaseDate: 1990 + Math.floor(r() * 36) + "-0" + (1 + Math.floor(r() * 9)) + "-15",
        last_modified: String(BASE_TIME - Math.floor(r() * 300) * 86400),
        rating: (6 + r() * 3).toFixed(1),
        backdrop_path: ["/mock-art/backdrop/s" + id + ".svg"],
        category_id: String(catId),
        is_adult: catName.indexOf("18+") >= 0 ? "1" : "0",
      };
      if (r() < 0.5) s.tmdb = String(20000 + id);
      list.push(s);
      series.push(s);
    }
    seriesByCategory[String(catId)] = list;
  }
  return { movies, moviesByCategory, series, seriesByCategory };
}

const LIBRARY = buildLibrary();

function codecsFor(r, container) {
  if (container === "avi") return { video: { codec_name: "mpeg4", profile: "Advanced Simple Profile", width: 640, height: 272 }, audio: { codec_name: "mp3", channels: 2 } };
  const hevc = r() < 0.6;
  return {
    video: hevc
      ? { codec_name: "hevc", profile: r() < 0.5 ? "Main 10" : "Main", width: r() < 0.2 ? 3840 : 1920, height: 1080 }
      : { codec_name: "h264", profile: "High", width: 1920, height: 1080 },
    // A little DTS, which the real library sample didn't have, so that path gets tested.
    audio: { codec_name: r() < 0.04 ? "dts" : pick(r, ["aac", "aac", "eac3", "ac3"]), channels: r() < 0.5 ? 6 : 2 },
  };
}

function vodInfo(id) {
  const movie = LIBRARY.movies.find((m) => String(m.stream_id) === String(id));
  if (!movie) return { info: [], movie_data: [] };
  const r = rng(Number(id) * 31);
  const secs = 5000 + Math.floor(r() * 3000);
  const hms = [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60].map((n) => String(n).padStart(2, "0")).join(":");
  // One in ten answers has no details at all (the "info": [] quirk).
  if (Number(id) % 10 === 3) return { info: [], movie_data: { stream_id: movie.stream_id, container_extension: movie.container_extension } };
  const info = {
    plot: movie.plot,
    releasedate: movie.year + "-06-01",
    genre: movie.genre + ", " + pick(r, GENRES),
    rating: String(movie.rating),
    cast: pick(r, PEOPLE) + ", " + pick(r, PEOPLE),
    director: pick(r, PEOPLE),
    backdrop_path: ["/mock-art/backdrop/m" + id + ".svg"],
    movie_image: movie.stream_icon,
    tmdb_id: movie.tmdb || String(movie.tmdb_id || ""),
    ...codecsFor(r, movie.container_extension),
  };
  if (r() < 0.5) info.duration_secs = secs;
  else info.duration = hms;
  return { info, movie_data: { stream_id: movie.stream_id, name: movie.name, container_extension: movie.container_extension } };
}

function seriesInfo(id) {
  const show = LIBRARY.series.find((s) => String(s.series_id) === String(id));
  if (!show) return { seasons: [], info: [], episodes: [] };
  const r = rng(Number(id) * 131);
  const seasonCount = 1 + Math.floor(r() * 4);
  const hasSpecials = r() < 0.3;
  const episodes = {};
  const seasons = [];
  let epId = Number(id) * 1000;
  const numbers = (hasSpecials ? [0] : []).concat(Array.from({ length: seasonCount }, (_, i) => i + 1));
  for (const n of numbers) {
    const count = n === 0 ? 2 : 6 + Math.floor(r() * 7);
    const list = [];
    for (let e = 1; e <= count; e++) {
      const container = ext(r);
      const epTitle = pick(r, ADJECTIVES) + " " + pick(r, NOUNS);
      const prefixed = r() < 0.6 ? show.name + " - S" + String(n).padStart(2, "0") + "E" + String(e).padStart(2, "0") + " - " + epTitle : epTitle;
      const info =
        r() < 0.1
          ? []
          : {
              name: r() < 0.3 ? epTitle : undefined,
              plot: pick(r, PLOTS),
              duration_secs: 1300 + Math.floor(r() * 1400),
              movie_image: "/mock-art/still/e" + epId + ".svg",
              ...codecsFor(r, container),
            };
      list.push({ id: String(epId++), episode_num: r() < 0.5 ? e : String(e), title: prefixed, container_extension: container, season: n, info });
    }
    // Out of order, as real servers sometimes send them.
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    episodes[String(n)] = list;
    if (n > 0) seasons.push({ season_number: n, name: r() < 0.2 ? "The " + pick(r, ADJECTIVES) + " Season" : "Season " + n, episode_count: String(count) });
  }
  const info = {
    name: show.name,
    cover: show.cover,
    plot: show.plot,
    cast: show.cast,
    director: show.director,
    genre: show.genre,
    releaseDate: show.releaseDate,
    rating: show.rating,
    backdrop_path: show.backdrop_path,
    tmdb: show.tmdb || "",
  };
  // Sequential season keys starting at 1 sometimes come back as a plain array (PHP).
  const sequential = !hasSpecials && Number(id) % 3 === 0;
  return { seasons, info, episodes: sequential ? numbers.map((n) => episodes[String(n)]) : episodes };
}

// --- Artwork: simple SVGs in the ARAN+ palette ------------------------------------

const PALETTES = [
  ["#43377A", "#FF9ECF"],
  ["#30275A", "#B9A3FF"],
  ["#241C42", "#FFD98A"],
  ["#1E1736", "#C9B8FF"],
  ["#43377A", "#9EE6D2"],
];

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

function nameFor(key) {
  const kind = key[0];
  const id = key.slice(1);
  if (kind === "m") return (LIBRARY.movies.find((m) => String(m.stream_id) === id) || {}).name || "Movie";
  if (kind === "s") return (LIBRARY.series.find((s) => String(s.series_id) === id) || {}).name || "Series";
  return "Episode " + id;
}

function art(kind, key) {
  const [w, h] = kind === "poster" ? [342, 513] : kind === "backdrop" ? [1280, 720] : [300, 169];
  const n = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
  const [from, to] = PALETTES[n % PALETTES.length];
  const label = escapeXml(nameFor(key).replace(/^EN - /, "").replace(/ \(\d{4}\)$/, ""));
  const size = kind === "poster" ? 30 : kind === "backdrop" ? 64 : 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w * 0.78}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" fill-opacity="0.14"/>
<text x="${w / 2}" y="${h * (kind === "poster" ? 0.78 : 0.55)}" font-family="Fredoka, sans-serif" font-size="${size}" font-weight="600" fill="#F7F3FF" text-anchor="middle">${label}</text>
</svg>`;
}

// --- HTTP ---------------------------------------------------------------------------

const ACCOUNTS = {
  demo: { password: "demo", status: "Active" },
  expired: { password: "demo", status: "Expired" },
};

export function playerApi(params) {
  const account = ACCOUNTS[params.get("username") || ""];
  if (!account || account.password !== params.get("password")) return { user_info: { auth: 0 } };
  const action = params.get("action") || "";
  const category = params.get("category_id");
  switch (action) {
    case "":
      return {
        user_info: {
          username: params.get("username"),
          auth: 1,
          status: account.status,
          exp_date: String(BASE_TIME + 365 * 86400),
          max_connections: "1",
          active_cons: "0",
        },
        server_info: { url: "localhost", port: "8080", server_protocol: "http" },
      };
    case "get_vod_categories":
      return VOD_CATEGORIES.map(([id, name]) => ({ category_id: id, category_name: name, parent_id: 0 }));
    case "get_series_categories":
      return SERIES_CATEGORIES.map(([id, name]) => ({ category_id: id, category_name: name, parent_id: 0 }));
    case "get_vod_streams":
      return category ? LIBRARY.moviesByCategory[category] || [] : LIBRARY.movies;
    case "get_series":
      return category ? LIBRARY.seriesByCategory[category] || [] : LIBRARY.series;
    case "get_vod_info":
      return vodInfo(params.get("vod_id"));
    case "get_series_info":
      return seriesInfo(params.get("series_id"));
    default:
      return [];
  }
}

// dev/media/sample.<ext> for the file type asked for (sample.avi, to try the helper in
// helper/), otherwise sample.mp4 or sample.webm.
function sampleMedia(ext) {
  if (!existsSync(MEDIA)) return null;
  const files = readdirSync(MEDIA);
  const own = "sample." + ext;
  if (ext && files.indexOf(own) >= 0) return path.join(MEDIA, own);
  const file = files.find((f) => /^sample\.(mp4|webm)$/.test(f));
  return file ? path.join(MEDIA, file) : null;
}

const TYPES = { webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska" };

// Streams play a sample from dev/media when there is one, with Range support.
function serveStream(req, res) {
  const ext = (/\.([a-z0-9]+)$/i.exec(new URL(req.url, "http://localhost").pathname) || ["", ""])[1].toLowerCase();
  const file = sampleMedia(ext);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No sample video. Put one at dev/media/sample.mp4.");
    return;
  }
  const size = statSync(file).size;
  const type = TYPES[path.extname(file).slice(1)] || "video/mp4";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!range) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(file).pipe(res);
    return;
  }
  let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}

// Handles a request if it belongs to the fake server; returns false otherwise.
export function handleMock(req, res) {
  const url = new URL(req.url, "http://localhost");
  const delay = Number(process.env.MOCK_DELAY_MS || 120);
  if (url.pathname === "/player_api.php") {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(playerApi(url.searchParams)));
    }, delay);
    return true;
  }
  const artMatch = /^\/mock-art\/(poster|backdrop|still)\/([mse]\d+)\.svg$/.exec(url.pathname);
  if (artMatch) {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
    res.end(art(artMatch[1], artMatch[2]));
    return true;
  }
  if (/^\/(movie|series)\/[^/]+\/[^/]+\/[^/]+\.\w+$/.test(url.pathname)) {
    serveStream(req, res);
    return true;
  }
  return false;
}
