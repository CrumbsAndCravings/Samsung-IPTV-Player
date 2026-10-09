// The same account at a new address (the Roku app's LoginChange, NoteLogin, the build's
// moved address and PickOsAccount's "removed"; docs/features.md §2.5 and §8).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastLogin, loginChange, movedFromSpace, noteLogin, passwordStamp, spaceOf } from "../src/core/account";
import { applyBuiltInLogin, applyBuiltInSubtitles, usePersonal } from "../src/core/personal";
import { progressList, progressPut } from "../src/core/progress";
import { clearAccount, loadCreds, loadOsAccount, MemoryStore, readJson, saveCreds, useStore, writeJson } from "../src/core/storage";

const jane = { server: "http://old.example", username: "jane", password: "pw1" };

describe("a login compared with the last one", () => {
  it("is the same, moved, or another account", () => {
    const last = { server: "http://old.example", username: "jane", pass: passwordStamp("pw1") };
    expect(loginChange(last, { ...last, server: "HTTP://OLD.example/" })).toBe("same");
    expect(loginChange(last, { ...last, server: "http://new.example" })).toBe("moved");
    expect(loginChange(last, { server: "http://new.example", username: "jane", pass: passwordStamp("other") })).toBe("other");
    expect(loginChange(last, { ...last, username: "sam" })).toBe("other");
    expect(passwordStamp("pw1")).toMatch(/^[0-9a-f]{16}$/);
    expect(passwordStamp("pw1")).not.toBe("pw1");
  });
});

describe("signing in", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("keeps what the TV learnt for the same account at a new address, and brings Continue Watching over", () => {
    noteLogin(jane);
    writeJson("mylist", "items", [{ k: "m:1" }]);
    noteLogin({ ...jane, server: "http://new.example" });
    expect(readJson("mylist", "items")).toEqual([{ k: "m:1" }]);
    expect(movedFromSpace()).toBe(spaceOf(jane));
    expect(lastLogin()!.server).toBe("http://new.example");
    expect(JSON.stringify(lastLogin())).not.toContain("pw1");
  });

  it("starts fresh for another account", () => {
    noteLogin(jane);
    writeJson("mylist", "items", [{ k: "m:1" }]);
    writeJson("taste", "history", [{ k: "m:1" }]);
    writeJson("taste", "picks", [{ s: "picks", t: "Top picks for you", i: [["m", "1", "Jawan", "", "mkv", "2023"]] }]);
    noteLogin({ server: "http://other.example", username: "sam", password: "x" });
    expect(readJson("mylist", "items")).toBeUndefined();
    expect(readJson("taste", "history")).toBeUndefined();
    expect(readJson("taste", "picks")).toBeUndefined();
    expect(movedFromSpace()).toBe("");
  });

  it("keeps the history across a sign-out for the same account", () => {
    noteLogin(jane);
    writeJson("taste", "history", [{ k: "m:1" }]);
    clearAccount();
    noteLogin(jane);
    expect(readJson("taste", "history")).toEqual([{ k: "m:1" }]);
  });
});

describe("a personal build whose address moved", () => {
  beforeEach(() => useStore(new MemoryStore()));
  afterEach(() => usePersonal(null));

  it("moves the saved login and brings Continue Watching over from the old address", () => {
    usePersonal(jane);
    saveCreds(jane);
    expect(applyBuiltInLogin()).toBe(false);
    progressPut({ k: "m:1", kind: "movie", id: "1", name: "A", poster: "", bd: "", ext: "mkv", pos: 60, dur: 600 }, 10);
    usePersonal({ ...jane, server: "http://new.example" });
    expect(applyBuiltInLogin()).toBe(false);
    expect(loadCreds()!.server).toBe("http://new.example");
    expect(progressList().length).toBe(1);
    expect(movedFromSpace()).toBe(spaceOf(jane));
  });
});

describe("online subtitles removed on the TV", () => {
  beforeEach(() => useStore(new MemoryStore()));
  afterEach(() => usePersonal(null));

  it("keep the build's own off until sign-out, or a build with other details", () => {
    const os = { apiKey: "key1", username: "jane", password: "pw" };
    usePersonal({ opensubtitles: os });
    expect(applyBuiltInSubtitles()).toBe(true);
    writeJson("opensubtitles", "account", { removed: true });
    expect(applyBuiltInSubtitles()).toBe(false);
    expect(loadOsAccount()).toBeNull();
    usePersonal({ opensubtitles: { ...os, apiKey: "key2" } });
    expect(applyBuiltInSubtitles()).toBe(true);
    writeJson("opensubtitles", "account", { removed: true });
    clearAccount();
    expect(applyBuiltInSubtitles()).toBe(true);
    expect(loadOsAccount()!.apiKey).toBe("key2");
  });
});
