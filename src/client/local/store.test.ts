import { describe, expect, it } from "vitest";
import type { SessionDto } from "../../shared/contracts.js";
import type { DraftRecord, LocalRunRecord, LocalScope } from "../../shared/local.js";
import type { FileContents, LocalBackend, RecordKind, SavedImageResult } from "./backend.js";
import { createLocalStore } from "./store.js";

const SERVER = "http://127.0.0.1:3210";
const scopeA: LocalScope = { serverOrigin: SERVER, userId: "user-a" };
const scopeB: LocalScope = { serverOrigin: SERVER, userId: "user-b" };
const scopeC: LocalScope = { serverOrigin: "https://other.example", userId: "user-a" };

const DRAFT_ID = "0f2a1c4e-0000-4000-8000-000000000002";

function draft(id = DRAFT_ID, updatedAt = "2026-09-29T10:00:00.000Z"): DraftRecord {
  return {
    id,
    connectionId: null,
    modelId: null,
    prompt: "a quiet solar observatory",
    parameters: { aspectRatio: "16:9" },
    references: [],
    updatedAt,
  };
}

function run(runId = "0f2a1c4e-0000-4000-8000-000000000005"): LocalRunRecord {
  return {
    runId,
    submissionId: "0f2a1c4e-0000-4000-8000-000000000006",
    images: [],
    updatedAt: "2026-09-29T10:00:00.000Z",
  };
}

const session = (token: string): SessionDto => ({
  token,
  expiresAt: "2026-09-30T10:00:00.000Z",
  user: { id: "user-a", displayName: null, createdAt: "2026-09-01T10:00:00.000Z" },
});

/** In-memory stand-in for the native layer. Records every call it is given. */
function createFakeBackend(options: { failSave?: boolean; corruptSession?: boolean } = {}) {
  const records = new Map<string, string>();
  const sessions = new Map<string, string>();
  const files = new Map<string, string>();
  const calls: { command: string; args: unknown[] }[] = [];
  const recordKey = (kind: RecordKind, scopeKey: string, recordId: string): string => `${kind}/${scopeKey}/${recordId}`;

  const backend: LocalBackend = {
    async beginLogin() {
      throw new Error("the login flow is not used by these tests");
    },
    async awaitLoginCallback() {
      throw new Error("the login flow is not used by these tests");
    },
    async cancelLogin() {
      calls.push({ command: "cancelLogin", args: [] });
    },
    async openExternalUrl(url) {
      calls.push({ command: "openExternalUrl", args: [url] });
    },
    async readSession(serverOrigin) {
      calls.push({ command: "readSession", args: [serverOrigin] });
      if (options.corruptSession === true) return "not a session";
      return sessions.get(serverOrigin) ?? null;
    },
    async writeSession(serverOrigin, document) {
      calls.push({ command: "writeSession", args: [serverOrigin, document] });
      sessions.set(serverOrigin, document);
    },
    async clearSession(serverOrigin) {
      calls.push({ command: "clearSession", args: [serverOrigin] });
      sessions.delete(serverOrigin);
    },
    async listRecords(kind, scopeKey) {
      calls.push({ command: "listRecords", args: [kind, scopeKey] });
      return [...records.entries()]
        .filter(([key]) => key.startsWith(`${kind}/${scopeKey}/`))
        .map(([, document]) => document);
    },
    async readRecord(kind, scopeKey, recordId) {
      calls.push({ command: "readRecord", args: [kind, scopeKey, recordId] });
      return records.get(recordKey(kind, scopeKey, recordId)) ?? null;
    },
    async writeRecord(kind, scopeKey, recordId, document) {
      calls.push({ command: "writeRecord", args: [kind, scopeKey, recordId, document] });
      records.set(recordKey(kind, scopeKey, recordId), document);
    },
    async deleteRecord(kind, scopeKey, recordId) {
      calls.push({ command: "deleteRecord", args: [kind, scopeKey, recordId] });
      records.delete(recordKey(kind, scopeKey, recordId));
    },
    async chooseReferenceFiles(scopeKey): Promise<string[]> {
      calls.push({ command: "chooseReferenceFiles", args: [scopeKey] });
      return [];
    },
    async readReferenceFile(scopeKey, filePath): Promise<FileContents> {
      calls.push({ command: "readReferenceFile", args: [scopeKey, filePath] });
      const data = files.get(filePath);
      if (data === undefined) throw new Error("the reference file is not available");
      return { dataBase64: data };
    },
    async chooseSaveDirectory(scopeKey) {
      calls.push({ command: "chooseSaveDirectory", args: [scopeKey] });
      return `/fake/${scopeKey}`;
    },
    async saveImage(input): Promise<SavedImageResult> {
      calls.push({ command: "saveImage", args: [input] });
      if (options.failSave === true) throw new Error("the local store failed: No space left on device");
      const filePath = `/fake/${input.scopeKey}/${input.fileName}`;
      files.set(filePath, input.dataBase64);
      return { filePath, byteSize: input.dataBase64.length };
    },
    async imageExists(scopeKey, filePath) {
      calls.push({ command: "imageExists", args: [scopeKey, filePath] });
      return files.has(filePath);
    },
    async readSavedImage(scopeKey, filePath): Promise<FileContents> {
      calls.push({ command: "readSavedImage", args: [scopeKey, filePath] });
      const data = files.get(filePath);
      if (data === undefined) throw new Error("the local store failed: no such file");
      return { dataBase64: data };
    },
    async revealInFileManager(scopeKey, filePath) {
      calls.push({ command: "revealInFileManager", args: [scopeKey, filePath] });
    },
  };

  return {
    backend,
    calls,
    files,
    commands: (name: string) => calls.filter((call) => call.command === name),
    recordKeys: () => [...records.keys()],
  };
}

describe("scope isolation", () => {
  it("never mixes two accounts", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.saveDraft(scopeA, { ...draft(), prompt: "account a" });
    await store.saveDraft(scopeB, { ...draft(), prompt: "account b" });

    expect((await store.listDrafts(scopeA)).map((entry) => entry.prompt)).toEqual(["account a"]);
    expect((await store.listDrafts(scopeB)).map((entry) => entry.prompt)).toEqual(["account b"]);
    // The same draft id in two accounts lands in two different records.
    expect(new Set(fake.recordKeys()).size).toBe(2);
  });

  it("never mixes two Servers, even for the same user", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.saveDraft(scopeA, draft());
    expect(await store.listDrafts(scopeC)).toEqual([]);
    expect(new Set(fake.recordKeys()).size).toBe(1);

    // A run of another Server is invisible here too.
    await store.upsertLocalRun(scopeC, run());
    expect(await store.listLocalRuns(scopeA)).toEqual([]);
    expect((await store.listLocalRuns(scopeC)).map((entry) => entry.runId)).toEqual([run().runId]);
    expect(new Set(fake.recordKeys()).size).toBe(2);
  });

  it("keeps a deletion inside its own scope", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.saveDraft(scopeA, draft());
    await store.saveDraft(scopeB, draft());
    await store.deleteDraft(scopeA, DRAFT_ID);

    expect(await store.listDrafts(scopeA)).toEqual([]);
    expect((await store.listDrafts(scopeB)).map((entry) => entry.id)).toEqual([DRAFT_ID]);
  });

  it("refuses a record id that could address another record", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await expect(store.saveDraft(scopeA, draft("../escape"))).rejects.toThrow();
    await expect(store.upsertLocalRun(scopeA, run("../../escape"))).rejects.toThrow();
    expect(fake.commands("writeRecord")).toEqual([]);
  });

  it("lists drafts newest first", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.saveDraft(scopeA, draft("older", "2026-09-28T10:00:00.000Z"));
    await store.saveDraft(scopeA, draft("newer", "2026-09-29T10:00:00.000Z"));
    expect((await store.listDrafts(scopeA)).map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("saveImage", () => {
  const input = { runId: run().runId, index: 0, mimeType: "image/png", dataBase64: "aW1hZ2UtYnl0ZXM=" };

  it("returns only once the file is on disk, and records nothing itself", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    const saved = await store.saveImage(scopeA, input);

    expect(fake.files.has(saved.filePath)).toBe(true);
    expect(saved.byteSize).toBe(input.dataBase64.length);
    // The caller records `saved` afterwards; the store makes no record of a file.
    expect(fake.commands("writeRecord")).toEqual([]);
    expect(fake.commands("saveImage")).toHaveLength(1);
  });

  it("names the file on the device, never after the remote run", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    const saved = await store.saveImage(scopeA, input);
    const name = saved.filePath.split("/").pop() ?? "";

    expect(name).toMatch(/^solaris-\d{1,16}-[0-9a-f-]{36}\.png$/);
    expect(name).not.toContain(input.runId);
    expect(saved.filePath.startsWith(`/fake/`)).toBe(true);
  });

  it("throws and leaves the run untouched when the write fails", async () => {
    const fake = createFakeBackend({ failSave: true });
    const store = createLocalStore(fake.backend);

    const pending: LocalRunRecord = {
      ...run(),
      images: [{ index: 0, filePath: null, state: "unsaved", byteSize: 0, mimeType: "image/png" }],
    };
    await store.upsertLocalRun(scopeA, pending);
    const writesBefore = fake.commands("writeRecord").length;

    await expect(store.saveImage(scopeA, input)).rejects.toThrow(/No space left/);

    // A failed write is not a saved image: the run still has nothing on disk,
    // and the store wrote no record of a file that does not exist.
    const [record] = await store.listLocalRuns(scopeA);
    expect(record?.images).toEqual([{ index: 0, filePath: null, state: "unsaved", byteSize: 0, mimeType: "image/png" }]);
    expect(fake.commands("writeRecord")).toHaveLength(writesBefore);
  });

  it("refuses a MIME type it cannot name a file after, before touching the device", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await expect(store.saveImage(scopeA, { ...input, mimeType: "image/gif" })).rejects.toThrow();
    await expect(store.saveImage(scopeA, { ...input, mimeType: "../../escape" })).rejects.toThrow();
    expect(fake.commands("saveImage")).toEqual([]);
  });

  it("reads a saved image back with the MIME type of its own extension", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    const saved = await store.saveImage(scopeA, input);
    const read = await store.readSavedImage(scopeA, saved.filePath);
    expect(read.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(read.bytes)).toBe("image-bytes");
  });

  it("reports whether the file is still there for this scope", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    const saved = await store.saveImage(scopeA, input);
    expect(await store.imageExists(scopeA, saved.filePath)).toBe(true);

    fake.files.delete(saved.filePath);
    expect(await store.imageExists(scopeA, saved.filePath)).toBe(false);
  });
});

describe("local runs", () => {
  const savedRun: LocalRunRecord = {
    ...run(),
    images: [
      { index: 0, filePath: "/fake/s-1/solaris-1-0f2a1c4e-0000-4000-8000-000000000001.png", state: "saved", byteSize: 12, mimeType: "image/png" },
      { index: 1, filePath: null, state: "unsaved", byteSize: 0, mimeType: "image/png" },
    ],
  };

  it("reports a vanished file as missing without rewriting the record", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);
    await store.upsertLocalRun(scopeA, savedRun);
    const writesBefore = fake.commands("writeRecord").length;

    // The file is not on this device any more.
    const [record] = await store.listLocalRuns(scopeA);
    expect(record?.images[0]).toEqual({ ...savedRun.images[0], state: "missing" });
    // An image that was never saved is not probed.
    expect(record?.images[1]?.state).toBe("unsaved");

    // Nothing was rewritten: the downgrade is a reading of this device, not a
    // change to the record or to any remote run status.
    expect(fake.commands("imageExists")).toHaveLength(1);
    expect(fake.commands("writeRecord")).toHaveLength(writesBefore);
  });

  it("keeps reporting saved while the file is present", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);
    await store.upsertLocalRun(scopeA, savedRun);
    const filePath = savedRun.images[0]?.filePath ?? "";
    fake.files.set(filePath, "AQ==");

    const [record] = await store.listLocalRuns(scopeA);
    expect(record?.images[0]?.state).toBe("saved");
    expect(record?.images[0]?.filePath).toBe(filePath);
  });

  it("replaces the record of the same run", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.upsertLocalRun(scopeA, run());
    await store.upsertLocalRun(scopeA, { ...run(), updatedAt: "2026-09-29T11:00:00.000Z" });

    const records = await store.listLocalRuns(scopeA);
    expect(records).toHaveLength(1);
    expect(records[0]?.updatedAt).toBe("2026-09-29T11:00:00.000Z");
  });
});

describe("sessions", () => {
  it("keeps exactly one active session per Server", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    expect(await store.readSession(SERVER)).toBeNull();
    await store.writeSession(SERVER, session("first"));
    expect((await store.readSession(SERVER))?.token).toBe("first");

    // Signing in as another account replaces the token rather than adding one.
    await store.writeSession(SERVER, { ...session("second"), user: { ...session("second").user, id: "user-b" } });
    expect((await store.readSession(SERVER))?.token).toBe("second");
    expect(fake.commands("writeSession")).toHaveLength(2);

    await store.clearSession(SERVER);
    expect(await store.readSession(SERVER)).toBeNull();
  });

  it("does not carry a token to another Server", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.writeSession(SERVER, session("only-here"));
    expect(await store.readSession("https://other.example")).toBeNull();
    expect(await store.readSession("https://other.example")).toBeNull();
  });

  it("normalises the origin before it reaches the secure store", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);

    await store.writeSession("HTTP://127.0.0.1:3210/", session("token"));
    expect(fake.commands("writeSession")[0]?.args[0]).toBe(SERVER);
    expect((await store.readSession("http://127.0.0.1:3210"))?.token).toBe("token");
  });

  it("reports a stored session it cannot trust instead of inventing one", async () => {
    const fake = createFakeBackend({ corruptSession: true });
    const store = createLocalStore(fake.backend);
    await expect(store.readSession(SERVER)).rejects.toThrow();
  });
});

describe("reference files", () => {
  it("reads a chosen reference with its own MIME type", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);
    const filePath = "/Users/someone/Pictures/source.png";
    fake.files.set(filePath, "cmVmZXJlbmNl");

    const file = await store.readReferenceFile(scopeA, filePath);
    expect(file.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(file.bytes)).toBe("reference");
  });

  it("refuses a file it cannot name", async () => {
    const fake = createFakeBackend();
    const store = createLocalStore(fake.backend);
    await expect(store.readReferenceFile(scopeA, "/Users/someone/.ssh/id_rsa")).rejects.toThrow();
  });
});
