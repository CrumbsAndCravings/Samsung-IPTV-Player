// A personal build's settings (docs/features.md §2.2, §4.2, §9.4), with made-up logins.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBuiltInLogin, applyBuiltInSubtitles, builtInCreds, builtInSubtitles, languagePrefs, syncConfig, usePersonal } from "../src/core/personal";
import { progressList, progressPut } from "../src/core/progress";
import { clearAccount, loadCreds, loadOsAccount, MemoryStore, saveCreds, saveOsAccount, useStore, writeJson } from "../src/core/storage";

const login = { server: "provider.example:8080/", username: "jane", password: " pw1 " };
const watched = () => progressPut({ k: "m:1", kind: "movie", id: "1", name: "A", poster: "", bd: "", ext: "mkv", pos: 60, dur: 600 }, 10);

describe("a personal build", () => {
  beforeEach(() => useStore(new MemoryStore()));
  afterEach(() => usePersonal(null));

  it("reads its login, languages and sync settings", () => {
    usePersonal({ ...login, languages: ["en", "hi"], sync: { url: "https://sync.example/", key: "k" } });
    expect(builtInCreds()).toEqual({ server: "http://provider.example:8080", username: "jane", password: "pw1" });
    expect(languagePrefs()).toEqual(["en", "hi"]);
    expect(syncConfig()).toEqual({ url: "https://sync.example", key: "k" });
    writeJson("prefs", "languages", ["pa"]);
    expect(languagePrefs()).toEqual(["pa"]);
    usePersonal({ languages: ["en"] });
    expect(builtInCreds()).toBeNull();
    expect(syncConfig()).toBeNull();
    usePersonal(null);
    writeJson("prefs", "languages", "nope");
    expect(languagePrefs()).toEqual([]);
  });

  it("keeps a saved login for the same account, and its Continue Watching", () => {
    usePersonal(login);
    saveCreds({ server: "http://PROVIDER.example:8080", username: "jane", password: "old" });
    watched();
    expect(applyBuiltInLogin()).toBe(false);
    expect(loadCreds()!.password).toBe("pw1");
    expect(progressList().length).toBe(1);
    expect(applyBuiltInLogin()).toBe(false);
  });

  it("follows the provider to a new address, keeping Continue Watching", () => {
    usePersonal({ ...login, server: "http://new.example" });
    saveCreds({ server: "http://provider.example:8080", username: "jane", password: "pw1" });
    watched();
    expect(applyBuiltInLogin()).toBe(false);
    expect(loadCreds()).toEqual({ server: "http://new.example", username: "jane", password: "pw1" });
    expect(progressList().length).toBe(1);
  });

  it("treats a new address with another password as another account", () => {
    usePersonal({ ...login, server: "http://new.example" });
    saveCreds({ server: "http://provider.example:8080", username: "jane", password: "old" });
    watched();
    expect(applyBuiltInLogin()).toBe(true);
    expect(loadCreds()).toBeNull();
    expect(progressList().length).toBe(0);
  });

  it("replaces another account's login and clears its Continue Watching", () => {
    usePersonal(login);
    saveCreds({ server: "http://other.example", username: "sam", password: "x" });
    watched();
    expect(applyBuiltInLogin()).toBe(true);
    expect(loadCreds()).toBeNull();
    expect(progressList().length).toBe(0);
    // Once seen, the same build leaves things alone.
    watched();
    expect(applyBuiltInLogin()).toBe(false);
    expect(progressList().length).toBe(1);
  });
});

describe("OpenSubtitles in a personal build", () => {
  beforeEach(() => useStore(new MemoryStore()));
  afterEach(() => usePersonal(null));
  const os = { apiKey: "key1", username: "jane", password: "pw" };

  it("reads its details", () => {
    usePersonal({ opensubtitles: { apiKey: " key1 ", username: "jane", password: "pw" } });
    expect(builtInSubtitles()).toEqual(os);
    usePersonal({ opensubtitles: { apiKey: "key1", username: "jane" } });
    expect(builtInSubtitles()).toEqual({ apiKey: "key1", username: "", password: "" });
    usePersonal({ opensubtitles: { username: "jane", password: "pw" } });
    expect(builtInSubtitles()).toBeNull();
    expect(applyBuiltInSubtitles()).toBe(false);
  });

  it("sets them up when the TV has none, and keeps what's typed on the TV", () => {
    usePersonal({ opensubtitles: os });
    expect(applyBuiltInSubtitles()).toBe(true);
    expect(loadOsAccount()).toEqual({ ...os, token: "", baseUrl: "" });
    expect(applyBuiltInSubtitles()).toBe(false);
    saveOsAccount({ apiKey: "mine", username: "", password: "", token: "", baseUrl: "" });
    expect(applyBuiltInSubtitles()).toBe(false);
    expect(loadOsAccount()!.apiKey).toBe("mine");
    // Signing out clears them; the build's come back.
    clearAccount();
    expect(applyBuiltInSubtitles()).toBe(true);
    expect(loadOsAccount()!.apiKey).toBe("key1");
    // A build with new details replaces them.
    usePersonal({ opensubtitles: { ...os, apiKey: "key2" } });
    expect(applyBuiltInSubtitles()).toBe(true);
    expect(loadOsAccount()!.apiKey).toBe("key2");
  });

  it("leaves the same details alone, sign-in token and all", () => {
    saveOsAccount({ ...os, token: "t", baseUrl: "https://vip.example" });
    usePersonal({ opensubtitles: os });
    expect(applyBuiltInSubtitles()).toBe(false);
    expect(loadOsAccount()!.token).toBe("t");
  });
});

describe("the helper on a computer at home", () => {
  beforeEach(() => useStore(new MemoryStore()));
  afterEach(() => usePersonal(null));

  it("is set up by personal.json", async () => {
    const { helperOn, transcoderConfig } = await import("../src/core/personal");
    expect(helperOn()).toBe(false);
    usePersonal({ transcoder: { url: "http://192.168.1.50:8090/", key: "abc" } });
    expect(transcoderConfig()).toEqual({ url: "http://192.168.1.50:8090", key: "abc" });
    expect(helperOn()).toBe(true);
    usePersonal({ transcoder: { url: "http://192.168.1.50:8090" } });
    expect(helperOn()).toBe(false);
  });

  it("is asked for a title from a time, and remembers what worked", async () => {
    const { helperStreamUrl, learnedMode, learnMode, needsHelper, rememberNeedsHelper } = await import("../src/data/transcoder");
    const { makeItem } = await import("../src/core/items");
    usePersonal({ transcoder: { url: "http://192.168.1.50:8090", key: "k y" } });
    const episode = makeItem({ kind: "episode", itemId: "77", ext: "AVI" });
    expect(helperStreamUrl(episode, 754.6, "convert")).toBe("http://192.168.1.50:8090/v1/stream?key=k%20y&kind=series&id=77&ext=avi&start=754&video=convert");
    expect(learnedMode("mpeg4")).toBe("");
    learnMode("mpeg4", "copy");
    expect(learnedMode("mpeg4")).toBe("copy");
    expect(needsHelper("m:1")).toBe(false);
    rememberNeedsHelper("m:1");
    rememberNeedsHelper("m:2");
    rememberNeedsHelper("m:1");
    expect(needsHelper("m:1")).toBe(true);
    expect(needsHelper("m:2")).toBe(true);
  });

  it("says why it failed, and where it is", async () => {
    const { HELPER_NO_ANSWER, helperAddress, helperFailure } = await import("../src/data/transcoder");
    expect(helperFailure(0, false, "")).toBe(HELPER_NO_ANSWER);
    expect(helperFailure(200, true, "")).toBe(HELPER_NO_ANSWER);
    expect(helperFailure(401, false, "")).toContain("key doesn't match");
    expect(helperFailure(404, false, '{"error":"Nothing here."}')).toContain("may be older than this app");
    expect(helperFailure(502, false, '{"error":"The provider refused it."}')).toBe("Your computer says: The provider refused it.");
    expect(helperFailure(500, false, "<html>")).toBe("The helper on your computer answered HTTP 500.");
    usePersonal({ transcoder: { url: "http://192.168.1.50:8090/", key: "secret" } });
    expect(helperAddress()).toBe("http://192.168.1.50:8090");
    usePersonal(null);
    expect(helperAddress()).toBe("");
  });
});
