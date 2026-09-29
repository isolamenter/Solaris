import { describe, expect, it } from "vitest";
import { contentDigest, sha256Hex } from "../shared/digest.js";
import type { LocalStore } from "../shared/local.js";
import { createDraftRun, resolveReference } from "./generation.js";

const scope = { serverOrigin: "http://127.0.0.1:3210", userId: "user-1" };

function storeReturning(mimeType: string, bytes: Uint8Array): LocalStore {
  return {
    async readReferenceFile() {
      return { mimeType, bytes };
    },
  } as unknown as LocalStore;
}

const bytesA = new Uint8Array([1, 2, 3, 4]);
const bytesB = new Uint8Array([9, 9]);

async function reference(mimeType: string, bytes: Uint8Array, filePath: string) {
  return resolveReference(storeReturning(mimeType, bytes), scope, filePath);
}

describe("generation draft", () => {
  it("hashes the raw bytes read from the store", async () => {
    const resolved = await reference("image/png", bytesA, "/tmp/a.png");

    expect(resolved.byteSize).toBe(4);
    expect(resolved.sha256).toBe(await sha256Hex(bytesA));
  });

  it("digests exactly the frozen input, in file order, with absent parameters as null", async () => {
    const first = await reference("image/png", bytesA, "/tmp/a.png");
    const second = await reference("image/jpeg", bytesB, "/tmp/b.jpg");

    const draft = await createDraftRun({
      connectionId: "conn-1",
      modelId: "model-1",
      prompt: "a lighthouse at dusk",
      parameters: null,
      references: [first, second],
    });

    const expected = await contentDigest({
      connectionId: "conn-1",
      modelId: "model-1",
      prompt: "a lighthouse at dusk",
      parameters: null,
      references: [
        { mimeType: "image/png", sha256: first.sha256 },
        { mimeType: "image/jpeg", sha256: second.sha256 },
      ],
    });

    expect(draft.contentDigest).toBe(expected);
    expect(draft.request.contentDigest).toBe(expected);
    expect(draft.request.parameters).toBeUndefined();
    expect(draft.request.submissionId).toBe(draft.submissionId);
  });

  it("changes the digest when the reference order changes", async () => {
    const first = await reference("image/png", bytesA, "/tmp/a.png");
    const second = await reference("image/jpeg", bytesB, "/tmp/b.jpg");
    const base = { connectionId: "conn-1", modelId: "model-1", prompt: "p", parameters: null };

    const forward = await createDraftRun({ ...base, references: [first, second] });
    const reversed = await createDraftRun({ ...base, references: [second, first] });

    expect(forward.contentDigest).not.toBe(reversed.contentDigest);
  });

  it("gives every deliberate run a new submission id", async () => {
    const base = { connectionId: "conn-1", modelId: "model-1", prompt: "p", parameters: null, references: [] };

    const first = await createDraftRun(base);
    const second = await createDraftRun(base);

    expect(first.submissionId).not.toBe(second.submissionId);
    expect(first.contentDigest).toBe(second.contentDigest);
  });
});
