import { AppError } from "../errors.js";
import type { CredentialSource, CredentialVault, Repository, ResolvedCredential } from "../interfaces.js";

/** The repository methods a user-key lookup needs; ownership lives in `getConnection`. */
export type ConnectionLookup = Pick<Repository, "getConnection">;

/**
 * CONTRACTS §3.1: an expired credential is not usable for a new call. A null
 * expiry never expires; an unparsable one is treated as expired rather than
 * trusted.
 */
export function requireUsable(credential: ResolvedCredential, now: number): ResolvedCredential {
  if (credential.expiresAt !== null && !(Date.parse(credential.expiresAt) > now)) {
    throw new AppError("CREDENTIAL_MISSING", "The saved credential for this connection has expired", 409);
  }
  return credential;
}

/**
 * The first-phase public credential source: the key the user typed for one of
 * their own connections, decrypted on demand.
 *
 * Ownership is established by the repository before any ciphertext is touched —
 * the repository scopes `getConnection` by user, so another user's connection is
 * `NOT_FOUND` here rather than a decryption attempt. A failure never falls back
 * to another source (there is no other source in this registry) or to another
 * user's key, and a session problem is reported as `AUTH_REQUIRED` (401) by the
 * session boundary, never as a credential failure.
 */
export class UserKeyCredentialSource implements CredentialSource {
  readonly id = "user-key" as const;

  constructor(
    private readonly repository: ConnectionLookup,
    private readonly vault: CredentialVault,
    private readonly clock: () => number = Date.now,
  ) {}

  async resolve(input: { userId: string; connectionId: string }): Promise<ResolvedCredential> {
    const connection = this.repository.getConnection(input.userId, input.connectionId);
    if (!connection.keyEncrypted) {
      throw new AppError("CREDENTIAL_MISSING", "No API key is saved for this connection", 409);
    }
    const apiKey = this.vault.decrypt(connection.keyEncrypted, input.userId, input.connectionId);
    if (apiKey.length === 0) {
      throw new AppError("CREDENTIAL_MISSING", "The saved API key for this connection is empty", 409);
    }
    // A user-entered key carries no expiry, so `expiresAt` is null here; the
    // guard is what makes a source that does return an expiry fail closed.
    return requireUsable({ apiKey, expiresAt: null }, this.clock());
  }

  async hasCredential(input: { userId: string; connectionId: string }): Promise<boolean> {
    const connection = this.repository.getConnection(input.userId, input.connectionId);
    return typeof connection.keyEncrypted === "string" && connection.keyEncrypted.length > 0;
  }
}
