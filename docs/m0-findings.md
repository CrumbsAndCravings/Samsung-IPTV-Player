# M0 findings: what the TV told us

Results from the Setup checks screen on the real TV (report from ARAN+ 0.1.0). These answer section 2 of the plan (`docs/samsung-plan.md` in the Roku repo) and change a few later decisions, listed at the end.

## The TV

| | |
|---|---|
| Model | `QN65Q60TAFXZC` (Q60**T**, 2020) |
| Tizen | 5.5 |
| Web engine | Chromium 69 (`69.0.3497.106`) |
| Firmware | T-NKLAKUC-2743.0 |
| AVPlay | 4.0 |
| Panel | 4K (UHD); the UI plane is 1920x1080 |

The user agent has no `Chrome/` token: `... (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36`. `core/device.ts` reads both forms.

`tizen.systeminfo` reported the display as `1x1`, so screens rely on the 1920x1080 viewport instead.

## Network

- **Xtream from the packaged app works** (HTTP 200 in under a second). `<access origin="*">` is enough; no CORS trouble.
- **The account allows one connection at a time** (`max_connections` 1).
- **Range requests work:** 206 with exactly 65,536 bytes for both the first and last 64 KB of a 1.8 GB file, and `Content-Range` is readable from JavaScript.

## OpenSubtitles

- The TV replaces our `User-Agent` with its own; `X-User-Agent` arrives as sent.
- The API key works with or without `X-User-Agent`, and the login works: a free account allows 20 downloads a day.

## Library size

- Series: 6,992. One `get_series` call without a category returned 4.9 MB in about 3 s.
- Movies: 21,502. One `get_vod_streams` call without a category failed within 45 s; loading per category took 72 s.
- Containers in a sample of 4,376 movies: MKV 3,438 (79 %), MP4 867 (20 %), AVI 71 (1.6 %). 27 of 36 `get_vod_info` answers had codec details.

## Playback (AVPlay)

| File | Result |
|---|---|
| That '70s Show S1:E2, MKV, HEVC Main 10, AAC | Played; 15.5 s to start |
| Lost in Paradise (2026), MKV, HEVC Main, AAC | Played; 5.3 s to start; two English text tracks |
| Cheetahs Up Close, MP4, H.264 High, AAC 5.1 | Played; 3.7 s to start; seek reported failed (see below) |
| Harry Potter and the Order of the Phoenix, AVI, MPEG-4 ASP, MP3 | Failed three times: `PLAYER_ERROR_NOT_SUPPORTED_FORMAT` while preparing |
| They Will Kill You, MKV (0.1.1) | Played |
| Man of Steel, AVI (0.1.1) | Failed |
| DTS audio | Not tried yet |

HEVC, the reason for moving to Samsung, works. AVI doesn't: both AVIs tried failed, while every MKV and MP4 played.

**Embedded subtitles work.** With 0.1.1, Lost in Paradise's English text track showed on screen once selected: AVPlay hands the text to `onsubtitlechange` and ARAN+ draws it. That '70s Show has no text track (`T: none`), so it needs online subtitles (M4).

## Still open

- **The error name for Man of Steel**, to confirm it matches Harry Potter's.
- **Seeking.** 0.1.0 checked the position 1.5 s after a seek, which is too soon for a progressive file. 0.1.1 waits up to 10 s and logs where it landed.
- **DTS audio.**
- **Slow start of the Main 10 file** (15.5 s). Worth timing again.

## Decisions for later milestones

- **Build for Chromium 69** (ES2018 plus `Array.flat`), not 63. CSS limits stay: no flexbox `gap`, `aspect-ratio`, `inset`, `backdrop-filter` or `clamp()`.
- **One stream at a time.** Never open a second connection to a stream while one is playing. Compute the moviehash (M4) before starting playback, not during. Don't pre-load the next episode. After stopping a stream, expect the provider to take a moment to free the slot; retry once after a short wait.
- **OpenSubtitles headers:** send `Api-Key` and `X-User-Agent: ARANplus v<version>`. Don't count on `User-Agent`.
- **Search index (M5):** load series with the single call. Load movies per category in the background, three at a time, from the first search of a session; it takes over a minute, so the "Still indexing your library" note matters. Consider keeping the index between sessions.
- **Playability check (M2 and M3):** mark AVI "Won't play" on this TV, with "OK to try anyway" as on Roku. It is 1.6 % of the movies. Remember other failures per title rather than per codec combination, so one bad file doesn't mark a whole format.
- **Provider flood protection:** after the setup screen loaded all movies category by category (well over a hundred requests in about a minute), the provider stopped answering for a while, and sign-in timed out until it recovered. Keep request bursts small (at most three at once, with pauses between batches) and cache what is already loaded.
