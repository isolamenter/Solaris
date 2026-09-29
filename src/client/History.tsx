import { useCallback, useEffect, useState } from "react";
import type { RunDto } from "../shared/contracts.js";
import { useServices } from "./context.js";
import { describeImageRefs, Empty, formatTime, runStatusLabels, runStatusMeaning, StatusBadge } from "./display.js";

const PAGE_SIZE = 30;

/**
 * Run history. History responses carry metadata only — there are no bytes to
 * open or download here, and a `success` row is never presented as one.
 */
export function History() {
  const { api, fail, notify } = useServices();
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<RunDto | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listRuns({ limit: PAGE_SIZE });
      setRuns(page.items);
      setCursor(page.nextCursor);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }, [api, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (cursor === null) return;
    setLoading(true);
    try {
      const page = await api.listRuns({ limit: PAGE_SIZE, cursor });
      setRuns((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }

  async function openRun(runId: string) {
    try {
      setOpen(await api.getRun(runId));
    } catch (error) {
      fail(error);
    }
  }

  async function remove(run: RunDto) {
    try {
      await api.deleteRun(run.id);
      setConfirmDelete(null);
      if (open?.id === run.id) setOpen(null);
      notify("Run history deleted. The submission is still recorded, so it will not run again.");
      await load();
    } catch (error) {
      fail(error);
    }
  }

  return (
    <section>
      <h2>Run history</h2>
      {loading && runs.length === 0 ? (
        <p className="muted">Loading runs…</p>
      ) : runs.length === 0 ? (
        <Empty title="No runs yet" text="Runs appear here after you generate an image." />
      ) : (
        <div className="card">
          <h3>Runs</h3>
          <p className="muted">
            History keeps prompt and image metadata only. Solaris stores no generated image bytes, so nothing here is
            downloadable.
          </p>
          <ul className="run-list">
            {runs.map((run) => (
              <li key={run.id}>
                <span>
                  <b>
                    <StatusBadge status={run.status} label={runStatusLabels[run.status]} />
                  </b>
                  <small>
                    {run.connectionName} · {run.providerModelId} · {formatTime(run.createdAt)} · {run.referenceCount} reference
                    {run.referenceCount === 1 ? "" : "s"} · {describeImageRefs(run.images)}
                  </small>
                  <small>{run.prompt.length > 160 ? `${run.prompt.slice(0, 160)}…` : run.prompt}</small>
                </span>
                {confirmDelete === run.id ? (
                  <div className="row">
                    <button type="button" className="danger" onClick={() => void remove(run)}>
                      Delete now
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="row">
                    <button type="button" onClick={() => void openRun(run.id)}>
                      Open
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(run.id)}>
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {cursor !== null && (
            <button type="button" disabled={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : "Load older runs"}
            </button>
          )}
        </div>
      )}

      {open && <RunDetail run={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function RunDetail({ run, onClose }: { run: RunDto; onClose: () => void }) {
  return (
    <div className="card stack result">
      <div className="title-row">
        <h3>Run {run.id}</h3>
        <StatusBadge status={run.status} label={runStatusLabels[run.status]} />
      </div>
      <p className="muted">{runStatusMeaning(run.status)}</p>
      <ul className="state-list">
        <li>
          <b>Target</b>
          <span>
            {run.connectionName} · {run.providerModelId} · {run.operation}
          </span>
        </li>
        <li>
          <b>Prompt</b>
          <span>{run.prompt}</span>
        </li>
        <li>
          <b>Parameters</b>
          <span>{JSON.stringify(run.parameters)}</span>
        </li>
        <li>
          <b>References</b>
          <span>{run.referenceCount}</span>
        </li>
        <li>
          <b>Returned</b>
          <span>
            {run.returnedImageCount === null
              ? "unknown — the upstream response was not fully read within budget"
              : run.returnedImageCount}
          </span>
        </li>
        <li>
          <b>Retained</b>
          <span>{run.retainedImageCount === null ? "unknown" : run.retainedImageCount}</span>
        </li>
        <li>
          <b>Image metadata</b>
          <span>{describeImageRefs(run.images)}</span>
        </li>
        <li>
          <b>Timestamps</b>
          <span>
            created {formatTime(run.createdAt)} · updated {formatTime(run.updatedAt)}
          </span>
        </li>
        {run.error && (
          <li>
            <b>Error</b>
            <span>
              <code>{run.error.code}</code> — {run.error.message}
            </span>
          </li>
        )}
      </ul>
      {run.status === "uncertain" && (
        <p className="warning">
          Solaris will not resubmit this request. Running it again from the workspace creates a new submission id and may be
          billed twice.
        </p>
      )}
      {run.status === "success" && (
        <p className="muted">
          The images were delivered when the run finished. History does not keep the bytes, so this run cannot be downloaded
          here.
        </p>
      )}
      <div className="result-actions">
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
