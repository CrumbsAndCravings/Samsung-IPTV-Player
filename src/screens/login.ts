// Sign in (plan 7.1; the Roku app's LoginScreen): server, username and password, typed
// with the TV's keyboard. Pasting a full M3U, get.php, /playlist/ or stream link into
// Server fills in the username and password. The login is checked with the server
// before it is saved, and a failure shows who answered and what they said, with the
// address used, in a card in place of the tips. A personal build's own login
// (personal.json) fills the form, and signs in by itself at launch.

import type { App, Screen } from "../app";
import { log } from "../core/log";
import { builtInCreds } from "../core/personal";
import { loadCreds, saveCreds } from "../core/storage";
import { Creds, normalizeServer, parseProviderLink } from "../core/utils";
import { checkLogin } from "../data/api";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";
import { introReady } from "../ui/intro";

interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
}

export class LoginScreen implements Screen {
  readonly el: HTMLElement;
  private fields: Field[];
  private submit: HTMLElement;
  private status: HTMLElement;
  private tips: HTMLElement;
  private errorCard: HTMLElement;
  private errorText: HTMLElement;
  private index = 0; // 0..2 fields, 3 the Sign in button
  private busy = false;

  // `autoSignIn` (launch only, never after signing out) submits a built-in login.
  constructor(
    private app: App,
    private autoSignIn = false,
  ) {
    // Nothing to load: the intro may fly in when it's ready (ui/intro.ts).
    introReady();
    const saved = loadCreds() || builtInCreds();
    this.fields = [
      this.field("Server", "text", "e.g. http://line.example.com:8080", saved ? saved.server : ""),
      this.field("Username", "text", "", saved ? saved.username : ""),
      this.field("Password", "password", "", saved ? saved.password : ""),
    ];
    this.submit = h("div", { class: "pill", text: "Sign in" });
    this.status = h("div", { class: "login-status" });
    this.errorText = h("div", { class: "login-error-text" });
    this.errorCard = h("div", { class: "login-tips login-error is-hidden" }, [h("div", { class: "login-tips-heading", text: "Couldn't sign in" }), this.errorText]);
    this.el = h("div", { class: "screen login" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo login-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "login-heading", text: "Welcome to ARAN+" }),
      h("div", { class: "login-intro", text: "Enter the Xtream Codes login your provider sent you. You only need to do this once." }),
      h("div", { class: "login-fields" }, this.fields.map((f) => f.wrap)),
      h("div", { class: "login-submit" }, [this.submit]),
      this.status,
      (this.tips = h("div", { class: "login-tips" }, [
        h("div", { class: "login-tips-heading", text: "Where to find these" }),
        h("p", { text: "Your provider's welcome email lists a server address, username and password. It may call them an Xtream or API login." }),
        h("p", { text: "Have an M3U link instead? Put it in Server and the username and password fill in by themselves." }),
        h("p", { text: "Press OK on a box to type, and Done on the TV keyboard when you're finished." }),
      ])),
      this.errorCard,
    ]);
    this.index = this.nextEmpty();
    this.style();
  }

  onShow(): void {
    if (!this.autoSignIn) return;
    this.autoSignIn = false;
    if (this.nextEmpty() === 3) this.signIn();
  }

  // Long errors go in the card where the tips were, inside the TV's safe area.
  private showError(text: string): void {
    setText(this.errorText, text);
    toggle(this.errorCard, "is-hidden", text === "");
    toggle(this.tips, "is-hidden", text !== "");
  }

  private field(label: string, type: string, placeholder: string, value: string): Field {
    const input = h("input", { class: "login-input", attrs: { type, spellcheck: "false", autocomplete: "off" } });
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    const wrap = h("div", { class: "login-field" }, [h("div", { class: "login-caption", text: label.toUpperCase() }), input]);
    input.addEventListener("blur", () => this.commit(this.fields.indexOf(field)));
    const field = { wrap, input };
    return field;
  }

  private commit(i: number): void {
    const f = this.fields[i];
    if (!f) return;
    toggle(f.wrap, "is-editing", false);
    const text = f.input.value.trim();
    if (i === 0) {
      const link = parseProviderLink(text);
      f.input.value = link.server;
      if (link.username) this.fields[1].input.value = link.username;
      if (link.password) this.fields[2].input.value = link.password;
    } else f.input.value = text;
    setText(this.status, "");
    this.showError("");
    this.index = this.nextEmpty();
    this.style();
  }

  private nextEmpty(): number {
    for (let i = 0; i < 3; i++) if (this.fields[i].input.value === "") return i;
    return 3;
  }

  private style(): void {
    this.fields.forEach((f, i) => toggle(f.wrap, "is-focused", i === this.index));
    toggle(this.submit, "is-focused", this.index === 3);
  }

  private edit(i: number): void {
    const f = this.fields[i];
    toggle(f.wrap, "is-editing", true);
    f.input.focus();
    try {
      f.input.setSelectionRange(f.input.value.length, f.input.value.length);
    } catch {
      // Not every input type allows a selection.
    }
  }

  private signIn(): void {
    const creds: Creds = {
      server: normalizeServer(this.fields[0].input.value),
      username: this.fields[1].input.value.trim(),
      password: this.fields[2].input.value.trim(),
    };
    if (!creds.server || !creds.username || !creds.password) {
      setText(this.status, "Fill in the server, username and password first.");
      this.index = this.nextEmpty();
      this.style();
      return;
    }
    this.busy = true;
    this.showError("");
    setText(this.status, "Checking your login…");
    checkLogin(creds).then((error) => {
      this.busy = false;
      if (error) {
        setText(this.status, "");
        this.showError(error);
        return;
      }
      log("signed in");
      saveCreds(creds);
      setText(this.status, "");
      this.app.onSignedIn(creds);
    });
  }

  onKey(key: Key): void {
    if (this.busy) return;
    switch (key) {
      case "up":
        if (this.index > 0) this.index--;
        this.style();
        break;
      case "down":
        if (this.index < 3) this.index++;
        this.style();
        break;
      case "ok":
        if (this.index < 3) this.edit(this.index);
        else this.signIn();
        break;
      case "back":
        this.app.confirmExit();
        break;
      default:
        break;
    }
  }
}
