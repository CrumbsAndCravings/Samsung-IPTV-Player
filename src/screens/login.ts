// Sign in (plan 7.1; the Roku app's LoginScreen): server, username and password, typed
// with the TV's keyboard. Pasting a full M3U or get.php link into Server fills in the
// username and password. The login is checked with the server before it is saved, and
// a failure shows the server's own reason.

import type { App, Screen } from "../app";
import { log } from "../core/log";
import { loadCreds, saveCreds } from "../core/storage";
import { Creds, normalizeServer, parseProviderLink } from "../core/utils";
import { checkLogin } from "../data/api";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";

interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
}

export class LoginScreen implements Screen {
  readonly el: HTMLElement;
  private fields: Field[];
  private submit: HTMLElement;
  private status: HTMLElement;
  private index = 0; // 0..2 fields, 3 the Sign in button
  private busy = false;

  constructor(private app: App) {
    const saved = loadCreds();
    this.fields = [
      this.field("Server", "text", "e.g. http://line.example.com:8080", saved ? saved.server : ""),
      this.field("Username", "text", "", saved ? saved.username : ""),
      this.field("Password", "password", "", saved ? saved.password : ""),
    ];
    this.submit = h("div", { class: "pill", text: "Sign in" });
    this.status = h("div", { class: "login-status" });
    this.el = h("div", { class: "screen login" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo login-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "login-heading", text: "Welcome to ARAN+" }),
      h("div", { class: "login-intro", text: "Enter the Xtream Codes login your provider sent you. You only need to do this once." }),
      h("div", { class: "login-fields" }, this.fields.map((f) => f.wrap)),
      h("div", { class: "login-submit" }, [this.submit]),
      this.status,
      h("div", { class: "login-tips" }, [
        h("div", { class: "login-tips-heading", text: "Where to find these" }),
        h("p", { text: "Your provider's welcome email lists a server address, username and password. It may call them an Xtream or API login." }),
        h("p", { text: "Have an M3U link instead? Put it in Server and the username and password fill in by themselves." }),
        h("p", { text: "Press OK on a box to type, and Done on the TV keyboard when you're finished." }),
      ]),
    ]);
    this.index = this.nextEmpty();
    this.style();
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
    const text = f.input.value;
    if (i === 0 && text.toLowerCase().indexOf("username=") >= 0) {
      const link = parseProviderLink(text);
      f.input.value = link.server;
      if (link.username) this.fields[1].input.value = link.username;
      if (link.password) this.fields[2].input.value = link.password;
    } else if (i !== 2) f.input.value = text.trim();
    setText(this.status, "");
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
      password: this.fields[2].input.value,
    };
    if (!creds.server || !creds.username || !creds.password) {
      setText(this.status, "Fill in the server, username and password first.");
      this.index = this.nextEmpty();
      this.style();
      return;
    }
    this.busy = true;
    setText(this.status, "Checking your login…");
    checkLogin(creds).then((error) => {
      this.busy = false;
      if (error) {
        setText(this.status, error);
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
