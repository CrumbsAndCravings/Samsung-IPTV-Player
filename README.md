# ARAN+ for Samsung TVs

ARAN+ is a cosy, Netflix-style IPTV player for movies and series from an Xtream Codes provider. This repo is the Samsung Tizen version, built for a Samsung Q60 series 65" TV and laid out for 1920x1080. The Roku app ([CrumbsAndCravings/roku-iptv-player](https://github.com/CrumbsAndCravings/roku-iptv-player)) is the working reference for every feature, and its [`docs/samsung-plan.md`](https://github.com/CrumbsAndCravings/roku-iptv-player/blob/main/docs/samsung-plan.md) is the build plan this repo follows.

## Status: M3 (the player)

| | Scope | State |
|---|---|---|
| **M0** | Repo, config.xml, hello-world screen with fonts and palette, packaging and install scripts, the TV checks | Done on the TV, see [docs/m0-findings.md](docs/m0-findings.md) |
| **M1** | `core/` ports with tests, storage, mock server, desktop harness | Done: every applicable Roku check is ported and passes, plus new subtitle-file and playability modules |
| **M2** | Login, Home, Details, account menu | Done: browsing works on the TV |
| **M3** | Player: controls, jump preview, resume, Up Next, errors | Built and tested in the desktop harness; waiting on a TV test |
| M4 | Audio and subtitle tracks, OpenSubtitles | |
| M5 | Search, motion polish, performance pass | |

What the app does now:

- **Sign in** with server, username and password (a full M3U link in Server fills in the rest). The login is checked with your provider before it's saved, on this TV only.
- **Home, Movies and Series tabs.** Home starts with Continue Watching, then your provider's first six movie and six series categories. Movies and Series list every category. Each row shows the 40 newest titles and more rows load as you scroll.
- **The hero** at the top shows the focused title's backdrop, year, runtime, genre, rating and plot; movie details arrive after you rest on a poster for a moment.
- **Details** for movies (Play, or Resume and Play from start) and series (seasons, with Specials first, and the episode list with stills, runtimes and synopses).
- **"Won't play"** marks titles this TV can't play (AVI, for now), with "Try anyway".
- **Account menu** (the round button at the right of the tabs): Keep watching, Setup checks, Sign out.
- **The player.** Back and the title at the top; play/pause, the bar and the times at the bottom; Episodes, Next episode and Restart underneath. The controls show when you press a key and hide after 5 seconds of playing.
- **Jump preview.** Press or hold **Left/Right** (or Rewind/Fast forward) and the bar shows where you'll land before you get there; the longer you hold, the bigger the steps. The jump happens a moment after you let go, **OK** jumps straight away and **Back** cancels.
- **Resume and Continue Watching.** Progress is saved every 15 seconds and when you leave. Resuming starts 5 seconds early. A movie drops out of Continue Watching when you finish it; a series moves on to the next episode.
- **Up Next** counts down 8 seconds at the end of an episode, then plays the next one (specials come after the last season). **OK** plays it now, **Back** stops.
- **Errors explain themselves.** A stream that fails is tried once more; if it fails again you see Samsung's reason, the file's format, whether this TV normally plays files like it, and the stream address with your login hidden. Files this TV can't play (AVI) say so before they try.
- Search comes in M5, audio and subtitle tracks in M4.

Remote: **Up** from the first row (or **Left** from a row's first poster) reaches the tabs. **Back** jumps to the first row, then the tabs, then asks to exit. On Details, **Down** reaches the seasons and episodes. In the player, **OK** pauses, **Up** reaches Back, **Down** reaches the buttons, **Back** hides the controls and then leaves, and **Stop** leaves at once.

The **Setup checks** screen from M0 is under the account menu. It checks the TV's engine and model, the connection to your provider and to OpenSubtitles, and plays test files, with a report that is safe to photograph or scan as a QR code (logins, server names and keys are replaced with placeholders).

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

## Setup checks on the TV

Account menu, then **Setup checks**:

1. The **This TV** card shows the engine and model.
2. **Your IPTV account:** press OK on each box to type with the TV keyboard (a full M3U link in Server fills in the rest), press Done, then **Save and test**.
3. **OpenSubtitles:** optional. **Save and test** checks the headers even without an account; with your API key, username and password it also checks the key and login.
4. **Playback:** press **Find test videos**, then OK on each file. Let it play for a few seconds, try Left/Right (jump 30 s), Up (next audio track) and Down (next subtitle track), then Back to save the result. Use **Find a title** for anything else worth trying.
5. Send the result back: a photo of the Report card, or **Show report code**, scan it with your phone's camera and paste the text into the chat.

The M0 results are in [docs/m0-findings.md](docs/m0-findings.md).

## Develop

```sh
npm install
npm run dev        # desktop harness and fake IPTV server on http://localhost:8080
npm test           # unit tests (vitest)
npm run check      # typecheck, lint, tests, bundle, and an ES2018 syntax check of the bundle
npm run screens    # screenshots of each screen from the harness, in out/screens
python3 tools/make_sample_video.py   # a 40 s test video for the harness player (dev/media, not committed)
npm run images     # regenerate icon.png and the glows (needs Pillow)
```

In the desktop harness the arrow keys, Enter, Escape (as Back), Space (play/pause) and comma and full stop (Rewind and Fast forward) stand in for the remote, and the player falls back to HTML5 video (MP4 and WebM only). The TV-only APIs (`tizen`, `webapis`) are absent there, so the TV fields stay blank.

The harness includes a fake Xtream server (`dev/mock-xtream.mjs`): sign in with server `localhost:8080`, username `demo`, password `demo`. It has a few hundred made-up movies and series with generated artwork, and it reproduces the real provider's quirks (numbers as strings, `info: []`, episodes as a plain array, title prefixes, adult categories). Streams play `dev/media/sample.webm` (made by `tools/make_sample_video.py`) or a `sample.mp4` you put there. No real account is ever needed to develop.

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
    utils.ts items.ts xtream.ts      Utils.brs and XtreamParse.brs: helpers, items, rows, details
    storage.ts progress.ts           Registry.brs and Progress.brs (Continue Watching)
    tracks.ts playback.ts            Tracks.brs and Playback.brs (track labels, seeking)
    search.ts                        SearchIndex.brs
    opensubtitles.ts oshash.ts       Subtitles.brs: queries, ranking, moviehash without BigInt
    srt.ts                           new: SRT/WebVTT parsing and cue lookup with a delay
    compat.ts                        new: will it play on this TV (M0 results plus what it learns)
    device.ts redact.ts log.ts       engine and model year, secret hiding, on-screen log
  platform/                          Tizen and browser APIs
    http.ts keys.ts tizen.ts         XHR with timeouts, remote keys, device info
    player.ts avplay.ts html5.ts     player interface, AVPlay, desktop <video>
  ui/                                dom helper, key routing (focus rules), posters, backdrop, dialogs
  app.ts                             the screen stack and shared dialogs
  data/api.ts                        Xtream calls: session cache, at most three at once
  screens/                           sign in, Home, Details, Setup checks
  probe/                             the M0 setup checks
  styles/                            design tokens, base styles, screen styles
assets/fonts  assets/images          Fredoka and Nunito (SIL OFL), generated glows
tests/                               vitest
dev/                                 fake Xtream server, screenshot script
tools/                               build, dev server, Tizen CLI wrapper, image generator
docs/m0-findings.md                  what the TV told us in M0, and the decisions it changed
```

### Keep secrets out of git

The IPTV login and OpenSubtitles details are typed on the TV and stay in its storage. Signing certificates and `tizen.local.json` stay on your computer (`.gitignore` covers `*.p12`, `*.pem`, `*.wgt` and `tizen.local.json`). Before pushing, check the diff for your provider's hostname and username.
