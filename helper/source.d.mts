// Types for tests that use the helper's source reader directly.
export const HEAD_BYTES: number;
export const TAIL_BYTES: number;
export function totalFromContentRange(header: string | null): number;
export function parseRange(header: string | undefined): { start: number; end: number } | { suffix: number } | null;
export interface SourceFile {
  key: string;
  url: string;
  size: number;
  headLength: number;
}
// helper/http-get.mjs's httpGet, or a stand-in with answers shaped like fetch's.
export type SourceFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: string },
) => Promise<{
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: (AsyncIterable<Uint8Array> & { cancel(): Promise<void> }) | null;
  text(): Promise<string>;
}>;
export class SourceFiles {
  constructor(options: {
    fetch: SourceFetch;
    userAgent?: string;
    onRequest?: (info: { key: string; start: number; ms: number; status: number }) => void;
    ahead?: number;
    onAhead?: (info: { key: string; held: number; received: number; ms: number; waited: number }) => void;
    letGoMs?: number;
  });
  reading: { file: SourceFile; end: number; reader: number; held: number } | null;
  stopReadAhead(keep?: string): void;
  file(key: string, url: string): SourceFile;
  size(file: SourceFile, signal?: AbortSignal): Promise<number>;
  bytes(file: SourceFile, start: number, end: number, signal?: AbortSignal, options?: { exclusive?: boolean }): AsyncGenerator<Uint8Array, void, unknown>;
}
