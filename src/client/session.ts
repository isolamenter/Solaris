/**
 * Client wiring boundary.
 *
 * `App` receives every environment-specific dependency as a prop and implements
 * none of them:
 *
 * - `LocalStore` and `DesktopLogin` belong to task B06 (`src/client/local/`).
 * - `ServerSettings` keeps the one configured value the client cannot derive —
 *   the absolute Server address.
 *
 * The session is a credential (D3), so its persistence lives here and nowhere
 * else: `SessionProvider` is the only code that touches the stored token, and
 * the token is keyed by the normalized Server origin, so two Servers or two
 * accounts never share one.
 */

import type { DeploymentDto, SessionDto } from "../shared/contracts.js";
import type { DesktopLogin, LocalStore } from "../shared/local.js";
import type { SolarisApi } from "./api.js";
import type { ServerSettings } from "./settings.js";

export interface SessionProvider {
  /**
   * Reads the session this Server stored for the device. Called once, before the
   * shell renders anything that needs a token.
   */
  restore(): Promise<SessionDto | null>;
  /**
   * Persists the active session of this Server; `null` forgets the stored token.
   * Resolves only once the secure store accepted the change, so a session is
   * never treated as active while the stored one is something else.
   */
  persist(session: SessionDto | null): Promise<void>;
}

export function createSessionProvider(input: { localStore: LocalStore; serverOrigin: string }): SessionProvider {
  const { localStore, serverOrigin } = input;
  return {
    restore: () => localStore.readSession(serverOrigin),
    async persist(session) {
      if (session === null) await localStore.clearSession(serverOrigin);
      else await localStore.writeSession(serverOrigin, session);
    },
  };
}

export type AppDependencies = {
  /** B06 owns the account-scoped store. */
  localStore: LocalStore;
  /** B06 owns the native loopback + PKCE listener. */
  desktopLogin: DesktopLogin;
  /** Where this device keeps the configured Server address. */
  settings: ServerSettings;
  /**
   * Absolute Server base URL assumed when the device has none configured, or
   * null when the build has no default and one must be entered. A default exists
   * for development only; the shell says so when it applies.
   */
  defaultServerOrigin: string | null;
};

/** Shared manual/startup login; the native store remains the only token store. */
export async function signInSession(login: DesktopLogin, api: SolarisApi, deployment: DeploymentDto, signal?: AbortSignal): Promise<SessionDto> {
  const authorizationEndpoint = new URL(deployment.auth.authorizationEndpoint, api.origin).toString();
  const { code, codeVerifier } = await login.authorize({ authorizationEndpoint, signal });
  return api.exchangeDesktopCode({ code, codeVerifier });
}
