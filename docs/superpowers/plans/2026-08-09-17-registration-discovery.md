# Multi-Indexer Registration and Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let publishers register directly with multiple independent indexers and let a fresh watch-only companion discover/query index services without preloading the catalog.

**Architecture:** Bootstrap anti-entropy primarily discovers signed index-service announcements. A publisher connects directly to selected indexers and submits its signed current locator; each indexer verifies/follows the catalog and republishes its own service state, not publisher authority. Companions combine operator-configured services, discovered services, and optional stable seeder lists under local policy.

**Tech Stack:** Plans 15–16, Hyperswarm direct peers, Protomux index protocol, existing bootstrap manager, optional `@hyperswarm/seeders`/blind-peer configuration, Brittle.

## Global Constraints

- Depends on Plan 15 recovery plus Plan 16 `PublisherLocatorV2` and Plan 06 `IndexServiceAnnouncementV1`.
- Publisher registration with one indexer never makes that indexer canonical or grants it publication authority.
- A publisher should register with several independently identified indexers.
- Ordinary companions retain service announcements and queried source locators only; they do not persist the complete source corpus.
- Index/service roles change resource contribution, never permission to search the complete published catalog.
- Optional seeders/blind peers carry connectivity/replication availability only, not catalog truth.

---

### Task 1: Implement authenticated direct publisher registration

**Files:**
- Create: `packages/backend/src/indexer/registration.js`
- Modify: `packages/backend/src/indexer/protocol.js`
- Modify: `packages/backend/src/discovery/publisher-manager.js`
- Modify: `packages/backend/src/runtime.js`
- Test: `packages/backend/test/indexer-registration.test.mjs`

**Interfaces:**
- Produces request `RegisterPublisherV1 { requestId, locator, requestedPolicyClass }` and response `{ status, publisherId, sourceCursor, retryAfterMs }`.
- Produces publisher API `registerWithIndexers({ announcements, minimumSuccesses, signal })`.

- [ ] **Step 1: Write failing independent-registration tests**

```js
const result = await publisher.registerWithIndexers({ announcements: [index1, index2], minimumSuccesses: 2 })
t.is(result.accepted.length, 2)
t.is(index1.sourceCursor.publisherId, publisher.publisherId)
t.is(index2.sourceCursor.publisherId, publisher.publisherId)
```

Assert one indexer's admission rejection does not retract or suppress registration at the other.

- [ ] **Step 2: Implement bounded registration**

Verify the submitted locator/root proof, apply per-peer/publisher admission and rate limits, return explicit accepted/rejected/retry status, enqueue Plan 15 ingestion idempotently, and never accept caller-supplied arbitrary catalog/checkpoint keys outside verified locator/seal refs.

- [ ] **Step 3: Add publisher retry/backoff state**

Persist successful indexer identities, retry transient failures with bounded backoff/jitter, stop on permanent policy rejection, and refresh registration before locator/service expiry without coupling publisher writes to indexer availability.

- [ ] **Step 4: Run registration tests**

Run: `cd packages/backend && npx brittle test/indexer-registration.test.mjs test/publisher-protocol.test.mjs test/network-admission.test.mjs`

Expected: multiple independent accepts, isolated rejection, replay-safe retry, and publisher operation without any live indexer.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer/registration.js packages/backend/src/indexer/protocol.js packages/backend/src/discovery/publisher-manager.js packages/backend/src/runtime.js packages/backend/test/indexer-registration.test.mjs
git commit -m "feat(indexer): register publishers directly"
```

### Task 2: Discover and select index services as a fresh companion

**Files:**
- Create: `packages/backend/src/indexer/service-directory.js`
- Modify: `packages/backend/src/discovery/bootstrap-manager.js`
- Modify: `packages/backend/src/search/index-federation.js`
- Modify: `packages/backend/src/api/operability.js`
- Modify: `packages/cli/src/config.js`
- Test: `packages/backend/test/index-service-directory.test.mjs`
- Test: `packages/backend/test/watch-only-index-discovery.test.mjs`

**Interfaces:**
- Produces `createIndexServiceDirectory({ configured, discovered, policy, swarm, now })`.
- Produces `listSelectedServices(selector)` and diagnostics with source, identity, expiry, capabilities, shard coverage, connection state, and last bounded error.

- [ ] **Step 1: Write a failing fresh-install test**

```js
const companion = await createWatchOnlyCompanion(emptyStorage)
await companion.bootstrap(bootstrapPeers)
const services = companion.indexDirectory.listSelectedServices({ namespace: 'tmdb', identifier: '348' })
t.ok(services.length >= 2)
t.is(companion.localIndexSourceRecordCount(), 0)
```

Remove one service and assert query still finds the source through another.

- [ ] **Step 2: Implement deterministic local service policy**

Merge configured and verified discovered announcements by `indexerId`, filter by capability/shard/expiry/local trust policy, prefer independent signing identities and healthy connections, retain several services, and never equate service ranking with publication authority.

- [ ] **Step 3: Wire optional stable connectivity aids**

Add explicit config for seed endpoints and blind peers. Verify signed seed lists where used, keep them optional, and expose their connectivity role in diagnostics without granting index/source trust.

- [ ] **Step 4: Run discovery and search proof**

Run: `cd packages/backend && npx brittle test/index-service-directory.test.mjs test/watch-only-index-discovery.test.mjs test/index-federated-search.test.mjs test/bootstrap-anti-entropy.test.mjs`

Expected: a fresh watch-only node finds multiple indexers, queries the full catalog surface, stores no full index, and survives one indexer removal.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer packages/backend/src/discovery packages/backend/src/search packages/backend/src/api/operability.js packages/backend/src/runtime.js packages/backend/test packages/cli/src/config.js
git commit -m "feat(discovery): register publishers with independent indexes"
```