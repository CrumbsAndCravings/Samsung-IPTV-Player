// Types for tests that call the helper's plan directly.
export interface ProbeResult {
  duration: number;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; channels: number; language: string }[];
}
export interface HelperQuery {
  kind: "movie" | "series";
  id: string;
  ext: string;
  start: number;
  video: "copy" | "convert";
  height: number;
  audio: "aac" | "";
  track: number;
}
export const HLS_SEGMENT_SECS: number;
export const BROWSER_USER_AGENT: string;
export function parseProbe(text: string): ProbeResult;
export function videoPlan(codec: string): "copy" | "try" | "convert";
export function audioPlan(stream: { codec: string; channels: number }, audio?: "aac" | ""): "copy" | "ac3" | "aac";
export const ENCODERS: { [name: string]: string[] };
export function scaleFilter(height: number): string;
export function ffmpegArgs(options: {
  url: string;
  start: number;
  video: "copy" | "convert";
  encoder: string;
  probe: ProbeResult | null;
  height?: number;
  audio?: "aac" | "";
  track?: number;
  hwaccel?: boolean;
  userAgent?: string;
  hls?: { dir: string } | null;
}): string[];
export function providerUrl(login: { server: string; username: string; password: string }, kind: string, id: string, ext: string): string;
export function readQuery(params: URLSearchParams): HelperQuery | null;
export function masterPlaylist(session: string, size: { width: number; height: number } | null): string;
export function rewritePlaylist(text: string, prefix: string): string;
export function playlistState(text: string): { segments: number; ended: boolean };
export function sessionFile(session: string, file: string): boolean;
export function outputSize(source: { width: number; height: number } | null, video: string, height: number): { width: number; height: number };
export function redactor(login: { server: string; username: string; password: string }, key: string): (text: string) => string;
