# ARAN+ for Samsung TVs

ARAN+ is a cosy, Netflix-style IPTV player for movies and series from an Xtream Codes provider. This repo is the Samsung Tizen version, built for a Samsung Q60 series 65" TV and laid out for 1920x1080. The Roku app ([CrumbsAndCravings/roku-iptv-player](https://github.com/CrumbsAndCravings/roku-iptv-player)) is the working reference for every feature, and its [`docs/samsung-plan.md`](https://github.com/CrumbsAndCravings/roku-iptv-player/blob/main/docs/samsung-plan.md) is the build plan this repo follows.

## Status: M0 (setup checks)

| | Scope | State |
|---|---|---|
| **M0** | Repo, config.xml, hello-world screen with fonts and palette, packaging and install scripts, the TV checks | Done on the TV; a few checks still open, see [docs/m0-findings.md](docs/m0-findings.md) |
| M1 | `core/` ports with tests, storage, mock server, desktop harness | Started: utils, Xtream parsing, storage |
| M2 | Login, Home, Details, account menu | |
| M3 | Player: controls, jump preview, resume, Up Next, errors | |
| M4 | Audio and subtitle tracks, OpenSubtitles | |
| M5 | Search, motion polish, performance pass | |

Right now the app opens on a **Setup checks** screen. It answers the questions the plan says to settle before building features (section 2), on the TV itself:

- **This TV:** web engine (Chromium version), Tizen version, model code, firmware, and the model year that code implies.
- **IPTV account:** one request from the packaged app to your Xtream server (proves cross-origin requests work), your account status, and category counts.
- **OpenSubtitles:** which headers actually leave the TV (a public echo service shows whether our `User-Agent` survives and whether `X-User-Agent` gets through), then your API key with and without `X-User-Agent`, then the login.
- **Range requests:** the first and last 64 KB of a stream, which OpenSubtitles' file fingerprint needs.
- **Playback:** finds an HEVC MKV, an AVI (DivX/Xvid), an H.264 MP4 and a file with DTS audio in your library and plays each with Samsung's player (AVPlay). **Find a title** lets you try a specific show, such as one the Roku couldn't play.
- **Report:** a summary of all of the above, safe to photograph. **Show report code** turns it into a QR code you can scan with a phone and paste into a chat.

Logins are hidden on screen unless you're typing them, and the log, report and QR code replace your server, usernames, passwords and API key with placeholders.

## One-time setup

You need the TV, a computer on the same Wi-Fi (Windows, Mac or Linux), and a free Samsung account. Samsung only installs apps signed for your TV, so a phone alone can't do the first install.

1. **Find the model code.** Settings > Support > About This TV, or the sticker on the back. In Canada it looks like `QN65Q60?AFXZC`; the letter after `Q60` is the year (R 2019, T 2020, A 2021, B 2022, C 2023, D 2024). The Setup checks screen also shows it.
2. **Developer mode on the TV.** Open Apps, then press 1 2 3 4 5 on the remote (the 123 button brings up the number pad). Turn Developer mode on, enter your computer's IP address, and restart the TV by holding the power button until it restarts.
3. **Tizen Studio on the computer.** Samsung's download page now points to its VS Code extension, because Tizen Studio is deprecated, but the last Tizen Studio (6.1) still installs and is what `npm run install:tv` uses. Download it straight from [download.tizen.org](https://download.tizen.org/sdk/Installer/tizen-studio_6.1/): on Windows, `web-ide_Tizen_Studio_6.1_windows-64.exe` (about 660 MB); on a Mac or Linux, the `web-ide` file for your system. Install it to the suggested folder (`C:\tizen-studio` on Windows, no spaces in the path). When Package Manager opens, go to **Extension SDK** and install **TV Extensions** (the newest) and **Samsung Certificate Extension**. Install [Node.js](https://nodejs.org) 22.12 or newer too.
4. **Connect.** In Tizen Studio's Device Manager, add the TV by its IP address and connect. Note the TV's DUID.
5. **Certificate.** In Certificate Manager, create a **Samsung** certificate profile (not Tizen), sign in with your Samsung account, choose TV, and include the TV's DUID. Name the profile, for example `ARANplus`. Back up the author and distributor `.p12` files and their passwords somewhere safe outside this repo.
6. **Local settings.** Copy `tizen.local.example.json` to `tizen.local.json` (ignored by git) and fill in the TV's IP and the profile name. If Tizen Studio isn't in `~/tizen-studio` (or `C:\tizen-studio`), set `tizenStudio` to where it is.

## Install on the TV

```sh
npm install
npm run install:tv
```

This builds the app, signs it into `out/ARANplus.wgt` with your certificate profile, installs it on the TV and opens it. ARAN+ stays in the TV's Apps list; run the same command again to update it. Developer mode can stay on.

Other commands: `npm run package` (build and sign only), `npm run run:tv` (open the installed app), `npm run debug:tv` (open it in debug mode and forward Chrome DevTools to your computer).

## M0 on the TV

1. Open ARAN+. The **This TV** card shows the engine and model.
2. **Your IPTV account:** press OK on each box to type with the TV keyboard (a full M3U link in Server fills in the rest), press Done, then **Save and test**.
3. **OpenSubtitles:** optional. **Save and test** checks the headers even without an account; with your API key, username and password it also checks the key and login.
4. **Playback:** press **Find test videos**, then OK on each file. Let it play for a few seconds, try Left/Right (jump 30 s), Up (next audio track) and Down (next subtitle track), then Back to save the result. Use **Find a title** for anything else worth trying.
5. Send the result back: a photo of the Report card, or **Show report code**, scan it with your phone's camera and paste the text into the chat.

M0 is done when the ARAN+ tile opens on the TV and shows the engine version, the IPTV check works, and an HEVC MKV and an AVI both play.

## Develop

```sh
npm install
npm run dev        # desktop harness on http://localhost:8080 (use a 1920x1080 window)
npm test           # unit tests (vitest)
npm run check      # typecheck, lint, tests, bundle, and an ES2018 syntax check of the bundle
npm run images     # regenerate icon.png and the glows (needs Pillow)
```

In the desktop harness the arrow keys, Enter, and Escape (as Back) stand in for the remote, and the player falls back to HTML5 video, which plays MP4 only. The TV-only APIs (`tizen`, `webapis`) are absent there, so the TV fields stay blank.

Every push runs the same checks on GitHub Actions and uploads the unsigned build as an artifact.

### The TV's engine

The TV is a 2020 Q60T (`QN65Q60TAFXZC`): Tizen 5.5 with Chromium 69. So:

- esbuild lowers syntax to ES2018 (`target: es2018, chrome69`), and CI checks the bundle parses as ES2018;
- TypeScript knows ES2018 plus `Array.flat` and `String.trimStart`, and lint blocks newer calls such as `replaceChildren`, `replaceAll`, `Object.fromEntries` and `globalThis`;
- CSS avoids flexbox `gap`, `aspect-ratio`, `inset`, `backdrop-filter` and `clamp()`.

### Layout

```
config.xml  index.html  icon.png     Tizen package files
src/
  main.ts                            boot, keys, background/foreground handling
  core/                              pure logic, unit tested (ports of the Roku app)
    utils.ts xtream.ts storage.ts    Utils.brs, XtreamParse.brs, Registry.brs
    opensubtitles.ts                 the parts of SubtitleTask.brs needed so far
    device.ts redact.ts log.ts       engine and model year, secret hiding, on-screen log
  platform/                          Tizen and browser APIs
    http.ts keys.ts tizen.ts         XHR with timeouts, remote keys, device info
    player.ts avplay.ts html5.ts     player interface, AVPlay, desktop <video>
  ui/                                dom helper, key routing (focus rules), spatial focus
  probe/                             the M0 setup checks screen
  styles/                            design tokens, base styles, screen styles
assets/fonts  assets/images          Fredoka and Nunito (SIL OFL), generated glows
tests/                               vitest
tools/                               build, dev server, Tizen CLI wrapper, image generator
```

### Keep secrets out of git

The IPTV login and OpenSubtitles details are typed on the TV and stay in its storage. Signing certificates and `tizen.local.json` stay on your computer (`.gitignore` covers `*.p12`, `*.pem`, `*.wgt` and `tizen.local.json`). Before pushing, check the diff for your provider's hostname and username.
