# Codebase Simplification Review

> Lens: the @mafintosh / Holepunch code philosophy this stack is built on —
> small composable modules, minimal abstraction, no speculative layers,
> delete dead code on sight. Every finding below is grounded in greps over the
> current tree (no `node_modules`), not intuition.

This review separates **executed** changes (verified zero-risk, already applied on
this branch) from **proposals** (real wins, but entangled with tests or behavior,
so they need a human go-ahead). Findings are ordered by value-to-risk.

---

## Tier 1 — Executed on this branch (verified zero-risk)

### A. Deleted 9 dead `video-player` components
`packages/app/components/video-player/{ActionButtons,ControlsOverlay,LoadingOverlay,MiniPlayerControls,MiniPlayerProgressBar,SeekBar,SeekFeedback,TimeDisplay,VideoInfo}.tsx`

These were extracted in a modularization pass that was never wired up — the
3,224-line `VideoPlayerOverlayImpl.tsx` kept its own inlined versions. Each had
**0 external references** and **0 test references**; they were reachable only
through the barrel (`video-player/index.ts`), which made them *look* load-bearing.
Removed the files and their `export` lines from the barrel. (`P2PStatsBar`,
`ChannelInfo`, `ActionButton`, `ReactionButton`, `Scrubber`, the `Comment*`
components, `PearInlineVideoView`, and the hooks are all live — kept.)

### B. Archived stale root-level docs + one orphan spec file
Moved to `docs/archive/`:
- `DISCUSSION.md` — a one-shot agent task transcript ("# Task: Group current
  working tree into strategic local commits"), not a doc.
- `ARCHITECTURE_NEXT.md` — its own header says "this roadmap is historical …
  uses `apps/desktop`/`apps/mobile`" (paths that no longer exist).
- `RESEARCH-P2P-VIDEO-STARTUP.md` — a research *prompt*, not living docs.
- `peartube-relay-core-spec.ts` — root-level design spec with **zero importers**
  anywhere in the tree and not covered by `tsconfig` (`include: ["src/**/*"]`).
  The live relay-core wire format is exercised by
  `packages/backend/test/{gossip,mirror}-relay-core.test.mjs`.

All four had **zero references** from README/CLAUDE/DEVELOPMENT/code. Archiving
(not deleting) preserves the content while clearing root clutter.

---

## Tier 2 — Proposed: dead-code removal (entangled with tests)

Each of these is dead in production but has tests or regression assertions built
around it, so deleting it means deleting/adjusting those too — a deliberate call,
not a mechanical cleanup.

> **Status: #1, #2, #3 DONE** — executed in the Tier-2 commit (dead `mirror/`
> subsystem, Autobase op trio, and `createUniversalHrpcSurface` removed with
> their tests; `blob-utils.js` hoisted to `src/`). #4–#6 remain proposals.

### 1. `mirror/` subsystem — ~2,150 LOC, no production consumer ✅ DONE
`packages/backend/src/mirror/{autobase,seeder,fetcher,refresh,proof,schemas}.js`.
A self-contained Autobase descriptor/proof "relay" engine. Greps for
`MirrorSeeder`/`MirrorFetcher`/`seedMirroredVideo`/`fetchMirroredVideo`/etc.
outside `mirror/` hit **only `test/mirror-*.test.mjs`**. The single live import is
`mirror/blob-utils.js` (used by `blob-ref.js`).
**Proposal:** hoist `blob-utils.js` to `src/`, delete the rest of `mirror/` and its
tests. If it's intended future work, move it to a clearly non-exported
`experimental/` dir so it stops reading as live infrastructure.

### 2. Autobase op trio — ~700 LOC, contradicts the real storage model ✅ DONE
`channel/op-schemas.js`, `channel/op-signing.js`, `channel/migrations.js`.
`validateOp`/`verifyOp`/`signOp`/`migrateOp` are referenced only by
`op-signing.test.mjs` and each other. The live channel
(`multi-writer-channel.js`) writes directly to HyperDB collections and never
builds/validates/signs an "op". Worse, `op-signing.js` reimplements signing with
raw `JSON.stringify` + `crypto.sign` (order-dependent, no canonicalization) — an
inferior duplicate of the **live** canonical-JSON attestation in
`channel-descriptor.js`.
**Proposal:** delete all three + their test; `channel-descriptor.js` is the keeper.

### 3. `createUniversalHrpcSurface` — dead RPC surface on the hot startup path ✅ DONE
`universal-core.js:1062` defines `GetUniversalCoreStatus` +
`UniversalCoreInit/Start/Suspend/Resume/Shutdown`, registered by
`backend-entry.js:27-33` and `runtime.js:313`. **None of these method names exist
in the HRPC schema** (`grep UniversalCore packages/spec` → nothing), so no
generated client can ever call them; `rpc.respond` falls through to a no-op.
**Proposal:** delete `createUniversalHrpcSurface` + `registerUniversalHandlers`.
Note: `desktop-bundle-script-regression.test.mjs` uses this symbol name as a
*fixture example* — swap the fixture to a neutral name.

### 4. Speculative peer-economy inside `universal-core.js` (1,110 LOC)
The lifecycle wrapper (`init/start/suspend/resume/shutdown`) is load-bearing, but
the bulk of the file is a peer-scoring / useful-work-ledger / sybil-policy /
descriptor-&-proof-ingestion economy (`scorePeer`, `recordUsefulWork`,
`ingestDescriptor`, `ingestProof`, plus a `loadNativeModules`/`libhc`/`libkv`/
`libudx` machinery for native modules that don't exist in the tree). No caller in
`app/`, `host/`, or `platform/` feeds this economy.
**Proposal:** keep the thin lifecycle wrapper; extract `peer-scorer.js`,
`budget-manager.js`, and the `ingest*`/`score*`/native-transition code to an
unmerged branch until a real call site exists. Reclaims most of the file + 2 helpers.

### 5. Dead `createBackendRuntime` (~180 LOC near-duplicate of `createBackend`)
`runtime.js` `createBackendRuntime` duplicates `backend-entry.js` `createBackend`
almost line-for-line and has **no runtime callers** (only an `index.js`
re-export). The real entrypoint everywhere is `createBackend`.
**Proposal:** delete `createBackendRuntime` + its `index.js` export. Keep
`buildSharedSystemHandlers`/`attachSharedAppHandlers`/`requireHostProtocolVersion`
(used by tests + `backend-entry.js`) — move them into `backend-entry.js` or a small
`shared-handlers-setup.js`, then drop `runtime.js`. (Adjust the source-text
regression tests that read `runtime.js`.)

### 6. Dead Hyperbee fallback paths in `public-channel-bee.js` ✅ DONE (partial)
`this.bee` is initialized to `null` and **never assigned** (only `this.db` is, in
`_open`), so every `this.bee?.…` call in `getMetadata`/`setMetadata`/`listVideos`
was a permanent no-op. Replaced those dead branches with the equivalent empty
result, keeping the `if (!this.db)` not-ready guard (`waitForSync` does not
guarantee `db`, so the guard is real) and the `this.bee = null` line (a test
asserts the raw-bee path is gone).
**Correction:** `applyVideoChanges` is **not** dead — `public-channel-hyperdb.test.mjs`
uses it. Kept.

---

## Tier 3 — Proposed: de-duplication & decomposition

### 7. `api.js` is a 4,888-line god-file ✅ DONE (safe slices)
A single `createApi` returning a ~3,700-line object literal with ~110 methods
spanning channels, playback, livestream, personal store, feed, seeding, pairing,
search, comments, recommendations. `prefetchVideo` alone is **~780 lines**
(2842-3623, ~16% of the file).

> **Slice 1 done:** the 7 comments/reactions methods extracted to
> `api/comments.js` as `createCommentsApi({ refreshSearchIndex })`, spread into
> the api object (so `this._getCommentsAutobase`, which stays in api.js, still
> resolves). Chosen first because it's the cleanest group (single injected dep)
> **and** CI's `api-comments-hyperdb.test.mjs` exercises it. Each further slice
> lands as its own CI-gated commit. The pattern: methods that touch only `this.*`
> + a small dep set extract cleanly; heavily closure-coupled methods (e.g.
> `prefetchVideo`, `getCommentsDebugInfo`) stay until they're decomposed in place.
> **Slice 4 done:** Search operations (`searchVideos`, `globalSearchVideos`,
> `indexVideoVectors`) moved to `api/search.js` with explicit helper injection;
> the shared search-envelope/indexing helpers remain in `api.js` because comments
> and background indexing still use them.
> **Slice 5 done:** Public feed, seeding, and multi-device pairing operations
> moved to `api/feed.js`, `api/seeding.js`, and `api/pairing.js`. Storage/offload
> remains in `api.js` because it shares active playback range state and upload
> offload helpers.
> **Slice 6 done:** Recommendations/watch-event operations moved to
> `api/recommendations.js`; the module injects the multi-writer guard, channel
> loader, and semantic-finder initializer explicitly.
> **Slice 7 done:** Live, subscriptions, status diagnostics, and network lifecycle
> operations moved to `api/live.js`, `api/subscriptions.js`, `api/status.js`, and
> `api/network-lifecycle.js`. Shared playback/cache state stays in `api.js` and is
> passed as callbacks where needed.
**Proposal:** split along the comment-banner sections that already exist into
`api/{personal,comments,feed,seeding,pairing,search}.js`, each taking the shared
closure deps and returning its method group; `createApi` becomes
`return { ...createPersonalApi(deps), ... }`. Decompose `prefetchVideo` into named
phase helpers. Start with the self-contained personal (2423-2515) and
comments/reactions (4512-4658) groups.

### 8. Triplicated `getSwarmStatus` / `safeJson` / `getBlobServerStatus` / debug-log helpers ✅ DONE (partial)
- **debug-log (3 copies → 1): done.** `resolveDebugLogPath` + `appendDebugLine`
  were byte-duplicated in `orchestrator.js`, `runtime.js`, *and* `storage.js`
  (storage's are used at 71 call sites). Extracted to `src/debug-log.js`; all
  three now import it.
- **`getSwarmStatus` shaping: NOT merged — correction.** The agent claimed
  `mobile-handlers.js` and `runtime.js` (`buildSharedSystemHandlers`) are
  byte-equivalent, but they derive `connected`/`peerCount` differently
  (`swarmConnections > 0` vs `(swarmConnections || peerCount) > 0`). Merging
  would silently change behavior, so this needs a deliberate "which shape is
  canonical" decision first — left as a proposal.
- **`safeJson` / `getBlobServerStatus` (2 copies each): left.** Genuinely
  identical but only duplicated once each (~7 and ~10 lines); a shared module +
  imports is barely cheaper than the duplication. Low priority.

### 9. Comments/reactions handlers wrapped twice ⚠️ DEFERRED
`api.js` (4512-4658) already returns the HRPC-ready `{success,error}` envelope;
`mobile-handlers.js` (334-353) wraps each one in a *second* try/catch that can't
throw, re-normalizing the same fields.
**Decision:** do not drop these wrappers on this branch. The current HRPC fallback
invokes handlers as request-object functions, while `api/comments.js` methods are
positional and rely on `this._getCommentsAutobase`; direct fallback would pass the
wrong args and lose binding. A later cleanup can replace the wrappers with explicit
request adapters or make the comments API request-shaped first.

### 10. Per-method `console.log('[API] …')` + try/catch boilerplate
172 `console.*` and 125 `try` blocks in `api.js`, including `'====== addComment
ENTERED ======'`-style banners and a repeated
`try {…} catch (err) { return { success:false, error: err.message } }` shape.
**Proposal:** one tiny `wrap(name, fn)` higher-order helper (not a logging
framework) removes ~100+ lines of copy-paste.

### 11. Three overlapping video-normalization layers
`canonical-feed.js` (`normalizeCanonicalFeedVideo*`),
`canonical-feed-contract.js` (`createCanonicalFeedVideo*`), and
`public-feed.js` (`_sanitizePreviewVideos`, which does **not** import the canonical
normalizer and reimplements field selection). Two functions per type ("create" vs
"normalize") differ only in how many input aliases they accept; callers must know
which to use.
**Proposal:** collapse to one normalizer per type; have `public-feed` delegate to
it so the wire shape can't diverge from the canonical contract.

---

## Tier 4 — Proposed: package-boundary & platform simplification

### 12. Merge `@peartube/protocol` into `@peartube/host`
`protocol/src/index.js` is 3 lines re-exporting `create-client.js` + `event-map.js`
and re-exporting `HOST_ERROR_CODES`/`PROTOCOL_VERSION` straight from `host`. The
23-line `host/src/contracts.js` exists *only* to be imported by both sides, and
`normalizeReadyPayload`/`normalizeHostError`/`appendDebugLine` are copy-pasted
verbatim across `start-host.js` and `create-client.js`.
**Proposal:** one `@peartube/host` exposing `startHost`, `createProtocolClient`,
and the error contract. Kills a package boundary, the re-export layer, and the
cross-package helper duplication in one move.

### 13. Shrink `@peartube/core` to types + tokens ✅ DONE (partial)
937 LOC, but every one of its 17 import sites uses either `import type {…}` or
`colors/theme`. The shipped `components/` (Button/Card/Input/Text), `stores/`, and
`hooks/useP2PVideo.ts` (243 LOC) have **no app importers** (the app uses RN
primitives).
**Done:** deleted the unused `components/` (Button/Card/Input/Text + styles) and
the placeholder `stores/`, dropped their `index.ts` re-export and the `./components`
/ `./stores` subpath exports from `package.json`. `@peartube/core` is now
hooks + types + utils (design tokens).
**Kept (correction):** `hooks/useP2PVideo.ts` — although no app screen imports it,
`mobile-video-stats-lifecycle-regression.test.mjs` reads its source and asserts on
its request-generation race guards. Like `createBackendRuntime` (#5), it's a
test-guarded "dead-looking" path; removing it means removing its guard test, which
needs an explicit intent decision, not a mechanical delete.

### 14. Collapse the third method-name registry (`core/utils` `CMD`/`RPC_METHODS`) ✅ DONE (the dead map)
Method names live in three places: the HRPC schema (`spec/`), the per-platform
clients (`rpc.native.ts` 1,431 LOC / `rpc.web.ts` 684 LOC), **and** a numeric
`CMD`/`RPC_METHODS` map in `core/src/utils` (a bare-rpc artifact superseded by HRPC).
**Done:** deleted the legacy `CMD`/`RPC`/`RPC_METHODS`/`NETWORK_DISCOVERY_TOPIC`/
`FEED_PROTOCOL_NAME` block from `core/src/utils/index.ts` (−123 lines). Verified
zero importers repo-wide (the live registry is `APP_RPC_METHODS` from
`@peartube/spec`); the file is now just design tokens, and the
`mobile-ui-redesign-regression.test.mjs` source check (which only asserts on the
color tokens) is unaffected.
**Still proposed:** pushing more per-method client construction into the shared
`rpc.shared.ts` so the two transport files shrink toward thin adapters.

### 15. Quarantine `desktop-native` + Swift codegen out of the main build
`desktop-native/` is ~13.4k LOC Swift + 24 `.mjs`; the Swift half of `spec/`
(`swift-schema` + `swift-hrpc` + the 658-LOC hand-rolled `lib/swift-codegen.cjs`)
is **18,365 generated LOC** — more than the entire generated JS surface. It's
documented as *experimental* (Electrobun is the shipping desktop app), yet every
`schema.cjs` change now forces regenerating + re-validating 18k lines of Swift that
must stay byte-compatible with JS `compact-encoding` (a documented recurring
`DecodingError` footgun).
**Proposal:** move the native-desktop path + its Swift codegen into a clearly
optional workspace that doesn't gate `npm run typecheck` / schema regen, until the
native shell is actually chosen as a target. It's the single largest
maintenance-multiplier in the repo.

---

## Tier 5 — Proposed: frontend decomposition (app)

### 16. `VideoPlayerOverlayImpl.tsx` — 3,224-line god-component (92 stateful hooks)
Owns mini-player drag physics, fullscreen/landscape, cast UI, comments, P2P stats,
channel-meta caching, reactions — and inlines control/gesture logic that already
exists as hooks in `components/video-player/hooks/`.
**Proposal:** delegate to the existing `useVideoGestures`/`useMiniPlayerPosition`/
`useLandscapeMode` hooks, deleting the inlined duplicates; target < ~800 lines.
(Tier-1 item A already removed the unused *extracted* components; this is the deeper
half of the same problem.)

### 17. Two sources of truth for player state
`lib/VideoPlayerContext.tsx` (1,446 lines, 107 hooks) already delegates mode
transitions to `lib/playerStateMachine.ts` (766-line reducer) yet still holds
~107 ad-hoc `useState`/`useRef` and exposes 4 consumer hooks as a perf workaround
for one over-broad context value.
**Proposal:** migrate the ad-hoc state (position/rate/stats/mode flags) into the
reducer so the context is a thin provider over `usePlayerStateMachine`.

### 18. Platform-split screens re-grown duplicate logic
- `(tabs)/index.tsx` (1,618) vs `(tabs)/index.web.tsx` (3,018): web reimplements
  its own `feedCache`, 12 inline SVG `*Icon` components, and snapshot logic that
  mobile gets from shared `lib/feed-snapshot*` + `home-feed-virtualization`.
- `channel/[key].tsx` (806) vs `.web.tsx` (678): ~51 combined hooks, **no shared
  `useChannel*` hook** — load/subscribe/follow logic copy-pasted per platform.
**Proposal:** route web feed caching through the same `lib/` helpers and the shared
icon set; extract a `useChannelPage(key)` hook so both screens keep only
platform-specific JSX. Realistic: ~800-1,000 lines out of `index.web.tsx`, several
hundred out of the channel screens.

### 19. `lib/cast/useCast.shared.ts` — 824-line monolith hook
Discovery + session lifecycle + media controls + remote-state polling in one hook
(the `.ts`/`.native.ts`/`.web.ts` files are 3-line shims forwarding to it).
**Proposal:** split into `useCastDevices` + `useCastSession`; the shims compose them.

---

## Suggested sequence

1. **Tier 1** (done) — dead components + doc hygiene.
2. **Tier 2 #1–#3** — delete `mirror/`, the op trio, and `createUniversalHrpcSurface`
   (largest dead-LOC removals; ~3,000 lines) with their tests, behind one review.
3. **Tier 3 #7–#10** — break up `api.js`, hoist the triplicated helpers.
4. **Tier 4 #12–#15** — package merges + quarantine native-desktop.
5. **Tier 5 #16–#19** — frontend decomposition.

Tiers 2–5 are independent; each can land as its own reviewed PR.
