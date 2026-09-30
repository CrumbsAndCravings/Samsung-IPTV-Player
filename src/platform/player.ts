// What screens need from a video player. On the TV this is AVPlay (MKV, AVI, HEVC,
// AC3/EAC3, embedded subtitle tracks); on a desktop it is <video> (MP4 only).

export interface PlayerEvents {
  onTime?(ms: number): void;
  onBuffering?(phase: "start" | "progress" | "end", percent: number): void;
  onEnded?(): void;
  onError?(name: string): void;
  // Text of an embedded subtitle cue. AVPlay never draws subtitles itself.
  onSubtitle?(text: string, durationMs: number): void;
  onEvent?(type: string, data: string): void;
}

export interface Track {
  index: number;
  kind: "VIDEO" | "AUDIO" | "TEXT";
  language: string;
  codec: string;
  detail: { [key: string]: string };
}

export interface OpenOptions {
  uhd?: boolean; // the file is wider than 1920 px (AVPlay needs 4K mode set up front)
}

export class PlayerError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export interface Player {
  readonly kind: "avplay" | "html5";
  // Resolves once the stream is ready to play; rejects with a PlayerError.
  open(url: string, events: PlayerEvents, options?: OpenOptions): Promise<void>;
  play(): void;
  pause(): void;
  seek(ms: number): Promise<void>;
  // Stops and releases the stream. Safe to call at any time.
  close(): void;
  state(): string;
  currentMs(): number;
  durationMs(): number;
  tracks(): Track[];
  selectTrack(kind: "AUDIO" | "TEXT", index: number): void;
  setSubtitlesHidden(hidden: boolean): void;
  suspend(): void;
  restore(): void;
}
