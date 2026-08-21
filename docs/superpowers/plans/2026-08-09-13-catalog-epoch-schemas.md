# Catalog Epoch Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode root-authorized catalog epoch seals, sparse checkpoints, and next-epoch descriptors with complete authorization/replay state.

**Architecture:** A publisher root signs one `CatalogEpochSeal` that commits the completed epoch head, an incrementally maintained checkpoint Hyperbee, authorization state digest and snapshot, policy/replay state, and the next catalog bootstrap key. The publisher identity/root key remains unchanged.

**Tech Stack:** Existing canonical publisher operation codecs, signed envelopes, Hyperbee, Hypercore/Corestore, Brittle.

## Global Constraints

- Depends on Plan 05 source cursor semantics.
- Rollover is capacity management, not identity/root-key rotation.
- Do not serialize the complete active catalog into a new snapshot every 4,096 operations.
- The checkpoint is a long-lived sparse Hyperbee updated incrementally and committed by the seal.
- Authorization snapshot must include writer admission/revocation high-water marks, root transition state, policy epochs, replay windows, and required sequence state.
- A seal is valid only when signed with current root-operation authorization.

---

### Task 1: Add canonical rollover records and verification

**Files:**
- Modify: `packages/backend/src/publisher/canonical.js`
- Create: `packages/backend/src/publisher/rollover.js`
- Modify: `packages/backend/src/publisher/index.js`
- Test: `packages/backend/test/publisher-rollover-schema.test.mjs`

**Interfaces:**
- Adds publisher record type `CATALOG_EPOCH_SEAL`.
- Produces `encodeCatalogEpochSealBody`, `decodeCatalogEpochSealBody`, `deriveCatalogEpochSealId`, and `verifyCatalogEpochSeal`.
- Seal fields include `publisherId`, `catalogEpoch`, `previousCatalogEpoch`, `previousCatalogBootstrapKey`, `catalogHead`, `catalogFork`, `catalogLength`, `checkpointCoreRef`, `checkpointStateDigest`, `authorizationStateDigest`, `authorizationSnapshotRef`, `policySequence`, `recoveryPolicyDigest`, `nextCatalogEpoch`, `nextCatalogBootstrapKey`, `issuedAt`, and root authorization proof.

- [ ] **Step 1: Write failing canonical round-trip tests**

```js
const encoded = encodeCatalogEpochSealBody(body)
const decoded = decodeCatalogEpochSealBody(encoded)
t.alike(decoded, body)
t.alike(deriveCatalogEpochSealId(decoded), deriveCatalogEpochSealId(body))
t.exception(() => encodeCatalogEpochSealBody({ ...body, nextCatalogEpoch: body.catalogEpoch + 2 }))
```

Assert exact fields, integer bounds, epoch adjacency, core ref bounds, and unknown-field rejection.

- [ ] **Step 2: Implement codecs and root authorization**

Use existing canonical field encoding, domain-separated seal IDs, and `getPublisherRootOperationAuthorization()` semantics. Make `requiredPublisherCapability(CATALOG_EPOCH_SEAL)` root-only.

- [ ] **Step 3: Run schema tests**

Run: `cd packages/backend && npx brittle test/publisher-rollover-schema.test.mjs test/publisher-authorization.test.mjs test/publisher-catalog.test.mjs`

Expected: valid seals round-trip/verify; stale root, skipped epoch, tampered checkpoint, and non-root writer fail.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/publisher/canonical.js packages/backend/src/publisher/rollover.js packages/backend/src/publisher/index.js packages/backend/test/publisher-rollover-schema.test.mjs
git commit -m "feat(publisher): define catalog epoch seals"
```

### Task 2: Maintain and validate sparse checkpoint state

**Files:**
- Create: `packages/backend/src/publisher/checkpoint.js`
- Modify: `packages/backend/src/publisher/catalog-view.js`
- Test: `packages/backend/test/publisher-checkpoint.test.mjs`

**Interfaces:**
- Produces `openPublisherCheckpoint(store, key?)`, `applyCheckpointChanges(checkpoint, projectionChanges)`, `sealCheckpoint(checkpoint, authorizationState)`, and `verifyCheckpointAgainstSeal(checkpoint, seal)`.
- Checkpoint keys cover current projections, descriptor, complete authorization snapshot, replay/sequence high-water state, and checkpoint metadata.

- [ ] **Step 1: Write a failing incremental checkpoint test**

```js
await applyCheckpointChanges(checkpoint, [{ type: 'put', key: projectionKey, value }])
const before = checkpoint.core.length
await applyCheckpointChanges(checkpoint, [{ type: 'put', key: secondKey, value: secondValue }])
t.ok(checkpoint.core.length > before)
t.is((await checkpoint.get(projectionKey)).value.toString(), value.toString())
```

Assert sealing 4,096 changes does not rewrite every unchanged projection and the checkpoint contains the exact authorization snapshot.

- [ ] **Step 2: Implement incremental checkpoint maintenance**

Feed accepted projection put/delete changes from `applyPublisherCatalogNodes()` into the checkpoint Hyperbee transactionally with the view. Persist a checkpoint cursor and reject a seal unless its committed core ref and state digests match the current checkpoint.

- [ ] **Step 3: Run checkpoint and catalog tests**

Run: `cd packages/backend && npx brittle test/publisher-checkpoint.test.mjs test/publisher-rollover-schema.test.mjs test/publisher-catalog.test.mjs`

Expected: unchanged tree history is reused, authorization state is complete, and tampered/uncommitted checkpoints fail.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/publisher packages/backend/test/publisher-rollover-schema.test.mjs packages/backend/test/publisher-checkpoint.test.mjs
git commit -m "feat(publisher): define sealed catalog epochs"
```