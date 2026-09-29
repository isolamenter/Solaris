/**
 * Presentation helpers shared by the workspace and history pages.
 *
 * The wording here is contract wording: a `success` run means the upstream
 * generation produced an image, it does not mean this client holds the bytes,
 * and it is never presented as downloadable (CONTRACTS §4.2, §4.3).
 */

import type { GenerationUnavailableReason, RunImageRefDto, RunStatus } from "../shared/contracts.js";
import { ApiClientError } from "./api.js";

export const runStatusLabels: Record<RunStatus, string> = {
  running: "Running",
  success: "Succeeded",
  error: "Failed",
  uncertain: "Uncertain",
};

/** What the persisted run status does and does not mean. */
export function runStatusMeaning(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Claimed and still in flight. There is no result yet.";
    case "success":
      return "Solaris received at least one valid image upstream. The bytes are not stored in history.";
    case "error":
      return "The generation failed and produced no valid image.";
    case "uncertain":
      return "The request may have been accepted; Solaris will not resubmit it.";
  }
}

/** Why this delivery attempt has no bytes, and what is not going to happen. */
export function unavailableReasonText(reason: GenerationUnavailableReason): string {
  switch (reason) {
    case "not-generated":
      return "The run failed, so there is no result to deliver.";
    case "submission-unknown":
      return "Solaris could not determine whether the upstream request was accepted, and will not resubmit it.";
    case "cache-miss":
      return "The bytes are no longer in Solaris's short-lived in-memory result cache. Solaris does not regenerate results automatically.";
    case "result-too-large":
      return "The upstream response exceeded the delivery budget. Run again with a smaller image size or fewer images.";
    case "history-deleted":
      return "This run's history was deleted. The submission is still recorded, so it will not run again.";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/**
 * True when the Server refused the call because the session is gone (CONTRACTS
 * §9). The shell signs out instead of showing this as a page error.
 */
export function isAuthRequired(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "AUTH_REQUIRED";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export function formatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function describeImageRefs(images: RunImageRefDto[]): string {
  if (!images.length) return "No image metadata";
  const bytes = images.reduce((total, image) => total + image.byteSize, 0);
  return `${images.length} image${images.length === 1 ? "" : "s"} · ${formatBytes(bytes)} · metadata only`;
}

export function StatusBadge({ status, label }: { status: RunStatus | "delivered" | "pending" | "unavailable"; label: string }) {
  const tone =
    status === "success" || status === "delivered"
      ? "ok"
      : status === "error"
        ? "bad"
        : status === "uncertain" || status === "unavailable"
          ? "warn"
          : "idle";
  return <span className={`state-badge ${tone}`}>{label}</span>;
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
