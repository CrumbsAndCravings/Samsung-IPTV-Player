// Subtitle files (SRT and WebVTT) for online subtitles. New for Samsung: AVPlay never
// draws subtitles, so ARAN+ parses the file once and draws each cue itself, timed
// against the player's position. Timing (Subtitle settings, 0.1 s a step) is just a
// delay applied at lookup, so it costs no new download (on Roku each nudge did).

export interface Cue {
  start: number; // ms
  end: number; // ms
  text: string; // lines joined by "\n", tags removed
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

// "01:02:03,450" or "02:03.45" (WebVTT may drop the hours) -> ms
export function parseTimestamp(text: string): number {
  const m = TIME.exec(text);
  if (!m) return -1;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const fraction = parseInt((m[4] + "00").slice(0, 3), 10);
  return ((hours * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + fraction;
}

const ENTITIES: { [name: string]: string } = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, "") // <i>, <b>, <font color=...>, WebVTT <c.x> and <v Name>
    .replace(/\{\\[^}]*\}/g, "") // ASS overrides such as {\an8}
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_all: string, name: string) => ENTITIES[name])
    .trim();
}

// Text from AVPlay's embedded tracks can carry the same tags as a file.
export function cleanCueText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanLine)
    .filter((line) => line !== "")
    .join("\n");
}

export function parseSubtitles(raw: string): Cue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: { cue: Cue; i: number }[] = [];
  const blocks = text.split(/\n[ \t]*\n/);
  blocks.forEach((block, i) => {
    const lines = block.split("\n");
    const timeLine = lines.findIndex((line) => line.indexOf("-->") >= 0);
    if (timeLine < 0) return; // WEBVTT header, NOTE, STYLE, stray numbers
    const [from, to] = lines[timeLine].split("-->");
    const start = parseTimestamp(from);
    const end = parseTimestamp(to || "");
    if (start < 0 || end <= start) return;
    const body = lines
      .slice(timeLine + 1)
      .map(cleanLine)
      .filter((line) => line !== "")
      .join("\n");
    if (body !== "") cues.push({ cue: { start, end, text: body }, i });
  });
  cues.sort((a, b) => a.cue.start - b.cue.start || a.i - b.i);
  return cues.map((c) => c.cue);
}

// Finds the cues showing at a moment, quickly, even for a film's worth of cues.
export class CueTrack {
  private maxDuration = 0;

  constructor(readonly cues: Cue[]) {
    for (const cue of cues) this.maxDuration = Math.max(this.maxDuration, cue.end - cue.start);
  }

  // Text showing at `videoMs`, with the subtitles shifted by `delayMs` (positive shows
  // them later, negative earlier). Overlapping cues are stacked in start order.
  textAt(videoMs: number, delayMs = 0): string {
    const t = videoMs - delayMs;
    let lo = 0;
    let hi = this.cues.length - 1;
    let last = -1; // the last cue starting at or before t
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start <= t) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const showing: string[] = [];
    for (let i = last; i >= 0 && this.cues[i].start > t - this.maxDuration - 1; i--) {
      if (this.cues[i].end > t) showing.unshift(this.cues[i].text);
    }
    return showing.join("\n");
  }
}
