# Identity, sessions and model connections

## Goal

Authenticate desktop users without embedding an IdP secret in the Client, isolate their Server resources and resolve only their own model credentials.

## Sign-in and sessions

- The public authentication adapter is OIDC. The Server owns the IdP client secret, upstream PKCE verifier and nonce; the desktop uses its own independent state and S256 PKCE verifier.
- The Client opens the system browser and receives a single-use Solaris code at an allowed literal loopback IP, random port and `/callback` path. The Server's IdP callback is `/api/auth/callback`. These are separate callbacks; a session token never appears in the redirect URL.
- Server verification includes signature, issuer, audience, expiry and nonce. Users are mapped by stable `(issuer, subject)`, not email or display name.
- Login transactions and authorization codes are bounded, short-lived, in-memory and consumed atomically. Restart invalidates them. Tokens, codes and verifiers must not enter logs or persistence.
- Solaris issues opaque bearer sessions. Only token hashes are stored on the Server; the Client stores its session in native secure storage. Expired/revoked sessions require login (`AUTH_REQUIRED`); there is no refresh-token flow. Logout revokes the current session.
- Protected resources are queried with `userId`. Missing and foreign resources both return `NOT_FOUND`.

## Connections and capabilities

Users configure their own Gemini-protocol connections and provide their own API keys through the `user-key` credential source. Keys are write-only: public DTOs expose `hasKey`, never the key. The Client does not save model-service keys. Server encryption is AES-256-GCM with AAD `${userId}:${connectionId}`; there is no alternate AAD or legacy decryption fallback.

Connection adapter identity is immutable. Provider base URLs must use HTTPS without credentials, query or fragment. Connection configuration and generation parameters use strict adapter schemas.

Discovery narrows candidate models; it does not authorize generation. The curated adapter allowlist derives capabilities, operation controls and availability at read time. Manual model records obey the same rule. Refresh preserves manual models and stable model identities; a stored capability or matching name alone cannot enable a run.

## Deployment boundary and sources

Required authentication, credential-source and deployment configuration must be complete before serving. Host is restricted to the configured public authority; supplied Origin must be explicitly allowed. Requests without Origin still need bearer authentication for account data. Trusted proxy hops are configured explicitly. See [.env.example](../../.env.example) for configuration.

Implementation: [auth/](../../src/server/auth/), [credentials/](../../src/server/credentials/), [security.ts](../../src/server/http/security.ts), [session.ts](../../src/client/session.ts), [local/login.ts](../../src/client/local/login.ts), [providers/geminiAdapter.ts](../../src/server/providers/geminiAdapter.ts). Module tests use fake IdP/provider calls; the Playwright harness proves HTTP boundary rejection and an unreachable-IdP failure, not real sign-in.
