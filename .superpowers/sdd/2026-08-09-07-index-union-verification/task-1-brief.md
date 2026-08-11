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

