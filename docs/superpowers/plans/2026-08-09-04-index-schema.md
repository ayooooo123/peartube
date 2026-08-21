# Durable Index Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist bounded, source-attributed raw records and independently derived search projections in one generated HyperDB index.

**Architecture:** A new indexer module owns a generated HyperDB schema with normalized collections and compound publisher-prefix indexes. Raw source rows remain distinct from projection rows. All writes run in HyperDB transactions behind persistent byte/row admission accounting.

**Tech Stack:** HyperDB 6, Hyperschema, Corestore, JavaScript ESM, Brittle.

## Global Constraints

- Depends on Plan 02 publication/asset identifiers.
- HyperDB is the durable index target; publisher source remains Hyperbee.
- Every source-derived row and edge includes `publisherId` plus `sourceRecordRef`.
- Do not embed unbounded arrays in projection rows; use normalized relation collections.
- Search policy may suppress projection rows but never mutate the source record.
- Enforce global, shard, publisher, and admission/trust-class row and retained-byte ceilings before durable writes.

---

### Task 1: Generate the normalized HyperDB schema

**Files:**
- Create: `packages/backend/src/indexer/index-hyperdb-build.cjs`
- Generate: `packages/backend/src/indexer/index-hyperdb-spec/hyperschema/`
- Generate: `packages/backend/src/indexer/index-hyperdb-spec/hyperdb/`
- Create: `packages/backend/src/indexer/schema.js`
- Test: `packages/backend/test/indexer-schema.test.mjs`

**Interfaces:**
- Produces collections `sourceRecords`, `sourceCursors`, `externalReferenceProjections`, `publicationProjections`, `renditionProjections`, `availabilityProjections`, and `relationshipEdges`.
- Produces `openIndexerDatabase(store, options)`.

- [ ] **Step 1: Write a failing schema conformance test**

```js
await db.insert('@peartubeIndex/sourceRecords', sourceRecord)
await db.insert('@peartubeIndex/relationshipEdges', {
  publisherId, sourceRecordRef, relationType: 'work-rendition',
  fromId: workId, toId: renditionId
})
const rows = await db.find('@peartubeIndex/relationshipEdges', {
  publisherId, relationType: 'work-rendition'
}).toArray()
t.is(rows.length, 1)
```

Assert the schema rejects a row without `publisherId`, a duplicate compound key, and values beyond approved byte maxima.

- [ ] **Step 2: Define and generate the schema**

Follow `packages/backend/src/channel/public-hyperdb-build.cjs`. Register bounded scalar fields, normalized compound keys, and indexes for exact external refs, work/entity IDs, normalized token prefixes, asset IDs, publication IDs, and publisher-prefix deletion/repair.

- [ ] **Step 3: Run generation and conformance**

Run: `node packages/backend/src/indexer/index-hyperdb-build.cjs`

Run: `cd packages/backend && npx brittle test/indexer-schema.test.mjs`

Expected: generated ESM definitions load and every normalized query returns only its source-attributed rows.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/indexer/index-hyperdb-build.cjs packages/backend/src/indexer/index-hyperdb-spec packages/backend/src/indexer/schema.js packages/backend/test/indexer-schema.test.mjs
git commit -m "feat(indexer): generate normalized HyperDB schema"
```

### Task 2: Add persistent admission and transactional source-slice writes

**Files:**
- Create: `packages/backend/src/indexer/store.js`
- Create: `packages/backend/src/indexer/admission.js`
- Create: `packages/backend/src/indexer/index.js`
- Modify: `packages/backend/package.json`
- Test: `packages/backend/test/indexer-store.test.mjs`
- Test: `packages/backend/test/indexer-admission.test.mjs`

**Interfaces:**
- Produces `createIndexerStore({ store, limits, policy })`.
- Produces `replacePublisherSlice({ publisherId, rows, cursor })`, `applyPublisherChanges({ publisherId, operations, cursor })`, `queryExactExternalRef(selector)`, and `snapshotUsage()`.

- [ ] **Step 1: Write failing transaction and quota tests**

```js
await index.replacePublisherSlice({ publisherId, rows, cursor })
const before = await index.snapshotUsage()
await t.exception(index.applyPublisherChanges({ publisherId, operations: oversized, cursor: nextCursor }))
const after = await index.snapshotUsage()
t.alike(after, before)
```

Restart the store and assert usage counters, cursor, and source rows remain consistent.

- [ ] **Step 2: Implement admission before commit**

Calculate encoded row bytes before opening the transaction, reserve global/shard/publisher/trust-class budgets atomically, write or replace normalized rows, persist accounting and `SourceCursor` in the same transaction, and roll back reservations on failure.

- [ ] **Step 3: Implement local eviction semantics**

Eviction deletes source rows and publisher-prefixed derived rows together, records an admission tombstone so immediate anti-entropy does not reinsert them, and never emits a publisher retraction or network deletion claim.

- [ ] **Step 4: Run focused persistence checks**

Run: `cd packages/backend && npx brittle test/indexer-schema.test.mjs test/indexer-store.test.mjs test/indexer-admission.test.mjs test/storage-pressure.test.mjs`

Expected: PASS across restart, failed transaction, hard ceiling, local eviction, and per-publisher repair.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer packages/backend/package.json packages/backend/test/indexer-schema.test.mjs packages/backend/test/indexer-store.test.mjs packages/backend/test/indexer-admission.test.mjs
git commit -m "feat(indexer): add durable normalized HyperDB index"
```