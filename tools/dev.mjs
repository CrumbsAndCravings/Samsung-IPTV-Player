// Desktop harness: rebuilds on save and serves dist/ at http://localhost:8080.
// Arrow keys, Enter, and Escape (or Backspace) as Back. No Tizen APIs here, so the
// player falls back to HTML5 video (MP4 only).
import * as esbuild from "esbuild";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { copyStatic, dist, esbuildOptions } from "./build.mjs";

const port = Number(process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

const ctx = await esbuild.context(esbuildOptions({ dev: true }));
await ctx.rebuild();
copyStatic();
await ctx.watch();

http
  .createServer((req, res) => {
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
  })
  .listen(port, () => console.log(`ARAN+ dev harness on http://localhost:${port} (1920x1080 window recommended)`));
