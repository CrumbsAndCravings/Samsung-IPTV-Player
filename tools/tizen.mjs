// Signs, installs, launches and debugs ARAN+ on the TV with Samsung's Tizen CLI (part
// of Tizen Studio). Run through npm:
//   npm run package      build dist/ and sign it into out/ARANplus.wgt
//   npm run install:tv   package, install on the TV and open it
//   npm run run:tv       open the installed app
//   npm run debug:tv     open it in debug mode and forward DevTools to this computer
//
// Settings come from tizen.local.json (kept out of git; copy tizen.local.example.json)
// or environment variables, which win:
//   TV_IP          the TV's IP address (the TV's Developer mode must point at this computer)
//   TIZEN_PROFILE  the certificate profile name from Tizen Studio's Certificate Manager
//   TIZEN_STUDIO   where Tizen Studio is installed (default ~/tizen-studio or C:\tizen-studio)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, dist, root } from "./build.mjs";

const APP_ID = "ARANplus01.ARANplus";
const WGT = "ARANplus.wgt";
const out = path.join(root, "out");
const windows = process.platform === "win32";

function settings() {
  const file = path.join(root, "tizen.local.json");
  const local = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return {
    tvIp: process.env.TV_IP || local.tvIp || "",
    profile: process.env.TIZEN_PROFILE || local.profile || "",
    studio: process.env.TIZEN_STUDIO || local.tizenStudio || path.join(windows ? "C:\\" : os.homedir(), "tizen-studio"),
  };
}

function fail(message) {
  console.error("\n" + message + "\n");
  process.exit(1);
}

// The CLI tools inside Tizen Studio, or the bare names if they are on PATH.
function tool(studio, name) {
  const candidates =
    name === "tizen"
      ? [path.join(studio, "tools", "ide", "bin", windows ? "tizen.bat" : "tizen")]
      : [path.join(studio, "tools", windows ? "sdb.exe" : "sdb")];
  return candidates.find((p) => existsSync(p)) || name;
}

function quote(arg) {
  return windows && /[\s"]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg;
}

function run(cmd, args, { capture = false } = {}) {
  console.log("> " + [cmd].concat(args).join(" "));
  // .bat files need a shell on Windows.
  const result = spawnSync(windows ? quote(cmd) : cmd, windows ? args.map(quote) : args, {
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: windows,
    encoding: "utf8",
  });
  if (result.error) fail("Couldn't run " + cmd + ": " + result.error.message + "\nIs Tizen Studio installed? Set TIZEN_STUDIO or tizenStudio in tizen.local.json.");
  if (capture && result.stdout) process.stdout.write(result.stdout);
  return { status: result.status, stdout: result.stdout || "" };
}

async function packageApp() {
  const s = settings();
  if (!s.profile) fail("No signing profile. Create a Samsung certificate profile in Tizen Studio's Certificate Manager, then set TIZEN_PROFILE or \"profile\" in tizen.local.json.");
  await build();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const res = run(tool(s.studio, "tizen"), ["package", "-t", "wgt", "-s", s.profile, "-o", out, "--", dist]);
  const made = readdirSync(out)
    .filter((f) => f.endsWith(".wgt"))
    .map((f) => path.join(out, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (res.status !== 0 || made.length === 0) fail("Packaging failed (see the Tizen CLI output above).");
  const target = path.join(out, WGT);
  if (made[0] !== target) renameSync(made[0], target);
  console.log("\nSigned package: " + path.relative(root, target));
  return target;
}

function serial(s) {
  if (!s.tvIp) fail("No TV address. Set TV_IP or \"tvIp\" in tizen.local.json (the TV shows its IP under Settings > General > Network > Network Status > IP Settings).");
  return s.tvIp.indexOf(":") >= 0 ? s.tvIp : s.tvIp + ":26101";
}

function connect(s) {
  const target = serial(s);
  const res = run(tool(s.studio, "sdb"), ["connect", target], { capture: true });
  if (res.status !== 0 || /failed|unable|error/i.test(res.stdout)) {
    fail("Couldn't connect to the TV at " + target + ". Check it's on, on the same network, and that Developer mode on the TV has this computer's IP.");
  }
  return target;
}

async function installApp() {
  const s = settings();
  await packageApp();
  const target = connect(s);
  const res = run(tool(s.studio, "tizen"), ["install", "-n", WGT, "-s", target, "--", out]);
  if (res.status !== 0) fail("Install failed. A certificate error usually means the Samsung certificate doesn't include this TV's DUID.");
  launch(s, target);
}

function launch(s, target) {
  run(tool(s.studio, "tizen"), ["run", "-p", APP_ID, "-s", target]);
}

function debugApp() {
  const s = settings();
  const target = connect(s);
  const sdb = tool(s.studio, "sdb");
  const res = run(sdb, ["-s", target, "shell", "0", "debug", APP_ID], { capture: true });
  const match = /port:\s*(\d+)/i.exec(res.stdout);
  if (!match) fail("The TV didn't give a debug port. Is ARAN+ installed?");
  const port = match[1];
  run(sdb, ["-s", target, "forward", "tcp:" + port, "tcp:" + port]);
  console.log("\nIn Chrome on this computer, open chrome://inspect, choose Configure, add localhost:" + port + ", and inspect ARAN+.");
}

const command = process.argv[2];
if (command === "package") await packageApp();
else if (command === "install") await installApp();
else if (command === "run") launch(settings(), connect(settings()));
else if (command === "debug") debugApp();
else fail("Usage: node tools/tizen.mjs package | install | run | debug");
