# Multi-Index Union and Source Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Query several indexers, preserve disagreement and provenance, deduplicate source-identical candidates, and verify only MediaStorm's selected candidate against the current accepted publisher source.

**Architecture:** A replacement federated coordinator sends the same bounded selector query to configured index services, unions results by source identity, and returns URL-less unranked candidate facts. An opaque local `candidateRef` binds the cached facts and locator. Selection triggers publisher namespace verification, current projection lookup, immutable descriptor verification, and live availability probing.

**Tech Stack:** Plan 06 index protocol, publisher catalog view, media graph identifiers, existing source selector diagnostics, JavaScript ESM, Brittle.

## Global Constraints

- Search responses never contain playback URLs, credentials, or control capabilities.
- One indexer's omission, annotation, or policy decision does not overwrite another indexer's result.
- Source verification is against the current accepted publisher projection, not merely an old valid signature.
- `candidateRef` is random/opaque, bounded, local, expiring, and not a network identity.
- MediaStorm, not PearTube, owns compatibility ranking and final selection.

---

### Task 1: Replace broadcast search with bounded multi-index union

**Files:**
- Create: `packages/backend/src/search/index-federation.js`
- Modify: `packages/backend/src/search/federated-search.js`
- Modify: `packages/backend/src/api/search.js`
- Modify: `packages/backend/src/media-graph/selection-diagnostics.js`
- Test: `packages/backend/test/index-federated-search.test.mjs`
- Test: `packages/backend/test/search-direct-ref-regression.test.mjs`

**Interfaces:**
- Produces `createIndexFederation({ services, cache, limits, now })`.
- Produces `search({ selector, limit, signal }) -> CompanionCandidateV2[]` with `candidateRef` and `sourceIndexers[]`.

- [ ] **Step 1: Inspect exported-symbol references before cutover**

Use LSP references for `FederatedSearch` and `createSearchApi`; record every caller in the task notes and update all of them in this task.

- [ ] **Step 2: Write failing union/dedup tests**

```js
const results = await federation.search({ selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' }, limit: 64 })
t.is(results.length, 2)
t.is(results[0].streamUrl, undefined)
t.ok(results[0].candidateRef)
t.alike(results[0].sourceIndexers.map(row => row.indexerId).sort(), ['i1', 'i2'])
```

Assert two conflicting source records remain two candidates and one timed-out indexer does not erase successful results.

- [ ] **Step 3: Implement bounded concurrent queries and cache**

Query configured services concurrently under one deadline, validate every page, deduplicate only identical `{ publisherId, sourceRecordRef, publicationId, renditionId, assetId }`, preserve indexer evidence, issue expiring local `candidateRef` values, and return no universal score/order promise.

- [ ] **Step 4: Run focused search tests**

Run: `cd packages/backend && npx brittle test/index-federated-search.test.mjs test/search-direct-ref-regression.test.mjs test/media-selection-diagnostics.test.mjs`

Expected: PASS for union, disagreement, timeout, paging, dedup, and candidate expiry.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/search/index-federation.js packages/backend/src/search/federated-search.js packages/backend/src/api/search.js packages/backend/src/media-graph/selection-diagnostics.js packages/backend/test/index-federated-search.test.mjs packages/backend/test/search-direct-ref-regression.test.mjs
git commit -m "feat(search): union independent index results"
```

### Task 2: Verify and open only the selected source

**Files:**
- Create: `packages/backend/src/search/source-verifier.js`
- Modify: `packages/backend/src/search/index-federation.js`
- Modify: `packages/backend/src/api/search.js`
- Modify: `packages/backend/src/runtime.js`
- Test: `packages/backend/test/index-source-verification.test.mjs`
- Test: `packages/backend/test/hostile-media-validation.test.mjs`

**Interfaces:**
- Produces `verifySelectedCandidate({ candidateRef, signal }) -> VerifiedCandidate`.
- `VerifiedCandidate` includes current publisher descriptor/head, exact publication/rendition/asset descriptors, and fresh bounded availability evidence; it still contains no HTTP URL.

- [ ] **Step 1: Write failing forged/stale candidate tests**

```js
const candidate = await cacheCandidate(indexResult)
await publisher.retract(indexResult.sourceRecordRef)
await t.exception(
  verifier.verifySelectedCandidate({ candidateRef: candidate.candidateRef }),
  /source-not-current/
)
```

Also reject forged publisher roots, mismatched manifestation keys, changed asset IDs, and expired candidate refs.

- [ ] **Step 2: Implement current-source verification**

Resolve and verify the publisher namespace/root chain, open the catalog at its current accepted head, fetch the exact projection by source reference, compare canonical publication/rendition/asset identifiers, reconstruct and verify the static manifest, then run bounded live range probes.

- [ ] **Step 3: Expose deferred verification through the backend API**

Add API methods `searchIndexCandidates(selector)` and `verifyIndexCandidate(candidateRef)`. Keep URL minting for Plan 08/10 after verification.

- [ ] **Step 4: Run focused adversarial checks**

Run: `cd packages/backend && npx brittle test/index-source-verification.test.mjs test/hostile-media-validation.test.mjs test/index-federated-search.test.mjs`

Expected: valid current candidates verify; forged, stale, retracted, mismatched, and expired candidates fail closed.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/search packages/backend/src/api/search.js packages/backend/src/runtime.js packages/backend/test/index-federated-search.test.mjs packages/backend/test/index-source-verification.test.mjs
git commit -m "feat(search): federate indexes with source verification"
```