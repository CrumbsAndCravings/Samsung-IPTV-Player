// Captures the app's screens from the desktop harness for review:
//   npm run screens        -> out/screens/*.png
// Signs in to the fake server (dev/mock-xtream.mjs); never uses a real account.
// Uses Playwright's Chromium, or the browser at CHROMIUM_PATH. The player shots need
// the test video from tools/make_sample_video.py and are skipped without it.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { root } from "../tools/build.mjs";
import { startDevServer } from "../tools/dev.mjs";

const port = 8099;
const out = path.join(root, "out", "screens");
mkdirSync(out, { recursive: true });

const server = await startDevServer({ port, watch: false });
const hasVideo = ["mp4", "webm"].some((ext) => existsSync(path.join(root, "dev", "media", "sample." + ext)));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
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
  await page.evaluate(() => {
    localStorage.clear();
    globalThis.indexedDB.deleteDatabase("aranplus");
  });
  // The intro, mid-way (ARAN punched in, rays out), then off for the rest: it keeps the
  // keys while it plays.
  await page.reload();
  await page.waitForSelector(".intro.is-playing");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "intro.png") });
  console.log("saved out/screens/intro.png");
  await page.evaluate(() => {
    // The languages a personal build would set (English, Hindi, Punjabi).
    localStorage.setItem("aranplus:prefs:languages", JSON.stringify(["en", "hi", "pa"]));
    localStorage.setItem("aranplus:prefs:player", JSON.stringify({ intro: "off" }));
  });
  await page.reload();
  await page.waitForSelector(".screen.login");
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
  await type("nope");
  await page.keyboard.press("Enter"); // refused: the error card replaces the tips
  await page.waitForSelector(".login-error:not(.is-hidden)");
  await shot("login-error");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("demo");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  await shot("login-filled");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.home");
  await page.waitForTimeout(2500);
  await shot("home");

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(1500);
  await shot("home-rows");

  // The end of a row: See all.
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  await shot("home-see-all");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.category");
  await page.waitForTimeout(1500);
  await shot("category-see-all");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  await page.keyboard.press("Backspace"); // Back: to the first row
  await page.keyboard.press("Backspace"); // Back: to the nav bar
  await page.keyboard.press("ArrowRight");
  await shot("home-nav");

  // Categories: cards by language, with counts from the stored library.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.categories");
  await page.waitForTimeout(2500);
  await shot("categories");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.category");
  await page.waitForTimeout(800);
  await shot("category");
  // Search this category, with the app's keyboard.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.type("the");
  await page.waitForTimeout(800);
  await shot("category-search");
  await page.keyboard.press("Backspace"); // close the keyboard, keeping the search
  await page.waitForTimeout(300);
  await shot("category-searched");
  await page.keyboard.press("Backspace"); // clear the search
  await page.keyboard.press("Backspace"); // back to Categories
  await page.waitForTimeout(300);
  await page.keyboard.press("Backspace"); // back to Home
  await page.waitForTimeout(300);

  // Search: the library is stored by now; type with a computer keyboard here.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".screen.search");
  await page.waitForTimeout(300);
  await shot("search");
  await page.keyboard.type("silver");
  await page.waitForTimeout(2000);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await shot("search-results");
  await page.keyboard.press("Backspace"); // results -> keyboard
  // Clear (straight down from the last column), then a search that finds a category.
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("punjabi");
  await page.waitForTimeout(2000);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await shot("search-categories");
  await page.keyboard.press("Backspace"); // results -> keyboard
  await page.keyboard.press("Backspace"); // back to Home
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
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

  if (hasVideo) {
    await page.keyboard.press("Enter"); // play the focused episode
    await page.waitForSelector(".player-controls.is-visible", { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot("player");

    // Hold Right: the jump is previewed on the bar before it happens.
    await page.keyboard.down("ArrowRight");
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250);
      await page.keyboard.down("ArrowRight");
    }
    await shot("player-preview");
    await page.keyboard.up("ArrowRight");
    await page.waitForTimeout(1200);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // Audio & subtitles
    await shot("player-tracks");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter"); // Episodes
    await shot("player-episodes");
    await page.keyboard.press("Backspace");

    // Jump to the end; Up Next counts down to the following episode.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.down("ArrowRight");
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(250);
      await page.keyboard.down("ArrowRight");
    }
    await page.keyboard.up("ArrowRight");
    await page.waitForSelector(".upnext.is-visible", { timeout: 20000 });
    await page.waitForTimeout(600);
    await shot("player-upnext");
    await page.keyboard.press("Backspace");
    await page.waitForSelector(".screen.details");
    await page.waitForTimeout(300); // keys are ignored for 150 ms after a screen change

    // A stream that fails twice ends on the error screen.
    await page.route("**/series/**", (route) => route.abort());
    await page.keyboard.press("Backspace"); // episodes -> buttons
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter"); // Play the next episode
    await page.waitForSelector(".player-error.is-visible", { timeout: 20000 });
    await shot("player-error");
    await page.unroute("**/series/**");
    await page.keyboard.press("Backspace");
    await page.waitForSelector(".screen.details");
    await page.waitForTimeout(300);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter"); // Home, with Continue Watching
    await page.waitForTimeout(2000);
    await shot("home-continue");
    // Holding OK on a Continue Watching poster offers to remove it.
    await page.keyboard.down("Enter");
    await page.waitForTimeout(900);
    await page.keyboard.up("Enter");
    await page.waitForSelector(".dialog-scrim");
    await shot("home-continue-menu");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    // A quick press opens it; Details offers to remove it too.
    await page.keyboard.press("Enter");
    await page.waitForSelector(".screen.details");
    await page.waitForTimeout(1500);
    await shot("details-continue");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
  } else {
    console.log("no dev/media/sample.webm: skipping the player (python3 tools/make_sample_video.py)");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
  }

  await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await shot("account-menu");

  // Online subtitles, with the fake OpenSubtitles (key, username and password "demo").
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".subtitle-setup");
  await page.waitForTimeout(300);
  await type("demo");
  await type("demo");
  await type("demo");
  await page.keyboard.press("Enter"); // Save and check
  await page.waitForTimeout(1200);
  await shot("subtitle-setup");

  if (hasVideo) {
    // Play an episode, search online and pick the best match.
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter"); // Series
    await page.waitForTimeout(2000);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".screen.details");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Enter"); // Play
    await page.waitForSelector(".player-controls.is-visible", { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // Audio & subtitles
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // Find English subtitles online
    await page.waitForTimeout(1200);
    await page.keyboard.press("Enter"); // the best match
    await page.waitForTimeout(1500);
    await shot("player-subtitles-panel");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(2000);
    await shot("player-subtitles");

    // Subtitle settings: timing a tenth of a second a step, which never downloads the
    // subtitles again, then the look.
    let downloads = 0;
    page.on("request", (req) => {
      if (/\/download$/.test(req.url())) downloads++;
    });
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter"); // Subtitle settings
    await page.waitForSelector(".player-substyle.is-visible");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(200);
    }
    await shot("player-subtitle-timing");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight"); // Netflix style
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight"); // See-through box
    await page.waitForTimeout(600);
    await shot("player-subtitle-style");
    if (downloads > 0) problems.push("Subtitle settings downloaded the subtitles " + downloads + " time(s)");
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("Page errors:\n" + problems.join("\n"));
  process.exit(1);
}
