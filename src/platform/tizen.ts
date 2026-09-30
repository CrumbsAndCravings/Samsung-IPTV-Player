// Everything the app reads from Tizen and Samsung's APIs about the TV itself. Each
// value is read on its own, so one failing call (or running on a desktop) only blanks
// that value.

import { chromiumVersion, tizenFromUserAgent } from "../core/device";
import { log } from "../core/log";

export function isTv(): boolean {
  return typeof window.tizen !== "undefined";
}

function read(label: string, get: () => unknown): string {
  try {
    const value = get();
    return value === undefined || value === null ? "" : String(value);
  } catch (err) {
    log(label + " failed:", err);
    return "";
  }
}

export interface DeviceInfo {
  userAgent: string;
  chromium: string;
  tizenFromUa: string;
  platformVersion: string;
  realModel: string;
  model: string;
  modelCode: string;
  firmware: string;
  webapisVersion: string;
  avplayVersion: string;
  uhdPanel: string;
  window: string;
  display: string;
}

export function readDevice(): Promise<DeviceInfo> {
  const ua = navigator.userAgent;
  const product = window.webapis ? window.webapis.productinfo : undefined;
  const avplay = window.webapis ? window.webapis.avplay : undefined;
  const tizen = window.tizen;
  const info: DeviceInfo = {
    userAgent: ua,
    chromium: chromiumVersion(ua),
    tizenFromUa: tizenFromUserAgent(ua),
    platformVersion: tizen ? read("platform.version", () => tizen.systeminfo.getCapability("http://tizen.org/feature/platform.version")) : "",
    realModel: product && product.getRealModel ? read("getRealModel", () => product.getRealModel && product.getRealModel()) : "",
    model: product ? read("getModel", () => product.getModel()) : "",
    modelCode: product ? read("getModelCode", () => product.getModelCode()) : "",
    firmware: product ? read("getFirmware", () => product.getFirmware()) : "",
    webapisVersion: product ? read("productinfo.getVersion", () => product.getVersion()) : "",
    avplayVersion: avplay ? read("avplay.getVersion", () => avplay.getVersion()) : "",
    uhdPanel: product ? read("isUdPanelSupported", () => (product.isUdPanelSupported() ? "yes" : "no")) : "",
    window: window.innerWidth + "x" + window.innerHeight + " at " + (window.devicePixelRatio || 1) + "x",
    display: "",
  };
  if (!tizen) return Promise.resolve(info);
  return new Promise((resolve) => {
    const done = () => resolve(info);
    try {
      tizen.systeminfo.getPropertyValue(
        "DISPLAY",
        (value) => {
          info.display = value.resolutionWidth + "x" + value.resolutionHeight;
          done();
        },
        done,
      );
    } catch {
      done();
    }
    setTimeout(done, 2000);
  });
}

// The best single name for this TV's model.
export function modelName(info: DeviceInfo): string {
  return info.realModel || info.model || info.modelCode;
}

export function exitApp(): void {
  try {
    if (window.tizen) {
      window.tizen.application.getCurrentApplication().exit();
      return;
    }
  } catch (err) {
    log("exit failed:", err);
  }
  window.close();
}
