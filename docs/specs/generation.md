# Image generation, replay and history

## Goal

Generate images from a prompt, optionally with reference images, while preventing a transport retry from making another upstream call. Remote generation, delivery to the Client and saving on this device are separate outcomes.

## Behavior and rules

- `POST /api/generations` accepts one JSON text field named `request` and optional `reference` files. The DTO is defined in [contracts.ts](../../src/shared/contracts.ts); transport validation and multipart bounds live in [app.ts](../../src/server/http/app.ts).
- Every deliberate run gets a new `submissionId`. A transport retry reuses the original ID and exact input. The Server recomputes `contentDigest` from the received prompt, IDs, parameters and ordered reference MIME/byte hashes using [digest.ts](../../src/shared/digest.ts); it does not trust the declared digest. For a new submission, a mismatched declared digest is rejected as `DIGEST_MISMATCH`. For a replay, the recomputed digest is compared with the stored receipt; the declared digest does not decide replay eligibility.
- Idempotency is scoped to `(userId, submissionId)`. Same ID with different content is `SUBMISSION_CONFLICT`; matching content replays before checking whether the original connection/model is still usable. A concurrent `running` receipt returns HTTP 202 with `pending`; terminal outcomes return HTTP 200 with the generation envelope. Pre-execution validation/authentication failures use the error envelope.
- New runs require owned, enabled resources, a resolved credential, an explicitly adapted model and strictly supported parameters. Reference MIME, count, per-file and total bounds are enforced before the provider call.
- A run moves from `running` to `success`, `error` or `uncertain`. At least one usable image is success; a complete response with no usable image is error. A possibly accepted request without a determinate result is uncertain. Terminal outcomes are not automatically resubmitted.
- Re-running is an explicit user action with a new ID and may be billed again. Startup recovery and stale-run cleanup mark abandoned runs uncertain without resubmitting; active calls are excluded.
- The Gemini `outputCount` parameter retains up to N returned images. It does not guarantee N generated images or make extra calls to reach N. Returned and retained counts are tracked separately.

## Delivery and deletion

`GenerationResponseDto` separates run status from `result`: pending, delivered image bytes, or unavailable with a reason. A generation can succeed while delivery is unavailable because its decoded output exceeds the delivery budget. If the raw upstream response cannot be read within its budget, the outcome may instead be uncertain because no complete result is known.

Server image bytes exist only in bounded memory. Cache replay is best effort: TTL expiry, LRU eviction and restart can make a successful result unavailable. Run history contains metadata only and is not a download library. A missing result never triggers regeneration.

Deleting a run removes its prompt, parameters, image metadata and cache entry, but retains the minimal dedup receipt. Later replay returns `run: null` and `history-deleted`, without another upstream call.

## Security and evidence

Provider requests have complete-call deadlines and response-read budgets. Generation redirects are refused; upstream-supplied URLs are never fetched for assets. Images and credentials must not enter persisted diagnostics or errors. API failures use the closed public error codes; unknown internal failures expose a generic `INTERNAL` message. Host/Origin transport rejections are separately defined in [security.ts](../../src/server/http/security.ts).

Implementation: [services.ts](../../src/server/services.ts), [repository.ts](../../src/server/repository.ts), [resultCache.ts](../../src/server/resultCache.ts), [providers/](../../src/server/providers/). Focused evidence lives in `services.generate.test.ts`, `services.replay.test.ts`, `services.lifecycle.test.ts`, provider tests and HTTP upload tests. Fixtures establish Solaris behavior, not current provider support or billing.
