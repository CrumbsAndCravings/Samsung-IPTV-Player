// The screen stack: Login or Home at the bottom, then Details, then the player (as in
// the Roku app's MainScene). Only the top screen is shown and gets keys; dialogs sit
// over it and take the keys while open.

import { log } from "./core/log";
import { syncConfig, transcoderConfig } from "./core/personal";
import { credsSecrets, setSecrets } from "./core/redact";
import { clearAccount, loadCreds, readOsFields } from "./core/storage";
import type { Creds } from "./core/utils";
import { XtreamApi } from "./data/api";
import { deleteStoredLibrary, SearchLibrary } from "./data/library";
import { ProgressSync } from "./data/sync";
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

const MOVE_IN_MS = 400; // the longest screen arrival (Details, 380 ms)
const MOVE_OUT_MS = 260; // a screen leaving or sinking back (240 ms)

export class App {
  private stack: Screen[] = [];
  private moving = new Map<HTMLElement, { name: string; timer: number }>();
  api: XtreamApi | null = null;
  // The whole library for this login: searched, browsed by category and counted. It
  // starts on the first search, category page or Categories tab.
  library: SearchLibrary | null = null;
  // Continue Watching between devices, for a personal build with a sync service.
  sync: ProgressSync | null = null;

  constructor(readonly root: HTMLElement) {}

  get top(): Screen | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  // Sets the login used by every screen, and what the logs must hide.
  useCreds(creds: Creds | null): void {
    if (this.library) this.library.stop();
    if (this.sync) this.sync.stop();
    this.api = creds ? new XtreamApi(creds) : null;
    this.library = this.api ? new SearchLibrary(this.api) : null;
    this.sync = ProgressSync.forCreds(creds);
    if (this.sync) this.sync.now(); // at launch and sign-in
    this.refreshSecrets();
  }

  // What logs and on-screen reports must hide; call again after the OpenSubtitles
  // details change.
  refreshSecrets(): void {
    const creds = this.api ? this.api.creds : null;
    const os = readOsFields();
    const secrets = creds ? credsSecrets(creds.server, creds.username, creds.password) : [];
    secrets.push({ value: os.apiKey, label: "<api key>" }, { value: os.username, label: "<os user>" }, { value: os.password, label: "<os password>" });
    const sync = syncConfig();
    if (sync) secrets.push({ value: sync.key, label: "<sync key>" });
    const helper = transcoderConfig();
    if (helper) secrets.push({ value: helper.key, label: "<helper key>" });
    setSecrets(secrets);
  }

  // Screens move (motion.css): the new one slides in while the one underneath sinks back
  // and is then hidden; leaving, the top one goes back the way it came and the one
  // underneath comes up again. Keys belong to the new top screen at once.
  push(screen: Screen): void {
    const below = this.top;
    if (below) {
      if (below.onHide) below.onHide();
      this.animate(below.el, "is-sinking", MOVE_OUT_MS, () => {
        if (this.top !== below) below.el.style.display = "none";
      });
    }
    this.stack.push(screen);
    this.root.appendChild(screen.el);
    this.animate(screen.el, "is-entering", MOVE_IN_MS);
    setKeyTarget(screen);
    if (screen.onShow) screen.onShow();
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    const top = this.stack.pop() as Screen;
    if (top.onHide) top.onHide();
    if (top.destroy) top.destroy();
    this.animate(top.el, "is-leaving", MOVE_OUT_MS, () => {
      if (top.el.parentNode) top.el.parentNode.removeChild(top.el);
    });
    const below = this.top as Screen;
    below.el.style.display = "";
    this.animate(below.el, "is-returning", MOVE_IN_MS);
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

  // Plays one of motion.css's screen moves on `el`, then `done`. A newer move on the same
  // screen replaces it.
  private animate(el: HTMLElement, name: string, ms: number, done?: () => void): void {
    const pending = this.moving.get(el);
    if (pending) {
      window.clearTimeout(pending.timer);
      el.classList.remove(pending.name);
    }
    void el.offsetWidth;
    el.classList.add(name);
    const timer = window.setTimeout(() => {
      this.moving.delete(el);
      el.classList.remove(name);
      if (done) done();
    }, ms);
    this.moving.set(el, { name, timer });
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
    deleteStoredLibrary();
    this.onSignedOut();
  }

  // Set by main.ts: where to go after signing in or out.
  onSignedIn: (creds: Creds) => void = () => undefined;
  onSignedOut: () => void = () => undefined;

  hasCreds(): boolean {
    return loadCreds() !== null;
  }

}
