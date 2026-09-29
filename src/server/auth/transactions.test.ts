import { describe, expect, it } from "vitest";
import { InMemoryAuthTransactionStore } from "./transactions.js";

const CLIENT_STATE = "client-state-1";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://127.0.0.1:8765/callback";

function store(options: { clock?: () => number; maxTransactions?: number; maxCodes?: number } = {}) {
  return new InMemoryAuthTransactionStore(options);
}

describe("login transactions", () => {
  it("binds the client state, challenge and redirect URI to a separate upstream state", () => {
    const transactions = store();
    const login = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(login.clientState).toBe(CLIENT_STATE);
    expect(login.clientChallenge).toBe(CHALLENGE);
    expect(login.redirectUri).toBe(REDIRECT);
    expect(login.upstreamState).not.toBe(CLIENT_STATE);
    expect(login.upstreamState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(login.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("gives every attempt a fresh upstream state and id", () => {
    const transactions = store();
    const first = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const second = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(second.upstreamState).not.toBe(first.upstreamState);
    expect(second.id).not.toBe(first.id);
  });

  it("consumes a transaction exactly once", () => {
    const transactions = store();
    const login = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(transactions.consumeByUpstreamState(login.upstreamState)?.id).toBe(login.id);
    expect(transactions.consumeByUpstreamState(login.upstreamState)).toBeNull();
  });

  it("does not resolve an unknown, discarded or client state", () => {
    const transactions = store();
    const login = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(transactions.consumeByUpstreamState("never-issued")).toBeNull();
    // The client state is not a lookup key.
    expect(transactions.consumeByUpstreamState(CLIENT_STATE)).toBeNull();
    transactions.discard(login.id);
    expect(transactions.consumeByUpstreamState(login.upstreamState)).toBeNull();
  });

  it("expires an unconsumed transaction and code by TTL", () => {
    let now = Date.parse("2026-09-29T10:00:00.000Z");
    const transactions = store({ clock: () => now });
    const login = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const { code } = transactions.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    // Still inside both TTLs, but only the login has been spent.
    now += 61_000;
    expect(transactions.consumeByUpstreamState(login.upstreamState)?.id).toBe(login.id);
    expect(transactions.consumeCode(code)).toBeNull();

    const late = transactions.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const lateCode = transactions.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    now += 5 * 60_000;
    expect(transactions.consumeByUpstreamState(late.upstreamState)).toBeNull();
    expect(transactions.consumeCode(lateCode.code)).toBeNull();
  });

  it("stays bounded: expired entries go first, then the oldest", () => {
    let now = 0;
    const transactions = store({ clock: () => now, maxTransactions: 2, maxCodes: 1 });
    const first = transactions.begin({ clientState: "a", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    now = 1;
    const second = transactions.begin({ clientState: "b", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    now = 2;
    const third = transactions.begin({ clientState: "c", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(transactions.consumeByUpstreamState(first.upstreamState)).toBeNull();
    expect(transactions.consumeByUpstreamState(second.upstreamState)?.id).toBe(second.id);
    expect(transactions.consumeByUpstreamState(third.upstreamState)?.id).toBe(third.id);

    now = 3;
    const firstCode = transactions.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const secondCode = transactions.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(transactions.consumeCode(firstCode.code)).toBeNull();
    expect(transactions.consumeCode(secondCode.code)).not.toBeNull();
  });

  it("issues a one-time code bound to the same challenge and redirect URI", () => {
    const transactions = store();
    const { code, expiresAt } = transactions.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(transactions.consumeCode(code)).toEqual({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT, expiresAt });
    expect(transactions.consumeCode(code)).toBeNull();
    expect(transactions.consumeCode("never-issued")).toBeNull();
  });

  it("keeps nothing across a restart", () => {
    // No database and no file: a new process starts with an empty store, so a
    // half-finished login is simply lost and cannot be replayed.
    const before = store();
    const login = before.begin({ clientState: CLIENT_STATE, clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const { code } = before.issueCode({ userId: "user-1", clientChallenge: CHALLENGE, redirectUri: REDIRECT });
    const after = store();
    expect(after.consumeByUpstreamState(login.upstreamState)).toBeNull();
    expect(after.consumeCode(code)).toBeNull();
  });
});
