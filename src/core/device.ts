// Reading the TV's engine and model year from strings. Pure, so it is unit tested;
// platform/tizen.ts gathers the raw values.

// "... Chrome/63.0.3239.84 TV Safari/537.36" -> "63.0.3239.84". Tizen 5.5 leaves out
// the "Chrome/" name: "(KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36".
export function chromiumVersion(userAgent: string): string {
  const named = /Chrome\/(\d+(?:\.\d+)+)/.exec(userAgent);
  if (named) return named[1];
  const bare = /\)\s+(\d+\.\d+\.\d+\.\d+)\/\d+(?:\.\d+)?\s+TV\b/.exec(userAgent);
  return bare ? bare[1] : "";
}

export function chromiumMajor(userAgent: string): number {
  const version = chromiumVersion(userAgent);
  return version === "" ? 0 : parseInt(version, 10);
}

// "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) ..." -> "5.0"
export function tizenFromUserAgent(userAgent: string): string {
  const match = /Tizen (\d+(?:\.\d+)?)/.exec(userAgent);
  return match ? match[1] : "";
}

export interface ModelYear {
  letter: string;
  year: number;
  tizen: string;
  chromium: number;
}

// Samsung's year letter, with the Tizen version and web engine that year shipped with
// (from docs/samsung-plan.md in the Roku repo; the TV's own user agent is the truth).
const YEARS: { [letter: string]: ModelYear } = {
  R: { letter: "R", year: 2019, tizen: "5.0", chromium: 63 },
  T: { letter: "T", year: 2020, tizen: "5.5", chromium: 69 },
  A: { letter: "A", year: 2021, tizen: "6.0", chromium: 76 },
  B: { letter: "B", year: 2022, tizen: "6.5", chromium: 85 },
  C: { letter: "C", year: 2023, tizen: "7.0", chromium: 94 },
  D: { letter: "D", year: 2024, tizen: "8.0", chromium: 108 },
};

// "QN65Q60RAFXZC" -> R (2019). QLED codes put the letter after the series ("Q60");
// others put it straight after the size ("UN65TU8000" -> T).
export function modelYear(model: string): ModelYear | null {
  const code = model.trim().toUpperCase();
  const qled = /^[A-Z]{2}\d{2,3}Q\d{2,3}([A-Z])/.exec(code);
  const plain = /^[A-Z]{2}\d{2,3}([A-Z])/.exec(code);
  const letter = qled ? qled[1] : plain ? plain[1] : "";
  return Object.prototype.hasOwnProperty.call(YEARS, letter) ? YEARS[letter] : null;
}

export function describeModelYear(model: string): string {
  const info = modelYear(model);
  if (!info) return "";
  return info.year + " model: shipped with Tizen " + info.tizen + " (Chromium " + info.chromium + ")";
}
