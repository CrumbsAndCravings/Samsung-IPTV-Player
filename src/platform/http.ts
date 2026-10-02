// All network access goes through XHR: timeouts, abort(), progress events and
// response headers all work the same on every Tizen engine.

import { Headers, isCloudflareBlock, refusalText } from "../core/refusals";
import { Json } from "../core/utils";

export interface HttpRequest {
  method?: "GET" | "POST";
  url: string;
  headers?: { [name: string]: string };
  body?: string;
  timeoutMs?: number;
  responseType?: "text" | "arraybuffer";
  // Abort once more than this many bytes arrive (a server that ignores Range would
  // otherwise send the whole movie).
  maxBytes?: number;
}

export interface HttpResponse {
  code: number; // 0 when the request never got an answer
  ok: boolean; // 2xx
  text: string;
  buffer: ArrayBuffer | null;
  ms: number;
  timedOut: boolean;
  overflowed: boolean; // aborted by maxBytes
  headerErrors: string[]; // headers the engine refused to set (by throwing)
  header(name: string): string | null;
  headers(): Headers; // every header, with lower-case names
}

function parseHeaders(raw: string): Headers {
  const out: Headers = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
}

export interface Pending {
  promise: Promise<HttpResponse>;
  abort(): void;
}

export function send(req: HttpRequest): Pending {
  const xhr = new XMLHttpRequest();
  const started = Date.now();
  const headerErrors: string[] = [];
  let timedOut = false;
  let overflowed = false;
  let lastStatus = 0;
  const promise = new Promise<HttpResponse>((resolve) => {
    const finish = () => {
      const code = xhr.status || lastStatus;
      resolve({
        code,
        ok: code >= 200 && code < 300,
        text: req.responseType === "arraybuffer" ? "" : xhr.responseText || "",
        buffer: req.responseType === "arraybuffer" && xhr.response instanceof ArrayBuffer ? xhr.response : null,
        ms: Date.now() - started,
        timedOut,
        overflowed,
        headerErrors,
        header: (name: string) => {
          try {
            return xhr.getResponseHeader(name);
          } catch {
            return null;
          }
        },
        headers: () => {
          try {
            return parseHeaders(xhr.getAllResponseHeaders() || "");
          } catch {
            return {};
          }
        },
      });
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2 && xhr.status) lastStatus = xhr.status;
    };
    if (req.maxBytes) {
      const limit = req.maxBytes;
      xhr.onprogress = (event) => {
        if (event.loaded > limit) {
          overflowed = true;
          xhr.abort();
        }
      };
    }
    xhr.onload = finish;
    xhr.onerror = finish;
    xhr.onabort = finish;
    xhr.ontimeout = () => {
      timedOut = true;
      finish();
    };
    try {
      xhr.open(req.method || "GET", req.url, true);
      xhr.timeout = req.timeoutMs || 20000;
      if (req.responseType === "arraybuffer") xhr.responseType = "arraybuffer";
      const headers = req.headers || {};
      for (const name of Object.keys(headers)) {
        try {
          xhr.setRequestHeader(name, headers[name]);
        } catch {
          headerErrors.push(name);
        }
      }
      xhr.send(req.body === undefined ? null : req.body);
    } catch {
      finish();
    }
  });
  return { promise, abort: () => xhr.abort() };
}

export interface JsonResult {
  ok: boolean;
  code: number;
  data: Json;
  error: string;
  ms: number;
  bytes: number;
  cfBlock: boolean; // Cloudflare itself turned the request away
}

// JSON GET with the Roku app's error wording (tasks/Http.brs): a refusal says who
// answered and what they said.
export function getJson(url: string, timeoutMs = 20000): Promise<JsonResult> {
  return send({ url, timeoutMs }).promise.then((res) => {
    const base = { code: res.code, ms: res.ms, bytes: res.text.length, data: undefined as Json, cfBlock: false };
    if (res.timedOut) return { ...base, ok: false, error: "The server took too long to answer." };
    if (res.code === 0) return { ...base, ok: false, error: "Couldn't reach the server (no answer, or the request was blocked)." };
    if (res.code !== 200) {
      const headers = res.headers();
      return { ...base, ok: false, cfBlock: isCloudflareBlock(headers, res.text), error: refusalText(res.code, headers, res.text) };
    }
    try {
      return { ...base, ok: true, data: JSON.parse(res.text) as Json, error: "" };
    } catch {
      return { ...base, ok: false, error: "The server's answer wasn't readable. Check the server address." };
    }
  });
}

// Runs `worker` over `items` with at most `limit` in flight, in order of start.
export function eachLimited<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>, stop?: () => boolean): Promise<void> {
  let next = 0;
  const lane = (): Promise<void> => {
    if (next >= items.length || (stop && stop())) return Promise.resolve();
    const index = next++;
    return worker(items[index], index).then(lane, lane);
  };
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane());
  return Promise.all(lanes).then(() => undefined);
}
