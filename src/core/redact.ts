// Keeps the IPTV login and OpenSubtitles details off the screen in logs, errors and
// reports, so a photo of the TV (or the report QR code) never carries them.

import { normalizeServer } from "./utils";

export interface Secret {
  value: string;
  label: string;
}

let secrets: Secret[] = [];

export function setSecrets(list: Secret[]): void {
  // Longest first, so a server URL is replaced before the host inside it.
  secrets = list.filter((s) => s.value.trim().length >= 3).sort((a, b) => b.value.length - a.value.length);
}

// Secrets for an Xtream login: the full server, its host, username and password.
export function credsSecrets(server: string, username: string, password: string): Secret[] {
  const list: Secret[] = [];
  const normalized = normalizeServer(server);
  if (normalized !== "") {
    list.push({ value: normalized, label: "<server>" });
    const host = normalized.replace(/^https?:\/\//i, "").replace(/:\d+$/, "");
    list.push({ value: host, label: "<server>" });
  }
  list.push({ value: username, label: "<user>" });
  list.push({ value: password, label: "<password>" });
  return list;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, list: Secret[] = secrets): string {
  let out = text;
  for (const secret of list) {
    const forms = [secret.value, encodeURIComponent(secret.value)];
    for (const form of forms) {
      if (form.length < 3) continue;
      out = out.replace(new RegExp(escapeRegExp(form), "gi"), secret.label);
    }
  }
  return out;
}
