import { beforeEach, describe, expect, it } from "vitest";
import { clearAccount, loadCreds, loadOsAccount, MemoryStore, readOsFields, regRead, saveCreds, saveOsAccount, useStore } from "../src/core/storage";

describe("storage", () => {
  beforeEach(() => useStore(new MemoryStore()));

  it("round-trips the IPTV login", () => {
    expect(loadCreds()).toBeNull();
    saveCreds({ server: "http://a.b", username: "jane", password: "pw" });
    expect(loadCreds()).toEqual({ server: "http://a.b", username: "jane", password: "pw" });
    expect(regRead("account", "creds")).toContain("jane");
  });

  it("treats a login without server or username as missing", () => {
    saveCreds({ server: "", username: "jane", password: "pw" });
    expect(loadCreds()).toBeNull();
  });

  it("keeps OpenSubtitles fields even before they work", () => {
    saveOsAccount({ apiKey: "", username: "me", password: "pw", token: "", baseUrl: "" });
    expect(loadOsAccount()).toBeNull();
    expect(readOsFields().username).toBe("me");
    saveOsAccount({ apiKey: "k", username: "me", password: "pw", token: "t", baseUrl: "vip-api.opensubtitles.com" });
    expect(loadOsAccount()).toMatchObject({ apiKey: "k", token: "t" });
  });

  it("clears the account, progress and OpenSubtitles on sign out", () => {
    saveCreds({ server: "http://a.b", username: "jane", password: "pw" });
    saveOsAccount({ apiKey: "k", username: "", password: "", token: "", baseUrl: "" });
    clearAccount();
    expect(loadCreds()).toBeNull();
    expect(loadOsAccount()).toBeNull();
  });
});
