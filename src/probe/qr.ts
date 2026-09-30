// Draws the report as a QR code, so it can be scanned with a phone and pasted into a
// chat instead of photographed.

import qrcode from "qrcode-generator";

// The library's default keeps only the low byte of each character; send UTF-8 instead.
qrcode.stringToBytes = (text: string) => Array.prototype.slice.call(new TextEncoder().encode(text)) as number[];

const MAX_BYTES = 2800; // version 40 at level L holds 2953

function fit(text: string): string {
  let out = text;
  while (new TextEncoder().encode(out).length > MAX_BYTES) out = out.slice(0, out.lastIndexOf("\n") > 0 ? out.lastIndexOf("\n") : out.length - 100);
  return out;
}

export function drawQr(canvas: HTMLCanvasElement, text: string, maxSize: number): void {
  const qr = qrcode(0, "L");
  qr.addData(fit(text));
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const cell = Math.max(1, Math.floor(maxSize / (count + margin * 2)));
  const size = cell * (count + margin * 2);
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#151028";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + margin) * cell, (row + margin) * cell, cell, cell);
    }
  }
}
