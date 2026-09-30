# Tests

`npm test` runs these with vitest. Most are ports of the Roku app's off-device checks (`tests/utils_test.brs` and `tests/parse_test.brs` in CrumbsAndCravings/roku-iptv-player), with the same inputs and expected results.

Differences from the Roku checks, on purpose:

- **Image sizes** are for 1080p: `w342` posters and `w1280` backdrops (Roku asked for `w185` and `w780` at 720p).
- **Not ported, because they test Roku-only APIs:** ContentNode field-name collisions, `StreamFormatFor` (a Roku stream-format hint), and the Roku playability helpers `IsUnsupportedContainer`, `UnplayableText` and `RokuVideoCodec`, including the "AVI flagged" checks on rows and search results. Samsung's playability check is `core/compat.ts`, tested in `compat.test.ts` against what the TV did in M0.
- **Roku's track lists** (`Track`, `Language`, `Name` / `TrackName`, `Description`) become `{ id, language, description }`; `fromAvplay` builds those from AVPlay's tracks.

New for Samsung: `srt.test.ts` (subtitle files), `compat.test.ts` (playability), `oshash.test.ts` (moviehash without BigInt, same vectors as Roku), `mock.test.ts` (the fake server looks like the real provider), and the setup-checks tests in `probe.test.ts`.
