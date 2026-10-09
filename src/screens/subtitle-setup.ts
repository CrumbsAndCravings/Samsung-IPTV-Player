// Online subtitles (plan 7.6; the Roku app's SubtitleSetupScreen): the OpenSubtitles API
// key, username and password, typed with the TV's keyboard. Saved first, then checked,
// so nothing typed is lost when the check fails (a Roku lesson); leaving with Back keeps
// what was typed too, unchecked. After saving, the details are read back, since a TV
// whose storage is full may not keep them. Remove turns online subtitles off on this TV,
// a personal build's own details too, until sign-out. The key shows only its last four
// characters, so a photo of the screen doesn't give it away.

import type { App, Screen } from "../app";
import { log } from "../core/log";
import { loadOsAccount, OsAccount, readOsFields, saveOsAccount, writeJson } from "../core/storage";
import { OsClient } from "../data/opensubtitles";
import type { Key } from "../platform/keys";
import { h, setText, toggle } from "../ui/dom";

interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
  mask: HTMLElement | null;
}

type ButtonAction = "save" | "remove";

const NOT_KEPT = "This TV didn't keep these details, so they'll be gone next time. Its storage for ARAN+ may be full: removing a few titles from Continue Watching makes room.";

export class SubtitleSetupScreen implements Screen {
  readonly el: HTMLElement;
  private fields: Field[];
  private buttonsEl: HTMLElement;
  private buttons: { label: string; action: ButtonAction }[] = [];
  private buttonEls: HTMLElement[] = [];
  private status: HTMLElement;
  private index = 0; // 0..2 fields, 3 the buttons
  private buttonIndex = 0;
  private busy = false;
  private alive = true;
  private dirty = false; // typed something not yet saved

  constructor(private app: App) {
    const saved = readOsFields();
    this.fields = [
      this.field("API key", "text", "From your OpenSubtitles profile", saved.apiKey, true),
      this.field("Username (optional)", "text", "Your username, not your email", saved.username, false),
      this.field("Password (optional)", "password", "", saved.password, false),
    ];
    this.buttonsEl = h("div", { class: "login-submit setup-buttons" });
    this.status = h("div", { class: "login-status" });
    this.el = h("div", { class: "screen login subtitle-setup" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "logo login-logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
      h("div", { class: "login-heading", text: "Online subtitles" }),
      h("div", { class: "login-intro", text: "Connect OpenSubtitles to find English subtitles for titles that don't have their own." }),
      h("div", { class: "login-fields" }, this.fields.map((f) => f.wrap)),
      this.buttonsEl,
      this.status,
      h("div", { class: "login-tips" }, [
        h("div", { class: "login-tips-heading", text: "Getting a key" }),
        h("p", { text: "Sign up free at opensubtitles.com. In your profile, open API Consumers and create one; its API key goes here." }),
        h("p", { text: "Add your username (not your email) and password for about 20 downloads a day, or about 5 with the key alone." }),
        h("p", { text: "These stay on this TV. A USB keyboard plugged into the TV makes the key quicker to type." }),
      ]),
    ]);
    this.setButtons(saved.apiKey !== "");
    if (saved.apiKey) this.say("Connected. Change anything and save to check again.", true);
    this.index = saved.apiKey ? 3 : 0;
    this.style();
  }

  private field(label: string, type: string, placeholder: string, value: string, masked: boolean): Field {
    const input = h("input", { class: "login-input", attrs: { type, spellcheck: "false", autocomplete: "off" } });
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    const mask = masked ? h("div", { class: "login-input setup-mask" }) : null;
    const wrap = h("div", { class: "login-field" + (masked ? " is-masked" : "") }, [h("div", { class: "login-caption", text: label.toUpperCase() }), input, mask]);
    const field = { wrap, input, mask };
    input.addEventListener("blur", () => this.commit(this.fields.indexOf(field)));
    this.renderMask(field);
    return field;
  }

  // "••••••••••••3f9a": enough to recognise the key, not enough to use it.
  private renderMask(field: Field): void {
    if (!field.mask) return;
    const value = field.input.value;
    const hidden = value.length > 8 ? value.length - 4 : value.length;
    const shown = new Array(Math.min(hidden, 24) + 1).join("•") + value.slice(hidden);
    setText(field.mask, shown || field.input.placeholder);
    toggle(field.mask, "is-placeholder", value === "");
  }

  private setButtons(hasAccount: boolean): void {
    this.buttons = [{ label: "Save and check", action: "save" }];
    if (hasAccount) this.buttons.push({ label: "Remove", action: "remove" });
    this.buttonEls = this.buttons.map((b) => h("div", { class: "pill", text: b.label }));
    while (this.buttonsEl.firstChild) this.buttonsEl.removeChild(this.buttonsEl.firstChild);
    for (const el of this.buttonEls) this.buttonsEl.appendChild(el);
    if (this.buttonIndex >= this.buttons.length) this.buttonIndex = 0;
  }

  private say(text: string, good: boolean): void {
    setText(this.status, text);
    toggle(this.status, "is-good", good);
  }

  private commit(i: number): void {
    const f = this.fields[i];
    if (!f) return;
    toggle(f.wrap, "is-editing", false);
    if (i !== 2) f.input.value = f.input.value.trim();
    const saved = readOsFields();
    if (f.input.value !== [saved.apiKey, saved.username, saved.password][i]) this.dirty = true;
    this.renderMask(f);
    // On to the next box, as on the sign-in screen.
    if (this.index === i) this.index = i + 1;
    this.style();
  }

  private style(): void {
    this.fields.forEach((f, i) => toggle(f.wrap, "is-focused", i === this.index));
    this.buttonEls.forEach((el, i) => toggle(el, "is-focused", this.index === 3 && i === this.buttonIndex));
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

  private save(): void {
    const apiKey = this.fields[0].input.value.trim();
    const username = this.fields[1].input.value.trim();
    const password = this.fields[2].input.value;
    if (!apiKey) {
      this.say("Enter your API key first.", false);
      this.index = 0;
      this.style();
      return;
    }
    if (username && !password) {
      this.say("Add the password for " + username + ", or clear the username.", false);
      this.index = 2;
      this.style();
      return;
    }
    // Saved before the check, so a failed check loses nothing.
    const saved = readOsFields();
    const changed = saved.apiKey !== apiKey || saved.username !== username || saved.password !== password;
    const account = { apiKey, username, password, token: changed ? "" : saved.token, baseUrl: changed ? "" : saved.baseUrl };
    this.keep(account);
    this.dirty = false;
    this.app.refreshSecrets();
    this.setButtons(true);
    this.busy = true;
    if (this.keptHere(apiKey, username)) this.say("Saved. Checking with OpenSubtitles…", true);
    else this.say(NOT_KEPT + " They're being checked for now.", false);
    this.style();
    new OsClient(account).check().then((result) => {
      if (!this.alive) return;
      this.busy = false;
      if (!result.ok) {
        log("opensubtitles check failed:", result.error);
        this.say(result.error, false);
        return;
      }
      if (!this.keptHere(apiKey, username)) {
        this.say("The details work, but " + NOT_KEPT.charAt(0).toLowerCase() + NOT_KEPT.slice(1), false);
        return;
      }
      let text = result.name ? "Connected as " + result.name + "." : "The key works. Without a login you get about 5 downloads a day.";
      if (result.name && result.allowed > 0) text += " " + result.allowed + " downloads a day.";
      this.say(text, true);
    });
  }

  // Saves the account; a TV whose storage is full may refuse (keptHere says so).
  private keep(account: OsAccount): void {
    try {
      saveOsAccount(account);
    } catch (err) {
      log("opensubtitles: not saved:", String(err));
    }
  }

  // Reads the account back: a TV can refuse to keep it when its storage is full.
  private keptHere(apiKey: string, username: string): boolean {
    const kept = loadOsAccount();
    return kept !== null && kept.apiKey === apiKey && kept.username === username;
  }

  // Leaving without "Save and check" keeps what was typed (checked the next time it's
  // used), so nothing has to be typed again.
  private keepTyped(): void {
    const apiKey = this.fields[0].input.value.trim();
    if (!this.dirty || apiKey === "") return;
    const username = this.fields[1].input.value.trim();
    const password = this.fields[2].input.value;
    this.keep({ apiKey, username: username && password ? username : "", password: username && password ? password : "", token: "", baseUrl: "" });
    this.dirty = false;
    this.app.refreshSecrets();
  }

  private remove(): void {
    // The build's own details stay off too, until sign-out.
    writeJson("opensubtitles", "account", { removed: true });
    this.dirty = false;
    this.app.refreshSecrets();
    for (const f of this.fields) {
      f.input.value = "";
      this.renderMask(f);
    }
    this.setButtons(false);
    this.index = 0;
    this.say("Removed. Online subtitles are off.", true);
    this.style();
  }

  onKey(key: Key): void {
    if (this.busy) {
      if (key === "back") this.app.pop();
      return;
    }
    if (key === "back") this.keepTyped();
    switch (key) {
      case "up":
        if (this.index > 0) this.index--;
        break;
      case "down":
        if (this.index < 3) this.index++;
        break;
      case "left":
        if (this.index === 3 && this.buttonIndex > 0) this.buttonIndex--;
        break;
      case "right":
        if (this.index === 3 && this.buttonIndex < this.buttons.length - 1) this.buttonIndex++;
        break;
      case "ok":
        if (this.index < 3) this.edit(this.index);
        else if (this.buttons[this.buttonIndex].action === "save") this.save();
        else this.remove();
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
