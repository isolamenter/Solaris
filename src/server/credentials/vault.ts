import type { CredentialVault } from "../interfaces.js";
import { credentialAad, decryptSecret, encryptSecret } from "../vault.js";

/**
 * CONTRACTS §3: the existing AES-256-GCM format with the AAD widened from a
 * profile id to `${userId}:${connectionId}`.
 *
 * Both ids must be UUIDs (`credentialAad` enforces it), and the master key is
 * the only key material: there is no second AAD and no plaintext fallback, so a
 * credential written before this change, or copied to another user or another
 * connection, fails to decrypt.
 */
export class AesCredentialVault implements CredentialVault {
  constructor(private readonly masterKey: string | undefined) {}

  encrypt(plainText: string, userId: string, connectionId: string): string {
    return encryptSecret(plainText, credentialAad(userId, connectionId), this.masterKey);
  }

  decrypt(payload: string, userId: string, connectionId: string): string {
    return decryptSecret(payload, credentialAad(userId, connectionId), this.masterKey);
  }
}
