import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  GenerationResponseDto,
  ModelOperationConfigDto,
  OperationParameterDto,
  ParameterValues,
} from "../shared/contracts.js";
import type { LocalImageRecord } from "../shared/local.js";
import { ApiClientError } from "./api.js";
import type { ConnectionCatalog } from "./catalog.js";
import { useServices } from "./context.js";
import {
  describeError,
  describeImageRefs,
  Empty,
  formatBytes,
  formatTime,
  runStatusLabels,
  runStatusMeaning,
  StatusBadge,
  unavailableReasonText,
} from "./display.js";
import { baseName, createDraftRun, resolveReference, type DraftRun, type ResolvedReference } from "./generation.js";

/**
 * The generation flow. One deliberate run = one `DraftRun` = one submission id;
 * the draft is reused unchanged when a failed transport is retried and only ever
 * replaced when the user starts a new run.
 */
type Attempt =
  | { phase: "idle" }
  | { phase: "submitting"; draft: DraftRun; recheck: boolean }
  | { phase: "answered"; draft: DraftRun; response: GenerationResponseDto }
  /** The Server refused the request before execution; nothing was sent upstream. */
  | { phase: "refused"; draft: DraftRun; error: ApiClientError }
  /** Transport failure: the outcome is unknown, so the submission id is kept. */
  | { phase: "unknown"; draft: DraftRun; message: string };

/**
 * CONTRACTS §3.2: `outputCount` is a Solaris-side truncation of what the
 * provider already returned, not a promise of N images, and its future is not
 * frozen. Until B04/B07 settle it, the control is labelled so it cannot be read
 * as a guarantee. Nothing in this client calls the provider repeatedly hoping to
 * reach a count.
 */
const truncationParameterKey = "outputCount";

function defaultsFor(config: ModelOperationConfigDto | undefined): ParameterValues {
  const values: ParameterValues = {};
  for (const definition of config?.parameters ?? []) {
    if (definition.default !== undefined) values[definition.key] = definition.default;
  }
  return values;
}

/**
 * The parameter object that goes into the request, or null when the model
 * exposes none. Non-finite numbers are dropped: the digest rejects them, so a
 * half-typed number field must not reach the request.
 */
function requestParameters(config: ModelOperationConfigDto | undefined, values: ParameterValues): ParameterValues | null {
  const definitions = config?.parameters ?? [];
  if (definitions.length === 0) return null;
  const parameters: ParameterValues = {};
  for (const definition of definitions) {
    const value = values[definition.key] ?? definition.default;
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    parameters[definition.key] = value;
  }
  return parameters;
}

/** What this delivery carries, before this device has saved any of it. */
function deliveredRecords(response: GenerationResponseDto): LocalImageRecord[] {
  if (response.result.kind !== "delivered") return [];
  return response.result.images.map((image, index) => ({
    index,
    filePath: null,
    state: "unsaved",
    byteSize: image.byteSize,
    mimeType: image.mimeType,
  }));
}

/** What this device already recorded wins over the unsaved state of a re-delivery. */
function mergeLocalImages(delivered: LocalImageRecord[], stored: LocalImageRecord[]): LocalImageRecord[] {
  const byIndex = new Map(stored.map((image) => [image.index, image]));
  for (const image of delivered) if (!byIndex.has(image.index)) byIndex.set(image.index, image);
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

/**
 * The device decides what is saved and what can still be previewed: a recorded
 * file that is gone is `missing` here, for this device only, and the remote run
 * status is never rewritten from this side (CONTRACTS §4.2, §10). `unsaved` is
 * not a failure — it is simply what the bytes are until `saveImage` resolves.
 */
function localCopyText(images: LocalImageRecord[], saving: boolean): string {
  if (saving) return `Saving ${images.length} image${images.length === 1 ? "" : "s"}…`;
  if (images.length === 0) return "Nothing to save.";
  const saved = images.filter((image) => image.state === "saved").length;
  const missing = images.filter((image) => image.state === "missing").length;
  if (missing > 0) {
    return `${saved} file${saved === 1 ? "" : "s"} saved on this device; ${missing} recorded file${
      missing === 1 ? " is" : "s are"
    } missing on this device (moved or deleted). This is this device's copy only; the run's remote status is unchanged.`;
  }
  if (saved === 0) return "Not saved on this device yet.";
  return `${saved} of ${images.length} image${images.length === 1 ? "" : "s"} saved on this device.`;
}

function imageLocalState(record: LocalImageRecord | undefined): string {
  if (record === undefined) return "not saved";
  if (record.state === "saved") return record.filePath ?? "saved on this device";
  if (record.state === "missing") return "missing on this device";
  return "not saved";
}

/** True when the current inputs are the ones the shown draft was built from. */
function matchesDraft(
  draft: DraftRun,
  prompt: string,
  modelId: string,
  parameters: ParameterValues | null,
  references: ResolvedReference[],
): boolean {
  if (draft.request.prompt !== prompt || draft.request.modelId !== modelId) return false;
  if (JSON.stringify(draft.request.parameters ?? null) !== JSON.stringify(parameters)) return false;
  if (draft.references.length !== references.length) return false;
  return draft.references.every((reference, index) => reference.sha256 === references[index]?.sha256);
}

export function Workspace({ catalog }: { catalog: ConnectionCatalog }) {
  const { api, localStore, scope, notify, fail } = useServices();
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [parameters, setParameters] = useState<ParameterValues>({});
  const [references, setReferences] = useState<ResolvedReference[]>([]);
  const [picking, setPicking] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>({ phase: "idle" });
  const [localImages, setLocalImages] = useState<LocalImageRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);

  const model = catalog.models.find((item) => item.id === modelId);
  const config = model?.operationConfigs.imageGenerate;
  const policy = config?.attachments;
  const usableModels = useMemo(() => catalog.models.filter((item) => item.enabled), [catalog.models]);

  useEffect(() => {
    setModelId((current) =>
      usableModels.some((item) => item.id === current && item.adapted)
        ? current
        : (usableModels.find((item) => item.adapted)?.id ?? ""),
    );
  }, [usableModels]);

  useEffect(() => {
    setPrompt("");
    setReferences([]);
    setAttempt({ phase: "idle" });
    setLocalImages([]);
    setSaveAttempted(false);
    setParameters(defaultsFor(model?.operationConfigs.imageGenerate));
    // Reset only when the target changes, not when a response arrives.
  }, [model?.id, catalog.selectedId]);

  const busy = attempt.phase === "submitting";
  const totalReferenceBytes = references.reduce((total, reference) => total + reference.byteSize, 0);
  const atLimit = policy !== undefined && references.length >= policy.maxCount;

  async function addReferences() {
    if (!policy) return;
    setPicking(true);
    try {
      const paths = await localStore.chooseReferenceFiles(scope);
      if (paths.length === 0) return;
      const resolved: ResolvedReference[] = [];
      for (const path of paths) resolved.push(await resolveReference(localStore, scope, path));
      if (references.length + resolved.length > policy.maxCount) {
        notify(`Up to ${policy.maxCount} reference image${policy.maxCount === 1 ? "" : "s"} per request.`);
        return;
      }
      const unsupported = resolved.find((reference) => !policy.accept.includes(reference.mimeType));
      if (unsupported) {
        notify(`${baseName(unsupported.filePath)} is not an accepted reference type (${policy.accept.join(", ")}).`);
        return;
      }
      const oversized = resolved.find((reference) => reference.byteSize > policy.maxFileBytes);
      if (oversized) {
        notify(`${baseName(oversized.filePath)} exceeds the ${formatBytes(policy.maxFileBytes)} per-file limit.`);
        return;
      }
      const total = [...references, ...resolved].reduce((sum, reference) => sum + reference.byteSize, 0);
      if (total > policy.maxTotalBytes) {
        notify(`Reference images must total ${formatBytes(policy.maxTotalBytes)} or less.`);
        return;
      }
      setReferences((current) => [...current, ...resolved]);
    } catch (error) {
      fail(error);
    } finally {
      setPicking(false);
    }
  }

  /**
   * Records what this delivery brought, and adopts what this device already
   * knows about the run: a re-delivery of the same submission must not present a
   * file that is already on disk as unsaved, nor one that has since disappeared
   * as present.
   */
  async function adoptLocalImages(draft: DraftRun, response: GenerationResponseDto) {
    const delivered = deliveredRecords(response);
    setLocalImages(delivered);
    setSaveAttempted(false);
    const runId = response.run?.id;
    if (runId === undefined) return;
    try {
      const stored = (await localStore.listLocalRuns(scope)).find((record) => record.runId === runId);
      if (stored === undefined) {
        // The first delivery of this run is the record; only the device-local
        // record is written here, because the Server keeps no bytes.
        await localStore.upsertLocalRun(scope, {
          runId,
          submissionId: draft.submissionId,
          images: delivered,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      setLocalImages(mergeLocalImages(delivered, stored.images));
    } catch (error) {
      fail(error);
    }
  }

  async function submitDraft(draft: DraftRun, recheck: boolean) {
    setAttempt({ phase: "submitting", draft, recheck });
    try {
      const response = await api.submitGeneration({
        request: draft.request,
        references: draft.references.map((reference) => ({ mimeType: reference.mimeType, bytes: reference.bytes })),
      });
      setAttempt({ phase: "answered", draft, response });
      void adoptLocalImages(draft, response);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "AUTH_REQUIRED") {
        fail(error);
        return;
      }
      if (error instanceof ApiClientError && error.envelope) {
        setAttempt({ phase: "refused", draft, error });
        return;
      }
      setAttempt({ phase: "unknown", draft, message: describeError(error) });
    }
  }

  async function startNewRun() {
    const connection = catalog.selected;
    if (!connection || !model) return;
    if (!prompt.trim()) {
      notify("Enter a prompt before generating.");
      return;
    }
    try {
      // A deliberate new run always gets a new submission id.
      const draft = await createDraftRun({
        connectionId: connection.id,
        modelId: model.id,
        prompt,
        parameters: requestParameters(config, parameters),
        references,
      });
      await submitDraft(draft, false);
    } catch (error) {
      fail(error);
    }
  }

  async function replay() {
    if (attempt.phase === "idle" || attempt.phase === "submitting") return;
    await submitDraft(attempt.draft, true);
  }

  /**
   * Saves the bytes this delivery already carries — no provider call is made
   * here, and none is made to recover a failure. `saved` is recorded only after
   * `saveImage` resolves; anything that failed stays `unsaved`, and the bytes
   * stay in this session for another attempt.
   */
  async function saveDelivered(draft: DraftRun, response: GenerationResponseDto) {
    if (response.result.kind !== "delivered") return;
    const runId = response.run?.id;
    if (runId === undefined) return;
    setSaving(true);
    try {
      if ((await localStore.chooseSaveDirectory(scope)) === null) return;
      setSaveAttempted(true);
      let images = localImages;
      for (const [index, image] of response.result.images.entries()) {
        if (images.find((record) => record.index === index)?.state === "saved") continue;
        try {
          const saved = await localStore.saveImage(scope, {
            runId,
            index,
            mimeType: image.mimeType,
            dataBase64: image.dataBase64,
          });
          images = images.map((record): LocalImageRecord =>
            record.index === index
              ? { index, filePath: saved.filePath, state: "saved", byteSize: saved.byteSize, mimeType: image.mimeType }
              : record,
          );
          setLocalImages(images);
          await localStore.upsertLocalRun(scope, {
            runId,
            submissionId: draft.submissionId,
            images,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          fail(error);
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  }

  if (catalog.connections.length === 0) {
    return (
      <section>
        <h2>Workspace</h2>
        <Empty title="No connections yet" text="Create a named connection before starting a run." />
      </section>
    );
  }

  const dirty =
    attempt.phase !== "idle" &&
    attempt.phase !== "submitting" &&
    !matchesDraft(attempt.draft, prompt, modelId, requestParameters(config, parameters), references);

  return (
    <section>
      <h2>Workspace</h2>
      <div className="selectors">
        <label>
          Connection
          <select value={catalog.selectedId} onChange={(event) => catalog.select(event.target.value)}>
            {catalog.connections.map((connection) => (
              <option value={connection.id} key={connection.id}>
                {connection.name} · {connection.adapterId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            <option value="" disabled>
              Select an adapted model
            </option>
            {usableModels.map((item) => (
              <option value={item.id} disabled={!item.adapted} key={item.id}>
                {item.label}
                {item.adapted ? "" : " — not adapted"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!model ? (
        <Empty title="No adapted models" text="Refresh this connection's models, or add one manually on the Connections page." />
      ) : (
        <>
          <form
            className="card creation-card"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void startNewRun();
            }}
          >
            {config?.warning && (
              <div className="model-warning" role="status">
                <b>Model notice</b>
                <span>{config.warning}</span>
              </div>
            )}
            <div className="creation-grid">
              <div className="prompt-panel">
                <label className="prompt-label" htmlFor="workspace-prompt">
                  {references.length ? "Edit instruction" : "Prompt"}
                </label>
                <textarea
                  id="workspace-prompt"
                  rows={8}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    references.length
                      ? "Describe how to transform these references…"
                      : "Describe the image you want to create…"
                  }
                />
                {policy ? (
                  <div className="reference-picker">
                    <div className="reference-heading">
                      <div>
                        <b>Reference images</b>
                        <small>{policy.description ?? "Attached to this request in the order shown."}</small>
                      </div>
                      <span>
                        {references.length} / {policy.maxCount}
                        <small>
                          {formatBytes(totalReferenceBytes)} / {formatBytes(policy.maxTotalBytes)}
                        </small>
                      </span>
                    </div>
                    {references.length > 0 && (
                      <ul className="reference-list">
                        {references.map((reference, index) => (
                          <li key={index}>
                            <b>{index + 1}</b>
                            <span>{baseName(reference.filePath)}</span>
                            <small>
                              {reference.mimeType} · {formatBytes(reference.byteSize)}
                            </small>
                            <span className="spacer" />
                            <button
                              type="button"
                              aria-label={`Remove reference ${index + 1}`}
                              disabled={busy}
                              onClick={() => setReferences((current) => current.filter((_, position) => position !== index))}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button type="button" className="drop-zone" disabled={busy || picking || atLimit} onClick={() => void addReferences()}>
                      <b>{picking ? "Reading files…" : atLimit ? "Reference limit reached" : "Choose reference images"}</b>
                      <small>
                        {policy.accept.map((type) => (type.split("/")[1] ?? type).toUpperCase()).join(" · ")} · up to{" "}
                        {formatBytes(policy.maxFileBytes)} each
                      </small>
                    </button>
                  </div>
                ) : (
                  <p className="muted upload-unavailable">This model does not accept reference images.</p>
                )}
              </div>
              <aside className="output-spec">
                <div className="spec-heading">
                  <span>Output specification</span>
                  <small>{config?.parameters.length ? "Model controls" : "Provider defaults"}</small>
                </div>
                <ParameterPanel
                  definitions={config?.parameters ?? []}
                  values={parameters}
                  onChange={(key, value) => setParameters((current) => ({ ...current, [key]: value }))}
                />
              </aside>
            </div>
            <div className="creation-actions">
              <span className="action-context">
                {references.length
                  ? `${references.length} reference${references.length === 1 ? "" : "s"}`
                  : "Text prompt · new image"}
              </span>
              <span className="spacer" />
              <button className="primary" disabled={busy || !prompt.trim() || !model.adapted}>
                {busy ? "Sending…" : "Generate"}
              </button>
            </div>
          </form>

          {attempt.phase !== "idle" && (
            <AttemptPanel
              attempt={attempt}
              dirty={dirty}
              localImages={localImages}
              saving={saving}
              saveAttempted={saveAttempted}
              onReplay={() => void replay()}
              onNewRun={() => void startNewRun()}
              onSave={() => {
                if (attempt.phase === "answered") void saveDelivered(attempt.draft, attempt.response);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function ParameterPanel({
  definitions,
  values,
  onChange,
}: {
  definitions: OperationParameterDto[];
  values: ParameterValues;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  if (definitions.length === 0) {
    return <p className="muted spec-empty">This model does not expose adjustable output parameters.</p>;
  }
  return (
    <div className="parameter-list">
      {definitions.map((definition) => (
        <div className={`parameter parameter-${definition.key}`} key={definition.key}>
          <div className="parameter-title">
            <b>
              {definition.label}
              {definition.key === truncationParameterKey ? " — maximum retained" : ""}
            </b>
            {definition.description && <small>{definition.description}</small>}
          </div>
          {definition.type === "enum" && (
            <div className="parameter-options">
              {definition.options?.map((option) => (
                <button
                  type="button"
                  className={values[definition.key] === option.value ? "active" : ""}
                  aria-pressed={values[definition.key] === option.value}
                  onClick={() => onChange(definition.key, option.value)}
                  key={String(option.value)}
                >
                  <span>{option.label}</span>
                  {option.detail && <small>{option.detail}</small>}
                </button>
              ))}
            </div>
          )}
          {definition.type === "boolean" && (
            <button
              type="button"
              className={`toggle ${values[definition.key] ? "active" : ""}`}
              aria-pressed={Boolean(values[definition.key])}
              onClick={() => onChange(definition.key, !values[definition.key])}
            >
              <i />
              {values[definition.key] ? "On" : "Off"}
            </button>
          )}
          {definition.type === "number" && (
            <input
              type="number"
              min={definition.min}
              max={definition.max}
              step={definition.step}
              value={typeof values[definition.key] === "number" ? String(values[definition.key]) : ""}
              onChange={(event) => onChange(definition.key, Number(event.target.value))}
            />
          )}
          {definition.key === truncationParameterKey && (
            <small className="parameter-note">
              At most this many images are kept from a single upstream response. It is not a promise that this many will be
              generated, and Solaris never calls the provider repeatedly to reach it.
            </small>
          )}
        </div>
      ))}
    </div>
  );
}

function AttemptPanel({
  attempt,
  dirty,
  localImages,
  saving,
  saveAttempted,
  onReplay,
  onNewRun,
  onSave,
}: {
  attempt: Exclude<Attempt, { phase: "idle" }>;
  dirty: boolean;
  localImages: LocalImageRecord[];
  saving: boolean;
  saveAttempted: boolean;
  onReplay: () => void;
  onNewRun: () => void;
  onSave: () => void;
}) {
  if (attempt.phase === "submitting") {
    return (
      <div className="card result">
        <h3>{attempt.recheck ? "Re-checking the submission…" : "Sending the request…"}</h3>
        <p className="muted">
          Submission <code>{attempt.draft.submissionId}</code> — reused for every retry of this run.
        </p>
      </div>
    );
  }

  if (attempt.phase === "refused") {
    return (
      <div className="card result">
        <h3>The Server refused this request</h3>
        <ul className="state-list">
          <li>
            <b>Generation</b>
            <span>Not started. Nothing was sent to the provider, so nothing was billed.</span>
          </li>
          <li>
            <b>Reason</b>
            <span>
              <code>{attempt.error.code}</code> — {attempt.error.message}
            </span>
          </li>
          <li>
            <b>Submission</b>
            <span>
              <code>{attempt.draft.submissionId}</code>
            </span>
          </li>
        </ul>
        {dirty && <p className="muted">The inputs changed since this submission.</p>}
        <div className="result-actions">
          <button type="button" className="primary" onClick={onNewRun}>
            Start a new run
          </button>
        </div>
      </div>
    );
  }

  if (attempt.phase === "unknown") {
    return (
      <div className="card result">
        <h3>The outcome of this request is unknown</h3>
        <ul className="state-list">
          <li>
            <b>Generation</b>
            <span>
              <StatusBadge status="uncertain" label="Unknown" /> The request may have been accepted. Solaris will not resubmit
              it on its own.
            </span>
          </li>
          <li>
            <b>Failure</b>
            <span>{attempt.message}</span>
          </li>
          <li>
            <b>Submission</b>
            <span>
              <code>{attempt.draft.submissionId}</code> — re-checking it never calls the provider again.
            </span>
          </li>
        </ul>
        <div className="result-actions">
          <button type="button" onClick={onReplay}>
            Re-check same submission
          </button>
          <button type="button" className="primary" onClick={onNewRun}>
            Start a new run
          </button>
        </div>
        <p className="warning">
          A new run uses a new submission id and may be billed again by the provider, even if this one was also accepted.
        </p>
      </div>
    );
  }

  const { draft, response } = attempt;
  const run = response.run;
  const result = response.result;
  const delivered = result.kind === "delivered";
  /** A re-run of an already saved image is skipped; a missing one is saved again. */
  const pendingSave = delivered && localImages.some((record) => record.state !== "saved");

  return (
    <div className="card result">
      <h3>Submission {response.submissionId}</h3>
      <ul className="state-list">
        <li>
          <b>Generation</b>
          <span>
            <StatusBadge status={response.status} label={runStatusLabels[response.status]} />
            {runStatusMeaning(response.status)}
          </span>
        </li>
        <li>
          <b>Result</b>
          <span>
            {result.kind === "pending" && (
              <>
                <StatusBadge status="pending" label="Pending" /> The run is claimed and the upstream call is still outstanding.
                Solaris will not send it again.
              </>
            )}
            {result.kind === "delivered" && (
              <>
                <StatusBadge status="delivered" label="Delivered" /> Delivered to this client:{" "}
                {result.images.length} image{result.images.length === 1 ? "" : "s"} ·{" "}
                {formatBytes(result.images.reduce((total, image) => total + image.byteSize, 0))}. These bytes are not stored by
                Solaris.
              </>
            )}
            {result.kind === "unavailable" && (
              <>
                <StatusBadge status="unavailable" label="Not available" /> {unavailableReasonText(result.reason)} No download is
                offered, because there is nothing to download.
              </>
            )}
          </span>
        </li>
        <li>
          <b>Local copy</b>
          <span>{localCopyText(localImages, saving)}</span>
        </li>
        {run && (
          <li>
            <b>Run</b>
            <span>
              {run.connectionName} · {run.providerModelId} · {formatTime(run.createdAt)} ·{" "}
              {run.returnedImageCount === null ? "returned count unknown" : `${run.returnedImageCount} returned`}
              {run.retainedImageCount === null ? "" : ` · ${run.retainedImageCount} retained`} · {run.referenceCount} reference
              {run.referenceCount === 1 ? "" : "s"}
            </span>
          </li>
        )}
        {run?.error && (
          <li>
            <b>Run error</b>
            <span>
              <code>{run.error.code}</code> — {run.error.message}
            </span>
          </li>
        )}
        {run && run.images.length > 0 && (
          <li>
            <b>History metadata</b>
            <span>{describeImageRefs(run.images)}</span>
          </li>
        )}
      </ul>

      {delivered && (
        <div className="result-images">
          {result.images.map((image, index) => {
            const record = localImages.find((item) => item.index === index);
            return (
              <figure key={index}>
                <img alt={`Generated image ${index + 1}`} src={`data:${image.mimeType};base64,${image.dataBase64}`} />
                <figcaption>
                  <span>
                    #{index + 1} · {image.mimeType} · {formatBytes(image.byteSize)}
                  </span>
                  <span>{imageLocalState(record)}</span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      <div className="result-actions">
        {result.kind === "pending" && (
          <button type="button" onClick={onReplay}>
            Re-check same submission
          </button>
        )}
        {delivered && (
          <button type="button" disabled={saving || !run || !pendingSave} onClick={onSave}>
            {saving ? "Saving…" : pendingSave ? "Save to a local folder…" : "Saved on this device"}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="primary" onClick={onNewRun}>
          Start a new run
        </button>
      </div>

      {response.status === "uncertain" && (
        <p className="warning">
          Solaris will not resubmit this uncertain request. Starting a new run creates a new submission id and may be billed
          twice.
        </p>
      )}
      {delivered && saveAttempted && localImages.some((record) => record.state === "unsaved") && (
        <p className="warning">
          Some images were not saved. The bytes are still in this session, so saving again reuses them and calls no provider.
          If they are gone, re-checking this submission re-delivers them while the Server&apos;s result cache still holds them.
        </p>
      )}
      {dirty && <p className="muted">The inputs changed since this submission; Generate starts a new run.</p>}
      <p className="muted">
        Submission <code>{draft.submissionId}</code> · content digest <code>{draft.contentDigest}</code>
      </p>
    </div>
  );
}
