// Captures the app's screens from the desktop harness for review:
//   npm run screens        -> out/screens/*.png
// Signs in to the fake server (dev/mock-xtream.mjs); never uses a real account.
// Uses Playwright's Chromium, or the browser at CHROMIUM_PATH.
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

async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, name + ".png") });
  console.log("saved out/screens/" + name + ".png");
}

try {
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await shot("login");

  // Sign in to the fake server with the keyboard, as on the TV.
  const type = async (text) => {
    await page.keyboard.press("Enter");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
  };
  await type("localhost:" + port);
  await type("demo");
  await type("demo");
  await shot("login-filled");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.home");
  await page.waitForTimeout(2500);
  await shot("home");

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(1500);
  await shot("home-rows");

  await page.keyboard.press("Backspace"); // Back: to the first row
  await page.keyboard.press("Backspace"); // Back: to the nav bar
  await page.keyboard.press("ArrowRight");
  await shot("home-nav");
  await page.keyboard.press("Enter"); // Movies
  await page.waitForTimeout(2500);
  await shot("movies");

  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.details");
  await page.waitForTimeout(1500);
  await shot("details-movie");

  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter"); // Series
  await page.waitForTimeout(2500);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.details");
  await page.waitForTimeout(1500);
  await shot("details-series");
  await page.keyboard.press("ArrowDown");
  await shot("details-seasons");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await shot("details-episodes");

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await shot("account-menu");
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("Page errors:\n" + problems.join("\n"));
  process.exit(1);
}
