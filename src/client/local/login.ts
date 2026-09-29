/**
 * `DesktopLogin` — the client half of CONTRACTS §2.3.
 *
 * The listener and the browser belong to the native layer; the state, the S256
 * verifier and the callback validation belong here. The verifier is created in
 * this closure, handed straight back to the caller, and passed to no other
 * function: it is never written to a record, never logged, and never reaches the
 * native side.
 *
 * A timeout or an abort closes the listener, so an abandoned attempt does not
 * leave a port open.
 */

import type { DesktopLogin } from "../../shared/local.js";
import type { LocalBackend } from "./backend.js";
import { parseLoopbackCallback } from "./callback.js";
import { buildAuthorizationUrl, createLoginAttempt } from "./pkce.js";

/** Default lifetime of one authorization attempt. */
export const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export function createDesktopLogin(
  backend: LocalBackend,
  options: { timeoutMs?: number } = {},
): DesktopLogin {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  return {
    async authorize({ authorizationEndpoint, signal }) {
      const aborted = (): boolean => signal?.aborted === true;
      if (aborted()) throw new Error("The desktop login was cancelled before it started");

      const attempt = await createLoginAttempt();
      const { redirectUri } = await backend.beginLogin({ timeoutMs });
      const cancel = () => {
        void backend.cancelLogin();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        // The signal may have fired while the listener was being bound.
        if (aborted()) throw new Error("The desktop login was cancelled");
        await backend.openExternalUrl(
          buildAuthorizationUrl({
            authorizationEndpoint,
            redirectUri,
            state: attempt.state,
            codeChallenge: attempt.codeChallenge,
          }),
        );
        const callback = await backend.awaitLoginCallback();
        return {
          code: parseLoopbackCallback({
            requestTarget: callback.requestTarget,
            redirectUri,
            expectedState: attempt.state,
          }),
          codeVerifier: attempt.codeVerifier,
        };
      } catch (error) {
        // The listener is closed on every failure path, including a rejected
        // callback, so a half-finished attempt cannot be answered later.
        await backend.cancelLogin();
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
