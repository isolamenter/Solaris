import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentDigest, sha256Hex } from "../../shared/digest.js";
import { geminiModelOperationConfig } from "../providers/geminiAdapter.js";
import { referenceTransportBounds } from "./app.js";
import { createTestDeployment, multipartBody, requestField, stubImageGeneration, TINY_PNG, type MultipartPart, type TestDeployment } from "./testSupport.js";

/**
 * Upload limits (CONTRACTS §4.1).
 *
 * Two layers, and the test insists on the ordering between them: the per-model
 * policy (count, MIME type, per-file and total size) gives the user a frozen
 * code and a model-specific message, and the multipart transport bound sits one
 * step above it as a backstop. Whatever layer answers, the code is frozen and
 * never `INTERNAL` — an overflow is a client error, not a server fault.
 *
 * Nothing here makes a real model call: the provider operation is stubbed, so
 * the bytes that are accepted for a reference never leave the process.
 */

const MIB = 1024 * 1024;

let deployment: TestDeployment;
let userId: string;
let token: string;
let connectionId: string;
let modelId: string;
let upstream: { calls: number; restore(): void };

beforeEach(async () => {
  deployment = await createTestDeployment();
  const user = await deployment.signIn("Alice");
  userId = user.userId;
  token = user.token;
  connectionId = deployment.connect(userId, { apiKey: "test-key-value" }).id;
  modelId = deployment.addModel(userId, connectionId).id;
  upstream = stubImageGeneration([{ bytes: TINY_PNG, mimeType: "image/png" }]);
});

afterEach(async () => {
  upstream.restore();
  await deployment.close();
});

/** Builds a reference part whose declared type and bytes the test controls. */
function reference(bytes: Buffer, mimeType = "image/png"): MultipartPart {
  return { kind: "file", name: "reference", filename: "reference.png", mimeType, bytes };
}

async function post(parts: MultipartPart[]) {
  const { body, contentType } = multipartBody(parts);
  return deployment.call({
    method: "POST",
    url: "/api/generations",
    token,
    payload: body,
    headers: { "content-type": contentType },
  });
}

/** Posts a request whose `contentDigest` covers exactly these reference bytes. */
async function generate(references: Buffer[], extra: MultipartPart[] = [], prompt = "draw a circle") {
  const field = requestField({
    connectionId,
    modelId,
    prompt,
    submissionId: randomUUID(),
    contentDigest: await contentDigest({
      connectionId,
      modelId,
      prompt,
      parameters: null,
      references: await Promise.all(references.map(async (bytes) => ({ mimeType: "image/png", sha256: await sha256Hex(bytes) }))),
    }),
  });
  return post([field, ...extra, ...references.map((bytes) => reference(bytes))]);
}

/** Every rejection is a frozen client-error code; a 500 is never acceptable. */
async function expectRejection(response: Awaited<ReturnType<typeof post>>, status: number, code: string) {
  expect(response.statusCode, response.body.slice(0, 300)).toBe(status);
  expect(response.json().error.code).toBe(code);
  expect(response.json().error.code).not.toBe("INTERNAL");
  expect(response.statusCode).toBeLessThan(500);
  // A rejected upload never reaches upstream.
  expect(upstream.calls).toBe(0);
}

describe("the transport bound is looser than every policy the adapters declare", () => {
  it("orders each transport bound above the declared attachment policy", () => {
    const models = ["gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", "gemini-3-pro-image", "gemini-3.1-flash-lite-image"];
    for (const model of models) {
      const policy = geminiModelOperationConfig(model, "imageGenerate")?.dto.attachments;
      if (policy === undefined) throw new Error(`${model} declares no attachment policy; this test needs updating`);
      expect(policy.maxCount, model).toBeLessThan(referenceTransportBounds.count);
      expect(policy.maxFileBytes, model).toBeLessThan(referenceTransportBounds.fileBytes);
      expect(policy.maxTotalBytes, model).toBeLessThan(referenceTransportBounds.totalBytes);
    }
  });

  it("accepts a policy-compliant reference and reaches the model", async () => {
    const response = await generate([TINY_PNG]);
    expect(response.statusCode).toBe(200);
    expect(response.json().result.kind).toBe("delivered");
    expect(upstream.calls).toBe(1);
  });
});

describe("the per-model policy answers before the transport does", () => {
  it("rejects one reference more than the model accepts", async () => {
    const policy = geminiModelOperationConfig("gemini-3.1-flash-image", "imageGenerate")?.dto.attachments;
    if (policy === undefined) throw new Error("no policy");
    const response = await generate(Array.from({ length: policy.maxCount + 1 }, () => TINY_PNG));
    await expectRejection(response, 400, "REFERENCE_COUNT");
    // The model's own message, not the transport's: the policy is what answered.
    expect(response.json().error.message).toContain(`at most ${policy.maxCount}`);
  });

  it("rejects a reference the model does not accept, by type", async () => {
    const field = requestField({
      connectionId,
      modelId,
      submissionId: randomUUID(),
      contentDigest: await contentDigest({ connectionId, modelId, prompt: "draw a circle", parameters: null, references: [] }),
    });
    const response = await post([field, reference(Buffer.from("%PDF-1.4 not an image"), "application/pdf")]);
    await expectRejection(response, 415, "REFERENCE_TYPE");
  });

  it("rejects a single file just over the model's per-file limit, not the transport's", async () => {
    const policy = geminiModelOperationConfig("gemini-3.1-flash-image", "imageGenerate")?.dto.attachments;
    if (policy === undefined) throw new Error("no policy");
    const oversized = Buffer.alloc(policy.maxFileBytes + 1, 0x89);
    const response = await generate([oversized]);
    await expectRejection(response, 413, "REFERENCE_SIZE");
    // The model's limit, not the transport's one-mebibyte-looser backstop.
    expect(response.json().error.message).toContain(`${Math.floor(policy.maxFileBytes / MIB)} MB`);
    expect(response.json().error.message).not.toContain(`${Math.floor(referenceTransportBounds.fileBytes / MIB)} MB`);
  });

  it("rejects a total just over the model's total limit, not the transport's", async () => {
    const policy = geminiModelOperationConfig("gemini-3.1-flash-image", "imageGenerate")?.dto.attachments;
    if (policy === undefined) throw new Error("no policy");
    // Two files, each inside the per-file limit, together above the total one.
    const half = Buffer.alloc(Math.ceil(policy.maxTotalBytes / 2) + 1, 0x89);
    expect(half.byteLength).toBeLessThanOrEqual(policy.maxFileBytes);
    const response = await generate([half, half]);
    await expectRejection(response, 413, "REFERENCE_TOTAL_SIZE");
    expect(response.json().error.message).toContain(`${Math.floor(policy.maxTotalBytes / MIB)} MB`);
  });
});

describe("the transport backstop still bounds what is buffered", () => {
  it("refuses more parts than the quota allows, as REFERENCE_COUNT", async () => {
    const response = await generate(Array.from({ length: referenceTransportBounds.count + 1 }, () => TINY_PNG));
    await expectRejection(response, 400, "REFERENCE_COUNT");
  });

  it("refuses a file over the transport's own byte bound, as REFERENCE_SIZE", async () => {
    const response = await generate([Buffer.alloc(referenceTransportBounds.fileBytes + 1)]);
    await expectRejection(response, 413, "REFERENCE_SIZE");
  });

  it("refuses a body whose running total crosses the transport bound, as REFERENCE_TOTAL_SIZE", async () => {
    const chunk = Buffer.alloc(referenceTransportBounds.fileBytes);
    const response = await generate([chunk, chunk, chunk]);
    await expectRejection(response, 413, "REFERENCE_TOTAL_SIZE");
  });

  it("refuses a request field over its own bound, as VALIDATION", async () => {
    const field = requestField({
      connectionId,
      modelId,
      submissionId: randomUUID(),
      prompt: "x".repeat(1_100_000),
      contentDigest: "0".repeat(64),
    });
    const response = await post([field]);
    await expectRejection(response, 400, "VALIDATION");
  });
});

describe("the §13 delivery budget reaches the service through the app", () => {
  it("keeps a result over SOLARIS_IMAGE_RESULT_MAX_BYTES successful but undeliverable", async () => {
    // The budget is the configuration the process passes in, so this is what
    // catches the value not being wired through the composition at all.
    const image = { bytes: Buffer.alloc(64, 7), mimeType: "image/png" };
    const small = await createTestDeployment({ imageResultMaxBytes: 32 });
    const stub = stubImageGeneration([image]);
    try {
      const user = await small.signIn("Budget");
      const connection = small.connect(user.userId, { apiKey: "test-key-value" });
      const model = small.addModel(user.userId, connection.id);
      const prompt = "draw a circle";
      const field = requestField({
        connectionId: connection.id,
        modelId: model.id,
        prompt,
        submissionId: randomUUID(),
        contentDigest: await contentDigest({ connectionId: connection.id, modelId: model.id, prompt, parameters: null, references: [] }),
      });
      const { body: request, contentType } = multipartBody([field]);
      const response = await small.call({
        method: "POST",
        url: "/api/generations",
        token: user.token,
        payload: request,
        headers: { "content-type": contentType },
      });
      expect(response.statusCode).toBe(200);
      const envelope = response.json();
      // The generation stands; only the delivery does not — and no byte of it
      // is sent, or cached for a replay.
      expect(envelope.status).toBe("success");
      expect(envelope.result).toEqual({ kind: "unavailable", reason: "result-too-large" });
      expect(envelope.run.images).toEqual([{ mimeType: "image/png", byteSize: 64 }]);
      expect(response.body).not.toContain(image.bytes.toString("base64"));
    } finally {
      stub.restore();
      await small.close();
    }
  });
});

describe("malformed generation requests are client errors", () => {
  it("refuses a body that is not multipart, and one with no request field", async () => {
    const json = await deployment.call({ method: "POST", url: "/api/generations", token, payload: { prompt: "hello" } });
    await expectRejection(json, 400, "VALIDATION");

    const empty = await post([]);
    await expectRejection(empty, 400, "VALIDATION");
  });

  it("refuses a request field that is not JSON, and one with an unknown shape", async () => {
    const notJson = await post([{ kind: "field", name: "request", value: "{not json" }]);
    await expectRejection(notJson, 400, "VALIDATION");

    const wrongShape = await post([{ kind: "field", name: "request", value: JSON.stringify({ prompt: "hello" }) }]);
    await expectRejection(wrongShape, 400, "VALIDATION");

    const extraKey = await post([
      {
        kind: "field",
        name: "request",
        value: JSON.stringify({ connectionId, modelId, prompt: "hello", submissionId: randomUUID(), contentDigest: "0".repeat(64), userId: "smuggled" }),
      },
    ]);
    await expectRejection(extraKey, 400, "VALIDATION");
  });

  it("refuses a file sent under an unexpected field name", async () => {
    const field = requestField({ connectionId, modelId, submissionId: randomUUID(), contentDigest: "0".repeat(64) });
    const response = await post([field, { kind: "file", name: "upload", filename: "a.png", mimeType: "image/png", bytes: TINY_PNG }]);
    await expectRejection(response, 400, "VALIDATION");
  });

  it("refuses a digest that does not describe the bytes that arrived", async () => {
    const field = requestField({ connectionId, modelId, submissionId: randomUUID(), contentDigest: "a".repeat(64) });
    const response = await post([field]);
    await expectRejection(response, 400, "DIGEST_MISMATCH");
  });

  it("refuses a disabled connection with CONNECTION_DISABLED", async () => {
    const connection = deployment.repository.getConnection(userId, connectionId);
    deployment.repository.updateConnection(userId, connectionId, {
      name: connection.name,
      baseUrl: connection.baseUrl,
      config: connection.config,
      enabled: false,
    });
    const response = await generate([TINY_PNG]);
    await expectRejection(response, 409, "CONNECTION_DISABLED");
  });
});
