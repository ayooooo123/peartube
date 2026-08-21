# Verified Multi-Peer Range Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream sparse byte ranges from multiple peers, verify every block against the static core, and survive seek and peer loss without origin fallback.

**Architecture:** Asset-scoped Protomux sessions exchange bounded pageable range inventories and block/proof responses. A scheduler splits missing canonical blocks across eligible peers using latency, throughput, failure history, and playhead urgency. Only Hypercore-verified blocks enter the local sparse core or HTTP response.

**Tech Stack:** Existing scoped network runtime, Protomux, compact-encoding, Hypercore sparse replication, Brittle.

## Global Constraints

- Depends on Plan 02 `AssetCoreRefV2` and canonical block boundaries.
- Range inventory is an untrusted scheduling hint; possession is established only by returned blocks plus valid Hypercore proofs.
- Inventory pages and transfer frames are bounded and cancellable.
- No HTTP origin/debrid fallback exists inside this scheduler.
- A seek cancels obsolete prefetch without cancelling the exact active playhead range.

---

### Task 1: Add pageable asset inventory and verified block transport

**Files:**
- Modify: `packages/backend/src/network/frame.js`
- Modify: `packages/backend/src/network/scoped-runtime.js`
- Modify: `packages/backend/src/network/version.js`
- Modify: `packages/backend/src/assets/asset-session.js`
- Modify: `packages/backend/src/assets/availability.js`
- Test: `packages/backend/test/network-frame.test.mjs`
- Test: `packages/backend/test/asset-session.test.mjs`
- Test: `packages/backend/test/protocol-version-skew.test.mjs`
- Test: `packages/backend/test/asset-availability.test.mjs`

**Interfaces:**
- Produces scoped capability `asset-rendition:v2` plus frames `asset-range-summary-request`, `asset-range-summary-page`, `asset-block-request`, `asset-block-response`, and `asset-block-error`.
- Produces `listAssetRanges({ assetId, cursor, limit }) -> { ranges, nextCursor }` and `requestAssetBlocks({ assetId, startBlock, endBlock, signal })`.

- [ ] **Step 1: Write failing codec and pagination tests**

```js
const page = decodeAssetRangeSummaryPage(encodeAssetRangeSummaryPage({
  assetId, ranges: [{ startBlock: 0, bitCount: 8, presentBitfield }], nextCursor: '8'
}))
t.is(page.ranges.length, 1)
t.is(page.nextCursor, '8')
t.exception(() => encodeAssetRangeSummaryPage({ assetId, ranges: oversizedRanges }))
```

- [ ] **Step 2: Implement bounded codecs and session handlers**

Add exact maxima from the approved spec, reject overlapping/out-of-bounds pages, bind every frame to one asset scope, reconstruct the exact static manifest before accepting custom proof frames, and bump the scoped protocol major/capability so v1 peers cannot misinterpret v2 asset identities.

- [ ] **Step 3: Verify frame and session behavior**

Run: `cd packages/backend && npx brittle test/network-frame.test.mjs test/asset-session.test.mjs test/asset-availability.test.mjs test/protocol-version-skew.test.mjs`

Expected: PASS for pagination, cancellation, malformed proofs, wrong asset IDs, and responder teardown.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/network/frame.js packages/backend/src/network/scoped-runtime.js packages/backend/src/network/version.js packages/backend/src/assets/asset-session.js packages/backend/src/assets/availability.js packages/backend/test/network-frame.test.mjs packages/backend/test/asset-session.test.mjs packages/backend/test/asset-availability.test.mjs packages/backend/test/protocol-version-skew.test.mjs
git commit -m "feat(protocol): add verified asset range transport"
```

### Task 2: Schedule and stream ranges across peers

**Files:**
- Modify: `packages/backend/src/playback/multi-peer-scheduler.js`
- Modify: `packages/backend/src/playback/index.js`
- Modify: `packages/backend/src/playback-forward-fill.js`
- Modify: `packages/backend/src/blob-playback-service.js`
- Test: `packages/backend/test/multi-peer-playback.test.mjs`
- Test: `packages/backend/test/playback-forward-fill.test.mjs`
- Test: `packages/backend/test/playback-api.test.mjs`

**Interfaces:**
- Consumes: verified asset sessions and local sparse-core inventory.
- Produces: `requestRange({ assetId, byteStart, byteEnd, deadlineMs, signal }) -> { status, bytes, verified, peerIds }` and `seek({ byteStart })`.

- [ ] **Step 1: Replace the synthetic scheduler test with byte verification**

```js
const first = await scheduler.requestRange({ assetId, byteStart: 0, byteEnd: 524288, deadlineMs: 5000 })
t.is(first.status, 'ok')
t.ok(first.verified)
t.ok(first.peerIds.includes('peer-a'))
t.ok(first.peerIds.includes('peer-b'))
t.alike(first.bytes, sourceBytes.subarray(0, 524288))
```

Disconnect `peer-a` during a later seek and assert completion from `peer-b` without an origin attempt.

- [ ] **Step 2: Implement block planning, hedging, and penalties**

Track per-peer range coverage, RTT, throughput, in-flight bytes, invalid-proof failures, and cooldown. Assign different missing block runs to different peers, hedge only after the urgency threshold, write verified blocks into the sparse core, and expose bounded error codes `NO_VERIFIED_SOURCE`, `DEADLINE_EXCEEDED`, and `BUDGET_EXHAUSTED`.

- [ ] **Step 3: Wire the playback service**

Translate HTTP byte ranges to exact block runs, trim the first/last blocks to requested bytes, preserve `206`, `Content-Range`, and `Content-Length`, and cancel stale prefetch on seek/client disconnect.

- [ ] **Step 4: Run the playback proof**

Run: `cd packages/backend && npx brittle test/multi-peer-playback.test.mjs test/playback-forward-fill.test.mjs test/playback-api.test.mjs`

Expected: PASS with two peers, mid-stream loss, backward/forward seeks, corrupt blocks, and no available owner.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/network packages/backend/src/assets packages/backend/src/playback packages/backend/src/playback-forward-fill.js packages/backend/src/blob-playback-service.js packages/backend/test
git commit -m "feat(playback): verify sparse ranges across multiple peers"
```