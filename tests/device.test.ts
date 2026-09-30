import { describe, expect, it } from "vitest";
import { chromiumMajor, chromiumVersion, describeModelYear, modelYear, tizenFromUserAgent } from "../src/core/device";

const TIZEN_5 = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) 2.2 Chrome/63.0.3239.84 TV Safari/537.36";

describe("engine", () => {
  it("reads Chromium and Tizen versions from the user agent", () => {
    expect(chromiumVersion(TIZEN_5)).toBe("63.0.3239.84");
    expect(chromiumMajor(TIZEN_5)).toBe(63);
    expect(tizenFromUserAgent(TIZEN_5)).toBe("5.0");
    expect(chromiumVersion("Something else")).toBe("");
    expect(chromiumMajor("Something else")).toBe(0);
  });
});

describe("model year", () => {
  it("reads the letter after the QLED series", () => {
    expect(modelYear("QN65Q60RAFXZC")).toMatchObject({ year: 2019, tizen: "5.0", chromium: 63 });
    expect(modelYear("QN65Q60AAFXZC")).toMatchObject({ year: 2021, chromium: 76 });
    expect(modelYear("qn65q60tafxzc")).toMatchObject({ year: 2020 });
    expect(modelYear("QE65Q60DAUXXU")).toMatchObject({ year: 2024, chromium: 108 });
  });
  it("reads the letter after the size on other lines", () => {
    expect(modelYear("UN65TU8000FXZC")).toMatchObject({ year: 2020 });
    expect(modelYear("UN55RU7100")).toMatchObject({ year: 2019 });
  });
  it("gives up on unknown codes", () => {
    expect(modelYear("19_MUSEL_QTV")).toBeNull();
    expect(modelYear("")).toBeNull();
    expect(describeModelYear("")).toBe("");
    expect(describeModelYear("QN65Q60BAFXZC")).toBe("2022 model: shipped with Tizen 6.5 (Chromium 85)");
  });
});
