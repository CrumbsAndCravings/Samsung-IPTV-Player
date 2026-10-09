// Change server address (the Roku app's 0.5.13; docs/features.md §2.5), from the account
// menu. Providers move to new addresses now and then. Changing it here, rather than
// signing out, keeps everything: the new address is checked with a sign-in first (one
// request), then the same account carries on there and Home starts again, Continue
// Watching following from the old address at the next sync (core/account.ts). A failed
// check changes nothing.

import type { App, Screen } from "../app";
import { log } from "../core/log";
import { loadCreds, saveCreds } from "../core/storage";
import { normalizeServer } from "../core/utils";
import { checkLogin } from "../data/api";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";

type Button = "check" | "cancel";

export class ServerScreen implements Screen {
  readonly el: HTMLElement;
  private wrap: HTMLElement;
  private input: HTMLInputElement;
  private buttonEls: HTMLElement[];
  private buttons: Button[] = ["check", "cancel"];
  private status: HTMLElement;
  private tips: HTMLElement;
  private errorCard: HTMLElement;
  private errorText: HTMLElement;
  private index = 0; // 0 the address, 1 the buttons
  private buttonIndex = 0;
  private checking = 0; // the check under way, so a cancelled one's answer is dropped
  private alive = true;

  constructor(private app: App) {
    const creds = loadCreds();
    this.input = h("input", { class: "login-input", attrs: { type: "text", spellcheck: "false", autocomplete: "off" } });
    this.input.value = creds ? creds.server : "";
    this.input.placeholder = "e.g. http://line.example.com:8080";
    this.input.addEventListener("blur", () => this.commit());
    this.wrap = h("div", { class: "login-field" }, [h("div", { class: "login-caption", text: "SERVER ADDRESS" }), this.input]);
    this.buttonEls = [h("div", { class: "pill", text: "Check and save" }), h("div", { class: "pill", text: "Cancel" })];
    this.status = h("div", { class: "login-status" });
    this.errorText = h("div", { class: "login-error-text" });
    this.errorCard = h("div", { class: "login-tips login-error is-hidden" }, [h("div", { class: "login-tips-heading", text: "That address didn't work" }), this.errorText]);
    this.el = h("div", { class: "screen login server-setup" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo login-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "login-heading", text: "Server address" }),
      h("div", { class: "login-intro", text: "Your provider's new address. Your account, Continue Watching, My List and ratings stay." }),
      h("div", { class: "login-fields" }, [this.wrap]),
      h("div", { class: "login-submit setup-buttons" }, this.buttonEls),
      this.status,
      this.errorCard,
      (this.tips = h("div", { class: "login-tips" }, [
        h("div", { class: "login-tips-heading", text: "When to use this" }),
        h("p", { text: "When your provider tells you their address has changed. Your username and password stay as they are." }),
        h("p", { text: "The new address is checked by signing in there first; if that fails, nothing changes." }),
      ])),
    ]);
    this.style();
  }

  private say(text: string, good: boolean): void {
    setText(this.status, text);
    toggle(this.status, "is-good", good);
  }

  // A long failure goes in a card in place of the tips, as on the sign-in screen.
  private showError(text: string): void {
    setText(this.errorText, text);
    toggle(this.errorCard, "is-hidden", text === "");
    toggle(this.tips, "is-hidden", text !== "");
  }

  private style(): void {
    toggle(this.wrap, "is-focused", this.index === 0);
    this.buttonEls.forEach((el, i) => toggle(el, "is-focused", this.index === 1 && i === this.buttonIndex));
  }

  private commit(): void {
    toggle(this.wrap, "is-editing", false);
    this.input.value = this.input.value.trim();
    this.index = 1;
    this.buttonIndex = 0;
    this.style();
  }

  private edit(): void {
    toggle(this.wrap, "is-editing", true);
    this.input.focus();
    try {
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    } catch {
      // Not every input type allows a selection.
    }
  }

  private check(): void {
    const creds = loadCreds();
    if (!creds) return this.app.pop();
    const server = normalizeServer(this.input.value);
    if (server === "") {
      this.say("Enter the new address first.", false);
      this.index = 0;
      this.style();
      return;
    }
    if (server.toLowerCase() === normalizeServer(creds.server).toLowerCase()) {
      this.say("That's the address ARAN+ uses now.", false);
      return;
    }
    const next = { server, username: creds.username, password: creds.password };
    const mine = ++this.checking;
    this.showError("");
    this.say("Checking the new address…", true);
    log("server address: checking a new one");
    checkLogin(next).then((error) => {
      if (!this.alive || mine !== this.checking) return;
      this.checking = 0;
      if (error) {
        setText(this.buttonEls[0], "Try again");
        this.say("That address didn't work.", false);
        this.showError(error + (/[.!?]$/.test(error) ? "" : ".") + "\n\nNothing has changed: ARAN+ still uses " + creds.server + ".");
        return;
      }
      log("server address: changed; the same account carries on there");
      saveCreds(next);
      // Home starts again at the new address, keeping everything.
      this.app.onSignedIn(next);
    });
  }

  onKey(key: Key): void {
    if (this.checking) {
      // Back cancels the check; its answer is dropped.
      if (key === "back") {
        this.checking = 0;
        this.say("", false);
      }
      return;
    }
    switch (key) {
      case "up":
        this.index = 0;
        break;
      case "down":
        this.index = 1;
        break;
      case "left":
        if (this.index === 1 && this.buttonIndex > 0) this.buttonIndex--;
        break;
      case "right":
        if (this.index === 1 && this.buttonIndex < this.buttons.length - 1) this.buttonIndex++;
        break;
      case "ok":
        if (this.index === 0) this.edit();
        else if (this.buttons[this.buttonIndex] === "check") this.check();
        else this.app.pop();
        break;
      case "back":
        this.app.pop();
        return;
      default:
        return;
    }
    this.style();
  }

  destroy(): void {
    this.alive = false;
  }
}
