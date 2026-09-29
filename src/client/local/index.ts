/**
 * Client-local layer — CONTRACTS §10. Owned by B06, consumed by B07.
 *
 * `createLocalStore()` and `createDesktopLogin()` are the two dependencies
 * `AppDependencies` expects. Both talk to the desktop shell through
 * `src-tauri/`; neither decides any local rule itself — that is `store.ts` and
 * `login.ts`, which are unit tested without a device.
 */

import type { DesktopLogin, LocalStore } from "../../shared/local.js";
import type { LocalBackend } from "./backend.js";
import { createDesktopLogin as createDesktopLoginOn } from "./login.js";
import { createLocalStore as createLocalStoreOn } from "./store.js";
import { createTauriBackend } from "./tauriBackend.js";

/** The account-scoped on-disk store of the desktop shell. */
export function createLocalStore(backend: LocalBackend = createTauriBackend()): LocalStore {
  return createLocalStoreOn(backend);
}

/** Loopback listener plus PKCE, driven by the desktop shell. */
export function createDesktopLogin(
  backend: LocalBackend = createTauriBackend(),
  options: { timeoutMs?: number } = {},
): DesktopLogin {
  return createDesktopLoginOn(backend, options);
}
