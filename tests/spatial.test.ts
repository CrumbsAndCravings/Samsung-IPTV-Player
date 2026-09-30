import { describe, expect, it } from "vitest";
import { directionScore } from "../src/ui/spatial";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

describe("spatial focus", () => {
  const field = box(100, 100, 1000, 70);
  const left = box(100, 200, 490, 70);
  const right = box(610, 200, 490, 70);
  const button = box(100, 300, 250, 66);

  it("only considers elements in the pressed direction", () => {
    expect(directionScore(field, left, "up")).toBeNull();
    expect(directionScore(left, field, "down")).toBeNull();
    expect(directionScore(left, right, "left")).toBeNull();
  });
  it("prefers the closest row, then the best aligned element", () => {
    const toLeft = directionScore(field, left, "down") as number;
    const toRight = directionScore(field, right, "down") as number;
    const toButton = directionScore(field, button, "down") as number;
    expect(toLeft).toBeLessThan(toRight);
    expect(toLeft).toBeLessThan(toButton);
    expect(directionScore(right, button, "down")).toBeGreaterThan(directionScore(left, button, "down") as number);
  });
  it("moves sideways within a row", () => {
    expect(directionScore(left, right, "right")).toBe(20 + 0 + 0);
  });
});
