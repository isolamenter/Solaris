import { randomBytes, randomUUID } from "node:crypto";
import type { AuthTransactionStore, IssuedAuthorizationCode, LoginTransaction } from "../interfaces.js";

/**
 * CONTRACTS §2.3: short-lived, bounded, in-memory only. Nothing here is
 * persisted, so a restart simply loses logins that were in progress — the user
 * signs in again, and no half-finished transaction can ever be replayed.
 */
export const LOGIN_TRANSACTION_TTL_MS = 5 * 60_000;
/** The code only has to survive one loopback redirect plus one token POST. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const MAX_LOGIN_TRANSACTIONS = 1_000;
export const MAX_AUTHORIZATION_CODES = 1_000;

export type AuthTransactionStoreConfig = {
  transactionTtlMs?: number;
  codeTtlMs?: number;
  maxTransactions?: number;
  maxCodes?: number;
  clock?: () => number;
};

/** 256 bits of randomness, URL-safe: unbounded guessing is not a threat model. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The two-stage desktop login state.
 *
 * Two independent state namespaces: the Client's `state` (echoed back on the
 * loopback redirect and never sent to the IdP) and the Server's upstream
 * `state` (sent to the IdP and consumed on the IdP callback). Neither can be
 * substituted for the other, and the adapter's PKCE verifier and nonce live in
 * the adapter, not here.
 *
 * Every entry is bounded by both a TTL and a maximum count; insertion evicts
 * expired entries first and then the oldest, so a flood of authorize requests
 * cannot grow the process unboundedly.
 */
export class InMemoryAuthTransactionStore implements AuthTransactionStore {
  private readonly transactions = new Map<string, LoginTransaction>();
  /** Upstream state -> transaction id. The upstream state is never a map key of its own. */
  private readonly upstreamStates = new Map<string, string>();
  private readonly codes = new Map<string, IssuedAuthorizationCode>();
  private readonly transactionTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly maxTransactions: number;
  private readonly maxCodes: number;
  private readonly clock: () => number;

  constructor(config: AuthTransactionStoreConfig = {}) {
    this.transactionTtlMs = config.transactionTtlMs ?? LOGIN_TRANSACTION_TTL_MS;
    this.codeTtlMs = config.codeTtlMs ?? AUTHORIZATION_CODE_TTL_MS;
    this.maxTransactions = config.maxTransactions ?? MAX_LOGIN_TRANSACTIONS;
    this.maxCodes = config.maxCodes ?? MAX_AUTHORIZATION_CODES;
    this.clock = config.clock ?? Date.now;
  }

  begin(input: { clientState: string; clientChallenge: string; redirectUri: string }): LoginTransaction {
    this.sweep();
    const transaction: LoginTransaction = {
      id: randomUUID(),
      clientState: input.clientState,
      clientChallenge: input.clientChallenge,
      redirectUri: input.redirectUri,
      upstreamState: randomToken(),
      expiresAt: new Date(this.clock() + this.transactionTtlMs).toISOString(),
    };
    this.transactions.set(transaction.id, transaction);
    this.upstreamStates.set(transaction.upstreamState, transaction.id);
    this.evict(this.transactions.keys(), this.maxTransactions, (id) => this.removeTransaction(id));
    return transaction;
  }

  consumeByUpstreamState(upstreamState: string): LoginTransaction | null {
    const id = this.upstreamStates.get(upstreamState);
    if (id === undefined) return null;
    // Look up and remove before any await: one callback can consume one
    // transaction, and a replay finds nothing.
    const transaction = this.transactions.get(id);
    this.removeTransaction(id);
    if (!transaction) return null;
    return this.expired(transaction.expiresAt) ? null : transaction;
  }

  discard(transactionId: string): void {
    this.removeTransaction(transactionId);
  }

  issueCode(input: { userId: string; clientChallenge: string; redirectUri: string }): { code: string; expiresAt: string } {
    this.sweep();
    const code = randomToken();
    const expiresAt = new Date(this.clock() + this.codeTtlMs).toISOString();
    this.codes.set(code, { userId: input.userId, clientChallenge: input.clientChallenge, redirectUri: input.redirectUri, expiresAt });
    this.evict(this.codes.keys(), this.maxCodes, (key) => this.codes.delete(key));
    return { code, expiresAt };
  }

  consumeCode(code: string): IssuedAuthorizationCode | null {
    const issued = this.codes.get(code);
    this.codes.delete(code);
    if (!issued) return null;
    return this.expired(issued.expiresAt) ? null : issued;
  }

  private expired(expiresAt: string): boolean {
    return !(Date.parse(expiresAt) > this.clock());
  }

  private removeTransaction(id: string): void {
    const transaction = this.transactions.get(id);
    if (!transaction) return;
    this.transactions.delete(id);
    this.upstreamStates.delete(transaction.upstreamState);
  }

  /** Drops everything that is already expired; called on every insertion. */
  private sweep(): void {
    for (const [id, transaction] of this.transactions) {
      if (this.expired(transaction.expiresAt)) this.removeTransaction(id);
    }
    for (const [code, issued] of this.codes) {
      if (this.expired(issued.expiresAt)) this.codes.delete(code);
    }
  }

  /** Oldest-first eviction once the count bound is reached. */
  private evict(keys: IterableIterator<string>, max: number, drop: (key: string) => void): void {
    // Map iterators yield insertion order, so the excess is the oldest entries.
    const ordered = [...keys];
    for (let index = 0; index < ordered.length - max; index += 1) {
      const key = ordered[index];
      if (key !== undefined) drop(key);
    }
  }
}
