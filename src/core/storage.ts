// Persistent key/value storage, ported from the Roku app's Registry.brs. localStorage
// survives app restarts on the TV and has no 16 KB limit like the Roku registry.
// Keys look like "aranplus:<section>:<key>", mirroring Roku's registry sections.

import { Creds, fieldStr, isObj, Json } from "./utils";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// A stand-in when localStorage is unavailable (and for tests).
export class MemoryStore implements KeyValueStore {
  private data: { [key: string]: string } = {};
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
  }
  setItem(key: string, value: string): void {
    this.data[key] = value;
  }
  removeItem(key: string): void {
    delete this.data[key];
  }
}

let backing: KeyValueStore | null = null;

export function useStore(store: KeyValueStore): void {
  backing = store;
}

function store(): KeyValueStore {
  if (!backing) {
    try {
      backing = window.localStorage;
    } catch {
      backing = new MemoryStore();
    }
  }
  return backing;
}

function storageKey(section: string, key: string): string {
  return "aranplus:" + section + ":" + key;
}

export function regRead(section: string, key: string): string | null {
  return store().getItem(storageKey(section, key));
}

export function regWrite(section: string, key: string, value: string): void {
  store().setItem(storageKey(section, key), value);
}

export function regDelete(section: string, key: string): void {
  store().removeItem(storageKey(section, key));
}

export function readJson(section: string, key: string): Json {
  const raw = regRead(section, key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeJson(section: string, key: string, value: Json): void {
  regWrite(section, key, JSON.stringify(value));
}

export function loadCreds(): Creds | null {
  const creds = readJson("account", "creds");
  if (!isObj(creds) || fieldStr(creds, "server") === "" || fieldStr(creds, "username") === "") return null;
  return { server: fieldStr(creds, "server"), username: fieldStr(creds, "username"), password: fieldStr(creds, "password") };
}

export function saveCreds(creds: Creds): void {
  writeJson("account", "creds", { server: creds.server, username: creds.username, password: creds.password });
}

export function clearAccount(): void {
  regDelete("account", "creds");
  regDelete("progress", "items");
  regDelete("opensubtitles", "account");
}

// OpenSubtitles account. Stays on the TV.
export interface OsAccount {
  apiKey: string;
  username: string;
  password: string;
  token: string;
  baseUrl: string;
}

// Whatever was typed, even when incomplete: forms save before they check.
export function readOsFields(): OsAccount {
  const raw = readJson("opensubtitles", "account");
  return {
    apiKey: fieldStr(raw, "apiKey"),
    username: fieldStr(raw, "username"),
    password: fieldStr(raw, "password"),
    token: fieldStr(raw, "token"),
    baseUrl: fieldStr(raw, "baseUrl"),
  };
}

// A usable account needs at least the API key.
export function loadOsAccount(): OsAccount | null {
  const account = readOsFields();
  return account.apiKey === "" ? null : account;
}

export function saveOsAccount(account: OsAccount): void {
  writeJson("opensubtitles", "account", {
    apiKey: account.apiKey,
    username: account.username,
    password: account.password,
    token: account.token,
    baseUrl: account.baseUrl,
  });
}
