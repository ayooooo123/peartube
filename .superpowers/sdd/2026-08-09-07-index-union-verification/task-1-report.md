# Task 1 report — bounded multi-index union

## Status

Implementation and focused contract tests are authored. The obsolete peer-broadcast search protocol is removed, local semantic search remains local, and independent Plan 06 index-service pages are unioned behind bounded expiring local candidate references. Parent current focused validation passes: 18/18 Brittle tests with 95 assertions and 4/4 Node subtests. Spec and quality review are pending.

## Changed files and symbols

- Created `packages/backend/src/search/index-federation.js`.
  - Added `createIndexFederation({ services, cache, limits, now })`.
  - The returned facade exposes `search({ selector, limit, signal })` and `resolveCandidate(candidateRef)`.
  - `search` calls each configured service's existing `queryIndexService({ indexerId, query, signal })`, validates every returned page through the Plan 06 page codec, follows bounded opaque cursors, isolates service failures, unions exact cached locator identities, and returns immutable URL-less nested `CompanionCandidateV2` facts.
- Removed `packages/backend/src/search/federated-search.js`.
  - Removed `FederatedSearch`, `peartube-search-v1`, topic joins, JSON peer messages, broadcast aggregation, score averaging, peer-result ranking, timers, channels, and discovery ownership. No compatibility alias or second search protocol remains.
- Modified `packages/backend/src/api/search.js`.
  - Removed the `FederatedSearch` import and lazy swarm coordinator.
  - `createSearchApi().searchVideos` continues to call the existing semantic finder with the same query/top-K behavior; the tolerated legacy `federated` option no longer causes peer broadcast.
- Modified `packages/backend/src/media-graph/selection-diagnostics.js`.
  - `projectSourceSelectionDiagnostics` now reads nested `publication` facts and includes bounded `sourceIndexers[].indexerId` provenance in `introductionIndexIds` without treating index evidence as ranking authority.
- Modified `packages/backend/src/api.js`.
  - Reintroduced the `createSearchApi` import and spreads its methods into the root API exactly once with the existing semantic/search-envelope helpers, preview lookup, multi-writer check, and a context-compatible bound channel loader.
  - Added optional `getPreviewVideoFromFeed` dependency injection (defaulting to no preview) so both root `getVideoData` and extracted global search share the same callable preview path while preserving `this.getVideoData` dispatch.
- Created `packages/backend/test/index-federated-search.test.mjs`.
- Modified `packages/backend/test/search-direct-ref-regression.test.mjs`.
- Modified `packages/backend/test/search-creator-name.test.mjs`.
  - Removed obsolete `FederatedSearch` lifecycle/broadcast tests and their no-longer-valid imports.
- Created this report.

## Exported-symbol caller scan and cutover

LSP was unavailable; the supplied reference scan was confirmed with repository regex search.

### `FederatedSearch`

- `packages/backend/src/api/search.js`: import/construction/topic setup/search call removed; local semantic search now calls the semantic finder directly.
- `packages/backend/test/search-creator-name.test.mjs`: import and the two broadcast-coordinator lifecycle tests removed.
- No remaining code/test references exist.

### `createSearchApi`

- `packages/backend/src/api.js`: now imports and invokes `createSearchApi` once in the root API object; its `loadChannel` adapter accepts `(ctx, channelKey)` and delegates to `loadChannelBounded(channelKey)`.
- `packages/backend/test/search-creator-name.test.mjs`: obsolete coordinator-oriented caller removed.
- `packages/backend/test/search-direct-ref-regression.test.mjs`: direct `createSearchApi` coverage remains, and root `createApi` coverage proves the extracted methods are exposed.
- No other scanned callers exist.

## Tests authored; parent validated

`packages/backend/test/index-federated-search.test.mjs` contains these focused contracts:

1. `federation returns exact URL-less CompanionCandidateV2 facts`
   - proves configured services start concurrently and identical source facts merge;
   - asserts the complete §10.2 nested schema with `schemaVersion: 2`, opaque `candidateRef`, and exact `work`, `edition`, `publication`, `rendition`, `asset`, `provenance`, `availability`, `verification`, and `sourceIndexers` shapes;
   - proves known external-reference facts populate `work.entityId`/`work.externalRefs`, unavailable facts are explicit `null`/empty arrays, and `verification.state` is `unverified`;
   - proves the private cache retains the exact locator tuple while `sourceRecordRef`, `evidenceWeight`, URLs, credentials, controls, scores, and ranking never enter the public candidate.
2. `federation merges only identical cached locator tuples and preserves conflicts`
   - asserts the private tuple `{publisherId, sourceRecordRef, publicationId, renditionId, assetId}`;
   - proves distinct source records remain distinct;
   - proves public `sourceIndexers` rows contain exactly `{indexerId, observedAtMs}` and no index annotations.
3. `federation validates every page and isolates malformed pagination to its service`
   - covers multi-page cursor forwarding, fresh query IDs, per-page codec validation, and discard/isolation of a service whose continuation page does not correlate to its request.
4. `one service error or shared-deadline timeout cannot erase successful results`
   - covers a successful service, a rejecting service, strict rejection of a page carrying URL/credential/control/score fields, an abort-aware stalled service, one shared deadline timer, and timer cleanup.
5. `caller abort rejects search and removes the shared deadline`
   - covers caller-signal propagation, service cancellation, abort rejection, and deadline cleanup.
6. `candidate refs are opaque, expiring, and evicted within the cache bound`
   - covers 32-byte base64url local refs, oldest-entry eviction, lazy expiry, public-candidate resolution without locator leakage, and bounded cache size.
7. `diagnostics retain bounded provenance from nested candidates`
   - covers nested `publication.publisherId` plus deduplicated bounded `sourceIndexers` projection.
8. `configuration, requested counts, and page counts remain bounded`
   - covers service-count rejection, page-cap truncation, result cap, and over-limit search rejection.

`packages/backend/test/search-direct-ref-regression.test.mjs` adds:

9. `semantic search remains local and does not create a broadcast coordinator`
   - proves current semantic `searchVideos` results/top-K behavior is preserved even when a legacy caller passes `federated: true`;
   - proves no swarm topic is joined and no coordinator is retained.
10. `root API exposes search methods and keeps global direct refs callable`
   - behaviorally creates root `createApi`, proves `searchVideos`, `globalSearchVideos`, and `indexVideoVectors` are exposed, calls local/global search, preserves direct blob/core refs without hydration, exercises preview injection, and preserves method `this` binding.

The two existing direct-reference regressions remain unchanged.

## Invariants implemented

- Every configured service is independent and addressed only through Plan 06 `queryIndexService({ indexerId, query, signal })`; the legacy global feed/broadcast protocol is not restored.
- Services, pages per service, page rows, requested results, cache entries, random-allocation retries, cursors, timers, and in-memory union allocations all have explicit hard bounds.
- All services run concurrently under one shared deadline and shared abort signal. A service error, invalid page, or timeout removes only that service's observations.
- Every page is canonicalized and validated by `encodeIndexQueryPage` plus `decodeIndexQueryPage`; query ID, requested row count, stable source revision, and cursor non-repetition are checked locally.
- Deduplication uses exactly the private cached locator `[publisherId, sourceRecordRef, publicationId, renditionId, assetId]`. No title, work ID, indexer omission, evidence annotation, policy decision, or score participates.
- Plan 06 discovery results do not contain publication/rendition/asset projection IDs. The private locator therefore stores explicit `null` for those three tuple positions and never guesses them. Task 2 must fetch the exact current accepted publisher projection by `{publisherId, sourceRecordRef}` before deriving or trusting those IDs.
- Public search results match §10.2 `CompanionCandidateV2`: known external-reference facts populate `work.entityId`/`externalRefs`; all other unavailable nested facts are explicit `null`/empty arrays; verification is `unverified`; and each public source row contains only `{indexerId, observedAtMs}`.
- Public candidates contain no `sourceRecordRef`, flat locator IDs, `evidenceWeight`, query cursor/revision, index annotation, playback URL, credential, cookie, request header, control capability, universal score, or ranking field.
- `candidateRef` is a fresh random 32-byte base64url token, local to one federation instance, bounded to 43 characters, stored only in the caller-supplied cache, lazily expired, and unrelated to a peer/service/query/network identity.
- Candidate cache values and locators are immutable. The federation prunes or evicts only entries it owns and never closes or clears caller-owned caches, services, transports, swarms, or connections.
- Result order is encounter order only. There is no sorting, universal ordering contract, compatibility computation, or final selection. MediaStorm remains responsible for compatibility ranking and selection.
- Diagnostics surface independent introduction IDs only; they do not make indexer evidence authoritative.
- No payload telemetry was added.

## Self-review

- Re-scanned all `FederatedSearch` and `createSearchApi` references after the cutover; all supplied callers are updated and no broadcast symbol remains.
- Re-scanned the repository for `peartube-search-v1`, `SEARCH_QUERY`, `SEARCH_RESPONSE`, and `_broadcastSearch`; no code/test references remain.
- Re-read the Plan 06 request/page codec and dispatcher result mapping. The implementation constructs only canonical exact-external-ref requests and accepts only canonical Plan 06 pages.
- Checked the timeout path for services that ignore abort: the local abort race settles without waiting for the underlying caller-owned promise, while the passed signal still requests cancellation and late completion cannot mutate a returned union.
- Checked cache ownership and eviction: only records carrying the instance-private owner marker are deleted; external cache entries and resources remain untouched.
- Checked disagreement behavior: only the exact private locator participates in dedup; conflicting work entity IDs collapse to public `null` rather than letting one indexer overwrite another, and public source rows retain only independent indexer identity/time.
- Checked the local semantic path: it preserves the existing finder call/result shape and post-await lifecycle guard while removing all peer setup.
- Checked root API composition: search methods are spread once, the channel adapter preserves `api/search.js`'s `(ctx, channelKey)` contract, and global search remains a method on the returned root object so `this.getVideoData` semantics are unchanged.

## Parent validation

- Command: `cd packages/backend && npx brittle test/index-federated-search.test.mjs test/search-direct-ref-regression.test.mjs test/media-selection-diagnostics.test.mjs`
- Current post-wiring result: PASS — 18/18 Brittle tests with 95 assertions, plus 4/4 Node subtests.
- Spec review: pending.
- Quality review: pending.

## Concerns and intentional boundaries

- No implementation concern is known after current focused validation; spec and quality review remain pending.
- Intentional Task 1 boundary: publication/rendition/asset IDs remain `null` discovery hints until Task 2 verifies the current accepted publisher projection. This is required by the Plan 06 wire shape and prevents guessed or stale identifiers.
- Intentional Task 1 boundary: backend API methods for searching candidates and verifying a selected candidate are scheduled for Task 2; this task supplies the federation facade without prematurely minting verification or playback surfaces.
- Parent current focused validation passed as recorded above. No command, test, build, schema generation, lint, formatter, typecheck, git command, or commit was run in this worker session.
