// Captures the app's screens from the desktop harness for review:
//   npm run screens        -> out/screens/*.png
// Signs in to the fake server (dev/mock-xtream.mjs); never uses a real account.
// Uses Playwright's Chromium, or the browser at CHROMIUM_PATH.
/* global document */ // used inside page.evaluate, which runs in the browser
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { root } from "../tools/build.mjs";
import { startDevServer } from "../tools/dev.mjs";

const port = 8099;
const out = path.join(root, "out", "screens");
mkdirSync(out, { recursive: true });

const server = await startDevServer({ port, watch: false });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const problems = [];
page.on("pageerror", (err) => problems.push(err.message));

async function focusedText() {
  return page.evaluate(() => (document.querySelector(".is-focused") || {}).textContent || "");
}

async function moveTo(label, key = "ArrowDown", max = 60) {
  for (let i = 0; i < max; i++) {
    if ((await focusedText()).includes(label)) return;
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
  }
  throw new Error("Couldn't reach " + label);
}

async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, name + ".png") });
  console.log("saved out/screens/" + name + ".png");
}

try {
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate((p) => {
    localStorage.clear();
    localStorage.setItem("aranplus:account:creds", JSON.stringify({ server: "http://localhost:" + p, username: "demo", password: "demo" }));
  }, port);
  await page.reload();
  await shot("setup-checks");

  await moveTo("Save and test");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("setup-checks-iptv");

  await moveTo("Find test videos");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(8000);
  await shot("setup-checks-samples");
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("Page errors:\n" + problems.join("\n"));
  process.exit(1);
}
