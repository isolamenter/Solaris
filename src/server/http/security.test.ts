import { describe, expect, it } from "vitest";
import { assertLoopbackHost, assertSameOrigin } from "./security.js";

describe("local BFF boundary", () => {
  it("rejects non-loopback Host headers", () => {
    expect(() => assertLoopbackHost({ headers: { host: "evil.example" } } as never, 3210)).toThrow("loopback host");
    expect(() => assertLoopbackHost({ headers: { host: "127.0.0.1:3210" } } as never, 3210)).not.toThrow();
  });
  it("requires the exact local origin for writes", () => {
    expect(() => assertSameOrigin({ headers: { origin: "http://evil.example" } } as never, 3210)).toThrow("Cross-origin");
    expect(() => assertSameOrigin({ headers: { origin: "http://127.0.0.1:3210" } } as never, 3210)).not.toThrow();
  });
});
