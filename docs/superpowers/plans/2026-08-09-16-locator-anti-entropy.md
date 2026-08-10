# Locator Anti-Entropy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge signed publisher-locator and index-service control records across bootstrap peers with deterministic expiry, replay, and equivocation behavior.

**Architecture:** Versioned signed control records carry one stable identity, monotonic sequence, issue/expiry times, transport/service metadata, and root authorization proof where required. Bootstrap peers retain a bounded accepted map, exchange summary digests and paged missing records, and reconcile by deterministic identity/sequence rules. Expiry/supersession removes direct peers when unreferenced.

**Tech Stack:** Existing bootstrap protocol/manager, signed application envelopes, replay windows, compact-encoding, Hyperswarm, Brittle.

## Global Constraints

- Depends on Plan 06 service announcements.
- Control records carry locators/service metadata only, never catalog content or search authority.
- `PublisherLocatorV2` signer must equal the active root key proved for `publisherId`, unless the root explicitly authorizes a locator-signing role.
- Same identity/sequence with different canonical bodies is equivocation: quarantine both and do not choose by arrival order.
- Every summary/page/record set is bounded by count and encoded bytes.
- Expired or superseded transport keys call `leavePeer()` only when no retained service references them.

---

### Task 1: Define v2 locator identity and acceptance rules

**Files:**
- Modify: `packages/backend/src/discovery/bootstrap-protocol.js`
- Create: `packages/backend/src/discovery/locator-state.js`
- Modify: `packages/backend/src/network/replay-window.js`
- Test: `packages/backend/test/bootstrap-protocol.test.mjs`
- Test: `packages/backend/test/locator-state.test.mjs`

**Interfaces:**
- Produces `PublisherLocatorV2 { publisherId, catalogEpoch, catalogBootstrapKey, catalogHead, sequence, issuedAt, expiresAt, transportPublicKeys, capabilities, rootProof, signature }`.
- Produces `acceptControlRecord(record, context) -> accepted | stale | duplicate | equivocation | expired | rejected`.

- [ ] **Step 1: Write failing identity/replay/equivocation tests**

```js
const first = await state.accept(locator({ publisherId, sequence: 7, catalogHead: headA }))
t.is(first.status, 'accepted')
const replay = await state.accept(locator({ publisherId, sequence: 6, catalogHead: oldHead }))
t.is(replay.status, 'stale')
const conflict = await state.accept(locator({ publisherId, sequence: 7, catalogHead: headB }))
t.is(conflict.status, 'equivocation')
t.is(state.get(publisherId), null)
```

Reject a trusted envelope signer attempting to assert another publisher's locator without root proof.

- [ ] **Step 2: Implement bounded v2 codecs and verification**

Add exact-field canonical encoding, domain-separated signatures, root-chain verification, sequence/expiry checks, deterministic canonical body fingerprints, and per-identity quarantine. Keep v1 locators as local migration input only; never relay them into the federated path.

- [ ] **Step 3: Run acceptance tests**

Run: `cd packages/backend && npx brittle test/bootstrap-protocol.test.mjs test/locator-state.test.mjs test/network-replay-window.test.mjs`

Expected: valid updates advance; stale/replayed/forged/expired inputs fail; equivocation is arrival-order independent.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/discovery/bootstrap-protocol.js packages/backend/src/discovery/locator-state.js packages/backend/src/network/replay-window.js packages/backend/test/bootstrap-protocol.test.mjs packages/backend/test/locator-state.test.mjs
git commit -m "feat(discovery): verify v2 publisher locators"
```

### Task 2: Add bounded summary/page reconciliation and cleanup

**Files:**
- Modify: `packages/backend/src/discovery/bootstrap-manager.js`
- Modify: `packages/backend/src/discovery/bootstrap-protocol.js`
- Modify: `packages/backend/src/network/scoped-runtime.js`
- Test: `packages/backend/test/bootstrap-manager.test.mjs`
- Test: `packages/backend/test/bootstrap-anti-entropy.test.mjs`

**Interfaces:**
- Adds frames `control-summary`, `control-page-request`, `control-page`, and `control-records`.
- Produces `reconcileControlState(peer, { cursor, limit, signal })` and periodic bounded reconciliation.

- [ ] **Step 1: Write a failing convergence test**

```js
await nodeA.accept(records.slice(0, 40))
await nodeB.accept(records.slice(20, 60))
await reconcile(nodeA, nodeB)
t.alike(nodeA.acceptedIds(), nodeB.acceptedIds())
t.ok(nodeA.lastPageBytes <= MAX_CONTROL_PAGE_BYTES)
```

Partition, update both sides, reconnect, and assert the same accepted/quarantined sets regardless of message order.

- [ ] **Step 2: Implement deterministic summaries and pages**

Summaries contain sorted identity/sequence/body-digest tuples or bounded buckets. Request pages by opaque cursor, validate every returned record independently, apply acceptance rules, and repeat until both summaries match or the per-peer reconciliation budget is exhausted.

- [ ] **Step 3: Implement expiry/supersession cleanup**

On timer or accepted replacement, delete expired records, decrement transport-key references, close index/publisher channels, call `swarm.leavePeer()` at zero references, and persist enough accepted/quarantine state to prevent replay after restart.

- [ ] **Step 4: Run anti-entropy proof**

Run: `cd packages/backend && npx brittle test/bootstrap-anti-entropy.test.mjs test/bootstrap-manager.test.mjs test/scoped-network-runtime.test.mjs`

Expected: partitioned nodes converge, page limits hold, equivocation stays quarantined, and expired services leave direct-peer state.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/discovery packages/backend/src/network packages/backend/test/bootstrap-protocol.test.mjs packages/backend/test/locator-state.test.mjs packages/backend/test/bootstrap-anti-entropy.test.mjs packages/backend/test/bootstrap-manager.test.mjs
git commit -m "feat(discovery): converge signed locator control state"
```