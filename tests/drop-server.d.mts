export function startDroppingServer(size: number, byteAt: (i: number) => number): Promise<{ url: string; ranges: string[]; close(): void }>;
