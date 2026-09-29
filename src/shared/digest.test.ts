import { describe, expect, it } from "vitest";
import { canonicalDigestInput, contentDigest, sha256Hex, stableStringify, type DigestInput } from "./digest.js";

/**
 * Fixed digest vectors — CONTRACTS §6.1 / §11.
 *
 * These pin the exact canonical string and hash. Client (B07) and Server (B05)
 * both consume this module, so a change here is a contract change: it invalidates
 * every stored `contentDigest` and every dedup receipt.
 */

const ref = (mimeType: string, sha256: string) => ({ mimeType, sha256 });

const base: DigestInput = {
  connectionId: "6f1c0c1e-4a1a-4f5e-9d3a-2b7c8e9f0a11",
  modelId: "2b7c8e9f-0a11-4a1a-4f5e-9d3a6f1c0c1e",
  prompt: "a red circle",
  parameters: null,
  references: [],
};

describe("stableStringify", () => {
  it("sorts object keys by code point and emits no whitespace", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested keys too", () => {
    expect(stableStringify({ z: { d: 4, c: 3 } })).toBe('{"z":{"c":3,"d":4}}');
  });

  it("keeps array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => stableStringify({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => stableStringify({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("rejects unsupported values", () => {
    expect(() => stableStringify({ n: undefined })).toThrow(/unsupported/);
  });
});

describe("canonicalDigestInput", () => {
  it("emits the frozen field set in sorted order, with absent parameters as null", () => {
    expect(canonicalDigestInput(base)).toBe(
      '{"connectionId":"6f1c0c1e-4a1a-4f5e-9d3a-2b7c8e9f0a11","modelId":"2b7c8e9f-0a11-4a1a-4f5e-9d3a6f1c0c1e","parameters":null,"prompt":"a red circle","references":[]}',
    );
  });

  it("distinguishes absent parameters from an empty object", () => {
    const absent = canonicalDigestInput(base);
    const empty = canonicalDigestInput({ ...base, parameters: {} });
    expect(empty).toBe(
      '{"connectionId":"6f1c0c1e-4a1a-4f5e-9d3a-2b7c8e9f0a11","modelId":"2b7c8e9f-0a11-4a1a-4f5e-9d3a6f1c0c1e","parameters":{},"prompt":"a red circle","references":[]}',
    );
    expect(empty).not.toBe(absent);
  });

  it("is insensitive to parameter key order but sensitive to values", () => {
    const a = canonicalDigestInput({ ...base, parameters: { aspectRatio: "1:1", imageSize: "1K" } });
    const b = canonicalDigestInput({ ...base, parameters: { imageSize: "1K", aspectRatio: "1:1" } });
    const c = canonicalDigestInput({ ...base, parameters: { imageSize: "2K", aspectRatio: "1:1" } });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("does not normalize the prompt", () => {
    expect(canonicalDigestInput({ ...base, prompt: "a red circle " })).not.toBe(canonicalDigestInput(base));
    expect(canonicalDigestInput({ ...base, prompt: "é" })).not.toBe(canonicalDigestInput({ ...base, prompt: "é" }));
  });

  it("is sensitive to reference order", () => {
    const one = ref("image/png", "aa");
    const two = ref("image/jpeg", "bb");
    expect(canonicalDigestInput({ ...base, references: [one, two] })).not.toBe(
      canonicalDigestInput({ ...base, references: [two, one] }),
    );
  });

  it("is sensitive to reference MIME and to reference content", () => {
    const original = canonicalDigestInput({ ...base, references: [ref("image/png", "aa")] });
    expect(canonicalDigestInput({ ...base, references: [ref("image/jpeg", "aa")] })).not.toBe(original);
    expect(canonicalDigestInput({ ...base, references: [ref("image/png", "ab")] })).not.toBe(original);
  });

  it("excludes any extra field the caller tries to add", () => {
    const withExtra = { ...base, providerModelId: "smuggled", size: "1024" } as unknown as DigestInput;
    expect(canonicalDigestInput(withExtra)).toBe(canonicalDigestInput(base));
  });
});

describe("contentDigest", () => {
  it("hashes the canonical string, UTF-8, lowercase hex", async () => {
    // Independently derived: `printf '%s' '<canonical string>' | shasum -a 256`.
    // Do not update this by copying the implementation's output.
    await expect(contentDigest(base)).resolves.toBe(
      "98c98d5a82c4d24cc5b4c848ccac6c8e2a078f31e58b37bf8e5284658599654a",
    );
  });

  it("is stable across repeated calls and distinct across inputs", async () => {
    expect(await contentDigest(base)).toBe(await contentDigest(base));
    expect(await contentDigest({ ...base, prompt: "a blue circle" })).not.toBe(await contentDigest(base));
  });

  it("matches the canonical string hashed by sha256Hex", async () => {
    const viaCanonical = await sha256Hex(new TextEncoder().encode(canonicalDigestInput(base)));
    expect(await contentDigest(base)).toBe(viaCanonical);
  });
});

describe("sha256Hex", () => {
  it("hashes raw bytes as lowercase hex", async () => {
    await expect(sha256Hex(new Uint8Array([]))).resolves.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
