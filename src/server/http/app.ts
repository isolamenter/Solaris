import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { adapterIds, errorCodes, operations } from "../../shared/contracts.js";
import type { DeploymentDto, GenerationRequestDto, GenerationResponseDto, UserDto } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import type { Repository } from "../interfaces.js";
import type { ReferenceInput, SolarisService } from "../services.js";
import { ProviderCallError } from "../providers/types.js";
import { AUTHORIZE_PATH, registerAuthRoutes, TOKEN_PATH, type AuthBoundaries } from "../auth/index.js";
import { reportBoundaryRejection, type DeploymentBoundary } from "./security.js";

// ---------------------------------------------------------------------------
// Composition (CONTRACTS §9)
// ---------------------------------------------------------------------------

export type AppConfig = {
  /** The interface the process listens on, reported by the health route. */
  bindHost: string;
};

/**
 * Every collaborator is injected so the composition root owns construction:
 * B08 supplies the lifecycle wiring and the deployment boundary, B03 the
 * session/credential boundaries. The result cache is not here — the service
 * owns it, and no route touches it.
 */
export type AppDependencies = {
  repository: Repository;
  service: SolarisService;
  /** B03's auth boundaries: adapter, sessions, login transactions, allowlist. */
  auth: AuthBoundaries;
  /** The transport boundary, enforced on every request before any handler. */
  boundary: DeploymentBoundary;
  /** The IdP callback registered with the provider, derived from the public origin. */
  callbackUrl: string;
  config: AppConfig;
};

const JSON_BODY_MAX_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// multipart transport bounds (CONTRACTS §4.1)
// ---------------------------------------------------------------------------

/**
 * The `request` field is a field, so it never consumes the file quota.
 *
 * These are the transport's outer guard, not the per-model policy.
 * `providers/geminiAdapter.ts` declares the largest policy Solaris serves
 * (`attachmentPolicy`: 14 references, 10 MiB each, 14 MiB in total), and every
 * bound here sits one step above that ceiling. A request that exceeds a policy
 * therefore always meets the *policy's* frozen code and model-specific message,
 * and only a body that also exceeds the ceiling meets the transport's generic
 * one — the transport bound is never what a user hits first. `app.upload.test
 * .ts` derives the declared policy from the plugins and fails if that ordering
 * stops holding.
 *
 * The bounds still bound what is buffered: `readGenerationParts` checks the
 * running total as each part is read, so an oversized body is abandoned while
 * streaming rather than accumulated.
 */
const DECLARED_REFERENCE_CEILING = { count: 14, fileBytes: 10 * 1024 * 1024, totalBytes: 14 * 1024 * 1024 };
/** One extra reference: enough for the service to see — and name — the over-count part. */
const REFERENCE_COUNT_MAX = DECLARED_REFERENCE_CEILING.count + 1;
/** One mebibyte above the largest single file any policy accepts. */
const REFERENCE_FILE_MAX_BYTES = DECLARED_REFERENCE_CEILING.fileBytes + 1024 * 1024;
/**
 * One whole file above the largest total any policy accepts: a request that a
 * policy rejects for its total size is still inside the transport's bound, so
 * the policy is what reports it.
 */
const REFERENCE_TOTAL_MAX_BYTES = DECLARED_REFERENCE_CEILING.totalBytes + DECLARED_REFERENCE_CEILING.fileBytes;
const REQUEST_FIELD_MAX_BYTES = 1_000_000;
/**
 * Parts backstop: the `request` field, the whole file quota, and one more part
 * so that the quota — not the part count — is what an over-quota request hits.
 */
const REQUEST_PARTS_MAX = 1 + REFERENCE_COUNT_MAX + 1;

/** Exported for `app.upload.test.ts`, which proves the ordering documented above. */
export const referenceTransportBounds = {
  count: REFERENCE_COUNT_MAX,
  fileBytes: REFERENCE_FILE_MAX_BYTES,
  totalBytes: REFERENCE_TOTAL_MAX_BYTES,
  parts: REQUEST_PARTS_MAX,
} as const;

const REQUEST_FIELD = "request";
const REFERENCE_FIELD = "reference";

const megabytes = (bytes: number) => `${Math.floor(bytes / 1024 / 1024)} MB`;

/**
 * Transport-limit failures are format violations, never `INTERNAL`
 * (CONTRACTS §4.1). An unrecognized code is deliberately left alone: it means a
 * limit nobody declared here, and guessing a friendly code for it would hide a
 * real defect.
 */
function transportError(error: unknown): unknown {
  switch (errorCode(error)) {
    case "FST_FILES_LIMIT":
      return new AppError("REFERENCE_COUNT", `At most ${REFERENCE_COUNT_MAX} reference images are accepted per request`, 400);
    case "FST_REQ_FILE_TOO_LARGE":
      return new AppError("REFERENCE_SIZE", `Each reference image must be ${megabytes(REFERENCE_FILE_MAX_BYTES)} or smaller`, 413);
    case "FST_FIELDS_LIMIT":
    case "FST_PARTS_LIMIT":
      return new AppError("VALIDATION", `The request must carry one "${REQUEST_FIELD}" field and at most ${REFERENCE_COUNT_MAX} "${REFERENCE_FIELD}" files`, 400);
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
      return new AppError("VALIDATION", `The request must be multipart/form-data`, 400);
    case "FST_PROTO_VIOLATION":
    case "FST_INVALID_JSON_FIELD_ERROR":
      return new AppError("VALIDATION", `The "${REQUEST_FIELD}" field must be a JSON text field`, 400);
    default:
      return error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

// ---------------------------------------------------------------------------
// Error envelope (CONTRACTS §9)
// ---------------------------------------------------------------------------

const FROZEN_ERROR_CODES = new Set<string>(errorCodes);

/**
 * Transport-boundary codes, which belong to the deployment boundary rather than
 * the API error table (see `security.ts`). The boundary hook answers them
 * directly, so they normally never reach here; the mapping exists so that a
 * boundary rejection can never be reported as an `INTERNAL` 500 — an operator
 * must be able to tell a refused request from a broken server.
 */
const TRANSPORT_BOUNDARY_CODES: ReadonlyMap<string, number> = new Map([
  ["HOST_REJECTED", 421],
  ["ORIGIN_REJECTED", 403],
]);

/**
 * Fastify's own content-type-parser failures describe a malformed request body,
 * exactly like the multipart ones, so they fold into `VALIDATION` — the only
 * frozen code for a client-side format problem. Without this they would be
 * reported as an internal error, hiding both the cause and any real defect.
 */
const PARSER_ERROR_CODES = new Set<string>([
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
  "FST_ERR_CTP_BODY_TOO_LARGE",
]);

/** Catalog calls that failed before a run existed report 502 (CONTRACTS §9). */
const CATALOG_UPSTREAM_CODES = new Set<string>(["UPSTREAM_FAILED", "UPSTREAM_NO_IMAGE", "UPSTREAM_UNAVAILABLE", "RESULT_TOO_LARGE"]);

/**
 * The public error surface is frozen: only the codes in CONTRACTS §9 reach a
 * client, and anything else becomes a generic `INTERNAL` whose original message
 * and stack are never echoed.
 */
function toPublicError(error: unknown): AppError {
  if (error instanceof ZodError) {
    return new AppError("VALIDATION", "Request validation failed", 400, error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  if (error instanceof AppError) {
    const boundaryStatus = TRANSPORT_BOUNDARY_CODES.get(error.code);
    if (boundaryStatus !== undefined) return new AppError(error.code, error.message, boundaryStatus);
    if (FROZEN_ERROR_CODES.has(error.code)) return error;
  }
  if (PARSER_ERROR_CODES.has(errorCode(error) ?? "")) return new AppError("VALIDATION", "The request body could not be read", 400);
  return new AppError("INTERNAL", "Unexpected server error", 500);
}

/** CONTRACTS §9: an upstream failure before a run exists is a 502, not a run state. */
function throwCatalogFailure(error: unknown): never {
  if (error instanceof ProviderCallError) throw new AppError(error.errorCode, error.message, 502);
  if (error instanceof AppError && CATALOG_UPSTREAM_CODES.has(error.code)) throw new AppError(error.code, error.message, 502);
  throw error;
}

// ---------------------------------------------------------------------------
// Input schemas — strict everywhere, so a caller can never smuggle in an
// identity field: `userId`/`sessionId` come from the authenticated session.
// ---------------------------------------------------------------------------

const idParams = z.strictObject({ id: z.uuid() });

const connectionCreate = z.strictObject({
  name: z.string().trim().min(1).max(80),
  adapterId: z.enum(adapterIds),
  baseUrl: z.string().min(1).max(2000),
  config: z.record(z.string(), z.unknown()).optional(),
  apiKey: z.string().min(1).max(10_000),
});

/** `adapterId` is immutable after creation, so it is absent here. */
const connectionUpdate = z.strictObject({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().min(1).max(2000),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean(),
  apiKey: z.string().min(1).max(10_000).optional(),
});

const manualModel = z.strictObject({
  providerModelId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200).optional(),
  capabilities: z.array(z.enum(operations)).min(1).max(operations.length),
});

const parameterValues = z
  .record(z.string().min(1).max(80), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 16, "Too many parameters");

/** The JSON body of the multipart `request` field (CONTRACTS §4.1). */
const generationRequest = z.strictObject({
  connectionId: z.uuid(),
  modelId: z.uuid(),
  prompt: z.string().min(1).max(100_000),
  parameters: parameterValues.optional(),
  submissionId: z.uuid(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/, "contentDigest must be a lowercase hex SHA-256"),
});

const runListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// Identity (CONTRACTS §2.2/§9)
// ---------------------------------------------------------------------------

const BEARER_TOKEN = /^Bearer ([^\s]+)$/;

async function authenticate(
  request: FastifyRequest,
  sessions: AuthBoundaries["sessions"],
): Promise<{ sessionId: string; user: UserDto }> {
  const token = request.headers.authorization?.match(BEARER_TOKEN)?.[1];
  if (!token) throw new AppError("AUTH_REQUIRED", "A bearer session token is required", 401);
  return sessions.authenticate(token);
}

// ---------------------------------------------------------------------------
// Generation transport (CONTRACTS §4.1)
// ---------------------------------------------------------------------------

/** The `request` part is a text field holding JSON. */
function parseRequestField(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", `The "${REQUEST_FIELD}" field must contain JSON`, 400);
  }
}

/**
 * Reads the multipart parts into memory. Reference bytes are passed straight to
 * the service: there is no server-side asset store, and nothing here writes an
 * upload to disk.
 */
async function readGenerationParts(request: FastifyRequest): Promise<{ field: string; references: ReferenceInput[] }> {
  let field: string | null = null;
  const references: ReferenceInput[] = [];
  let totalBytes = 0;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== REFERENCE_FIELD) {
          throw new AppError("VALIDATION", `Unexpected file field "${part.fieldname}"; reference images use the "${REFERENCE_FIELD}" field`, 400);
        }
        const bytes = await part.toBuffer();
        totalBytes += bytes.byteLength;
        if (totalBytes > REFERENCE_TOTAL_MAX_BYTES) {
          throw new AppError("REFERENCE_TOTAL_SIZE", `Reference images must total ${megabytes(REFERENCE_TOTAL_MAX_BYTES)} or less`, 413);
        }
        references.push({ mimeType: part.mimetype, bytes });
        continue;
      }
      if (part.fieldname !== REQUEST_FIELD) throw new AppError("VALIDATION", `Unexpected field "${part.fieldname}"`, 400);
      if (part.valueTruncated || typeof part.value !== "string") {
        throw new AppError("VALIDATION", `The "${REQUEST_FIELD}" field must be a JSON text field`, 400);
      }
      field = part.value;
    }
  } catch (error) {
    throw transportError(error);
  }
  if (field === null) throw new AppError("VALIDATION", `The "${REQUEST_FIELD}" field is required`, 400);
  return { field, references };
}

// ---------------------------------------------------------------------------
// Static client
// ---------------------------------------------------------------------------

async function installClient(app: FastifyInstance) {
  const root = join(process.cwd(), "dist/client");
  if (!existsSync(join(root, "index.html"))) throw new Error("Built UI is missing; run npm run build first");
  await app.register(fastifyStatic, { root, wildcard: true });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Unknown API route" } });
    }
    return reply.sendFile("index.html");
  });
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export async function createApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { repository, service, auth, boundary, callbackUrl, config } = deps;
  const { sessions } = auth;
  const app = Fastify({
    logger: false,
    bodyLimit: JSON_BODY_MAX_BYTES,
    // Exactly the configured number of hops: the client address and protocol are
    // read that many hops from the socket, so an `X-Forwarded-*` header from an
    // untrusted peer is ignored rather than believed.
    trustProxy: boundary.trustProxy === 0 ? false : boundary.trustProxy,
  });

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fields: 1,
      fieldSize: REQUEST_FIELD_MAX_BYTES,
      files: REFERENCE_COUNT_MAX,
      fileSize: REFERENCE_FILE_MAX_BYTES,
      parts: REQUEST_PARTS_MAX,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    const safe = toPublicError(error);
    reply.status(safe.statusCode).send({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } });
  });

  /**
   * The deployment boundary runs on every request, before any route handler and
   * before the default 404 handler: a rejected request never reaches application
   * code, so no route can be probed from a host or origin the deployment did not
   * announce. The boundary answers directly rather than throwing, so a routine
   * rejection keeps its transport status instead of being normalized into an API
   * error code.
   */
  app.addHook("onRequest", async (request, reply) => {
    const rejection = boundary.rejectionFor(request);
    if (rejection === null) return;
    reportBoundaryRejection(request, rejection);
    return reply.status(rejection.statusCode).send({ error: { code: rejection.code, message: rejection.message } });
  });

  const currentUser = async (request: FastifyRequest): Promise<UserDto> => (await authenticate(request, sessions)).user;

  app.get("/api/health", async (request) => ({
    ok: true,
    bind: config.bindHost,
    // What the server believes about this request, so an operator can verify the
    // trusted-proxy hop count against the real topology.
    ip: request.ip,
    protocol: request.protocol,
  }));

  // -- deployment and authentication ----------------------------------------

  app.get("/api/deployment", async (): Promise<DeploymentDto> => ({
    name: "Solaris",
    auth: { flow: "desktop-code", authorizationEndpoint: AUTHORIZE_PATH, tokenEndpoint: TOKEN_PATH },
  }));

  // B03 owns the desktop authorization-code flow, its input schemas and its
  // bounded login-transaction store; the composition wires it in as-is.
  registerAuthRoutes(app, {
    adapter: auth.adapter,
    transactions: auth.transactions,
    sessions: auth.sessions,
    users: repository,
    redirectAllowlist: auth.redirectAllowlist,
    callbackUrl,
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await authenticate(request, sessions);
    await sessions.revoke(session.sessionId, session.user.id);
    reply.status(204).send();
  });

  app.get("/api/me", async (request) => currentUser(request));

  // -- catalog --------------------------------------------------------------

  app.get("/api/adapters", async (request) => {
    await currentUser(request);
    return service.listAdapters();
  });

  app.get("/api/connections", async (request) => service.listConnections((await currentUser(request)).id));

  app.post("/api/connections", async (request, reply) => {
    const user = await currentUser(request);
    reply.status(201).send(service.createConnection(user.id, connectionCreate.parse(request.body)));
  });

  app.put("/api/connections/:id", async (request) => {
    const user = await currentUser(request);
    return service.updateConnection(user.id, idParams.parse(request.params).id, connectionUpdate.parse(request.body));
  });

  app.delete("/api/connections/:id", async (request, reply) => {
    const user = await currentUser(request);
    service.deleteConnection(user.id, idParams.parse(request.params).id);
    reply.status(204).send();
  });

  app.post("/api/connections/:id/test", async (request) => {
    const user = await currentUser(request);
    const { id } = idParams.parse(request.params);
    try {
      return await service.testConnection(user.id, id);
    } catch (error) {
      throwCatalogFailure(error);
    }
  });

  app.get("/api/connections/:id/models", async (request) => {
    const user = await currentUser(request);
    return service.listModels(user.id, idParams.parse(request.params).id);
  });

  app.post("/api/connections/:id/models/refresh", async (request) => {
    const user = await currentUser(request);
    const { id } = idParams.parse(request.params);
    try {
      return await service.refreshModels(user.id, id);
    } catch (error) {
      throwCatalogFailure(error);
    }
  });

  app.post("/api/connections/:id/models", async (request, reply) => {
    const user = await currentUser(request);
    const { id } = idParams.parse(request.params);
    reply.status(201).send(await service.addModel(user.id, id, manualModel.parse(request.body)));
  });

  app.delete("/api/models/:id", async (request, reply) => {
    const user = await currentUser(request);
    const { id } = idParams.parse(request.params);
    // A model is addressed by its own id; the owning connection comes from the
    // row the repository resolves for this user, never from the request.
    const model = repository.getModelById(user.id, id);
    service.deleteModel(user.id, model.connectionId, id);
    reply.status(204).send();
  });

  // -- generation and history ----------------------------------------------

  app.post("/api/generations", async (request, reply) => {
    const user = await currentUser(request);
    const { field, references } = await readGenerationParts(request);
    const input: GenerationRequestDto = generationRequest.parse(parseRequestField(field));
    const response: GenerationResponseDto = await service.generate(user.id, { ...input, references });
    // CONTRACTS §4.2: `pending` is the only 202; every other handled outcome is 200.
    reply.status(response.result.kind === "pending" ? 202 : 200).send(response);
  });

  app.get("/api/runs", async (request) => {
    const user = await currentUser(request);
    // The cursor is opaque and only ever applied to this user's rows.
    return service.listRuns(user.id, runListQuery.parse(request.query));
  });

  app.get("/api/runs/:id", async (request) => {
    const user = await currentUser(request);
    return service.getRun(user.id, idParams.parse(request.params).id);
  });

  app.delete("/api/runs/:id", async (request, reply) => {
    const user = await currentUser(request);
    service.deleteRun(user.id, idParams.parse(request.params).id);
    reply.status(204).send();
  });

  await installClient(app);
  return app;
}
