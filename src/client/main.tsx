import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDesktopLogin, createLocalStore } from "./local/index.js";
import type { AppDependencies } from "./session.js";
import { createServerSettings, developmentServerOrigin, isDesktopShell } from "./settings.js";
import "./styles.css";

const deps: AppDependencies = {
  // The account-scoped on-disk store and the native loopback + PKCE login are
  // task B06's client-local layer; nothing is stubbed in this build.
  localStore: createLocalStore(),
  desktopLogin: createDesktopLogin(),
  settings: createServerSettings(window.localStorage),
  // The Server address is configured, not derived. The browser build is served
  // by the Server itself, so its page origin is only a development default; the
  // packaged desktop shell gets null here and asks for the address.
  defaultServerOrigin: developmentServerOrigin(window.location.origin, isDesktopShell(globalThis)),
};

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");
createRoot(container).render(
  <StrictMode>
    <App deps={deps} />
  </StrictMode>,
);
