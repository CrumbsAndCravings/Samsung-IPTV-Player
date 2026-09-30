// The screen stack: Login or Home at the bottom, then Details, then the player (as in
// the Roku app's MainScene). Only the top screen is shown and gets keys; dialogs sit
// over it and take the keys while open.

import { log } from "./core/log";
import { credsSecrets, setSecrets } from "./core/redact";
import { clearAccount, loadCreds, readOsFields } from "./core/storage";
import type { Creds } from "./core/utils";
import { XtreamApi } from "./data/api";
import { exitApp } from "./platform/tizen";
import { Dialog, DialogOptions } from "./ui/dialog";
import { KeyTarget, setKeyTarget } from "./ui/focus";

export interface Screen extends KeyTarget {
  readonly el: HTMLElement;
  // Called each time the screen comes back to the top (after Details closes, say).
  onShow?(): void;
  onHide?(): void;
  destroy?(): void;
}

export class App {
  private stack: Screen[] = [];
  api: XtreamApi | null = null;

  constructor(readonly root: HTMLElement) {}

  get top(): Screen | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  // Sets the login used by every screen, and what the logs must hide.
  useCreds(creds: Creds | null): void {
    this.api = creds ? new XtreamApi(creds) : null;
    const os = readOsFields();
    const secrets = creds ? credsSecrets(creds.server, creds.username, creds.password) : [];
    secrets.push({ value: os.apiKey, label: "<api key>" }, { value: os.username, label: "<os user>" }, { value: os.password, label: "<os password>" });
    setSecrets(secrets);
  }

  push(screen: Screen): void {
    const below = this.top;
    if (below) {
      if (below.onHide) below.onHide();
      below.el.style.display = "none";
    }
    this.stack.push(screen);
    this.root.appendChild(screen.el);
    setKeyTarget(screen);
    if (screen.onShow) screen.onShow();
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    const top = this.stack.pop() as Screen;
    if (top.onHide) top.onHide();
    if (top.destroy) top.destroy();
    if (top.el.parentNode) top.el.parentNode.removeChild(top.el);
    const below = this.top as Screen;
    below.el.style.display = "";
    // Replay the enter animation so returning feels like arriving.
    below.el.classList.remove("screen");
    void below.el.offsetWidth;
    below.el.classList.add("screen");
    setKeyTarget(below);
    if (below.onShow) below.onShow();
  }

  resetTo(screen: Screen): void {
    while (this.stack.length) {
      const s = this.stack.pop() as Screen;
      if (s.onHide) s.onHide();
      if (s.destroy) s.destroy();
      if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    }
    this.push(screen);
  }

  dialog(options: DialogOptions): void {
    new Dialog(this.root, options, this.top).open();
  }

  confirmExit(): void {
    this.dialog({ title: "Exit ARAN+?", buttons: [{ label: "Stay" }, { label: "Exit", action: exitApp }] });
  }

  signOut(): void {
    log("signing out");
    clearAccount();
    this.useCreds(null);
    this.onSignedOut();
  }

  // Set by main.ts: where to go after signing in or out.
  onSignedIn: (creds: Creds) => void = () => undefined;
  onSignedOut: () => void = () => undefined;

  hasCreds(): boolean {
    return loadCreds() !== null;
  }

}
