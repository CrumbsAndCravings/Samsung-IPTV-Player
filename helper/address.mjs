// Points the helper's address in personal.json at a computer: this one (no address
// given), or the one given, such as the Raspberry Pi the helper now runs on.
//
//   node helper/address.mjs                  this computer (helper/setup-pi.sh runs it)
//   npm run helper:address -- 192.168.1.50   on the PC, then npm run install:tv
//
// The key stays as it is, so the TV, the Roku and the phone keep the one they have.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lanAddress } from "./where.mjs";

const DEFAULT_PORT = 8090;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personalPath = process.env.ARANPLUS_PERSONAL || path.join(root, "personal.json");
const name = path.basename(personalPath);

function fail(message) {
  console.error("\n" + message + "\n");
  process.exit(1);
}

// "192.168.1.50", "192.168.1.50:8091" or "http://192.168.1.50:8090": the host and port.
function parseAddress(raw, port) {
  let text = String(raw || "").trim();
  if (!/^https?:\/\//i.test(text)) text = "http://" + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/^[0-9A-Za-z.-]+$/.test(url.hostname) || url.pathname.length > 1) return null;
  return { host: url.hostname, port: Number(url.port) || port };
}

if (!existsSync(personalPath)) fail(`There's no ${name} in ${path.dirname(personalPath)}. Copy it from the computer the helper ran on before.`);
let personal;
try {
  personal = JSON.parse(readFileSync(personalPath, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
  fail(`${name} isn't valid JSON: ${err.message}`);
}

const given = process.argv[2];
const old = personal.transcoder && typeof personal.transcoder === "object" ? personal.transcoder : {};
let oldPort = DEFAULT_PORT;
try {
  oldPort = Number(new URL(old.url).port) || DEFAULT_PORT;
} catch {
  // No address yet.
}
const where = given ? parseAddress(given, oldPort) : { host: lanAddress(), port: oldPort };
if (!where) fail(`"${given}" isn't an address. Give it like this:  npm run helper:address -- 192.168.1.50`);
if (given && !old.key) {
  // A new key here wouldn't match the one the helper has.
  fail(`${name} here has no helper key yet. Copy personal.json from the computer the helper runs on instead, then run npm run install:tv.`);
}

const url = `http://${where.host}:${where.port}`;
const changed = old.url !== url;
personal.transcoder = { ...old, url, key: old.key || randomBytes(12).toString("hex") };
writeFileSync(personalPath, JSON.stringify(personal, null, 2) + "\n");

console.log("");
if (!old.key) console.log(`The helper's address is ${url}, with a new key (in ${name}).`);
else console.log(changed ? `The helper's address is now ${url} (in ${name}; the key is the same).` : `The helper's address was already ${url}.`);
if (given) {
  console.log("Now run  npm run install:tv  so the TV uses it, and close the helper on this computer.");
  console.log(`For the Roku, put the same "transcoder" in its src/source/account.json and build it again.`);
}
console.log("");
