import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "./http.js";

describe("provider endpoint policy", () => {
  it("requires HTTPS provider endpoints", () => {
    expect(() => normalizeBaseUrl("http://127.0.0.1:11434/v1")).toThrow("must use HTTPS");
    expect(() => normalizeBaseUrl("http://provider.example/v1")).toThrow("must use HTTPS");
    expect(() => normalizeBaseUrl("https://provider.example/v1?redirect=x")).toThrow("cannot contain");
  });
});
