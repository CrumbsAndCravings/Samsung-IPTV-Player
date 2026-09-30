// A small in-memory log: the last 50 lines, shown on screen for diagnosing from a photo
// of the TV. Lines are redacted when displayed (core/redact.ts).

export interface LogLine {
  at: number;
  text: string;
  level: "info" | "error";
}

const MAX_LINES = 50;
const lines: LogLine[] = [];
const listeners: (() => void)[] = [];

function add(level: LogLine["level"], parts: unknown[]): void {
  const text = parts
    .map((part) => (part instanceof Error ? part.name + ": " + part.message : typeof part === "string" ? part : safeJson(part)))
    .join(" ");
  lines.push({ at: Date.now(), text, level });
  if (lines.length > MAX_LINES) lines.shift();
  if (level === "error") console.error("[ARAN+]", text);
  else console.log("[ARAN+]", text);
  for (const listener of listeners) listener();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(...parts: unknown[]): void {
  add("info", parts);
}

export function logError(...parts: unknown[]): void {
  add("error", parts);
}

export function logLines(): LogLine[] {
  return lines.slice();
}

export function onLog(listener: () => void): void {
  listeners.push(listener);
}
