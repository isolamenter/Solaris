import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDesktopLogin, createLocalStore } from "./local/index.js";
import type { AppDependencies } from "./session.js";
import { createServerSettings, developmentServerOrigin, isDesktopShell } from "./settings.js";
import "./styles.css";

declare const __SOLARIS_DEFAULT_SERVER__: string | null;

const deps: AppDependencies = {
  // File operations and session storage always use the real native backend.
  localStore: createLocalStore(),
  desktopLogin: createDesktopLogin(),
  settings: createServerSettings(window.localStorage),
  // Mock builds carry an explicit local Server default. Other desktop builds
  // ask for an address; the served browser page uses its development origin.
  defaultServerOrigin: __SOLARIS_DEFAULT_SERVER__ ?? developmentServerOrigin(window.location.origin, isDesktopShell(globalThis)),
};

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root container");
createRoot(container).render(
  <StrictMode>
    <App deps={deps} />
  </StrictMode>,
);
