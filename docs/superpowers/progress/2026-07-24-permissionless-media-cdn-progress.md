# Permissionless Media CDN Progress — 2026-07-24

Branch: `feat/permissionless-media-cdn`

Plan: `docs/superpowers/plans/2026-07-23-permissionless-media-cdn.md`

Latest pushed implementation commit at the time of this note:

- `644394ef feat(protocol): remove legacy global feed data plane`

## Task 2 resumed implementation (uncommitted)

Task 2 now has an end-to-end shell-custodied publisher authorization path:

- Compact bounded `SignedEnvelope` and `MultiSignedEnvelope` codecs use explicit authorization, replay, sequence, time, signer-role, and exact-quorum contexts with Node/Bare vectors.
- Publisher roots remain in authenticated Expo SecureStore or the privileged Bun keyring. The normal backend, desktop renderer, web bridge, and HRPC expose no root secret or migration method.
- Single-use prepare/sign/submit intents bind the record type, canonical bytes, recomputed ID/transition ID, public summary, signer, and expiry. Every terminal failure consumes the intent.
- Per-publisher Autobase catalogs use independent device writers and a deterministic Hyperbee view. Genesis pinning, writer admission/revocation cutoffs, capability checks, root rotation/recovery, source sequence high-water, deterministic conflict receipts, bounded journal lanes, restart, replay, and compaction edge cases are covered.
- Legacy `identities[].secretKey` roots migrate in an offline preflight before normal Corestore boot. Shell vault import, exact public-key continuity, and a durable signed challenge acknowledgement must complete before one atomic metadata write removes the source; every failure path preserves it.
- Mobile migration uses a short-lived bounded BareKit IPC worklet before `mainBridge.init`; desktop gates all `PearRuntime` worker creation on the privileged Bun preflight. Physical mobile execution was not performed; the transport is source/test verified only.

Fresh verification after schema regeneration:

```text
backend full suite: PASS
Task 2 backend focus: 94/94 tests, 561/561 assertions
Task 2 portable Bare signed-record vectors: 12/12 tests, 58/58 assertions
publisher catalog focused Node: 38/38 tests, 188/188 assertions
publisher catalog focused Bare: 17/17 tests, 92/92 assertions
spec: 13/13 tests, 112/112 assertions
host: 26/26 tests, 80/80 assertions
platform: 32/32 tests; TypeScript clean
app shell/vault/migration focus: 44/44 tests
mobile backend bundle: regenerated; manifest/script checks 6/6
```

The broad app TypeScript check still reports the existing 70 diagnostics across 42 unrelated UI/dependency/desktop files. Filtering the output to this slice found only the pre-existing `pear-runtime` declaration and Electrobun frame-shape errors in `src/bun/index.ts`; `_layout.tsx`, both vaults, signer/shell services, and platform files add no diagnostics.

## Completed since `11d6ed7e`

- `9cba6316 feat(app): expose local network and moderation policy`
  - Added local app controls for network policy, retention policy, followed publisher/index feeds, moderation feeds, and AI analysis mode.
  - Kept retention/moderation copy local-only: archive pledges are evidence only, and moderation controls do not affect other libraries.

- `d89639f0 feat(live): scope events by epoch and seal recordings`
  - Added signed live event descriptors, epoch descriptors, epoch chain verification, and live network session metadata.
  - Bound live topics to scoped `live` topics with event/epoch/protocol-major inputs.

- `f38c6ad2 test(p2p): add adversarial multi-peer network coverage`
  - Added deterministic adversarial P2P harness and tests for protocol skew, moderation-before-work, archive/offload integration, and entity graph/index/moderation integration.
  - Added backend script `test:adversarial`.

- `644394ef feat(protocol): remove legacy global feed data plane`
  - Added `packages/backend/src/migrations/publication-v1.js` and migration coverage.
  - Added `packages/backend/test/legacy-global-feed-absence.test.mjs` to keep production source clear of legacy global-feed identifiers and unrestricted data-plane callsites.
  - Removed legacy `public-feed`, `canonical-feed`, blind relay, relay-links, and app/backend compatibility surfaces.
  - Removed app discovery/profile callsites for deleted `getPublicFeed`, `getCanonicalFeed`, and relay-link RPCs.
  - Regenerated schema and mobile backend bundle.

## Verification already run for the latest pushed state

These passed before `644394ef` was pushed:

```bash
npm exec --prefix packages/backend -- brittle test/publication-v1-migration.test.mjs test/legacy-global-feed-absence.test.mjs test/holepunch-major-migration.test.mjs
npm test --prefix packages/spec
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs packages/app/tests/desktop-preview-regression.test.mjs
npm test --prefix packages/backend
npm run typecheck
npm run bundle:backend --prefix packages/app
git diff --check
```

Earlier slices in the same branch also passed their focused suites, including:

```bash
node --test packages/app/tests/network-policy-controls-regression.test.mjs
npm exec --prefix packages/backend -- brittle test/live-descriptor.test.mjs test/live-network-session.test.mjs test/live-stream.test.mjs
npm exec --prefix packages/backend -- brittle test/adversarial-network.test.mjs test/entity-graph-integration.test.mjs test/archive-integration.test.mjs test/protocol-version-skew.test.mjs
npm run test:adversarial --prefix packages/backend
```

## Final completion update

- The authored implementation plan is reconciled through Tasks 1–22, including the post-plan operability requirements.
- Legacy global-feed, unrestricted replication, no-op compatibility, and stale watch-page test surfaces were removed rather than retained as aliases.
- Final app cleanup repaired native startup/seek playback races, removed obsolete desktop-watch MSE assertions and their dead helper, corrected P2P status copy so aggregate cache progress is not presented as live transfer, and rebased direct-blob delegation tests on the current normalized service boundary.
- The physical Android debug build requires JDK 17 on this workstation; JDK 25 fails native CMake configuration. With JDK 17, the arm64 build completed, installed on the attached device, and `com.peartube.app/.MainActivity` launched with Android reporting `Status: ok`.

Post-plan archive/offload hardening is also complete:

- Archive network traffic now carries signed requests, pledges, and possession challenges over bounded chunked transfers, with purpose/topic binding, unpredictable auditor nonces, exact one-block Hypercore proofs, replay caches, deadlines, and admission budgets.
- Retention capacity is reserved before acceptance, persisted, restored before archive discovery resumes, released on expiry/close, and protected from cache eviction and storage-limit reductions.
- Source offload now resolves the immutable publication manifest, requires full coverage of every original rendition range, rejects ambiguous or active sources, recollects fresh evidence at confirmation, and serializes deletion against playback/prefetch startup on the same blobs core.
- Studio and every generated JS/Swift/mobile/desktop transport carry immutable publication identifiers and expose only `assessSourceOffload` plus `confirmSourceOffload`; legacy direct destructive RPCs are absent.
- The adversarial archive integration fixture was migrated to the exact one-block possession-proof contract, and the app scoped-session regression now asserts the bounded per-scope session map rather than the retired array shape.

The post-hardening physical Android rerun is complete on the attached arm64 device. A clean JDK 17 build installed and launched the refreshed app; the first live pass exposed Bare's missing `AbortController` global during backend startup and an omitted pairing API spread that made profile `listDevices` fail through HRPC. Both blockers now have focused regressions, regenerated backend bundles, and physical-device confirmation: the backend reaches `BACKEND READY`, `SmokeChannel` survives restart, and the profile resolves its local device without an error banner.

Final release verification also caught and fixed a fail-open source-offload clock path: confirmations now reject clocks earlier than the persisted assessment issue time with a structured diagnostic code. The stale async archive diagnostics and crash fixtures now await durable operations, validate exact one-block possession proofs, and exercise both Node and Bare process recovery.

The final combative release review found six real production-wiring defects despite the green component suites. All are closed: publication-v1 migration is now a durable startup gate; the privileged publisher shell owns fresh/upgrade catalog provisioning, writer admission, canonical confirmation, and root signing; renderer-selected signing semantics are absent; failed immutable upload commits clear newly written blobs without deleting uncertain accepted records; persisted network policy is loaded before manager startup and reconfigures the scoped network, seeding quota, and archive participation paths; omitted HRPC ceilings no longer decode as explicit zero; and source-offload evidence/eligibility/playback state is recollected inside the source-core mutation lock immediately before clear.

Fresh final verification after the release-blocker repairs:

```text
integrated migration/publisher/policy/offload focus: 124/124 tests, 710/710 assertions
app regression suite: 445/445 tests passed
root npm test: spec 23/23 (313 assertions), backend full suite passed, host 30/30 (91 assertions)
platform: 37/37 tests passed; supported root TypeScript check passed
archive/adversarial suite: 11/11 tests (38 assertions) passed
process crash-recovery matrix: 15/15 passed, including Node and Bare mobile backend restart
desktop native-addon smoke: passed
schema, HRPC, mobile backend bundles, and quarantined Swift contract artifacts: regenerated; native generated contract test 1/1 (9 assertions) passed
```

The broad, non-project app `npx tsc --noEmit` command still reports 68 standing diagnostics across 41 legacy UI/dependency/desktop files. The supported root typecheck remains clean.

The automated implementation and regression plan is complete. The full manual multi-device product scenario matrix below remains release acceptance work, not an unimplemented code slice: publish standalone/partial collections, discover through explicit feeds, resolve cross-publisher claims, stream with two peers and offline cache, exercise missing-range diagnostics, answer archive challenges, confirm source offload, apply local moderation, and restart against the same storage.

## Final validation commands

```bash
npm run schema:full
npm test
npm test --prefix packages/platform
npm run typecheck
npm run test:adversarial --prefix packages/backend
node --test packages/app/tests/*.test.mjs
npm run desktop:smoke --prefix packages/app
JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home npm run android --prefix packages/app
```
