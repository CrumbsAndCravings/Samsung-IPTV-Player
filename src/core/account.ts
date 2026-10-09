// The account last signed in on this TV, so the same account at a new address keeps
// everything (the Roku app's NoteLogin, LoginChange and PasswordStamp; docs/features.md
// §2.5). Providers move to new addresses now and then: the titles, their ids and the
// account stay the same, so nothing should be lost. Continue Watching syncs by a space
// made from the address, so after a move the next sync fetches the old address's space
// once and brings its list over (data/sync.ts).

import { sha256Hex } from "./sha256";
import { readJson, regDelete, regRead, regWrite, writeJson } from "./storage";
import { Creds, fieldStr, isObj, normalizeServer, syncSpaceText } from "./utils";

export interface LastLogin {
  server: string;
  username: string;
  pass: string; // passwordStamp's, not the password
}

// A short fingerprint of a password, to tell the same account from another without
// keeping the password itself after a sign-out.
export function passwordStamp(text: string): string {
  return text === "" ? "" : sha256Hex(text).slice(0, 16);
}

// This login's list on the sync service: 16 hex digits of SHA-256 of syncSpaceText.
export function spaceOf(creds: { server: string; username: string }): string {
  return sha256Hex(syncSpaceText(creds)).slice(0, 16);
}

// The same server (as normalizeServer writes it, ignoring case) and username.
export function sameLogin(a: { server: string; username: string } | null, b: { server: string; username: string } | null): boolean {
  if (!a || !b) return false;
  return normalizeServer(a.server).toLowerCase() === normalizeServer(b.server).toLowerCase() && a.username === b.username;
}

// How a login compares with the last one on this TV: "same" account at the same address;
// "moved", the same username and password at another address (the provider moved), so
// everything stays and Continue Watching follows; or "other".
export function loginChange(last: LastLogin, now: LastLogin): "same" | "moved" | "other" {
  if (last.username === "" || last.username !== now.username) return "other";
  if (sameLogin(last, now)) return "same";
  if (last.pass !== "" && last.pass === now.pass) return "moved";
  return "other";
}

export function lastLogin(): LastLogin | null {
  const raw = readJson("account", "last");
  if (!isObj(raw) || fieldStr(raw, "username") === "") return null;
  return { server: fieldStr(raw, "server"), username: fieldStr(raw, "username"), pass: fieldStr(raw, "pass") };
}

// The account moved from `server` to now's address: its old sync space is fetched once at
// the next sync and folded into the new one (sync "previous").
export function noteMovedFrom(server: string, now: { server: string; username: string }): void {
  if (server === "") return;
  const old = spaceOf({ server, username: now.username });
  if (old !== spaceOf(now)) regWrite("sync", "previous", old);
}

// The old address's space still to bring over, or "".
export function movedFromSpace(): string {
  return regRead("sync", "previous") || "";
}

export function forgetMovedFrom(): void {
  regDelete("sync", "previous");
}

// A sign-in (or a login a build carries): the same account at a new address keeps
// everything, Continue Watching following from the old address at the next sync; another
// account clears what this TV learnt about the last one (watch history, ratings, My List).
export function noteLogin(creds: Creds): void {
  const now: LastLogin = { server: normalizeServer(creds.server), username: creds.username, pass: passwordStamp(creds.password) };
  const last = lastLogin();
  if (last) {
    const change = loginChange(last, now);
    if (change === "moved") noteMovedFrom(last.server, now);
    else if (change === "other") {
      regDelete("taste", "history");
      regDelete("taste", "scores");
      regDelete("mylist", "items");
      regDelete("sync", "previous");
    }
  }
  writeJson("account", "last", now);
}
