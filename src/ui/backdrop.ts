// The big picture behind the hero and the details page: right-aligned, fading into the
// background on the left and bottom. A new picture is loaded first and only then
// cross-faded in (500 ms), so the screen never shows a half-loaded image.
//
// The moving banner (the Roku app's Slides.brs, after Netflix's): resting on a title with
// more than one backdrop, they take turns every 7 seconds, cross-fading over 1.4 s, each
// slowly zooming in to 106 % (a little longer than it shows). It starts once the details
// are in, stops when the picture changes for another title, and waits while another
// screen is on top. The pictures come from the image hosts, not the provider's video
// connection.

import { h } from "./dom";

const SLIDE_MS = 7000;

export class Backdrop {
  readonly el: HTMLElement;
  private layers: HTMLImageElement[];
  private front = 0;
  private current = "";
  private wanted = "";
  private opacity = 1;
  private pictures: string[] = [];
  private index = 0;
  private timer = 0;
  private paused = false;

  constructor() {
    this.layers = [0, 1].map(() => h("img", { class: "backdrop-img", attrs: { alt: "" } }));
    this.el = h("div", { class: "backdrop" }, [this.layers[0], this.layers[1], h("div", { class: "backdrop-shade" })]);
  }

  // `opacity` below 1 dims a stand-in (a poster when there is no backdrop). A different
  // picture stops the slideshow; the same one leaves it running.
  show(url: string, opacity: number): void {
    if (url !== this.current && this.pictures.indexOf(url) < 0) this.stopSlides();
    this.wanted = url;
    this.opacity = opacity;
    if (url === this.current) {
      if (url) this.layers[this.front].style.opacity = String(opacity);
      return;
    }
    if (!url) {
      this.layers[this.front].style.opacity = "0";
      this.current = "";
      return;
    }
    this.load(url, false);
  }

  // Starts `pictures` (a title's backdrops; the first is the one showing, or about to)
  // taking turns. Fewer than two, nothing happens.
  slides(pictures: string[]): void {
    if (pictures.length < 2 || pictures.join("\n") === this.pictures.join("\n")) return;
    this.stopSlides();
    this.pictures = pictures.slice();
    this.index = 0;
    // The first picture zooms in slowly while it shows.
    if (this.current === pictures[0]) this.zoom(this.layers[this.front]);
    this.schedule();
  }

  // Waits while another screen is on top; picks up again when it's gone.
  pause(on: boolean): void {
    this.paused = on;
    if (on) window.clearTimeout(this.timer);
    else if (this.pictures.length > 1) this.schedule();
  }

  private stopSlides(): void {
    window.clearTimeout(this.timer);
    this.pictures = [];
    for (const layer of this.layers) {
      layer.classList.remove("is-slide");
      layer.style.transform = "";
    }
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (this.paused) return;
    this.timer = window.setTimeout(() => {
      if (this.pictures.length < 2 || this.paused) return;
      this.index = (this.index + 1) % this.pictures.length;
      this.wanted = this.pictures[this.index];
      this.load(this.wanted, true);
      this.schedule();
    }, SLIDE_MS);
  }

  private load(url: string, slide: boolean): void {
    const probe = new Image();
    probe.onload = () => {
      if (this.wanted !== url) return;
      const back = this.layers[1 - this.front];
      back.classList.toggle("is-slide", slide);
      back.style.transform = "";
      back.src = url;
      back.style.opacity = String(this.opacity);
      const old = this.layers[this.front];
      old.classList.toggle("is-slide", slide);
      old.style.opacity = "0";
      this.front = 1 - this.front;
      this.current = url;
      // The first picture zooms too, when the slideshow started while it was loading.
      if (slide || (this.pictures.length > 1 && this.pictures[0] === url)) this.zoom(back);
    };
    probe.src = url;
  }

  // A slow push in, a little longer than the picture shows.
  private zoom(layer: HTMLImageElement): void {
    layer.classList.add("is-slide");
    layer.style.transform = "scale(1)";
    void layer.offsetWidth;
    layer.style.transform = "scale(1.06)";
  }
}
