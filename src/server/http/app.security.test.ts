import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentDigest } from "../../shared/digest.js";
import type { ConnectionRow, ModelRow } from "../interfaces.js";
import { sessionTokenHash } from "../auth/index.js";
import { captureConsole, createTestDeployment, multipartBody, requestField, stubImageGeneration, TEST_AUTHORITY, TEST_ORIGIN, type TestDeployment } from "./testSupport.js";

/**
 * HTTP-level authorization and secret handling (CONTRACTS §3, §8, §9).
 *
 * Every test goes through the real application — boundary, session
 * authentication, route schemas, service, repository — so an ownership rule is
 * proven where a client actually meets it. Nothing here claims a real upstream
 * or IdP call: the provider operation and the global fetch are stubbed.
 */

const SECRET = "sk-secret-key-value-do-not-leak-0123456789";

let deployment: TestDeployment;
let alice: { token: string; userId: string };
let bob: { token: string; userId: string };
let aliceConnection: ConnectionRow;
let aliceModel: ModelRow;
let bobConnection: ConnectionRow;
let bobModel: ModelRow;
let upstream: { calls: number; restore(): void };

beforeEach(async () => {
  deployment = await createTestDeployment();
  alice = await deployment.signIn("Alice");
  bob = await deployment.signIn("Bob");
  aliceConnection = deployment.connect(alice.userId, { name: "alice-gateway", apiKey: SECRET });
  aliceModel = deployment.addModel(alice.userId, aliceConnection.id);
  bobConnection = deployment.connect(bob.userId, { name: "bob-gateway" });
  bobModel = deployment.addModel(bob.userId, bobConnection.id);
  upstream = stubImageGeneration([{ bytes: Buffer.from("alice-image-bytes"), mimeType: "image/png" }]);
});

afterEach(async () => {
  upstream.restore();
  vi.unstubAllGlobals();
  await deployment.close();
});

async function fieldFor(connectionId: string, modelId: string, submissionId: string, prompt = "draw a circle") {
  return requestField({
    connectionId,
    modelId,
    prompt,
    submissionId,
    contentDigest: await contentDigest({ connectionId, modelId, prompt, parameters: null, references: [] }),
  });
}

async function generate(input: { token: string; connectionId: string; modelId: string; submissionId?: string; prompt?: string }) {
  const submissionId = input.submissionId ?? randomUUID();
  const { body, contentType } = multipartBody([await fieldFor(input.connectionId, input.modelId, submissionId, input.prompt)]);
  return deployment.call({
    method: "POST",
    url: "/api/generations",
    token: input.token,
    payload: body,
    headers: { "content-type": contentType },
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("session credentials", () => {
  it("refuses every account route without a usable session", async () => {
    const routes = [
      { method: "GET" as const, url: "/api/me" },
      { method: "GET" as const, url: "/api/adapters" },
      { method: "GET" as const, url: "/api/connections" },
      { method: "POST" as const, url: "/api/connections" },
      { method: "GET" as const, url: "/api/runs" },
      { method: "POST" as const, url: "/api/auth/logout" },
      { method: "POST" as const, url: "/api/generations" },
    ];
    const credentials = [undefined, "", "Bearer", "Bearer ", "Basic YWxpY2U6c2VjcmV0", "Bearer not-a-session"];
    for (const route of routes) {
      for (const authorization of credentials) {
        const response = await deployment.call({
          method: route.method,
          url: route.url,
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(response.statusCode, `${route.method} ${route.url} [${authorization ?? "no header"}]`).toBe(401);
        expect(response.json().error.code, `${route.method} ${route.url}`).toBe("AUTH_REQUIRED");
      }
    }
  });

  it("refuses an expired session", async () => {
    const token = randomUUID();
    deployment.repository.createSession({
      id: randomUUID(),
      userId: alice.userId,
      tokenHash: sessionTokenHash(token),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const response = await deployment.call({ method: "GET", url: "/api/me", token });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a revoked session", async () => {
    const token = randomUUID();
    const sessionId = randomUUID();
    deployment.repository.createSession({
      id: sessionId,
      userId: alice.userId,
      tokenHash: sessionTokenHash(token),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    deployment.repository.revokeSession(sessionId, alice.userId);
    const response = await deployment.call({ method: "GET", url: "/api/me", token });
    expect(response.statusCode).toBe(401);
  });

  it("takes identity from the session, never from the request", async () => {
    const response = await deployment.call({
      method: "POST",
      url: "/api/connections",
      token: alice.token,
      payload: { name: "mine", adapterId: "gemini", baseUrl: "https://gateway.example.test", apiKey: SECRET, userId: bob.userId, id: randomUUID() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(deployment.repository.listConnections(bob.userId)).toHaveLength(1);
  });

  it("logs out only the calling session", async () => {
    const second = await deployment.auth.sessions.issue(alice.userId);
    const loggedOut = await deployment.call({ method: "POST", url: "/api/auth/logout", token: alice.token });
    expect(loggedOut.statusCode).toBe(204);
    expect((await deployment.call({ method: "GET", url: "/api/me", token: alice.token })).statusCode).toBe(401);
    expect((await deployment.call({ method: "GET", url: "/api/me", token: second.token })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cross-user access
// ---------------------------------------------------------------------------

describe("cross-user access", () => {
  it("lists only the caller's connections and models", async () => {
    const connections = await deployment.call({ method: "GET", url: "/api/connections", token: alice.token });
    expect(connections.json()).toHaveLength(1);
    expect(connections.json()[0]).toMatchObject({ id: aliceConnection.id, name: "alice-gateway" });

    const bobModels = await deployment.call({ method: "GET", url: `/api/connections/${aliceConnection.id}/models`, token: bob.token });
    expect(bobModels.statusCode).toBe(404);
    expect(bobModels.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses every connection and model route for another user's resource", async () => {
    const calls = [
      { method: "PUT" as const, url: `/api/connections/${bobConnection.id}`, payload: { name: "hijack", baseUrl: "https://gateway.example.test", enabled: true } },
      { method: "DELETE" as const, url: `/api/connections/${bobConnection.id}` },
      { method: "POST" as const, url: `/api/connections/${bobConnection.id}/test` },
      { method: "GET" as const, url: `/api/connections/${bobConnection.id}/models` },
      { method: "POST" as const, url: `/api/connections/${bobConnection.id}/models/refresh` },
      { method: "POST" as const, url: `/api/connections/${bobConnection.id}/models`, payload: { providerModelId: "injected", capabilities: ["imageGenerate"] } },
      { method: "DELETE" as const, url: `/api/models/${bobModel.id}` },
    ];
    for (const call of calls) {
      const response = await deployment.call({ ...call, token: alice.token });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(404);
      expect(response.json().error.code, `${call.method} ${call.url}`).toBe("NOT_FOUND");
    }
    // Bob's resources are untouched.
    expect(deployment.repository.listConnections(bob.userId)).toHaveLength(1);
    expect(deployment.repository.listModels(bob.userId, bobConnection.id)).toHaveLength(1);
  });

  it("refuses to generate against another user's connection, without calling upstream", async () => {
    const response = await generate({ token: alice.token, connectionId: bobConnection.id, modelId: bobModel.id });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    expect(upstream.calls).toBe(0);
  });

  it("refuses to generate with another user's model id", async () => {
    const response = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: bobModel.id });
    expect(response.statusCode).toBe(404);
    expect(upstream.calls).toBe(0);
  });

  it("keeps run history, delivery and deletion inside the caller's own scope", async () => {
    const bobRun = await generate({ token: bob.token, connectionId: bobConnection.id, modelId: bobModel.id });
    expect(bobRun.statusCode).toBe(200);
    const bobRunId = bobRun.json().run.id as string;
    const bobSubmission = bobRun.json().submissionId as string;

    const read = await deployment.call({ method: "GET", url: `/api/runs/${bobRunId}`, token: alice.token });
    expect(read.statusCode).toBe(404);
    const remove = await deployment.call({ method: "DELETE", url: `/api/runs/${bobRunId}`, token: alice.token });
    expect(remove.statusCode).toBe(404);

    const aliceRuns = await deployment.call({ method: "GET", url: "/api/runs", token: alice.token });
    expect(aliceRuns.json().items).toEqual([]);

    // Alice's replay of Bob's submission id is her own run: the delivery cache
    // is keyed by (user, submission) and is never read across users.
    upstream.restore();
    upstream = stubImageGeneration([{ bytes: Buffer.from("alice-image-bytes"), mimeType: "image/png" }]);
    const aliceReplay = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: aliceModel.id, submissionId: bobSubmission });
    expect(aliceReplay.statusCode).toBe(200);
    const delivered = aliceReplay.json().result;
    expect(delivered.kind).toBe("delivered");
    expect(Buffer.from(delivered.images[0].dataBase64, "base64").toString()).toBe("alice-image-bytes");
    expect(upstream.calls).toBe(1);

    // Bob's history is intact and still his.
    const bobRuns = await deployment.call({ method: "GET", url: "/api/runs", token: bob.token });
    expect(bobRuns.json().items).toHaveLength(1);
  });

  it("does not let one user free another user's replay cache", async () => {
    const submission = randomUUID();
    const first = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: aliceModel.id, submissionId: submission });
    expect(first.statusCode).toBe(200);
    const aliceRunId = first.json().run.id as string;

    // Bob deletes a run of his own that happens to use the same submission id.
    const bobRun = await generate({ token: bob.token, connectionId: bobConnection.id, modelId: bobModel.id, submissionId: submission });
    await deployment.call({ method: "DELETE", url: `/api/runs/${bobRun.json().run.id}`, token: bob.token });

    const replay = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: aliceModel.id, submissionId: submission });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().run.id).toBe(aliceRunId);
    expect(replay.json().result.kind).toBe("delivered");
    expect(upstream.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Credentials at rest and on the wire
// ---------------------------------------------------------------------------

describe("credentials", () => {
  it("never returns the stored key, only hasKey", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/connections", token: alice.token });
    expect(response.body).not.toContain(SECRET);
    expect(response.json()[0]).toMatchObject({ hasKey: true });
    expect(Object.keys(response.json()[0]).sort()).toEqual(
      ["adapterId", "baseUrl", "config", "createdAt", "enabled", "hasKey", "id", "lastTest", "name", "updatedAt"].sort(),
    );
  });

  it("never echoes the key in an error body", async () => {
    const console_ = captureConsole();
    try {
      // A shape error on create, with the key in the submitted payload.
      const created = await deployment.call({
        method: "POST",
        url: "/api/connections",
        token: alice.token,
        payload: { name: "", adapterId: "gemini", baseUrl: "https://gateway.example.test", apiKey: SECRET },
      });
      expect(created.statusCode).toBe(400);
      expect(created.body).not.toContain(SECRET);

      // A fault raised deep in the provider path, where the request URL — and
      // the `?key=` it carries — is already in scope. (The provider layer
      // reports the rejected base URL as `UPSTREAM_UNAVAILABLE`/502; whatever
      // the code, the body must not carry the submitted key.)
      const insecure = deployment.connect(alice.userId, { name: "insecure", baseUrl: "http://plaintext.example.test", apiKey: SECRET });
      const tested = await deployment.call({ method: "POST", url: `/api/connections/${insecure.id}/test`, token: alice.token });
      expect(tested.statusCode).toBeGreaterThanOrEqual(400);
      expect(tested.body).not.toContain(SECRET);
    } finally {
      console_.restore();
    }
    expect(console_.output.join("\n")).not.toContain(SECRET);
  });

  it("reports a missing credential as CREDENTIAL_MISSING without creating a run or calling upstream", async () => {
    const bare = deployment.repository.createConnection({
      userId: alice.userId,
      id: randomUUID(),
      name: "no-key",
      adapterId: "gemini",
      baseUrl: "https://gateway.example.test",
      config: {},
      keyEncrypted: "",
    });
    const model = deployment.addModel(alice.userId, bare.id);
    const response = await generate({ token: alice.token, connectionId: bare.id, modelId: model.id });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CREDENTIAL_MISSING");
    expect(upstream.calls).toBe(0);
    const runs = await deployment.call({ method: "GET", url: "/api/runs", token: alice.token });
    expect(runs.json().items).toEqual([]);
  });

  it("never resolves another user's connection to decrypt a key", async () => {
    // Bob's connection id is Alice's request: the vault is never reached,
    // because ownership is checked before any ciphertext is touched.
    const response = await deployment.call({ method: "POST", url: `/api/connections/${bobConnection.id}/test`, token: alice.token });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Secret non-leakage through a failing and a succeeding upstream call
// ---------------------------------------------------------------------------

describe("upstream output never carries a secret or an image into history", () => {
  /** A gateway that echoes the request — key included — back to the caller. */
  function stubGateway(response: () => Response): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(response());
    });
    return { urls };
  }

  it("does not leak the key or upstream text into a failed run's error, envelope or logs", async () => {
    // The real provider transport runs; only the socket it would use is stubbed.
    // A rejecting gateway answers a determinate failure (`error`), an
    // unavailable one an indeterminate failure (`uncertain`); neither may carry
    // the request URL, the key, or anything else the gateway said.
    upstream.restore();
    const base64Image = Buffer.from(randomUUID().repeat(40)).toString("base64");
    for (const failure of [
      { status: 400, runStatus: "error", reason: "not-generated" },
      { status: 503, runStatus: "uncertain", reason: "submission-unknown" },
    ] as const) {
      const console_ = captureConsole();
      let body: string;
      const gateway = stubGateway(
        () =>
          new Response(
            `{"error":{"message":"invalid key: POST /v1beta/models/x:generateContent?key=${SECRET}","inlineData":{"data":"${base64Image}"}}}`,
            { status: failure.status },
          ),
      );
      try {
        const response = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: aliceModel.id });
        body = response.body;
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe(failure.runStatus);
        expect(response.json().result).toEqual({ kind: "unavailable", reason: failure.reason });
        expect(response.json().run.errorMessage).toBeUndefined();
        const run = await deployment.call({ method: "GET", url: `/api/runs/${response.json().run.id}`, token: alice.token });
        expect(run.body).not.toContain(SECRET);
        expect(run.body).not.toContain(base64Image);
        // History is metadata only: no image bytes, ever.
        expect(JSON.stringify(run.json())).not.toContain("dataBase64");
      } finally {
        console_.restore();
      }
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(base64Image);
      expect(console_.output.join("\n")).not.toContain(SECRET);
      expect(console_.output.join("\n")).not.toContain(base64Image);
      expect(gateway.urls[0]).toContain(SECRET);
    }
  });

  it("delivers image bytes once and keeps them out of history and logs", async () => {
    const imageBytes = Buffer.from("a-real-image-payload");
    upstream.restore();
    vi.stubGlobal(
      "fetch",
      () => Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: imageBytes.toString("base64") } }] } }] }), { status: 200 })),
    );
    const console_ = captureConsole();
    let body: string;
    let runId: string;
    try {
      const response = await generate({ token: alice.token, connectionId: aliceConnection.id, modelId: aliceModel.id });
      body = response.body;
      runId = response.json().run.id as string;
      expect(response.json().result.kind).toBe("delivered");
      expect(Buffer.from(response.json().result.images[0].dataBase64, "base64").toString()).toBe("a-real-image-payload");
    } finally {
      console_.restore();
    }
    const run = await deployment.call({ method: "GET", url: `/api/runs/${runId}`, token: alice.token });
    expect(run.body).not.toContain(imageBytes.toString("base64"));
    expect(JSON.stringify(run.json())).not.toContain("dataBase64");
    expect(console_.output.join("\n")).not.toContain(imageBytes.toString("base64"));
    expect(body).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Boundary interaction with the authenticated surface
// ---------------------------------------------------------------------------

describe("the boundary and the session are independent gates", () => {
  it("rejects a valid session presented on a forged host", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/connections", token: alice.token, headers: { host: "attacker.example" } });
    expect(response.statusCode).toBe(421);
  });

  it("rejects a valid session presented from a forged origin", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/connections", token: alice.token, headers: { origin: "https://attacker.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("accepts the desktop client's shape: bearer token, no Origin, configured host", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/connections", token: alice.token });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
  });

  it("serves the configured origin and refuses a lookalike", async () => {
    const good = await deployment.call({ method: "GET", url: "/api/deployment", headers: { origin: TEST_ORIGIN } });
    expect(good.statusCode).toBe(200);
    const lookalike = await deployment.call({ method: "GET", url: "/api/deployment", headers: { origin: `https://${TEST_AUTHORITY}.attacker.example` } });
    expect(lookalike.statusCode).toBe(403);
  });
});
