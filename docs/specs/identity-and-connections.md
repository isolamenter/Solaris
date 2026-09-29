# Identity, sessions and model connections

## Goal

Authenticate desktop users without embedding an IdP secret in the Client, isolate their Server resources and resolve only their own model credentials.

## Sign-in and sessions

- Desktop authorization requires `response_type=code`, `state`, `redirect_uri`, `code_challenge` and `code_challenge_method=S256`; unknown parameters and other response types are refused.
- The public authentication adapter is OIDC. The Server owns the IdP client secret, upstream PKCE verifier and nonce; the desktop uses its own independent state and S256 PKCE verifier.
- The Client resolves the deployment authorization endpoint against its configured Server origin, then opens the system browser and receives a single-use Solaris code at an allowed literal loopback IP, random port and `/callback` path. The Server's IdP callback is `/api/auth/callback`. These are separate callbacks; a session token never appears in the redirect URL.
- Server verification includes signature, issuer, audience, expiry and nonce. Users are mapped by stable `(issuer, subject)`, not email or display name.
- Login transactions and authorization codes are bounded, short-lived, in-memory and consumed atomically. Restart invalidates them. Tokens, codes and verifiers must not enter logs or persistence.
- Solaris issues opaque bearer sessions. Only token hashes are stored on the Server; the Client stores its session in native secure storage. Expired/revoked sessions require login (`AUTH_REQUIRED`); there is no refresh-token flow. Logout revokes the current session.
- Protected resources are queried with `userId`. Missing and foreign resources both return `NOT_FOUND`.

## Explicit local mock mode

`SOLARIS_MOCK_OIDC=1` hosts a local mock IdP at `/mock-oidc`. It uses the existing
`oidc` adapter and desktop-code transport: two PKCE legs, signed ID tokens, nonce
verification, single-use codes and native secure session storage still apply.
The mock IdP immediately authorizes the fixed `local-developer` subject; it has no
user verification. Mock routes exist only when enabled. Startup refuses non-loopback
public origins or bind addresses and any trusted proxy hops.

Mock deployments publish optional `auth.autoSignIn: true` in `/api/deployment`.
The Client makes one startup login attempt when no session is stored; failure
requires manual retry, and logout does not trigger another automatic attempt.
Vite embeds only the explicitly configured mock Server origin as a desktop default.
Existing device settings take precedence. Changing the mode/origin requires rebuilding.

Server startup requires `SOLARIS_GEMINI_API_KEY`, initializes the mock user and
reserved Local Gemini connection, and updates its encrypted key and URL on restart.
It seeds the configured adapted image model without discovery or provider calls.
The key uses the existing `user-key` source and vault, never enters Client DTOs and
has no implicit fallback. Keep one stable public origin per local data directory.

## Connections and capabilities

Users configure their own Gemini-protocol connections and provide their own API keys through the `user-key` credential source. Keys are write-only: public DTOs expose `hasKey`, never the key. The Client does not save model-service keys. Server encryption is AES-256-GCM with AAD `${userId}:${connectionId}`; there is no alternate AAD or legacy decryption fallback.

Connection adapter identity is immutable. Provider base URLs must use HTTPS without credentials, query or fragment. Connection configuration and generation parameters use strict adapter schemas.

Discovery narrows candidate models; it does not authorize generation. The curated adapter allowlist derives capabilities, operation controls and availability at read time. Manual model records obey the same rule. Refresh preserves manual models and stable model identities; a stored capability or matching name alone cannot enable a run.

## Deployment boundary and sources

Required authentication, credential-source and deployment configuration must be complete before serving. Allowed origins receive explicit CORS response headers and preflight responses for GET, POST, PUT and DELETE with Authorization and Content-Type. CORS does not grant authentication. macOS Tauri uses `tauri://localhost`, which must be configured in `SOLARIS_ALLOWED_ORIGINS`. Rejected Hosts/Origins receive no CORS access. Host is restricted to the configured public authority; supplied Origin must be explicitly allowed. Requests without Origin still need bearer authentication for account data. Trusted proxy hops are configured explicitly. See [.env.example](../../.env.example) for configuration.

Implementation: [auth/](../../src/server/auth/), [credentials/](../../src/server/credentials/), [security.ts](../../src/server/http/security.ts), [session.ts](../../src/client/session.ts), [local/login.ts](../../src/client/local/login.ts), [providers/geminiAdapter.ts](../../src/server/providers/geminiAdapter.ts). Module tests use fake IdP/provider calls; the Playwright harness proves HTTP boundary rejection and an unreachable-IdP failure, not real sign-in.
