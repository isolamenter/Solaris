/**
 * Test support for the HTTP integration and security suites (B08).
 *
 * It builds the *real* composition — repository, service, auth boundaries,
 * deployment boundary, Fastify app — over a temporary database, so a test
 * exercises the same code a deployment runs rather than a stand-in. Only the
 * things that would leave the machine are injected: the OIDC fetch (no test
 * reaches a real IdP unless it installs a fake one) and the upstream provider
 * operation (no test makes a billable call).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createAuthBoundaries, type AuthBoundaries } from "../auth/index.js";
import { AesCredentialVault, createCredentialSource } from "../credentials/index.js";
import { openDatabase, type SqliteDatabase } from "../db/index.js";
import { gemini } from "../providers/gemini.js";
import type { ConnectionRow, ModelRow } from "../interfaces.js";
import { SqliteRepository } from "../repository.js";
import { ResultCache } from "../resultCache.js";
import { SolarisService } from "../services.js";
import { createApp } from "./app.js";
import { deploymentBoundary, type DeploymentBoundary } from "./security.js";

export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
export const TEST_ORIGIN = "https://solaris.example.test";
export const TEST_AUTHORITY = "solaris.example.test";
export const TEST_OIDC_ISSUER = "https://idp.example.test";
export const TEST_CALLBACK_URL = `${TEST_ORIGIN}/api/auth/callback`;

/** No test reaches an IdP or an upstream by accident. */
const unreachableIdp = async (): Promise<Response> => {
  throw new Error("This test did not install a fake IdP");
};

export type TestDeployment = {
  app: FastifyInstance;
  repository: SqliteRepository;
  service: SolarisService;
  auth: AuthBoundaries;
  boundary: DeploymentBoundary;
  /** Creates a user with an external identity and issues a real bearer session. */
  signIn(displayName?: string): Promise<{ token: string; userId: string }>;
  connect(userId: string, input?: { name?: string; baseUrl?: string; apiKey?: string }): ConnectionRow;
  addModel(userId: string, connectionId: string, providerModelId?: string): ModelRow;
  /** A request to the app that already carries the boundary's Host. */
  call(input: InjectOptions & { token?: string }): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
  close(): Promise<void>;
};

export type TestDeploymentOptions = {
  boundary?: { publicOrigin?: string; allowedOrigins?: string[]; trustProxy?: string };
  oidcIssuer?: string;
  idpFetch?: typeof fetch;
  imageResultMaxBytes?: number;
  /** Kept and not removed by `close()` when the caller owns the directory. */
  dataDir?: string;
};

export async function createTestDeployment(options: TestDeploymentOptions = {}): Promise<TestDeployment> {
  const root = options.dataDir ?? mkdtempSync(join(tmpdir(), "solaris-http-"));
  const database: SqliteDatabase = openDatabase(join(root, "data")).sqlite;
  const repository = new SqliteRepository(database);
  const vault = new AesCredentialVault(TEST_MASTER_KEY);
  const credentials = createCredentialSource("user-key", repository, vault);
  const cache = new ResultCache(60_000, 8 * 1024 * 1024);
  const service = new SolarisService(repository, credentials, vault, cache, {
    imageResultMaxBytes: options.imageResultMaxBytes ?? 4 * 1024 * 1024,
  });
  const boundary = deploymentBoundary({
    publicOrigin: options.boundary?.publicOrigin ?? TEST_ORIGIN,
    allowedOrigins: options.boundary?.allowedOrigins ?? [],
    trustProxy: options.boundary?.trustProxy,
  });
  const auth = createAuthBoundaries(repository, {
    adapter: "oidc",
    sessionTtlSeconds: undefined,
    desktopRedirectAllowlist: [],
    oidc: {
      issuer: options.oidcIssuer ?? TEST_OIDC_ISSUER,
      clientId: "solaris-test",
      clientSecret: "test-client-secret",
      scopes: ["openid", "profile"],
    },
    fetch: options.idpFetch ?? unreachableIdp,
  });
  const app = await createApp({
    repository,
    service,
    auth,
    boundary,
    callbackUrl: `${boundary.publicOrigin}/api/auth/callback`,
    config: { bindHost: "127.0.0.1" },
  });

  let identity = 0;
  return {
    app,
    repository,
    service,
    auth,
    boundary,
    async signIn(displayName?: string) {
      identity += 1;
      const user = repository.createUserWithIdentity({
        issuer: TEST_OIDC_ISSUER,
        subject: `subject-${identity}-${randomUUID()}`,
        ...(displayName === undefined ? {} : { displayName }),
      });
      const session = await auth.sessions.issue(user.id);
      return { token: session.token, userId: user.id };
    },
    connect(userId, input = {}) {
      // The AAD binds the ciphertext to this exact user and connection, so the
      // id must exist before the key is encrypted against it.
      const id = randomUUID();
      return repository.createConnection({
        userId,
        id,
        name: input.name ?? "gateway",
        adapterId: "gemini",
        baseUrl: input.baseUrl ?? "https://gateway.example.test",
        config: {},
        keyEncrypted: vault.encrypt(input.apiKey ?? "test-key-value", userId, id),
      });
    },
    addModel(userId, connectionId, providerModelId = "gemini-3.1-flash-image") {
      return repository.upsertModel({ userId, connectionId, providerModelId, capabilities: ["imageGenerate"], manual: true });
    },
    call(input) {
      const { token, headers, ...rest } = input;
      return app.inject({
        ...rest,
        headers: {
          host: TEST_AUTHORITY,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
      });
    },
    async close() {
      await app.close();
      database.close();
      if (options.dataDir === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// multipart bodies
// ---------------------------------------------------------------------------

export type MultipartPart =
  | { kind: "field"; name: string; value: string }
  | { kind: "file"; name: string; filename: string; mimeType: string; bytes: Buffer };

const TEST_BOUNDARY = "solaris-test-boundary";

/** Builds the raw body by hand so a test can control parts, counts and sizes. */
export function multipartBody(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.kind === "field"
        ? `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
        : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`;
    chunks.push(Buffer.from(`--${TEST_BOUNDARY}\r\n${disposition}`));
    chunks.push(part.kind === "field" ? Buffer.from(part.value) : part.bytes);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${TEST_BOUNDARY}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${TEST_BOUNDARY}` };
}

/** A one-pixel PNG, so reference bytes are real image bytes. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function requestField(input: {
  connectionId: string;
  modelId: string;
  prompt?: string;
  submissionId?: string;
  /** Defaults to the canonical digest of the request without references. */
  contentDigest: string;
  parameters?: Record<string, string | number | boolean>;
}): { kind: "field"; name: string; value: string } {
  return {
    kind: "field",
    name: "request",
    value: JSON.stringify({
      connectionId: input.connectionId,
      modelId: input.modelId,
      prompt: input.prompt ?? "draw a circle",
      submissionId: input.submissionId ?? randomUUID(),
      contentDigest: input.contentDigest,
      ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    }),
  };
}

// ---------------------------------------------------------------------------
// upstream stub
// ---------------------------------------------------------------------------

export type StubImages = { bytes: Buffer; mimeType: string }[];

/**
 * Replaces the Gemini image operation for the duration of a test. The real
 * transport (timeouts, response reading, decoding) is B04's suite; this is what
 * lets an HTTP test reach a delivered result without a billable call.
 */
export function stubImageGeneration(images: StubImages): { calls: number; restore(): void } {
  const real = gemini.operations.imageGenerate;
  const stub = { calls: 0 };
  gemini.operations.imageGenerate = async () => {
    stub.calls += 1;
    return { images, returnedImageCount: images.length, diagnostics: { durationMs: 1, returnedImageCount: images.length } };
  };
  return {
    get calls() {
      return stub.calls;
    },
    restore() {
      gemini.operations.imageGenerate = real;
    },
  };
}

/** Captures everything the process writes while a test runs. */
export function captureConsole(): { output: string[]; restore(): void } {
  const output: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const record =
    (prefix: string) =>
    (...args: unknown[]) => {
      output.push(`${prefix} ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`);
    };
  console.log = record("log");
  console.warn = record("warn");
  console.error = record("error");
  return {
    output,
    restore() {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    },
  };
}
