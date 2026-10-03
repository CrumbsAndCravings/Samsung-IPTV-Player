// Types for tests that call the helper's plan directly.
export interface ProbeResult {
  duration: number;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; channels: number; language: string }[];
}
export function parseProbe(text: string): ProbeResult;
export function videoPlan(codec: string): "copy" | "try" | "convert";
export function audioPlan(stream: { codec: string; channels: number }): "copy" | "ac3" | "aac";
export const ENCODERS: { [name: string]: string[] };
export function ffmpegArgs(options: { url: string; start: number; video: "copy" | "convert"; encoder: string; probe: ProbeResult | null }): string[];
export function providerUrl(login: { server: string; username: string; password: string }, kind: string, id: string, ext: string): string;
export function redactor(login: { server: string; username: string; password: string }, key: string): (text: string) => string;
