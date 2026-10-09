// After the account moved to a new address, the next sync brings the old address's
// Continue Watching over once (the Roku app's progressRound with "previous").
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; url: string; body: string }[] = [];
vi.mock("../src/platform/http", () => ({
  send: (req: { method?: string; url: string; body?: string }) => {
    calls.push({ method: req.method || "GET", url: req.url, body: req.body || "" });
    const old = req.url.indexOf("space=oldspace") >= 0;
    const text = old ? JSON.stringify({ entries: [{ k: "m:7", at: 50, pos: 120 }], removed: [{ k: "m:8", at: 40 }] }) : JSON.stringify({ entries: [], removed: [] });
    return { promise: Promise.resolve({ code: 200, ok: true, timedOut: false, text, headers: () => ({}), header: () => null }) };
  },
}));

import { movedFromSpace } from "../src/core/account";
import { MemoryStore, regWrite, useStore } from "../src/core/storage";
import { ProgressSync } from "../src/data/sync";

describe("Continue Watching after a move", () => {
  beforeEach(() => {
    useStore(new MemoryStore());
    calls.length = 0;
  });

  it("comes over from the old address once", async () => {
    regWrite("sync", "previous", "oldspace");
    const sync = new ProgressSync({ server: "http://new.example", username: "jane", password: "pw" }, { url: "https://sync.example", key: "k" });
    sync.now();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("space=oldspace");
    expect(calls[1].method).toBe("POST");
    const body = JSON.parse(calls[1].body);
    expect(body.entries.map((e: { k: string }) => e.k)).toEqual(["m:7"]);
    expect(body.removed.map((e: { k: string }) => e.k)).toEqual(["m:8"]);
    expect(movedFromSpace()).toBe("");
    sync.now();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(3);
    expect(calls[2].method).toBe("POST");
  });
});
