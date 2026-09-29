import { describe, expect, it } from "vitest";
import type { LocalBackend } from "./backend.js";
import { createDesktopLogin } from "./login.js";

const ENDPOINT = "http://127.0.0.1:3210/api/auth/desktop/authorize";
const REDIRECT = "http://127.0.0.1:53124/callback";

type Call = { command: string; args: unknown[] };

/**
 * Native stand-in: the listener reports the redirect URI it bound, then the
 * callback request target it received. The test builds that target from the state
 * it observed, exactly as the Server would echo it back.
 */
function createFakeBackend(
  callbackFor: (stateFromUrl: string) => string,
  options: { timeout?: boolean; onOpen?: () => void } = {},
) {
  const calls: Call[] = [];
  let opened = "";
  let cancelled = false;
  let rejectCallback: ((error: Error) => void) | null = null;

  const backend: LocalBackend = {
    async beginLogin(input) {
      calls.push({ command: "beginLogin", args: [input] });
      return { redirectUri: REDIRECT };
    },
    awaitLoginCallback() {
      if (options.timeout === true) {
        return Promise.reject(new Error("desktop login timed out"));
      }
      if (cancelled) {
        return Promise.reject(new Error("desktop login was cancelled"));
      }
      const state = new URL(opened).searchParams.get("state") ?? "";
      return new Promise<{ requestTarget: string }>((resolve, reject) => {
        rejectCallback = reject;
        resolve({ requestTarget: callbackFor(state) });
      });
    },
    async cancelLogin() {
      cancelled = true;
      calls.push({ command: "cancelLogin", args: [] });
      rejectCallback?.(new Error("desktop login was cancelled"));
    },
    async openExternalUrl(url) {
      opened = url;
      calls.push({ command: "openExternalUrl", args: [url] });
      options.onOpen?.();
    },
    // Unused by the login flow.
    async readSession() {
      throw new Error("not used");
    },
    async writeSession() {
      throw new Error("not used");
    },
    async clearSession() {
      throw new Error("not used");
    },
    async listRecords() {
      throw new Error("not used");
    },
    async readRecord() {
      throw new Error("not used");
    },
    async writeRecord() {
      throw new Error("not used");
    },
    async deleteRecord() {
      throw new Error("not used");
    },
    async chooseReferenceFiles() {
      throw new Error("not used");
    },
    async readReferenceFile() {
      throw new Error("not used");
    },
    async chooseSaveDirectory() {
      throw new Error("not used");
    },
    async saveImage() {
      throw new Error("not used");
    },
    async imageExists() {
      throw new Error("not used");
    },
    async readSavedImage() {
      throw new Error("not used");
    },
    async revealInFileManager() {
      throw new Error("not used");
    },
  };

  return { backend, calls, isCancelled: () => cancelled, openedUrl: () => opened };
}

describe("desktop login", () => {
  it("returns the code of a matching callback and the verifier of that attempt", async () => {
    const fake = createFakeBackend((state) => `/callback?code=code-123&state=${state}`);
    const login = createDesktopLogin(fake.backend);

    const result = await login.authorize({ authorizationEndpoint: ENDPOINT });

    expect(result.code).toBe("code-123");
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);

    const url = new URL(fake.openedUrl());
    expect(url.origin).toBe("http://127.0.0.1:3210");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).not.toBe("");
    expect(fake.calls.filter((call) => call.command === "cancelLogin")).toEqual([]);
  });

  it("sends the challenge of the verifier it hands back", async () => {
    const fake = createFakeBackend((state) => `/callback?code=code-123&state=${state}`);
    const login = createDesktopLogin(fake.backend);

    const result = await login.authorize({ authorizationEndpoint: ENDPOINT });
    const { s256Challenge } = await import("./pkce.js");
    expect(new URL(fake.openedUrl()).searchParams.get("code_challenge")).toBe(
      await s256Challenge(result.codeVerifier),
    );
  });

  it("refuses a callback that does not carry this attempt's state", async () => {
    const fake = createFakeBackend(() => "/callback?code=planted&state=someone-elses-state");
    const login = createDesktopLogin(fake.backend);

    await expect(login.authorize({ authorizationEndpoint: ENDPOINT })).rejects.toThrow(/state/);
    expect(fake.isCancelled()).toBe(true);
  });

  it("refuses a callback on another path", async () => {
    const fake = createFakeBackend((state) => `/callback/extra?code=code-123&state=${state}`);
    const login = createDesktopLogin(fake.backend);

    await expect(login.authorize({ authorizationEndpoint: ENDPOINT })).rejects.toThrow(/\/callback/);
    expect(fake.isCancelled()).toBe(true);
  });

  it("propagates a timeout and closes the listener", async () => {
    const fake = createFakeBackend(() => "/callback", { timeout: true });
    const login = createDesktopLogin(fake.backend, { timeoutMs: 1000 });

    await expect(login.authorize({ authorizationEndpoint: ENDPOINT })).rejects.toThrow(/timed out/);
    expect(fake.calls.filter((call) => call.command === "cancelLogin")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.command === "beginLogin")[0]?.args[0]).toEqual({ timeoutMs: 1000 });
  });

  it("does not start when the caller already aborted", async () => {
    const fake = createFakeBackend(() => "/callback");
    const login = createDesktopLogin(fake.backend);
    const controller = new AbortController();
    controller.abort();

    await expect(
      login.authorize({ authorizationEndpoint: ENDPOINT, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(fake.calls.filter((call) => call.command === "beginLogin")).toEqual([]);
  });

  it("closes the listener when the caller aborts while waiting", async () => {
    const controller = new AbortController();
    const fake = createFakeBackend((state) => `/callback?code=code-123&state=${state}`, {
      onOpen: () => controller.abort(),
    });
    const login = createDesktopLogin(fake.backend);

    await expect(
      login.authorize({ authorizationEndpoint: ENDPOINT, signal: controller.signal }),
    ).rejects.toThrow();
    // The abort reached the native layer, which closed the port instead of
    // leaving an attempt listening.
    expect(fake.isCancelled()).toBe(true);
  });

  it("never hands the verifier to the native layer", async () => {
    const fake = createFakeBackend((state) => `/callback?code=code-123&state=${state}`);
    const login = createDesktopLogin(fake.backend);

    const result = await login.authorize({ authorizationEndpoint: ENDPOINT });

    const seen = JSON.stringify(fake.calls);
    expect(seen).not.toContain(result.codeVerifier);
    expect(fake.openedUrl()).not.toContain(result.codeVerifier);
    // Nothing that reaches the device carries the verifier.
    expect(fake.calls.some((call) => call.command === "beginLogin")).toBe(true);
  });

  it("refuses an authorization endpoint it cannot open", async () => {
    const fake = createFakeBackend((state) => `/callback?code=code-123&state=${state}`);
    const login = createDesktopLogin(fake.backend);

    await expect(login.authorize({ authorizationEndpoint: "javascript:alert(1)" })).rejects.toThrow();
    expect(fake.calls.filter((call) => call.command === "openExternalUrl")).toEqual([]);
    expect(fake.isCancelled()).toBe(true);
  });
});
