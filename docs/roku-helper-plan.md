# Plan: the helper for the Roku app

A brief for a new session. It extends the helper built for the Samsung app (this
repo, `helper/`) so the Roku app can use it too, and lists every change in both
repositories.

- **Samsung repo:** `CrumbsAndCravings/Samsung-IPTV-Player`. The helper (1.1) and this
  plan are on branch `claude/blissful-wozniak-8xy7ar` (app version 0.7.1); if that
  branch has been merged by the time you start, use `main`.
- **Roku repo:** `CrumbsAndCravings/roku-iptv-player`, `main` (0.4.25 at the time of
  writing). Its `docs/features.md` is the spec for every feature and its gotchas
  (section 13); read it before touching BrightScript.

The session needs both repositories: Part A changes the helper in the Samsung repo,
Part B changes the Roku app.

## Status

Done, in a different shape from the plan below, which is kept as it was written. The
helper here (1.2) is the one built for the iPhone app (`web-iptv-player`), and the Roku
app (0.5.2) plays through it. It supersedes both 1.1's reading layer (section 2) and the
Roku-only build of A1 to A3 (once on branch `claude/new-session-700kir`):

- **Reading the provider:** FFmpeg reads each file through the helper's own address
  (`/v1/source/...`, answered to this computer only), and the helper reads the provider
  one connection at a time, keeping the start and the end of each file and the
  provider's redirect (`helper/source.mjs`). This replaces `readHead`, `feedFromStart`
  and `/p/<token>`. Once a file's start and end are kept, a jump costs one request to
  the provider.
- **Whole-film playlists:** `/v1/hls/start?vod=1` answers with a playlist for the whole
  film in 6 s MPEG-TS pieces, made as they're asked for and keeping the film's own
  timestamps. The Roku jumps by itself, and online subtitles play without re-timing.
  Files of unknown length still get the growing (EVENT) playlist.
- **For the TVs:** `/v1/info` takes `hash=1` (the moviehash, for the Samsung TV's
  online subtitles; `start` is accepted and no longer needed); `/v1/hash` gives the
  moviehash on its own (the Roku asks for it before the stream starts);
  `/v1/stop?session=<id>` stops one session; and `/v1/last-error` reports `ago`
  (seconds).
- **Not carried over** from the Roku-only build: `track=`, the master playlist,
  `/v1/subtitles.srt` (re-timed subtitles) and `-hwaccel auto`.
- **The Roku's side:** the Roku repo's `docs/features.md` §15.

## 1. Goal

Titles the Roku can't play today should play on it through the helper on the user's
Windows PC, the same way they already do on the Samsung TV:

- **AVI files** (DivX/Xvid pictures, MP3 sound): Roku plays no AVI and decodes no
  DivX/Xvid, so the picture is always converted to H.264.
- **HEVC files**, if this Roku can't decode HEVC. The Samsung M0 notes call HEVC "the
  reason for moving to Samsung", so the user's Roku (a 720p Roku TV) most likely
  can't; `PlaybackCheck` already asks the device (`CanDecodeVideo`). These are most of
  the library, so this is the biggest win, and the heaviest work for the PC.
- **DTS or TrueHD sound** with no other playable track: the sound is converted.
- **Anything that fails** on its own after the usual retries.

The user's words: "decode every video into the format the TV is capable of running".

## 2. What exists now

### The helper (Samsung repo, `helper/`)

- `helper/aranplus-helper.mjs`: a Node HTTP server with no dependencies, started with
  `npm run helper` or `helper\start-helper.cmd`. It uses FFmpeg (installed with
  `winget install Gyan.FFmpeg`).
- `helper/plan.mjs`: pure logic with tests (`tests/helper.test.ts`):
  - `parseProbe`: reads `ffmpeg -i` output; this works with every FFmpeg build, while
    ffprobe isn't always there.
  - `videoPlan`: "copy" for H.264, HEVC and MPEG-2; "try" for MPEG-4 Part 2, MPEG-1
    and VC-1; "convert" for the rest.
  - `audioPlan`: keeps AAC, AC-3 and E-AC-3; turns DTS and TrueHD (more than 2
    channels) into AC-3 448k; turns everything else into AAC 192k.
  - `ffmpegArgs({ input, start, video, encoder, probe })`: `input` is `"pipe:0"` or a
    URL.
  - `providerUrl`, `redactor`, `sizeFromAnswer`, `askedRange`, and `osHash` (the
    OpenSubtitles moviehash, which matches the app's `src/core/oshash.ts`).
- **Settings:** it reads the provider login from `personal.json` at the Samsung repo
  root (git-ignored). On its first run it writes `transcoder: { url, key }` there:
  this PC's LAN address on port 8090 and a random key. `transcoder.userAgent` is
  optional; the default is `Lavf/61.1.100`, the way FFmpeg introduces itself.
- **Endpoints:**
  - `GET /`: a health check; needs no key.
  - `GET /v1/info?key&kind&id&ext&start&hash=1`: what the file holds, with
    `{ duration, video, audio[], videoPlan, encoder, hash }`. `hash` is the moviehash,
    filled in when `hash=1` is asked. `start` tells the helper whether to keep its
    connection open for a stream from the beginning. Cached for 6 hours.
  - `GET /v1/stream?key&kind&id&ext&start&video=copy|convert`: one endless MPEG-TS
    stream from `start` seconds. The timestamps restart at 0.
  - `GET /v1/last-error?key`: why the last stream failed.
  - `GET /p/<token>`: the local address described below. It answers this computer only.
- **How it reads the provider (1.1).** This is the speed fix, and every new output
  must use it.
  - **Why:** FFmpeg never asks the provider itself. It would open an AVI with 6
    requests (the start, the index at the end, back again), and a provider takes a
    moment to start each one: with 2 s per request, a start took 24 s.
  - **From the beginning:**
    - the first 4 MB are read once (`readHead`), described with FFmpeg reading
      `pipe:0`, and kept in a block cache (1 MB blocks);
    - the connection stays open just after them for 20 s (`warm`);
    - `feedFromStart` then feeds FFmpeg the cached start followed by the rest of that
      same connection: 1 provider request in all.
  - **Resumes and jumps:**
    - FFmpeg reads `localUrl(file)`, which is `http://127.0.0.1:<port>/p/<token>`;
    - `serveFile` answers its range requests from the cache, and asks the provider
      only for the rest, from a block boundary, caching up to 8 MB of each read so the
      index stays;
    - the first resume of a title costs 3 requests (the start, the index, the resume
      point), and each later jump costs 1.
  - **Files that can't be read from their start alone** (MP4 with its index at the
    end): described through the local address instead. `pipeOk` is false for them, so
    they always stream through it.
  - **Unknown size** (the provider sends no length): FFmpeg falls back to the provider
    URL.
  - **The fingerprint:** with `hash=1`, the last 64 KB are fetched first (`readTail`),
    then the start. So with online subtitles a start costs 2 requests, and the TV
    makes none of its own.
  - **Memory:** up to 32 MB of cache per title, for the 3 most recent titles.
- **One provider connection at a time:**
  - `openAt` closes any other provider connection first;
  - `takeSlot` stops the running FFmpeg, closes the connection and waits 300 ms.
- **Encoders:** at startup it picks the first H.264 encoder that works:
  `h264_nvenc`, `h264_qsv`, `h264_amf`, then `libx264`.
- **Logs:**
  - they hide the server, username, password and key;
  - each title logs "the provider started sending after X s" and "Sending to the TV
    after Y s";
  - `ARANPLUS_HELPER_DEBUG=1` also prints which input FFmpeg reads.

### The Samsung app's use of it (reference implementation)

- `src/data/transcoder.ts`: the helper client and the remembered choices.
  - `helperInfo(item, start, wantHash)`: asks for the moviehash when online subtitles
    are on. `src/screens/player.ts` then skips the TV's own hash requests for helper
    titles (`hashThenLoad`, `helperHash`), and stores the result with
    `rememberHash`.
  - `helperModes`: per picture codec, whether "copy" or "convert" worked.
  - `helperTitles`: titles that need the helper from the start, such as DTS-only ones.
- `src/screens/player.ts`, the `route: "direct" | "helper"` state:
  - `offsetMs` is added to the TV's clock; the duration comes from `/v1/info`.
  - A jump calls `reopenAt(target)`, which restarts the stream with `start=target`.
  - A "try" picture that the TV refuses switches to "convert" without spending a retry.
  - After the direct route's last retry, the title moves to the helper.
  - When the audio rescue finds no playable track, the title moves to the helper.
  - A helper stream that ends more than 60 s early counts as a failure.
  - The error screen adds the helper's own reason from `/v1/last-error`.
- `src/core/personal.ts`: `transcoderConfig()` and `helperOn()`.
- With a helper set up, "Won't play" badges are hidden (`ui/poster.ts`). Details says
  "This TV can't play this file itself, so the helper on your computer converts it
  while you watch."

### The Roku app

- `src/components/screens/PlayerScreen.brs`:
  - `startItem` calls `PlaybackCheck`; a title it blocks gets `showUnplayable()`.
  - `loadStream` builds the content node:
    - `url = StreamUrl(...)`;
    - `streamFormat` from `StreamFormatFor(ext)`, dropped on the second attempt;
    - `playStart = startAt - 5`;
    - a `User-Agent` header when one is saved.
  - Playback: `onState` handles playing, paused, error and finished.
  - Failures: `onPlaybackError` retries without the format hint, and checks the stream
    under each identity (`startProbe`, `onProbeResult`) before calling
    `showPlaybackError`.
  - Jumps: `commitSeek` and `jumpBy` set `m.video.seek`.
  - Position: `onPosition`, `saveProgress` and `renderBar` read `m.video.position` and
    `m.video.duration` directly.
  - `checkAudioPlayable` is the audio rescue and shows a toast.
- `src/components/common/Compat.brs`: `PlaybackCheck(ext, videoCodec, videoProfile,
  audioCodec)` returns `{ blocked, warning }`, using `roDeviceInfo.CanDecodeVideo` and
  `CanDecodeAudio`.
- **Where "Won't play" comes from:**
  - `item.problem` is set by `containerProblem(ext)` in `tasks/XtreamParse.brs` and
    `tasks/SearchIndex.brs`;
  - and from `check.blocked` in `HomeScreen.brs` (hero info) and `DetailsScreen.brs`.
- `src/components/common/Registry.brs`: `BuiltInCreds`, `LanguagePrefs`, `SyncConfig`
  and `SyncSpace`. Personal settings are read from `pkg:/source/account.json`, which
  is git-ignored.
- **HTTP happens in Task nodes**, never on the render thread. See `tasks/XtreamTask.brs`
  (`mode`: auth, categories, row, vodInfo, seriesInfo, probe) and `tasks/SyncTask.brs`.
- **Tests:** `tools/test.sh`, using the `brs` interpreter. `tests/utils_test.brs` and
  `tests/parse_test.brs` hold the pure functions, and `tests/sync_test.mjs` covers the
  Worker.

## 3. Why the Roku needs more than the Samsung TV

1. **No endless MPEG-TS.** As far as known, Roku's Video node plays HLS, DASH, Smooth,
   and progressive MP4/MOV/MKV, but not an endless `.ts` stream. The helper needs an
   **HLS** output: the same MPEG-TS, cut into numbered segments listed in a playlist.
   Verify this first on the device with the existing stream URL and
   `streamFormat = "hls"` versus a plain URL (see 6).
2. **No shortcut for DivX/Xvid.** The Roku can't decode it, so "try copy first" never
   applies; always convert.
3. **Decoding limits differ.** HEVC and AC-3 support depend on the device. Ask
   `CanDecodeVideo` and `CanDecodeAudio` before choosing what the helper keeps.
4. **The screen is 720p.** Converting to 720p (or the Roku's own height) makes the PC's
   work much lighter, especially for 1080p and 4K HEVC.

## 4. Part A: helper changes (Samsung repo, `helper/`)

Keep `/v1/stream` and `/v1/info` exactly as they are: the Samsung app uses them.

**Update (built for the iPhone app in `web-iptv-player`):** most of A1 and
A2 now exists. What's there, and how it differs from the plan below:

- `GET /v1/hls/index.m3u8?key&kind&id&ext&start&video&height&audio` starts a session
  and answers with a redirect to `s/<session>/index.m3u8` (relative), so the playlist's
  piece names resolve to the session's folder without rewriting. MPEG-TS pieces and
  sound as for the TV (`audio=keep`) unless `format=fmp4` or `audio=aac` is asked for.
  `GET /v1/hls/start` does the same and answers with JSON (the phone uses that, with
  `format=fmp4`).
- Pieces are 6 s; converting forces a keyframe at each piece's start; the playlist is
  served with `#EXT-X-START:TIME-OFFSET=0` so a player starts at its beginning.
- `height` scales down when converting; `audio=aac` turns everything but AAC into AAC
  stereo; `a=<n>` or `alang=<code>` picks the one sound track a session carries;
  `hevc=0` converts HEVC for players without it; `subs=1` writes text subtitles as
  WebVTT next to the pieces.
- Sessions: the newest is kept for 3 hours of not being asked for, older ones for 2
  minutes, and everything is deleted when the helper starts. `/v1/stop?session=<id>`
  stops one. A start the player gives up on is dropped.
- Not done: `-hwaccel auto` (A2) and a default browser user agent for FFmpeg (A3);
  `transcoder.userAgent` sets one when needed.
- The phone now asks for `vod=1`: a playlist for the whole film (`#EXT-X-PLAYLIST-TYPE:VOD`,
  6 s pieces at fixed places), with pieces made when asked for and FFmpeg started again
  for a jump (`helper/plan.mjs`, "Whole films"). Safari didn't start the growing (EVENT)
  playlists on a real iPhone. The Roku may well want the same; `/v1/hls/index.m3u8`
  still gives the growing kind.

### A1. HLS output

- **Build it on the 1.1 reading layer** (section 2): FFmpeg's input is `"pipe:0"` fed by
  `feedFromStart` when starting at 0, otherwise `localUrl(file)` with `-ss`. Never the
  provider URL, or the start and jumps go back to taking 10 s or more.
- **The playlist:** `GET /v1/hls/index.m3u8?key&kind&id&ext&start&video=copy|convert&height=&audio=`
  - starts FFmpeg with `-f hls -hls_time 6 -hls_list_size 0 -hls_playlist_type event
    -hls_flags independent_segments+temp_file -hls_segment_filename <dir>/seg%05d.ts`,
    writing to a fresh folder under `os.tmpdir()/aranplus-helper/<session>`;
  - `<session>` is 16 random bytes in hex, and works as a capability token;
  - answers once the playlist holds two segments (wait up to 45 s, then 502 with
    FFmpeg's reason);
  - serves the playlist with the segment lines rewritten to `s/<session>/seg00001.ts`
    (relative), so they don't need the key.
- **The segments:** `GET /v1/hls/s/<session>/<file>`
  - serves a segment or a fresh copy of the playlist (`index.m3u8`), whose contents
    grow while FFmpeg works;
  - answers 404 for an unknown session, and never serves anything outside the
    session's folder (no `..`).
- **One run at a time:** a new HLS or stream request stops the previous FFmpeg and
  provider connection (the existing `takeSlot`).
  - Keep the previous session's files until its next request fails, so a Roku
    re-reading the playlist doesn't break during a reopen.
  - Delete a session's folder 2 minutes after it stops being requested, and delete
    everything when the helper starts.
- **Keyframes:** when converting, force a keyframe at each segment boundary
  (`-force_key_frames expr:gte(t,n_forced*6)`), so segments are close to 6 s each.

### A2. Options the Roku needs (on both endpoints)

- `height=<n>`: when converting, scale down to at most this height, keeping the shape
  and even sizes (`scale=-2:min(ih\,<n>)`). Ignored when copying.
- `audio=aac`: turn every sound track into AAC stereo, for devices without AC-3
  decoding.
- `video=convert` stays as it is; the Roku sends it for every picture it can't decode.
- When converting, add `-hwaccel auto` before `-i`, so a graphics card or Quick Sync
  also decodes HEVC.
  - Test that a failed hardware decode still falls back to the processor; if FFmpeg
    errors instead, retry once without `-hwaccel`.

### A3. The provider's view of the helper

- Done in 1.1: the helper's own requests send `transcoder.userAgent`, defaulting to
  `Lavf/61.1.100`.
- If the provider refuses it, the Roku notes (features.md §2.3) suggest trying the
  same desktop browser string as the Roku's `BrowserUserAgent()`.
- The one place FFmpeg still asks the provider directly (unknown size) should pass
  `-user_agent` with the same value.

### A4. Tests and checks

- Unit tests in `tests/helper.test.ts` for the new `ffmpegArgs` options:
  - HLS mode, `height`, `audio=aac`, `-hwaccel`, `-user_agent`;
  - the playlist rewriting (a pure function: segment lines become `s/<session>/...`;
    `#EXT` lines are kept).
- An end-to-end run against the fake provider (`dev/mock-xtream.mjs` serves
  `dev/media/sample.<ext>`):
  - make 10-minute test files with FFmpeg into `dev/media/` (git-ignored): an Xvid AVI
    with MP3 sound, and an H.264 or HEVC MKV with DTS 5.1. Small files fit in the
    cache and hide jump costs;
  - start the helper with `ARANPLUS_PERSONAL` pointing at a test `personal.json` whose
    server is `localhost:<port>`; with `127.0.0.1` the log's redaction also hides the
    helper's own local address;
  - fetch the playlist, check it grows, fetch two segments;
  - time it the way 1.1 was timed:
    - wrap the fake provider so each file request waits 2 s and is counted;
    - expect 1 provider request for a start from the beginning (2 with `hash=1`), 3
      for a first resume, and 1 for each later jump;
  - run FFmpeg asynchronously in such scripts: a synchronous call freezes the fake
    provider living in the same process.
  - Note: the static FFmpeg used in the cloud sandbox crashed reading MPEG-TS, so
    check segments by reading the TS program table directly (stream types 0x1B H.264,
    0x24 HEVC, 0x0F AAC, 0x81 AC-3) with a small Python script, as was done for
    `/v1/stream`.
- `npm run check` must pass. Update the README's helper section.

## 5. Part B: Roku app changes (Roku repo)

### B1. Settings

- `account.json` gains `"transcoder": { "url": ..., "key": ... }`, the same values
  the helper wrote into the Samsung `personal.json`. The user copies them over.
- Add `TranscoderConfig()` in `Registry.brs`: `{ url, key }` or invalid, with the
  trailing `/` removed, mirroring `SyncConfig()`. Add `HelperOn()`.

### B2. Talking to the helper

- Add a `helperInfo` mode to `XtreamTask` (or a small `HelperTask`):
  `GET /v1/info?...&start=<s>&hash=1`, returning
  `{ duration, videoCodec, width, height, audio[], videoPlan, hash }` or an error.
  - Pass the real `start`, so the helper keeps its connection only for a stream from
    the beginning.
  - Ask for `hash=1` when online subtitles are set up.
- Add a `helperError` mode: `GET /v1/last-error`.
- Errors in plain words, as in the Samsung `src/data/transcoder.ts` `failure()`:
  - no answer: "The helper on your computer didn't answer. Is the computer on, with
    the helper running?";
  - 401: the key doesn't match;
  - otherwise the helper's own `error`.

### B3. When to use the helper (pure function, tested)

`HelperRoute(check, item, helperOn, alreadyTried)` decides. Use the helper when:
- `PlaybackCheck` blocks the title: an AVI container, or a video codec the device
  can't decode;
- the title is in the registry list `helper/titles` (as on Samsung: DTS-only titles);
- the direct route failed after its retry and the stream check found no refusal under
  any identity (a refused stream won't do better through the helper);
- `checkAudioPlayable` finds no playable track: remember the title, then reopen through
  the helper from the current position.

Never use the helper when `HelperOn()` is false. Then everything behaves as today.

### B4. The helper's content node

- `url = <helper>/v1/hls/index.m3u8?key=..&kind=..&id=..&ext=..&start=<s>&video=..&height=<h>&audio=..`, with `streamFormat = "hls"`, and no `playStart` or `HttpHeaders`.
- **`video`:** "copy" when `videoPlan` is "copy" and `CanDecodeVideo` says yes for that
  codec; otherwise "convert".
- **`height`:** the screen's height (`roDeviceInfo.GetDisplaySize().h`, 720 on the
  user's TV).
- **`audio`:** "aac" unless `CanDecodeAudio({ Codec: "ac3" })` is true.

### B4b. Online subtitles through the helper

- The Roku computes the moviehash during the online search, while the video plays:
  `SubtitleTask.brs` `osFind` calls `fileHash(videoUrl)`, which makes two range
  requests to the provider.
- Through the helper, the helper already holds the provider's one connection, so those
  requests would be a second one during playback.
- For helper titles:
  - pass the hash from `helperInfo` to the subtitle search (a `hash` field next to
    `videoUrl`, used when set);
  - leave `videoUrl` empty, so `fileHash` never runs.

### B5. Position and duration

- Add `positionSecs()` (the offset plus `m.video.position`) and `durationSecs()` (the
  helper's duration when using it, otherwise `m.video.duration`).
- Use them in `onPosition`, `saveProgress`, `renderBar`, `markFinished`, `jumpBy` and
  the jump preview (`beginHold`, `commitSeek`).
- **Check on the device** whether Roku's `position` for an EVENT HLS playlist started
  at `start=S` counts from 0 or from S. The helper's segments restart at 0, as
  `/v1/stream` does today. Pick the offset accordingly.

### B6. Jumps

- First try Roku's own seek within the playlist:
  - an EVENT playlist allows jumping within what is already converted;
  - a jump beyond it, or one the Roku refuses, reopens the playlist at the target time.
- If seeking within EVENT playlists turns out to be unreliable, always reopen, as the
  Samsung app does. Each jump then takes a few seconds.
- Optional later: a VOD playlist that lists every segment up front, with FFmpeg
  restarted at a segment's time when the Roku asks for one far ahead (Jellyfin's
  approach). Native seeking everywhere, but much more helper work; only for converted
  pictures, since copied pictures don't cut at exact times.

### B7. Errors and the end of a stream

- **A helper stream ending early:** a "finished" state more than 60 s before the end
  counts as a failure, not as watched.
- **The error screen** adds:
  - "Through the helper on your computer: picture converted to H.264, DTS sound
    converted.";
  - the helper's reason from `helperError`.
- **The identity checks** (`startProbe`) apply to the provider, not the helper. Skip
  them for helper streams.

### B8. What the screens say

With `HelperOn()`:
- clear `item.problem` (or skip the badge) for titles the helper can convert, in
  `XtreamParse.brs`, `SearchIndex.brs`, `HomeScreen.brs`, `DetailsScreen.brs` and
  `CategoryScreen.brs`;
- skip `showUnplayable()`;
- in Details, replace the butter "Won't play" line with "This TV can't play this file
  itself, so the helper on your computer converts it while you watch." (or "Roku"
  where `DeviceWord()` says so).

### B9. Tests

In `tests/utils_test.brs` and `tests/parse_test.brs`, test:
- `TranscoderConfig` (with `tests/fake_registry.brs`; the account file is read from
  `pkg:`, so follow how `SyncConfig` is tested, or make it take the parsed JSON);
- `HelperRoute`;
- the URL builder, with keys and ids URL-encoded;
- the `video`, `height` and `audio` choices;
- the remembered titles list.

`tools/test.sh` must print ALL PASSED.

### B10. Docs and version

- **Roku `docs/features.md`:**
  - a new section "The helper on a computer at home";
  - update §7 (AVI line), the §1 table, §12 data formats (`transcoder` in
    `account.json`, `helper/titles` in the registry) and the §14 checklist (Samsung
    has it).
- **README:** the same Windows setup steps as the Samsung README's helper section, plus
  "copy `transcoder` into `src/source/account.json`".
- Bump the version in the Roku manifest; keep any version that `AppUserAgent()` reports
  in step.

## 6. Verify on the Roku (in this order)

1. **Can it play the helper's output?**
   - Point a test build at `/v1/stream` with no `streamFormat`, then with
     `streamFormat = "hls"` at `/v1/hls/index.m3u8`.
   - Expect only the HLS one to play.
   - If plain MPEG-TS does play, A1 is optional for the Roku; keep it anyway for better
     jumps.
2. **An AVI title:** it plays, with sound, and the bar shows the right time and length.
3. **HEVC:**
   - a 1080p HEVC title converted to 720p plays without stalling;
   - the helper window shows which encoder it used;
   - watch the PC's CPU or GPU load.
4. **A DTS-only MKV:** sound plays, as AC-3 or AAC.
5. **Jumps** inside and beyond the converted part; resume from Continue Watching; Up
   Next to an episode that also needs the helper.
6. **The PC switched off:** the error says the helper didn't answer.
7. **No `transcoder` in `account.json`:** everything behaves exactly as before.

## 7. Risks and open questions

- **How Roku handles EVENT playlists:** its `position` and `duration`, and how far it
  can jump. Settle this first (B5, B6).
- **Start time:** the helper's speed fix (section 2) carries over to the Roku only if
  the HLS output reads through it and the Roku asks for `start` and `hash` as above.
  The helper window's "provider started sending after X s" line shows how much of
  what remains is the provider's own delay.
- **PC load:** converting HEVC in real time needs hardware help or a reasonably modern
  processor. Converting to 720p helps a lot. The helper prints the encoder at
  startup.
- **One provider connection:** the Samsung TV and the Roku can't play at once, with or
  without the helper. A second device's request stops the first one's stream.
- **The PC's address can change:** suggest a fixed address in the router. The helper
  already warns when it no longer matches `personal.json`.
- **Subtitles:** embedded tracks don't come through the helper (`-sn`); online
  subtitles still work. Converting text subtitles to WebVTT in the HLS output is a
  possible later step.
- **Disk and memory:** HLS segments take room in the temp folder (about 1 GB per hour
  at 720p), so cleanup (A1) matters. The read cache takes up to about 100 MB of
  memory.

## 8. Working agreements (from the earlier sessions)

- **Secrets stay out of git:**
  - never commit `personal.json`, `account.json`, logins, the sync key or the helper
    key;
  - before every push, scan the diff for the provider's host, the username and the
    keys;
  - logs and on-screen reports hide them.
- **Wording for the user:** plain words; no em dashes in anything written for the user.
- **Messages explain who said what:** "Your computer says: ...", the address used, and
  the usual causes. Don't guess a cause as fact.
- **Be gentle with the provider:** no bursts, one connection, stop after refusals
  (features.md §3).
- **Roku BrightScript gotchas:** see features.md §13. Reserved words can't be variable
  names, locals can't share a function's name, guard `invalid` comparisons, and HTTP
  only in Task nodes.
- **Commits:** small and validated. Run `npm run check` (Samsung) and `tools/test.sh`
  (Roku) before each push.
