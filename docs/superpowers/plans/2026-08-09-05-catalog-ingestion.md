# Incremental Publisher Catalog Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incrementally ingest each publisher's current Hyperbee view into the durable index and repair only that publisher after a fork or invalid cursor.

**Architecture:** The indexer opens the verified publisher namespace and current catalog view, pins a checkout, and uses native Hyperbee `createDiffStream(previousViewVersion)`. It converts changed projection keys into idempotent normalized HyperDB puts/deletes and atomically advances `{ catalogEpoch, viewFork, viewVersion, sourceHead }`.

**Tech Stack:** Hyperbee 2.27.x, HyperDB 6, existing publisher catalog verification, JavaScript ESM, Brittle.

## Global Constraints

- Depends on Plan 04 `createIndexerStore()` and compound publisher-prefix indexes.
- Never call nonexistent HyperDB change APIs on a publisher Hyperbee.
- Pin one source checkout for the entire diff; do not mix live view versions.
- Verify publisher namespace/root authorization before reading projections.
- A fork mismatch replaces only that publisher's slice, never the complete index.

---

### Task 1: Convert pinned publisher-view diffs into normalized operations

**Files:**
- Create: `packages/backend/src/indexer/catalog-ingestor.js`
- Create: `packages/backend/src/indexer/projection-normalizer.js`
- Modify: `packages/backend/src/indexer/index.js`
- Test: `packages/backend/test/indexer-catalog-ingestion.test.mjs`

**Interfaces:**
- Consumes: `openPublisherCatalogView()`, `getPublisherViewHead()`, current accepted namespace descriptor, and Plan 04 store.
- Produces: `ingestPublisher({ publisherId, descriptor, catalog, signal }) -> { status, inserted, deleted, cursor }`.

- [ ] **Step 1: Write a failing incremental ingestion test**

```js
const first = await ingestor.ingestPublisher(source)
t.is(first.status, 'rebuilt')
await publisher.putProjection(secondProjection)
const second = await ingestor.ingestPublisher(source)
t.is(second.status, 'incremental')
t.is(second.inserted, 1)
t.is(second.deleted, 0)
```

Assert the second pass does not rewrite the first projection row and that a source deletion removes its normalized edges.

- [ ] **Step 2: Implement deterministic projection normalization**

```js
const sourceKey = `${publisherId}:${sourceRecordRef}`
return {
  sourceRecords: [{
    publisherId, sourceRecordRef, sourceKey,
    recordType: projection.recordType,
    canonicalBody: projection.canonicalBody
  }],
  externalReferenceProjections: (projection.externalRefs || []).map(ref => ({
    publisherId, sourceRecordRef,
    namespace: normalizeNamespace(ref.namespace),
    normalizedIdentifier: normalizeIdentifier(ref.identifier)
  })),
  relationshipEdges: (projection.relationships || []).map(edge => ({
    publisherId, sourceRecordRef,
    relationType: edge.relationType,
    fromId: edge.fromId,
    toId: edge.toId
  }))
}
```

Return bounded `sourceRecords` plus normalized external-ref, publication, rendition, availability, and relationship rows. Each row key must be stable across replay and include source attribution.

- [ ] **Step 3: Implement pinned diff ingestion**

Read the prior durable cursor, open a source checkout at the current view version, call `checkout.createDiffStream(previousViewVersion)`, translate `left/right` changes to typed puts/deletes, and commit rows with the new cursor in one `applyPublisherChanges()` transaction.

- [ ] **Step 4: Run the focused test**

Run: `cd packages/backend && npx brittle test/indexer-catalog-ingestion.test.mjs`

Expected: PASS for initial rebuild, one insert, one update, one delete, cancellation, and duplicate replay.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer/catalog-ingestor.js packages/backend/src/indexer/projection-normalizer.js packages/backend/src/indexer/index.js packages/backend/test/indexer-catalog-ingestion.test.mjs
git commit -m "feat(indexer): ingest publisher catalog diffs"
```

### Task 2: Detect forks and repair one publisher transactionally

**Files:**
- Modify: `packages/backend/src/indexer/catalog-ingestor.js`
- Modify: `packages/backend/src/indexer/store.js`
- Test: `packages/backend/test/indexer-fork-repair.test.mjs`
- Test: `packages/backend/test/indexer-store.test.mjs`

**Interfaces:**
- Consumes: durable `SourceCursor { publisherId, catalogEpoch, catalogBootstrapKey, viewFork, viewVersion, sourceHead, lastVerifiedDescriptor }`.
- Produces: `repairPublisher({ publisherId, descriptor, catalog, reason })`.

- [ ] **Step 1: Write failing fork and stale-cursor tests**

```js
await ingestor.ingestPublisher(original)
await original.catalog.truncateAndReplace(reorderedEntries)
const repaired = await ingestor.ingestPublisher(original)
t.is(repaired.status, 'repaired')
t.is(repaired.reason, 'source-fork-changed')
t.is(await index.countPublisherRows(otherPublisherId), otherCount)
```

Also simulate a cursor version unavailable from source history and assert publisher-local rebuild.

- [ ] **Step 2: Implement cursor validation and repair**

Compare stored and current fork/head before applying a diff. On fork change, missing historical version, epoch change, or descriptor mismatch, enumerate the pinned current source view, build a replacement publisher slice off-transaction, then atomically replace only the publisher prefix and cursor.

- [ ] **Step 3: Prove restart idempotency**

Close after source rows commit but before the caller observes success, reopen, repeat ingestion, and assert no duplicate row or edge and unchanged usage counters.

- [ ] **Step 4: Run focused recovery tests**

Run: `cd packages/backend && npx brittle test/indexer-catalog-ingestion.test.mjs test/indexer-fork-repair.test.mjs test/indexer-store.test.mjs`

Expected: PASS for fork, reorder, stale cursor, crash/restart, and unaffected publisher isolation.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer packages/backend/test/indexer-catalog-ingestion.test.mjs packages/backend/test/indexer-fork-repair.test.mjs packages/backend/test/indexer-store.test.mjs
git commit -m "feat(indexer): ingest publisher Hyperbee diffs"
```