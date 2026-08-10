# Asset Manifest and Ingestion Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and ingest v2 manifests that bind exact renditions to deterministic static cores while quarantining ambiguous legacy shared-core records.

**Architecture:** `AssetCoreRefV2` becomes the only accepted active rendition core reference. Upload produces the static core first, then the segment index, rendition descriptor, signed publication manifest, and catalog operation. A migration classifier may identify legacy input, but it never treats a random writable core prefix as an exact asset.

**Tech Stack:** Existing signed application envelopes, publisher catalogs, Hypercore/Corestore, JavaScript ESM, Brittle.

## Global Constraints

- Depends on Plan 01 exports from `packages/backend/src/assets/static-core.js`.
- Preserve `Work -> Edition -> Rendition -> Asset`; publisher provenance remains separate from asset identity.
- `AssetCoreRefV2.assetId` must equal its canonical static Hypercore `key`; reject any mismatch.
- Every segment index range must remain within `byteLength` and map to canonical static-core blocks.
- Remove obsolete random-core fixtures after explicit re-ingestion or assert their quarantine.
- Do not add a compatibility shim that silently upgrades unverifiable bytes.

---

### Task 1: Define and verify v2 asset references

**Files:**
- Modify: `packages/backend/src/assets/rendition.js`
- Modify: `packages/backend/src/assets/segment-index.js`
- Modify: `packages/backend/src/assets/manifest.js`
- Modify: `packages/backend/src/assets/manifest-store.js`
- Create: `packages/backend/src/migrations/asset-core-v2.js`
- Test: `packages/backend/test/asset-manifest.test.mjs`
- Test: `packages/backend/test/asset-segment-index.test.mjs`
- Test: `packages/backend/test/asset-manifest-store.test.mjs`

**Interfaces:**
- Consumes: `AssetCoreRefV2 { kind, key, treeHash, length, byteLength, blockSize, assetId }`.
- Produces: `normalizeAssetCoreRefV2`, v2 rendition/manifest encoders, and `classifyLegacyAssetReference(input) -> 'reingest-required' | 'quarantine'`.

- [ ] **Step 1: Add failing schema-boundary tests**

```js
const core = normalizeAssetCoreRefV2({
  kind: 'static-prologue-v1', key, treeHash, length: 2,
  byteLength: 300000, blockSize: 262144, assetId
})
t.is(core.assetId, assetId)
t.exception(() => normalizeAssetCoreRefV2({ ...core, byteLength: 262145, length: 1 }))
t.is(classifyLegacyAssetReference({ key, start: 4, end: 9 }), 'reingest-required')
```

Assert manifest verification rejects a static descriptor whose reconstructed manifest key or tree root differs.

- [ ] **Step 2: Run the focused tests**

Run: `cd packages/backend && npx brittle test/asset-manifest.test.mjs test/asset-segment-index.test.mjs test/asset-manifest-store.test.mjs`

Expected: FAIL on missing v2 normalization and legacy classification.

- [ ] **Step 3: Implement strict v2 normalization and verification**

```js
if (input.kind !== 'static-prologue-v1') throw new Error('static asset core reference required')
const byteLength = normalizeNonNegativeInteger(input.byteLength, 'byteLength')
const blockSize = normalizeNonNegativeInteger(input.blockSize, 'blockSize')
const length = normalizeNonNegativeInteger(input.length, 'length')
if (blockSize !== 256 * 1024 || length !== Math.ceil(byteLength / blockSize)) {
  throw new Error('asset core length does not match canonical blocks')
}
const keyHex = toHex(input.key, 32, 'key')
const assetId = toHex(input.assetId, 32, 'assetId')
if (assetId !== keyHex) throw new Error('assetId must equal static core key')
const normalized = Object.freeze({
  kind: input.kind,
  key: keyHex,
  treeHash: toHex(input.treeHash, 32, 'treeHash'),
  length, byteLength, blockSize, assetId
})
const legacyDisposition = input.sourcePath || input.localFilePath ? 'reingest-required' : 'quarantine'
```

Bump the asset manifest/rendition schema versions, reconstruct the static manifest during verification, require exact key/tree/length/byte-length agreement, and add `assetId` indexes to the manifest store without conflating publisher IDs.

- [ ] **Step 4: Run the focused tests**

Expected: PASS for valid v2 records, tampered descriptors, out-of-range segments, duplicate publisher references, and legacy quarantine.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/assets/rendition.js packages/backend/src/assets/segment-index.js packages/backend/src/assets/manifest.js packages/backend/src/assets/manifest-store.js packages/backend/src/migrations/asset-core-v2.js packages/backend/test/asset-manifest.test.mjs packages/backend/test/asset-segment-index.test.mjs packages/backend/test/asset-manifest-store.test.mjs
git commit -m "feat(assets): require verified v2 core references"
```

### Task 2: Cut upload and publication over to static assets

**Files:**
- Modify: `packages/backend/src/upload.js`
- Modify: `packages/backend/src/assets/rendition-writer.js`
- Modify: `packages/backend/src/assets/publication-batch.js`
- Modify: `packages/backend/src/api.js`
- Test: `packages/backend/test/upload-playback-support.test.mjs`
- Test: `packages/backend/test/upload-structured-metadata.test.mjs`
- Test: `packages/backend/test/publication-batch.test.mjs`
- Test: `packages/backend/test/publication-v1-migration.test.mjs`

**Interfaces:**
- Consumes: `writeStaticAsset()` from Plan 01 plus publisher/metadata claims.
- Produces: upload result `{ publicationId, manifestId, renditionId, assetId, coreKey }` backed by the same verified descriptor stored in the publisher catalog.

- [ ] **Step 1: Add a failing end-to-end upload assertion**

```js
const result = await uploadManager.uploadVideo(input)
t.is(result.assetId, result.manifest.body.renditions[0].core.assetId)
t.is(result.coreKey, result.manifest.body.renditions[0].core.key)
t.is(result.manifest.body.renditions[0].core.kind, 'static-prologue-v1')
```

Repeat the upload in a second store and assert the same asset/core IDs but distinct publisher provenance.

- [ ] **Step 2: Implement the clean upload sequence**

Create the static core before signing the manifest, build the segment index from canonical byte boundaries, publish only after local verification succeeds, and make cancellation delete staging state without emitting catalog operations.

- [ ] **Step 3: Replace fixtures and migration expectations**

Re-ingest fixtures whose source bytes exist. For fixtures with only a legacy random core reference, assert `reingest-required` or quarantine and remove active-playback expectations.

- [ ] **Step 4: Run the focused cutover tests**

Run: `cd packages/backend && npx brittle test/upload-playback-support.test.mjs test/upload-structured-metadata.test.mjs test/publication-batch.test.mjs test/publication-v1-migration.test.mjs`

Expected: PASS; no active v2 fixture contains a shared writable blob range.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/upload.js packages/backend/src/assets/rendition-writer.js packages/backend/src/assets/publication-batch.js packages/backend/src/api.js packages/backend/test/upload-playback-support.test.mjs packages/backend/test/upload-structured-metadata.test.mjs packages/backend/test/publication-batch.test.mjs packages/backend/test/publication-v1-migration.test.mjs
git commit -m "feat(assets): publish static asset manifests"
```

### Task 3: Preserve multi-file source provenance without coupling assets

**Files:**
- Create: `packages/backend/src/assets/bundle.js`
- Modify: `packages/backend/src/assets/index.js`
- Modify: `packages/backend/src/assets/publication-batch.js`
- Test: `packages/backend/test/asset-bundle.test.mjs`

**Interfaces:**
- Produces metadata-only `AssetBundleV1 { bundleId, sourceKind, publicInfohash?, entries[] }`.
- Each entry binds bounded source path/index metadata to one independently playable `{ publicationId, renditionId, assetId }`; it never contains media bytes or a shared core range.

- [ ] **Step 1: Write a failing season-pack independence test**

```js
const bundle = createAssetBundleManifest({
  sourceKind: 'public-torrent',
  publicInfohash,
  entries: [
    { sourcePath: 'Show.S01E01.mkv', publicationId: pub1, renditionId: rend1, assetId: asset1 },
    { sourcePath: 'Show.S01E02.mkv', publicationId: pub2, renditionId: rend2, assetId: asset2 }
  ]
})
t.unlike(bundle.entries[0].assetId, bundle.entries[1].assetId)
t.exception(() => createAssetBundleManifest({ sourceKind: 'private-torrent', publicInfohash, entries: bundle.entries }))
```

- [ ] **Step 2: Implement bounded metadata-only bundles**

Canonicalize entry order and paths, derive `bundleId` from metadata, accept `publicInfohash` only when the caller explicitly attests the torrent is tracker-independent and public, and reject passkeys, tracker URLs, cookies, signed URLs, and source headers. Publishing or retaining one entry must not join, fetch, or pin any sibling asset.

- [ ] **Step 3: Run bundle and publication tests**

Run: `cd packages/backend && npx brittle test/asset-bundle.test.mjs test/publication-batch.test.mjs test/asset-manifest.test.mjs`

Expected: partial pack mappings verify, independent assets remain independently playable/retainable, and private acquisition details are rejected.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/assets/bundle.js packages/backend/src/assets/index.js packages/backend/src/assets/publication-batch.js packages/backend/test/asset-bundle.test.mjs
git commit -m "feat(assets): preserve source bundle mappings"
```