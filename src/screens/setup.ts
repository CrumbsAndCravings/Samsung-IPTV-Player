// The M0 setup checks, reachable from the account menu for diagnosing on the TV.

import type { App, Screen } from "../app";
import type { Key } from "../platform/keys";
import { ProbeScreen } from "../probe/probe";

export class SetupChecksScreen implements Screen {
  readonly el: HTMLElement;
  private probe: ProbeScreen;
  private started = false;

  constructor(private app: App) {
    this.probe = new ProbeScreen(app.root, () => this.app.pop());
    this.el = this.probe.el;
  }

  onShow(): void {
    if (this.started) return;
    this.started = true;
    this.probe.start();
  }

  onKey(key: Key): void {
    this.probe.onKey(key);
  }
}
