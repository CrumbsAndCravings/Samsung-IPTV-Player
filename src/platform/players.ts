import { AvPlayer } from "./avplay";
import { Html5Player } from "./html5";
import type { Player } from "./player";

let shared: Player | null = null;

// AVPlay on the TV, <video> on a desktop. One player for the whole app.
export function getPlayer(): Player {
  if (!shared) shared = window.webapis && window.webapis.avplay ? new AvPlayer(window.webapis.avplay) : new Html5Player();
  return shared;
}
