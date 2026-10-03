// GET requests to the provider for the files FFmpeg and Safari read (helper/source.mjs),
// with Node's own http and https, following redirects. Answers look like fetch's
// (status, url, headers.get, body, text), which source.mjs and its tests expect.
//
// Not fetch itself: Node's fetch (undici) crashes the whole helper when the provider
// closes a connection while the helper is holding back (FFmpeg busy converting, so not
// reading): "AssertionError: assert(!this.paused)". Node's http just ends the response.

import http from "node:http";
import https from "node:https";

const MAX_REDIRECTS = 5;

export function httpGet(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (err) {
        reject(err);
        return;
      }
      const client = parsed.protocol === "https:" ? https : http;
      const request = client.get(parsed, { headers, signal }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          redirects++;
          res.resume();
          go(new URL(res.headers.location, parsed).href);
          return;
        }
        resolve(answerOf(res, target));
      });
      request.on("error", reject);
    };
    go(url);
  });
}

function answerOf(res, url) {
  // A readable stream, so `for await` reads it; cancel() as on fetch's bodies.
  res.cancel = () => {
    res.destroy();
    return Promise.resolve();
  };
  // A provider that drops the connection mid-file ends the stream early rather than
  // throwing; the reader asks again from where it got to.
  res.on("error", () => undefined);
  return {
    status: res.statusCode || 0,
    url,
    headers: {
      get(name) {
        const value = res.headers[name.toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? value.join(", ") : String(value);
      },
    },
    body: res,
    async text() {
      let out = "";
      for await (const chunk of res) {
        out += chunk;
        if (out.length > 65536) break;
      }
      return out;
    },
  };
}
