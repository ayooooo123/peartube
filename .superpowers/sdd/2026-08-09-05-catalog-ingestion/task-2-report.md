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
- Fork changes, stored source identity discontinuities (including catalog epoch/bootstrap/descriptor digest), stored-ahead history, and the proven stale-history error shape select publisher-local repair.
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
