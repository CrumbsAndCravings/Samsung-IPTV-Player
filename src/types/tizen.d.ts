// Just the parts of Tizen's and Samsung's web APIs that ARAN+ uses. Both globals exist
// only inside the packaged app on a TV, so every use goes through platform/.

interface TizenKey {
  name: string;
  code: number;
}

interface TizenApi {
  tvinputdevice: {
    registerKey(name: string): void;
    unregisterKey(name: string): void;
    getKey(name: string): TizenKey | null;
    getSupportedKeys(): TizenKey[];
  };
  application: {
    getCurrentApplication(): { exit(): void; hide(): void; appInfo: { id: string; version: string } };
  };
  systeminfo: {
    getCapability(key: string): unknown;
    getPropertyValue(property: string, ok: (value: { [key: string]: unknown }) => void, fail?: (err: Error) => void): void;
  };
}

interface AVPlayError {
  name: string;
  message: string;
}

interface AVPlayTrackInfo {
  index: number;
  type: string; // "VIDEO" | "AUDIO" | "TEXT"
  extra_info: string; // JSON text
}

interface AVPlayListener {
  onbufferingstart?(): void;
  onbufferingprogress?(percent: number): void;
  onbufferingcomplete?(): void;
  oncurrentplaytime?(ms: number): void;
  onstreamcompleted?(): void;
  onevent?(eventType: string, eventData: string): void;
  onerror?(eventType: string): void;
  onsubtitlechange?(duration: number, text: string, type: unknown, attributes: unknown): void;
  ondrmevent?(drmEvent: unknown, drmData: unknown): void;
}

interface AVPlay {
  open(url: string): void;
  close(): void;
  prepareAsync(ok: () => void, fail: (err: AVPlayError) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(ms: number, ok?: () => void, fail?: (err: AVPlayError) => void): void;
  getCurrentTime(): number;
  getDuration(): number;
  getState(): string; // NONE, IDLE, READY, PLAYING, PAUSED
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(method: string): void;
  setListener(listener: AVPlayListener): void;
  setStreamingProperty(name: string, value: string): void;
  setBufferingParam?(option: string, unit: string, amount: number): void;
  getTotalTrackInfo(): AVPlayTrackInfo[];
  getCurrentStreamInfo(): AVPlayTrackInfo[];
  setSelectTrack(type: string, index: number): void;
  setSilentSubtitle(silent: boolean): void;
  suspend(): void;
  restore(url?: string, resumeMs?: number, prepare?: boolean): void;
  getVersion(): string;
}

interface ProductInfo {
  getFirmware(): string;
  getModel(): string;
  getModelCode(): string;
  getRealModel?(): string;
  getVersion(): string;
  isUdPanelSupported(): boolean;
}

interface WebApis {
  avplay: AVPlay;
  productinfo: ProductInfo;
}

interface Window {
  tizen?: TizenApi;
  webapis?: WebApis;
}
