// Types for tests that use the helper's requests to the provider directly.
export interface HttpAnswer {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> & { cancel(): Promise<void> };
  text(): Promise<string>;
}
export function httpGet(url: string, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<HttpAnswer>;
