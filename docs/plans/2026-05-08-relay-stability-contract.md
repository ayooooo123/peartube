# Relay Stability Contract Implementation Plan

> **For Hermes:** Use this plan as the guardrail for the relay architecture pass. Do not stack one-off UI fixes unless a regression proves the contract is incomplete.

**Goal:** Make the relay a deterministic bootstrap/cache-serving node again: advertise a stable catalog, retain content-core discovery, and let light clients play preview-backed videos without full channel hydration.

**Architecture:** Keep the single canonical `peartube-network` Hyperswarm topic and Protomux feed channel. Add a first-class relay catalog contract on top of the existing public-feed snapshot mechanism, and restore the old v0.1.34-era behavior where known cached/seeded content expands into long-lived PublicBee/blob/thumbnail discovery joins.

**Tech Stack:** Node/Bare-compatible JS, Hyperswarm, Hypercore/Corestore, Hyperbee/PublicBee, Protomux, brittle/node:test.

---

## Root Cause

Earlier PearTube relays were boring because cached channels were expanded directly into active discovery handles for PublicBee/video/thumbnail cores. Current releases still retain some of that in CLI seeding, but the client path became layered: public feed entries → preview hydration → PublicBee reads → channel load fallback → playback. That made relay/cache availability depend on timing-sensitive channel hydration and UI preservation.

The structural fix is not to revive legacy topics. It is to make relay availability explicit and local-first:

1. A relay catalog entry is a stable serving contract, not a user-published channel.
2. Known cached/seeded content must retain discovery for public metadata and blob cores on startup.
3. Feed/list/playback APIs must prefer catalog/preview direct refs over `loadChannel()` for light-client playback.
4. Status/tests must fail when the relay has cached videos but is not advertising/serving their cores.

---

## Task 1: Backend content discovery retention helper

**Objective:** Restore the old simple seeding behavior as a shared backend primitive.

**Files:**
- Modify: `packages/backend/src/storage.js`
- Test: `packages/backend/test/storage-startup-regression.test.mjs`

**Implementation:**

Add `retainPublicBeeContentDiscovery(ctx, publicBeeKeyHex, options = {})` near `retainSwarmDiscovery()`.

Contract:
- validate 64-hex `publicBeeKeyHex`;
- call `loadPublicBee(ctx, publicBeeKeyHex)` so PublicBee discovery is retained by the existing loader;
- list videos best-effort;
- collect valid `blobsCoreKey` and `thumbnailBlobsCoreKey`;
- open each core through `ctx.store.get(b4a.from(key, 'hex'))` and `await core.ready()`;
- call `retainSwarmDiscovery(ctx, core.discoveryKey, { label })`;
- do not block on swarm flush or core update;
- return stats `{ publicBeeKey, videos, blobCores, thumbnailBlobCores, discoveryHandles, retained, errors, lastError }`.

**Regression:** source-level test should assert the helper exists, calls `loadPublicBee`, iterates `blobsCoreKey` and `thumbnailBlobsCoreKey`, and uses `retainSwarmDiscovery`.

---

## Task 2: Make app/backend seed metadata restartable

**Objective:** Persist enough seed metadata that clients can re-announce content cores after restart without waiting for channel hydration.

**Files:**
- Modify: `packages/backend/src/seeding.js`
- Modify: `packages/backend/src/api.js`
- Test: `packages/backend/test/playback-api.test.mjs` or `packages/backend/test/public-feed-api.test.mjs`

**Implementation:**

Extend `SeedingManager.addSeed(driveKey, videoPath, metadata = {})` to accept and persist optional:
- `publicBeeKey`
- `blobId`
- `blobsCoreKey`
- `thumbnailBlobId`
- `thumbnailBlobsCoreKey`
- `mimeType`
- `thumbnailMimeType`

Patch `api.prefetchVideo()` so when it registers a seed it passes the above fields from the resolved video metadata/publicBeeKey.

**Regression:** add a test that `prefetchVideo()` calls `seedingManager.addSeed()` with `blobsCoreKey`, `blobId`, and `publicBeeKey` when video metadata contains direct refs.

---

## Task 3: App/backend startup expands known seeds/pins into content discovery

**Objective:** Normal clients should regain the old “cached content advertises itself” behavior, not just CLI relays.

**Files:**
- Modify: `packages/backend/src/orchestrator.js`
- Test: `packages/backend/test/orchestrator-seed-mismatch.test.mjs` or new source-level regression

**Implementation:**

In deferred warmup after subscriptions/pins/seeds are loaded:
- for every persisted seed with direct `blobsCoreKey`, retain that blob core discovery immediately;
- for every seed/pin/subscription with a `publicBeeKey`, call `retainPublicBeeContentDiscovery()` in a bounded background queue;
- if only driveKey exists, keep existing `loadChannel()` warmup as fallback but do not make it the only content-serving path.

**Regression:** assert orchestrator imports/calls `retainPublicBeeContentDiscovery` and uses direct seed `blobsCoreKey` before channel fallback.

---

## Task 4: First-class relay catalog entries in PublicFeedManager

**Objective:** Stop conflating relay cache inventory with user-published channels.

**Files:**
- Modify: `packages/backend/src/public-feed.js`
- Test: `packages/backend/test/public-feed-manager.test.mjs`

**Implementation:**

Add catalog fields to serialized/restored entries:
- `schema: 'peartube.relayCatalog'`
- `catalogVersion: 1`
- `relayRole: 'publisher' | 'cache' | 'mirror'`
- `relayServing: boolean`
- `lastSeenAt`
- `previewVideosHash`

Add `submitRelayCatalogEntry(entry)`:
- normalizes `driveKey`, `publicBeeKey`, preview videos, and relay fields;
- stores entry with `source: 'relay-cache'`, `relayRole: 'cache'`, `relayServing: true`;
- persists to a catalog key such as `public-feed-relay-catalog-v1`;
- broadcasts over the existing Protomux feed channel;
- does **not** add to `publishedChannels`.

Update `getFeed()` visibility so relay-serving entries with valid `publicBeeKey` or playable direct preview refs remain visible at `peerCount: 0`.

**Regressions:**
- relay catalog submission does not add to `publishedChannels`;
- `HAVE_FEED` preserves relay catalog fields;
- restore from catalog persistence preserves preview direct refs;
- relay-cache entries remain visible at zero live peer count.

---

## Task 5: Relay runtime uses catalog contract

**Objective:** Relay startup should advertise cached inventory as relay-serving catalog entries before first gossip.

**Files:**
- Modify: `packages/cli/src/runtime.js`
- Modify: `packages/cli/src/cache-manager.js` if needed
- Modify: `packages/cli/src/seeding.js`
- Test: `packages/cli/test/runtime.test.mjs`
- Test: `packages/cli/test/relay-seeding.test.mjs`

**Implementation:**

Reorder relay startup:
1. init cache manager;
2. create API;
3. install `setAvailabilityHintProvider` and `setFeedSnapshotProvider`;
4. start public feed;
5. restore cached channels as `submitRelayCatalogEntry()` instead of `submitChannel()`;
6. seed each cached channel and update catalog snapshots from seeder/API metadata.

Patch `emitFeedEntries()` to emit `source: 'relay-cache'`, `relayServing`, and `previewVideos` for relay catalog entries.

Patch seeder to return a `catalogEntry` snapshot with preview direct refs where available.

**Regressions:**
- runtime registers providers before `publicFeed.start()`;
- cached channels use `submitRelayCatalogEntry`, not `submitChannel`;
- seeder returns catalogEntry with direct refs and seeding stats.

---

## Task 6: API uses relay catalog previews before channel hydration

**Objective:** Light clients must not need full channel `loadChannel()` to list/play feed-preview-backed relay videos.

**Files:**
- Modify: `packages/backend/src/api.js`
- Test: `packages/backend/test/public-feed-api.test.mjs`
- Test: `packages/backend/test/playback-api.test.mjs`

**Implementation:**

Add helpers inside `createApi()`:
- `getPublicFeedEntry(driveKey)`
- `normalizeVideoId(value)`
- `getPreviewVideoFromFeed(driveKey, videoId)`
- `previewVideosFromFeedEntry(driveKey)`

Patch:
- `listVideos()`: if PublicBee is empty/fails and feed entry has preview direct refs, return preview videos and do not call `loadChannel()`.
- `getVideoData()`: after direct request refs and PublicBee miss/fail, use feed preview direct refs before `loadChannel()`.
- `getFeedSnapshotEntries()`: preserve existing preview refs if local enrichment fails.
- `getPublicFeed()`: expose relay catalog fields.

**Regressions:**
- PublicBee empty + relay preview returns videos with `channelKey`/`publicBeeKey` and `channelLoads === 0`.
- PublicBee failure + relay preview returns videos with `channelLoads === 0`.
- `getVideoData()` resolves preview `blobId`/`blobsCoreKey` with `channelLoads === 0`.
- `preparePlayback()`/`getVideoUrl()` can use that direct metadata path.

---

## Verification

Run targeted tests first:

```bash
node --test packages/backend/test/storage-startup-regression.test.mjs
node --test packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-api.test.mjs packages/backend/test/playback-api.test.mjs
npm test --prefix packages/cli -- --timeout=30000
npm run lint:changed
git diff --check
```

Then open PR, wait for CI, merge, and cut the next tag release.

---

## Non-goals

- Do not reintroduce `peartube-public-feed-v1`.
- Do not bake relay-specific behavior into UI card components.
- Do not require Google/YouTube credentials or cookies for relay availability.
- Do not make backend readiness depend on P2P/feed sync.
