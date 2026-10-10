# ARAN+ for Samsung TVs

ARAN+ is a cosy, Netflix-style IPTV player for movies and series from an Xtream Codes provider. This repo is the Samsung Tizen version, built for a Samsung Q60 series 65" TV and laid out for 1920x1080. The Roku app ([CrumbsAndCravings/roku-iptv-player](https://github.com/CrumbsAndCravings/roku-iptv-player)) is the working reference for every feature, and its [`docs/samsung-plan.md`](https://github.com/CrumbsAndCravings/roku-iptv-player/blob/main/docs/samsung-plan.md) is the build plan this repo follows.

## Status: M5, plus the Roku app's 0.4.25 features

| | Scope | State |
|---|---|---|
| **M0** | Repo, config.xml, hello-world screen with fonts and palette, packaging and install scripts, the TV checks | Done on the TV, see [docs/m0-findings.md](docs/m0-findings.md) |
| **M1** | `core/` ports with tests, storage, mock server, desktop harness | Done: every applicable Roku check is ported and passes, plus new subtitle-file and playability modules |
| **M2** | Login, Home, Details, account menu | Done: browsing works on the TV |
| **M3** | Player: controls, jump preview, resume, Up Next, errors | Built and tested in the desktop harness; waiting on a TV test |
| **M4** | Audio and subtitle tracks, OpenSubtitles | Built and tested in the desktop harness with a fake OpenSubtitles; waiting on a TV test |
| **M5** | Search, motion polish, performance pass | Built and measured in the desktop harness with the CPU slowed 6x; waiting on a TV test |
| **Roku parity** | Everything in the Roku app's [`docs/features.md`](https://github.com/CrumbsAndCravings/roku-iptv-player/blob/main/docs/features.md) §14 checklist (v0.4.25) | Built and tested in the desktop harness; waiting on a TV test |

What the app does now:

- **Sign in** with server, username and password (a full M3U, `get.php`, `/playlist/` or stream link in Server fills in the rest). The login is checked with your provider before it's saved, on this TV only. A refused sign-in says who answered and what they said (`HTTP 403 from nginx: "Forbidden"`), the address used, and the usual causes, in a card where the tips were.
- **Your languages.** Category names are read for their language (`EN ✪ ACTION`, `|IN| BOLLYWOOD`, `PUNJABI MOVIES`), tidied ("Action", "Bollywood", "Punjabi") and, with a language choice set (see [A personal build](#a-personal-build)), categories in other languages leave Home, the tabs and search. Titles lose language tags and trailing years (`EN ★ Alterity - 2026` becomes "Alterity").
- **Home, Movies, Series, Categories and Search tabs.** Home starts with Continue Watching, then up to 18 rows: new releases first, then the rest, with movies and series taking turns and each of your languages taking turns. Movies and Series list every category in your languages. Each row shows the 40 newest titles and ends with a **See all** tile; more rows load as you scroll. If the provider refuses a row, Home stops asking (a burst of requests can keep a block going) and says why.
- **Categories tab:** every category as a card ("Punjabi", "Movies · 104"): new releases first, then each language's movies and series. OK opens the category's page.
- **A category's page** (See all, a category card, or a category found by Search): every title in it, newest first, 9 across, from the library stored on the TV, so nothing is asked of the provider. **Search this category** (Up from the first row) opens the keyboard and the grid narrows as you type.
- **The hero** at the top shows the focused title's backdrop, year, runtime, genre, rating and plot; movie details arrive after you rest on a poster for a moment. Resting on a title with several backdrops (most have up to five), they take turns every 7 seconds, cross-fading and slowly zooming in, as Netflix's banner moves; Details does the same. The pictures come from the image hosts, not the provider's video connection.
- **Look and motion** (the Roku app's 0.5.5 and 0.5.14, after the iPhone app). The tabs sit on a floating glass bar with a glass lens on the current tab; with the bar focused the lens lights up lavender and springs from tab to tab, stretching the further it goes, and OK swells the bar and lifts the lens, which wobbles back. Screens slide in (Details rises like a card) and only one screen moves at a time: the one underneath is hidden at once and simply there again when you come back, and the player comes and goes without a move, so the video starts with nothing else for the TV to draw. the banner's lines come up one after another as its picture settles, a row's posters build in from the right as they arrive, pictures fade in once loaded, progress bars fill, focused buttons spring, and the player's controls are dragged on from the left and from below. Soft click sounds go with moving, choosing and going back (never over a video).
- **The intro.** When ARAN+ opens: a knock, a boom as ARAN punches in out of a glow with light rays, the plus spinning with two pings and sparks, then a flight through the plus into the app, with its own sting (Web Audio, as on the iPhone). About 2.5 seconds; any key skips it, and the account menu turns it off.
- **Details** for movies (Play, or Resume and Play from start) and series (seasons, with Specials first, and the episode list with stills, runtimes and synopses; **Left/Right** in the list switch seasons). A title on Continue Watching also gets **Remove from Continue Watching**.
- **"Won't play"** marks titles this TV can't play (AVI, for now), with "Try anyway". Codecs that are really a file's cover picture (MJPEG, PNG) no longer count. With [the helper on your computer](#the-helper-on-your-computer), those titles play too, and a title that fails on its own is tried through it.
- **Files made for a 4K decoder.** Some 1080p files are encoded beyond what the TV's HD decoder holds: H.264 above level 4.2 (The Super Mario Galaxy Movie is level 5.0 with 16 reference frames, where the HD decoder holds 5) or HEVC above 4.1. The HD decoder refuses them ("PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), so ARAN+ opens them with the TV's 4K decoder, as it does files wider than 1920, going by the level your provider reports. A failure from before that doesn't count against them. If the TV still refuses such a picture through the helper, the helper converts it for that file.
- **Account menu** (the round button at the right of the tabs): Keep watching, Online subtitles, Turn click sounds off (or on), Turn the intro off (or on), Setup checks, Change server address, Sign out. Signing out also forgets the stored library; Continue Watching comes back from the sync service.
- **When the provider moves.** Providers change their address now and then, keeping the titles and the account. **Change server address** checks the new address by signing in there first (one request), then carries on there with everything kept; a failed check changes nothing. The same username and password at a new address (typed at sign-in, or in a newer personal build) count as the same account too: the stored library stays, and the next sync brings Continue Watching over from the old address. The TV remembers the last account by a fingerprint of its password, never the password itself after a sign-out.
- **The player.** Back and the title at the top; play/pause, the bar and the times at the bottom; Audio & subtitles, Subtitle settings, Episodes, Next episode and Restart underneath. The controls show when you press a key and hide after 5 seconds of playing.
- **Long pauses and a failing server.** Paused for 3 minutes, a video straight from the provider lets go of the provider's one connection (which the provider may otherwise drop) and shows the title's picture; Play opens it again at the same spot, with the same sound and subtitles. When a video won't start, one small request for its first kilobyte tells the cases apart: the provider's server failing (HTTP 5xx) is asked again once, 5 seconds later, and the error screen then starts with plain words; a refusal goes straight to the error screen; a file the provider sent but this TV couldn't play goes to the helper, when there is one. Only that last case teaches the TV that files like it don't play.
- **Jump preview.** Press or hold **Left/Right** (or Rewind/Fast forward) and the bar shows where you'll land before you get there; the longer you hold, the bigger the steps. The jump happens a moment after you let go, **OK** jumps straight away and **Back** cancels. Jumps go to the TV's player one at a time; one that fails is tried again, and if it still fails the reason shows under the bar.
- **Resume and Continue Watching.** Progress is saved every 15 seconds and when you leave. Resuming starts 5 seconds early. A movie drops out of Continue Watching when you finish it; a series moves on to the next episode. **Hold OK** on a Continue Watching poster for Remove from Continue Watching; a quick press opens it as usual.
- **Picked for you.** Home learns from what you watch, as Netflix does, all on the TV and from the stored library, so the provider isn't asked for anything. A movie counts once you're 3 minutes in, more from half way and most when finished; a series counts while you watch it and a little more for each episode finished; taking a title off Continue Watching before a fifth of it counts against it. Under Continue Watching come **My List**, **Top picks for you** (new titles from the 6 categories you like most, at most 8 from one) and up to two **Because you watched …** rows (the rest of that series of films first, then the newest from its category), The categories you like move up Home (after the first two rows of new releases), Movies and Series. Home never loads the stored library itself (reading a big one stops the TV for seconds): the rows picked last time show at once at launch, and they are picked again whenever the library is in already (after Search, Categories or a See all page) and what you watched, rated or listed has changed. With no stored library yet, these rows wait until one of those pages has loaded it.
- **Ratings and My List.** On Details, **+ My List** (In My List) and **Rate** sit after the play buttons; on Home, **hold OK** on any poster for Add to My List, Rate it, Remove from Continue Watching (on those) and Account. **Not for me**, **I like this** and **Love this!** count for more than watching: loved titles get "Because you watched" rows first, and one that's not for you never does. My List keeps 40 titles, newest first. Signing out keeps the history, ratings and My List for the same account; another account starts fresh.
- **Continue Watching on every device.** With a sync service set up (see [A personal build](#a-personal-build)), the TV and the Roku share one Continue Watching list per provider login, through the small Cloudflare Worker in the Roku repo's [`sync/`](https://github.com/CrumbsAndCravings/roku-iptv-player/tree/main/sync) folder. It syncs at launch, after leaving a video or removing a title, every 5 minutes while one plays, and when Home comes back.
- **Up Next** counts down 8 seconds at the end of an episode, then plays the next one (specials come after the last season). **OK** plays it now, **Back** stops.
- **Errors explain themselves.** A stream that fails is tried once more; if it fails again you see Samsung's reason, the file's format, whether this TV normally plays files like it, and the stream address with your login hidden. Then the server is asked for the stream once more, and a refusal is shown in its own words ("The trial may not include it, may allow one device at a time, or may have ended"). Files this TV can't play (AVI) say so before they try.
- **Audio & subtitles** (in the player's buttons): the file's own audio tracks with their format ("English · DTS") and subtitle tracks, then English subtitles from OpenSubtitles. ARAN+ draws the subtitles itself, lifted above the controls when they show. Your choice is remembered for the next video. The panel says which format is playing ("Audio now: AAC.").
- **No silent DTS.** Samsung TVs from 2018 on can't play DTS (or TrueHD) audio. When a video starts on such a track, ARAN+ switches to one the TV can play and says so for 9 seconds; when there's none, it says why there may be no sound.
- **Subtitle settings** (in the player's buttons, and last in the Subtitles column of Audio & subtitles): a card at the side, so the video and its subtitles stay in view (the subtitles show in front of it) while you change them. Up and Down choose a row; Left and Right change it.
  - **Timing:** Left shows the subtitles earlier and Right later, 0.1 s a step; holding the key down moves 0.5 s a step after a moment, and OK puts them back on time. It moves the subtitles already on the TV, so it never downloads them again. It's kept for that title on this TV, and for saved online subtitles on every device too. The file's own subtitle tracks can only move later (the player says what to show only when it's due).
  - **Font:** ARAN+ rounded (as before), **Netflix style**, **Prime Video style**, Samsung TV (the TV's own), Typewriter and Casual. Netflix Sans and Amazon Ember belong to Netflix and Amazon, so the two styles use free look-alikes, Inter and Roboto (Latin letters; other scripts use the TV's fonts).
  - **Size** (Small to Extra large), **Colour** (white, yellow, cyan, green), **Background** (none, a see-through box or a black box behind each line), **Edge** (outline, drop shadow or none) and **Position** (bottom, or higher). **Back to the usual look** resets them. The look is kept for every video; while you choose it with nothing on screen, a sample line shows.
- **Online subtitles.** Connect OpenSubtitles once (account menu, **Online subtitles**: API key, and your username and password for about 20 downloads a day). Then "Find English subtitles online" lists the best matches, with "matches this file" first when one was made for your exact video. The file is fetched once, so timing them in **Subtitle settings** costs no download, and pressing OK again while one downloads doesn't start another. With a sync service, subtitles you download are saved for that movie or episode, timing and all: every device (this TV, the Roku, the iPhone) shows them without another download, even one without an OpenSubtitles account. They show by themselves unless subtitles are set to Off or a language of the file's own, and are listed as "English · saved for this title". The sync Worker needs updating once for this (its guide, "Update it"); until then the Audio & subtitles panel says so, and a save that fails says why. "Matches this file" comes from the helper's fingerprint of the file; a video played straight from the provider isn't read for one, since that took the provider's one connection before the video could open, and the search goes by the title's TMDB id or name.
- **Automatic subtitles.** Once you've picked an online subtitle, later videos without English subtitles of their own get the best match by themselves a few seconds after they start.
- **Search** (the Search tab): a keyboard on the left (letters and digits, a symbols page behind **#+=**, **Shift** for one capital and **Caps** to keep them on), and rows on the right that update as you type: **Categories** whose name matches (so "punjabi" reaches every Punjabi title), then **Movies**, then **Series**. Every word typed must appear; one or two letters only match the start of a word, so "th" finds "The Office" but not "Other". Every match is ranked (titles starting with what you typed first), movies and series separately. Matching ignores capitals, accents and most punctuation, so "spider man" finds "Spider-Man". A USB keyboard plugged into the TV types too.
- **The stored library.** Search, the Categories tab and category pages use your whole library, kept on the TV. The first time, it loads in the background (series in one request, movies one category at a time, two at a time a second apart, paused while a video plays, stopping after three failures in a row) and the line under the search keyboard says how far it has got. After that it's searched at once on every launch, and once a day a fresh copy loads slowly in the background (one list every two seconds) and replaces it when complete.
- **The look.** Sharp corners, posters 15 px apart, badges ("S1:E4", "Won't play") on the poster with a thin progress strip along the bottom, and a 6% lift on the focused poster.

Remote: **Up** from the first row (or **Left** from a row's first poster) reaches the tabs. **Back** jumps to the first row, then the tabs, then asks to exit. **Hold OK** on a poster for its menu (My List, rating, Remove from Continue Watching, Account). On Details, **Down** reaches the seasons and episodes, and **Left/Right** in the episode list change season. On a category's page, **Up** from the first row reaches Search this category, and **Back** clears a search before leaving. In the player, **OK** pauses, **Up** reaches Back, **Down** reaches the buttons, **Back** hides the controls and then leaves, and **Stop** leaves at once.

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

## A personal build

A build can carry settings of your own in `personal.json` at the top of the repo. Git ignores the file, so it never reaches GitHub; copy [`personal.example.json`](personal.example.json) to start. Every part is optional:

```json
{
  "languages": ["en", "hi", "pa"],
  "sync": { "url": "https://aranplus-sync.<your-subdomain>.workers.dev", "key": "<the SYNC_KEY you set on the Worker>" },
  "server": "…", "username": "…", "password": "…",
  "opensubtitles": { "apiKey": "…", "username": "…", "password": "…" }
}
```

- **`languages`:** whose categories to show, in order (`en`, `hi`, `pa`, `other`). Without it every language shows. This part holds nothing private.
- **`sync`:** the address and key of your sync Worker, set up once with the Roku repo's [sync guide](https://github.com/CrumbsAndCravings/roku-iptv-player/blob/main/sync/README.md). Use the same key as the Roku build. Without it nothing syncs.
- **`server`, `username`, `password`:** a login the TV signs in with by itself. Leave them out to type the login on the TV as usual. With them, the signed `.wgt` holds your login, so keep that file to yourself. When a newer build carries a different login, the TV replaces the saved one and clears Continue Watching (its titles belong to the old provider). A login typed on the TV for the same account is kept, Continue Watching and all. So is one where only the server changed and the username and password are the same (the provider's new address).
- **`opensubtitles`:** your OpenSubtitles API key, and optionally your OpenSubtitles username and password, so online subtitles are set up without typing them on the TV. The TV takes them when it has none (the first start, or after signing out) or when a newer build carries different ones; details typed on the TV after that are kept. **Remove** on the Online subtitles screen keeps the build's own off too, until you sign out. Leaving that screen with Back keeps what you typed, and after saving it reads the details back, saying so if the TV's storage didn't keep them.

- **`transcoder`:** where [the helper on your computer](#the-helper-on-your-computer) is, and its key. The helper writes this itself the first time it runs. Optional extras the helper reads here: `webApp` (the folder of the [iPhone app](#the-iphone-app)'s build, when it isn't next to this repo) and `userAgent` (how the helper introduces itself to the provider; when left out, a desktop browser for lists and files, and FFmpeg's own name for conversions).

`npm run install:tv` (and `npm run build`) picks the file up and prints which parts it found, never their values. The desktop harness ignores it unless `ARANPLUS_PERSONAL` names a file, so `npm run dev` never talks to your provider by accident.

## The helper on your computer

The TV plays MKV and MP4 files with H.264 or HEVC pictures, but not AVI files (old DivX and Xvid movies, about 1 in 60 of the provider's), and not DTS or TrueHD sound. The helper fixes that: a small program on a computer at home (a PC switched on while you watch, or a Raspberry Pi that is always on) that uses [FFmpeg](https://ffmpeg.org) to turn those files into a stream the TV plays. The Roku app ([CrumbsAndCravings/roku-iptv-player](https://github.com/CrumbsAndCravings/roku-iptv-player)) uses the same helper, for AVI files, DTS sound, and HEVC pictures on a Roku that can't decode them (see [For the Roku too](#for-the-roku-too)).

**How it works.** When a title can't play on the TV (an AVI, sound the TV can't decode, or a file that failed before), ARAN+ asks the helper instead of the provider. The helper fetches the file with your login (from `personal.json`, so the login never travels from the TV), and FFmpeg sends it on as an MPEG-TS stream:

- **The picture** is kept as it is when the TV plays it (H.264, HEVC). DivX and Xvid are first just repackaged, which takes almost no computing power; if the TV still refuses, they are converted to H.264, and ARAN+ remembers which way worked. Conversion uses the graphics card or Intel Quick Sync when the computer has one, otherwise the processor (fine for standard definition).
- **The sound** is kept as it is when it's AAC, Dolby Digital (AC-3) or Dolby Digital Plus (E-AC-3, Atmos included). DTS, Dolby TrueHD and any other surround track become Dolby Digital 5.1 at 640 kb/s, its highest rate: every channel stays in its place, and 7.1 (TrueHD Atmos and DTS-HD on 4K films) is mixed down to 5.1 with the subwoofer kept and the back channels folded into the surrounds. Stereo stays stereo and mono stays mono. Atmos height effects inside TrueHD can't be carried over, since the TV can't play TrueHD and nothing free can make Atmos. A file played straight from the provider whose sound in your language is DTS or TrueHD goes to the helper for this, rather than switching to another language the TV can play. The iPhone and the Roku get stereo AAC, by design.
- **Jumping** starts the helper's stream again at the new time, so a jump takes a few seconds. Resuming works the same way. While you choose where to jump, a picture of that moment shows above the time (helper 1.3 and newer): FFmpeg writes a small picture every six seconds of the film as it streams, named by the film's own time (from the nearest keyframe when the picture is kept, so it decodes about a seventeenth of the film rather than all of it), so everything played so far (and a little ahead) has one; a moment not reached yet shows just the time. Pictures are kept for the three titles played last. FFmpeg reads the provider's files through the helper, which keeps the start and the end of each file (where its index is) and remembers the provider's redirect, so a jump costs one request to the provider instead of four or five. The window says how long each start took and how slow the provider was to answer ("Ready to play after 6.1 s (2 requests to the provider, the slowest answered in 2.8 s)").
- **Online subtitles:** with OpenSubtitles set up, the helper also fingerprints the file for it from the parts it keeps anyway, so the TV doesn't make two requests of its own to the provider.
- **When the stream drops** after it has played (the provider's connection, say), ARAN+ opens it again from where it got to, twice at most (a minute of playing resets the count). Then the error screen says what the helper said, what it was doing with the file, and where it is. "May be older than this app" means the helper doesn't know the TV's request: update it (`git pull`) and start it again.
- The file's own subtitle tracks don't come through; online subtitles still work.
- **Resuming and jumping** keep the picture as it is, so the stream can only start on a keyframe, up to a few seconds before the time asked for. The helper notes where it really began (helper 1.5 and newer), and the TV counts from there, so the time, online subtitles and the place saved for Continue Watching match the picture (before, they ran early by that much).

**Set it up on Windows (once):**

1. Install FFmpeg: open PowerShell and run `winget install Gyan.FFmpeg`.
2. Make sure `personal.json` (in the top folder of this repo) has your provider's login: the helper needs `server`, `username` and `password`.
3. Open a new window in the repo folder and run `npm run helper` (or double-click `helper\start-helper.cmd`). The first time, it adds `transcoder` (this computer's address and a random key) to `personal.json`, and Windows asks whether Node.js may use the network: allow **private networks**.
4. Run `npm run install:tv` once more, so the TV knows where the helper is.

From then on, start the helper before you watch (or put a shortcut to `helper\start-helper.cmd` in the Startup folder: press Win+R, type `shell:startup`). Its window shows what it is converting. If the TV says the helper didn't answer, check that the computer is on and the window is open. Give the computer a fixed address in your router, or the TV may lose it; the helper says when the address in `personal.json` no longer matches.

**Or on a Raspberry Pi, always on.** A Raspberry Pi 4 or 5 (2 GB or more) can run the helper instead of the PC, on a few watts, starting by itself with the Pi. For the TV its job is light: most titles are passed on as they are with only the sound converted, and the pictures for choosing a jump come from keyframes only. Converting pictures (DivX and Xvid films for the TV, most films for the iPhone, HEVC films for the Roku) runs on the Pi's processor with quicker settings (x264 `superfast`): fine for standard definition anywhere and for HD on a Pi 5; on a Pi 4, HD films for the phone or the Roku may stutter. A cable to the router is best; Wi-Fi works.

1. Put **Raspberry Pi OS (64-bit)** on the card with Raspberry Pi Imager (Lite is enough), turning on SSH in its settings, and start the Pi on your home network.
2. On the PC, open PowerShell, run `ssh <your Pi username>@<the Pi's address>`, and on the Pi run:
   ```
   sudo apt install -y git
   git clone https://github.com/CrumbsAndCravings/Samsung-IPTV-Player.git
   cd Samsung-IPTV-Player
   bash helper/setup-pi.sh
   ```
   The first time, it stops and shows the command that copies `personal.json` from the PC (an `scp` line to run in PowerShell in the repo folder on the PC); then run `bash helper/setup-pi.sh` again. It installs FFmpeg and Node.js 22, points the helper's address in `personal.json` at the Pi (keeping the key), and starts the helper as a service that starts with the Pi and starts again by itself if it stops.
3. On the PC: close the helper's window and take its shortcut out of the Startup folder (two helpers would fight over the provider's one connection), then run `npm run helper:address -- <the Pi's address>` and `npm run install:tv`. For the Roku, copy the same `transcoder` into its `src/source/account.json` and build it again. For the iPhone, open the new link: `journalctl -u aranplus-helper -b` on the Pi shows it with its code (and building web-iptv-player next to this repo on the Pi, as on the PC, puts the app there too).
4. Give the Pi a fixed address in your router, so the TV keeps finding it.

`journalctl -u aranplus-helper -f` on the Pi shows what the helper is doing. To update it: `git pull`, then `bash helper/setup-pi.sh` again. On another computer, `"x264Preset"` under `"transcoder"` in `personal.json` chooses the processor's settings (`ultrafast` to `medium`; `veryfast` on a PC, `superfast` on a Pi).

### When 4K films pause

Rich 4K copies (HDR and Dolby Atmos) carry about 20 to 26 Mbit/s, ten times a 1080p copy; their sound is a small part of it (768 kb/s). The TV streams a film over one connection all the way to your provider, which is a different thing from an internet speed test (several connections to a server nearby), so a line that tests fast can still bring a 4K film in too slowly.

- **Find out where it slows:** on the computer the helper runs on (it shares the TV's internet), with nothing playing, run `npm run speed` (or `npm run speed -- "Dune Part Two"` for a film by name). It downloads 20 seconds of a rich 4K copy the way the TV does and says whether your path to the provider keeps up: fast enough (then the TV's Wi-Fi is the likely hold-up: a cable or 5 GHz Wi-Fi closer to the router); fast once it gets going but slow for its first seconds (every start and jump opens a new connection, so each begins like that; the TV's 5 seconds gathered before starting carry it through, and a second run on the same film says whether only a film's first play starts slowly); enough with dips; or slower than the film needs (then the provider's 1080p copies play smoothly, and another time of day may be faster).
- **What the TV does:** for 4K files and ones of 12 Mbit/s and more, the player gathers 5 seconds before it starts and 15 seconds before it plays on after running dry (AVPlay's buffering settings, over its small default), so a dip in speed is ridden over rather than paused for.
- **Upload speed** doesn't matter at home: the TV downloads from the provider, and the helper's stream to the TV stays inside your network. It matters only for the iPhone away from home through Tailscale, which the helper sends to over your upload.

### The iPhone app

The helper also serves ARAN+ for the iPhone, a web app in [CrumbsAndCravings/web-iptv-player](https://github.com/CrumbsAndCravings/web-iptv-player) (its README has the setup steps). Put that repo next to this one, run `npm install` and `npm run build` in it, and start the helper: it prints a link and a QR code for the phone, with the key in the link. For the phone the helper also:

- **asks the provider for the lists,** adding the login from `personal.json` (a web page can't call the provider, and the password never reaches the phone);
- **passes MP4 files on as they are,** with ranges, so Safari jumps in them itself;
- **converts the rest into HLS,** the streaming format Safari plays, the way Safari likes it best: a playlist for the whole film from the start, in six-second pieces, so the phone knows the length, starts at once and jumps by itself. The helper makes each piece when the phone asks for it: FFmpeg converts the picture to H.264 (with the graphics card when there is one) and the sound to AAC, as fast as it can from where it was started, into MPEG-TS pieces in the computer's temp folder; a piece it has made is sent at once, and a jump elsewhere starts FFmpeg again from there (a few seconds). Every run cuts the film at the same places and keeps its own timestamps, so pieces from different runs play as one. The file's own text subtitles are written out as WebVTT alongside, and a small picture of each piece (about 6 KB), which the phone shows above the bar while it's dragged. Old pieces are deleted a couple of minutes after the phone stops asking for them, and all of them when the helper starts. The window says when the phone opened the stream and started playing, and how long each jump took;
- **passes OpenSubtitles requests on,** and reads a file's moviehash for "matches this file" results;
- **sends as little as it can,** for 5G: the app and the lists gzipped (a list is about a tenth of the size), the app's files checked rather than sent again, the provider's lists kept for 10 minutes, and a film the phone goes back to (resuming after leaving the player) carrying on with the pieces already made.

With [Tailscale](https://tailscale.com) on the computer and the phone, the helper also shows a link at its Tailscale address, which the phone reaches on 5G and on any Wi-Fi (the iPhone app's README has the steps).

The TV keeps its one MPEG-TS stream rather than the whole-film playlists: unlike the phone and the Roku, it plays that kind of stream, which keeps the picture as it is (nothing to convert, so it starts sooner and looks as it should) and carries every sound track, so changing the language needs no new stream. The phone, the TV and the Roku share the provider's one connection, so starting a video on one stops the others.

### For the Roku too

The Roku app ([CrumbsAndCravings/roku-iptv-player](https://github.com/CrumbsAndCravings/roku-iptv-player)) plays through the same whole-film playlists as the phone, in MPEG-TS pieces:

- **What the Roku asks for:** the picture converted when this Roku can't decode it (always for DivX and Xvid, and for HEVC on most Roku TVs), scaled down to the Roku's screen (720 lines on a 720p TV, which saves the computer most of the work on 1080p and 4K files), and stereo AAC sound in your language when the file has it.
- **Jumping** is the Roku's own: a piece the helper has made plays at once, and one further away takes a few seconds while the helper starts converting from there. The pieces keep the film's own times, so online subtitles play as they are.
- **When you leave a video,** the Roku tells the helper to stop its stream (only its own, so the phone isn't cut off). Pieces nobody asks for go after 2 minutes (3 hours for the video watched last, so a long pause can pick up again), and all of them when the helper starts.
- **Setup:** after the helper has written `transcoder` into `personal.json`, copy that `"transcoder": { "url": ..., "key": ... }` into the Roku repo's `src/source/account.json` and build the Roku app again. The Roku repo's README has the steps.

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
    storage.ts progress.ts           Registry.brs and Progress.brs (Continue Watching, removals, sync merge)
    personal.ts                      a personal build's login, languages and sync settings
    categories.ts                    Categories.brs: language, new releases and tidy names; Home's order
    refusals.ts                      who refused a request and what they said (HttpDetail and friends)
    sha256.ts                        the sync space, in plain JavaScript (no reliance on Web Crypto)
    tracks.ts playback.ts            Tracks.brs and Playback.brs (track labels, audio rescue, seeking)
    search.ts                        SearchIndex.brs: ranking, categories, category pages, saving
    subtitles.ts watch.ts seek.ts    the player's subtitle menu, progress rules and jump preview
    opensubtitles.ts                 Subtitles.brs: queries, ranking
    srt.ts                           new: SRT/WebVTT parsing and cue lookup with a delay
    compat.ts                        new: will it play on this TV (M0 results plus what it learns)
    device.ts redact.ts log.ts       engine and model year, secret hiding, on-screen log
    account.ts                       the last account on this TV: the same account at a new address
    taste.ts mylist.ts               Taste.brs and MyList.brs: watch history, ratings, likings, My List
  platform/                          Tizen and browser APIs
    http.ts keys.ts tizen.ts         XHR with timeouts, remote keys, device info
    files.ts                         big text kept between launches (IndexedDB, else localStorage)
    player.ts avplay.ts html5.ts     player interface, AVPlay, desktop <video>
  ui/                                dom helper, key routing (focus rules), posters, backdrop (the moving
                                     banner), dialogs, the intro and its sting
  platform/sound.ts                  click sounds (assets/sounds, the Roku app's own)
  app.ts                             the screen stack and shared dialogs
  data/api.ts                        Xtream calls: session cache, at most three at once
  data/library.ts                    the stored library: loaded gently, saved, refreshed daily
  data/sync.ts                       Continue Watching through the sync Worker
  data/transcoder.ts                 the helper on a computer at home
  data/opensubtitles.ts moviehash.ts OpenSubtitles calls; fingerprints from the helper
  screens/                           sign in, Home, Categories, a category's page, Search, Details,
                                     player, Online subtitles, Setup checks, Change server address
  probe/                             the M0 setup checks
  styles/                            design tokens, base styles, screen styles
assets/fonts  assets/images          Fredoka and Nunito (SIL OFL), generated glows
helper/                              the helper for a computer at home: FFmpeg converts what the TV can't
                                     play, and it serves the iPhone app (web-iptv-player) and its HLS;
                                     setup-pi.sh runs it as a service on a Raspberry Pi
tests/                               vitest
dev/                                 fake Xtream server, fake OpenSubtitles, screenshot script
tools/                               build, dev server, Tizen CLI wrapper, image generator
docs/m0-findings.md                  what the TV told us in M0, and the decisions it changed
docs/roku-helper-plan.md             the plan for letting the Roku app use the helper too
```

### Performance

Only the rows and posters near the focus are in the page, and anything that moves (the rows, each row's posters, the backdrop's cross-fade) sits on its own layer, so moving is the GPU's work rather than a repaint. Animations use transform and opacity only. In the harness with the CPU slowed 6x (Chrome DevTools throttling, roughly the TV's speed) and JPEG artwork like the provider's, scrolling a row and moving between rows stay at 60 fps for more than 95 % of frames, and a key press reaches the screen within about 30 ms. Searching 28,500 titles takes about 2 ms on a desktop, so a few tens of milliseconds on the TV, and every match is ranked, not just the first few thousand.

Home draws a row again only when its titles change: coming back from Details or a video, a sync, or new picks leave the other rows as they are, and a picture already loaded doesn't fade in again. The intro animates transform and opacity only (no blur or brightness filters, which the TV redraws every frame), and its sting's room echo is two delays, not a convolution reverb. Click sounds' Web Audio sleeps while a video plays. With the CPU slowed 6x, the launch's longest stall went from 478 ms to about 70 ms, and coming back to Home redraws no posters (it redrew 34).

### Keep secrets out of git

The IPTV login and OpenSubtitles details are typed on the TV and stay in its storage. Signing certificates, `tizen.local.json` and `personal.json` stay on your computer (`.gitignore` covers `*.p12`, `*.pem`, `*.wgt`, `tizen.local.json` and `personal.json`). Logs and on-screen reports hide the server, username, password, OpenSubtitles details and the sync key. Before pushing, check the diff for your provider's hostname and username.
