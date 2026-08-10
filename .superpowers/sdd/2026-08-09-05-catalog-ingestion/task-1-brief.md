# Plan 05 Task 1 Brief: Incremental publisher catalog ingestor

## Goal

Implement the first Plan 05 slice: a real incremental ingestor that verifies one publisher's active catalog view, pins an exact Hyperbee checkout, diffs current projection keys from a prior same-fork cursor, normalizes current signed source records into the Plan 04 HyperDB schema, and commits source changes plus the cursor in one transaction.

## Required files

- Create `packages/backend/src/indexer/catalog-ingestor.js`
- Modify `packages/backend/src/indexer/index.js`
- Create `packages/backend/test/indexer-catalog-ingestion.test.mjs`

Do not modify generated schema, Plan 04 store/admission code, package exports outside `src/indexer/index.js`, or unrelated tests.

## Public API

Export from `@peartube/backend/indexer`:

```js
createCatalogIngestor({ index, now? })
```

The returned object must expose at least:

```js
await ingestor.ingest({ publisherId, descriptor, catalog })
```

`index` is the Plan 04 `createIndexerStore()` public surface. Do not reach into HyperDB private internals; use `index.replacePublisherSlice(...)` for bootstrap/rebuild and `index.applyPublisherChanges(...)` for a same-fork incremental diff.

`catalog` is a verified/open publisher catalog object. The production `PublisherCatalog` surface has `update()`, `view` (plain Hyperbee), `getViewHead()`, and `getAuthorizationState()`. Tests may use a narrow fixture exposing the same surface.

## Security and consistency invariants

1. Canonicalize `publisherId` as lowercase 64-hex (accept 32-byte Buffer/Uint8Array or canonical lowercase hex only).
2. Verify the passed namespace descriptor with existing publisher namespace APIs. It must match the requested publisher, the catalog bootstrap key, and the descriptor accepted in the pinned view's `state/descriptor` row. Reject all mismatch before any local index mutation.
3. Call `catalog.update()`, capture the current Hyperbee fork/version/head, then open a checkout pinned to that exact version. All reads and diffs for this ingestion attempt use the pinned checkout. Close the checkout on success and every failure.
4. Read the existing source cursor for exactly `(publisherId, catalogEpoch)`. Never use another publisher/epoch cursor.
5. Same epoch + same fork + usable prior version: call `pinnedView.createDiffStream(previousViewVersion, range)` over the `projection/` prefix. Treat `left` as current and `right` as previous. Convert each changed projection into deletes for the prior source record and its exact derived rows plus puts for the current record and rows.
6. Missing cursor or unusable prior version is a publisher-local bootstrap/rebuild: enumerate only the pinned `projection/` prefix, normalize it, and call `replacePublisherSlice`. Do not scan or replace another publisher.
7. Plan 05 Task 2 owns explicit fork-change repair semantics. Task 1 may rebuild for a missing/unusable version but must not claim or implement the Task 2 repair suite.
8. The same transaction that changes source/derived rows must advance one `sourceCursors` control row containing canonical `publisherId`, `catalogEpoch`, `catalogBootstrapKey`, `viewFork`, `viewVersion`, `sourceHead`, and `lastVerifiedDescriptor`.
9. Cursor `lastVerifiedDescriptor` is the canonical encoded descriptor bytes, not JSON. `sourceHead` must be a stable lowercase 64-hex digest/identity of the pinned source head, not a mutable object serialization.
10. Invalid descriptor, catalog identity, projection key, signed envelope, operation body, manifest, claim, or schema mapping fails closed before transaction commit. No partial publisher slice and no cursor advancement.
11. Preserve source attribution. `sourceRecords` retain canonical signed operation-envelope bytes; every derived row includes the same `publisherId` and exact source record reference.
12. Bound all source reads and output. Projection enumeration must use finite limits derived from existing publisher/schema limits; one source record may not emit unbounded arrays. Reject over-limit input rather than truncate silently.

## Source projection decoding

Publisher view keys use `projection/<kind>/<64hex-id>`. Values are encoded publisher catalog frames. Use existing canonical publisher decoders:

- `decodePublisherCatalogFrame(value)`
- `decodePublisherOperationBody(frame.body, { recordType: frame.recordType })`

The canonical raw source envelope is the exact projection value bytes. The source identity is the signed frame's canonical record/transition ID. Verify key kind/id agrees with the decoded operation body and record type.

Current relevant kinds are `publication` and `claim`. Reject malformed records; ignore no unknown projection kind silently. If the current protocol contains a bounded non-indexable kind, encode it as a raw `sourceRecord` only and document the decision in tests/report.

For publication operations:

- Decode `operation.body.payload` with `decodePublicationManifest`.
- Verify manifest identity matches operation publisher/publication/manifest IDs and signer using existing `verifyCatalogPublicationManifest`.
- Emit one `publicationProjections` row.
- Emit bounded `renditionProjections` for manifest `renditions`, `artwork`, and `subtitles` when representable.
- Emit relationship edges for publication→rendition and rendition→asset.

For claim operations:

- Decode the payload as an application envelope with `decodeApplicationEnvelope`, then decode its body with `decodeClaimBody`.
- Verify claim ID, signer, and claim type agree with the publisher operation. Use existing signature verification where the existing APIs support it.
- Emit bounded normalized rows that are directly represented by the current claim shapes:
  - `EntityMetadataClaim` on work subjects → `workFactProjections` with deterministic normalized title/tokens and optional release year.
  - external subject refs and `ExternalReferenceClaim.payload.externalRef` → `externalReferenceProjections`.
  - supported typed relation claims → one row per bounded relation in `relationshipEdges` using only schema-valid edge kinds.
  - `AvailabilityObservation` with an exact asset identity → `availabilityProjections`; do not invent an asset ID from publication ID.
- A valid claim that has no directly representable derived row still emits its raw `sourceRecord`.

Use the generated schema limits and validators through the Plan 04 store rather than introducing a second database convention.

## Tests to write first

Create behavior tests with real Hyperbee/Corestore publisher views or the narrowest real catalog fixture that exercises actual `createDiffStream` semantics. Tests must cover:

1. Initial ingestion materializes raw records + normalized publication/rendition/asset and metadata/external-reference rows, then writes the cursor.
2. A later same-fork publisher update reads the stored cursor, uses `createDiffStream`, and advances only changed records/rows.
3. Re-ingesting the same pinned head is an idempotent no-op for source/derived contents and usage totals except for no mutation at all if possible.
4. Retraction/removal deletes the exact prior source-derived rows.
5. Malformed or publisher-mismatched projection fails without changing rows or cursor.
6. Mid-batch local transaction failure leaves both source/derived rows and cursor unchanged.
7. Checkout closes on success and failure.

Use Brittle and existing test utilities/conventions. Do not use source-text assertions or mock the database transaction. Fault injection should use a legitimate Plan 04 store seam or a small wrapper around the public index surface.

## Acceptance

Parent validation will run:

```bash
cd packages/backend
npx brittle test/indexer-catalog-ingestion.test.mjs test/indexer-store.test.mjs
```

The implementation must preserve all Plan 04 conformance tests and expose `createCatalogIngestor` from `@peartube/backend/indexer`.

## Worker constraints

- Use strict TDD ordering while editing: add behavior tests before implementation.
- Do not run tests, generation, build, lint, formatter, typecheck, or any project-wide command. Parent owns validation.
- Do not commit.
- Write `.superpowers/sdd/2026-08-09-05-catalog-ingestion/task-1-report.md` with files changed, behavior implemented, explicit non-goals, and any concern/blocker.