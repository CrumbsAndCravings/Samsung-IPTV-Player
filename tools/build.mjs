// Bundles the app into dist/, ready for `tizen package` (see tools/tizen.mjs).
//   node tools/build.mjs          production bundle
//   import { ... } for the dev server (tools/dev.mjs)
import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// A personal build can carry a login, languages, sync and OpenSubtitles settings in personal.json
// (git-ignored; see personal.example.json), so the TV signs in by itself. The dev
// harness ignores it unless ARANPLUS_PERSONAL names a file, so it never talks to the
// real provider by accident. Nothing from it is printed.
export function readPersonal({ dev = false } = {}) {
  const file = process.env.ARANPLUS_PERSONAL || (dev ? "" : path.join(root, "personal.json"));
  if (!file || !existsSync(file)) return null;
  let data;
  try {
    // Windows editors may start the file with a byte-order mark, which JSON doesn't allow.
    data = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`${path.basename(file)} isn't valid JSON: ${err.message}`, { cause: err });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path.basename(file)} must hold a JSON object`);
  const parts = [];
  if (data.server && data.username && data.password) parts.push("a login");
  if (Array.isArray(data.languages)) parts.push("languages " + data.languages.join(", "));
  if (data.sync && data.sync.url && data.sync.key) parts.push("sync");
  if (data.opensubtitles && data.opensubtitles.apiKey) parts.push("OpenSubtitles");
  if (data.transcoder && data.transcoder.url && data.transcoder.key) parts.push("the helper at " + data.transcoder.url);
  console.log(`personal build: ${path.basename(file)} with ${parts.join(", ") || "nothing usable"}`);
  return data;
}

export function esbuildOptions({ dev = false } = {}) {
  return {
    absWorkingDir: root,
    entryPoints: { app: "src/main.ts" },
    bundle: true,
    outdir: "dist",
    format: "iife",
    // The TV's engine: a 2020 Q60T runs Tizen 5.5 with Chromium 69.
    target: ["es2018", "chrome69"],
    loader: { ".ttf": "file", ".png": "file", ".wav": "file" },
    assetNames: "assets/[name]",
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __DEV__: String(dev), __PERSONAL__: JSON.stringify(readPersonal({ dev })) },
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    logLevel: "info",
  };
}

// config.xml carries its own version (Tizen reads it); keep it in step with package.json.
function checkConfigVersion() {
  const xml = readFileSync(path.join(root, "config.xml"), "utf8");
  const match = /<widget[^>]*\sversion="([^"]+)"/.exec(xml);
  if (!match || match[1] !== pkg.version) {
    throw new Error(`config.xml version (${match ? match[1] : "missing"}) must match package.json (${pkg.version})`);
  }
}

export function copyStatic() {
  checkConfigVersion();
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  for (const file of ["index.html", "config.xml", "icon.png"]) {
    copyFileSync(path.join(root, file), path.join(dist, file));
  }
  for (const file of ["OFL-Fredoka.txt", "OFL-Nunito.txt"]) {
    copyFileSync(path.join(root, "assets/fonts", file), path.join(dist, "assets", file));
  }
  copyFileSync(path.join(root, "THIRD_PARTY_NOTICES.txt"), path.join(dist, "THIRD_PARTY_NOTICES.txt"));
}

export async function build({ dev = false } = {}) {
  rmSync(dist, { recursive: true, force: true });
  await esbuild.build(esbuildOptions({ dev }));
  copyStatic();
  writeFileSync(path.join(dist, "build.txt"), `ARAN+ ${pkg.version} built ${new Date().toISOString()}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
