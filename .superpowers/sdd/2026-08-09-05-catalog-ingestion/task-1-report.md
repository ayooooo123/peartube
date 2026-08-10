# Plan 05 Task 1 Report

## Files changed

- Created `packages/backend/src/indexer/catalog-ingestor.js`.
- Created `packages/backend/test/indexer-catalog-ingestion.test.mjs`.
- Modified `packages/backend/src/indexer/index.js` to export `createCatalogIngestor`.
- Modified `packages/backend/src/indexer/store.js` with exact `getSourceCursor({ publisherId, catalogEpoch })`, publisher-effective admission ceilings, and optional atomic expected-cursor comparison for ingestion writes.
- Modified `packages/backend/test/indexer-store.test.mjs` with cursor-read isolation and stale expected-cursor rejection coverage.
- Created this report.

## Behavior implemented

- Canonicalizes publisher identity from 32-byte input or lowercase 64-hex and rejects noncanonical strings.
- Verifies the supplied publisher namespace descriptor, requested publisher identity, catalog bootstrap key, exact accepted `state/descriptor`, and captured view head before local mutation.
- Calls the production catalog surface, captures fork/version/head, opens an exact Hyperbee checkout, and closes that checkout on every success and failure path.
- Reads only the exact current `(publisherId, catalogEpoch)` cursor through the Plan 04 store surface.
- Enumerates only bounded `projection/` rows for bootstrap/rebuild, rejects every key outside the canonical ASCII publication/claim shape, and uses `pinnedView.createDiffStream(previousViewVersion, projectionRange)` for usable same-fork cursors, treating `left` as current and `right` as previous. Accumulation stops before retaining more than the effective configured publisher budget, capped at 4,096 rows and 8 MiB for replacement or twice those limits for a diff containing old deletes plus current puts.
- Canonically decodes and independently verifies publisher frames, operation identity/signature, operation body/key agreement, writer authorization, publication manifests, and application claim envelopes.
- Normalizes publication source rows, publication rows, rendition rows for manifest renditions/artwork/subtitles, publication-to-rendition and rendition-to-asset edges, deterministic bounded title-token edges, external-reference rows, supported typed relation rows, and exact-asset availability rows.
- Uses the signed publication ID as an isolated `workEntityId` when no exact signed work entity ID is carried by a manifest claim reference. This is index grouping only and does not assert cross-publication equivalence.
- Keeps valid claims with no Plan 04-representable derived row as canonical raw source records.
- Reconstructs exact prior source-derived keys for deletes, writes current puts, and advances the cursor in the same `applyPublisherChanges` transaction. Bootstrap/rebuild uses `replacePublisherSlice` with the cursor in the same transaction. Both mutations atomically compare the exact cursor used to prepare the change, preventing concurrent stale ingestion from regressing durable state.
- Same-head and same-fork incremental paths revalidate every current projection against the exact pinned descriptor, authorization state, signatures, and current time before either returning a no-mutation no-op or applying a projection-only diff. Authorization-only view changes therefore cannot advance a cursor while retaining newly invalid rows.
- Rejects any stored cursor whose catalog bootstrap key or verified descriptor digest differs from the pinned source before same-fork diffing, including lower-version cursors.
- Uses installed Plan 04 cursor fields: pinned source head length in `sourceHead` and the canonical stack's lowercase 64-hex descriptor hash in `lastVerifiedDescriptor`.

## Tests added first

The behavior suite covers:

1. Initial raw and normalized materialization plus cursor write.
2. Same-fork incremental diff from the stored cursor.
3. Concurrent stale ingestion rejection with the newest normalized slice and cursor preserved.
4. Idempotent same-head replay with no store mutation.
5. Same-head revalidation of time-dependent writer authorization.
6. Aggregate normalized row/byte rejection before index mutation.
7. Authorization-only view changes rejecting before unchanged rows or cursor mutation.
8. Exact source-derived removal and cursor advancement.
9. Fail-closed publisher/projection mismatch with no mutation.
10. Real index transaction flush failure rolling back rows, accounting, and cursor together.
11. Lower-version cursor catalog/descriptor identity mismatch rejection before diffing or mutation.
12. Non-ASCII and otherwise unsupported projection-key rejection before cursor advancement.
13. Bounded manifest rendition/artwork/subtitle materialization.
14. Valid raw-only metadata and asset-less availability claims without invented projections.
15. Catalog readiness ordering and absence of mutable-head helper reads after pinning.
16. Missing pinned authorization-state rejection before mutation.
17. Pinned checkout cleanup after successful and rejected ingestion.

The store suite also covers exact, validated publisher/epoch cursor reads and atomic compare-and-swap rejection for stale replacement and incremental writers.

## Explicit non-goals

- No explicit fork-repair policy. A changed fork fails closed for Plan 05 Task 2.
- No query RPCs, schema changes, generated-schema edits, private HyperDB access, compatibility shim, or unrelated refactor.
- No invented work-fact or asset collection. Installed Plan 04 stores title metadata on `publicationProjections`, title tokens as `title-token` relationship edges, and asset identity on rendition/relationship rows.
- No invented asset identity for availability claims; valid observations without an exact signed 64-hex `assetId` remain canonical raw source records without an asset projection.

## Concerns / blockers

- The installed claim shapes do not provide a dedicated Plan 04 work-fact collection, so representable external references and schema-valid relations are projected while otherwise-valid metadata claims remain raw source records. Publication title metadata comes from the verified manifest.
- Installed cursor schema differs from early brief prose; implementation follows the approved Plan 04 schema decision recorded above.
- The ingestor accepts the plan's verified/open catalog surface as its source capability, then checks the bootstrap key against the signed descriptor and the descriptor/authorization records inside the exact pinned view. It deliberately does not compare the Autobase bootstrap key with the Hyperbee view-core key: those are distinct keys in a real `PublisherCatalog`.
- Parent validation passed `npx brittle test/indexer-catalog-ingestion.test.mjs` (19/19 tests, 93/93 assertions) and `node --test test/indexer-store.test.mjs` (16/16 tests).
