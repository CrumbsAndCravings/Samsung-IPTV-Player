import { describe, expect, it } from "vitest";
import { JumpResult, MAX_FAILED_JUMPS, SEEK_RETRY_MS, SEEK_TIMEOUT_MS, SeekRunner } from "../src/core/seek";

// A pretend player whose seeks answer when the test says, and a pretend clock.
function setup() {
  const sent: number[] = [];
  const pending: { ok: () => void; fail: (name: string) => void }[] = [];
  const results: JumpResult[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const runner = new SeekRunner(
    (ms) =>
      new Promise<void>((resolve, reject) => {
        sent.push(ms);
        pending.push({ ok: resolve, fail: (name) => reject(new Error(name)) });
      }),
    (r) => results.push(r),
    (ms, fn) => timers.push({ at: now + ms, fn }),
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await flush();
  };
  return { runner, sent, pending, results, advance, flush };
}

describe("jumps", () => {
  it("go one at a time, and only the newest waiting jump is sent", async () => {
    const t = setup();
    t.runner.jump(10000);
    t.runner.jump(20000);
    t.runner.jump(30000);
    expect(t.sent).toEqual([10000]);
    t.pending[0].ok();
    await t.flush();
    expect(t.sent).toEqual([10000, 30000]);
    t.pending[1].ok();
    await t.flush();
    expect(t.results.filter((r) => r.ok).length).toBe(2);
  });

  it("try a failed jump once more before saying so", async () => {
    const t = setup();
    t.runner.jump(60000);
    t.pending[0].fail("PLAYER_ERROR_INVALID_OPERATION");
    await t.flush();
    expect(t.results).toEqual([]);
    await t.advance(SEEK_RETRY_MS);
    expect(t.sent).toEqual([60000, 60000]);
    t.pending[1].ok();
    await t.flush();
    expect(t.results).toEqual([{ ok: true, error: "", gaveUp: false }]);
  });

  it("give up only after several jumps in a row fail", async () => {
    const t = setup();
    for (let i = 0; i < MAX_FAILED_JUMPS; i++) {
      t.runner.jump(1000 * i);
      t.pending[t.pending.length - 1].fail("PLAYER_ERROR_SEEK_FAILED");
      await t.flush();
      await t.advance(SEEK_RETRY_MS);
      t.pending[t.pending.length - 1].fail("PLAYER_ERROR_SEEK_FAILED");
      await t.flush();
    }
    expect(t.results.map((r) => r.gaveUp)).toEqual([false, false, true]);
    expect(t.results[0].error).toBe("PLAYER_ERROR_SEEK_FAILED");
    expect(t.runner.gaveUp).toBe(true);
  });

  it("count a jump that never answers as done", async () => {
    const t = setup();
    t.runner.jump(5000);
    t.runner.jump(9000);
    await t.advance(SEEK_TIMEOUT_MS);
    expect(t.sent).toEqual([5000, 9000]);
  });
});
