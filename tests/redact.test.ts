import { describe, expect, it } from "vitest";
import { credsSecrets, redact } from "../src/core/redact";

describe("redact", () => {
  const secrets = credsSecrets("line.example.com:8080", "jane.doe", "p@ss word");
  it("hides the server, username and password, raw or URL-encoded", () => {
    const url = "http://line.example.com:8080/movie/jane.doe/p%40ss%20word/12.mkv";
    expect(redact(url, secrets)).toBe("<server>/movie/<user>/<password>/12.mkv");
    expect(redact("Couldn't reach LINE.EXAMPLE.COM", secrets)).toBe("Couldn't reach <server>");
    expect(redact("user jane.doe typed p@ss word", secrets)).toBe("user <user> typed <password>");
  });
  it("ignores values too short to hide safely", () => {
    expect(redact("a b c", credsSecrets("", "a", "b"))).toBe("a b c");
  });
});
