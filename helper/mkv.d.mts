// Types for tests that read MKV indexes with the helper's reader directly.
export const CUES: number;
export function element(bytes: Uint8Array, pos: number): { id: number; start: number; end: number } | null;
export function mkvStart(head: Uint8Array): { segment: number; scale: number; video: number; cues: number; seekHeads: number[] } | null;
export function mkvSeekHeadCues(bytes: Uint8Array, segment: number): number;
export function mkvCuesLength(bytes: Uint8Array): number;
export function mkvCueTimes(bytes: Uint8Array, video: number, scale: number): number[] | null;
