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
export class SourceFiles {
  constructor(options: { fetch: typeof fetch; userAgent?: string; onRequest?: (info: { key: string; start: number; ms: number; status: number }) => void });
  file(key: string, url: string): SourceFile;
  size(file: SourceFile, signal?: AbortSignal): Promise<number>;
  bytes(file: SourceFile, start: number, end: number, signal?: AbortSignal, options?: { exclusive?: boolean }): AsyncGenerator<Uint8Array, void, unknown>;
}
