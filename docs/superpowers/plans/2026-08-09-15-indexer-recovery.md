# Indexer Restart and Publisher Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make warm and cold indexers converge to the same source/projection/authorization state from bounded checkpoints and durable cursors without replaying all completed capacity epochs.

**Architecture:** The indexer verifies the stable publisher genesis and current-root proof, follows the root-authorized seal chain to the active epoch, sparsely fetches the latest checkpoint and active delta, validates full authorization/replay state, and then resumes native Hyperbee diffs from its durable source cursor. Cursor or fork failure triggers publisher-local repair.

**Tech Stack:** Plan 05 ingestor/store, Plan 14 epoch catalogs, Corestore sparse replication, Hyperbee diffs, HyperDB transactions, Brittle.

## Global Constraints

- Depends on Plan 14 runtime rollover.
- Cold start must not serially fetch every prior capacity epoch.
- Historical epochs remain fetchable for audit/repair but are not required for normal current-state query service.
- Warm/cold equality includes source rows, projections, authorization digest, policy/replay state, and source cursor.
- Repair remains bounded to one publisher and preserves every other publisher's index rows.

---

### Task 1: Bootstrap a publisher index from checkpoint plus active delta

**Files:**
- Create: `packages/backend/src/indexer/epoch-bootstrap.js`
- Modify: `packages/backend/src/indexer/catalog-ingestor.js`
- Modify: `packages/backend/src/indexer/store.js`
- Test: `packages/backend/test/indexer-epoch-bootstrap.test.mjs`

**Interfaces:**
- Produces `bootstrapPublisher({ descriptor, fetchCore, signal }) -> { checkpoint, activeCatalog, authorizationState, cursor }`.
- Produces source status `checkpoint-bootstrap | active-delta | current`.

- [ ] **Step 1: Write a failing cold-start boundedness test**

```js
const result = await bootstrapPublisher({ descriptor: epoch7Descriptor, fetchCore })
t.is(result.cursor.catalogEpoch, 7)
t.alike(result.authorizationState.digest, publisher.authorizationDigest)
t.not(fetchCore.requestedEpochs.includes(0))
t.ok(fetchCore.requestedRefs.includes(epoch7Descriptor.checkpointCoreRef.key))
```

Assert the fetched current state equals an indexer that followed epochs 0 through 7 live.

- [ ] **Step 2: Implement seal-chain and checkpoint verification**

Verify stable genesis/current root, the current seal's root authorization and predecessor commitment, fetch only referenced checkpoint/authorization cores, validate all digests, open the active catalog, apply its committed delta, and transactionally install the publisher slice/cursor.

- [ ] **Step 3: Run bootstrap tests**

Run: `cd packages/backend && npx brittle test/indexer-epoch-bootstrap.test.mjs test/publisher-rollover.test.mjs`

Expected: warm and cold source/projection/authorization digests match; uncommitted, stale-root, or tampered checkpoint inputs fail.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/indexer/epoch-bootstrap.js packages/backend/src/indexer/catalog-ingestor.js packages/backend/src/indexer/store.js packages/backend/test/indexer-epoch-bootstrap.test.mjs
git commit -m "feat(indexer): bootstrap from publisher checkpoints"
```

### Task 2: Persist restart cursors and repair forks across epochs

**Files:**
- Modify: `packages/backend/src/indexer/catalog-ingestor.js`
- Modify: `packages/backend/src/indexer/store.js`
- Modify: `packages/backend/src/indexer/epoch-bootstrap.js`
- Test: `packages/backend/test/indexer-restart-repair.test.mjs`
- Test: `packages/backend/test/indexer-fork-repair.test.mjs`
- Test: `packages/backend/test/product-chaos-recovery.test.mjs`

**Interfaces:**
- Extends `SourceCursor` with committed epoch seal/checkpoint refs and authorization digest.
- Produces `reconcilePublisher({ publisherId, descriptor, reason })` with deterministic outcomes `incremental`, `epoch-advanced`, `repaired`, or `rejected`.

- [ ] **Step 1: Write failing crash-window tests**

```js
await harness.crashAfter('projection-commit-before-observed-success')
const restarted = await reopenIndexer(storage)
const result = await restarted.reconcilePublisher(source)
t.is(result.status, 'incremental')
t.is(await restarted.countSourceRecord(sourceRecordRef), 1)
```

Cover crash during checkpoint install, active delta, cursor advancement, source fork, and epoch advancement.

- [ ] **Step 2: Implement atomic resume and epoch transition**

Persist source rows, derived rows, usage, epoch refs, view fork/version/head, and authorization digest in one transaction. On epoch advance, verify the seal then checkpoint-bootstrap; on active-epoch fork, rebuild only the publisher slice; on stale/forged rollover, keep the last verified cursor and return `rejected`.

- [ ] **Step 3: Prove other publishers remain online**

During one publisher repair, query a second publisher concurrently and assert its rows, latency budget, and cursor are unchanged.

- [ ] **Step 4: Run restart/repair checks**

Run: `cd packages/backend && npx brittle test/indexer-restart-repair.test.mjs test/indexer-fork-repair.test.mjs test/indexer-epoch-bootstrap.test.mjs test/product-chaos-recovery.test.mjs`

Expected: no duplicate projection rows, exact warm/cold convergence, one-publisher repair, and bounded active replay.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer packages/backend/test/indexer-epoch-bootstrap.test.mjs packages/backend/test/indexer-restart-repair.test.mjs packages/backend/test/indexer-fork-repair.test.mjs
git commit -m "feat(indexer): recover from bounded publisher checkpoints"
```