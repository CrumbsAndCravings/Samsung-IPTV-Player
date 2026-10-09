// Where the helper runs: this computer's address on the home network and on Tailscale,
// and whether it's a small computer such as a Raspberry Pi. Used by the helper itself
// and by helper/address.mjs.

import { readFileSync } from "node:fs";
import os from "node:os";

// This computer's address on the home network, as the TV will reach it.
export function lanAddress() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|wsl|hyper-v|loopback|docker/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      found.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || "127.0.0.1";
}

// This computer's Tailscale address (100.64.0.0 to 100.127.255.255), when Tailscale is on:
// a private network of your own devices, so the phone reaches the helper from anywhere
// (5G, another Wi-Fi) at one address. "" without it.
export function tailscaleAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const parts = a.address.split(".").map(Number);
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return a.address;
    }
  }
  return "";
}

// "Raspberry Pi 5 Model B Rev 1.0" on a Raspberry Pi, "a small ARM computer" on another
// Linux ARM board with four cores or fewer, "" anywhere else (a PC, a Mac). A small
// computer converts on its processor with quicker settings.
export function smallComputer() {
  if (process.platform !== "linux") return "";
  try {
    const model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
    if (/raspberry pi/i.test(model)) return model;
  } catch {
    // Not a board that says what it is.
  }
  return /^arm/.test(os.arch()) && os.cpus().length <= 4 ? "a small ARM computer" : "";
}
