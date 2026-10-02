// Large text kept on the TV between launches, like the stored search library (several
// megabytes for a big catalog). IndexedDB holds it; localStorage, whose quota is a few
// megabytes, is the fallback when IndexedDB can't open. Nothing here ever throws: a
// failed load reads as "nothing saved" and a failed save as false.

import { log } from "../core/log";
import { regDelete, regRead, regWrite } from "../core/storage";

export interface TextStore {
  load(name: string): Promise<string | null>;
  save(name: string, text: string): Promise<boolean>;
  remove(name: string): Promise<void>;
}

// For tests.
export class MemoryTextStore implements TextStore {
  data: { [name: string]: string } = {};
  load(name: string): Promise<string | null> {
    return Promise.resolve(Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : null);
  }
  save(name: string, text: string): Promise<boolean> {
    this.data[name] = text;
    return Promise.resolve(true);
  }
  remove(name: string): Promise<void> {
    delete this.data[name];
    return Promise.resolve();
  }
}

const DB_NAME = "aranplus";
const STORE = "files";

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const request = window.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          log("files: IndexedDB didn't open:", request.error ? request.error.message : "unknown error");
          resolve(null);
        };
        request.onblocked = () => resolve(null);
      } catch (err) {
        log("files: no IndexedDB:", (err as Error).message);
        resolve(null);
      }
    });
  }
  return opening;
}

function inDb<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest, fallback: T, pick: (result: unknown) => T): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const request = work(tx.objectStore(STORE));
          let value: T = fallback;
          request.onsuccess = () => {
            value = pick(request.result);
          };
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => {
            log("files:", tx.error ? tx.error.message : "IndexedDB failed");
            resolve(fallback);
          };
          tx.onabort = tx.onerror;
        } catch (err) {
          log("files:", (err as Error).message);
          resolve(fallback);
        }
      }),
  );
}

export const files: TextStore = {
  load(name) {
    return inDb<string | null>("readonly", (store) => store.get(name), null, (result) => (typeof result === "string" ? result : null)).then((text) => {
      if (text !== null) return text;
      try {
        return regRead("files", name);
      } catch {
        return null;
      }
    });
  },
  save(name, text) {
    return inDb<boolean>("readwrite", (store) => store.put(text, name), false, () => true).then((saved) => {
      try {
        // A fallback copy from an earlier save would only take up space now.
        if (saved) regDelete("files", name);
        else regWrite("files", name, text);
        return true;
      } catch (err) {
        log("files: couldn't save", name + ":", (err as Error).message);
        return false;
      }
    });
  },
  remove(name) {
    return inDb<boolean>("readwrite", (store) => store.delete(name), false, () => true).then(() => {
      try {
        regDelete("files", name);
      } catch {
        // nothing to delete
      }
    });
  },
};
