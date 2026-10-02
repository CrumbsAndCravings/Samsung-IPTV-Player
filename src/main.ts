// ARAN+ for Samsung Tizen TVs. Boots into Home when a login is saved, otherwise into
// sign-in. The M0 setup checks stay reachable from the account menu.

import "./styles/app.css";
import { App } from "./app";
import { log, logError } from "./core/log";
import { applyBuiltInLogin, builtInCreds } from "./core/personal";
import { loadCreds } from "./core/storage";
import { registerKeys } from "./platform/keys";
import { getPlayer } from "./platform/players";
import { HomeScreen } from "./screens/home";
import { LoginScreen } from "./screens/login";
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

  const root = document.getElementById("app");
  if (!root) return;
  const app = new App(root);
  app.onSignedIn = (creds) => {
    app.useCreds(creds);
    app.resetTo(new HomeScreen(app));
  };
  app.onSignedOut = () => app.resetTo(new LoginScreen(app));

  // A personal build whose login changed replaces the saved one (and Continue Watching).
  if (applyBuiltInLogin()) log("personal build: using its login");
  const creds = loadCreds();
  if (creds) app.onSignedIn(creds);
  // With no saved login, a personal build signs in by itself.
  else app.resetTo(new LoginScreen(app, builtInCreds() !== null));
}

boot();
