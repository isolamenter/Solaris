# Solaris local-first guide

Solaris is a Vite + React client and Fastify BFF running as one local Node process. Keep it bound to `127.0.0.1`, keep provider keys on the server, and keep all write endpoints protected by the origin guard in `src/server/http/security.ts`.

- SQLite schema lives in `src/server/db/schema.ts`; use the repository helpers rather than exposing database records to the client.
- Provider implementations belong in `src/server/providers/`. They own protocol mapping and fixed remote paths. Do not add arbitrary URL, header, tool, or proxy inputs.
- Files belong in the content-addressed local store. User-supplied URLs are not server-fetched.
- Plugins must redact credential material from inspectors, errors, logs, and cURL exports.
- Run `npm run test`, `npm run typecheck`, and `npm run lint` for code changes.
