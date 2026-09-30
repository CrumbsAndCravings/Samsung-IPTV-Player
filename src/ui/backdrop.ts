// The big picture behind the hero and the details page: right-aligned, fading into the
// background on the left and bottom. A new picture is loaded first and only then
// cross-faded in (500 ms), so the screen never shows a half-loaded image.

import { h } from "./dom";

export class Backdrop {
  readonly el: HTMLElement;
  private layers: HTMLImageElement[];
  private front = 0;
  private current = "";
  private wanted = "";

  constructor() {
    this.layers = [0, 1].map(() => h("img", { class: "backdrop-img", attrs: { alt: "" } }));
    this.el = h("div", { class: "backdrop" }, [this.layers[0], this.layers[1], h("div", { class: "backdrop-shade" })]);
  }

  // `opacity` below 1 dims a stand-in (a poster when there is no backdrop).
  show(url: string, opacity: number): void {
    this.wanted = url;
    if (url === this.current) {
      if (url) this.layers[this.front].style.opacity = String(opacity);
      return;
    }
    if (!url) {
      this.layers[this.front].style.opacity = "0";
      this.current = "";
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      if (this.wanted !== url) return;
      const back = this.layers[1 - this.front];
      back.src = url;
      back.style.opacity = String(opacity);
      this.layers[this.front].style.opacity = "0";
      this.front = 1 - this.front;
      this.current = url;
    };
    probe.src = url;
  }
}
