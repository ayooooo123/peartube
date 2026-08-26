# Permissionless Media CDN and Archive Implementation Plan

> **For agentic workers:** REQUIRED: use `superpowers:subagent-driven-development` when subagents are available, otherwise use `superpowers:executing-plans`. Execute one task at a time. Each task uses tests first, focused verification, and an atomic commit.

**Goal:** Replace PearTube's global consumer feed and channel-sized media replication with publisher-signed namespaces, immutable rendition swarms, a cross-publisher media entity graph, bounded permissionless discovery, voluntary archival evidence, client-selected moderation, and a unified native media library.

**Architecture:** Publishers append signed publications and claims to publisher-scoped feeds. Immutable asset manifests reference original and playback-optimized rendition cores. Clients join publisher topics for catalog state and asset topics only for media they play, cache, audit, or archive. Local resolvers combine publisher, curator, index, moderation, and optional AI claims into a provenance-preserving media graph. Archivists publish voluntary pledges and answer possession challenges. No PearTube-operated control plane is introduced.

**Tech Stack:** Node/Bare JavaScript, Hypercore/Corestore/Hyperbee/Hyperblobs, Hyperswarm/Noise/Protomux, compact-encoding, sodium-universal/hypercore-crypto, HRPC/Hyperschema, Expo React Native, Electrobun, `brittle`, and `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-23-permissionless-media-cdn-design.md`

**Scope decisions:** Public media only — no protected/DRM, entitlement, or license concept; native mobile and Electrobun desktop first; no PearTube-operated central catalog, media origin, or analytics service; no browser transport; no payment system; optional local AI only.

## Product Direction Amendment — 2026-07-24

The protocol and storage program below is implemented. The next product phase is governed by `docs/superpowers/plans/2026-07-24-stremio-consumer-vertical-slice.md`, which supersedes the original upload-centric product projection without reopening the completed network cutover.

Locked product decisions:

- PearTube is primarily a consumer streaming application with one seamless global catalog. Publishing, archive operations, diagnostics, identity internals, moderation administration, and network policy live behind Developer Settings or in the CLI/relay.
- Mobile navigation is Home, Search/Discover, and Library. Desktop/TV uses the same destinations in a compact Stremio-style sidebar.
- Permissionless publication remains globally discoverable. Default community moderation filters normal views; advanced users may inspect and override local policy.
- The first catalog experience is movies and episodic series, while the media graph remains universal.
- Play selects the best currently playable source automatically and fails over among equivalent sources. An optional Other Sources view remains available.
- Default participation is balanced: seed during playback and briefly afterward, then perform bounded background seeding subject to explicit metered, battery, thermal, storage, and upload ceilings.
- No account is required. Watch progress, library, and recommendations are local by default; optional encrypted device pairing is user-initiated.
- All media is public. There is no protected rendition, entitlement, or license path anywhere in the product or protocol.
- PearTube collects no playback, engagement, recommendation, or CDN-savings analytics, and does not aggregate or forward viewer telemetry.
- Playback is strict P2P. There is no HTTP media-origin fallback and no required provider-operated seed. Catalog visibility and playback UI must therefore expose Awaiting replication, Limited availability, Healthy, and Unavailable honestly.
- Relay nodes are permissionless volunteer discovery/archive/mirror nodes. They may follow MediaStorm instances, gossip catalog records, cache media bytes, satisfy archive pledges, and seed retained ranges; they gain no publication, moderation, or catalog authority over anyone else.


---

## Execution Rules

- Execute chunks in order. Later chunks depend on stable contracts from earlier chunks.
- Do not expand `storage.js`, `api.js`, or `public-feed.js` with new subsystems. Add focused modules and keep orchestration thin.
- App-facing backend changes begin in `packages/spec/schema.cjs`, regenerate with `npm run schema:full`, then flow through host and platform.
- Peer wire protocols are not HRPC. They use explicit, versioned `compact-encoding` codecs with pre-decode frame limits.
- Every network handler reserves resources before accepting work and releases reservations on success, failure, timeout, disconnect, cancellation, and shutdown.
- Preserve the existing consumer experience until the replacement path passes end-to-end multi-peer verification. Temporary dual-read instrumentation is allowed inside a task, but the final cutover removes legacy paths rather than leaving compatibility aliases.
- Never delete the publisher/source copy because transient viewer peers have complete bitfields.
- Never log private keys, key material, capability secrets, raw secure-store payloads, or unredacted playback tokens.
- Each commit command below is path-specific. Do not stage unrelated worktree changes.

## Program Gates

The program stops before the next gate if the current gate fails.

1. **Runtime gate:** mobile policy propagation and deterministic shutdown pass on Node and Bare.
2. **Identity gate:** publisher root/device delegation and revocation are cryptographically enforced; production keys are not stored as plaintext files.
3. **Model gate:** IDs, claims, manifests, and resolver outputs are deterministic across Node and Bare.
4. **Network gate:** bootstrap, publisher, and asset protocols reject oversized or replayed input before expensive work.
5. **Playback gate:** locally complete/cached playback does not regress with no peer; P2P improves or preserves startup and seek behavior; missing verified ranges fail promptly with structured unavailability rather than an implicit origin.
6. **Durability gate:** source offload requires explicit policy plus persistent archival evidence.
7. **Product gate:** partial collections and duplicate publications render as one coherent media graph with provenance and conflicts.
8. **Cutover gate:** the global feed data plane and unsigned mirror steering are removed.

---

## Chunk 0: Runtime and Security Prerequisites

### Task 1: Propagate platform policy into storage and prove lifecycle cleanup

**Files:**

- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/storage.js`
- Modify: `packages/backend/src/universal-core.js`
- Modify: `packages/backend/src/backend-entry.js`
- Modify: `packages/app/backend/mobile-start.mjs`
- Modify: `packages/app/workers/desktop/index.ts`
- Modify: `packages/backend/test/mobile-backend-context-wiring.test.mjs`
- Modify: `packages/backend/test/storage-startup-regression.test.mjs`
- Modify: `packages/backend/test/backend-entry.test.mjs`
- Modify: `packages/app/tests/native-backend-startup-regression.test.mjs`
- Create: `packages/backend/test/backend-lifecycle-contract.test.mjs`

**Acceptance:** `platform: 'mobile' | 'desktop'` reaches `initializeStorage`; platform defaults select the expected swarm limits; `destroy()` closes seed-pin, feed discovery, playback workers, blob server, blind peering, swarm, metadata cores, and Corestore exactly once; deferred initialization cannot reopen resources after shutdown.

- [ ] **Step 1: Write failing propagation tests**

Assert `createBackendContext({ platform: 'mobile' })` forwards `platform` into `initializeStorage`, selects mobile peer/concurrency defaults, and does not inherit desktop's 96-peer ceiling. Assert explicit `network` and `swarmOptions` still override platform defaults.

- [ ] **Step 2: Write failing lifecycle tests**

Use fake resources with ordered close logs. Start deferred warm-up, call `destroy()` twice, and assert every owned resource closes once, deferred work observes shutdown, no timer remains, and the Corestore lock is released.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/mobile-backend-context-wiring.test.mjs test/backend-lifecycle-contract.test.mjs
node --test packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: FAIL on dropped platform data or incomplete ownership wiring.

- [ ] **Step 4: Implement one runtime ownership contract**

Add `platform` to the `createBackendContext` destructure and forward it to `initializeStorage`. Make the context own an idempotent ordered cleanup stack. Register each long-lived timer, discovery handle, server, worker, feed, database, swarm, and store immediately after creation. Make `shutdownBackend` consume the stack in reverse ownership order with bounded timeouts. Do not create a second desktop/mobile backend path.

- [ ] **Step 5: Run focused verification**

```bash
npm exec --prefix packages/backend -- brittle test/mobile-backend-context-wiring.test.mjs test/storage-startup-regression.test.mjs test/backend-entry.test.mjs test/backend-lifecycle-contract.test.mjs
node --test packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit runtime prerequisites**

```bash
git add packages/backend/src/orchestrator.js packages/backend/src/storage.js packages/backend/src/universal-core.js packages/backend/src/backend-entry.js packages/app/backend/mobile-start.mjs packages/app/workers/desktop/index.ts packages/backend/test/mobile-backend-context-wiring.test.mjs packages/backend/test/storage-startup-regression.test.mjs packages/backend/test/backend-entry.test.mjs packages/backend/test/backend-lifecycle-contract.test.mjs packages/app/tests/native-backend-startup-regression.test.mjs
git commit -m "fix(runtime): enforce platform policy and lifecycle ownership"
```

### Task 2: Establish shell-custodied publisher roots and an authorized Autobase catalog

**Files:**

- Create: `packages/backend/src/records/signed-envelope.js`
- Create: `packages/backend/src/records/multi-signed-envelope.js`
- Create: `packages/backend/src/records/index.js`
- Create: `packages/backend/src/publisher/canonical.js`
- Create: `packages/backend/src/publisher/namespace.js`
- Create: `packages/backend/src/publisher/authorization.js`
- Create: `packages/backend/src/publisher/catalog.js`
- Create: `packages/backend/src/publisher/catalog-view.js`
- Create: `packages/backend/src/publisher/key-provider.js`
- Create: `packages/backend/src/api/publisher.js`
- Create: `packages/backend/test/signed-envelope.test.mjs`
- Create: `packages/backend/test/publisher-namespace.test.mjs`
- Create: `packages/backend/test/publisher-authorization.test.mjs`
- Create: `packages/backend/test/publisher-catalog.test.mjs`
- Create: `packages/backend/test/publisher-key-provider.test.mjs`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/backend-entry.js`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Modify: `packages/backend/src/identity.js`
- Modify: `packages/backend/src/identity-key-file.js`
- Modify: `packages/backend/test/identity-key-file.test.mjs`
- Modify: `packages/backend/package.json`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs`
- Create: `packages/spec/test/publisher-root-operations.test.mjs`
- Regenerate: `packages/spec/spec/**`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/platform/src/runner.native.ts`
- Modify: `packages/platform/src/runner.web.ts`
- Modify: `packages/platform/test/rpc.shared.test.mjs`
- Create: `packages/app/lib/publisher-key-vault.ts`
- Create: `packages/app/lib/publisher-signer-bridge.ts`
- Create: `packages/app/src/bun/publisher-key-vault.ts`
- Modify: `packages/app/src/bun/index.ts`
- Modify: `packages/app/backend/mobile-start.mjs`
- Modify: `packages/app/workers/desktop/index.ts`
- Modify: `packages/app/app/_layout.tsx`
- Modify: `packages/app/package.json`
- Create: `packages/app/tests/publisher-key-vault-regression.test.mjs`
- Create: `packages/app/tests/publisher-signer-bridge-regression.test.mjs`
- Modify: `packages/app/tests/native-backend-startup-regression.test.mjs`

**Acceptance:** shared bounded `SignedEnvelope` and `MultiSignedEnvelope` contracts exist before publisher protocol code; the universal backend depends only on a narrow injected signer/request interface and never imports platform vault APIs or receives normal root-secret exports; the mobile React Native shell owns `expo-secure-store`, the privileged Bun main process owns the desktop OS vault, and the web renderer never holds root secrets; prepare/sign/submit operations bind one user intent to exact canonical bytes; one stable `publisherId` anchors independent device-writer Hypercores and a deterministic Autobase/Hyperbee view; delegation, revocation cutoffs, root rotation, and M-of-N recovery are enforced during apply; legacy plaintext keys are deleted only after an authenticated local migration import, public-key/sign challenge, and durable acknowledgement.

- [ ] **Step 1: Prove platform vault feasibility before protocol work**

Write adapter contract tests for create/import, public-key lookup, domain-separated signing, delete, device-locked/denied/missing behavior, and fully redacted errors. Exercise `expo-secure-store` on mobile. Verify the selected Electrobun/Bun OS credential API in the packaged desktop runtime; if absent, add one narrowly scoped maintained native dependency and record it in `packages/app/package.json`. Do not fall back to plaintext JSON or expose a `getSecret` operation.

- [ ] **Step 2: Write failing shared signed-record tests**

Test `bodyLength` before decode, record-type domain separation, single-signer canonical IDs, publisher authorization at catalog policy epoch/sequence, ephemeral nonce/expiry/replay rules, and peer records at policy epoch zero. For rotation/recovery, derive one signer-independent `transitionId`; require unique lexicographically ordered signatures capped at 16; enforce exact old/new root roles or new-root plus distinct configured recovery quorum.

- [ ] **Step 3: Run signed-record failures**

```bash
npm exec --prefix packages/backend -- brittle test/signed-envelope.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement shared signed-record codecs**

Use compact binary versioned codecs, check declared lengths before allocation, never include an ID or signatures in their own hash, and require an explicit authorization context for verification.

- [ ] **Step 5: Write failing cross-runtime signer and migration tests**

Define typed `prepare-publisher-root-operation` and `submit-publisher-root-operation` RPCs. The prepared response contains bounded canonical unsigned bytes, record type, candidate `recordId`/`transitionId`, public display summary, and expiry. The shell creates a single-use intent, independently bounds/decodes the exact bytes, compares public fields with the intent, recomputes the ID using the shared codec, constant-time compares it with the candidate, and signs only the protocol's domain-separated recomputed ID; the summary is never signature authority. Reject arbitrary-message signing, unknown/background intent, summary/body mismatch, candidate-ID mismatch, wrong record type, expiry, replay, locked vault, renderer invocation, and signature substitution. Drive mobile and desktop runner fixtures end to end. For legacy migration, allow one authenticated local app/worker import message toward the privileged vault, verify public-key and challenge continuity, persist acknowledgement, then delete; crash before acknowledgement preserves the source and restart after acknowledgement completes deletion idempotently.

- [ ] **Step 6: Write failing namespace and transition vectors**

Define the exact descriptor: `publisherId`, active root key, `catalogBootstrapKey`, `catalogEpoch`, profile reference, policy sequence, recovery keys/threshold, previous root, and transition proof. Assert genesis-derived identity, Node/Bare parity, `MultiSignedEnvelope` rotation/recovery, monotonic epoch, and failure without old-root authority or configured recovery quorum.

- [ ] **Step 7: Write failing Autobase catalog tests**

Create one writer Hypercore per device and one deterministic Hyperbee view. Test writer admission, concurrent publication operations, deterministic ordering/tie-break, idempotent replay, signed view-head digest, restart from `catalogBootstrapKey`, and byte-identical replica views.

- [ ] **Step 8: Write failing authorization reducer tests**

Every operation carries writer key, capability, operation type, policy epoch, and writer sequence. A root-authorized revocation advances policy epoch and fixes `acceptedThroughSequence`. Test removed-writer continuation, delayed delivery at/below cutoff, sequence reuse with different bytes, moderator owner action, stale epoch, unknown operation, forked transition, and announce-capability misuse.

- [ ] **Step 9: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/signed-envelope.test.mjs test/publisher-namespace.test.mjs test/publisher-authorization.test.mjs test/publisher-catalog.test.mjs test/publisher-key-provider.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
node --test packages/app/tests/publisher-key-vault-regression.test.mjs packages/app/tests/publisher-signer-bridge-regression.test.mjs packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: FAIL.

- [ ] **Step 10: Implement signer bridge and root/device/catalog separation**

Keep vault access in the platform/app runner. The backend prepares canonical operations and verifies returned signatures but never gains a normal root-secret API. Device cores sign ordinary catalog traffic; roots sign namespace/delegation/revocation/transition records only. Apply exact schemas and authorization inside the deterministic reducer. Retain rejected history for diagnostics without projection. Zero and redact sensitive bridge payloads on every terminal path.

- [ ] **Step 11: Migrate existing key files**

Use only the authenticated local migration channel. The privileged shell vault imports the legacy root without exposing it to the desktop renderer, verifies public-key and sign/challenge continuity, and returns a durable acknowledgement before backend source/temp deletion. Preserve mode `0600` until deletion. Never generate a replacement identity on vault failure. Permanently disable the migration message after committed success.

- [ ] **Step 12: Run focused verification**

```bash
npm run schema:full
npm exec --prefix packages/backend -- brittle test/signed-envelope.test.mjs test/publisher-namespace.test.mjs test/publisher-authorization.test.mjs test/publisher-catalog.test.mjs test/publisher-key-provider.test.mjs test/identity-key-file.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
node --test packages/app/tests/publisher-key-vault-regression.test.mjs packages/app/tests/publisher-signer-bridge-regression.test.mjs packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 13: Commit publisher identity foundation**

```bash
git add packages/backend/src/records packages/backend/src/publisher packages/backend/src/api/publisher.js packages/backend/src/index.js packages/backend/src/api.js packages/backend/src/backend-entry.js packages/backend/src/orchestrator.js packages/backend/src/mobile-handlers.js packages/backend/src/hrpc-handlers.js packages/backend/src/identity.js packages/backend/src/identity-key-file.js packages/backend/package.json packages/backend/test/signed-envelope.test.mjs packages/backend/test/publisher-namespace.test.mjs packages/backend/test/publisher-authorization.test.mjs packages/backend/test/publisher-catalog.test.mjs packages/backend/test/publisher-key-provider.test.mjs packages/backend/test/identity-key-file.test.mjs packages/spec packages/host packages/platform packages/app/lib/publisher-key-vault.ts packages/app/lib/publisher-signer-bridge.ts packages/app/src/bun/publisher-key-vault.ts packages/app/src/bun/index.ts packages/app/backend/mobile-start.mjs packages/app/workers/desktop/index.ts packages/app/app/_layout.tsx packages/app/package.json packages/app/tests/publisher-key-vault-regression.test.mjs packages/app/tests/publisher-signer-bridge-regression.test.mjs packages/app/tests/native-backend-startup-regression.test.mjs
git commit -m "feat(identity): add shell-custodied publisher roots"
```

---

## Chunk 1: Canonical Media Graph Contracts

### Task 3: Define deterministic entity references, IDs, and signed claims

**Files:**

- Create: `packages/backend/src/media-graph/constants.js`
- Create: `packages/backend/src/media-graph/canonical.js`
- Create: `packages/backend/src/media-graph/entity-reference.js`
- Create: `packages/backend/src/media-graph/claim.js`
- Create: `packages/backend/src/media-graph/index.js`
- Create: `packages/backend/test/media-entity-reference.test.mjs`
- Create: `packages/backend/test/media-claim.test.mjs`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/package.json`

**Acceptance:** Work, Recording/Edition, Publication, Asset Rendition, Collection, Agent, and Publisher IDs cannot be confused; external and issuer-native references normalize deterministically; typed claims specialize the shared `SignedEnvelope`, use its `recordId` as `claimId`, and remain canonical, signed, bounded, immutable, issuer-attributed, lifecycle-defined, and non-circular.

- [ ] **Step 1: Write failing ID domain-separation tests**

Cover Work, Recording, Edition, Publication, Rendition, Collection, Agent, and Publisher references across YouTube, MusicBrainz, TMDB/TVDB/IMDb, podcast GUID, canonical URL, exact hash, fingerprint, and issuer-native namespaces. The same payload under two entity kinds must produce different IDs. Version normalization explicitly. Invalid Unicode, empty namespaces, oversized IDs, ambiguous URLs, and unsupported algorithms must fail.


- [ ] **Step 2: Write failing claim-envelope tests**

Cover `EntityMetadataClaim`, `ExternalReferenceClaim`, `EquivalentEntityClaim`, `EditionOfClaim`, `RecordingOfClaim`, `ContributionClaim`, `CollectionStructureClaim`, `CollectionMembershipClaim`, `SupersedesClaim`, `RetractionClaim`, `ModerationClaim`, and `AvailabilityObservation`. Assert exact tagged bodies, typed endpoints, membership position tuples, expected-slot bounds, maximum counts/bytes, canonical ordering, signer capability, issuer sequence, expiry rules, retraction authorization, supersession scope, and `claimId === SignedEnvelope.recordId`.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/media-entity-reference.test.mjs test/media-claim.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement canonical entity and claim contracts**

Use compact binary encoding and explicit major/minor versions. Derive entity IDs from canonical typed reference bodies. Claims reuse `SignedEnvelope` and its ID directly; never hash an object containing its own ID or signature. Quarantine unknown major versions, mandatory claim variants, and state-changing tags without applying them; skip only explicitly optional length-delimited minor extensions.

- [ ] **Step 5: Verify Node/Bare parity**

Generate fixed vectors in Node and decode/verify them in the Bare backend harness. Check all limits before constructing large arrays or strings.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/media-entity-reference.test.mjs test/media-claim.test.mjs
npm run bundle:backend

git add packages/backend/src/media-graph packages/backend/src/index.js packages/backend/package.json packages/backend/test/media-entity-reference.test.mjs packages/backend/test/media-claim.test.mjs packages/app/backend.bundle.js packages/app/backend-bundles.manifest.mjs
git commit -m "feat(media): define canonical entity and claim contracts"
```

### Task 4: Build the local evidence graph and deterministic resolver

**Files:**

- Create: `packages/backend/src/media-graph/store.js`
- Create: `packages/backend/src/media-graph/resolver.js`
- Create: `packages/backend/src/media-graph/source-selector.js`
- Create: `packages/backend/test/media-graph-store.test.mjs`
- Create: `packages/backend/test/media-entity-resolver.test.mjs`
- Create: `packages/backend/test/media-source-selector.test.mjs`
- Modify: `packages/backend/src/meta-subspaces.js`
- Modify: `packages/backend/test/meta-subspaces.test.mjs`

**Acceptance:** unrelated publishers can populate one work, agent, or collection; exact duplicates collapse locally without losing publication provenance; contribution, order, structure, and equivalence conflicts remain inspectable; missing-member placeholders require trusted structure claims; resolver output is deterministic for a fixed trust policy; local materialized IDs are never serialized as global truth.

- [ ] **Step 1: Write failing graph-store tests**

Persist claims by issuer, subject, predicate, external reference, publication, collection, and revocation status. Test idempotent ingest, invalid signature quarantine, retraction without deletion, bounded scans, and migration-safe subspaces.

- [ ] **Step 2: Write failing resolver fixtures**

Cover:

- four publishers contributing episodes 1-4 of one season;
- three byte-identical publications of one episode;
- original recording, remaster, and live performance remaining distinct;
- the same creator represented by publisher, external-agent, and issuer-native references;
- artist/author/director/uploader contribution roles remaining distinct;
- conflicting season/track order and expected completeness claims;
- a missing slot shown only from an accepted `CollectionStructureClaim`;
- false provider-ID claim from an untrusted publisher;
- trusted curator equivalence claim;
- AI suggestion with lower evidence rank;
- split of a previously merged local cluster after contradictory evidence.

- [ ] **Step 3: Write failing source-selection tests**

Score metadata confidence, publisher trust, verified fingerprint agreement, observed availability, format support, and moderation penalty. Stable ties use publication ID. Never let publisher ownership decide abstract work, agent, or collection identity.

- [ ] **Step 4: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/media-graph-store.test.mjs test/media-entity-resolver.test.mjs test/media-source-selector.test.mjs test/meta-subspaces.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement graph storage and pure resolution**

Keep raw claims, acceptance decisions, conflicts, and preferred projections separate. Resolution receives an explicit local trust policy and clock. It must not read mutable globals or network state. Rebuild projections incrementally from affected references.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/media-graph-store.test.mjs test/media-entity-resolver.test.mjs test/media-source-selector.test.mjs test/meta-subspaces.test.mjs

git add packages/backend/src/media-graph packages/backend/src/meta-subspaces.js packages/backend/test/media-graph-store.test.mjs packages/backend/test/media-entity-resolver.test.mjs packages/backend/test/media-source-selector.test.mjs packages/backend/test/meta-subspaces.test.mjs
git commit -m "feat(media): materialize cross-publisher entity graph"
```

---

## Chunk 2: Immutable Publications and Renditions

### Task 5: Define content-addressed rendition, segment-index, and publication manifests

**Files:**

- Create: `packages/backend/src/assets/rendition.js`
- Create: `packages/backend/src/assets/segment-index.js`
- Create: `packages/backend/src/assets/manifest.js`
- Create: `packages/backend/src/assets/manifest-store.js`
- Create: `packages/backend/src/assets/index.js`
- Create: `packages/backend/test/asset-rendition.test.mjs`
- Create: `packages/backend/test/asset-segment-index.test.mjs`
- Create: `packages/backend/test/asset-manifest.test.mjs`
- Create: `packages/backend/test/asset-manifest-store.test.mjs`
- Modify: `packages/backend/src/content-publication.js`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/package.json`

**Acceptance:** `manifestId`, `publicationId`, and `renditionId` follow the non-circular domain-separated derivations in the design; exact rendition cores can be referenced by several publishers; segment indexes are immutable, content-addressed, bounded, and safe for sparse seek scheduling; corrected releases create new manifests and scoped supersession claims.

- [ ] **Step 1: Write failing rendition and segment-index vectors**

A rendition descriptor includes purpose, format, Hypercore key/length/tree hash, exact byte length, and segment-index descriptor. Derive `renditionId` from the canonical descriptor without publication identity. Test small inline indexes and separate immutable index cores. Validate index codec/version, core key/length/tree hash, byte length, entry count, digest, monotonic non-overlapping coordinates, decode timestamps/durations, independent-decode flags, and exact media bounds. A one-byte or one-field change changes the ID.

- [ ] **Step 2: Write failing manifest vectors**

Derive `manifestId` from the canonical unsigned body and `publicationId` from `publisherId + manifestId`, then sign an outer envelope. Neither ID/signature appears in the hashed body. Cover originals, ABR renditions, audio, artwork, subtitles, previous manifest, provenance, work/edition/contribution/collection claims, and exact maximum bounds.

- [ ] **Step 3: Write failing storage tests**

Store manifests by publication ID, publisher ID/sequence, referenced rendition, supersession, and current verified publisher head. Ingest is idempotent. Conflicting bytes for one ID fail closed. Reusing an existing verified rendition requires no writer key and preserves each publisher's manifest provenance.

- [ ] **Step 4: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/asset-rendition.test.mjs test/asset-segment-index.test.mjs test/asset-manifest.test.mjs test/asset-manifest-store.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement immutable contracts**

Use content identity, not publication identity, as the reusable media object. Decode segment-index pages lazily with hard page, entry, duration, coordinate, and byte limits before handing them to playback.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/asset-rendition.test.mjs test/asset-segment-index.test.mjs test/asset-manifest.test.mjs test/asset-manifest-store.test.mjs test/content-publication.test.mjs

git add packages/backend/src/assets packages/backend/src/content-publication.js packages/backend/src/index.js packages/backend/package.json packages/backend/test/asset-rendition.test.mjs packages/backend/test/asset-segment-index.test.mjs packages/backend/test/asset-manifest.test.mjs packages/backend/test/asset-manifest-store.test.mjs
git commit -m "feat(media): add immutable content-addressed media manifests"
```

### Task 6: Safely package uploads into immutable playable renditions

**Files:**

- Create: `packages/backend/src/assets/publication-batch.js`
- Create: `packages/backend/src/assets/rendition-writer.js`
- Create: `packages/backend/src/assets/media-validation.js`
- Create: `packages/backend/src/assets/hostile-media-worker.mjs`
- Create: `packages/backend/test/publication-batch.test.mjs`
- Create: `packages/backend/test/rendition-writer.test.mjs`
- Create: `packages/backend/test/hostile-media-validation.test.mjs`
- Modify: `packages/backend/src/upload.js`
- Modify: `packages/backend/src/transcode/segment-store.mjs`
- Modify: `packages/backend/src/transcode/fmp4-segmenter.mjs`
- Modify: `packages/backend/src/thumbnail.js`
- Modify: `packages/backend/src/mp4-playback-probe.js`
- Modify: `packages/backend/src/channel/structured-content.js`
- Modify: `packages/backend/test/upload-structured-metadata.test.mjs`
- Modify: `packages/backend/test/upload-playback-support.test.mjs`

**Acceptance:** hostile signed media is validated with bounded, cancellable probing before expensive parsing/decoding; an upload produces an immutable original, independent streaming/artwork/subtitle renditions, a signed manifest, and one atomic content-addressed publisher-catalog batch; albums and season packs publish independent child items plus typed structure/membership claims.

- [ ] **Step 1: Write failing hostile-media tests**

Cover oversized dimensions, duration, track count, container table count, malformed offsets, integer overflow, pathological subtitle cues, decompression/archive bombs, excessive nested archive paths, huge artwork, parser timeout, cancellation, and native worker crash. Never auto-extract archive renditions. Assert all resource reservations release and no unbounded buffer copy occurs.

- [ ] **Step 2: Write failing rendition-writer tests**

Verify initialization blocks, exact media segment boundaries, separate content-addressed segment index, sealed read-only cores, cancellation cleanup, no complete-buffer copies, and deterministic descriptors.

- [ ] **Step 3: Write failing atomic batch tests**

Write and seal an immutable collection-release batch containing child publication locators, typed structure/membership claims, and bounded pages; append one catalog commit referencing its digest. Simulate crashes before batch seal, before commit, and after commit. Readers project zero or all verified references, never a half-imported collection.

- [ ] **Step 4: Write failing import fixtures**

Cover one video, one song, full album with tracks and original archive, partial season, complete season, duplicate source references, alternate encodings, and conflicting metadata that remains a claim.

- [ ] **Step 5: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/hostile-media-validation.test.mjs test/rendition-writer.test.mjs test/publication-batch.test.mjs test/upload-structured-metadata.test.mjs test/upload-playback-support.test.mjs
```

Expected: FAIL.

- [ ] **Step 6: Implement bounded immutable packaging**

Keep original and playback variants in separate cores. Reuse fMP4 segmentation only behind the hostile-media boundary. Validate numeric limits before allocation, isolate native parsing where supported, propagate cancellation/time/memory budgets, and seal every rendition/index/batch before catalog publication. Do not retain raw source files as the only primary representation.

- [ ] **Step 7: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/hostile-media-validation.test.mjs test/rendition-writer.test.mjs test/publication-batch.test.mjs test/upload-structured-metadata.test.mjs test/upload-playback-support.test.mjs

git add packages/backend/src/assets packages/backend/src/upload.js packages/backend/src/transcode/segment-store.mjs packages/backend/src/transcode/fmp4-segmenter.mjs packages/backend/src/thumbnail.js packages/backend/src/mp4-playback-probe.js packages/backend/src/channel/structured-content.js packages/backend/test/hostile-media-validation.test.mjs packages/backend/test/rendition-writer.test.mjs packages/backend/test/publication-batch.test.mjs packages/backend/test/upload-structured-metadata.test.mjs packages/backend/test/upload-playback-support.test.mjs
git commit -m "feat(upload): safely publish immutable segmented media"
```

---

## Chunk 3: App-Facing Media Graph Contract

### Task 7: Add bounded media graph, publication, source, and collection RPCs

**Files:**

- Modify: `packages/spec/schema.cjs`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs`
- Create: `packages/spec/test/media-graph-schema.test.mjs`
- Regenerate: `packages/spec/spec/schema/**`
- Regenerate: `packages/spec/spec/hrpc/**`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/platform/test/rpc.shared.test.mjs`
- Create: `packages/backend/src/api/media-graph.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Create: `packages/backend/test/media-graph-api.test.mjs`

**Acceptance:** mobile and desktop consume one paginated, bounded media graph API exposing works, editions/recordings, publications, renditions, collections, agents/contributions, claims/conflicts, and source selection; publisher/source-provider and creator roles remain distinct; local resolver IDs are clearly scoped as local; no peer protocol object is passed as unbounded JSON.

- [ ] **Step 1: Write failing schema tests**

Register typed request/response codecs for:

- `get-media-entity`
- `get-media-collection`
- `get-media-collection-items`
- `get-media-agent`
- `get-agent-contributions`
- `get-publication-sources`
- `get-claim-provenance`
- `set-source-preference`

Use bounded pagination and explicit error codes. Do not use opaque JSON fields for claims, conflicts, or rendition descriptors.

- [ ] **Step 2: Run missing-contract tests**

```bash
npm test --prefix packages/spec
```

Expected: FAIL.

- [ ] **Step 3: Implement schema-first contract and regenerate**

Update the HRPC schema, generated app namespace classification, shared protocol version, and TypeScript declarations. Run:

```bash
npm run schema:full
```

- [ ] **Step 4: Write failing backend and facade tests**

Test pagination, stale cursors, bounded limits, missing entities, conflict exposure, alternate source order, provenance, and parity across native/web platform facades.

- [ ] **Step 5: Implement API and shared handlers**

The API reads only the local materialized graph and manifest store. It does not perform network discovery synchronously. Preserve typed structured errors through host and platform.

- [ ] **Step 6: Run verification**

```bash
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
npm exec --prefix packages/backend -- brittle test/media-graph-api.test.mjs test/mobile-handlers.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the app-facing contract**

```bash
git add packages/spec packages/host packages/platform packages/backend/src/api/media-graph.js packages/backend/src/api.js packages/backend/src/mobile-handlers.js packages/backend/src/hrpc-handlers.js packages/backend/test/media-graph-api.test.mjs packages/backend/test/mobile-handlers.test.mjs
git commit -m "feat(protocol): expose the local media entity graph"
```

---

## Chunk 4: Bounded Scoped Peer Networking

### Task 8: Build the common bounded peer protocol envelope and resource admission

**Files:**

- Create: `packages/backend/src/network/frame.js`
- Create: `packages/backend/src/network/replay-window.js`
- Create: `packages/backend/src/network/admission.js`
- Create: `packages/backend/src/network/peer-session.js`
- Create: `packages/backend/src/network/index.js`
- Create: `packages/backend/test/network-frame.test.mjs`
- Create: `packages/backend/test/network-replay-window.test.mjs`
- Create: `packages/backend/test/network-admission.test.mjs`
- Create: `packages/backend/test/network-peer-session.test.mjs`
- Modify: `packages/backend/src/budget-manager.js`
- Modify: `packages/backend/src/peer-scorer.js`
- Modify: `packages/backend/src/index.js`

**Acceptance:** every new peer connection binds one Protomux purpose/topic after Noise authentication, negotiates major/minor/features and the stricter limits before requests, and shares pre-decode byte limits, structural bounds, explicit unknown-tag dispatch, replay suppression, token buckets, verification queues, in-flight reservations, timeouts, cancellation, disconnect cleanup, and local penalties.

- [ ] **Step 1: Write failing frame tests**

Test exact maximum frame size, one-byte-over close, truncated varints, unknown major, unsupported mandatory tag, skippable optional length-delimited minor extension, oversized declared length without allocation, deep/nested payload attempts, invalid signed envelopes, and fixed Node/Bare vectors.

- [ ] **Step 2: Write failing negotiation and admission tests**

Drive `Noise authenticated -> purpose bound -> protocol negotiated -> active -> closed` for bootstrap, publisher, asset, live, and archive protocol names. Reject purpose/topic mismatch, major mismatch, request before handshake, cross-purpose handler dispatch, application-key/transport-key binding failure, and unsupported required feature bits. Negotiate stricter limits. Exhaust connection, message, verification, upload, and in-flight-byte budgets; release reservations on every terminal path; use monotonic replay windows with bounded wall-clock skew.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/network-frame.test.mjs test/network-replay-window.test.mjs test/network-admission.test.mjs test/network-peer-session.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement one common peer-session primitive**

Wrap Protomux channels with one purpose-bound handshake, framed dispatch, signed-envelope verification hooks, admission, cancellation, and local scoring. Handlers receive only negotiated, bounded, decoded values. They must not allocate from attacker-controlled lengths or open replication before validation.

- [ ] **Step 5: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/network-frame.test.mjs test/network-replay-window.test.mjs test/network-admission.test.mjs test/network-peer-session.test.mjs test/universal-core-hardening.test.mjs

git add packages/backend/src/network packages/backend/src/budget-manager.js packages/backend/src/peer-scorer.js packages/backend/src/index.js packages/backend/test/network-frame.test.mjs packages/backend/test/network-replay-window.test.mjs packages/backend/test/network-admission.test.mjs packages/backend/test/network-peer-session.test.mjs
git commit -m "feat(network): enforce bounded peer protocol sessions"
```

### Task 9: Implement domain-separated bootstrap, publisher, asset, and live topics

**Files:**

- Create: `packages/backend/src/network/topics.js`
- Create: `packages/backend/test/network-topics.test.mjs`
- Modify: `packages/backend/src/types.js`
- Modify: `packages/backend/test/swarm-status-diagnostics.test.mjs`
- Modify: `packages/backend/test/public-feed-manager.test.mjs`

**Acceptance:** every discovery purpose has a versioned domain-separated topic; exact rendition cores share an asset topic independent of publisher identity; bootstrap topics cannot infer or authorize asset replication; live topics rotate by event epoch.

- [ ] **Step 1: Write failing derivation vectors**

Define stable derivation for bootstrap, publisher namespace, exact asset rendition, and live event/epoch topics. Publisher topics use stable `publisherId + catalogEpoch`. Asset topics use `assetProtocolMajor + renditionId`, not publication identity, so several publications referencing the exact same core share peers.

- [ ] **Step 2: Test isolation properties**

Changing domain, publisher ID, catalog epoch, rendition ID, event, epoch, descriptor digest, or protocol major changes the topic. No asset topic is derivable from a bootstrap locator unless a verified publisher catalog explicitly reveals a rendition.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/network-topics.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Replace shared constants**

Retain `NETWORK_TOPIC_STRING` only in legacy code scheduled for deletion. All new code imports topic builders. Status diagnostics report joined topics by role without leaking secret material.

- [ ] **Step 5: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/network-topics.test.mjs test/swarm-status-diagnostics.test.mjs

git add packages/backend/src/network/topics.js packages/backend/src/types.js packages/backend/test/network-topics.test.mjs packages/backend/test/swarm-status-diagnostics.test.mjs packages/backend/test/public-feed-manager.test.mjs
git commit -m "feat(network): derive scoped publisher and asset topics"
```

### Task 10: Replace the global public feed with bounded bootstrap and publisher catalogs

**Files:**

- Create: `packages/backend/src/discovery/bootstrap-protocol.js`
- Create: `packages/backend/src/discovery/bootstrap-manager.js`
- Create: `packages/backend/src/discovery/publisher-protocol.js`
- Create: `packages/backend/src/discovery/publisher-manager.js`
- Create: `packages/backend/test/bootstrap-protocol.test.mjs`
- Create: `packages/backend/test/bootstrap-manager.test.mjs`
- Create: `packages/backend/test/publisher-protocol.test.mjs`
- Create: `packages/backend/test/publisher-manager.test.mjs`
- Create: `packages/backend/test/publisher-sync-budget.test.mjs`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/api/feed.js`
- Modify: `packages/backend/src/api/subscriptions.js`
- Modify: `packages/backend/src/api/status.js`
- Modify: `packages/backend/src/canonical-feed-contract.js`
- Modify: `packages/backend/test/canonical-feed-contract.test.mjs`

**Acceptance:** bootstrap exchanges bounded expiring signed locators that remain untrusted until a client syncs the stable genesis-bound catalog and validates root/device authorization; following or inspecting a publisher opens only that catalog under cumulative budgets; catalog ingest never downloads media or adopts a mirror; global topic peers cannot access generic locally open Corestore replication.

- [ ] **Step 1: Write failing bootstrap tests**

Test exact announcement bounds, envelope signature, expiry with skew, replay, per-publisher replacement, per-peer quotas, optional local proof-of-work policy, and zero media/core opening. Prove an unknown signer announcement is only a locator: use `catalogBootstrapKey` to sync from genesis or the last trusted checkpoint, validate root transitions and device admission, compare `authorizationChainDigest` only as a hint, then accept the advertised head.

- [ ] **Step 2: Write failing publisher sync tests**

Follow one publisher, lazily fetch bounded catalog pages, verify publisher delegation and signed envelopes, ingest manifests/claims, resume from a verified head, reject forks/stale heads, and stop topic discovery on unsubscribe. Exhaust per-peer/per-feed/global head-advance, bytes/records-per-window, retained bytes, projection rows, verification queue, collection-page, crawl-depth/fan-out, and concurrent-session budgets; persist the last verified cursor and return structured partial/quarantined state without eager allocation.

- [ ] **Step 3: Write a no-generic-replication test**

Connect an untrusted bootstrap peer while unrelated private and media cores are open. Assert it can access only bootstrap messages, not Corestore replication or arbitrary keys.

- [ ] **Step 4: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/bootstrap-protocol.test.mjs test/bootstrap-manager.test.mjs test/publisher-protocol.test.mjs test/publisher-manager.test.mjs test/publisher-sync-budget.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement managers and orchestration**

Use the common purpose-bound peer session and shared `SignedEnvelope`. Publisher catalogs carry atomic content-addressed batches fetched lazily. Bootstrap records are metadata-only locators until their signer chain verifies from the stable catalog. Persist trusted checkpoints, partial cursors, budget windows, and replay state in dedicated meta subspaces.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/bootstrap-protocol.test.mjs test/bootstrap-manager.test.mjs test/publisher-protocol.test.mjs test/publisher-manager.test.mjs test/publisher-sync-budget.test.mjs test/canonical-feed-contract.test.mjs test/swarm-status-diagnostics.test.mjs

git add packages/backend/src/discovery packages/backend/src/orchestrator.js packages/backend/src/api/feed.js packages/backend/src/api/subscriptions.js packages/backend/src/api/status.js packages/backend/src/canonical-feed-contract.js packages/backend/test/bootstrap-protocol.test.mjs packages/backend/test/bootstrap-manager.test.mjs packages/backend/test/publisher-protocol.test.mjs packages/backend/test/publisher-manager.test.mjs packages/backend/test/publisher-sync-budget.test.mjs packages/backend/test/canonical-feed-contract.test.mjs
git commit -m "feat(discovery): sync bounded publisher catalogs"
```

---

## Chunk 5: Asset Delivery and Enforced Resource Policy

### Task 11: Open only authorized rendition cores per peer connection

**Files:**

- Create: `packages/backend/src/assets/asset-session.js`
- Create: `packages/backend/src/assets/availability.js`
- Create: `packages/backend/test/asset-session.test.mjs`
- Create: `packages/backend/test/asset-availability.test.mjs`
- Modify: `packages/backend/src/storage.js`
- Modify: `packages/backend/src/content-replication.js`
- Modify: `packages/backend/test/channel-bootstrap-replication.test.mjs`
- Modify: `packages/backend/test/content-replication.test.mjs`

**Acceptance:** joining an asset topic opens only the manifest-approved rendition core and bounded availability protocol; a peer cannot request arbitrary local core keys; disconnect releases discovery, core sessions, and reservations.

- [ ] **Step 1: Write failing allowlist tests**

Attempt to request private metadata, another rendition, an unknown core, a superseded rendition, and a locally blocked asset over a valid asset session. All fail before replication opens.

- [ ] **Step 2: Write failing availability tests**

Exchange compact bounded range summaries for one rendition. Test sparse cores, malicious claimed ranges, contradictory summaries, and verification against actual delivered blocks.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/asset-session.test.mjs test/asset-availability.test.mjs test/channel-bootstrap-replication.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement explicit per-session core allowlists**

Do not call unrestricted `store.replicate(conn)`. Bind a session to one verified manifest/rendition descriptor and expose only its read-only replication surface. Treat availability as a scheduling hint until blocks verify.

- [ ] **Step 5: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/asset-session.test.mjs test/asset-availability.test.mjs test/channel-bootstrap-replication.test.mjs test/content-replication.test.mjs

git add packages/backend/src/assets packages/backend/src/storage.js packages/backend/src/content-replication.js packages/backend/test/asset-session.test.mjs packages/backend/test/asset-availability.test.mjs packages/backend/test/channel-bootstrap-replication.test.mjs packages/backend/test/content-replication.test.mjs
git commit -m "feat(replication): scope peer sessions to verified renditions"
```

### Task 12: Add multi-peer playback scheduling with strict local fallback

**Files:**

- Create: `packages/backend/src/playback/multi-peer-scheduler.js`
- Create: `packages/backend/src/playback/playback-session.js`
- Create: `packages/backend/src/playback/resource-policy.js`
- Create: `packages/backend/test/multi-peer-playback.test.mjs`
- Create: `packages/backend/test/playback-resource-policy.test.mjs`
- Modify: `packages/backend/src/blob-range-priority.js`
- Modify: `packages/backend/src/playback-forward-fill.js`
- Modify: `packages/backend/src/playback-window-cache.js`
- Modify: `packages/backend/src/blob-playback-service.js`
- Modify: `packages/backend/src/api/seeding.js`
- Modify: `packages/backend/test/blob-range-priority.test.mjs`
- Modify: `packages/backend/test/playback-forward-fill.test.mjs`
- Modify: `packages/backend/test/playback-service.test.mjs`

**Acceptance:** startup/index, playhead, seek, forward window, rarity, and background priorities are enforced across peers; observed verified delivery controls peer selection; full-file fill never delays startup or seek; source order is local/cache first and a bounded P2P race second; complete local/cache playback remains functional with no peers; absent verified ranges return structured unavailability within the deadline; no undeclared remote-origin path exists; every policy bounds disk, upload, peers, requests, in-flight bytes, and deadlines.

- [ ] **Step 1: Write failing scheduler simulations**

Use deterministic fake peers: fast partial, slow complete, lying availability, disconnecting, duplicated ranges, and no peers, plus complete and incomplete local caches. Assert no duplicate request unless the hedge threshold is crossed; cancellation releases all reservations; seek cancels stale background work; complete local data plays with no peer; missing-range and missed-deadline cases fail promptly with structured unavailability and never attempt an ad hoc HTTP/origin request.

- [ ] **Step 2: Write failing resource-transition tests**

Switch foreground/background, Wi-Fi/metered, charging/battery, normal/thermal pressure, and user consent. Assert peer discovery, upload, cache fill, and archiving react immediately without interrupting local playback.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/multi-peer-playback.test.mjs test/playback-resource-policy.test.mjs test/blob-range-priority.test.mjs test/playback-forward-fill.test.mjs test/playback-service.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement scheduler and policy enforcement**

Feed current availability and observed verified throughput into range assignment. Keep Hypercore verification as the integrity authority. Background fill uses only residual budget after playback. The public P2P-only scope has no remote-origin contract; do not add an implicit URL fallback. Do not copy media buffers to calculate scheduling decisions.

- [ ] **Step 5: Run focused and smoke verification**

```bash
npm exec --prefix packages/backend -- brittle test/multi-peer-playback.test.mjs test/playback-resource-policy.test.mjs test/blob-range-priority.test.mjs test/playback-forward-fill.test.mjs test/playback-service.test.mjs test/playback-api.test.mjs
```

Then launch desktop with a seeded local rendition, play once with a peer, once with the peer unavailable from complete local cache, and once with an intentionally missing seek range. Confirm the first two play, the missing range returns structured unavailability within the configured deadline, and diagnostics report the expected source mix without an origin request.

- [ ] **Step 6: Commit playback delivery**

```bash
git add packages/backend/src/playback packages/backend/src/blob-range-priority.js packages/backend/src/playback-forward-fill.js packages/backend/src/playback-window-cache.js packages/backend/src/blob-playback-service.js packages/backend/src/api/seeding.js packages/backend/test/multi-peer-playback.test.mjs packages/backend/test/playback-resource-policy.test.mjs packages/backend/test/blob-range-priority.test.mjs packages/backend/test/playback-forward-fill.test.mjs packages/backend/test/playback-service.test.mjs
git commit -m "feat(playback): schedule bounded multi-peer rendition delivery"
```

---

## Chunk 6: Voluntary Archival Evidence

### Task 13: Implement signed archival pledges and possession challenges

**Files:**

- Create: `packages/backend/src/archive/pledge.js`
- Create: `packages/backend/src/archive/challenge.js`
- Create: `packages/backend/src/archive/protocol.js`
- Create: `packages/backend/src/archive/store.js`
- Create: `packages/backend/src/archive/index.js`
- Create: `packages/backend/test/archive-pledge.test.mjs`
- Create: `packages/backend/test/archive-challenge.test.mjs`
- Create: `packages/backend/test/archive-protocol.test.mjs`
- Create: `packages/backend/test/archive-store.test.mjs`
- Reuse patterns from: `packages/backend/src/seed-pin/auth.js`
- Reuse patterns from: `packages/backend/src/seed-pin/protocol.js`
- Modify: `packages/backend/src/index.js`

**Acceptance:** archivists publish bounded self-issued `SignedEnvelope` pledges; auditors issue unpredictable transcript-bound challenges; responses bind pledge envelope ID, challenge nonce, exact core/range, Hypercore proof, peer transport identity, and monotonic deadline; replay, stale proof, false range, wrong core, and identity substitution fail.

- [ ] **Step 1: Write failing canonical pledge tests**

Test publication/rendition/range binding, expected retention, upload ceiling, issue/expiry, nonce, exact fields, maximum ranges, canonical ordering, policy epoch zero, and shared-envelope signature domain. Ensure no pledge body hashes its enclosing ID.

- [ ] **Step 2: Write failing challenge tests**

Use deterministic challenge selection from fresh auditor randomness unknown at pledge time. Verify complete and sparse ranges, wrong core, old nonce, copied response, expired pledge, late response, proof from another peer, and transport/signing-key mismatch.

- [ ] **Step 3: Write failing wire tests**

Apply common frame/admission limits, per-peer challenge quotas, response timeouts, cancellation, and peer scoring.

- [ ] **Step 4: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/archive-pledge.test.mjs test/archive-challenge.test.mjs test/archive-protocol.test.mjs test/archive-store.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement voluntary evidence**

Pledges and observations are signed facts, not leases assigned by a central server. Store local observations and optionally publish them through peer/curator feeds. Never convert one successful challenge into a guarantee of future availability.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/archive-pledge.test.mjs test/archive-challenge.test.mjs test/archive-protocol.test.mjs test/archive-store.test.mjs

git add packages/backend/src/archive packages/backend/src/index.js packages/backend/test/archive-pledge.test.mjs packages/backend/test/archive-challenge.test.mjs packages/backend/test/archive-protocol.test.mjs packages/backend/test/archive-store.test.mjs
git commit -m "feat(archive): add signed retention pledges and proofs"
```

### Task 14: Enforce retention reservations and confirmed source offload

**Files:**

- Create: `packages/backend/src/archive/policy.js`
- Create: `packages/backend/src/archive/manager.js`
- Create: `packages/backend/src/archive/confidence.js`
- Create: `packages/backend/test/archive-policy.test.mjs`
- Create: `packages/backend/test/archive-manager.test.mjs`
- Create: `packages/backend/test/archive-confidence.test.mjs`
- Modify: `packages/backend/src/upload-offload.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/seeding.js`
- Modify: `packages/backend/src/corestore-gc.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Modify: `packages/backend/test/upload-offload.test.mjs`
- Modify: `packages/backend/test/seeding-storage-accounting.test.mjs`
- Modify: `packages/backend/test/storage-quota-api.test.mjs`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs`
- Create: `packages/spec/test/source-offload-contract.test.mjs`
- Regenerate: `packages/spec/spec/**`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/platform/test/rpc.shared.test.mjs`
- Modify: `packages/app/workers/desktop/index.ts`
- Modify: `packages/app/app/(tabs)/studio.tsx`
- Create: `packages/app/tests/source-offload-confirmation-regression.test.mjs`

**Acceptance:** every retention mode reserves bytes before acceptance and reconciles expiry/actual usage atomically; physical disk and upload ceilings hold; the last publisher/original copy is never deleted automatically; viewer/anonymous possession never authorizes source offload; a destructive request is bound to one publication, a fresh assessment/evidence digest, a single-use confirmation nonce, and explicit irrecoverability acknowledgement; the backend re-evaluates evidence immediately before deletion and persists an auditable result.

- [ ] **Step 1: Write failing reservation tests**

Simulate concurrent pledges racing for remaining disk, partial writes, cancellation, expiry, GC, restart, and full disk. Reservations and actual bytes reconcile atomically.

- [ ] **Step 2: Write failing confidence and confirmation-contract tests**

Transient viewers with full bitfields are insufficient regardless of count. Cover a second publisher-controlled device, intentionally operated archivist, recent challenge history, same-device identities, Sybil hints, disconnected peers, and ordinary voluntary archivists. Define assessment responses with `publicationId`, `assessmentId`, canonical `evidenceDigest`, expiry, and policy version. Define offload requests with those exact values, a single-use random confirmation nonce, and `confirmIrrecoverableRisk: true`. Reject direct/unconfirmed calls, false acknowledgement, wrong publication, stale/changed evidence, expired assessment, replayed nonce, active playback, and post-confirmation policy changes.

- [ ] **Step 3: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/archive-policy.test.mjs test/archive-manager.test.mjs test/archive-confidence.test.mjs test/upload-offload.test.mjs test/seeding-storage-accounting.test.mjs
npm test --prefix packages/spec
node --test packages/app/tests/source-offload-confirmation-regression.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement transactional policy and schema-first confirmation**

Reserve before pledge acceptance; persist reservation and pledge atomically; write only inside it; release on rejection/expiry. GC evicts only policy-eligible ranges and preserves manual/original pins. Replace the legacy channel/video-only destructive RPC across generated HRPC, host, platform, mobile/desktop handlers, and Studio. The confirmation dialog displays the exact publication and current evidence limitations. On submit, atomically consume the nonce, recompute the assessment/evidence digest and eligibility, record success/failure, then delete only on an exact match. No background confidence score may invoke offload.

- [ ] **Step 5: Run focused and contract verification**

```bash
npm run schema:full
npm exec --prefix packages/backend -- brittle test/archive-policy.test.mjs test/archive-manager.test.mjs test/archive-confidence.test.mjs test/upload-offload.test.mjs test/seeding-storage-accounting.test.mjs test/storage-quota-api.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
node --test packages/app/tests/source-offload-confirmation-regression.test.mjs
```

- [ ] **Step 6: Commit retention and offload**

```bash
git add packages/backend/src/archive packages/backend/src/upload-offload.js packages/backend/src/api.js packages/backend/src/seeding.js packages/backend/src/corestore-gc.js packages/backend/src/mobile-handlers.js packages/backend/src/hrpc-handlers.js packages/backend/test/archive-policy.test.mjs packages/backend/test/archive-manager.test.mjs packages/backend/test/archive-confidence.test.mjs packages/backend/test/upload-offload.test.mjs packages/backend/test/seeding-storage-accounting.test.mjs packages/backend/test/storage-quota-api.test.mjs packages/spec packages/host packages/platform packages/app/workers/desktop/index.ts packages/app/app/'(tabs)'/studio.tsx packages/app/tests/source-offload-confirmation-regression.test.mjs
git commit -m "feat(archive): require confirmed source offload"
```

---

## Chunk 7: Permissionless Indexing and Moderation

### Task 15: Add signed curator and index feeds plus local graph search

**Files:**

- Create: `packages/backend/src/indexing/feed-contract.js`
- Create: `packages/backend/src/indexing/feed-manager.js`
- Create: `packages/backend/src/indexing/local-index.js`
- Create: `packages/backend/src/indexing/index.js`
- Create: `packages/backend/test/index-feed-contract.test.mjs`
- Create: `packages/backend/test/index-feed-manager.test.mjs`
- Create: `packages/backend/test/local-media-index.test.mjs`
- Modify: `packages/backend/src/search/federated-search.js`
- Modify: `packages/backend/src/search/semantic-finder.js`
- Modify: `packages/backend/src/api/search.js`
- Modify: `packages/backend/test/search-direct-ref-regression.test.mjs`
- Modify: `packages/backend/test/search-creator-name.test.mjs`

**Acceptance:** any identity may publish bounded signed index/curator records as untrusted locators and evidence; clients subscribe explicitly; every playable result resolves its publication reference through the stable publisher catalog and verifies root/delegation, manifest, and claims; spam feeds cannot force media downloads, eager catalog traversal, or unbounded indexing.

- [ ] **Step 1: Write failing feed-contract tests**

Cover typed entity/publication references, collections, membership, equivalence/contribution evidence, tags, ranking, methodology, model metadata, shared-envelope IDs/signatures, expiry, pagination, `catalogBlockHint`, `rootTransitionProofDigest` as a hint only, and strict bounds.

- [ ] **Step 2: Write failing trust/spam tests**

Unknown high-volume index, duplicate references, invalid/stale locator hints, invalid manifests, root-transition mismatch, conflicting claims, and subscribed trusted curator. Assert bounded lazy resolution, quarantine, and local policy, not a central allowlist.

- [ ] **Step 3: Write failing search projection tests**

Search one coherent entity while returning alternate publications and provenance. Verify exact source IDs, title/creator text, collection membership, and optional local semantic index.

- [ ] **Step 4: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/index-feed-contract.test.mjs test/index-feed-manager.test.mjs test/local-media-index.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement bounded feed ingestion and local search**

Index metadata and bounded locators only. Resolve from publisher genesis or a trusted checkpoint and verify the publisher chain before ranking a result as playable. A stale block hint falls back only to bounded head synchronization. Do not expose diagnostic URLs or credentials.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/index-feed-contract.test.mjs test/index-feed-manager.test.mjs test/local-media-index.test.mjs test/search-direct-ref-regression.test.mjs test/search-creator-name.test.mjs

git add packages/backend/src/indexing packages/backend/src/search/federated-search.js packages/backend/src/search/semantic-finder.js packages/backend/src/api/search.js packages/backend/test/index-feed-contract.test.mjs packages/backend/test/index-feed-manager.test.mjs packages/backend/test/local-media-index.test.mjs packages/backend/test/search-direct-ref-regression.test.mjs packages/backend/test/search-creator-name.test.mjs
git commit -m "feat(search): ingest permissionless signed media indexes"
```

### Task 16: Implement bounded moderation feeds, shared enforcement, and optional AI annotations

**Files:**

- Create: `packages/backend/src/moderation/feed-contract.js`
- Create: `packages/backend/src/moderation/store.js`
- Create: `packages/backend/src/moderation/manager.js`
- Create: `packages/backend/src/moderation/policy.js`
- Create: `packages/backend/src/moderation/annotation.js`
- Create: `packages/backend/src/moderation/index.js`
- Create: `packages/backend/test/moderation-feed-contract.test.mjs`
- Create: `packages/backend/test/moderation-manager.test.mjs`
- Create: `packages/backend/test/moderation-policy.test.mjs`
- Create: `packages/backend/test/moderation-enforcement.test.mjs`
- Create: `packages/backend/test/ai-annotation.test.mjs`
- Modify: `packages/backend/src/media-graph/resolver.js`
- Modify: `packages/backend/src/discovery/publisher-manager.js`
- Modify: `packages/backend/src/assets/asset-session.js`
- Modify: `packages/backend/src/playback/playback-session.js`
- Modify: `packages/backend/src/archive/manager.js`
- Modify: `packages/backend/src/seeding.js`
- Modify: `packages/backend/src/corestore-gc.js`
- Modify: `packages/backend/src/api/subscriptions.js`
- Modify: `packages/backend/src/api/media-graph.js`
- Modify: `packages/backend/src/orchestrator.js`

**Acceptance:** filtering independently targets publisher, publication, work, recording/edition, collection, agent/creator, claim issuer, curator/index feed, or exact rendition; optional moderation feeds synchronize only after explicit subscription under signature/replay/expiry and cumulative quotas; one shared decision/evidence contract governs projection, publisher/catalog retention, asset admission, playback fetch, archive retention, GC eligibility, download, and serving; agent decisions propagate only through accepted `ContributionClaim` roles selected by local policy; AI output is a derived annotation with model provenance and never mutates canonical publisher data.

- [ ] **Step 1: Write failing feed and subscription-manager tests**

Cover shared-envelope signatures, replay, expiry/skew, labels, block/allow records, age/safety metadata, copyright claims, recommendations, contradictory feeds, explicit subscribe/unsubscribe lifecycle, restart cursors, per-peer/per-feed/global records/bytes/verification/retained-state quotas, malformed pages, and disconnect cleanup. Metadata ingestion must not open media.

- [ ] **Step 2: Write failing policy precedence tests**

Hard local safety limits, local allow/block lists, subscribed feeds, publisher trust, metadata classification, sampled-media annotations, and full-media annotations produce explicit actions: visible, blurred, hidden, not downloaded, or not seeded. Test uploader, performer, and director decisions against one publication; only configured accepted contribution roles propagate to media actions while the agent projection remains independently filterable.

- [ ] **Step 3: Write failing enforcement integration tests**

Inject one decision/evidence trace into publisher catalog ingest, asset-session admission, playback range fetch, recent/followed/archivist retention, GC, and seeding/upload. For every target level, prove `not downloaded` prevents new blocks and `not seeded` prevents serving already retained blocks; policy changes cancel in-flight work and release reservations; allow does not override hard safety; a UI-only hidden state cannot bypass network/storage enforcement.

- [ ] **Step 4: Write failing AI annotation tests**

Require model ID/version, analyzed ranges, labels, confidence, creation time, and local or external issuer. Resolver weight remains below cryptographic/external-ID/fingerprint evidence and preserves original metadata.

- [ ] **Step 5: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/moderation-feed-contract.test.mjs test/moderation-manager.test.mjs test/moderation-policy.test.mjs test/moderation-enforcement.test.mjs test/ai-annotation.test.mjs test/media-entity-resolver.test.mjs
```

Expected: FAIL.

- [ ] **Step 6: Implement bounded ingestion and one pure policy decision**

Persist raw feed records separately from local subscription/trust and derived decisions. Return a decision, evidence trace, and exact traversed contribution edges/roles from a pure evaluator. Inject that evaluator into every listed network/storage manager; managers recheck before admission and on policy-change cancellation. Never rewrite or retract publisher-authored claims as moderation.

- [ ] **Step 7: Run tests and commit**

```bash
npm exec --prefix packages/backend -- brittle test/moderation-feed-contract.test.mjs test/moderation-manager.test.mjs test/moderation-policy.test.mjs test/moderation-enforcement.test.mjs test/ai-annotation.test.mjs test/media-entity-resolver.test.mjs test/media-graph-api.test.mjs

git add packages/backend/src/moderation packages/backend/src/media-graph/resolver.js packages/backend/src/discovery/publisher-manager.js packages/backend/src/assets/asset-session.js packages/backend/src/playback/playback-session.js packages/backend/src/archive/manager.js packages/backend/src/seeding.js packages/backend/src/corestore-gc.js packages/backend/src/api/subscriptions.js packages/backend/src/api/media-graph.js packages/backend/src/orchestrator.js packages/backend/test/moderation-feed-contract.test.mjs packages/backend/test/moderation-manager.test.mjs packages/backend/test/moderation-policy.test.mjs packages/backend/test/moderation-enforcement.test.mjs packages/backend/test/ai-annotation.test.mjs
git commit -m "feat(moderation): enforce client-selected media policy"
```

---

## Chunk 8: Unified Native Product Projection

### Task 17: Replace upload-centric client shaping with the resolved media graph

**Files:**

- Create: `packages/app/lib/media-entity-graph.js`
- Create: `packages/app/lib/media-source-selection.js`
- Create: `packages/app/tests/media-entity-graph.test.mjs`
- Create: `packages/app/tests/media-source-selection.test.mjs`
- Modify: `packages/app/lib/media-hub.js`
- Modify: `packages/app/lib/content-catalog.js`
- Modify: `packages/app/tests/media-hub.test.mjs`
- Modify: `packages/app/tests/content-catalog.test.mjs`

**Acceptance:** client data shaping consumes resolved works, editions/recordings, publications, renditions, collections, agents/contributions, provenance, and conflicts; partial collections merge; duplicates become alternate sources; publisher/source-provider attribution stays distinct from creator roles; explicit metadata remains preferred over title parsing.

- [ ] **Step 1: Write failing projection fixtures**

Cover partial season, full album, missing track, duplicate episode, remaster versus original, conflicting order, missing artwork, unavailable preferred source, uploader distinct from performer/director, one agent referenced across publishers, local moderation, and a legacy publication with minimal claims.

- [ ] **Step 2: Run focused failures**

```bash
node --test packages/app/tests/media-entity-graph.test.mjs packages/app/tests/media-source-selection.test.mjs packages/app/tests/media-hub.test.mjs packages/app/tests/content-catalog.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement pure client projection**

Keep playback keys tied to a selected publication/rendition while navigation keys identify local resolved entities. Do not collapse provenance or conflict arrays during normalization.

- [ ] **Step 4: Run tests and commit**

```bash
node --test packages/app/tests/media-entity-graph.test.mjs packages/app/tests/media-source-selection.test.mjs packages/app/tests/media-hub.test.mjs packages/app/tests/content-catalog.test.mjs

git add packages/app/lib/media-entity-graph.js packages/app/lib/media-source-selection.js packages/app/lib/media-hub.js packages/app/lib/content-catalog.js packages/app/tests/media-entity-graph.test.mjs packages/app/tests/media-source-selection.test.mjs packages/app/tests/media-hub.test.mjs packages/app/tests/content-catalog.test.mjs
git commit -m "feat(app): project the resolved cross-publisher media graph"
```

### Task 18: Render unified works, collections, sources, conflicts, and archive state

**Files:**

- Create: `packages/app/app/media/[id].tsx`
- Create: `packages/app/app/media/[id].web.tsx`
- Create: `packages/app/app/collection/[id].tsx`
- Create: `packages/app/app/collection/[id].web.tsx`
- Create: `packages/app/app/creator/[id].tsx`
- Create: `packages/app/app/creator/[id].web.tsx`
- Create: `packages/app/components/media/SourceSelector.tsx`
- Create: `packages/app/components/media/ProvenancePanel.tsx`
- Create: `packages/app/components/media/ConflictNotice.tsx`
- Create: `packages/app/components/media/CollectionCompleteness.tsx`
- Create: `packages/app/components/media/ArchiveStatus.tsx`
- Create: `packages/app/components/media/ContributionList.tsx`
- Modify: `packages/app/app/(tabs)/index.tsx`
- Modify: `packages/app/app/(tabs)/index.web.tsx`
- Modify: `packages/app/app/search.tsx`
- Modify: `packages/app/app/channel/[key].tsx`
- Modify: `packages/app/app/channel/[key].web.tsx`
- Modify: `packages/app/components/media/*`
- Create: `packages/app/tests/media-entity-pages-regression.test.mjs`
- Create: `packages/app/tests/collection-projection-regression.test.mjs`

**Acceptance:** ordinary users see one coherent title and play action; unified creator pages resolve accepted agent/contribution claims across publishers; advanced views expose alternate sources, source-provider attribution, creator roles, provenance, conflicts, completeness, and archival evidence; publisher channels remain provenance destinations rather than global entity or creator owners; mobile and desktop preserve current playback routes.

- [ ] **Step 1: Add failing UI contract tests**

Assert one episode row with multiple sources, missing episode/track placeholders, remaster separation, explicit conflict notice, source switch preserving playback, publisher versus uploader/performer/director attribution, one creator page assembled across publisher claims, and archive status without claiming guaranteed permanence.

- [ ] **Step 2: Run focused failures**

```bash
node --test packages/app/tests/media-entity-pages-regression.test.mjs packages/app/tests/collection-projection-regression.test.mjs packages/app/tests/channel-view-playback-regression.test.mjs packages/app/tests/desktop-media-cockpit-regression.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement routes and components**

Use the app-facing graph RPC. Fetch paginated collection members. Preserve `publicBeeKey`/publisher provenance for legacy routes during this task, but new entity navigation uses local resolver IDs. Display uncertainty instead of silently choosing contradictory claims.

- [ ] **Step 4: Browser and native smoke verification**

Launch desktop and exercise:

1. a collection assembled from several publishers;
2. a duplicate work with source switching;
3. a missing collection member;
4. a conflicting metadata claim;
5. a creator page with publisher, uploader, performer, and director roles kept distinct;
6. playback with and without a peer.

Run the equivalent navigation/playback path on Android or iOS before claiming mobile completion.

- [ ] **Step 5: Run focused verification and commit**

```bash
node --test packages/app/tests/media-entity-pages-regression.test.mjs packages/app/tests/collection-projection-regression.test.mjs packages/app/tests/channel-view-playback-regression.test.mjs packages/app/tests/desktop-media-cockpit-regression.test.mjs

git add packages/app/app/media packages/app/app/collection packages/app/app/creator packages/app/app/'(tabs)'/index.tsx packages/app/app/'(tabs)'/index.web.tsx packages/app/app/search.tsx packages/app/app/channel/'[key].tsx' packages/app/app/channel/'[key].web.tsx' packages/app/components/media packages/app/tests/media-entity-pages-regression.test.mjs packages/app/tests/collection-projection-regression.test.mjs
git commit -m "feat(app): render unified media entities and collections"
```

### Task 19: Add user-facing retention, trust, index, and moderation controls

**Files:**

- Create: `packages/app/app/network-policy.tsx`
- Create: `packages/app/app/subscriptions.tsx`
- Create: `packages/app/app/moderation.tsx`
- Create: `packages/app/components/library/RetentionPolicyEditor.tsx`
- Create: `packages/app/components/library/FeedTrustEditor.tsx`
- Create: `packages/app/components/library/ModerationFeedEditor.tsx`
- Modify: `packages/app/app/profile.tsx`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/platform/test/rpc.shared.test.mjs`
- Regenerate: `packages/spec/spec/**`
- Create: `packages/backend/src/api/policy.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Create: `packages/app/tests/network-policy-controls-regression.test.mjs`

**Acceptance:** users explicitly control upload permission, metered/background behavior, disk and upload ceilings, retention mode, followed publishers/indexes/curators, trusted moderation feeds, agent/creator and contribution-role moderation, and optional AI analysis; defaults avoid involuntary bandwidth and battery use.

- [ ] **Step 1: Define schema-first policy RPCs and tests**

Add typed get/set operations with validated numeric bounds and enum values. Regenerate HRPC, update host declarations and the shared native/web platform facade, persist policy writes locally, and emit resource-policy changes immediately. Keep policy RPCs in the focused backend policy API rather than the media-graph API.

- [ ] **Step 2: Run missing-contract failures**

```bash
npm test --prefix packages/spec
node --test packages/app/tests/network-policy-controls-regression.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement controls and focused tests**

Ensure no toggle implies global moderation or guaranteed retention. Explain public IP exposure and inability to retract already shared bytes.

- [ ] **Step 4: Smoke test transitions**

While playing and seeding, toggle metered/background/upload/retention settings and observe peer and archive sessions stop or resume without backend restart.

- [ ] **Step 5: Run verification and commit**

```bash
npm run schema:full
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
node --test packages/app/tests/network-policy-controls-regression.test.mjs

git add packages/spec packages/host packages/platform packages/backend/src/api/policy.js packages/backend/src/api.js packages/backend/src/mobile-handlers.js packages/backend/src/hrpc-handlers.js packages/app/app/network-policy.tsx packages/app/app/subscriptions.tsx packages/app/app/moderation.tsx packages/app/app/profile.tsx packages/app/components/library packages/app/tests/network-policy-controls-regression.test.mjs
git commit -m "feat(app): expose local network and moderation policy"
```

---

## Chunk 9: Live Event Scoping and Sealed Recordings

### Task 20: Move live delivery to event/epoch topics and immutable recording output

**Files:**

- Create: `packages/backend/src/live/live-descriptor.js`
- Create: `packages/backend/test/live-descriptor.test.mjs`
- Modify: `packages/backend/src/live/live-core-format.js`
- Modify: `packages/backend/src/live/live-core-writer.js`
- Modify: `packages/backend/src/live/live-broadcast-service.js`
- Modify: `packages/backend/src/live/live-playback-service.js`
- Create: `packages/backend/src/live/live-network-session.js`
- Create: `packages/backend/test/live-network-session.test.mjs`
- Modify: `packages/backend/test/live-stream.test.mjs`
- Modify: `packages/backend/src/api/live.js`

**Acceptance:** a publisher-authorized `SignedEnvelope<LiveEventBody>` derives stable `eventId`; every authorized epoch descriptor binds event ID, monotonic epoch, previous digest, writable core, initialization/index commitment, start/expiry, codec, and bounded DVR window; late joiners resolve only the current chain head; regressions, gaps, invalid windows, unauthorized writers, and catalog-event mismatch fail; `ended`/`aborted` closes new traffic; sealing validates the full chain before immutable publication/collection output; no global live feed carries segments.

- [ ] **Step 1: Write failing epoch and late-join tests**

Cover canonical event and epoch vectors; unauthorized event/device signer; event nonce/ID mismatch; descriptor tamper; catalog-event mismatch; epoch regression; duplicate epoch with different bytes; skipped, wrong, or missing `previousEpochDigest`; not-yet-valid and expired windows with bounded skew; event/epoch topic separation; unauthorized writer append; publisher disconnect; late join selecting only current head/window; malformed segments; `ended` and `aborted` rejecting new traffic; seal with incomplete chain; and atomic valid live-to-recording transition.

- [ ] **Step 2: Run focused failures**

```bash
npm exec --prefix packages/backend -- brittle test/live-descriptor.test.mjs test/live-network-session.test.mjs test/live-stream.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement scoped live sessions**

Reuse the shared envelope, purpose-bound peer framing/admission, and multi-peer scheduling. Verify the catalog event, exact device authorization/policy epoch, descriptor chain, validity window, and writable core before joining or accepting an append. Rotate topic/key and replay state per epoch. Terminal records cancel sessions and block later epochs. Keep DVR as a separately declared retained rendition; sealing walks and verifies the terminal chain before catalog commit.

- [ ] **Step 4: Run verification and commit**

```bash
npm exec --prefix packages/backend -- brittle test/live-descriptor.test.mjs test/live-network-session.test.mjs test/live-stream.test.mjs

git add packages/backend/src/live packages/backend/src/api/live.js packages/backend/test/live-descriptor.test.mjs packages/backend/test/live-network-session.test.mjs packages/backend/test/live-stream.test.mjs
git commit -m "feat(live): scope events by epoch and seal recordings"
```

---

## Chunk 10: Adversarial Validation, Migration, and Clean Cutover

### Task 21: Build the multi-peer adversarial network harness

**Files:**

- Create: `packages/backend/test/fixtures/p2p-network-harness.mjs`
- Create: `packages/backend/test/adversarial-network.test.mjs`
- Create: `packages/backend/test/entity-graph-integration.test.mjs`
- Create: `packages/backend/test/archive-integration.test.mjs`
- Create: `packages/backend/test/protocol-version-skew.test.mjs`
- Modify: `packages/backend/package.json`

**Acceptance:** deterministic integration tests cover honest and hostile publishers, viewers, archivists, indexers, and moderators without public DHT dependency; failure injection proves isolation and cleanup.

- [ ] **Step 1: Implement in-process isolated swarm fixtures**

Create identities, stores, swarms, time controls, packet delay/drop, disconnect, malformed frame injection, and disk/bandwidth limits. Record resource counts before/after each scenario.

- [ ] **Step 2: Add required adversarial scenarios**

Cover:

- Sybil peers saturating discovery;
- oversized and nested frames;
- replayed announcements, claims, pledges, and challenges;
- publisher fork and revoked writer continuation;
- duplicate/extra/role-invalid root transition signatures and recovery below quorum;
- bogus bootstrap/index authorization-chain digests and stale catalog locators;
- cumulative valid-but-costly catalog pages exhausting per-feed/global budgets;
- purpose/topic mismatch, cross-protocol dispatch, and application/transport key substitution;
- malicious mirror steering;
- false complete-range claims;
- duplicate publications and conflicting entity claims;
- peers disappearing during startup and seek;
- NAT/firewall connection failure;
- mobile background, battery, thermal, and metered transitions;
- disk reservation exhaustion;
- protocol version skew;
- live peers advertising regressed, skipped, not-yet-valid, expired, terminal-closed, or catalog-mismatched epochs, including segment traffic and a later epoch after `ended`/`aborted`;
- local moderation preventing download and seeding;
- source offload attempted from viewer bitfields or voluntary anonymous peers;
- duplicate exact renditions advertised by different publishers sharing one asset swarm without merging provenance;
- shutdown during each lifecycle phase.

- [ ] **Step 3: Run the harness repeatedly**

```bash
npm exec --prefix packages/backend -- brittle test/adversarial-network.test.mjs test/entity-graph-integration.test.mjs test/archive-integration.test.mjs test/protocol-version-skew.test.mjs
```

Run at least three consecutive times with deterministic seeds. Expected: PASS with zero leaked resources.

- [ ] **Step 4: Commit the harness**

```bash
git add packages/backend/test/fixtures/p2p-network-harness.mjs packages/backend/test/adversarial-network.test.mjs packages/backend/test/entity-graph-integration.test.mjs packages/backend/test/archive-integration.test.mjs packages/backend/test/protocol-version-skew.test.mjs packages/backend/package.json
git commit -m "test(p2p): add adversarial multi-peer network coverage"
```

### Task 22: Migrate legacy publications and delete every global-feed surface

**Files:**

- Create: `packages/backend/src/migrations/publication-v1.js`
- Create: `packages/backend/test/publication-v1-migration.test.mjs`
- Create: `packages/backend/test/legacy-global-feed-absence.test.mjs`
- Delete: `packages/backend/src/public-feed.js`
- Delete: `packages/backend/src/canonical-feed.js`
- Delete: `packages/backend/src/canonical-feed-contract.js`
- Delete: `packages/backend/src/feed.js`
- Delete: `packages/backend/src/relay-blind-peer.js`
- Delete: `packages/backend/src/blind-peering-client.js`
- Delete: `packages/backend/src/relay-links.js`
- Delete: `packages/backend/src/api/feed.js`
- Delete: `packages/backend/test/canonical-feed-contract.test.mjs`
- Delete: `packages/backend/test/public-feed-descriptor.test.mjs`
- Delete: `packages/backend/test/public-feed-live.test.mjs`
- Delete: `packages/backend/test/public-feed-manager.test.mjs`
- Delete: `packages/backend/test/public-feed-mirror-discovery.test.mjs`
- Delete: `packages/backend/test/public-feed-signed-ingress.test.mjs`
- Delete: `packages/backend/test/relay-blind-peer.test.mjs`
- Delete: `packages/backend/test/blind-peering-client.test.mjs`
- Delete: `packages/backend/test/relay-links.test.mjs`
- Delete: `packages/app/backend/canonical-feed-contract-rpc.test.mjs`
- Modify: `packages/backend/package.json`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/src/backend-entry.js`
- Modify: `packages/backend/src/content-publication.js`
- Modify: `packages/backend/src/runtime.js`
- Modify: `packages/backend/src/universal-core.js`
- Modify: `packages/backend/src/search/federated-search.js`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/storage.js`
- Modify: `packages/backend/src/types.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/api/live.js`
- Modify: `packages/backend/src/api/status.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/test/content-publication.test.mjs`
- Modify: `packages/backend/test/public-channel-bee-security.test.mjs`
- Modify: `packages/backend/test/fixtures/seed-pin-smoke.mjs`
- Modify: `packages/backend/test/mobile-handlers.test.mjs`
- Modify: `packages/backend/test/holepunch-major-migration.test.mjs`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs`
- Regenerate: `packages/spec/spec/**`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/create-client.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/platform/test/rpc.shared.test.mjs`
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/app/backend/index.mjs`
- Modify: `packages/app/workers/desktop/index.ts`
- Modify: `packages/app/app/_layout.tsx`
- Modify: `packages/app/app/(tabs)/index.tsx`
- Modify: `packages/app/app/(tabs)/index.web.tsx`
- Modify: `packages/app/app/(tabs)/discover.tsx`
- Modify: `packages/app/components/native-diagnostics/DiagnosticsPanel.native.tsx`
- Modify: `packages/app/components/native-diagnostics/types.ts`
- Modify: `packages/app/lib/feed-hydration.js`
- Modify: `packages/app/lib/feed-snapshot-storage.ts`
- Modify: `packages/app/lib/store/appStore.tsx`
- Modify: `packages/app/tests/native-backend-startup-regression.test.mjs`
- Modify: `packages/app/tests/vertical-discovery-regression.test.mjs`
- Modify: `packages/app/tests/desktop-preview-regression.test.mjs`

**Acceptance:** existing local videos and retained legacy snapshots migrate idempotently into attributed immutable publications/claims without invented entity truth; app home/discovery consume the new local media graph plus explicit publisher/index subscriptions; the global `peartube-network` data plane, `c.json` channel, legacy PublicFeed/PublicBee RPCs, unsigned `relayMirrorKey`, blind-peer auto-adoption, old cache timers, old diagnostics fields, compatibility fallbacks, exports, and generic replication are absent from every production package; generated clients and both native/desktop startup paths contain no dangling legacy callsites.

- [ ] **Step 1: Write failing migration tests**

Migrate local owner channels, public-feed cache entries, canonical snapshots, structured source metadata, thumbnails, blob references, partial content, and deleted metadata. Preserve publisher/source provenance and import unsupported records as bounded attributed legacy publications. Repeat after crashes at each checkpoint and assert stable IDs/no duplicates. Never infer abstract work, agent, or collection equivalence without evidence.

- [ ] **Step 2: Write repository-wide source-absence and replacement tests**

Scan production source under `packages/backend/src`, `packages/app`, `packages/core/src`, `packages/spec`, `packages/host/src`, and `packages/platform/src`. Reject legacy protocol/RPC/event/cache identifiers, imports/exports, global topic derivation, JSON peer frames, `relayMirrorKey`, automatic blind-peer adoption, and generic `store.replicate(conn)` on discovery connections. Explicitly test mobile startup, desktop worker, app backend cache lifecycle, generated clients, home/discover routes, diagnostics, and store types. Assert their replacements use publisher/index subscriptions, media-graph pagination, scoped status fields, and purpose-bound sessions—no alias or fallback.

- [ ] **Step 3: Run cutover failures**

```bash
npm exec --prefix packages/backend -- brittle test/publication-v1-migration.test.mjs test/legacy-global-feed-absence.test.mjs test/holepunch-major-migration.test.mjs
npm test --prefix packages/spec
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs packages/app/tests/desktop-preview-regression.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement migration and clean deletion**

Run migration before scoped discovery starts. Replace app feed snapshots with the local graph/index state built in prior tasks, update UI/store/diagnostics terminology and calls, remove schema methods and regenerate clients, remove backend API/handler branches, remove the `./public-feed`, `./relay-blind-peer`, and `./feed` package exports, and delete legacy registration, persistence, relay adoption, timers, events, and modules. Do not leave a dual-write, alias, renderer fallback, dangling package entrypoint, dead test fixture, or old generated codec.

- [ ] **Step 5: Run focused and full verification**

```bash
npm run schema:full
npm exec --prefix packages/backend -- brittle test/publication-v1-migration.test.mjs test/legacy-global-feed-absence.test.mjs test/adversarial-network.test.mjs test/entity-graph-integration.test.mjs test/archive-integration.test.mjs test/holepunch-major-migration.test.mjs
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 6: Perform end-to-end product smoke checks**

Verify on desktop and one physical mobile platform:

1. create/import and unlock a shell-custodied publisher identity;
2. publish one standalone video;
3. publish a partial season and album;
4. discover through explicit publisher/index feeds;
5. resolve duplicate media and creator contributions from another publisher;
6. stream with two peers, then from complete local cache with no peers;
7. observe structured unavailability for a missing range with no peer;
8. archive and answer a possession challenge;
9. reject an unconfirmed/stale source-offload request, then complete one fresh confirmed action;
10. apply local agent/publication moderation and confirm blocked media is neither downloaded nor served;
11. restart and verify graph, archive, policy, subscription, and migration state;
12. shut down and reopen the same storage path without lock recovery.

- [ ] **Step 7: Commit clean cutover**

```bash
git add packages/backend/package.json packages/backend/src packages/backend/test packages/spec packages/host packages/platform packages/core/src/types/index.ts packages/app/backend packages/app/workers/desktop/index.ts packages/app/app/_layout.tsx packages/app/app/'(tabs)'/index.tsx packages/app/app/'(tabs)'/index.web.tsx packages/app/app/'(tabs)'/discover.tsx packages/app/components/native-diagnostics packages/app/lib/feed-hydration.js packages/app/lib/feed-snapshot-storage.ts packages/app/lib/store/appStore.tsx packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs packages/app/tests/desktop-preview-regression.test.mjs
git commit -m "refactor(network): delete the global feed data plane"
```

---

## Additional Operability, Recovery, and Abuse-Resistance Work

These items were identified after Tasks 19–22 exposed the core protocol shape. They are required before the design should be treated as product-complete, even if the cryptographic/protocol foundations are already implemented.

### Migration observability

Migration must expose user- and operator-visible state, not only deterministic tests:

- [ ] Show migration states: pending, running, complete, failed, and retrying.
- [ ] Report imported records, skipped records, quarantined records, and unsupported legacy shapes.
- [ ] Preserve machine-readable failure reasons so support/debug tooling can tell “still migrating” from “quarantined” from “gone.”
- [ ] Provide a safe retry path and an exportable migration report without exposing secrets.

### Trust/debug explanation UI

Users need to understand why a media entity/source appears or disappears:

- [ ] Explain which publisher, index feed, moderation feed, and local policy decision introduced each visible source.
- [ ] Show why the selected source won over alternatives and why another source was blocked, stale, incomplete, or deprioritized.
- [ ] Surface claim conflicts, provenance, archive state, local-cache state, and peer/unavailability state in plain language.
- [ ] Keep the explanation local; do not require a global authority to answer “why am I seeing this?”

### Discovery/index spam resistance

Moderation is necessary but not sufficient. Discovery and index ingestion must resist pressure from spam and malformed-but-valid records:

- [ ] Enforce per-index, per-publisher, per-agent, and per-collection ingest/projection budgets.
- [ ] Bound duplicate storms, fork storms, huge collection poisoning, malicious metadata/title/artwork spam, and repeated retractions/renames.
- [ ] Keep reputation or quality signals local heuristics, never global truth.
- [ ] Add adversarial tests for spammy signed-but-unwanted feeds and indexes.

### Key loss, recovery, and revoked-device UX

The publisher root operation model must be understandable and recoverable:

- [ ] Define UX and protocol behavior for lost device, revoked device, rotated root, stale device publishing, and failed halfway legacy import.
- [ ] Show when a device is authorized, stale, revoked, or unable to publish.
- [ ] Define what the user can still do when media exists locally but publisher authority is lost.
- [ ] Test that stale/revoked devices cannot publish after root transition acceptance.

### Backup and export story

A user should be able to rebuild their local view and evidence without trusting an old relay:

- [ ] Export publisher root public history and recovery metadata without private root secrets.
- [ ] Export local graph/index preferences, followed publisher/index feeds, moderation subscriptions, archive/offload evidence, and policy state.
- [ ] Restore those exports on a new device and verify all signatures/checkpoints before use.
- [ ] Document which data is portable, which data is device-local, and which secrets are never exported by default.

### Storage pressure UX

Local-first caching, pinning, archiving, and seeding need understandable disk controls:

- [ ] Show what disk is used by owned originals, immutable publications, pinned/archive commitments, local cache, thumbnails, indexes, and temporary transfer state.
- [ ] Explain what can be evicted safely and what will stop being seeded or become unavailable.
- [ ] Preview the consequence of reducing disk/upload/background limits before applying policy changes.
- [ ] Ensure pledged/archive data is never silently evicted as ordinary cache.

### Versioned protocol deprecation policy

Protocol-major tests exist, but operators and users need a written compatibility story:

- [ ] Define how long old peers/backends are tolerated and what error newer clients show.
- [ ] Make publisher catalogs and index feeds advertise required protocol versions/capabilities.
- [ ] Define mobile bundle behavior when stored backend state was created by an older protocol.
- [ ] Add compatibility/deprecation tests around deleted legacy surfaces so fallback pressure does not reintroduce them.

### Privacy model

The plan must explicitly state what is private, what leaks, and what is not solved yet:

- [ ] Document leakage from followed publishers/indexes, requested assets, catalog fetches, archive challenges, moderation subscriptions, peer IP correlation, and local discovery.
- [ ] Avoid product copy that implies anonymity or privacy the protocol does not provide.
- [ ] Add settings/copy that distinguish local moderation privacy from network-visible fetch/seeding behavior.

### Relay/operator model

The design should not assume infinite free archivists or neutral always-on relays:

- [ ] Declare whether the intended model is altruistic pinning, friend/family relays, paid archival operators, community indexes, or local-first only.
- [ ] Ensure the protocol does not require any default trusted relay, default paid operator, or central upload endpoint.
- [ ] Add operator-facing diagnostics for archive pledge health, possession challenge failures, capacity exhaustion, and rejected offload attempts.

### Disaster and chaos tests

Add product-level chaos tests in addition to unit/protocol tests:

- [ ] Kill the app mid-upload, mid-migration, mid-offload confirmation, and mid-live sealing.
- [ ] Delete half the blobs, restart, and verify structured unavailability without corrupting graph state.
- [ ] Serve stale catalogs, equivocated indexes, and changed moderation feeds during active download.
- [ ] Rotate publisher roots while peers hold old catalogs.
- [ ] Jump clocks forward/backward around live epochs, archive pledges, moderation expiry, and offload confirmation tokens.
- [ ] Let the mobile OS kill the backend during migration/offload/live paths and verify recovery.

### Anti-centralization regression guards

Source-absence tests should cover the design goal, not only old symbol names:

- [ ] Reject hardcoded relay keys, mandatory/default trusted indexes, irreplaceable moderation authorities, default upload endpoints, and remote bootstrap services capable of serving media bytes. A bundled community moderation profile may be the replaceable local visibility default, but it cannot delete records, confer network authority, become the only readable policy, or be required for discovery/playback protocol validity.
- [ ] Reject env-var-only production trust roots and hidden central service dependencies.
- [ ] Verify bootstrap/discovery can introduce candidates but cannot become a media origin or trust authority.

## Completion Criteria

The program is complete only when all of the following are observed:

- A publisher releases original and playback renditions as one signed immutable publication.
- Work, Recording/Edition, Publication, Asset Rendition, Collection, Agent, and Publisher identities remain distinct in storage, protocol, API, and UI.
- Single- and multi-signer record IDs are non-circular; root rotation/recovery signatures cover one signer-independent transition ID and satisfy exact role/quorum rules.
- Publisher roots are shell-custodied: the backend receives only bounded prepared-record signatures, never a root secret/export, and the one-time legacy import is authenticated, crash-safe, and permanently disabled after success.
- Unrelated publishers contribute partial members to one locally resolved collection.
- Duplicate publications render as alternate sources without losing provenance.
- Bootstrap and index locators cannot open media or generic Corestore replication and cannot become trusted until the stable publisher catalog validates root transitions and device authorization.
- Publisher catalogs and asset delivery use separate bounded protocols and topics.
- Multi-peer delivery preserves complete local/cache playback, improves or preserves startup/seek behavior when peers exist, and fails missing ranges promptly without an implicit origin.
- Live event/epoch chains reject unauthorized writers, regressions, gaps, invalid validity windows, catalog mismatch, and traffic after `ended`/`aborted`; valid stop seals a fully verified chain into ordinary immutable publications.
- Every network path enforces negotiated per-frame and cumulative disk, upload, peer, request, verification, projection, and in-flight-byte limits before expensive work.
- Archivists publish voluntary pledges and answer possession challenges.
- Source offload rejects all viewer/anonymous availability evidence, never happens in the background, and requires explicit per-publication action plus a publisher-controlled or intentionally operated archival copy.
- Offload authorization binds a short-lived, single-use confirmation token to the exact publisher, publication, rendition set, evidence snapshot/digest, policy epoch, action, and expiry; replay, stale evidence, and UI-only acknowledgement fail.
- Index, curator, and moderation feeds remain optional and client-selected; agent moderation propagates only through accepted contribution roles chosen by local policy.
- AI annotations remain derived claims and do not mutate publisher records.
- Desktop and mobile display coherent cross-publisher shows, seasons, albums, creators, and collections.
- Default mobile/desktop policy performs no involuntary background upload, archive retention, metered transfer, or thermal-pressure work.
- The global `peartube-network` data plane, JSON feed frames, unsigned mirror steering, and unrestricted replication are absent from production code.
- Legacy migration is deterministic, idempotent, crash-resumable, provenance-preserving, and never invents work/agent/collection equivalence.
- Repository-wide source-absence checks prove that legacy global-feed modules, RPCs, events, cache timers, generated codecs, UI fallbacks, diagnostics, exports, and callsites are gone from backend, app, core, spec, host, and platform production source.
- Focused, full, adversarial, desktop, and physical-mobile checks pass with no leaked resources.
