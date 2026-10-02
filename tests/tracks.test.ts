// Ported from the Roku app's tests/utils_test.brs (audio and subtitle tracks). Roku's
// Video node fields map to { id, language, description }.
import { describe, expect, it } from "vitest";
import { audioOptions, fromAvplay, languageName, optionIndex, subtitleOptions } from "../src/core/tracks";

describe("languages", () => {
  it("names language codes", () => {
    expect(languageName("hin")).toBe("Hindi");
    expect(languageName("EN")).toBe("English");
    expect(languageName("xyz")).toBe("XYZ");
    expect(languageName("und")).toBe("");
  });
});

describe("audio options", () => {
  const audio = audioOptions([
    { id: "1", language: "hin", description: "" },
    { id: "2", language: "eng", description: "Commentary" },
    { id: "3", language: "und", description: "" },
    { id: "", language: "eng", description: "" },
  ]);
  it("labels each track", () => {
    expect(audio.length).toBe(3);
    expect(audio[0].label).toBe("Hindi");
    expect(audio[1].label).toBe("English · Commentary");
    expect(audio[2].label).toBe("Track 3");
    expect(audio[0].language).toBe("hin");
  });
});

describe("subtitle options", () => {
  const subs = subtitleOptions([
    { id: "mkv/3", language: "eng", description: "English" },
    { id: "mkv/4", language: "eng", description: "SDH" },
    { id: "mkv/5", language: "", description: "" },
  ]);
  it("starts with Off and labels each track", () => {
    expect(subs.length).toBe(4);
    expect(subs[0].label).toBe("Off");
    expect(subs[1].label).toBe("English");
    expect(subs[2].label).toBe("English · SDH");
    expect(subs[3].label).toBe("Subtitles 3");
  });
  it("finds options", () => {
    expect(optionIndex(subs, "language", "eng")).toBe(1);
    expect(optionIndex(subs, "id", "mkv/4")).toBe(2);
    expect(optionIndex(subs, "language", "fre")).toBe(-1);
    expect(subtitleOptions(null).length).toBe(1);
  });
});

describe("AVPlay tracks", () => {
  it("uses AVPlay's index as the id", () => {
    const tracks = [
      { index: 0, kind: "VIDEO" as const, language: "", codec: "h265", detail: {} },
      { index: 1, kind: "AUDIO" as const, language: "eng", codec: "mpeg", detail: {} },
      { index: 3, kind: "TEXT" as const, language: "en", codec: "", detail: {} },
    ];
    expect(audioOptions(fromAvplay(tracks, "AUDIO"))).toEqual([{ id: "1", label: "English · MPEG", language: "eng", format: "mpeg" }]);
    expect(subtitleOptions(fromAvplay(tracks, "TEXT"))[1]).toEqual({ id: "3", label: "English", language: "en" });
  });
});

describe("audio formats", () => {
  it("are shown and kept, from the Roku app's tests/utils_test.brs", () => {
    const withFormat = audioOptions([
      { id: "1", language: "eng", description: "", format: "DTS" },
      { id: "2", language: "eng", description: "", format: "AC3" },
    ]);
    expect(withFormat[0].label).toBe("English · DTS");
    expect(withFormat[1].format).toBe("ac3");
    expect(audioOptions([{ id: "1", language: "eng", description: "" }])[0].format).toBe("");
  });
});
