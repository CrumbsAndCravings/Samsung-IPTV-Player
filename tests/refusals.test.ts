// Ported from the Roku app's tests/utils_test.brs ("Refused requests"), plus the new
// title, link and sync helpers.
import { describe, expect, it } from "vitest";
import { briefText, httpDetail, isCloudflare, isCloudflareBlock, isRefusalCode, signInErrorText } from "../src/core/refusals";
import { commas, parseProviderLink, splitTitle, syncSpaceText } from "../src/core/utils";

const q = '"';

describe("refused requests", () => {
  it("say who answered and what they said", () => {
    expect(httpDetail(403, { server: "nginx/1.18.0 (Ubuntu)" }, "")).toBe("HTTP 403 from nginx, no reason given");
    expect(httpDetail(403, {}, "  ")).toBe("HTTP 403, no reason given");
    expect(httpDetail(403, { server: "Apache" }, "<html><head><title>403 Forbidden</title><style>body{color:red}</style></head><body><h1>Forbidden</h1></body></html>")).toBe(
      "HTTP 403 from Apache: " + q + "403 Forbidden Forbidden" + q,
    );
    expect(httpDetail(401, { server: "XUI" }, '{"message":"Line expired"}')).toBe("HTTP 401 from XUI: " + q + "Line expired" + q);
    expect(httpDetail(404, { server: "openresty" }, "<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>")).toBe(
      "HTTP 404 from openresty: " + q + "404 Not Found nginx" + q,
    );
  });
  it("only blame Cloudflare when its own page says so", () => {
    expect(httpDetail(403, { server: "cloudflare", "cf-ray": "8abc-YYZ" }, "error code: 1020")).toBe("HTTP 403 from Cloudflare (error 1020)");
    expect(httpDetail(403, { "cf-ray": "8abc" }, "<span>Error</span> <span>1006</span> Access denied")).toBe("HTTP 403 from Cloudflare (error 1006)");
    expect(httpDetail(403, { server: "cloudflare", "cf-mitigated": "challenge" }, "")).toBe("HTTP 403 from Cloudflare (browser check)");
    expect(httpDetail(403, { server: "cloudflare" }, '<html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script></head></html>')).toBe(
      "HTTP 403 from Cloudflare (browser check)",
    );
    expect(httpDetail(403, { server: "cloudflare" }, "<h1>Sorry, you have been blocked</h1><p>You are unable to access example.com</p>")).toBe("HTTP 403 from Cloudflare (blocked)");
    expect(httpDetail(403, { server: "cloudflare" }, "")).toBe("HTTP 403 via Cloudflare, no reason given");
    expect(httpDetail(403, { server: "cloudflare", "cf-ray": "8abc" }, "Access Denied")).toBe("HTTP 403 via Cloudflare: " + q + "Access Denied" + q);
    expect(isCloudflareBlock({ server: "cloudflare" }, "error code: 1020")).toBe(true);
    expect(isCloudflareBlock({ server: "cloudflare" }, "")).toBe(false);
    expect(isCloudflare({ "cf-ray": "8abc" })).toBe(true);
    expect(isCloudflare({ server: "nginx" })).toBe(false);
  });
  it("know refusals and keep text brief", () => {
    expect(isRefusalCode(403)).toBe(true);
    expect(isRefusalCode(429)).toBe(true);
    expect(isRefusalCode(404)).toBe(false);
    expect(briefText("Forbidden", 70)).toBe("Forbidden");
    expect(briefText("x".repeat(200), 70).length).toBe(70);
    expect(briefText(" a\n\tb&nbsp;c ", 70)).toBe("a b c");
  });
  it("explain a failed sign-in with the address and the usual causes", () => {
    const text = signInErrorText("The server refused the request: HTTP 403 from nginx, no reason given.", "http://a.b", 403, false);
    expect(text.split("\n")[1]).toBe("Address: http://a.b");
    expect(text).toMatch(/Often a typo in the login/);
    expect(signInErrorText("x", "http://a.b", 404, false)).toMatch(/often with a port like :8080/);
    expect(signInErrorText("x", "http://a.b", 403, true)).toMatch(/Only the provider can allow it/);
  });
});

describe("titles, links and sync", () => {
  it("take provider tags and years off titles", () => {
    expect(splitTitle("EN ★ Alterity - 2026")).toEqual({ title: "Alterity", year: "2026" });
    expect(splitTitle("PUN ★ Nikka Zaildar 4 - 2025").title).toBe("Nikka Zaildar 4");
    expect(splitTitle("BL ★ Don't Be Shy! - 2026").title).toBe("Don't Be Shy!");
    expect(splitTitle("IN | Chumbak").title).toBe("Chumbak");
    expect(splitTitle("Up").title).toBe("Up");
    expect(splitTitle("UFO - 2018").title).toBe("UFO");
    expect(splitTitle("M3GAN").title).toBe("M3GAN");
    expect(splitTitle("Spider-Man: No Way Home - 2021").title).toBe("Spider-Man: No Way Home");
    expect(splitTitle("EN ★ Heat").year).toBe("");
  });
  it("read logins from playlist and stream links", () => {
    expect(parseProviderLink("http://a.b:80/playlist/jane/s3cret/m3u_plus?output=hls")).toEqual({ server: "http://a.b:80", username: "jane", password: "s3cret" });
    expect(parseProviderLink("http://a.b/movie/joe/pw%40x/123.mkv").password).toBe("pw@x");
    expect(parseProviderLink("http://a.b:8080").username).toBe("");
  });
  it("build the sync space text the same way as every other device", () => {
    expect(syncSpaceText({ server: "HTTP://Host.Example:80/", username: "Jane" })).toBe("http://host.example\nJane");
    expect(syncSpaceText({ server: "https://host.example:443", username: "j" })).toBe("https://host.example\nj");
    expect(syncSpaceText({ server: "host.example:8080", username: "j" })).toBe("http://host.example:8080\nj");
  });
  it("write numbers with commas", () => {
    expect(commas(12)).toBe("12");
    expect(commas(1234)).toBe("1,234");
    expect(commas(1234567)).toBe("1,234,567");
  });
});
