import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { AssetStore } from "../assets.js";
import { openDatabase } from "../db/index.js";
import { env } from "../env.js";
import { AppError, toAppError } from "../errors.js";
import { geminiImageRequest } from "../providers/geminiAdapter.js";
import { pluginDtos } from "../providers/index.js";
import type { OperationParameters } from "../providers/types.js";
import { Repository } from "../repository.js";
import { VideoRunner } from "../runner.js";
import { SolarisService } from "../services.js";
import { assertLoopbackHost, assertSameOrigin } from "./security.js";
import { providerIds, type Operation } from "../../shared/contracts.js";

const profileInput = z.object({ name: z.string().trim().min(1).max(80), pluginId: z.enum(providerIds), baseUrl: z.string().min(1), config: z.record(z.string(), z.unknown()).optional(), apiKey: z.string().min(1).max(10_000) });
const profileUpdate = z.object({ name: z.string().trim().min(1).max(80), baseUrl: z.string().min(1), config: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean(), apiKey: z.string().min(1).max(10_000).optional() });
const modelInput = z.object({ providerModelId: z.string().trim().min(1).max(200), label: z.string().trim().max(200).optional(), capabilities: z.array(z.enum(["imageGenerate", "videoGenerate"])).min(1) });
const operationParameters = z.record(z.string().min(1).max(80), z.union([z.string().max(200), z.number(), z.boolean()])).refine((value) => Object.keys(value).length <= 16, "Too many parameters");
const imageInput = z.object({ profileId: z.string().uuid(), modelId: z.string().uuid(), operation: z.literal("imageGenerate"), prompt: z.string().min(1).max(100_000), size: z.string().max(50).optional(), assetIds: z.array(z.string().uuid()).max(14).optional(), parameters: operationParameters.optional() });
const videoInput = z.object({ profileId: z.string().uuid(), modelId: z.string().uuid(), operation: z.literal("videoGenerate"), prompt: z.string().min(1).max(100_000), durationSeconds: z.number().int().min(1).max(60).optional(), size: z.string().max(50).optional() });
const batchCreateInput = z.object({ profileId: z.string().uuid(), modelId: z.string().uuid(), displayName: z.string().trim().min(1).max(120).optional() });
const batchEntryInput = z.object({ prompt: z.string().min(1).max(100_000), parameters: operationParameters.optional(), assetIds: z.array(z.string().uuid()).max(14).optional() });

function issue(error: unknown) {
  if (error instanceof ZodError) return new AppError("VALIDATION", "Request validation failed", 400, error.issues.map((item) => ({ path: item.path.join("."), message: item.message })));
  return toAppError(error);
}
function curlFor(run: ReturnType<Repository["getRun"]>, profile: ReturnType<Repository["getProfile"]>, model: ReturnType<Repository["getModel"]>) {
  const input = run.input; const base = profile.baseUrl.replace(/\/$/, "");
  const path = `/v1beta/models/${encodeURIComponent(model.providerModelId)}:${run.operation.startsWith("image") ? "generateContent" : "predictLongRunning"}`;
  const imagePayload = geminiImageRequest(model.providerModelId, String(input.prompt ?? ""), [], (input.parameters ?? {}) as OperationParameters);
  if (input.assetIds) imagePayload.contents[0]?.parts.push({ inlineData: { mimeType: "[omitted]", data: "[local references omitted]" } });
  const payload = run.operation.startsWith("image") ? imagePayload : { instances: [{ prompt: input.prompt }], parameters: { durationSeconds: input.durationSeconds, aspectRatio: input.size } };
  const escaped = JSON.stringify(payload).replace(/'/g, "'\\\"'\\\"'");
  return `curl -X POST '${base}${path}?key=[REDACTED]' -H 'Content-Type: application/json' --data '${escaped}'`;
}
async function installClient(app: FastifyInstance) {
  const root = join(process.cwd(), "dist/client"); if (!existsSync(join(root, "index.html"))) throw new Error("Built UI is missing; run npm run build first");
  await app.register(fastifyStatic, { root, wildcard: true });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url;
    if (path.startsWith("/api/")) {
      return reply.status(404).send({ error: "Not Found" });
    }
    return reply.sendFile("index.html");
  });
}

export async function createApp() {
  const database = openDatabase(env.dataDir); const assets = new AssetStore(database.sqlite, env.dataDir); const repo = new Repository(database.sqlite, assets); const service = new SolarisService(repo, assets); const runner = new VideoRunner(repo, service, assets);
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(multipart, { limits: { files: 8, fileSize: 30 * 1024 * 1024 } });
  app.setErrorHandler((error, _request, reply) => { const safe = issue(error); reply.status(safe.statusCode).send({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } }); });
  app.addHook("onRequest", async (request) => assertLoopbackHost(request, env.port));
  app.addHook("preHandler", async (request) => { if (!/^(GET|HEAD|OPTIONS)$/i.test(request.method)) assertSameOrigin(request, env.port); });
  app.get("/api/health", async () => ({ ok: true, bind: "127.0.0.1" }));
  app.get("/api/plugins", async () => pluginDtos());
  app.get("/api/profiles", async () => repo.listProfiles());
  app.post("/api/profiles", async (request, reply) => reply.status(201).send(service.createProfile(profileInput.parse(request.body))));
  app.get("/api/profiles/:id", async (request) => repo.getProfile((request.params as { id: string }).id));
  app.put("/api/profiles/:id", async (request) => service.updateProfile((request.params as { id: string }).id, profileUpdate.parse(request.body)));
  app.delete("/api/profiles/:id", async (request, reply) => { repo.deleteProfile((request.params as { id: string }).id); reply.status(204).send(); });
  app.post("/api/profiles/:id/test", async (request) => service.testProfile((request.params as { id: string }).id));
  app.get("/api/profiles/:id/models", async (request) => service.listModels((request.params as { id: string }).id));
  app.post("/api/profiles/:id/models/refresh", async (request) => service.refreshModels((request.params as { id: string }).id));
  app.post("/api/profiles/:id/models", async (request, reply) => reply.status(201).send(service.addModel({ profileId: (request.params as { id: string }).id, ...modelInput.parse(request.body) })));
  app.delete("/api/models/:id", async (request, reply) => { repo.deleteModel((request.params as { id: string }).id); reply.status(204).send(); });
  app.post("/api/assets", async (request, reply) => { const file = await request.file(); if (!file) throw new AppError("FILE_REQUIRED", "Choose a local file first"); const asset = service.upload(Buffer.from(await file.toBuffer()), file.mimetype); reply.status(201).send(asset); });
  app.get("/api/assets/:id", async (request, reply) => { const asset = assets.read((request.params as { id: string }).id); reply.header("content-type", asset.row.mime_type).header("content-length", asset.bytes.byteLength).header("cache-control", "private, no-store").send(asset.bytes); });
  app.get("/api/runs", async () => repo.listRuns());
  app.get("/api/runs/:id", async (request) => repo.getRun((request.params as { id: string }).id));
  app.post("/api/runs", async (request, reply) => { const body = request.body as { operation?: Operation }; if (body.operation === "videoGenerate") return reply.status(202).send(service.createVideoRun(videoInput.parse(body))); return reply.status(201).send(await service.createImageRun(imageInput.parse(body))); });
  app.delete("/api/runs/:id", async (request, reply) => { repo.deleteRun((request.params as { id: string }).id); reply.status(204).send(); });
  app.post("/api/runs/:id/cancel", async (request) => service.cancelRun((request.params as { id: string }).id));
  app.get("/api/runs/:id/curl", async (request) => { const run = repo.getRun((request.params as { id: string }).id); return { curl: curlFor(run, repo.getProfile(run.profileId), repo.getModel(run.modelId)) }; });
  app.get("/api/jobs/:runId", async (request) => repo.getJobForRun((request.params as { runId: string }).runId));
  app.get("/api/batches", async () => service.listBatchJobs());
  app.post("/api/batches", async (request, reply) => reply.status(201).send(service.createBatchJob(batchCreateInput.parse(request.body))));
  app.get("/api/batches/:id", async (request) => service.getBatchJob((request.params as { id: string }).id));
  app.delete("/api/batches/:id", async (request, reply) => { service.deleteBatchJob((request.params as { id: string }).id); reply.status(204).send(); });
  app.post("/api/batches/:id/entries", async (request, reply) => reply.status(201).send(service.addBatchEntry({ batchJobId: (request.params as { id: string }).id, ...batchEntryInput.parse(request.body) })));
  app.delete("/api/batches/:id/entries/:entryId", async (request, reply) => { service.deleteBatchEntry((request.params as { entryId: string }).entryId); reply.status(204).send(); });
  app.post("/api/batches/:id/submit", async (request) => service.submitBatchJob((request.params as { id: string }).id));
  app.post("/api/batches/:id/cancel", async (request) => service.cancelBatchJob((request.params as { id: string }).id));
  app.get("/api/batches/:id/jsonl", async (request, reply) => { const text = service.previewBatchJsonl((request.params as { id: string }).id); reply.header("content-type", "application/jsonl").header("content-disposition", `attachment; filename="batch-${(request.params as { id: string }).id}.jsonl"`).send(text); });
  app.post("/api/settings/clear-history", async (_request, reply) => { repo.clearHistory(); reply.status(204).send(); });
  await installClient(app); runner.start();
  app.addHook("onClose", async () => { runner.stop(); database.sqlite.close(); });
  return app;
}
