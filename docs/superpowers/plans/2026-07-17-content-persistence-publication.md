# Content Persistence and Publication State Machine Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist rich TV/movie/creator records and provide a crash-safe private-draft-to-public projection state machine without breaking legacy channels.

**Architecture:** Extend the private and public channel HyperDB schemas with optional structured fields plus dedicated source, artwork, and import-claim collections. Keep record normalization in a focused module, make public projection explicitly filter pending drafts, and expose idempotent publication primitives that later plans can drive from a durable job queue.

**Tech Stack:** Node.js ESM, HyperDB/Hyperschema, Hyperblobs, Corestore, Brittle for new package tests, existing `node:test` regressions

**Spec:** `docs/superpowers/specs/2026-07-17-peartube-add-cli-design.md`

**Depends on:** Nothing. This is implementation plan 1 of 4.

---

## Chunk 1: Schemas and Record Semantics

### Task 1: Add structured channel and public schemas

**Files:**
- Modify: `packages/backend/src/channel/channel-hyperdb-build.cjs:13-80`
- Modify: `packages/backend/src/channel/public-hyperdb-build.cjs`
- Regenerate: `packages/backend/src/channel/channel-hyperdb-spec/**`
- Regenerate: `packages/backend/src/channel/public-hyperdb-spec/**`
- Create: `packages/backend/test/structured-content-codec.test.mjs`

- [ ] **Step 1: Write a failing codec round-trip test**

Create a test that imports both generated message codecs and proves new optional fields survive encoding:

```js
import test from 'brittle'
import { encode as encodePrivate, decode as decodePrivate } from '../src/channel/channel-hyperdb-spec/hyperdb/messages.js'
import { encode as encodePublic, decode as decodePublic } from '../src/channel/public-hyperdb-spec/hyperdb/messages.js'

const video = {
  id: 'episode-1',
  title: 'Pilot',
  contentKind: 'episode',
  sourceProvider: 'tmdb',
  sourceVideoId: '1399:1:1',
  identityUrl: 'https://example.test/pilot',
  sourcePublishedAt: 1212537600000,
  mediaProvider: 'tmdb',
  mediaId: '62085',
  seasonNumber: 1,
  episodeNumber: 1,
  publicationState: 'replicationPending',
  contentFingerprint: 'sha256:abc'
}

test('private and public video codecs retain structured fields', (t) => {
  t.alike(decodePrivate('@peartubeChannel/video', encodePrivate('@peartubeChannel/video', video)), video)
  t.alike(decodePublic('@peartubePublic/video', encodePublic('@peartubePublic/video', video)), video)
})
```

Also cover one `channelSource`, one `channelArtwork`, and one `importClaim` private record.

- [ ] **Step 2: Run the focused test and observe the schema failure**

Run: `npm exec -- brittle test/structured-content-codec.test.mjs` from `packages/backend`

Expected: FAIL because the generated codecs do not retain the new fields/collections.

- [ ] **Step 3: Extend the private builder**

Append optional structured fields to `peartubeChannel.metadata` and `peartubeChannel.video`; never reorder existing fields. Video fields include `importIdentityKey` and `importClaimantId` so replicated claim reconciliation can suppress a losing draft without deleting its media. The public video schema additionally carries optional `canonicalVisibility` and `duplicateOfClaimantId` reconciliation markers, and public metadata carries a stable `canonicalRevision`; these are not publication states.

```js
ns.register({
  name: 'channelSource',
  compact: true,
  fields: [
    { name: 'provider', type: 'string', required: true },
    { name: 'identityKey', type: 'string', required: true },
    { name: 'sourceId', type: 'string' },
    { name: 'identityUrl', type: 'string' },
    { name: 'handle', type: 'string' },
    { name: 'displayName', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'updatedAt', type: 'uint64' }
  ]
})

ns.register({
  name: 'channelArtwork',
  compact: true,
  fields: [
    { name: 'role', type: 'string', required: true },
    { name: 'blobId', type: 'string' },
    { name: 'blobsCoreKey', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'remoteUrl', type: 'string' },
    { name: 'updatedAt', type: 'uint64' }
  ]
})

ns.register({
  name: 'importClaim',
  compact: true,
  fields: [
    { name: 'identityKey', type: 'string', required: true },
    { name: 'claimantId', type: 'string', required: true },
    { name: 'jobId', type: 'string' },
    { name: 'writerKey', type: 'string' },
    { name: 'videoId', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'releasedAt', type: 'uint64' }
  ]
})
```

Register collections and indexes:

```js
ch.collections.register({ name: 'channelSources', schema: '@peartubeChannel/channelSource', key: ['provider', 'identityKey'] })
ch.collections.register({ name: 'channelArtwork', schema: '@peartubeChannel/channelArtwork', key: ['role'] })
ch.collections.register({ name: 'importClaims', schema: '@peartubeChannel/importClaim', key: ['identityKey', 'claimantId'] })
ch.indexes.register({ name: 'claims-by-writer', collection: '@peartubeChannel/importClaims', unique: false, key: ['identityKey', 'writerKey', 'claimantId'] })
ch.indexes.register({ name: 'claims-by-identity', collection: '@peartubeChannel/importClaims', unique: false, key: ['identityKey', 'claimantId'] })
ch.indexes.register({ name: 'videos-by-season-episode', collection: '@peartubeChannel/videos', unique: false, key: ['seasonNumber', 'episodeNumber', 'id'] })
ch.indexes.register({ name: 'videos-by-source', collection: '@peartubeChannel/videos', unique: false, key: ['sourceProvider', 'sourceVideoId', 'id'] })
ch.indexes.register({ name: 'videos-by-kind-published', collection: '@peartubeChannel/videos', unique: false, key: ['contentKind', 'sourcePublishedAt', 'id'] })
```

The public builder gets profile/artwork/source/video fields but not private import claims.

- [ ] **Step 4: Generate both databases**

Run from `packages/backend`:

```bash
node src/channel/channel-hyperdb-build.cjs
node src/channel/public-hyperdb-build.cjs
```

Expected: both commands exit 0 and update generated `hyperschema/` and `hyperdb/` artifacts.

- [ ] **Step 5: Run codec and legacy compatibility tests**

Run:

```bash
npm exec -- brittle test/structured-content-codec.test.mjs test/channel-writer-swarmkey-codec.test.mjs
```

Expected: PASS; the existing writer trailing-field compatibility remains intact.

- [ ] **Step 6: Commit schema generation**

```bash
git add packages/backend/src/channel/channel-hyperdb-build.cjs packages/backend/src/channel/public-hyperdb-build.cjs packages/backend/src/channel/channel-hyperdb-spec packages/backend/src/channel/public-hyperdb-spec packages/backend/test/structured-content-codec.test.mjs
git commit -m "feat(backend): add structured content channel schemas"
```

### Task 2: Centralize structured record normalization

**Files:**
- Create: `packages/backend/src/channel/structured-content.js`
- Create: `packages/backend/test/structured-content.test.mjs`
- Modify: `packages/backend/src/channel/index.js`

- [ ] **Step 1: Write failing normalization and claim-resolution tests**

Cover:

```js
assert.equal(normalizeProfileKind('TV_SHOW'), 'tvShow')
assert.equal(normalizeContentKind('episode'), 'episode')
assert.equal(importIdentityKey({ contentKind: 'episode', sourceProvider: 'tmdb', sourceVideoId: '62085' }), 'tmdb:episode:62085')
assert.equal(importIdentityKey({ contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', seasonNumber: 1, episodeNumber: 1 }), 'tmdb:episode:show:1396:s1:e1')
assert.equal(importIdentityKey({ contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '550' }), 'tmdb:movie:550')
assert.equal(channelSourceIdentityKey({ provider: 'youtube', sourceId: 'UC1', identityUrl: 'https://youtube.com/@changed' }), 'id:UC1')
assert.match(channelSourceIdentityKey({ provider: 'web', identityUrl: 'https://example.test/creator' }), /^url:sha256:/)
const claimant = deriveImportClaimantId('ab'.repeat(32), 'job-7')
assert.equal(claimant, deriveImportClaimantId('ab'.repeat(32), 'job-7'))
assert.notEqual(claimant, deriveImportClaimantId('cd'.repeat(32), 'job-7'))
assert.match(claimant, /^[0-9a-f]{64}$/)
assert.equal(resolveClaimWinner([
  { claimantId: 'b', state: 'reserved' },
  { claimantId: 'a', state: 'reserved' },
  { claimantId: '0', state: 'released' }
]).claimantId, 'a')
```

Reject channel sources with neither stable source ID nor normalized `identityUrl`, negative/non-integer season and episode numbers, invalid publication states, unknown artwork roles, overlong source values, malformed writer keys/job IDs, and timestamps outside safe integer range. Source identity uses `id:<sourceId>` whenever present; otherwise `url:sha256:<digest(identityUrl)>`. The stable provider/source ID takes precedence over URL identity, and raw `fetchUrl`/credentials are never accepted by persistence normalization. Define `claimantId = sha256(domain || writerKey || durableJobId)` with unambiguous encoding; retries of one durable job must derive the same contender.

- [ ] **Step 2: Run the test and verify missing exports**

Run: `npm exec -- brittle test/structured-content.test.mjs` from `packages/backend`

Expected: FAIL with module/export not found.

- [ ] **Step 3: Implement the focused module**

Export constants and pure functions only:

```js
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export const PROFILE_KINDS = new Set(['standard', 'tvShow', 'movie', 'creator'])
export const CONTENT_KINDS = new Set(['episode', 'movie', 'video', 'stream', 'trailer', 'extra'])
export const PUBLICATION_STATES = new Set(['replicationPending', 'durabilityVerified', 'published'])
export const ARTWORK_ROLES = new Set(['avatar', 'poster', 'banner', 'backdrop'])

export function channelSourceIdentityKey({ sourceId, identityUrl }) {
  if (sourceId) return `id:${sourceId}`
  if (identityUrl) return `url:sha256:${b4a.toString(crypto.hash(b4a.from(identityUrl)), 'hex')}`
  throw new Error('channel source requires sourceId or identityUrl')
}

export function deriveImportClaimantId(writerKeyHex, durableJobId) {
  const writerKey = b4a.from(writerKeyHex, 'hex')
  const payload = b4a.concat([
    b4a.from('peartube-import-claim/v1\0'),
    writerKey,
    b4a.from('\0'),
    b4a.from(durableJobId)
  ])
  return b4a.toString(crypto.hash(payload), 'hex')
}

export function resolveClaimWinner(claims = []) {
  return claims
    .filter((claim) => claim?.state !== 'released')
    .sort((a, b) => String(a.claimantId).localeCompare(String(b.claimantId)))[0] || null
}
```

Keep URL canonicalization and file hashing out of this backend module; those belong to plan 4. This module only hashes an already-normalized `identityUrl` for the channel-source fallback key.

- [ ] **Step 4: Export and run tests**

Run: `npm exec -- brittle test/structured-content.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit normalization**

```bash
git add packages/backend/src/channel/structured-content.js packages/backend/src/channel/index.js packages/backend/test/structured-content.test.mjs
git commit -m "feat(backend): normalize structured content records"
```

## Chunk 2: Private Records and Public Projection

### Task 3: Add channel source, artwork, claim, and draft APIs

**Files:**
- Modify: `packages/backend/src/channel/multi-writer-channel.js:324-524`
- Modify: `packages/backend/test/multiwriter-channel-hyperdb.test.mjs`
- Create: `packages/backend/test/import-claims.test.mjs`

- [ ] **Step 1: Write failing channel API tests**

Extend the channel harness to assert:

```js
await channel.putChannelSource({ provider: 'youtube', sourceId: 'UC1', identityUrl: 'https://youtube.com/channel/UC1' })
assert.equal((await channel.listChannelSources())[0].identityKey, 'id:UC1')
await channel.putChannelSource({ provider: 'web', identityUrl: 'https://example.test/creator' })
assert.match((await channel.listChannelSources()).find((source) => source.provider === 'web').identityKey, /^url:sha256:/)

await channel.putChannelArtwork({ role: 'poster', blobId: '1:2:0:20', blobsCoreKey: 'ab'.repeat(32), mimeType: 'image/jpeg' })
assert.equal((await channel.getChannelArtwork('poster')).role, 'poster')

await channel.addVideo({ id: 'draft-1', title: 'Pilot', publicationState: 'replicationPending' }, { syncPublic: false })
assert.equal((await channel.getVideo('draft-1')).publicationState, 'replicationPending')
```

In `import-claims.test.mjs`, assert released claims never win, the lexicographically lowest authenticated claimant wins, a losing draft remains privately readable but is never projectable, and duplicate claims converging after a partition choose the same winner regardless of insertion order. `putImportClaim` must recompute and require `claimantId === deriveImportClaimantId(writerKey, jobId)`; retry/restart of one job upserts the same claim, and a second active job from the same writer for the same import identity cannot grind a lower contender. Add retention tests: default 30 days, configurable duration, no compaction while a job references the claim, and compaction only when a published winner exists or no contender remains.

- [ ] **Step 2: Run tests and verify methods are missing**

Run:

```bash
node --test test/multiwriter-channel-hyperdb.test.mjs
npm exec -- brittle test/import-claims.test.mjs
```

Expected: FAIL on missing methods/options.

- [ ] **Step 3: Add focused collection methods**

Add methods without embedding policy in `MultiWriterChannel`:

```js
async putChannelSource(source) { /* normalize, insert, flush; no implicit public sync */ }
async listChannelSources() { /* update, find collection */ }
async putChannelArtwork(artwork) { /* normalize, insert, flush; no implicit public sync */ }
async getChannelArtwork(role) { /* update, get */ }
async listChannelArtwork() { /* update, find */ }
async putImportClaim(claim) { /* insert + flush */ }
async listImportClaims(identityKey) { /* use claims-by-identity */ }
async resolveImportClaim(identityKey) { /* deterministic non-released winner */ }
async releaseImportClaim(identityKey, claimantId, releasedAt) { /* retain tombstone */ }
async compactReleasedImportClaims({ now, retentionMs, isJobActive }) { /* enforce safe compaction conditions */ }
```

Change mutation signatures to explicit sync control:

```js
async addVideo(meta, { syncPublic = meta?.publicationState !== 'replicationPending' } = {})
async updateVideo(id, updates, { syncPublic = updates?.publicationState !== 'replicationPending' } = {})
```

Never make `syncPublic: false` the default for legacy callers.

- [ ] **Step 4: Run tests**

Run the two focused files. Expected: PASS.

- [ ] **Step 5: Commit private APIs**

```bash
git add packages/backend/src/channel/multi-writer-channel.js packages/backend/test/multiwriter-channel-hyperdb.test.mjs packages/backend/test/import-claims.test.mjs
git commit -m "feat(backend): add structured channel record APIs"
```

### Task 4: Make public projection durability-aware

**Files:**
- Modify: `packages/backend/src/channel/public-channel-bee.js:164-398`
- Modify: `packages/backend/src/channel/multi-writer-channel.js:246-249,459-461`
- Modify: `packages/backend/test/public-channel-bee-sync.test.mjs`
- Create: `packages/backend/test/public-projection-state.test.mjs`
- Modify: `packages/backend/src/storage.js:1930-2192`
- Modify: `packages/backend/src/identity.js:140-255`

- [ ] **Step 1: Write failing projection tests**

Build a fake/private channel containing:

- one legacy video with no state
- one `replicationPending` draft
- one `durabilityVerified` winning claim item
- one `durabilityVerified` losing claim item
- channel source and artwork records

Assert public sync includes legacy + the durable winner, excludes pending and the losing claim, and copies profile/source/artwork rich fields. Assert rerunning sync is idempotent.

Also exercise a brand-new identity/channel created with `deferPublicProjection: true` and only a `replicationPending` draft. Its public core key may be allocated locally for a signed descriptor and seed-pin authorization, but no profile/descriptor/video metadata is written publicly, no public discovery is retained/joined, and no feed entry exists. The signed descriptor remains staged privately. After the item becomes durable, one `project()` call activates discovery and writes the staged descriptor/profile/source/artwork/video atomically enough to be replay-safe. The legacy default creation path remains unchanged.

Add the post-partition case: two contenders for one import identity were each projected while partitioned, then claims converge. Reconciliation must upsert the public losing row with `canonicalVisibility: 'suppressed'` and `duplicateOfClaimantId: <winner>`; default public/canonical listing returns only the winner, the losing private draft and media remain intact, and replay is idempotent.

- [ ] **Step 2: Run tests and observe pending leakage**

Run:

```bash
npm exec -- brittle test/public-channel-bee-sync.test.mjs test/public-projection-state.test.mjs
```

Expected: FAIL because `syncFromChannel()` currently copies every `listVideos()` result and writable channel creation eagerly opens/syncs/advertises the public database.

- [ ] **Step 3: Add explicit projection filters**

Use one predicate:

```js
export function isPubliclyProjectable(video, claimWinner = null) {
  const durable = !video?.publicationState || video.publicationState === 'durabilityVerified' || video.publicationState === 'published'
  const winsClaim = !video?.importIdentityKey || claimWinner?.claimantId === video.importClaimantId
  return durable && winsClaim
}
```

`syncFromChannel()` must fetch claims, resolve winners, sync only already-committed channel sources/artwork, filter candidate videos, and reconcile any previously projected public contender whose claimant is now losing with targeted `canonicalVisibility`/`duplicateOfClaimantId` markers. Public records may carry `durabilityVerified`; finalization updates winners to `published` later. Canonical/default public listing excludes records marked `canonicalVisibility: 'suppressed'`, while an internal reconciliation read can include them.

Add an explicit deferred-public-projection option from `identityManager.createIdentity(name, generateMnemonic, { deferPublicProjection })` through `createChannel` to `MultiWriterChannel`. Deferred mode may open the public core locally to obtain its key, but `_openPublicDb` must suppress bootstrap metadata writes and discovery joins. Add an idempotent `activatePublicProjection()` used only by `content-publication.project()` to write the staged signed descriptor/profile and retain discovery. Do not change the legacy default.

- [ ] **Step 4: Preserve non-destructive sync semantics**

Do not make missing private rows delete public rows during partial replication. Add explicit targeted upsert methods for publication finalization and losing-claim visibility markers instead of destructive full sync. Suppression changes canonical metadata visibility only; it never changes the three-state publication enum or deletes private rows/media blobs.

- [ ] **Step 5: Run tests**

Expected: both focused files PASS.

- [ ] **Step 6: Commit projection**

```bash
git add packages/backend/src/channel/public-channel-bee.js packages/backend/src/channel/multi-writer-channel.js packages/backend/src/storage.js packages/backend/src/identity.js packages/backend/test/public-channel-bee-sync.test.mjs packages/backend/test/public-projection-state.test.mjs
git commit -m "feat(backend): gate public projection on durability"
```

## Chunk 3: Upload Persistence and Publication Primitives

### Task 5: Persist rich upload fields without dropping them

**Files:**
- Modify: `packages/backend/src/upload.js:207-330,340-410`
- Create: `packages/backend/test/upload-structured-metadata.test.mjs`

- [ ] **Step 1: Write a failing upload metadata contract test**

Use a temporary small media fixture and a fake channel/blob writer. Pass every structured field through `uploadFromPath`; assert the exact record delivered to `channel.addVideo` includes them and uses `{ syncPublic: false }` for `replicationPending`.

```js
const result = await manager.uploadFromPath(channel, fixture, {
  sourceProvider: 'tmdb',
  sourceVideoId: '62085',
  identityUrl: 'https://source.example/item/62085',
  title: 'Pilot',
  contentKind: 'episode',
  mediaProvider: 'tmdb',
  mediaId: '62085',
  seasonNumber: 1,
  episodeNumber: 1,
  publicationState: 'replicationPending'
}, fs)
```

- [ ] **Step 2: Run and verify structured fields are dropped**
Run: `npm exec -- brittle test/upload-structured-metadata.test.mjs`

Expected: FAIL because `uploadFromPath()` destructures only legacy fields.

- [ ] **Step 3: Normalize all supported options once**

Create a local `buildVideoMetadata(options, blobResult, channel, fileSize, videoId)` helper in `upload.js`; include all rich fields explicitly, including normalized `identityUrl`. Reject/ignore `fetchUrl`, `displayUrl`, credentials, and arbitrary remote JSON rather than spreading them into persisted records.

- [ ] **Step 4: Pass explicit public-sync intent**

```js
await channel.addVideo(metadata, {
  syncPublic: metadata.publicationState !== 'replicationPending'
})
```

Apply the same behavior to both upload code paths in the file.

- [ ] **Step 5: Run focused upload tests**

Run:

```bash
npm exec -- brittle test/upload-structured-metadata.test.mjs
node --test test/upload-playback-support.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit upload persistence**

```bash
git add packages/backend/src/upload.js packages/backend/test/upload-structured-metadata.test.mjs
git commit -m "feat(backend): persist structured upload metadata"
```

### Task 6: Add idempotent publication primitives

**Files:**
- Create: `packages/backend/src/content-publication.js`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/package.json:8-47`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/public-feed.js`
- Create: `packages/backend/test/content-publication.test.mjs`

- [ ] **Step 1: Write failing state-machine primitive tests**

Test these observable operations against fakes:

```js
const publication = createContentPublication({ channel, publicFeed })
await publication.markDurabilityVerified('video-1')
await publication.project({ videoId: 'video-1', stagedDescriptor, stagedProfile, stagedSources, stagedArtwork })
await publication.announce({ channelKey, publicBeeKey, videoId: 'video-1' })
await publication.finalize('video-1')
await publication.reconcileCanonicalClaims({ channelKey, publicBeeKey })
```

Assertions:

- pending cannot project
- `markDurabilityVerified` is idempotent
- staged channel changes apply only during project
- a deferred brand-new channel has no public metadata/discovery/feed entry before project; project activates its public target and writes the staged signed descriptor/profile together with the durable item
- project replay repairs partial application
- project re-resolves the import claim immediately before public upsert and refuses a losing claimant
- if a later replicated claim changes the winner after both rows were public, project/reconciliation suppresses the old public loser and canonical listing exposes exactly one winner
- after two already-announced contenders converge, reconciliation markers hide the loser in the public catalog and a stable feed upsert replaces cached previews so feed and catalog expose the same winner
- a crash after PublicBee suppression but before feed upsert is repaired on backend restart even when the originating job is already terminal; replay emits no duplicate feed entry
- an unrelated legacy public sync before durability cannot expose a staged profile/source/artwork patch because staged patches remain only in the durable job until `project()`
- announce uses stable channel/video identity
- finalize updates private/public state to `published`
- replaying every operation produces no duplicate records

- [ ] **Step 2: Run and verify module is missing**

Run: `npm exec -- brittle test/content-publication.test.mjs`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement one-responsibility primitives**


```js
export function createContentPublication({ channel, publicFeed }) {
  return {
    async markDurabilityVerified(videoId) { /* private state only */ },
    async project(input) { /* activate deferred public target; descriptor/profile/source/artwork + public upsert */ },
    async announce(input) { /* idempotent feed submit */ },
    async finalize(videoId) { /* private/public published state */ },
    async reconcileCanonicalClaims(input) { /* markers/revision + stable feed snapshot upsert */ }
  }
}
```

Use stable channel/video/feed keys, not append-only duplicate announcement payloads. `reconcileCanonicalClaims` derives a deterministic `canonicalRevision` from the resolved visible claimant set, persists public loser markers/revision, and idempotently re-submits the channel snapshot when the feed revision differs. Register this reconciliation after owned-channel claim sync and during backend startup, not only inside an active CLI job, so a terminal-job race or crash between PublicBee and feed effects repairs itself.

- [ ] **Step 4: Export the module**

Add `./content-publication` to backend exports and the root index export.

- [ ] **Step 5: Run tests**

Run:

```bash
npm exec -- brittle test/content-publication.test.mjs test/public-projection-state.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit publication primitives**

```bash
git add packages/backend/src/content-publication.js packages/backend/src/orchestrator.js packages/backend/src/public-feed.js packages/backend/src/index.js packages/backend/package.json packages/backend/test/content-publication.test.mjs
git commit -m "feat(backend): add idempotent content publication primitives"
```

### Task 7: Verify persistence plan as a working slice

**Files:**
- Test only; no planned source changes

- [ ] **Step 1: Run focused schema and publication suite**

From `packages/backend`:

```bash
npm exec -- brittle \
  test/structured-content-codec.test.mjs \
  test/structured-content.test.mjs \
  test/import-claims.test.mjs \
  test/public-channel-bee-sync.test.mjs \
  test/public-projection-state.test.mjs \
  test/upload-structured-metadata.test.mjs \
  test/content-publication.test.mjs
node --test test/multiwriter-channel-hyperdb.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 2: Run existing backend regression tests covering touched paths**

```bash
npm exec -- brittle \
  test/public-channel-owner-metadata.test.mjs \
  test/channel-owner-writer-dedupe.test.mjs
node --test \
  test/public-channel-hyperdb.test.mjs \
  test/upload-playback-support.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run a legacy decode smoke**

Open a test channel with only legacy metadata/video fields, sync it publicly, and verify it remains listable with no synthetic structured fields required.

Run: `npm exec -- brittle test/public-projection-state.test.mjs`

Expected: PASS.

- [ ] **Step 4: Commit only if verification required fixes**

If no fixes were needed, do not create an empty commit. Otherwise commit narrowly with `fix(backend): preserve structured content compatibility`.

## Plan 1 Completion Gate

The slice is complete when rich records round-trip, pending drafts never reach PublicBee, durable records project idempotently, staged profile changes do not leak early, finalization is restart-safe at primitive level, and all listed legacy regressions pass. Do not begin plan 2 until this gate is green.
