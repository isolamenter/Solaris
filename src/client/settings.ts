/**
 * The Server address this device talks to — the one environment value the client
 * cannot derive. A packaged desktop build loads its bundle from the shell's own
 * app-local scheme, so the address is configuration, not a page origin.
 *
 * The address is not a secret: the Solaris token stays in the OS secure store
 * behind `LocalStore` (`session.ts` is its only writer). It is kept in the
 * shell's own key/value storage, in its normalized form, so the value compared
 * against a `LocalScope` origin can never disagree about case, a trailing slash
 * or a default port.
 */

import { normalizeServerOrigin } from "./local/scope.js";

/** The slice of `Storage` this module needs, injected so it can be tested. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const serverOriginKey = "solaris.server-origin";

export type ServerSettings = {
  /** The configured Server origin, or null when this device has none. */
  read(): string | null;
  /** Stores an absolute Server origin; throws when the input is not one. */
  write(origin: string): void;
  /** Forgets the configured origin, so the build's own default applies again. */
  clear(): void;
};

export function createServerSettings(storage: KeyValueStore): ServerSettings {
  return {
    read(): string | null {
      const stored = storage.getItem(serverOriginKey);
      // A stored value that is no longer a Server origin is reported, never
      // repaired in place: the setting screen shows it and the user decides.
      return stored === null ? null : normalizeServerOrigin(stored);
    },
    write(origin: string): void {
      storage.setItem(serverOriginKey, normalizeServerOrigin(origin));
    },
    clear(): void {
      storage.removeItem(serverOriginKey);
    },
  };
}

/** True inside the Tauri webview, which injects this object before the bundle runs. */
export function isDesktopShell(target: object): boolean {
  return "__TAURI_INTERNALS__" in target;
}

/**
 * The address this build assumes when the device has none configured, or null
 * when it has no default and the address must be entered.
 *
 * The browser build is served by the Server itself, so the page origin is the
 * Server origin — a development convenience, and the shell labels it as one. The
 * packaged desktop shell loads the same bundle from an app-local scheme that is
 * never a Server origin, so a desktop build always asks for the address.
 */
export function developmentServerOrigin(pageOrigin: string, desktopShell: boolean): string | null {
  if (desktopShell) return null;
  try {
    return normalizeServerOrigin(pageOrigin);
  } catch {
    return null;
  }
}
