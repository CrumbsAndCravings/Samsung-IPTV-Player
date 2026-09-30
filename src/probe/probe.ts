// M0 "Setup checks" screen: the hello-world screen with the ARAN+ fonts and palette,
// plus every check from section 2 of the plan, run on the TV itself:
//   - the web engine and model (it turned out to be a 2020 Q60T with Chromium 69)
//   - one XHR to the Xtream server from the packaged app
//   - which headers reach OpenSubtitles (User-Agent vs X-User-Agent)
//   - range requests on a stream (needed for OpenSubtitles' moviehash)
//   - AVPlay on an HEVC MKV, an AVI, an H.264 MP4 and a file with DTS audio
// Everything shown is safe to photograph: logins stay hidden unless being typed, and
// logs and the report are redacted. The report can also be shown as a QR code.

import { describeModelYear } from "../core/device";
import { logLines, onLog } from "../core/log";
import { credsSecrets, redact, setSecrets } from "../core/redact";
import {
  loadCreds,
  readJson,
  readOsFields,
  saveCreds,
  saveOsAccount,
  writeJson,
} from "../core/storage";
import { apiUrl, Creds, episodeCode, isArr, isObj, normalizeServer, parseProviderLink, streamUrl } from "../core/utils";
import { ListItem, parseSeriesInfo, parseVodInfo, Season } from "../core/xtream";
import { getJson } from "../platform/http";
import type { Key } from "../platform/keys";
import { DeviceInfo, exitApp, readDevice } from "../platform/tizen";
import { append, clear, h, setText, toggle } from "../ui/dom";
import { KeyTarget, setKeyTarget } from "../ui/focus";
import { Direction, nearest, scrollIntoContainer } from "../ui/spatial";
import { echoCheck, osCheck, rangeCheck, xtreamCheck } from "./checks";
import { libraryStats, loadLibrary, matchTitles } from "./library";
import { PlayTest } from "./playtest";
import { drawQr } from "./qr";
import { fileLabel, PlayResult, playSummary, ProbeState, reportLines, reportText } from "./report";
import { findSamples, Sample, SLOTS, Slots } from "./samples";

type FieldKind = "text" | "secret" | "password";

interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
}

interface Modal {
  root: HTMLElement;
  back: () => void;
}

interface OpenSeries {
  id: string;
  name: string;
  seasons: Season[];
  seasonIndex: number;
}

const MAX_PLAYS = 20;

export class ProbeScreen implements KeyTarget {
  readonly el: HTMLElement;
  private left: HTMLElement;
  private right: HTMLElement;
  private actions = new WeakMap<HTMLElement, () => void>();
  private focused: HTMLElement | null = null;
  private modal: Modal | null = null;
  private busy: { [task: string]: boolean } = {};

  private state: ProbeState;
  private slots: Slots = {};
  private moreAvi: Sample[] = [];
  private series: OpenSeries | null = null;

  private tvCard: HTMLElement;
  private server: Field;
  private username: Field;
  private password: Field;
  private xtreamStatus: HTMLElement;
  private osKey: Field;
  private osUser: Field;
  private osPass: Field;
  private osStatus: HTMLElement;
  private findProgress: HTMLElement;
  private slotList: HTMLElement;
  private extLine: HTMLElement;
  private search: Field;
  private searchProgress: HTMLElement;
  private searchList: HTMLElement;
  private episodeBox: HTMLElement;
  private playList: HTMLElement;
  private reportList: HTMLElement;
  private logList: HTMLElement | null = null;

  // `onBack` makes Back leave the screen (opened from the account menu) instead of
  // asking to exit the app.
  constructor(
    private host: HTMLElement,
    private onBack?: () => void,
  ) {
    this.state = this.loadState();
    const saved = readJson("probe", "slots");
    if (isObj(saved)) this.slots = saved as Slots;
    const savedAvi = readJson("probe", "moreAvi");
    if (isArr(savedAvi)) this.moreAvi = savedAvi as Sample[];

    const creds = loadCreds();
    const os = readOsFields();
    this.updateSecrets();

    this.tvCard = h("div", { class: "card" }, [h("h2", { class: "card-title", text: "This TV" }), h("div", { class: "status-progress", text: "Reading…" })]);

    this.server = this.field("Server (hidden unless typing)", "secret", creds ? creds.server : "", false, "line.example.com:8080 or a full M3U link", (value) => this.commitServer(value));
    this.username = this.field("Username", "secret", creds ? creds.username : "", true, "", () => this.saveCredsFromFields());
    this.password = this.field("Password", "password", creds ? creds.password : "", true, "", () => this.saveCredsFromFields());
    this.xtreamStatus = h("div");
    const xtreamCard = h("div", { class: "card" }, [
      h("h2", { class: "card-title", text: "Your IPTV account" }),
      h("p", { class: "card-note", text: "Saved on this TV only. OK on a box opens the TV keyboard; Done or Back finishes." }),
      this.server.wrap,
      this.username.wrap,
      this.password.wrap,
      this.pill("Save and test", "xtream-test", () => this.testXtream()),
      this.xtreamStatus,
    ]);

    this.osKey = this.field("API key", "secret", os.apiKey, false, "From opensubtitles.com, Consumers", () => this.saveOsFromFields());
    this.osUser = this.field("Username, not email", "secret", os.username, true, "", () => this.saveOsFromFields());
    this.osPass = this.field("Password", "password", os.password, true, "", () => this.saveOsFromFields());
    this.osStatus = h("div");
    const osCard = h("div", { class: "card" }, [
      h("h2", { class: "card-title", text: "OpenSubtitles (for M4)" }),
      h("p", { class: "card-note", text: "Checks which headers get through from this TV. The header check works without an account." }),
      this.osKey.wrap,
      this.osUser.wrap,
      this.osPass.wrap,
      this.pill("Save and test", "os-test", () => this.testOs()),
      this.osStatus,
    ]);

    this.findProgress = h("div", { class: "status-progress" });
    this.slotList = h("div");
    this.extLine = h("div", { class: "card-note" });
    this.search = this.field("Find a title (a series the Roku couldn't play, say)", "text", "", false, "", (value) => this.runSearch(value));
    this.searchProgress = h("div", { class: "status-progress" });
    this.searchList = h("div");
    this.episodeBox = h("div");
    this.playList = h("div");
    const playCard = h("div", { class: "card" }, [
      h("h2", { class: "card-title", text: "Playback" }),
      h("p", {
        class: "card-note",
        text: "Plays files from your provider with Samsung's player. While playing: OK pauses, Left/Right jump 30 s, Up and Down switch audio and subtitles, Back stops and saves the result.",
      }),
      this.pill("Find test videos", "find", () => this.findTestVideos()),
      this.findProgress,
      this.slotList,
      this.extLine,
      this.search.wrap,
      this.searchProgress,
      this.searchList,
      this.episodeBox,
      h("div", { class: "section-title", text: "Tried so far" }),
      this.playList,
    ]);

    this.left = h("div", { class: "probe-left" }, [this.tvCard, xtreamCard, osCard, playCard, h("div", { class: "probe-end" })]);

    this.reportList = h("div");
    this.right = h("div", { class: "probe-right" }, [
      h("div", { class: "card" }, [
        h("h2", { class: "card-title", text: "Report" }),
        h("p", { class: "card-note", text: "Photograph this, or show the code and scan it with a phone. No logins or server names in it." }),
        this.reportList,
        this.pill("Show report code", "qr", () => this.showQr()),
        this.pill("Show log", "log", () => this.showLog()),
        this.pill("Clear results", "clear", () => this.clearResults()),
      ]),
    ]);

    this.el = h("div", { class: "screen probe" }, [
      h("div", { class: "glow glow-lavender" }),
      h("div", { class: "glow glow-pink" }),
      h("div", { class: "probe-header" }, [
        h("div", { class: "logo" }, [h("span", { class: "logo-name", text: "ARAN" }), h("span", { class: "logo-plus", text: "+" })]),
        h("div", { class: "probe-title", text: "Setup checks" }),
        h("div", { class: "probe-version", text: "v" + __APP_VERSION__ }),
      ]),
      this.left,
      this.right,
    ]);

    onLog(() => this.renderLog());
  }

  mount(): void {
    this.host.appendChild(this.el);
    this.start();
    setKeyTarget(this);
  }

  // Fills the screen and reads the TV's details. Called once, when first shown.
  start(): void {
    this.renderSlots();
    this.renderPlays();
    this.renderXtream();
    this.renderOs();
    this.renderReport();
    this.focus(this.server.wrap);
    readDevice().then((info) => {
      this.state.device = info;
      this.renderDevice(info);
      this.renderReport();
    });
  }

  // --- State --------------------------------------------------------------------

  private loadState(): ProbeState {
    const saved = readJson("probe", "state");
    const s = isObj(saved) ? (saved as unknown as Partial<ProbeState>) : {};
    return {
      device: null,
      xtream: s.xtream || null,
      range: s.range || null,
      echo: s.echo || null,
      os: s.os || null,
      samples: s.samples || null,
      library: [],
      plays: isArr(s.plays) ? (s.plays as PlayResult[]) : [],
    };
  }

  private saveState(): void {
    const { xtream, range, echo, os, samples, plays } = this.state;
    writeJson("probe", "state", { xtream, range, echo, os, samples, plays } as unknown as { [key: string]: unknown });
  }

  private updateSecrets(): void {
    const creds = loadCreds();
    const os = readOsFields();
    const list = creds ? credsSecrets(creds.server, creds.username, creds.password) : [];
    list.push({ value: os.apiKey, label: "<api key>" }, { value: os.username, label: "<os user>" }, { value: os.password, label: "<os password>" }, { value: os.token, label: "<token>" });
    setSecrets(list);
  }

  // --- Building blocks -------------------------------------------------------------

  private pill(label: string, key: string, action: () => void): HTMLElement {
    const el = h("div", { class: "pill focusable", text: label, attrs: { "data-key": key } });
    this.actions.set(el, action);
    return el;
  }

  private field(label: string, kind: FieldKind, value: string, half: boolean, placeholder: string, onCommit: (value: string) => void): Field {
    const hidden = kind !== "text";
    const input = h("input", { class: "field-input", attrs: { type: hidden ? "password" : "text", spellcheck: "false", autocomplete: "off" } });
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    const wrap = h("div", { class: "field focusable" + (half ? " field-half" : ""), attrs: { "data-key": "field:" + label } }, [
      h("span", { class: "field-label", text: label }),
      input,
    ]);
    this.actions.set(wrap, () => {
      // Shown while typing, hidden again afterwards (passwords stay hidden).
      if (kind !== "password") input.type = "text";
      toggle(wrap, "is-editing", true);
      input.focus();
      const end = input.value.length;
      try {
        input.setSelectionRange(end, end);
      } catch {
        // Not every input type allows a selection.
      }
    });
    input.addEventListener("blur", () => {
      toggle(wrap, "is-editing", false);
      if (hidden) input.type = "password";
      onCommit(input.value.trim());
    });
    return { wrap, input };
  }

  private row(key: string, kind: string, title: string, meta: string, result: { outcome: string; text: string } | null, poster: string, action: (() => void) | null): HTMLElement {
    const img = h("img", { class: "sample-poster" });
    if (poster) {
      img.src = poster;
      img.onerror = () => img.removeAttribute("src");
    }
    const el = h("div", { class: "sample-row" + (action ? " focusable" : " is-empty"), attrs: { "data-key": key } }, [
      img,
      h("div", { class: "sample-body" }, [
        h("div", { class: "sample-kind", text: kind }),
        h("div", { class: "sample-title", text: title }),
        meta ? h("div", { class: "sample-meta", text: meta }) : null,
        result ? h("div", { class: "sample-result" }, [h("span", { class: "dot dot-" + result.outcome }), result.text]) : null,
      ]),
    ]);
    if (action) this.actions.set(el, action);
    return el;
  }

  private statusLine(outcome: string, text: string): HTMLElement {
    return h("div", { class: "status-line" }, [h("span", { class: "dot dot-" + outcome }), h("span", { text: redact(text) })]);
  }

  // --- Focus and keys --------------------------------------------------------------

  private scope(): HTMLElement {
    return this.modal ? this.modal.root : this.el;
  }

  private focus(el: HTMLElement | null): void {
    if (!el) return;
    if (this.focused) toggle(this.focused, "is-focused", false);
    this.focused = el;
    toggle(el, "is-focused", true);
    if (this.left.contains(el)) scrollIntoContainer(this.left, el);
    if (this.right.contains(el)) scrollIntoContainer(this.right, el);
  }

  private focusables(): HTMLElement[] {
    const list = this.scope().querySelectorAll(".focusable");
    const out: HTMLElement[] = [];
    for (let i = 0; i < list.length; i++) out.push(list[i] as HTMLElement);
    return out;
  }

  // After a list is rebuilt, focus the element with the same key, or something nearby.
  private refocus(fallback?: HTMLElement): void {
    const key = this.focused ? this.focused.getAttribute("data-key") : null;
    if (this.focused && this.scope().contains(this.focused)) return;
    const again = key ? (this.scope().querySelector('[data-key="' + key.replace(/"/g, '\\"') + '"]') as HTMLElement | null) : null;
    this.focus(again || fallback || this.focusables()[0] || null);
  }

  onKey(key: Key): void {
    if (key === "up" || key === "down" || key === "left" || key === "right") {
      const from = this.focused && this.scope().contains(this.focused) ? this.focused : null;
      if (!from) {
        this.focus(this.focusables()[0] || null);
        return;
      }
      const next = nearest(from, this.focusables(), key as Direction);
      if (next) this.focus(next);
      return;
    }
    if (key === "ok") {
      const inScope = this.focused && this.scope().contains(this.focused);
      const action = inScope && this.focused ? this.actions.get(this.focused) : undefined;
      if (action) action();
      return;
    }
    if (key === "back") {
      if (this.modal) this.modal.back();
      else if (this.onBack) this.onBack();
      else this.confirmExit();
    }
  }

  // --- Modals ----------------------------------------------------------------------

  private openModal(content: HTMLElement, back: () => void, focusKey?: string): void {
    const root = h("div", { class: "dialog-scrim" }, [content]);
    this.el.appendChild(root);
    const previous = this.focused;
    this.modal = {
      root,
      back: () => {
        this.closeModal(previous);
        back();
      },
    };
    const first = focusKey ? (root.querySelector('[data-key="' + focusKey + '"]') as HTMLElement | null) : null;
    this.focus(first || this.focusables()[0] || null);
  }

  private closeModal(restore: HTMLElement | null): void {
    if (!this.modal) return;
    if (this.modal.root.parentNode) this.modal.root.parentNode.removeChild(this.modal.root);
    this.modal = null;
    this.focus(restore);
  }

  private confirmExit(): void {
    const dialog = h("div", { class: "dialog" }, [
      h("div", { class: "dialog-title", text: "Exit ARAN+?" }),
      this.pill("Stay", "stay", () => this.modal && this.modal.back()),
      this.pill("Exit", "exit", () => exitApp()),
    ]);
    this.openModal(dialog, () => undefined, "stay");
  }

  private showQr(): void {
    const canvas = h("canvas", { class: "qr-canvas" });
    const card = h("div", { class: "qr-card" }, [
      canvas,
      h("div", { class: "qr-caption", text: "Scan with your phone's camera, copy the text, and paste it into the chat. Back to close." }),
    ]);
    this.openModal(card, () => undefined);
    try {
      drawQr(canvas, redact(reportText(this.state, __APP_VERSION__)), 780);
    } catch (err) {
      card.insertBefore(h("div", { class: "pt-error", text: "Couldn't draw the code: " + (err as Error).message }), canvas);
    }
  }

  // --- IPTV account ----------------------------------------------------------------

  private commitServer(value: string): void {
    // Pasting a full M3U / get.php link fills in the username and password (as on Roku).
    if (value.indexOf("?") >= 0) {
      const link = parseProviderLink(value);
      if (link.username !== "") this.username.input.value = link.username;
      if (link.password !== "") this.password.input.value = link.password;
    }
    this.server.input.value = normalizeServer(value);
    this.saveCredsFromFields();
  }

  private credsFromFields(): Creds {
    return {
      server: normalizeServer(this.server.input.value),
      username: this.username.input.value.trim(),
      password: this.password.input.value.trim(),
    };
  }

  private saveCredsFromFields(): void {
    const creds = this.credsFromFields();
    if (creds.server === "" && creds.username === "") return;
    saveCreds(creds);
    this.updateSecrets();
  }

  private testXtream(): void {
    if (this.busy.xtream) return;
    const creds = this.credsFromFields();
    if (creds.server === "" || creds.username === "") {
      clear(this.xtreamStatus);
      this.xtreamStatus.appendChild(this.statusLine("warn", "Enter the server and username first."));
      return;
    }
    saveCreds(creds);
    this.updateSecrets();
    this.busy.xtream = true;
    clear(this.xtreamStatus);
    this.xtreamStatus.appendChild(h("div", { class: "status-progress", text: "Testing…" }));
    xtreamCheck(creds).then((result) => {
      this.busy.xtream = false;
      this.state.xtream = result;
      this.saveState();
      this.renderXtream();
      this.renderReport();
    });
  }

  private renderXtream(): void {
    clear(this.xtreamStatus);
    const x = this.state.xtream;
    if (!x) return;
    if (x.outcome === "fail") {
      this.xtreamStatus.appendChild(this.statusLine("fail", x.message + (x.code ? " (HTTP " + x.code + ")" : "")));
      return;
    }
    append(this.xtreamStatus, [
      this.statusLine("ok", "Reached the server from the TV: HTTP " + x.code + " in " + x.ms + " ms."),
      this.statusLine(x.status.toLowerCase() === "active" ? "ok" : "warn", "Account " + (x.status || "signed in") + " · ends " + x.expires + " · " + (x.maxConnections || "?") + " connections at once"),
      x.movieCategories >= 0
        ? this.statusLine("ok", x.movieCategories + " movie and " + x.seriesCategories + " series categories")
        : this.statusLine("warn", x.message),
    ]);
  }

  // --- OpenSubtitles ---------------------------------------------------------------

  private saveOsFromFields(): void {
    const saved = readOsFields();
    const apiKey = this.osKey.input.value.trim();
    const username = this.osUser.input.value.trim();
    const password = this.osPass.input.value.trim();
    const changed = apiKey !== saved.apiKey || username !== saved.username || password !== saved.password;
    // Save first, then check, so nothing typed is lost when the check fails.
    saveOsAccount({ apiKey, username, password, token: changed ? "" : saved.token, baseUrl: changed ? "" : saved.baseUrl });
    this.updateSecrets();
  }

  private testOs(): void {
    if (this.busy.os) return;
    this.saveOsFromFields();
    this.busy.os = true;
    clear(this.osStatus);
    this.osStatus.appendChild(h("div", { class: "status-progress", text: "Testing…" }));
    const account = readOsFields();
    echoCheck()
      .then((echo) => {
        this.state.echo = echo;
        return osCheck(account, (token, baseUrl) => {
          saveOsAccount({ apiKey: account.apiKey, username: account.username, password: account.password, token, baseUrl });
          this.updateSecrets();
        });
      })
      .then((os) => {
        this.busy.os = false;
        this.state.os = os;
        this.saveState();
        this.renderOs();
        this.renderReport();
      });
  }

  private renderOs(): void {
    clear(this.osStatus);
    const e = this.state.echo;
    if (e) {
      if (e.outcome === "fail") this.osStatus.appendChild(this.statusLine("fail", "Header check: " + e.message));
      else {
        append(this.osStatus, [
          this.statusLine(e.ourUserAgentArrived ? "ok" : "warn", e.ourUserAgentArrived ? "Our User-Agent arrives as sent." : "The TV replaces our User-Agent with: " + e.userAgentSeen),
          this.statusLine(e.xUserAgentArrived ? "ok" : "fail", e.xUserAgentArrived ? "X-User-Agent arrives." : "X-User-Agent doesn't arrive."),
        ]);
      }
    }
    const o = this.state.os;
    if (!o) return;
    const call = (label: string, c: { code: number; message: string } | null) =>
      c ? this.statusLine(c.code === 200 ? "ok" : "fail", label + ": " + (c.code === 200 ? "HTTP 200" : c.message || "HTTP " + c.code)) : null;
    append(this.osStatus, [
      o.message ? this.statusLine(o.outcome, o.message) : null,
      call("API key alone", o.keyOnly),
      call("API key with X-User-Agent", o.keyWithXua),
      o.login ? call("Login", o.login) : null,
      o.login && o.login.code === 200 ? this.statusLine("ok", o.login.allowed + " downloads a day" + (o.login.level ? " (" + o.login.level + ")" : "")) : null,
    ]);
  }

  // --- Playback --------------------------------------------------------------------

  private needCreds(status: HTMLElement): Creds | null {
    const creds = loadCreds();
    if (!creds) setText(status, "Save your IPTV account first.");
    return creds;
  }

  private findTestVideos(): void {
    if (this.busy.find) return;
    const creds = this.needCreds(this.findProgress);
    if (!creds) return;
    this.busy.find = true;
    findSamples(creds, (text) => setText(this.findProgress, text), () => false)
      .then((found) => {
        this.slots = found.slots;
        writeJson("probe", "slots", found.slots as unknown as { [key: string]: unknown });
        this.moreAvi = found.moreAvi;
        writeJson("probe", "moreAvi", found.moreAvi as unknown as { [key: string]: unknown }[]);
        this.state.samples = { titlesSeen: found.titlesSeen, infoChecked: found.infoChecked, withCodecs: found.withCodecs, extCounts: found.extCounts };
        const count = SLOTS.filter((s) => this.slots[s.id]).length;
        setText(this.findProgress, "Found " + count + " of " + SLOTS.length + " kinds in " + found.titlesSeen + " titles." + (found.message ? " " + found.message : ""));
        this.saveState();
        this.renderSlots();
        this.renderReport();
        const first = this.slots["hevc-mkv"] || this.slots["h264-mp4"] || this.slots.avi || this.slots.dts;
        if (first) return this.testRange(creds, first);
        return undefined;
      })
      .catch((err: Error) => setText(this.findProgress, redact(err.message)))
      .then(() => {
        this.busy.find = false;
      });
  }

  private testRange(creds: Creds, sample: Sample): Promise<void> {
    return rangeCheck(this.urlFor(creds, sample)).then((range) => {
      this.state.range = range;
      this.saveState();
      this.renderReport();
    });
  }

  private urlFor(creds: Creds, sample: Sample): string {
    return streamUrl(creds, sample.kind === "episode" ? "series" : "movie", sample.id, sample.ext);
  }

  private latestPlay(key: string): PlayResult | null {
    for (const play of this.state.plays) if (play.key === key) return play;
    return null;
  }

  private resultFor(key: string): { outcome: string; text: string } {
    const play = this.latestPlay(key);
    if (!play) return { outcome: "todo", text: "Not tried yet · OK to play" };
    return { outcome: play.outcome === "played" ? "ok" : play.outcome === "stopped" ? "warn" : "fail", text: playSummary(play) };
  }

  private renderSlots(): void {
    clear(this.slotList);
    for (const slot of SLOTS) {
      const sample = this.slots[slot.id];
      if (sample) {
        this.slotList.appendChild(this.row("slot:" + slot.id, slot.label, sample.title, fileLabel(sample), this.resultFor(sample.key), sample.poster, () => this.play(sample)));
      } else {
        this.slotList.appendChild(this.row("slot:" + slot.id, slot.label, this.state.samples ? "None found" : "Press Find test videos", "", null, "", null));
      }
    }
    if (this.moreAvi.length > 0) {
      // One AVI failing may be that file; a few more tell whether AVI works at all.
      this.slotList.appendChild(h("div", { class: "section-title", text: "More AVI files to try" }));
      for (const sample of this.moreAvi) {
        this.slotList.appendChild(this.row("avi:" + sample.id, "AVI", sample.title, "", this.resultFor(sample.key), sample.poster, () => this.play(sample)));
      }
    }
    const s = this.state.samples;
    setText(
      this.extLine,
      s
        ? "Containers seen: " +
            Object.keys(s.extCounts)
              .sort((a, b) => s.extCounts[b] - s.extCounts[a])
              .map((ext) => ext.toUpperCase() + " " + s.extCounts[ext])
              .join(" · ")
        : "",
    );
    this.refocus();
  }

  private renderPlays(): void {
    clear(this.playList);
    if (this.state.plays.length === 0) {
      this.playList.appendChild(h("div", { class: "card-note", text: "Nothing yet." }));
    }
    for (const play of this.state.plays) {
      const sample: Sample = {
        key: play.key,
        kind: play.key.indexOf("e:") === 0 ? "episode" : "movie",
        id: play.key.slice(2),
        title: play.title,
        ext: play.ext,
        poster: "",
        videoCodec: play.videoCodec,
        videoProfile: play.videoProfile,
        audioCodec: play.audioCodec,
        width: play.width,
      };
      this.playList.appendChild(
        this.row(
          "play:" + play.key + ":" + play.at,
          play.player === "html5" ? "Desktop player" : "AVPlay",
          play.title,
          fileLabel(play) + (play.tracks ? " · " + play.tracks : ""),
          { outcome: play.outcome === "played" ? "ok" : play.outcome === "stopped" ? "warn" : "fail", text: playSummary(play) },
          "",
          () => this.play(sample),
        ),
      );
    }
    this.refocus();
  }

  private play(sample: Sample): void {
    const creds = loadCreds();
    if (!creds) return;
    const test = new PlayTest(this.host, sample, this.urlFor(creds, sample), (result) => {
      this.state.plays = [result].concat(this.state.plays.filter((p) => !(p.key === result.key && p.outcome === "stopped"))).slice(0, MAX_PLAYS);
      this.saveState();
      setKeyTarget(this);
      this.renderSlots();
      this.renderPlays();
      this.renderEpisodes();
      this.renderReport();
    });
    setKeyTarget(test);
    test.start();
  }

  // --- Title search ----------------------------------------------------------------

  private runSearch(query: string): void {
    if (query === "" || this.busy.search) return;
    const creds = this.needCreds(this.searchProgress);
    if (!creds) return;
    this.busy.search = true;
    const progress = (text: string) => setText(this.searchProgress, text);
    let found: ListItem[] = [];
    loadLibrary(creds, "series", progress)
      .then((series) => {
        found = matchTitles(series, query, 6);
        this.showResults(found);
        return loadLibrary(creds, "movie", progress);
      })
      .then((movies) => {
        found = found.concat(matchTitles(movies, query, 6));
        this.showResults(found);
        this.state.library = libraryStats.slice();
        this.renderReport();
        progress(found.length === 0 ? "Nothing matches “" + query + "”." : found.length + " matches.");
      })
      .catch((err: Error) => progress(redact(err.message)))
      .then(() => {
        this.busy.search = false;
      });
  }

  private showResults(items: ListItem[]): void {
    clear(this.searchList);
    for (const item of items) {
      const kind = item.kind === "series" ? "Series" : "Movie" + (item.ext ? " · " + item.ext.toUpperCase() : "");
      this.searchList.appendChild(this.row("result:" + item.kind + ":" + item.id, kind, item.name, "", null, item.poster, () => this.openResult(item)));
    }
    this.refocus();
  }

  private openResult(item: ListItem): void {
    const creds = loadCreds();
    if (!creds) return;
    if (item.kind === "movie") {
      setText(this.searchProgress, "Reading " + item.name + "…");
      getJson(apiUrl(creds, "get_vod_info", { vod_id: item.id })).then((res) => {
        const info = res.ok ? parseVodInfo(res.data) : null;
        setText(this.searchProgress, res.ok ? "" : redact(res.error));
        this.play({
          key: "m:" + item.id,
          kind: "movie",
          id: item.id,
          title: item.name,
          ext: ((info && info.ext) || item.ext || "mp4").toLowerCase(),
          poster: item.poster,
          videoCodec: info ? info.videoCodec : "",
          videoProfile: info ? info.videoProfile : "",
          audioCodec: info ? info.audioCodec : "",
          width: info ? info.width : 0,
        });
      });
      return;
    }
    setText(this.searchProgress, "Reading episodes of " + item.name + "…");
    getJson(apiUrl(creds, "get_series_info", { series_id: item.id })).then((res) => {
      if (!res.ok) {
        setText(this.searchProgress, redact(res.error));
        return;
      }
      const parsed = parseSeriesInfo(res.data);
      const firstRegular = parsed.seasons.findIndex((s) => s.seasonNo > 0);
      this.series = { id: item.id, name: item.name, seasons: parsed.seasons, seasonIndex: Math.max(0, firstRegular) };
      setText(this.searchProgress, parsed.seasons.length === 0 ? "No episodes listed for " + item.name + "." : "");
      this.renderEpisodes();
      const first = this.episodeBox.querySelector(".sample-row.focusable") as HTMLElement | null;
      if (first) this.focus(first);
    });
  }

  private renderEpisodes(): void {
    clear(this.episodeBox);
    const series = this.series;
    if (!series || series.seasons.length === 0) return;
    this.episodeBox.appendChild(h("div", { class: "section-title", text: series.name }));
    series.seasons.forEach((season, i) => {
      const pill = this.pill(season.title, "season:" + season.seasonNo, () => {
        series.seasonIndex = i;
        this.renderEpisodes();
      });
      toggle(pill, "is-selected", i === series.seasonIndex);
      this.episodeBox.appendChild(pill);
    });
    const season = series.seasons[series.seasonIndex];
    for (const ep of season.episodes.slice(0, 30)) {
      const sample: Sample = {
        key: "e:" + ep.id,
        kind: "episode",
        id: ep.id,
        title: series.name + " " + episodeCode(ep.seasonNo, ep.episodeNo) + " " + ep.title,
        ext: (ep.ext || "mp4").toLowerCase(),
        poster: ep.still,
        videoCodec: ep.videoCodec,
        videoProfile: ep.videoProfile,
        audioCodec: ep.audioCodec,
        width: ep.width,
      };
      this.episodeBox.appendChild(
        this.row("ep:" + ep.id, episodeCode(ep.seasonNo, ep.episodeNo), ep.title, fileLabel(sample), this.resultFor(sample.key), "", () => this.play(sample)),
      );
    }
    this.refocus();
  }

  // --- This TV, report and log -----------------------------------------------------

  private renderDevice(d: DeviceInfo): void {
    const model = d.realModel || d.model || d.modelCode;
    const year = describeModelYear(model);
    const info = (label: string, value: string) =>
      h("div", { class: "info-row" }, [h("div", { class: "info-label", text: label }), h("div", { class: "info-value", text: value || "–" })]);
    clear(this.tvCard);
    append(this.tvCard, [
      h("h2", { class: "card-title", text: "This TV" }),
      info("Web engine", d.chromium ? "Chromium " + d.chromium : d.userAgent),
      info("Tizen", [d.platformVersion, d.tizenFromUa && d.tizenFromUa !== d.platformVersion ? "(user agent says " + d.tizenFromUa + ")" : ""].filter((v) => v).join(" ")),
      info("Model", [d.realModel, d.model, d.modelCode].filter((v, i, all) => v && all.indexOf(v) === i).join(" · ")),
      info("Firmware", d.firmware),
      info("Screen", d.window + (d.display ? " · display " + d.display : "") + (d.uhdPanel ? " · 4K panel " + d.uhdPanel : "")),
      info("Player", d.avplayVersion ? "AVPlay " + d.avplayVersion : "HTML5 video (desktop harness)"),
      year ? h("div", { class: "info-row info-hint", text: year }) : null,
      !model ? h("div", { class: "info-row info-hint", text: "Running in a desktop browser. On the TV this shows the model code and engine." }) : null,
    ]);
  }

  private showLog(): void {
    this.logList = h("div");
    this.openModal(h("div", { class: "log-card" }, [h("h2", { class: "card-title", text: "Log (newest last) · Back to close" }), this.logList]), () => {
      this.logList = null;
    });
    this.renderLog();
  }

  private renderReport(): void {
    clear(this.reportList);
    for (const line of reportLines(this.state)) {
      this.reportList.appendChild(
        h("div", { class: "report-line" }, [
          h("span", { class: "dot dot-" + line.outcome }),
          h("span", { class: "report-label", text: line.label }),
          h("span", { class: "report-text", text: redact(line.text) }),
        ]),
      );
    }
  }

  private logPending = false;

  private renderLog(): void {
    if (this.logPending || !this.logList) return;
    this.logPending = true;
    window.requestAnimationFrame(() => {
      this.logPending = false;
      const list = this.logList;
      if (!list) return;
      clear(list);
      for (const line of logLines().slice(-30)) {
        const time = new Date(line.at);
        const stamp = ("0" + time.getHours()).slice(-2) + ":" + ("0" + time.getMinutes()).slice(-2) + ":" + ("0" + time.getSeconds()).slice(-2);
        list.appendChild(h("div", { class: "log-line" + (line.level === "error" ? " is-error" : ""), text: stamp + "  " + redact(line.text) }));
      }
    });
  }

  private clearResults(): void {
    this.state = { device: this.state.device, xtream: null, range: null, echo: null, os: null, samples: null, library: [], plays: [] };
    this.slots = {};
    this.moreAvi = [];
    this.series = null;
    writeJson("probe", "slots", {});
    writeJson("probe", "moreAvi", []);
    this.saveState();
    setText(this.findProgress, "");
    clear(this.searchList);
    this.renderXtream();
    this.renderOs();
    this.renderSlots();
    this.renderEpisodes();
    this.renderPlays();
    this.renderReport();
  }
}
