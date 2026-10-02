// A personal build's settings (docs/features.md §2.2, §4.2, §9.4), with made-up logins.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBuiltInLogin, builtInCreds, languagePrefs, syncConfig, usePersonal } from "../src/core/personal";
import { progressList, progressPut } from "../src/core/progress";
import { loadCreds, MemoryStore, saveCreds, useStore, writeJson } from "../src/core/storage";

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
