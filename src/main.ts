// ARAN+ for Samsung Tizen TVs. M0: boots straight into the setup checks screen.

import "./styles/app.css";
import { log, logError } from "./core/log";
import { registerKeys } from "./platform/keys";
import { getPlayer } from "./platform/players";
import { ProbeScreen } from "./probe/probe";
import { startKeys } from "./ui/focus";

function boot(): void {
  log("ARAN+ " + __APP_VERSION__ + " starting");
  window.addEventListener("error", (event) => logError("uncaught:", event.message, event.filename + ":" + event.lineno));
  window.addEventListener("unhandledrejection", (event) => logError("unhandled rejection:", String(event.reason)));

  registerKeys();
  startKeys();

  // AVPlay must let go of the decoder while the app is in the background.
  document.addEventListener("visibilitychange", () => {
    const player = getPlayer();
    try {
      if (document.hidden) player.suspend();
      else player.restore();
    } catch (err) {
      logError("suspend/restore failed:", err);
    }
  });

  // Desktop browsers draw a "plugin not supported" box for AVPlay's <object>.
  const avPlayer = document.getElementById("av-player");
  if (!window.webapis && avPlayer && avPlayer.parentNode) avPlayer.parentNode.removeChild(avPlayer);

  const app = document.getElementById("app");
  if (!app) return;
  new ProbeScreen(app).mount();
}

boot();
