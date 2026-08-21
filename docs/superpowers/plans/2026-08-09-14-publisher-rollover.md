# Publisher Catalog Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross the bounded 4,096-operation catalog capacity by opening the next authorized epoch without changing publisher identity or replaying completed history.

**Architecture:** Near capacity, the publisher freezes normal writes, commits its current sparse checkpoint, signs the epoch seal, opens the next Autobase/Hyperbee catalog named by the seal, restores authorization/replay state, and resumes with epoch-bound operation signatures. Readers keep the old epoch addressable for audit while following the seal chain to the active epoch.

**Tech Stack:** PublisherCatalog, Autobase 7, Hyperbee, scoped replication runtime, signed publisher operations, Brittle.

## Global Constraints

- Depends on Plan 13 `CatalogEpochSeal`, checkpoint, and authorization-snapshot interfaces.
- Existing `PUBLISHER_LIMITS.maxJournalOperations === 4096` remains a per-epoch bound.
- Seal must commit before any next-epoch operation is accepted.
- Old catalog/checkpoint cores are read-only historical inputs after rollover.
- Every operation signature binds `catalogEpoch`; replaying an old-epoch writer operation in a later epoch fails.
- Rollover failure leaves one unambiguous active epoch and resumes or rolls back safely after restart.

---

### Task 1: Make publisher operations and namespace descriptors epoch-aware

**Files:**
- Modify: `packages/backend/src/publisher/namespace.js`
- Modify: `packages/backend/src/publisher/canonical.js`
- Modify: `packages/backend/src/publisher/catalog.js`
- Modify: `packages/backend/src/publisher/catalog-view.js`
- Modify: `packages/backend/src/records/signed-envelope.js`
- Test: `packages/backend/test/publisher-epoch-authorization.test.mjs`
- Test: `packages/backend/test/publisher-namespace.test.mjs`

**Interfaces:**
- Namespace descriptor adds current `catalogEpoch`, active catalog bootstrap key, latest seal/checkpoint refs, and bounded current-root proof.
- Publisher operation signature preimage adds exact `catalogEpoch`.

- [ ] **Step 1: Write failing cross-epoch replay tests**

```js
const epoch0 = await signPublisherOperation({ ...operation, catalogEpoch: 0 }, writer)
t.ok(await verifyPublisherOperation(epoch0, { expectedCatalogEpoch: 0 }))
t.not(await verifyPublisherOperation(epoch0, { expectedCatalogEpoch: 1 }))
```

Assert a descriptor cannot advance to epoch 1 without a valid committed epoch-0 seal and next bootstrap key.

- [ ] **Step 2: Update canonical signing and descriptor verification**

Bind epoch in signature preimages, include seal-chain proof in descriptor normalization, and preserve legacy epoch 0 only as an explicit migration input. Remove any assumption that catalog bootstrap key is permanent identity.

- [ ] **Step 3: Run authorization tests**

Run: `cd packages/backend && npx brittle test/publisher-epoch-authorization.test.mjs test/publisher-namespace.test.mjs test/signed-envelope.test.mjs`

Expected: correct epoch passes; replay, skipped seal, wrong bootstrap, and root rotation confused with rollover fail.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/publisher/namespace.js packages/backend/src/publisher/canonical.js packages/backend/src/publisher/catalog.js packages/backend/src/publisher/catalog-view.js packages/backend/src/records/signed-envelope.js packages/backend/test/publisher-epoch-authorization.test.mjs packages/backend/test/publisher-namespace.test.mjs
git commit -m "feat(publisher): bind operations to catalog epochs"
```

### Task 2: Execute and recover catalog rollover

**Files:**
- Modify: `packages/backend/src/publisher/catalog.js`
- Modify: `packages/backend/src/publisher/catalog-view.js`
- Modify: `packages/backend/src/discovery/publisher-manager.js`
- Modify: `packages/backend/src/discovery/publisher-protocol.js`
- Modify: `packages/backend/src/network/scoped-runtime.js`
- Test: `packages/backend/test/publisher-rollover.test.mjs`
- Test: `packages/backend/test/publisher-sync-budget.test.mjs`
- Test: `packages/backend/test/product-chaos-recovery.test.mjs`

**Interfaces:**
- Produces `PublisherCatalog.rollover({ rootAuthorization, signal }) -> { previousEpoch, catalogEpoch, seal, descriptor }`.
- Reader API produces `openActivePublisherCatalog({ descriptor })` and bounded historical audit access by committed core ref.

- [ ] **Step 1: Write a failing 4,097-operation proof**

```js
for (let i = 0; i < 4096; i++) await publisher.append(operationFor(i))
const rollover = await publisher.rollover({ rootAuthorization })
await publisher.append(operationFor(4096))
t.is(rollover.catalogEpoch, 1)
t.is(publisher.publisherId, originalPublisherId)
t.is((await publisher.getProjection('claim', id4096)).catalogEpoch, 1)
```

Inject crashes before seal commit, after seal commit, and after next catalog open; each restart must select one valid active epoch.

- [ ] **Step 2: Implement the rollover transaction protocol**

Freeze non-authority writes, flush current view/checkpoint, create and commit the root-authorized seal in epoch 0, open epoch 1 from the committed next key, restore complete authorization/replay state, publish the updated descriptor, then release queued writes with epoch-1 signatures.

- [ ] **Step 3: Extend verified replication dispatch**

Allow publisher sessions to request only current catalog, current checkpoint, and referenced sealed epoch/delta cores. Reject arbitrary caller-supplied keys; require core refs committed by the verified descriptor or seal.

- [ ] **Step 4: Run rollover and crash tests**

Run: `cd packages/backend && npx brittle test/publisher-rollover.test.mjs test/publisher-sync-budget.test.mjs test/product-chaos-recovery.test.mjs`

Expected: 4,097th operation succeeds in epoch 1; publisher ID is stable; crash cases recover; replay and uncommitted checkpoint attacks fail.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/publisher packages/backend/src/records/signed-envelope.js packages/backend/src/discovery packages/backend/src/network/scoped-runtime.js packages/backend/test
git commit -m "feat(publisher): roll bounded catalogs across epochs"
```