/**
 * Loopback callback validation — CONTRACTS §2.3 steps 1, 2 and 6.
 *
 * The native listener hands back the raw request target it received. Everything
 * that decides whether the callback is acceptable happens here: the path must be
 * exactly `/callback`, the host must be the loopback address the listener bound,
 * the port must be the one the listener got, and the Client state must match the
 * value minted for this attempt. Without the state check the code could be
 * planted by any local process that can reach the port.
 */

export type LoopbackRedirect = {
  port: number;
  /** Canonical `http://127.0.0.1:<port>/callback`. */
  url: string;
};

const CALLBACK_PATH = "/callback";
const CALLBACK_HOST = "127.0.0.1";

/** Validate and canonicalize the redirect URI the listener reported. */
export function parseLoopbackRedirectUri(value: string): LoopbackRedirect {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The desktop listener reported an unusable redirect URI: ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`The desktop redirect URI must use http, received ${parsed.protocol}`);
  }
  if (parsed.hostname !== CALLBACK_HOST) {
    throw new Error(`The desktop redirect URI must bind ${CALLBACK_HOST}, received ${parsed.hostname}`);
  }
  if (parsed.pathname !== CALLBACK_PATH) {
    throw new Error(`The desktop redirect URI must use ${CALLBACK_PATH}, received ${parsed.pathname}`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("The desktop redirect URI must carry the random listener port");
  }
  return { port, url: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}` };
}

/**
 * The authorization code from one callback request.
 *
 * Throws when the callback is not for this attempt, is not the exact callback
 * path, or reports a failure.
 */
export function parseLoopbackCallback(input: {
  requestTarget: string;
  redirectUri: string;
  expectedState: string;
}): string {
  const redirect = parseLoopbackRedirectUri(input.redirectUri);
  if (!input.requestTarget.startsWith("/")) {
    throw new Error("The desktop callback target must be an absolute path");
  }
  const callback = new URL(input.requestTarget, redirect.url);
  if (callback.origin !== `http://${CALLBACK_HOST}:${redirect.port}`) {
    throw new Error("The desktop callback did not arrive on the listener this attempt opened");
  }
  if (callback.pathname !== CALLBACK_PATH) {
    throw new Error(`The desktop callback must use ${CALLBACK_PATH}, received ${callback.pathname}`);
  }
  const error = callback.searchParams.get("error");
  if (error !== null) {
    throw new Error(`The Server refused the authorization: ${error}`);
  }
  const state = callback.searchParams.get("state");
  if (state === null || state !== input.expectedState) {
    throw new Error("The desktop callback did not carry the state this attempt created");
  }
  const code = callback.searchParams.get("code");
  if (code === null || code === "") {
    throw new Error("The desktop callback did not carry an authorization code");
  }
  return code;
}
