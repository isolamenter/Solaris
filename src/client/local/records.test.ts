import { describe, expect, it } from "vitest";
import type { DraftRecord, LocalRunRecord } from "../../shared/local.js";
import { parseDraft, parseLocalRun, parseSession, serializeDraft, serializeLocalRun, serializeSession } from "./records.js";

const draft: DraftRecord = {
  id: "0f2a1c4e-0000-4000-8000-000000000002",
  connectionId: null,
  modelId: "0f2a1c4e-0000-4000-8000-000000000003",
  prompt: "a quiet solar observatory",
  parameters: { aspectRatio: "16:9", imageSize: "4K", googleSearch: false, steps: 4 },
  references: [
    {
      id: "0f2a1c4e-0000-4000-8000-000000000004",
      filePath: "/Users/someone/Pictures/source.png",
      mimeType: "image/png",
      sha256: "0".repeat(64),
      byteSize: 1024,
    },
  ],
  updatedAt: "2026-09-29T10:00:00.000Z",
};

const run: LocalRunRecord = {
  runId: "0f2a1c4e-0000-4000-8000-000000000005",
  submissionId: "0f2a1c4e-0000-4000-8000-000000000006",
  images: [
    { index: 0, filePath: "/tmp/solaris/a.png", state: "saved", byteSize: 2048, mimeType: "image/png" },
    { index: 1, filePath: null, state: "unsaved", byteSize: 0, mimeType: "image/webp" },
  ],
  updatedAt: "2026-09-29T10:00:00.000Z",
};

describe("drafts", () => {
  it("round-trips", () => {
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  it("refuses a document that is not a draft", () => {
    for (const document of [
      "null",
      "{}",
      JSON.stringify({ ...draft, id: "" }),
      JSON.stringify({ ...draft, prompt: 7 }),
      JSON.stringify({ ...draft, parameters: { nested: { a: 1 } } }),
      JSON.stringify({ ...draft, references: "none" }),
      JSON.stringify({ ...draft, updatedAt: "yesterday" }),
      JSON.stringify({ ...draft, references: [{ ...draft.references[0], byteSize: -1 }] }),
      "not json",
    ]) {
      expect(() => parseDraft(document)).toThrow();
    }
  });
});

describe("local runs", () => {
  it("round-trips", () => {
    expect(parseLocalRun(serializeLocalRun(run))).toEqual(run);
  });

  it("refuses an unknown image state", () => {
    const broken = JSON.stringify({ ...run, images: [{ ...run.images[0], state: "downloaded" }] });
    expect(() => parseLocalRun(broken)).toThrow();
  });

  it("refuses a document that is not a run", () => {
    for (const document of ["[]", "{}", JSON.stringify({ ...run, images: null }), JSON.stringify({ ...run, runId: 1 })]) {
      expect(() => parseLocalRun(document)).toThrow();
    }
  });
});

describe("sessions", () => {
  const session = {
    token: "opaque-token",
    expiresAt: "2026-09-30T10:00:00.000Z",
    user: { id: "0f2a1c4e-0000-4000-8000-000000000007", displayName: null, createdAt: "2026-09-01T10:00:00.000Z" },
  };

  it("round-trips", () => {
    expect(parseSession(serializeSession(session))).toEqual(session);
  });

  it("refuses a document that is not a session", () => {
    for (const document of ["{}", JSON.stringify({ ...session, token: "" }), JSON.stringify({ ...session, user: {} }), "junk"]) {
      expect(() => parseSession(document)).toThrow();
    }
  });
});
