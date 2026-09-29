import { describe, expect, it, vi } from "vitest";
import type { SessionDto } from "../shared/contracts.js";
import type { LocalStore } from "../shared/local.js";
import { createSessionProvider } from "./session.js";

const originA = "http://127.0.0.1:3210";
const originB = "https://solaris.example.com";

function session(token: string, userId: string): SessionDto {
  return { token, expiresAt: "2026-09-30T00:00:00.000Z", user: { id: userId, displayName: null, createdAt: "2026-09-29T00:00:00.000Z" } };
}

/** Only the session half of `LocalStore` is exercised here; B06 tests the rest. */
function sessionStore(initial: Record<string, SessionDto> = {}) {
  const sessions = new Map(Object.entries(initial));
  const store = {
    readSession: async (serverOrigin: string) => sessions.get(serverOrigin) ?? null,
    writeSession: async (serverOrigin: string, value: SessionDto) => void sessions.set(serverOrigin, value),
    clearSession: async (serverOrigin: string) => void sessions.delete(serverOrigin),
  } as unknown as LocalStore;
  return { store, sessions };
}

describe("SessionProvider", () => {
  it("restores the session this Server stored, and only that one", async () => {
    const { store } = sessionStore({ [originA]: session("token-a", "user-a") });
    const provider = createSessionProvider({ localStore: store, serverOrigin: originA });

    expect(await provider.restore()).toEqual(session("token-a", "user-a"));
  });

  it("restores nothing for a Server that has no session on this device", async () => {
    const { store } = sessionStore({ [originA]: session("token-a", "user-a") });
    const provider = createSessionProvider({ localStore: store, serverOrigin: originB });

    expect(await provider.restore()).toBeNull();
  });

  it("stores the session under its own Server, leaving the other one alone", async () => {
    const { store, sessions } = sessionStore({ [originA]: session("token-a", "user-a") });
    const provider = createSessionProvider({ localStore: store, serverOrigin: originB });

    await provider.persist(session("token-b", "user-b"));

    expect(sessions.get(originA)).toEqual(session("token-a", "user-a"));
    expect(sessions.get(originB)).toEqual(session("token-b", "user-b"));
  });

  it("forgets only the current Server's token on sign-out", async () => {
    const { store, sessions } = sessionStore({
      [originA]: session("token-a", "user-a"),
      [originB]: session("token-b", "user-b"),
    });
    const provider = createSessionProvider({ localStore: store, serverOrigin: originB });

    await provider.persist(null);

    expect(sessions.has(originB)).toBe(false);
    expect(sessions.has(originA)).toBe(true);
  });

  it("does not resolve a persist that the secure store refused", async () => {
    const failure = new Error("keychain unavailable");
    const store = {
      writeSession: vi.fn().mockRejectedValue(failure),
      clearSession: vi.fn().mockRejectedValue(failure),
    } as unknown as LocalStore;
    const provider = createSessionProvider({ localStore: store, serverOrigin: originA });

    await expect(provider.persist(session("token-a", "user-a"))).rejects.toThrow(failure);
    await expect(provider.persist(null)).rejects.toThrow(failure);
  });
});
