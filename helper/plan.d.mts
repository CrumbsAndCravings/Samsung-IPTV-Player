// Types for tests that call the helper's plan directly.
export interface ProbeResult {
  duration: number;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; channels: number; language: string; title?: string }[];
  subtitles: { codec: string; language: string; text: boolean; forced: boolean; title?: string }[];
}
export function parseProbe(text: string): ProbeResult;
export function videoPlan(codec: string): "copy" | "try" | "convert";
export function hlsVideoPlan(codec: string): "copy" | "convert";
export function audioPlan(stream: { codec: string; channels: number }): "copy" | "ac3" | "aac";
export const ENCODERS: { [name: string]: string[] };
export const MAX_SUBTITLES: number;
export const HLS_SECONDS: number;
export function ffmpegArgs(options: { url: string; start: number; video: "copy" | "convert"; encoder: string; probe: ProbeResult | null }): string[];
export function hlsArgs(options: {
  url: string;
  start: number;
  video: "copy" | "convert";
  encoder: string;
  probe: ProbeResult | null;
  dir: string;
  audioTrack?: number;
  audio?: "aac" | "keep";
  height?: number;
  format?: "fmp4" | "ts";
  subtitles?: boolean;
  userAgent?: string;
}): string[];
export function playlistForPlayer(text: string): string;
export function playlistState(text: string): { segments: number; ended: boolean };
export function sessionFile(name: string): boolean;
export function sessionFileType(name: string): string;
export function movieHash(head: Uint8Array, tail: Uint8Array, size: number): string;
export function xtreamQuery(login: { server: string; username: string; password: string }, params: URLSearchParams): string | null;
export function fetchAllowed(url: string): boolean;
export function providerUrl(login: { server: string; username: string; password: string }, kind: string, id: string, ext: string): string;
export function redactor(login: { server: string; username: string; password: string }, key: string): (text: string) => string;
