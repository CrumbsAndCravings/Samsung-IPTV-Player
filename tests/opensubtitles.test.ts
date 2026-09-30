import { describe, expect, it } from "vitest";
import { APP_USER_AGENT, osBase, osErrorText, parseContentRangeTotal, serverMessage } from "../src/core/opensubtitles";

describe("OpenSubtitles helpers", () => {
  it("names the app in the user agent", () => {
    expect(APP_USER_AGENT).toMatch(/^ARANplus v/);
  });
  it("uses the server login hands back", () => {
    expect(osBase("")).toBe("https://api.opensubtitles.com/api/v1");
    expect(osBase("vip-api.opensubtitles.com")).toBe("https://vip-api.opensubtitles.com/api/v1");
    expect(osBase("https://vip-api.opensubtitles.com/")).toBe("https://vip-api.opensubtitles.com/api/v1");
  });
  it("quotes OpenSubtitles' own words", () => {
    expect(serverMessage({ message: "Invalid API key" })).toBe("Invalid API key");
    expect(serverMessage({ errors: ["one", "", "two"] })).toBe("one two");
    expect(osErrorText(401, { message: "invalid username/password" })).toBe("OpenSubtitles said HTTP 401: invalid username/password.");
    expect(osErrorText(406, {})).toBe("OpenSubtitles said HTTP 406. Downloads reset within a day.");
    expect(osErrorText(0, undefined)).toBe("Couldn't reach OpenSubtitles. Check the TV's internet connection.");
  });
  it("reads the file size from Content-Range", () => {
    expect(parseContentRangeTotal("bytes 0-65535/1234567890")).toBe(1234567890);
    expect(parseContentRangeTotal("bytes 0-65535/*")).toBe(-1);
    expect(parseContentRangeTotal("")).toBe(-1);
    expect(parseContentRangeTotal("bytes 0-1/6148914691236517")).toBe(6148914691236517);
  });
});
