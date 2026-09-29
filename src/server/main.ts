import { createAuthBoundaries, CALLBACK_PATH } from "./auth/index.js";
import { AesCredentialVault, createCredentialSource } from "./credentials/index.js";
import { openDatabase } from "./db/index.js";
import { env } from "./env.js";
import { createApp } from "./http/app.js";
import { deploymentBoundary } from "./http/security.js";
import { SqliteRepository } from "./repository.js";
import { ResultCache } from "./resultCache.js";
import { SolarisService } from "./services.js";

/**
 * How often the stale-run sweep runs and how old a `running` row must be before
 * it is eligible. These are safety-net values, not frozen budgets: runs that are
 * in flight are excluded by the service, so the sweep only converges rows left
 * behind by a process that died mid-request.
 */
const REAP_INTERVAL_MS = 60_000;
const STALE_RUN_MS = 15 * 60_000;

/**
 * The AES-256-GCM master key, checked before anything can serve: without it no
 * connection could be created, and every failure would surface much later as an
 * opaque internal error. Both messages name the variable and nothing else.
 */
function masterKey(): string {
  const key = env.masterKey;
  if (key === undefined || key === "") throw new Error("CREDENTIALS_MASTER_KEY is required; generate one with `openssl rand -base64 32`");
  if (Buffer.from(key, "base64").byteLength !== 32) throw new Error("CREDENTIALS_MASTER_KEY must be a base64-encoded 32-byte key");
  return key;
}

export async function start(): Promise<void> {
  // The data directory is opened first so an old-schema directory is refused
  // with its own message rather than being masked by a configuration failure.
  const database = openDatabase(env.dataDir);
  const repository = new SqliteRepository(database.sqlite);

  // Configuration that must be whole before a single request is accepted. Neither
  // call has a fallback: an unconfigured boundary or an unsupported auth adapter
  // refuses startup instead of serving unprotected.
  const boundary = deploymentBoundary({ publicOrigin: env.publicOrigin, allowedOrigins: env.allowedOrigins, trustProxy: env.trustProxy });
  const key = masterKey();
  const vault = new AesCredentialVault(key);
  const auth = createAuthBoundaries(repository, {
    adapter: env.authAdapter,
    sessionTtlSeconds: env.sessionTtlSeconds,
    desktopRedirectAllowlist: env.desktopRedirectAllowlist,
    oidc: { issuer: env.oidcIssuer, clientId: env.oidcClientId, clientSecret: env.oidcClientSecret, scopes: env.oidcScopes },
  });
  const credentials = createCredentialSource(env.credentialSource, repository, vault);

  const cache = new ResultCache(env.resultCacheTtlSeconds * 1000, env.resultCacheMaxBytes);
  const service = new SolarisService(repository, credentials, vault, cache, { imageResultMaxBytes: env.imageResultMaxBytes });

  // One process owns the data directory, so no `running` row can still be in
  // flight here. They become `uncertain` before the first request is accepted,
  // and are never resubmitted.
  const recovered = service.recoverAbandonedRuns();
  if (recovered.length > 0) console.log(`${recovered.length} abandoned run(s) marked uncertain`);

  const app = await createApp({
    repository,
    service,
    auth,
    boundary,
    // The IdP must be registered with exactly this value; it is derived from the
    // public origin so it cannot disagree with the host the Server is served at.
    callbackUrl: `${boundary.publicOrigin}${CALLBACK_PATH}`,
    config: { bindHost: env.bindHost },
  });

  // Periodic sweep for rows a mid-request crash left `running`. In-flight calls
  // are excluded by the service, so a slow call is never reaped for being old.
  const reaper = setInterval(() => {
    const stale = service.reapStaleRuns(new Date(Date.now() - STALE_RUN_MS).toISOString());
    if (stale.length > 0) console.log(`${stale.length} stale run(s) marked uncertain`);
  }, REAP_INTERVAL_MS);
  reaper.unref();

  // Shutdown order: the scheduler stops first (so nothing touches the database
  // after it closes), then Fastify drains the requests that are already in
  // flight — bounded by the upstream deadline — and only then does the database
  // close. There is no runner process to leave behind: generation is synchronous,
  // the delivery cache is memory-only and dies with the process, and the next
  // startup converges whatever this one did not finish.
  app.addHook("onClose", async () => {
    clearInterval(reaper);
    database.sqlite.close();
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await app.listen({ port: env.port, host: env.bindHost });
  console.log(`Solaris is listening on ${env.bindHost}:${env.port} for ${boundary.publicOrigin}${boundary.trustProxy > 0 ? ` behind ${boundary.trustProxy} trusted proxy hop(s)` : ""}`);
}

try {
  await start();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
