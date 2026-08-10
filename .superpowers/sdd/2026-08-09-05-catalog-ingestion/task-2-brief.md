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
