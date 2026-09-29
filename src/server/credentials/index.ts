import { credentialSourceIds } from "../../shared/contracts.js";
import type { CredentialSource, CredentialVault } from "../interfaces.js";
import type { ConnectionLookup } from "./userKey.js";
import { UserKeyCredentialSource } from "./userKey.js";

export { AesCredentialVault } from "./vault.js";
export { UserKeyCredentialSource, requireUsable, type ConnectionLookup } from "./userKey.js";

/**
 * The closed credential-source registry (CONTRACTS §1/§3.1). Only `user-key` is
 * implemented for the public deployment; an internal source is added here when
 * it ships, and there is deliberately no fallback from one source to another —
 * an unsupported or unset value refuses startup instead.
 */
export function createCredentialSource(id: string | undefined, repository: ConnectionLookup, vault: CredentialVault): CredentialSource {
  if (id === "user-key") return new UserKeyCredentialSource(repository, vault);
  throw new Error(`SOLARIS_CREDENTIAL_SOURCE must be one of ${credentialSourceIds.join(", ")}; got ${JSON.stringify(id ?? null)}`);
}
