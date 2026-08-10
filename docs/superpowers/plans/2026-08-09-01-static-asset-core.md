# Deterministic Static Asset Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make byte-identical media imports converge on one immutable Hypercore key, asset ID, and discovery topic.

**Architecture:** Write canonical 256 KiB blocks into a temporary writable core, read its completed tree hash, construct a zero-signer static-prologue manifest, and copy the committed prologue into the final key-addressed core. The final core has no signing key and accepts no append path.

**Tech Stack:** Hypercore 11.28.x, Corestore 7, hypercore-crypto, b4a, JavaScript ESM, Brittle.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-09-distributed-archive-search-scale-design.md` §4.3 exactly.
- `ASSET_BLOCK_SIZE` is `256 * 1024`; only the final block may be shorter.
- Derive `assetId` from the completed tree hash, block length, byte length, and block size.
- Use Hypercore's static prologue manifest; do not substitute a file hash for `treeHash`.
- The final core must expose no secret key or append operation.
- Pin the current Hypercore range and isolate internal `core.copyPrologue(sourceState)` use in one module with a conformance test.

---

### Task 1: Static manifest and identity primitive

**Files:**
- Create: `packages/backend/src/assets/static-core.js`
- Modify: `packages/backend/src/assets/index.js`
- Test: `packages/backend/test/static-asset-core.test.mjs`

**Interfaces:**
- Consumes: completed staging core state `{ treeHash, length }` and exact `byteLength`.
- Produces: `ASSET_BLOCK_SIZE`, `createStaticAssetManifest(input)`, `deriveStaticAssetId(input)`, `deriveStaticAssetTopic(assetId)`, and `verifyStaticAssetDescriptor(core, descriptor)`.

- [ ] **Step 1: Write the failing identity tests**

```js
const a = createStaticAssetManifest({ treeHash, blockLength: 3, byteLength: 600000 })
const b = createStaticAssetManifest({ treeHash: b4a.from(treeHash), blockLength: 3, byteLength: 600000 })
t.is(a.key.toString('hex'), b.key.toString('hex'))
t.is(deriveStaticAssetId(a), deriveStaticAssetId(b))
t.alike(deriveStaticAssetTopic(deriveStaticAssetId(a)), deriveStaticAssetTopic(deriveStaticAssetId(b)))
t.exception(() => createStaticAssetManifest({ treeHash, blockLength: 2, byteLength: 600000 }))
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `cd packages/backend && npx brittle test/static-asset-core.test.mjs`

Expected: FAIL because `src/assets/static-core.js` does not exist.

- [ ] **Step 3: Implement the canonical manifest and derivations**

```js
const expectedBlockLength = Math.ceil(byteLength / ASSET_BLOCK_SIZE)
if (blockLength !== expectedBlockLength) throw new Error('blockLength does not match canonical asset blocks')
const hypercoreManifest = {
  version: 1,
  hash: 'blake2b',
  allowPatch: false,
  quorum: 0,
  signers: [],
  prologue: { hash: treeHash, length: blockLength }
}
const key = Hypercore.key(hypercoreManifest)
const assetId = hashCanonical('peartube.asset.static.v1', {
  treeHash, blockLength, byteLength, blockSize: ASSET_BLOCK_SIZE
})
```

The implementation must validate the expected block count, create `{ version: 1, hash: 'blake2b', allowPatch: false, quorum: 0, signers: [], prologue: { hash: treeHash, length: blockLength } }`, derive the Hypercore key from that manifest, and compare the opened core's key, tree hash, length, and byte length to the descriptor.

- [ ] **Step 4: Run the focused test**

Run: `cd packages/backend && npx brittle test/static-asset-core.test.mjs`

Expected: PASS for convergence, one-byte divergence, malformed lengths, and stable topic derivation.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/assets/static-core.js packages/backend/src/assets/index.js packages/backend/test/static-asset-core.test.mjs
git commit -m "feat(assets): define deterministic static core identity"
```

### Task 2: Materialize a read-only final core

**Files:**
- Modify: `packages/backend/src/assets/static-core.js`
- Modify: `packages/backend/src/assets/rendition-writer.js`
- Test: `packages/backend/test/static-asset-core.test.mjs`

**Interfaces:**
- Consumes: `Corestore`, a readable media source, and optional `AbortSignal`.
- Produces: `writeStaticAsset({ store, source, signal }) -> { core, descriptor }` where `descriptor.kind === 'static-prologue-v1'`.

- [ ] **Step 1: Add failing two-store and mutability tests**

```js
const left = await writeStaticAsset({ store: storeA, source: [bytes] })
const right = await writeStaticAsset({ store: storeB, source: [bytes] })
t.is(left.descriptor.key, right.descriptor.key)
t.is(left.descriptor.assetId, right.descriptor.assetId)
t.absent(left.core.secretKey)
await t.exception(left.core.append(b4a.from('forbidden')))
```

Also assert canonical block lengths and a different key after flipping one byte.

- [ ] **Step 2: Implement staging, prologue copy, and cleanup**

```js
const staging = store.get({ name: `asset-staging-${randomId}` })
try {
  await appendCanonicalSource(staging, source, { blockSize: ASSET_BLOCK_SIZE, signal })
  const treeHash = await staging.treeHash()
  const descriptor = createStaticAssetManifest({
    treeHash, blockLength: staging.length, byteLength: staging.byteLength
  })
  const finalCore = store.get({ key: descriptor.key, manifest: descriptor.hypercoreManifest })
  await copyStaticPrologue({ sourceState: staging.core.state, target: finalCore })
  if (!await verifyStaticAssetDescriptor(finalCore, descriptor)) throw new Error('static asset verification failed')
  return { core: finalCore, descriptor }
} finally {
  await removeStagingCore(staging)
}
```

Stream the source once, append canonical blocks to a temporary core, close it at completion, reconstruct the exact static manifest, open the final key-addressed core with that manifest, invoke the isolated prologue-copy helper, verify it, and delete staging storage on success, cancellation, or failure.

- [ ] **Step 3: Replace the synthetic writer output**

Change `createImmutableRenditionWriter().writeRendition()` to require an injected store/source and return the real static descriptor. Remove the current `hashHex('core-key' + bytes)` and `hashHex(bytes)` identity substitutes.

- [ ] **Step 4: Run the focused proof**

Run: `cd packages/backend && npx brittle test/static-asset-core.test.mjs test/rendition-writer.test.mjs`

Expected: PASS; two independent stores converge, mutation diverges, final cores are read-only, and abort cleanup leaves no staging core.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/assets/static-core.js packages/backend/src/assets/index.js packages/backend/src/assets/rendition-writer.js packages/backend/test/static-asset-core.test.mjs packages/backend/test/rendition-writer.test.mjs
git commit -m "feat(assets): derive deterministic static media cores"
```