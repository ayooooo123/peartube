# Plan 05 Task 2 Report

## Status

DONE

## Files changed

- Modified `packages/backend/src/indexer/catalog-ingestor.js`.
- Modified `packages/backend/src/indexer/store.js`.
- Modified `packages/backend/test/indexer-catalog-ingestion.test.mjs` to cut over Task 1 stale-history/identity fail-closed expectations to Task 2 publisher-local repair semantics.
- Added `packages/backend/test/indexer-fork-repair.test.mjs`.
- Extended `packages/backend/test/indexer-store.test.mjs` for the new publisher-wide cursor lookup and cross-epoch cursor CAS contract.
- Added this report.

## RED scenarios added first

1. A real Hyperbee truncation/fork followed by replacement projections written in a different order automatically rebuilds the affected publisher and returns `status: repaired`, `mode: repair`, and `reason: source-fork-changed`.
2. A proven `SNAPSHOT_NOT_AVAILABLE` failure while opening prior diff history rebuilds from the already validated pinned current view, while an unrelated source failure propagates.
3. Another publisher's complete row counts and byte-equivalent snapshot remain unchanged across fork repair.
4. Repair calls the publisher-slice replacement once with the exact prior cursor; a concurrent winner makes the stale replacement fail CAS without disturbing another publisher.
5. A repair that commits before its result is observed remains idempotent after closing and reopening the index store: retry is a no-op with unchanged row/byte totals and no duplicate publication projection.
6. Explicit `repairPublisher(...)` accepts only bounded repair reasons, rejects free-form text, and returns the stable repaired result shape.
7. Store coverage proves publisher-wide cursor lookup and expected-cursor comparison across catalog epoch changes.
8. Existing stored-ahead and stored-source-identity discontinuity scenarios now assert repaired status/reason, current pinned rows/cursor, and removal of stale cursor state.
9. Incremental store writes reject catalog-epoch/source-identity transitions and preserve the singular publisher cursor and complete prior state.
10. Catalog-epoch discontinuity ingestion uses the required publisher-wide cursor surface and atomically repairs back to the exact pinned epoch.
11. Explicit repair rejects `null`, `undefined`, and free-form reasons, while private automatic repair uses a non-public sentinel.
12. Restart retry compares the store's persisted usage snapshot before close and after reopen/no-op retry.
13. Source-identity repair fixtures seed the discontinuous durable cursor through publisher replacement, while cross-epoch incremental rejection tests catch each invalid mutation and prove rows/cursor stay unchanged.

## Behavior

- `createCatalogIngestor(...)` retains `ingest({ publisherId, descriptor, catalog })` and now also exposes `repairPublisher({ publisherId, descriptor, catalog, reason })`.
- Supported reasons are exactly `source-fork-changed`, `source-history-unavailable`, and `source-identity-changed`; caller-provided arbitrary text is rejected.
- Current supplied descriptor verification, exact accepted pinned descriptor comparison, authorization-state loading, signature verification, projection normalization, and bounded accumulation all happen against one exact pinned checkout before any repair transaction.
- Fork changes and stored source identity discontinuities (including catalog epoch/bootstrap/descriptor digest) select publisher-local repair. A same-identity, same-fork source behind its durable cursor is treated as lagging and rejected without replacement; only a proven stale-history diff error selects automatic `source-history-unavailable` repair.
- The ingestor requires the publisher-wide cursor surface; exact-epoch fallback was removed so epoch discontinuities cannot masquerade as bootstrap.
- Repair enumerates the complete current publisher projection set off-transaction under the existing 4,096-row/8-MiB effective ceilings, then invokes `replacePublisherSlice` once with the exact prior publisher cursor.
- Replacement rows and the new cursor commit atomically under publisher-wide expected-cursor CAS. The store now detects a prior cursor even when its catalog epoch differs from the current descriptor.
- Incremental identity transitions are rejected directly inside the transaction before writes; CAS and storage failures retain their existing transactional rejection paths.
- Same-head revalidation, ordinary bootstrap, and same-fork incremental behavior retain their Task 1 result modes and mutation paths.
- Only `SNAPSHOT_NOT_AVAILABLE` is converted from incremental diff failure into repair. Other source, descriptor, authorization, normalization, storage, and validation errors propagate.
- Exact pinned checkouts remain caller-source-owned and are closed in the existing `finally`; the index still does not close the caller-owned Corestore.

## Explicit non-goals

- No schema or generated-file changes.
- No compatibility aliases, deprecated entry points, global rebuild, query RPC, or unrelated refactor.
- No repair of more than one publisher per invocation.
- No free-form operator reason persistence or logging.
- No weakening of descriptor, authorization, signature, projection-key, resource, or admission validation.

## Concerns

- Parent validation passed before the latest review fixes (24/24 Brittle tests with 118/118 assertions plus 17/17 Node subtests). Focused parent revalidation after these fixes is pending.

## Final-review fix round

### Status

IMPLEMENTATION COMPLETE — VALIDATION PENDING

### Exact files changed in this round

- Modified `packages/backend/src/indexer/catalog-ingestor.js`.
- Modified `packages/backend/test/indexer-catalog-ingestion.test.mjs`.
- Updated `.superpowers/sdd/2026-08-09-05-catalog-ingestion/task-2-report.md`.

### RED tests added first

These tests were added before the source changes but were not executed, as this fix round explicitly prohibited commands and validation. Against the prior implementation:

1. Same-identity, same-fork source lagging the durable cursor expects rejection, zero replacement/apply calls, and byte-equivalent rows/cursor. It fails because the prior branch labeled stored-ahead state `source-history-unavailable` and replaced the publisher slice.
2. Zero-expiry writer admission expects an expired-authorization rejection with no rows/cursor. It fails because the prior `writerExpiry > 0` guard treated zero as permanent.
3. A valid `RecordingOfClaim` with a `recording` subject and work target expects one exact raw source record and no relationship edge. It fails because the prior projection required a `rendition` subject and rejected the valid recording endpoint.
4. Invalid recording endpoint shapes expect fail-closed behavior before cursor mutation. The non-work target retains the existing guard; the new non-recording-subject case fails against the prior source because a `rendition` subject was accepted and projected as `work-rendition`.
5. Invalid `signal` input and a native already-aborted signal expect rejection before checkout or index mutation. They fail because the prior API ignored `signal`.
6. Incremental cancellation raised after bounded diff collection expects no `applyPublisherChanges` call and unchanged durable rows/cursor. It fails because the prior incremental path committed despite cancellation.
7. Explicit-repair cancellation raised after bounded current-row collection expects no `replacePublisherSlice` call and unchanged durable rows/cursor. It fails because the prior replacement path committed despite cancellation.

### Final behavior

- Automatic ingestion now rejects a same-catalog, same-descriptor, same-fork source whose pinned `viewVersion` is behind the durable publisher cursor. It does not enumerate for replacement, call a store mutation, or regress rows/cursor. Automatic `source-history-unavailable` replacement remains limited to `SNAPSHOT_NOT_AVAILABLE` from the exact prior-version diff checkout.
- Current writer authorization treats `expiresAt` as an absolute timestamp. Zero is expired whenever the captured ingestion time is positive.
- `RecordingOfClaim` validates a work target and recording subjects, retains the exact raw source record, and emits no relationship edge because the installed Plan 04 schema has no `work-recording` relation. Non-work and non-recording endpoints fail closed.
- `ingest` and `repairPublisher` destructure and validate optional `signal`, preserve native `AbortSignal.throwIfAborted()` reasons, check before source preparation and asynchronous pinned-source phases, check within bounded row/diff processing, and check immediately before every replacement or incremental store mutation.
- Exact cursor CAS, row/byte bounds, raw/projection diffing, caller-owned Corestore lifetime, and checkout closure in `finally` are unchanged.

### Blockers / concerns

- No implementation blocker identified.
- Focused Plan 05 validation is intentionally pending for the parent because this round prohibited test, build, schema, generation, lint, formatter, and typecheck commands.
