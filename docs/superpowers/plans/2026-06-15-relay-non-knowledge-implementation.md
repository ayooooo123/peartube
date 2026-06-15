# Relay Non-Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PearTube relays credible non-knowledge conduits by removing relay-authored plaintext evidence first, then forwarding owner-signed metadata, then adding opaque relay admission and source-side encryption/key distribution.

**Architecture:** Relay byte propagation becomes an opaque-core system: relays admit and gossip `coreKey`/`discoveryKey` refs under local resource policy, while viewers get decryption keys only from share links, pairing, or gated key holders. Public-browsable metadata and blind/key-gated content are treated as different node tiers because a node's deniability collapses to the weakest content it serves.

**Tech Stack:** Hypercore/Corestore/Hyperblobs, blind-peer, Hyperswarm/Protomux, HRPC schema generation, sodium-universal, existing PearTube public-feed descriptors and CLI relay service.

---

## Guardrails

- Do not propose or implement at-rest disk encryption as the answer.
- Keep `archive` and local mirror flows. They are publisher roles; do not remove or quarantine them.
- Relay-to-relay gossip must carry opaque keys only: `coreKey` and `discoveryKey`, plus non-content operational hints.
- Do not add `pear run` or `global.Pear.run` paths.
- Do not add panic-wipe or raid-triggered deletion behavior.
- Treat byte distribution and key distribution as separate systems.
- Network/IP anonymity is out of scope for v1 and must remain an honest limit.

## File Map

### Lever 1: Stop Manufacturing Evidence

- Create: `packages/cli/src/relay-privacy.js`
  - Owns relay inventory redaction, local salted owner/source buckets, and status/runtime sanitizers.
- Modify: `packages/cli/src/catalog.js`
  - Persist only opaque relay operational fields.
- Modify: `packages/cli/src/status.js`
  - Remove plaintext `channels`, `ownerKey`, per-video availability lists, titles, and previews from `relay-status.json`.
- Modify: `packages/cli/src/cache-manager.js`
  - Stop persisting `previewVideos` in `cache-channels`; keep only opaque core/channel keys and operational counters.
- Modify: `packages/cli/src/seeding.js`
  - Keep per-video availability detail in memory only; return aggregate counts to status/gossip callers.
- Modify: `packages/cli/src/runtime.js`
  - Stop relay-authored `relayServing: true`, `channelName`, and `previewVideos` in relay catalog submissions.
- Modify: `packages/cli/src/service.js`
  - Store sanitized catalog records and keep archive publisher metadata scoped to archive flows.
- Test: `packages/cli/test/relay-privacy.test.mjs`
- Test: `packages/cli/test/service.test.mjs`
- Test: `packages/cli/test/status.test.mjs`
- Test: `packages/cli/test/relay-seeding.test.mjs`
- Test: `packages/cli/test/runtime-no-relay-catalog.test.mjs`

### Lever 2: Owner-Signed Metadata Forwarding

- Modify: `packages/backend/src/public-feed.js`
  - Forward owner-signed descriptors without relay-authored serving claims.
- Modify: `packages/backend/src/channel-descriptor.js`
  - Add opaque descriptor fields if they belong at the channel-root level; otherwise leave root descriptors unchanged and add video descriptors in the schema phase.
- Modify: `packages/backend/src/api.js`
  - Ensure `getChannelSignedDescriptor()` remains local-only and descriptor-verified.
- Test: `packages/backend/test/public-feed-manager.test.mjs`
- Test: `packages/backend/test/public-feed-descriptor.test.mjs`
- Test: `packages/backend/test/public-feed-signed-ingress.test.mjs`

### Opaque Relay Admission and Disk Policy

- Modify: `packages/spec/schema.cjs`
  - Add canonical messages for relay core refs, registration, gossip, admission result, key requests, and key responses.
- Generated: `packages/spec/spec/**`
- Generated: `packages/desktop-native/Sources/Support/GeneratedSchema.swift`
- Generated: `packages/desktop-native/Sources/Support/GeneratedHRPC.swift`
- Create: `packages/backend/src/relay-admission.js`
  - Owns source gates, per-source caps, storage reservations, sanity checks, and archiver state transitions.
- Create: `packages/backend/src/relay-core-gossip.js`
  - Owns Protomux relay-to-relay opaque-core gossip.
- Modify: `packages/backend/src/relay-blind-peer.js`
  - Integrate admission decisions before `addCore()`/`download()`, expose cache vs archiver behavior, use `trustedPubKeys`.
- Modify: `packages/cli/src/config.js`
  - Add explicit cache/archiver budgets and trusted relay key config.
- Test: `packages/backend/test/relay-admission.test.mjs`
- Test: `packages/backend/test/relay-core-gossip.test.mjs`
- Test: `packages/backend/test/relay-blind-peer.test.mjs`
- Test: `packages/backend/test/gossip-relay-core.test.mjs`
- Test: `packages/backend/test/mirror-relay-core.test.mjs`
- Test: `packages/cli/test/config.test.mjs`

### Source-Side Encryption and Key Distribution

- Create: `packages/backend/src/content/content-crypto.js`
  - Derive `CMK`, `K_video`, key commitments, and key-gossip access proofs.
- Modify: `packages/backend/src/channel/multi-writer-channel.js`
  - Add per-video encrypted media cores under `_openBlobs()`/new helper while preserving legacy shared blob cores.
- Modify: `packages/backend/src/upload.js`
  - Write private uploads to per-video encrypted media cores and store owner-signed encrypted video descriptors.
- Modify: `packages/cli/src/archive/publisher.js`
  - Encrypt archived bodies for downstream relays while preserving publisher metadata for the archiving operator's channel.
- Modify: `packages/cli/src/archive-manager.js`
  - Pass archive import options through the encrypted upload path.
- Modify: `packages/backend/src/api.js`
  - Resolve encrypted playback with caller-provided `K_video` or locally held `CMK`; reject mismatched commitments.
- Modify: `packages/backend/src/mobile-handlers.js`
  - Add mobile request/response fields for encrypted playback keys without routing keys through relays.
- Create: `packages/backend/src/key-gossip.js`
  - Optional Protomux key-request transport gated by proof of channel secret.
- Test: `packages/backend/test/content-crypto.test.mjs`
- Test: `packages/backend/test/encrypted-video-core.test.mjs`
- Test: `packages/backend/test/key-gossip.test.mjs`
- Test: `packages/backend/test/playback-api.test.mjs`
- Test: `packages/backend/test/upload-playback-support.test.mjs`
- Test: `packages/cli/test/archive.test.mjs`

## Phase 1: Lever 1 - Stop Persisting and Gossiping Plaintext Relay Evidence

### Task 1: Add Relay Privacy Sanitizers

**Files:**
- Create: `packages/cli/src/relay-privacy.js`
- Test: `packages/cli/test/relay-privacy.test.mjs`

- [ ] **Step 1: Write failing sanitizer tests**

Add tests that prove plaintext fields are removed and owner/source identity is bucketed:

```js
import test from 'brittle'
import {
  sanitizeRelayCatalogRecord,
  sanitizeRelayStatusChannels,
  sanitizeRelayRuntimeStats,
  sanitizeRelayFeedEntry
} from '../src/relay-privacy.js'

test('relay privacy sanitizer strips names previews and raw owner keys', (t) => {
  const salt = Buffer.alloc(32, 7)
  const input = {
    channelKey: 'aa'.repeat(32),
    driveKey: 'aa'.repeat(32),
    publicBeeKey: 'bb'.repeat(32),
    ownerKey: 'cc'.repeat(32),
    channelName: 'Readable Channel',
    previewVideos: [{ id: 'v1', title: 'Readable Video', blobId: '0:1:0:1', blobsCoreKey: 'dd'.repeat(32) }],
    unavailableVideos: [{ id: 'v2', title: 'Missing Video' }],
    retentionClass: 'discovery',
    bytes: 1234,
    relayServing: true
  }

  const out = sanitizeRelayCatalogRecord(input, { salt })
  t.is(out.channelKey, 'aa'.repeat(32))
  t.is(out.publicBeeKey, 'bb'.repeat(32))
  t.absent(out.ownerKey)
  t.absent(out.channelName)
  t.absent(out.previewVideos)
  t.absent(out.unavailableVideos)
  t.absent(out.relayServing)
  t.ok(out.ownerBucket)
  t.is(out.bytes, 1234)
})

test('relay feed sanitizer never emits relay-authored serving metadata', (t) => {
  const out = sanitizeRelayFeedEntry({
    driveKey: 'aa'.repeat(32),
    publicBeeKey: 'bb'.repeat(32),
    channelName: 'Readable Channel',
    relayServing: true,
    previewVideos: [{ id: 'v1', title: 'Readable Video' }]
  })

  t.alike(out, {
    schema: 'peartube.relayCatalog',
    catalogVersion: 1,
    driveKey: 'aa'.repeat(32),
    publicBeeKey: 'bb'.repeat(32),
    relayRole: 'cache'
  })
})

test('status sanitizer reports aggregate availability only', (t) => {
  const out = sanitizeRelayRuntimeStats({
    seeding: {
      blobAvailability: {
        playable: 1,
        unavailable: 2,
        unknown: 3,
        videos: [{ id: 'v1', title: 'Readable Video' }]
      }
    }
  })

  t.is(out.seeding.blobAvailability.playable, 1)
  t.is(out.seeding.blobAvailability.unavailable, 2)
  t.is(out.seeding.blobAvailability.unknown, 3)
  t.absent(out.seeding.blobAvailability.videos)
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/cli/test/relay-privacy.test.mjs
```

Expected: fails because `packages/cli/src/relay-privacy.js` does not exist.

- [ ] **Step 3: Implement sanitizer module**

Implement these exports in `packages/cli/src/relay-privacy.js`:
- `normalizeRelayKey(value)`: return lowercase 64-byte hex or `null`.
- `createRelayPrivacySalt({ storagePath, fs })`: load or create a 32-byte relay-local salt under the relay DB path.
- `hashRelayBucket(value, { salt })`: return a deterministic salted bucket string for local rate/accounting use.
- `sanitizeRelayCatalogRecord(record, { salt })`: return the persisted opaque catalog record.
- `sanitizeRelayStatusChannels(channels, { salt })`: return aggregate counts and opaque eviction state only.
- `sanitizeRelayRuntimeStats(stats)`: return runtime stats without per-video availability detail.
- `sanitizeRelayFeedEntry(entry)`: return the relay catalog entry shape allowed to leave the node.

Rules:
- Preserve `channelKey`/`driveKey`, `publicBeeKey`, `source`, `retentionClass`, `relayRole`, byte counters, timestamps, and opaque state.
- Remove `ownerKey`, `channelName`, `previewVideos`, `unavailableVideos`, `videos`, titles, thumbnail fields, and `relayServing`.
- Replace `ownerKey` with `ownerBucket = hashRelayBucket(ownerKey, { salt })` only when owner-level caps still need it.
- Use a relay-local salt stored under the relay DB path. Do not put the salt in the status file.

- [ ] **Step 4: Run sanitizer tests**

Run:

```bash
npx brittle packages/cli/test/relay-privacy.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/relay-privacy.js packages/cli/test/relay-privacy.test.mjs
git commit -m "feat(relay): add privacy sanitizers"
```

### Task 2: Redact Catalog, Status, and Cache Persistence

**Files:**
- Modify: `packages/cli/src/catalog.js`
- Modify: `packages/cli/src/status.js`
- Modify: `packages/cli/src/cache-manager.js`
- Modify: `packages/cli/src/service.js`
- Test: `packages/cli/test/status.test.mjs`
- Test: `packages/cli/test/service.test.mjs`

- [ ] **Step 1: Add failing persistence tests**

Update existing CLI tests so they assert:
- `relay-catalog.json` has no `ownerKey`, `channelName`, `previewVideos`, or `unavailableVideos`.
- `relay-status.json` has no `channels` array and no per-video `blobAvailability.videos`.
- `cache-channels` persists no `previewVideos`.
- Owner limits still work through `ownerBucket`.

Add a regression assertion to the existing "persists catalog and status" service test:

```js
t.absent(catalog.channels['configured-channel'].ownerKey)
t.absent(catalog.channels['configured-channel'].previewVideos)
t.absent(status.channels)
t.absent(status.runtime.seeding.blobAvailability?.videos)
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npx brittle packages/cli/test/status.test.mjs packages/cli/test/service.test.mjs
```

Expected: fails because the current files still persist plaintext inventories.

- [ ] **Step 3: Wire sanitizers into persistence**

Implement these changes:
- `RelayCatalog.open()` creates/loads a local privacy salt.
- `RelayCatalog.upsertChannel()` stores `sanitizeRelayCatalogRecord(record, { salt })`.
- `RelayCatalog.getOwnerCounts()` counts `ownerBucket` rather than raw `ownerKey`.
- `buildRelayStatus()` calls `sanitizeRelayRuntimeStats()` and emits aggregate channel counts, not full channel records.
- `CacheManager._persist()` writes records without `previewVideos`.
- `service.js` keeps archive publisher metadata in archive-specific objects, but relay catalog persistence goes through the sanitizer.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx brittle packages/cli/test/status.test.mjs packages/cli/test/service.test.mjs packages/cli/test/config.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/catalog.js packages/cli/src/status.js packages/cli/src/cache-manager.js packages/cli/src/service.js packages/cli/test/status.test.mjs packages/cli/test/service.test.mjs
git commit -m "fix(relay): redact persisted relay inventories"
```

### Task 3: Stop Relay-Authored Plaintext Feed Claims

**Files:**
- Modify: `packages/cli/src/runtime.js`
- Modify: `packages/cli/src/seeding.js`
- Modify: `packages/backend/src/public-feed.js`
- Test: `packages/cli/test/relay-seeding.test.mjs`
- Test: `packages/cli/test/runtime-no-relay-catalog.test.mjs`
- Test: `packages/backend/test/public-feed-manager.test.mjs`

- [ ] **Step 1: Update tests to describe the new feed shape**

Change relay catalog tests from expecting `relayServing: true` and previews to expecting opaque relay entries:

```js
t.is(entry.schema, 'peartube.relayCatalog')
t.is(entry.relayRole, 'cache')
t.absent(entry.relayServing)
t.absent(entry.channelName)
t.alike(entry.previewVideos || [], [])
```

Update `relay-seeding` tests so seeding still joins public bee/blob core discovery topics, but `stats.catalogEntry` no longer contains title/preview metadata.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npx brittle packages/cli/test/relay-seeding.test.mjs packages/cli/test/runtime-no-relay-catalog.test.mjs
npx brittle packages/backend/test/public-feed-manager.test.mjs
```

Expected: fails because current relay catalog entries still carry previews and serving claims.

- [ ] **Step 3: Sanitize runtime and public-feed submission paths**

Implement these changes:
- `runtime.emitFeedEntries()` must pass only opaque candidate fields needed for byte seeding.
- `runtime.publishRelayCatalogEntry()` must call `sanitizeRelayFeedEntry()` before `publicFeed.submitRelayCatalogEntry()`.
- `seeding.seedChannel()` may inspect videos to join blob-core swarms, but returned `catalogEntry` must not include `channelName`, `previewVideos`, `unavailableVideos`, or `relayServing`.
- `publicFeed.submitRelayCatalogEntry()` must not force `relayServing: true`.
- `publicFeed._serializeEntry()` must not infer `relayServing` for relay-cache entries after this migration.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx brittle packages/cli/test/relay-seeding.test.mjs packages/cli/test/runtime-no-relay-catalog.test.mjs packages/backend/test/public-feed-manager.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime.js packages/cli/src/seeding.js packages/backend/src/public-feed.js packages/cli/test/relay-seeding.test.mjs packages/cli/test/runtime-no-relay-catalog.test.mjs packages/backend/test/public-feed-manager.test.mjs
git commit -m "fix(relay): stop relay-authored plaintext feed claims"
```

## Phase 2: Owner-Signed Metadata Forwarding

### Task 4: Forward Owner-Signed Descriptors Without Relay Claims

**Files:**
- Modify: `packages/backend/src/public-feed.js`
- Modify: `packages/backend/src/api.js`
- Test: `packages/backend/test/public-feed-descriptor.test.mjs`
- Test: `packages/backend/test/public-feed-signed-ingress.test.mjs`

- [ ] **Step 1: Add failing descriptor-forwarding tests**

Add coverage for this behavior:
- Peer entries with valid `signedDescriptor` are accepted and forwarded.
- Relay-cache entries with valid `signedDescriptor` are visible enough for discovery.
- Relay-cache entries do not become published channels and do not gain `relayServing`.
- Invalid descriptor/channel/publicBee mismatches are rejected.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/public-feed-descriptor.test.mjs packages/backend/test/public-feed-signed-ingress.test.mjs packages/backend/test/public-feed-manager.test.mjs
```

Expected: at least one assertion fails until the serializer and visibility filters separate signed metadata from relay serving claims.

- [ ] **Step 3: Implement descriptor-forwarding policy**

Implement:
- `_isVerifiedMetadataEntry(entry)` remains the authority for forwarded owner metadata.
- `_isLocallyBackedEntry(entry)` no longer treats relay-cache as equivalent to local publisher metadata.
- `sendHaveFeed()` includes entries that are local publishers or verified owner descriptors.
- `broadcastSubmitChannel()` includes `signedDescriptor` but strips relay-authored titles/previews for relay-cache entries.

- [ ] **Step 4: Run backend feed tests**

Run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-descriptor.test.mjs packages/backend/test/public-feed-signed-ingress.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/public-feed.js packages/backend/src/api.js packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-descriptor.test.mjs packages/backend/test/public-feed-signed-ingress.test.mjs
git commit -m "feat(feed): forward owner-signed metadata without relay claims"
```

### Task 5: Keep Archive Publisher Metadata Scoped

**Files:**
- Modify: `packages/cli/src/archive/publisher.js`
- Modify: `packages/cli/src/archive-manager.js`
- Modify: `packages/cli/src/service.js`
- Test: `packages/cli/test/archive.test.mjs`
- Test: `packages/cli/test/service.test.mjs`

- [ ] **Step 1: Add archive role regression tests**

Assert:
- Archive publish still emits public publisher metadata through `publicFeed.submitChannel()`.
- Archive publish does not cause relay-cache gossip for unrelated discovered content to include archive metadata.
- Completed archive jobs are stored with `source: 'archive-job'` in local publisher state, but relay conduit status remains redacted.

- [ ] **Step 2: Run tests and confirm failure where current behavior leaks**

Run:

```bash
npx brittle packages/cli/test/archive.test.mjs packages/cli/test/service.test.mjs
```

Expected: any current relay-catalog metadata leakage is visible in assertions.

- [ ] **Step 3: Implement archive separation**

Keep these paths distinct:
- Publisher archive path: named metadata is allowed because the operator chose the content.
- Relay conduit path: only sanitized relay feed entries and opaque operational state.

- [ ] **Step 4: Run CLI relay/archive tests**

Run:

```bash
npm test --prefix packages/cli
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/archive/publisher.js packages/cli/src/archive-manager.js packages/cli/src/service.js packages/cli/test/archive.test.mjs packages/cli/test/service.test.mjs
git commit -m "fix(archive): keep publisher metadata out of relay conduit state"
```

## Phase 3: Opaque Relay Admission and Disk Policy

### Task 6: Add Schema Messages for Relay Core Refs and Key Requests

**Files:**
- Modify: `packages/spec/schema.cjs`
- Generated: `packages/spec/spec/**`
- Generated: `packages/desktop-native/Sources/Support/GeneratedSchema.swift`
- Generated: `packages/desktop-native/Sources/Support/GeneratedHRPC.swift`
- Test: `packages/spec/test/*.test.mjs`

- [ ] **Step 1: Add failing schema tests**

Add tests that require these message names:
- `relay-core-ref`
- `relay-core-register-request`
- `relay-core-register-response`
- `relay-core-gossip-message`
- `key-request`
- `key-response`

- [ ] **Step 2: Run schema tests and confirm failure**

Run:

```bash
npm test --prefix packages/spec
```

Expected: fails because the messages do not exist.

- [ ] **Step 3: Add message definitions**

Add fields matching the design doc:

```js
ns.register({
  name: 'relay-core-ref',
  fields: [
    { name: 'coreKey', type: 'string', required: true },
    { name: 'discoveryKey', type: 'string', required: true },
    { name: 'kind', type: 'string', required: false },
    { name: 'tier', type: 'string', required: false },
    { name: 'byteLengthHint', type: 'uint', required: false },
    { name: 'blockLengthHint', type: 'uint', required: false },
    { name: 'announcedAt', type: 'uint', required: false }
  ]
})
```

Also add request/response wrappers for registration, gossip, key request, and
key response. Keep names stable for generated Swift.

- [ ] **Step 4: Regenerate schema outputs**

Run:

```bash
npm run schema:full
```

Expected: JS schema/HRPC output and Swift generated files update.

- [ ] **Step 5: Run schema tests**

Run:

```bash
npm test --prefix packages/spec
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/spec/schema.cjs packages/spec/spec packages/desktop-native/Sources/Support/GeneratedSchema.swift packages/desktop-native/Sources/Support/GeneratedHRPC.swift packages/spec/test
git commit -m "feat(spec): add opaque relay and key messages"
```

### Task 7: Implement Relay Admission Controller

**Files:**
- Create: `packages/backend/src/relay-admission.js`
- Test: `packages/backend/test/relay-admission.test.mjs`

- [ ] **Step 1: Write failing admission tests**

Cover:
- Reject unknown relay peer when `trustedPubKeys` is configured.
- Reject invalid `coreKey`/`discoveryKey` mismatch.
- Enforce per-source ref and byte caps.
- Reserve archiver bytes before full download.
- Return `storage-full` without calling `addCore()`.
- Allow cache fallback only when requested.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/relay-admission.test.mjs
```

Expected: fails because `relay-admission.js` does not exist.

- [ ] **Step 3: Implement controller**

Export `RelayAdmissionController` from `packages/backend/src/relay-admission.js`
with these methods:
- `constructor({ store, trustedPubKeys, limits, storage, now, logger })`
- `considerRegistration(request, context)`
- `considerRelayGossip(message, context)`
- `stageCore(ref, context)`
- `reserve(ref, context)`
- `markComplete(ref, context)`
- `markStalled(ref, context)`
- `getStats()`

The controller must return structured decisions:

```js
{ accepted: false, reason: 'storage-full', tier: 'archiver' }
{ accepted: true, state: 'admitted', tier: 'cache', refs: [...] }
```

- [ ] **Step 4: Run admission tests**

Run:

```bash
npx brittle packages/backend/test/relay-admission.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/relay-admission.js packages/backend/test/relay-admission.test.mjs
git commit -m "feat(relay): add opaque admission controller"
```

### Task 8: Wire Opaque Gossip and Disk-Bound Archiver Behavior

**Files:**
- Create: `packages/backend/src/relay-core-gossip.js`
- Modify: `packages/backend/src/relay-blind-peer.js`
- Modify: `packages/cli/src/config.js`
- Test: `packages/backend/test/relay-core-gossip.test.mjs`
- Test: `packages/backend/test/relay-blind-peer.test.mjs`
- Test: `packages/backend/test/gossip-relay-core.test.mjs`
- Test: `packages/cli/test/config.test.mjs`

- [ ] **Step 1: Write failing gossip/disk tests**

Assert:
- Relay gossip sends no names, titles, previews, or descriptors.
- Gossip from untrusted relay peer keys is ignored.
- Cache tier can evict/reject under budget.
- Archiver tier refuses new refs when reservation fails and keeps accepted refs.
- `getStats()` exposes aggregate storage/admission state only.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/relay-core-gossip.test.mjs packages/backend/test/relay-blind-peer.test.mjs packages/backend/test/gossip-relay-core.test.mjs
npx brittle packages/cli/test/config.test.mjs
```

Expected: fails until gossip and config exist.

- [ ] **Step 3: Implement Protomux opaque-core gossip**

`relay-core-gossip.js` should:
- Open a named Protomux channel for relay core refs.
- Send and receive `RelayCoreGossipV1`.
- Pass received refs to `RelayAdmissionController.considerRelayGossip()`.
- Re-gossip accepted refs only to trusted relays, with dedupe/backoff.

- [ ] **Step 4: Update blind-peer integration**

`createRelayBlindPeer()` should:
- Keep `trustedPubKeys`.
- Accept an optional `admissionController`.
- Call admission before `addCore()`.
- Support `tier: 'cache'` and `tier: 'archiver'`.
- Only run `core.download({ start: 0, end: -1 })` for admitted archiver refs.
- Report aggregate counts, not content metadata.

- [ ] **Step 5: Run backend and config tests**

Run:

```bash
npx brittle packages/backend/test/relay-core-gossip.test.mjs packages/backend/test/relay-blind-peer.test.mjs packages/backend/test/gossip-relay-core.test.mjs packages/backend/test/mirror-relay-core.test.mjs
npx brittle packages/cli/test/config.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/relay-core-gossip.js packages/backend/src/relay-blind-peer.js packages/cli/src/config.js packages/backend/test/relay-core-gossip.test.mjs packages/backend/test/relay-blind-peer.test.mjs packages/backend/test/gossip-relay-core.test.mjs packages/cli/test/config.test.mjs
git commit -m "feat(relay): add trusted opaque core gossip"
```

## Phase 4: Source-Side Encryption and Key Distribution

### Task 9: Add Content Key Derivation and Commitment Helpers

**Files:**
- Create: `packages/backend/src/content/content-crypto.js`
- Test: `packages/backend/test/content-crypto.test.mjs`

- [ ] **Step 1: Write failing crypto tests**

Cover:
- `deriveVideoKey(cmk, channelId, videoId)` is deterministic.
- Different video ids produce different keys.
- `commitVideoKey(key)` changes when the key changes.
- `makeKeyGossipProof(cmk, request)` verifies only with the same CMK and canonical request.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/content-crypto.test.mjs
```

Expected: fails because the module does not exist.

- [ ] **Step 3: Implement content crypto**

Export these functions from `packages/backend/src/content/content-crypto.js`:
- `generateChannelMasterKey()`
- `toChannelMasterKey(value)`
- `deriveVideoKey(cmk, channelId, videoId)`
- `commitVideoKey(videoKey)`
- `deriveKeyGossipAccessKey(cmk)`
- `makeKeyGossipProof(cmk, request)`
- `verifyKeyGossipProof(cmk, request, proof)`

Use HKDF-SHA256 exactly, because descriptors commit to
`hkdf-sha256/cmk/video-v1`. Implement it with a Bare-compatible HMAC-SHA256
primitive; if a Node-only `crypto.hkdf` path is used for development, add and
pass a Bare compatibility test before landing.

- [ ] **Step 4: Run crypto tests**

Run:

```bash
npx brittle packages/backend/test/content-crypto.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/content/content-crypto.js packages/backend/test/content-crypto.test.mjs
git commit -m "feat(content): derive per-video encryption keys"
```

### Task 10: Write Private Uploads to Per-Video Encrypted Media Cores

**Files:**
- Modify: `packages/backend/src/channel/multi-writer-channel.js`
- Modify: `packages/backend/src/upload.js`
- Modify: `packages/cli/src/archive/publisher.js`
- Modify: `packages/cli/src/archive-manager.js`
- Test: `packages/backend/test/encrypted-video-core.test.mjs`
- Test: `packages/backend/test/upload-playback-support.test.mjs`
- Test: `packages/cli/test/archive.test.mjs`

- [ ] **Step 1: Add failing encrypted-core tests**

Assert:
- A private upload creates a media core with `encryptionKey === K_video`.
- The video metadata stores `keyCommitment`, `mediaCoreKey`, and `mediaDiscoveryKey`.
- A store opened without `K_video` can replicate by key but cannot read plaintext.
- Existing public uploads still use the legacy shared blob core.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/encrypted-video-core.test.mjs packages/backend/test/upload-playback-support.test.mjs
npx brittle packages/cli/test/archive.test.mjs
```

Expected: fails until encrypted media cores are implemented.

- [ ] **Step 3: Implement per-video media core helper**

In `MultiWriterChannel`, add helpers named `openVideoBlobDrive({ videoId,
encryptionKey })` and `putEncryptedVideoBlob({ videoId, data, encryptionKey })`.
`openVideoBlobDrive()` opens a deterministic per-video Hyperblobs core with the
provided Hypercore `encryptionKey`; `putEncryptedVideoBlob()` writes bytes to
that core and returns the same blob-ref shape as `putBlob()`.

Keep `putBlob()` unchanged for public/legacy content.

- [ ] **Step 4: Update upload/archive paths**

Add an upload option such as `{ visibility: 'private' | 'public', channelMasterKey }`.
For private uploads:
- derive `K_video`;
- write media and thumbnail to encrypted per-video cores;
- store signed encrypted descriptor fields;
- register opaque media core refs with relay admission.

For `archive`, derive keys as publisher-owned keys and keep publisher metadata
scoped to the archive channel.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx brittle packages/backend/test/encrypted-video-core.test.mjs packages/backend/test/upload-playback-support.test.mjs packages/backend/test/playback-api.test.mjs
npx brittle packages/cli/test/archive.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/channel/multi-writer-channel.js packages/backend/src/upload.js packages/cli/src/archive/publisher.js packages/cli/src/archive-manager.js packages/backend/test/encrypted-video-core.test.mjs packages/backend/test/upload-playback-support.test.mjs packages/cli/test/archive.test.mjs
git commit -m "feat(content): store private videos in encrypted media cores"
```

### Task 11: Add Playback Key Resolution and Commitment Verification

**Files:**
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/spec/schema.cjs`
- Generated: `packages/spec/spec/**`
- Generated: `packages/desktop-native/Sources/Support/GeneratedSchema.swift`
- Generated: `packages/desktop-native/Sources/Support/GeneratedHRPC.swift`
- Test: `packages/backend/test/playback-api.test.mjs`
- Test: `packages/backend/test/mobile-handlers.test.mjs`

- [ ] **Step 1: Add failing playback tests**

Assert:
- `preparePlayback` accepts `videoKey` for encrypted content.
- `preparePlayback` derives from locally held `CMK` for subscribed channels.
- Wrong keys fail before playback URL creation with `key-commitment-mismatch`.
- Relays never receive or log `videoKey`/`CMK`.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/playback-api.test.mjs packages/backend/test/mobile-handlers.test.mjs
```

Expected: fails until playback accepts and verifies keys.

- [ ] **Step 3: Add schema fields and regenerate**

Add optional request fields where playback currently accepts `blobId` and
`blobsCoreKey`:
- `videoKey`
- `keyCommitment`
- `encryptedDescriptorId`

Run:

```bash
npm run schema:full
```

- [ ] **Step 4: Implement key verification**

Before opening an encrypted core:
- load the owner-signed encrypted descriptor;
- compute `commitVideoKey(videoKey)`;
- reject mismatches;
- pass `encryptionKey: videoKey` into the store/core open path.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx brittle packages/backend/test/playback-api.test.mjs packages/backend/test/mobile-handlers.test.mjs
npm test --prefix packages/spec
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/api.js packages/backend/src/mobile-handlers.js packages/spec/schema.cjs packages/spec/spec packages/desktop-native/Sources/Support/GeneratedSchema.swift packages/desktop-native/Sources/Support/GeneratedHRPC.swift packages/backend/test/playback-api.test.mjs packages/backend/test/mobile-handlers.test.mjs
git commit -m "feat(playback): verify encrypted video keys"
```

### Task 12: Add Optional Gated Key-Gossip Transport

**Files:**
- Create: `packages/backend/src/key-gossip.js`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/api.js`
- Test: `packages/backend/test/key-gossip.test.mjs`

- [ ] **Step 1: Write failing key-gossip tests**

Cover:
- Open requests without proof get no response.
- Proof made from the wrong CMK gets no response.
- Valid proof returns `K_video` encrypted to the requester's ephemeral key.
- Share-link-only viewers with `K_video` but no CMK cannot answer general key
  requests.
- Requester rejects a response if `hash(K_video)` does not match the descriptor commitment.
- Relay-only runtime with no CMK cannot answer.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/backend/test/key-gossip.test.mjs
```

Expected: fails because `key-gossip.js` does not exist.

- [ ] **Step 3: Implement Protomux key channel**

`key-gossip.js` should export `KeyGossipService` with:
- `constructor({ swarm, getChannelMasterKey, getVideoDescriptor, logger })`
- `handleConnection(conn, info)`
- `requestKey(request)`
- `close()`

The service must treat proof verification as the gate and descriptor
`keyCommitment` as poisoning defense. It must not accept open "anyone reply"
requests.

- [ ] **Step 4: Wire only where key material exists**

In `orchestrator.js`, start `KeyGossipService` only when the runtime has local
owner/subscriber secrets. Relay-only runtimes must not instantiate it with a
secretless fallback.

- [ ] **Step 5: Run key tests**

Run:

```bash
npx brittle packages/backend/test/key-gossip.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/key-gossip.js packages/backend/src/orchestrator.js packages/backend/src/api.js packages/backend/test/key-gossip.test.mjs
git commit -m "feat(keys): add gated key gossip transport"
```

### Task 13: Add Opt-In Always-On Key-Holder Role

**Files:**
- Modify: `packages/cli/src/config.js`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/api.js`
- Test: `packages/cli/test/config.test.mjs`
- Test: `packages/backend/test/key-gossip.test.mjs`

- [ ] **Step 1: Add role tests**

Assert:
- Default relay config is keyless.
- `nodeRole: 'key-holder'` requires explicit secret material.
- Co-hosted relay+key-holder status reports the deniability trade-off.
- Key-holder can answer gated key requests; blind relay cannot.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/cli/test/config.test.mjs packages/backend/test/key-gossip.test.mjs
```

Expected: fails until role config exists.

- [ ] **Step 3: Implement explicit role**

Add config:

```js
keyHolder: {
  enabled: false,
  channels: [],
  statusWarning: 'holds-decryption-keys-for-configured-channels'
}
```

Never enable it implicitly from relay mode. It should be an owner/trusted
subscriber availability feature, not part of blind relay mode.

- [ ] **Step 4: Run role tests**

Run:

```bash
npx brittle packages/cli/test/config.test.mjs packages/backend/test/key-gossip.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.js packages/backend/src/orchestrator.js packages/backend/src/api.js packages/cli/test/config.test.mjs packages/backend/test/key-gossip.test.mjs
git commit -m "feat(keys): add explicit key holder role"
```

## Phase 5: Verification and Migration

### Task 14: Add Migration Cleanup and Operator-Facing Status

**Files:**
- Modify: `packages/cli/src/catalog.js`
- Modify: `packages/cli/src/status.js`
- Modify: `packages/cli/src/service.js`
- Test: `packages/cli/test/service.test.mjs`
- Test: `packages/cli/test/status.test.mjs`

- [ ] **Step 1: Add migration tests**

Create fixtures for old `relay-catalog.json`, old `relay-status.json`, and old
`cache-channels` with plaintext previews. Assert startup rewrites/suppresses
new plaintext output and reports:

```js
privacyMigration: {
  redactedCatalogEntries: 1,
  droppedPreviewInventories: 1,
  historicalPlaintextExposure: true
}
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npx brittle packages/cli/test/service.test.mjs packages/cli/test/status.test.mjs
```

Expected: fails until migration reporting exists.

- [ ] **Step 3: Implement migration reporting**

On relay startup:
- Load old records.
- Write only sanitized records.
- Do not panic-delete data.
- Report historical exposure honestly in status.

- [ ] **Step 4: Run full focused suite**

Run:

```bash
npm test --prefix packages/cli
npm test --prefix packages/backend
npm test --prefix packages/spec
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/catalog.js packages/cli/src/status.js packages/cli/src/service.js packages/cli/test/service.test.mjs packages/cli/test/status.test.mjs
git commit -m "fix(relay): migrate plaintext relay inventories"
```

## Final Review Checklist

- [ ] `rg -n "relayServing: true|channelName|previewVideos" packages/cli/src packages/backend/src/public-feed.js` shows no relay-authored conduit path that emits plaintext metadata for other people's content.
- [ ] `rg -n "ownerKey|previewVideos|unavailableVideos" packages/cli/src/catalog.js packages/cli/src/status.js packages/cli/src/cache-manager.js` shows no durable plaintext relay inventory fields.
- [ ] Relay-to-relay gossip tests prove only `coreKey` and `discoveryKey` are sent.
- [ ] Key-gossip tests prove open unauthenticated requests get no key.
- [ ] Playback tests prove fetched keys are checked against owner-signed `keyCommitment`.
- [ ] Docs still state the honest limits: network attribution remains, no panic wipe, no v1 onion/mixnet anonymity, no revocation after key disclosure.
