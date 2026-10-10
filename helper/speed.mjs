// How fast your provider sends a film to this computer: one connection, as the TV
// streams it, over the internet path from your home to the provider. An internet speed
// test (several connections to a server nearby) doesn't show this. Run it on the
// computer the helper runs on (it shares the TV's internet), with nothing playing: the
// provider allows one connection at a time.
//
//   npm run speed                         a 4K film from the provider's list
//   npm run speed -- "Dune Part Two"      a film by name (4K copies first)

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpGet } from "./http-get.mjs";
import { providerUrl, redactor, speedVerdict } from "./plan.mjs";

const SECONDS = 20;
const HEAVY_KBPS = 15000; // a film this rich is worth testing with
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");

function fail(message) {
  console.error("\n" + message + "\n");
  process.exit(1);
}

if (!existsSync(personalPath)) fail(`There's no ${path.basename(personalPath)} here; the test needs your provider's login from it.`);
const personal = JSON.parse(readFileSync(personalPath, "utf8").replace(/^\uFEFF/, ""));
let server = String(personal.server || "").trim().replace(/\/+$/, "");
if (server && !/^https?:\/\//i.test(server)) server = "http://" + server;
const login = { server, username: String(personal.username || "").trim(), password: String(personal.password || "").trim() };
if (!login.server || !login.username || !login.password) fail(`${path.basename(personalPath)} needs your provider's login ("server", "username" and "password").`);
const redact = redactor(login, "");

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function api(params) {
  const query = new URLSearchParams({ username: login.username, password: login.password, ...params });
  const res = await httpGet(login.server + "/player_api.php?" + query, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (res.status !== 200) throw new Error("the provider said HTTP " + res.status);
  return JSON.parse(await readAll(res));
}

// The film: one matching the name asked for, or the richest of a few 4K copies (English
// 4K categories first). Some providers' "4K" copies are as light as 6 Mbit/s.
async function pickFilm(wanted) {
  const categories = (await api({ action: "get_vod_categories" })) || [];
  const label = (c) => String(c.category_name || "");
  const fourK = categories.filter((c) => /4k/i.test(label(c))).sort((a, b) => Number(/^en\b/i.test(label(b))) - Number(/^en\b/i.test(label(a))));
  const lists = [];
  for (const cat of fourK.length > 0 ? fourK.slice(0, 4) : categories.slice(0, 3)) lists.push(...((await api({ action: "get_vod_streams", category_id: String(cat.category_id) })) || []));
  const name = (m) => String(m.name || "");
  let candidates = wanted ? lists.filter((m) => name(m).toLowerCase().indexOf(wanted.toLowerCase()) >= 0) : lists;
  if (wanted && candidates.length === 0) {
    // Not among the 4K copies: any film by that name.
    candidates = ((await api({ action: "get_vod_streams" })) || []).filter((m) => name(m).toLowerCase().indexOf(wanted.toLowerCase()) >= 0);
  }
  if (candidates.length === 0) fail(wanted ? `No film named like "${wanted}" at your provider.` : "Your provider lists no films to test with.");
  // Newest first: recent 4K copies are the rich ones.
  candidates.sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  let best = null;
  for (const film of candidates.slice(0, wanted ? 1 : 12)) {
    const info = await api({ action: "get_vod_info", vod_id: String(film.stream_id) });
    const details = (info && info.info) || {};
    const found = {
      id: String(film.stream_id),
      name: name(film),
      ext: String((info && info.movie_data && info.movie_data.container_extension) || film.container_extension || "mkv"),
      kbps: Number(details.bitrate) || 0,
      seconds: Number(details.duration_secs) || 0,
    };
    if (wanted || found.kbps >= HEAVY_KBPS) return found;
    if (!best || found.kbps > best.kbps) best = found;
  }
  if (best && best.kbps > 0) return best;
  fail("Couldn't find a film with a listed rate to test with. Name one: npm run speed -- \"Dune Part Two\"");
  return null;
}

async function main() {
  const wanted = process.argv.slice(2).join(" ").trim();
  console.log("\nFinding a film to test with...");
  const film = await pickFilm(wanted);
  console.log(`  ${film.name.replace(/^[A-Z]{2} ★ /, "")}: ${film.kbps ? (film.kbps / 1000).toFixed(0) + " Mbit/s on average" : "its rate isn't listed"}`);
  // From a third of the way in, as the TV would be mid-film.
  const from = film.kbps && film.seconds ? Math.floor((film.kbps * 1000 * film.seconds) / 8 / 3) : 0;
  console.log(`\nDownloading ${SECONDS} seconds of it, as the TV streams it (one connection)...`);
  const asked = Date.now();
  const res = await httpGet(providerUrl(login, "movie", film.id, film.ext), { headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=" + from + "-" } });
  if (res.status !== 200 && res.status !== 206) {
    res.body.destroy();
    fail(`The provider said HTTP ${res.status}. Something else may be using your one connection (the TV, the helper, another device): stop it and run this again.`);
  }
  const firstByte = (Date.now() - asked) / 1000;
  const samples = [];
  let second = 0;
  let mark = Date.now();
  const started = mark;
  for await (const chunk of res.body) {
    second += chunk.length;
    if (Date.now() - mark >= 1000) {
      samples.push(second);
      process.stdout.write(`  ${samples.length}s: ${((second * 8) / 1e6).toFixed(0)} Mbit/s\n`);
      second = 0;
      mark = Date.now();
    }
    if (Date.now() - started >= SECONDS * 1000) break;
  }
  res.body.destroy();
  const result = speedVerdict(film.kbps, samples);
  console.log("");
  console.log(`The provider answered in ${firstByte.toFixed(1)} s and sent ${result.avg.toFixed(0)} Mbit/s on average, ${result.low.toFixed(0)} Mbit/s at its slowest 5 seconds.`);
  if (film.kbps) console.log(`This film needs about ${result.need.toFixed(0)} Mbit/s.`);
  console.log("");
  if (result.verdict === "fast") {
    console.log("Fast enough, with room to spare. If 4K films still pause on the TV, the hold-up is between");
    console.log("your router and the TV: a network cable, or 5 GHz Wi-Fi with the router closer, usually fixes it.");
  } else if (result.verdict === "slowstart") {
    const title = film.name.replace(/^[A-Z]{2} ★ /, "");
    console.log(`Fast once it gets going, but the connection starts slowly: its first ${result.slowSecs} seconds came at`);
    console.log(`${result.startLow.toFixed(0)} to ${result.startHigh.toFixed(0)} Mbit/s, under the ${result.need.toFixed(0)} this film needs, then ${result.afterAvg.toFixed(0)} on average. Every start`);
    console.log("and every jump opens a new connection, so each would begin like that. ARAN+ 0.8.6 and newer gather");
    console.log("5 seconds before starting a film like this, which should carry it through; it just takes a few");
    console.log("seconds longer to begin. Run this again on the same film: if it starts fast the second time, the");
    console.log("provider was fetching the film for the first time, and only first plays start slowly:");
    console.log(`  npm run speed -- "${title.replace(/ - \d{4}.*$/, "")}"`);
  } else if (result.verdict === "dips") {
    console.log("Enough on average, but it dips below what the film needs now and then. ARAN+ 0.8.6 and newer");
    console.log("give the TV a bigger buffer for films like this, which should carry it over dips like these.");
  } else if (result.verdict === "slow") {
    console.log("Slower than this film needs: the path from your home to the provider is the bottleneck, so 4K");
    console.log("copies this rich will pause whatever the TV does. Their 1080p copies (about 3 to 8 Mbit/s) play");
    console.log("smoothly. Evening traffic often slows it, so it's worth running this again at another time.");
  } else {
    console.log("Run it again with a film whose rate is listed, to compare: npm run speed -- \"Dune Part Two\"");
  }
  console.log("");
  process.exit(0);
}

main().catch((err) => fail("The test failed: " + redact(String(err && err.message ? err.message : err))));
