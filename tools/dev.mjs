// Desktop harness: rebuilds on save and serves dist/ at http://localhost:8080, along
// with the fake Xtream server in dev/mock-xtream.mjs (sign in with server
// "localhost:8080", username "demo", password "demo").
// Arrow keys, Enter, and Escape (or Backspace) as Back. No Tizen APIs here, so the
// player falls back to HTML5 video (MP4 and WebM only).
import * as esbuild from "esbuild";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleMockOs } from "../dev/mock-opensubtitles.mjs";
import { handleMock } from "../dev/mock-xtream.mjs";
import { copyStatic, dist, esbuildOptions } from "./build.mjs";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

function serveApp(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  // index.html loads Samsung's API script from $WEBAPIS, which only exists on the TV.
  if (pathname.startsWith("/$WEBAPIS/")) {
    res.writeHead(200, { "Content-Type": types[".js"] });
    res.end("/* webapis is only available on the TV */");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(dist, path.normalize(pathname));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}

// Builds once (and keeps rebuilding when `watch`), then serves the app and the fake
// server. Resolves with the running server.
export async function startDevServer({ port = Number(process.env.PORT || 8080), watch = true } = {}) {
  const ctx = await esbuild.context(esbuildOptions({ dev: true }));
  await ctx.rebuild();
  copyStatic();
  if (watch) await ctx.watch();
  else await ctx.dispose();
  const server = http.createServer((req, res) => {
    if (!handleMock(req, res) && !handleMockOs(req, res)) serveApp(req, res);
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  await startDevServer({ port });
  console.log(`ARAN+ dev harness on http://localhost:${port} (1920x1080 window recommended)`);
  console.log(`Fake IPTV server: sign in with server localhost:${port}, username demo, password demo`);
}
