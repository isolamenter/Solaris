import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, createTestDeployment, TEST_ORIGIN, type TestDeployment } from "./testSupport.js";

/**
 * The deployment boundary as the application enforces it: before any route
 * handler, with transport statuses that are distinguishable from a real fault,
 * and with the trusted-proxy hop count actually controlling what the server
 * believes about a request.
 */

let deployment: TestDeployment;

afterEach(async () => {
  await deployment.close();
});

describe("the boundary in front of every route", () => {
  beforeEach(async () => {
    deployment = await createTestDeployment();
  });

  it("serves the configured host", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, bind: "127.0.0.1" });
  });

  it("refuses a forged Host with 421 and a transport code, never INTERNAL", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/health", headers: { host: "attacker.example" } });
    expect(response.statusCode).toBe(421);
    expect(response.json()).toEqual({ error: { code: "HOST_REJECTED", message: "This Solaris Server does not serve the requested host" } });
  });

  it("refuses a forged Origin with 403", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/deployment", headers: { origin: "https://attacker.example" } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "ORIGIN_REJECTED", message: "This origin is not allowed to call the Solaris API" } });
  });

  it("refuses an unknown path from a forged Host before routing decides it is unknown", async () => {
    const response = await deployment.call({ method: "GET", url: "/api/nothing-here", headers: { host: "attacker.example" } });
    expect(response.statusCode).toBe(421);
    expect(response.json().error.code).toBe("HOST_REJECTED");
  });

  it("accepts the allowed origin and a request with no Origin at all", async () => {
    const allowed = await deployment.call({ method: "GET", url: "/api/deployment", headers: { origin: TEST_ORIGIN } });
    expect(allowed.statusCode).toBe(200);
    const desktop = await deployment.call({ method: "GET", url: "/api/deployment" });
    expect(desktop.statusCode).toBe(200);
  });

  it("treats an absent Origin as a non-browser client, not as same-origin", async () => {
    // The request passes the boundary, and is then refused by authentication:
    // "no Origin" is never shorthand for "already trusted".
    const response = await deployment.call({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("never reaches a route handler behind a rejected boundary", async () => {
    const { token } = await deployment.signIn();
    // A perfectly valid session is still not served on a host the deployment
    // did not announce.
    const response = await deployment.call({ method: "GET", url: "/api/me", token, headers: { host: "attacker.example" } });
    expect(response.statusCode).toBe(421);
    expect(response.json().error.code).toBe("HOST_REJECTED");
  });

  it("reports the rejection to the operator, since the server runs with logger:false", async () => {
    const console_ = captureConsole();
    try {
      await deployment.call({ method: "GET", url: "/api/health", headers: { host: "attacker.example", origin: "https://attacker.example" } });
    } finally {
      console_.restore();
    }
    expect(console_.output).toHaveLength(1);
    expect(console_.output[0]).toContain("HOST_REJECTED");
    expect(console_.output[0]).toContain("attacker.example");
  });

  it("does not forge a log line from an attacker-controlled header", async () => {
    const console_ = captureConsole();
    try {
      await deployment.call({ method: "GET", url: "/api/health", headers: { host: "attacker.example\ninjected: yes" } });
    } finally {
      console_.restore();
    }
    expect(console_.output).toHaveLength(1);
    expect(console_.output[0]?.includes("\n")).toBe(false);
  });
});

describe("trusted proxy hops", () => {
  afterEach(async () => {
    await deployment.close();
  });

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    deployment = await createTestDeployment({ boundary: { trustProxy: "0" } });
    const response = await deployment.call({ method: "GET", url: "/api/health", headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } });
    expect(response.json().ip).toBe("127.0.0.1");
    expect(response.json().protocol).toBe("http");
  });

  it("honours exactly one hop when one proxy is trusted", async () => {
    deployment = await createTestDeployment({ boundary: { trustProxy: "1" } });
    const response = await deployment.call({ method: "GET", url: "/api/health", headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } });
    expect(response.json().ip).toBe("203.0.113.7");
    expect(response.json().protocol).toBe("https");
  });

  it("reads the address the configured number of hops from the socket, not the leftmost value", async () => {
    deployment = await createTestDeployment({ boundary: { trustProxy: "1" } });
    const response = await deployment.call({
      method: "GET",
      url: "/api/health",
      headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" },
    });
    // One trusted hop means the rightmost entry is the client; an attacker
    // prepending addresses cannot shift it.
    expect(response.json().ip).toBe("198.51.100.9");
  });

  it("falls back to the socket address when a trusted proxy forwards no address", async () => {
    deployment = await createTestDeployment({ boundary: { trustProxy: "1" } });
    const response = await deployment.call({ method: "GET", url: "/api/health" });
    expect(response.json().ip).toBe("127.0.0.1");
  });
});
