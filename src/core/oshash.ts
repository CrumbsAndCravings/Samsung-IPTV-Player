// OpenSubtitles "moviehash", ported from the Roku app's OsHashHex (Subtitles.brs):
// the file size plus the first and last 64 KB read as little-endian 64-bit words,
// summed modulo 2^64, as 16 hex digits. It identifies the exact release, so matching
// subtitles are timed for this file.
//
// JavaScript numbers are exact only up to 2^53 and the TV's engine may lack BigInt, so
// the sum is kept as two 32-bit halves with a carry, as on Roku.

const TWO32 = 4294967296;

// A size as [high, low] 32-bit halves. Takes a number (exact below 2^53) or a string of
// decimal digits for anything bigger.
export function splitSize(size: number | string): [number, number] {
  if (typeof size === "number") {
    const whole = Math.max(0, Math.floor(size));
    return [Math.floor(whole / TWO32) % TWO32, whole % TWO32];
  }
  let hi = 0;
  let lo = 0;
  for (const ch of size.trim()) {
    const digit = ch.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) break;
    lo = lo * 10 + digit;
    const carry = Math.floor(lo / TWO32);
    lo %= TWO32;
    hi = (hi * 10 + carry) % TWO32;
  }
  return [hi, lo];
}

function hex8(value: number): string {
  return ("00000000" + value.toString(16)).slice(-8);
}

export function osHashHex(head: ArrayLike<number>, tail: ArrayLike<number>, size: number | string): string {
  let sumLo = 0;
  let sumHi = 0;
  for (const chunk of [head, tail]) {
    const n = chunk.length - (chunk.length % 8);
    for (let i = 0; i < n; i += 8) {
      // Each half is below 2^32, so thousands of them add up exactly below 2^53.
      sumLo += chunk[i] + chunk[i + 1] * 256 + chunk[i + 2] * 65536 + chunk[i + 3] * 16777216;
      sumHi += chunk[i + 4] + chunk[i + 5] * 256 + chunk[i + 6] * 65536 + chunk[i + 7] * 16777216;
    }
  }
  const [sizeHi, sizeLo] = splitSize(size);
  let low = sumLo + sizeLo;
  const high = (sumHi + sizeHi + Math.floor(low / TWO32)) % TWO32;
  low %= TWO32;
  return hex8(high) + hex8(low);
}
