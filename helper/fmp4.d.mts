// Types for tests that read fragmented MP4 with the helper's reader directly.
export interface TopBox {
  type: string;
  bytes: Uint8Array;
  last?: boolean;
}
export class TopBoxes {
  push(chunk: Uint8Array): TopBox[];
}
export function moovTracks(moov: Uint8Array): { id: number; timescale: number; video: boolean }[];
export function fragmentStart(moof: Uint8Array, tracks: { id: number; timescale: number; video: boolean }[]): number | null;
export function numberFragment(moof: Uint8Array, n: number): void;
