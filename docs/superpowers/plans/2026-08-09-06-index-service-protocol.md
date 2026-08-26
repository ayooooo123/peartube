# Index Service Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advertise independently operated index services and execute bounded typed queries over direct Protomux channels on the existing Hyperswarm lifecycle.

**Architecture:** A signed expiring service announcement binds indexer identity, transport public key, supported query capabilities, shard ranges, and policy digest. Companions call `swarm.joinPeer(transportPublicKey)` and dispatch the resulting connection into an `index` scoped protocol purpose. Query IDs correlate bounded request/page/error frames.

**Tech Stack:** Hyperswarm `joinPeer()`, Protomux, compact-encoding, existing application envelopes/replay windows, Brittle.

## Global Constraints

- Depends on Plan 05's durable query methods.
- Reuse the existing Hyperswarm and Protomux runtime; do not add `@hyperswarm/rpc` or another RPC convention.
- Announcement expiry removes the direct peer with `swarm.leavePeer()` when no other service needs it.
- Responses are unranked, paged, bounded, and source-attributed.
- Query telemetry never includes titles, external IDs, or selectors by default.

---

### Task 1: Define signed service announcements and index-purpose handshake

**Files:**
- Create: `packages/backend/src/indexer/service-announcement.js`
- Create: `packages/backend/src/indexer/protocol.js`
- Modify: `packages/backend/src/network/scoped-runtime.js`
- Modify: `packages/backend/src/network/topics.js`
- Test: `packages/backend/test/index-service-announcement.test.mjs`
- Test: `packages/backend/test/index-service-protocol.test.mjs`

**Interfaces:**
- Produces `IndexServiceAnnouncementV1` encode/decode/sign/verify helpers.
- Adds scoped purpose `index` and capability `index-query:v1`.
- Produces `attachIndexServiceProtocol({ connection, announcement, indexStore, limits })`.

- [ ] **Step 1: Write failing announcement and handshake tests**

```js
const signed = await createIndexServiceAnnouncement({
  indexerId, transportPublicKey, dimensions: ['external-ref'],
  shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
  queryCapabilities: ['exact-external-ref'], policyDigest, issuedAt, expiresAt
}, signer)
t.ok(await verifyIndexServiceAnnouncement(signed, { now: issuedAt + 1 }))
t.not(await verifyIndexServiceAnnouncement(signed, { now: expiresAt + 1 }))
```

Reject a handshake whose transport key differs from the signed announcement.

- [ ] **Step 2: Implement bounded signing and connection authorization**

Bind `indexerId` to the signing key/domain, validate monotonic sequence and expiry, cap dimensions/ranges/capabilities, add `index` to `PURPOSE_CODES`, and authorize the Protomux channel only after the remote transport key matches.

- [ ] **Step 3: Run focused protocol tests**

Run: `cd packages/backend && npx brittle test/index-service-announcement.test.mjs test/index-service-protocol.test.mjs test/scoped-network-runtime.test.mjs`

Expected: PASS for valid handshake, wrong transport, expired announcement, unsupported capability, and teardown.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/indexer/service-announcement.js packages/backend/src/indexer/protocol.js packages/backend/src/network/scoped-runtime.js packages/backend/src/network/topics.js packages/backend/test/index-service-announcement.test.mjs packages/backend/test/index-service-protocol.test.mjs
git commit -m "feat(indexer): authorize direct index service channels"
```

### Task 2: Implement bounded typed index queries

**Files:**
- Modify: `packages/backend/src/indexer/protocol.js`
- Create: `packages/backend/src/indexer/query-codec.js`
- Modify: `packages/backend/src/indexer/index.js`
- Test: `packages/backend/test/index-query-protocol.test.mjs`

**Interfaces:**
- Produces request `IndexQueryV1 { queryId, selectors, limit, cursor, deadlineMs }`.
- Produces response pages `IndexQueryPageV1 { queryId, results, nextCursor, sourceRevision }` and bounded errors.
- Produces client `queryIndex({ connection, query, signal })`.

- [ ] **Step 1: Write failing query correlation and bounds tests**

```js
const page = await client.queryIndex({
  connection, query: { queryId, selectors: [{ namespace: 'tmdb', identifier: '348' }], limit: 64, deadlineMs: 3000 }
})
t.is(page.queryId, queryId)
t.ok(page.results.every(row => row.publisherId && row.sourceRecordRef))
```

Assert cursor reuse against a different index revision, over-limit selectors, late pages, and cancellation fail with bounded codes.

- [ ] **Step 2: Implement codecs and server dispatch**

Use fixed compact-encoding schemas and maxima from the approved spec. Dispatch exact external-ref and bounded token-prefix queries to Plan 04, return opaque revision-scoped cursors, and close in-flight requests on connection teardown.

- [ ] **Step 3: Wire direct-peer connection dispatch**

On a verified announcement, call `swarm.joinPeer()`, match `info.publicKey` on `connection`, attach the index protocol, and call `leavePeer()` after expiry/supersession when the key has no remaining service reference.

- [ ] **Step 4: Run the two-peer smoke test**

Run: `cd packages/backend && npx brittle test/index-query-protocol.test.mjs test/index-service-protocol.test.mjs`

Expected: one service returns paged exact-ref results over a real Protomux connection; cancellation leaves zero pending requests.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/indexer packages/backend/src/network packages/backend/test/index-service-announcement.test.mjs packages/backend/test/index-service-protocol.test.mjs packages/backend/test/index-query-protocol.test.mjs
git commit -m "feat(indexer): add signed direct query service"
```