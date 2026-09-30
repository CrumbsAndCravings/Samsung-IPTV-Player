// Ported from the Roku app's tests/utils_test.brs: moviehash vectors checked against a
// Python reference (struct '<Q' sums).
import { describe, expect, it } from "vitest";
import { osHashHex, splitSize } from "../src/core/oshash";

const head = [165, 77, 202, 24, 37, 48, 187, 29, 109, 19, 44, 222, 214, 35, 123, 46, 217, 30, 63, 114, 31, 203, 25, 113, 23, 68, 148, 214, 73, 60, 157, 92, 52, 96, 190, 49, 32, 30, 105, 254, 218, 160, 238, 232, 185, 153, 127, 92, 124, 41, 153, 253, 175, 229, 147, 37, 60, 214, 84, 175, 77, 250, 215, 20];
const tail = [39, 160, 174, 179, 254, 233, 35, 47, 138, 242, 33, 31, 158, 228, 145, 197, 177, 11, 236, 181, 86, 59, 252, 30, 111, 147, 66, 126, 203, 200, 254, 41, 85, 229, 205, 142, 70, 220, 142, 212, 183, 194, 118, 77, 42, 90, 77, 118, 119, 6, 248, 93, 134, 144, 2, 74, 214, 189, 163, 64, 27, 233, 200, 203];

describe("moviehash", () => {
  it("matches the Roku vectors", () => {
    expect(osHashHex(head, tail, 131072)).toBe("4d9a760e894662f2");
    expect(osHashHex(head, tail, 5368709120)).toBe("4d9a760fc94462f2");
    expect(osHashHex(head, tail, "6148914691236517205")).toBe("a2efcb63de99b847");
  });
  it("wraps at 64 bits", () => {
    const ff = new Array(64).fill(255);
    expect(osHashHex(ff, ff, 12884901895)).toBe("00000002fffffff7");
  });
  it("takes the bytes as a Uint8Array too", () => {
    expect(osHashHex(new Uint8Array(head), new Uint8Array(tail), 131072)).toBe("4d9a760e894662f2");
  });
  it("splits sizes into 32-bit halves", () => {
    expect(splitSize(5368709120)).toEqual([1, 1073741824]);
    expect(splitSize("5368709120")).toEqual([1, 1073741824]);
    expect(splitSize("18446744073709551617")).toEqual([0, 1]); // 2^64 + 1 wraps
  });
});
