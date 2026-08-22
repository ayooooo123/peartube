import b4a from 'b4a'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'

import {
  normalizeBytes,
  normalizeNonNegativeInteger,
} from '../publisher/canonical.js'

export const ASSET_BLOCK_SIZE = 256 * 1024

const STATIC_ASSET_KIND = 'static-prologue-v1'

function normalizeIdentityInput(input = {}) {
  const treeHash = normalizeBytes(input.treeHash, 32, 'treeHash')
  const blockLength = normalizeNonNegativeInteger(
    input.blockLength ?? input.length,
    'blockLength',
    NaN
  )
  const byteLength = normalizeNonNegativeInteger(input.byteLength, 'byteLength', NaN)
  const blockSize = normalizeNonNegativeInteger(
    input.blockSize ?? ASSET_BLOCK_SIZE,
    'blockSize',
    NaN
  )

  if (blockSize !== ASSET_BLOCK_SIZE) throw new Error('blockSize does not match canonical asset blocks')
  if (blockLength !== Math.ceil(byteLength / ASSET_BLOCK_SIZE)) {
    throw new Error('blockLength does not match canonical asset blocks')
  }

  return { treeHash, blockLength, byteLength, blockSize }
}

function createHypercoreManifest(treeHash, blockLength) {
  return {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 0,
    signers: [],
    prologue: { hash: treeHash, length: blockLength },
  }
}

function isIterable(source) {
  return !!source && (
    typeof source[Symbol.asyncIterator] === 'function' ||
    typeof source[Symbol.iterator] === 'function'
  )
}

function assertWriteInput(store, source, createSource) {
  if (!store || typeof store.get !== 'function') throw new Error('store is required')
  if (createSource !== null && typeof createSource !== 'function') {
    throw new Error('createSource must be a function')
  }
  if (createSource === null && !isIterable(source)) {
    throw new Error('source is required')
  }
}

/**
 * How this write gets at the source bytes.
 *
 * `reopenable` is the whole point: bounded ingest reads the source TWICE (once
 * to derive the content-addressed key, once to write the blocks), so it can
 * only run when the source can be opened again. A factory can always be called
 * again; an array is the one iterable that is provably re-iterable; anything
 * else — a generator, a stream — is one-shot and is refused rather than
 * buffered.
 */
function resolveSource({ source, createSource }) {
  if (typeof createSource === 'function') {
    return {
      reopenable: true,
      open() {
        const opened = createSource()
        if (!isIterable(opened)) throw new Error('createSource() must return an iterable of byte chunks')
        return opened
      },
    }
  }
  return { reopenable: Array.isArray(source), open: () => source }
}

/**
 * `offload` is one of three things, and which one it is decides how the write
 * runs:
 *
 *   null                 no offload; the classic single-pass write.
 *   function             the classic single-pass write, then one call with
 *                        `({ core, descriptor, signal })` on the finished core.
 *   { createOffloader,   bounded ingest — see writeStaticAsset.
 *     createStagingStore }
 */
function normalizeOffload(offload) {
  if (offload === null || offload === undefined) {
    return { hook: null, createOffloader: null, createStagingStore: null }
  }
  if (typeof offload === 'function') {
    return { hook: offload, createOffloader: null, createStagingStore: null }
  }
  if (typeof offload === 'object' && typeof offload.createOffloader === 'function') {
    const staging = offload.createStagingStore
    if (staging !== null && staging !== undefined && typeof staging !== 'function') {
      throw new Error('offload.createStagingStore must be a function')
    }
    return {
      hook: null,
      createOffloader: (input) => offload.createOffloader(input),
      createStagingStore: typeof staging === 'function' ? (input) => staging(input) : null,
    }
  }
  throw new Error('offload must be a function or an object with createOffloader()')
}

function assertOffloader(offloader) {
  if (!offloader || typeof offloader.track !== 'function' || typeof offloader.drain !== 'function') {
    throw new Error('createOffloader() must return a block offloader with track() and drain()')
  }
  return offloader
}

const STAGING_STORE_METHODS = ['put', 'has', 'get', 'purge']

function assertStagingStore(store) {
  for (const name of STAGING_STORE_METHODS) {
    if (!store || typeof store[name] !== 'function') {
      throw new Error(`createStagingStore() must return a remote block store with ${STAGING_STORE_METHODS.join('(), ')}()`)
    }
  }
  return store
}

function sourceNotReopenableError() {
  const error = new Error(
    'bounded offload ingest needs the title twice and this source can only be read once: pass createSource(), a function returning a fresh iterable, or offload.createStagingStore() so the second pass can read the staged blocks back from the object store'
  )
  error.code = 'ASSET_SOURCE_NOT_REOPENABLE'
  return error
}

function sourceChangedError(message, index) {
  const error = new Error(`the source changed between passes: ${message}`)
  error.code = 'ASSET_SOURCE_CHANGED'
  error.blockIndex = index
  return error
}

function stagedBlockError(message, code, index) {
  const error = new Error(message)
  error.code = code
  error.blockIndex = index
  return error
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new Error('static asset write cancelled')
}

function sourceChunkView(value) {
  if (!b4a.isBuffer(value)) {
    throw new Error('source chunks must be a Buffer or Uint8Array')
  }
  return value.subarray(0)
}

/**
 * Split the source into canonical asset blocks and hand each one to `onBlock`,
 * in order, with its index. Chunk boundaries in the source are irrelevant: only
 * `blockSize` decides where a block ends, which is what makes the resulting
 * tree — and therefore the asset key — a function of the bytes alone.
 */
async function eachCanonicalBlock(source, { blockSize, signal, onBlock }) {
  let partial = null
  let partialLength = 0
  let index = 0

  for await (const value of source) {
    assertNotCancelled(signal)
    const chunk = sourceChunkView(value)
    let offset = 0

    if (partial !== null) {
      const length = Math.min(blockSize - partialLength, chunk.byteLength)
      b4a.copy(chunk.subarray(0, length), partial, partialLength)
      partialLength += length
      offset += length

      if (partialLength === blockSize) {
        await onBlock(partial, index++)
        assertNotCancelled(signal)
        partial = null
        partialLength = 0
      }
    }

    while (chunk.byteLength - offset >= blockSize) {
      await onBlock(chunk.subarray(offset, offset + blockSize), index++)
      assertNotCancelled(signal)
      offset += blockSize
    }

    if (offset < chunk.byteLength) {
      partial = b4a.allocUnsafe(blockSize)
      partialLength = chunk.byteLength - offset
      b4a.copy(chunk.subarray(offset), partial)
    }
  }

  assertNotCancelled(signal)
  if (partialLength > 0) await onBlock(partial.subarray(0, partialLength), index++)
  assertNotCancelled(signal)
  return index
}

/**
 * Append every canonical block of the source to `core`.
 *
 * `onAppended(index, block)` is optional and, when absent, this is the append
 * loop it always was. Bounded ingest uses it to deal with each staged block's
 * DATA the moment the block is durably written — dropped, or uploaded and then
 * dropped — keeping the merkle tree the append built and nothing else.
 */
async function appendCanonicalSource(core, source, { blockSize, signal, onAppended = null }) {
  await eachCanonicalBlock(source, {
    blockSize,
    signal,
    async onBlock(block, index) {
      await core.append(block)
      if (onAppended !== null) await onAppended(index, block)
    },
  })
}

async function copyStaticPrologue({ sourceState, target }) {
  await target.ready()
  // Hypercore 11.35.1 exposes this internal operation as Core.copyPrologue(sourceState).
  await target.core.copyPrologue(sourceState)
}

// ---------------------------------------------------------------------------
// bounded ingest
// ---------------------------------------------------------------------------
//
// The staging core is written through Hypercore, but a staged block's DATA is
// put and dropped through the storage write transaction directly, exactly as
// archive/block-offloader.js drops an offloaded block: it touches only the
// block key, so the tree and the bitfield the transplant needs survive.

async function putStagedBlockData(storage, index, data) {
  const tx = storage.write()
  tx.putBlock(index, data)
  await tx.flush()
}

async function dropStagedBlockData(storage, index) {
  const tx = storage.write()
  tx.deleteBlock(index)
  await tx.flush()
}

/**
 * The 32-byte commitment the staged tree made to block `index` — the hash of
 * merkle tree node `2 * index`. The second pass is only allowed to write bytes
 * that hash to this.
 */
async function stagedLeafHash(storage, index) {
  const rx = storage.read()
  let pending = null
  try {
    pending = rx.getTreeNode(2 * index)
  } finally {
    rx.tryFlush()
  }
  const node = await pending
  return node && b4a.isBuffer(node.hash) && node.hash.byteLength === 32 ? node.hash : null
}

function residentBytesOf(offloader) {
  const stats = typeof offloader.stats === 'function' ? offloader.stats() : null
  return Number.isSafeInteger(stats?.residentBytes) ? stats.residentBytes : 0
}

/**
 * Read block `index` from the staging core through its own storage layer.
 *
 * In streaming mode the local copy was dropped in pass 1, so this read misses
 * locally and the offload storage wrapper (archive/offload-storage.js) fetches
 * the object it was uploaded to and verifies it against the staged tree before
 * handing it back. Nothing above this line knows the difference.
 */
async function readStagedBlockData(storage, index) {
  const rx = storage.read()
  let pending = null
  try {
    pending = rx.getBlock(index)
  } finally {
    rx.tryFlush()
  }
  const data = await pending
  return data === undefined ? null : data
}

/**
 * The staged tree's commitment for block `index`, refusing a block the tree the
 * asset key came from never committed to.
 */
async function stagedLeafFor(stagingStorage, index, descriptor) {
  if (index >= descriptor.length) {
    throw sourceChangedError(`block ${index} is past the end of the tree the asset key was derived from`, index)
  }
  const expectedHash = await stagedLeafHash(stagingStorage, index)
  if (expectedHash === null) {
    throw sourceChangedError(`block ${index} has no leaf in the tree the asset key was derived from`, index)
  }
  return expectedHash
}

/**
 * The bytes for block `index` are checked against the staged tree BEFORE they
 * are written into the finished core.
 *
 * `copyPrologue` verifies the source core's roots against the prologue, but it
 * never hashes the block data it copies, so bytes that read back differently —
 * a source that changed between passes, an object store that handed back
 * something else — would otherwise land in a core whose key says they cannot
 * have, leaving every peer that asked for that block unable to verify the proof
 * the relay serves it. This check is the only thing standing there, so it stays
 * on the write side of the write.
 */
function assertMatchesStagedLeaf(block, index, expectedHash) {
  if (!b4a.equals(crypto.data(block), expectedHash)) {
    throw sourceChangedError(`block ${index} does not match the tree the asset key was derived from`, index)
  }
}

/**
 * Move one verified block from the staging core into the finished core.
 *
 * Stage the bytes, transplant them, drop the staged copy, then let the offloader
 * take the oldest end. So the only block data on local disk at any moment is the
 * window the offloader has not given up yet plus the one block being moved —
 * never the title.
 */
async function transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index) {
  // Both copies of this block are on local disk between the two writes below:
  // the staged one the transplant reads and the final one it writes. That pair,
  // on top of the window the offloader has not given up yet, is the peak this
  // whole path exists to bound.
  const local = residentBytesOf(offloader) + (2 * block.byteLength)
  if (local > progress.peakLocalBytes) progress.peakLocalBytes = local

  const stagingStorage = staging.core.state.storage
  await putStagedBlockData(stagingStorage, index, block)
  assertNotCancelled(signal)
  await copyStaticPrologue({ sourceState: staging.core.state, target: finalCore })
  assertNotCancelled(signal)
  // Redundant now rather than lost: the finished core holds it durably, and the
  // finished core's own offload has not started for this block yet, so no delete
  // here can be the delete of a block whose only other copy is remote.
  await dropStagedBlockData(stagingStorage, index)
  assertNotCancelled(signal)

  offloader.track(index, block.byteLength)
  await offloader.drain()
  assertNotCancelled(signal)

  progress.blocks++
  progress.bytes += block.byteLength
}

/**
 * Close the finished core's accounting and describe what the pass cost.
 */
async function finishIngest({ mode, finalCore, descriptor, offloader, progress }) {
  if (progress.blocks !== descriptor.length || progress.bytes !== descriptor.byteLength) {
    throw sourceChangedError(
      `it ended at ${progress.blocks} block(s) and ${progress.bytes} byte(s), but the asset key was derived from ${descriptor.length} block(s) and ${descriptor.byteLength} byte(s)`,
      progress.blocks
    )
  }

  if (progress.blocks > 0) {
    // `copyPrologue` sets the contiguous-length hint from the run of blocks one
    // call saw, and here every call sees exactly one, so the finished core is
    // told the truth once at the end. It is only a fast path — a full core
    // answers `has()` for every block either way — but a core that lies about
    // it is a core somebody debugs twice.
    finalCore.core.updateContiguousLength({ drop: false, start: 0, length: 1 })
    await finalCore.core.flushHints()
  }

  return {
    mode,
    blocks: progress.blocks,
    bytes: progress.bytes,
    peakLocalBytes: progress.peakLocalBytes,
    windowBytes: Number.isSafeInteger(offloader.windowBytes) ? offloader.windowBytes : null,
    offload: typeof offloader.stats === 'function' ? offloader.stats() : null,
  }
}

/**
 * Second pass over a RE-OPENABLE source: read the source again and move it into
 * the finished core one block at a time. Nothing leaves for the object store
 * except through the offloader's window, and the source is a local file or an
 * array, so re-reading it is cheaper than a round trip to a bucket.
 */
async function ingestBoundedSource({ staging, finalCore, descriptor, source, offloader, signal }) {
  const stagingStorage = staging.core.state.storage
  const progress = { blocks: 0, bytes: 0, peakLocalBytes: 0 }

  await eachCanonicalBlock(source, {
    blockSize: ASSET_BLOCK_SIZE,
    signal,
    async onBlock(block, index) {
      const expectedHash = await stagedLeafFor(stagingStorage, index, descriptor)
      assertMatchesStagedLeaf(block, index, expectedHash)
      await transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index)
    },
  })

  return finishIngest({ mode: 'reopen', finalCore, descriptor, offloader, progress })
}

// ---------------------------------------------------------------------------
// streaming ingest: one read of the source, ever
// ---------------------------------------------------------------------------
//
// A network download cannot be re-opened, and a relay that must stage the whole
// title on disk before ingest can only archive what its volume holds — which is
// the failure this mode exists for. So pass 1 sends each staged block to the
// object store under the STAGING core's key as it is appended, and pass 2 reads
// them back from there instead of from the network.
//
// Objects are addressed BY CORE KEY, so the staging objects cannot be handed to
// the finished core: each restored block is re-uploaded under the finished
// core's own key by its own offloader, and the staging objects are deleted once
// the finished core verifies.

/**
 * Pass 1, per appended block: upload it under the staging core's key, make the
 * object store confirm it holds it, and only then drop the local copy.
 *
 * That is the order block-offloader.js uses, for the same reason: a delete that
 * happens before the confirmation is a delete of the only copy. The staged leaf
 * is checked first because that leaf is what pass 2 verifies the restored object
 * against — a block dropped without one is a block nobody can prove again.
 */
async function offloadStagedBlock({ staging, stagingStore, staged, index, block, signal }) {
  const storage = staging.core.state.storage
  const expectedHash = await stagedLeafHash(storage, index)
  if (expectedHash === null || !b4a.equals(crypto.data(block), expectedHash)) {
    throw stagedBlockError(
      `staged block ${index} has no matching leaf in the staging tree; refusing to drop a block that could never be verified again`,
      'ASSET_STAGED_BLOCK_UNVERIFIABLE',
      index
    )
  }

  await stagingStore.put(index, block)
  assertNotCancelled(signal)
  if (await stagingStore.has(index) !== true) {
    throw stagedBlockError(
      `staged block ${index} was uploaded but the object store does not report holding it; the local copy is kept`,
      'ASSET_STAGED_UPLOAD_UNCONFIRMED',
      index
    )
  }
  staged.uploaded = index + 1

  await dropStagedBlockData(storage, index)
  assertNotCancelled(signal)
}

/**
 * Pass 2's source in streaming mode.
 *
 * The wrapper restores the block for us when the host's `resolveStore` answers
 * for staging cores, which is the normal wiring. The direct read is for a host
 * whose does not: without it a write that has already spent the entire download
 * would fail on a wiring detail, and there is no second download.
 */
async function restoreStagedBlock({ storage, stagingStore, index, expectedHash }) {
  const local = await readStagedBlockData(storage, index)
  if (local !== null) return local

  const restored = await stagingStore.get(index, { expectedHash })
  if (restored === null || restored === undefined) {
    throw stagedBlockError(
      `staged block ${index} is not on local disk and the object store does not hold it`,
      'ASSET_STAGED_BLOCK_MISSING',
      index
    )
  }
  return restored
}

/**
 * Second pass with no source: walk the staged tree and pull every block back
 * from the object store, one at a time, into the finished core.
 */
async function ingestStagedBlocks({ staging, finalCore, descriptor, stagingStore, staged, offloader, signal }) {
  const stagingStorage = staging.core.state.storage
  const progress = { blocks: 0, bytes: 0, peakLocalBytes: 0 }

  for (let index = 0; index < descriptor.length; index++) {
    assertNotCancelled(signal)
    const expectedHash = await stagedLeafFor(stagingStorage, index, descriptor)

    const block = await restoreStagedBlock({ storage: stagingStorage, stagingStore, index, expectedHash })
    staged.restored++
    assertNotCancelled(signal)
    assertMatchesStagedLeaf(block, index, expectedHash)
    await transplantStagedBlock({ staging, finalCore, offloader, signal, progress }, block, index)
  }

  return finishIngest({ mode: 'streaming', finalCore, descriptor, offloader, progress })
}

/**
 * Drop every staging object. They exist only to carry the title from pass 1 to
 * pass 2, so past that point they are pure cost.
 *
 * This never throws: on the success path a bucket that will not delete must not
 * lose the caller an archive that is already verified, and on the failure path
 * it must not bury the error that got us here. What it cannot delete it names.
 */
async function purgeStagingObjects(stagingStore, uploaded) {
  if (stagingStore === null || uploaded === 0) {
    return { uploaded, deleted: 0, orphaned: [], error: null }
  }
  try {
    const { deleted, orphaned } = await stagingStore.purge({ length: uploaded })
    return {
      uploaded,
      deleted,
      orphaned: orphaned.map((entry) => entry.key),
      error: orphaned.length > 0 ? orphaned[0].error : null,
    }
  } catch (error) {
    const orphaned = []
    for (let index = 0; index < uploaded; index++) orphaned.push(stagingStore.key(index))
    return { uploaded, deleted: 0, orphaned, error }
  }
}

async function closeUnreturnedCore(core, error) {
  if (!core || core.closed) return
  try {
    await core.close()
  } catch (closeError) {
    throw new AggregateError([error, closeError], 'static asset failure and final core close failed')
  }
}

async function removeStagingCore(staging) {
  const core = staging.core
  const storage = core.state.storage
  const storageRoot = storage.store
  const storagePointer = storage.core

  // Hypercore 11.35.1's public purge method references removed internals.
  await staging.close()
  await core.close()
  await storageRoot.deleteCore(storagePointer)
}

export function deriveStaticAssetId(input = {}) {
  const { treeHash, blockLength } = normalizeIdentityInput(input)
  return b4a.toString(Hypercore.key(createHypercoreManifest(treeHash, blockLength)), 'hex')
}

export function deriveStaticAssetTopic(assetId) {
  return Hypercore.discoveryKey(normalizeBytes(assetId, 32, 'assetId'))
}

export function createStaticAssetManifest(input = {}) {
  const { treeHash, blockLength, byteLength, blockSize } = normalizeIdentityInput(input)
  const hypercoreManifest = createHypercoreManifest(treeHash, blockLength)
  const key = Hypercore.key(hypercoreManifest)
  const descriptor = {
    kind: STATIC_ASSET_KIND,
    key,
    treeHash,
    length: blockLength,
    byteLength,
    blockSize,
    hypercoreManifest,
  }

  return {
    ...descriptor,
    assetId: b4a.toString(key, 'hex'),
  }
}

/**
 * Write one immutable static asset core.
 *
 * The asset's key is derived from the content, so the bytes have to be hashed
 * before the core they belong in can be opened. That is what shapes this
 * function, and `offload` decides which of the three shapes it takes.
 *
 * WITHOUT OFFLOAD (`offload` null, or a plain function) it is one pass: the
 * whole source is appended to a staging core, the descriptor is derived from
 * the staging tree, the prologue is copied into the finished core, the staging
 * core is removed, and a function `offload` is then called once with
 * `({ core, descriptor, signal })` — the first moment every block is durably
 * written, every merkle leaf exists, and the core's key is the content-
 * addressed key the network will ask for. Peak local block data is the title,
 * twice over at the copy, so the title has to fit on the volume.
 *
 * WITH BOUNDED INGEST (`offload` is `{ createOffloader }`) it is two passes and
 * the title does NOT have to fit:
 *
 *   1. the source is appended to the staging core and each staged block's DATA
 *      is dropped the moment it is written. Staging keeps the merkle tree,
 *      which is hashes and stays small no matter how large the title is, so
 *      this pass costs one block of disk and still yields the tree hash the
 *      key is derived from;
 *   2. `createOffloader({ core, descriptor, signal })` is asked for a windowed
 *      offloader over the finished core, and then the title is moved into that
 *      core one block at a time, the offloader giving up the oldest end as it
 *      goes.
 *
 * Where pass 2 gets the title decides the mode, and `ingest.mode` reports it:
 *
 *   'reopen'     a re-openable source (`createSource()`, or an array) is read a
 *                second time. Cheapest when the source is a local file: nothing
 *                is uploaded except through the offloader's window.
 *   'streaming'  the source is ONE-SHOT — a network download, a pipe — and
 *                `offload.createStagingStore({ core, signal })` supplied an
 *                object store for the staging core. Pass 1 then uploads each
 *                staged block under the STAGING core's key before dropping it,
 *                and pass 2 reads them back from there. The source is consumed
 *                exactly once, so a relay archives a title larger than its own
 *                volume off a single download.
 *
 * Peak local block data is the offload window plus the single block being moved
 * (its staged copy and its finished copy), whatever the title's size — reported
 * as `ingest.peakLocalBytes`, bounded by `windowBytes + 2 * ASSET_BLOCK_SIZE`.
 *
 * A one-shot source with no staging store is refused with
 * `ASSET_SOURCE_NOT_REOPENABLE` rather than buffered.
 */
export async function writeStaticAsset({
  store,
  source = null,
  createSource = null,
  signal,
  offload = null,
} = {}) {
  assertWriteInput(store, source, createSource)
  const { hook, createOffloader, createStagingStore } = normalizeOffload(offload)
  const resolved = resolveSource({ source, createSource })
  // A source that can be re-opened is re-opened: a caller with a local file
  // should not be pushed through a bucket for pass 2. Streaming is what the
  // one-shot sources get, and only if they brought a staging store.
  const streaming = createOffloader !== null && !resolved.reopenable
  if (streaming && createStagingStore === null) throw sourceNotReopenableError()
  assertNotCancelled(signal)

  const randomId = b4a.toString(crypto.randomBytes(16), 'hex')
  const stagingName = `asset-staging-${randomId}`
  const stagingKeyPair = await store.createKeyPair(stagingName)
  const staging = store.get({ keyPair: stagingKeyPair })

  let finalCore = null
  let descriptor = null
  let ingest = null
  let stagingStore = null
  // How much of the staging core made it to the object store, and how much came
  // back. `uploaded` is what the cleanup has to account for on either path.
  const staged = { uploaded: 0, restored: 0 }
  try {
    try {
      await staging.ready()
      if (streaming) {
        stagingStore = assertStagingStore(await createStagingStore({ core: staging, signal }))
        assertNotCancelled(signal)
      }

      await appendCanonicalSource(staging, resolved.open(), {
        blockSize: ASSET_BLOCK_SIZE,
        signal,
        onAppended: createOffloader === null
          ? null
          : (streaming
              ? (index, block) => offloadStagedBlock({ staging, stagingStore, staged, index, block, signal })
              : (index) => dropStagedBlockData(staging.core.state.storage, index)),
      })

      assertNotCancelled(signal)
      const treeHash = await staging.treeHash()
      assertNotCancelled(signal)
      descriptor = createStaticAssetManifest({
        treeHash,
        blockLength: staging.length,
        byteLength: staging.byteLength,
      })
      finalCore = store.get({
        key: descriptor.key,
        manifest: descriptor.hypercoreManifest,
        writable: false,
      })

      assertNotCancelled(signal)
      if (createOffloader === null) {
        await copyStaticPrologue({
          sourceState: staging.core.state,
          target: finalCore,
        })
      } else {
        // The same prologue copy, with no staged block data left for it to
        // find: the finished core learns its length, byte length and roots up
        // front, so what is handed to createOffloader below is a core that
        // already knows the whole title rather than an empty one that fills in
        // later. Every block then arrives through the same copy, one at a time.
        await copyStaticPrologue({
          sourceState: staging.core.state,
          target: finalCore,
        })
        assertNotCancelled(signal)
        const offloader = assertOffloader(await createOffloader({ core: finalCore, descriptor, signal }))
        assertNotCancelled(signal)
        ingest = streaming
          ? await ingestStagedBlocks({
            staging,
            finalCore,
            descriptor,
            stagingStore,
            staged,
            offloader,
            signal,
          })
          : await ingestBoundedSource({
            staging,
            finalCore,
            descriptor,
            source: resolved.open(),
            offloader,
            signal,
          })
      }
      assertNotCancelled(signal)
      const verified = await verifyStaticAssetDescriptor(finalCore, descriptor)
      assertNotCancelled(signal)
      if (!verified) throw new Error('static asset verification failed')
    } finally {
      await removeStagingCore(staging)
    }

    // The finished core is verified, so the staging objects have carried the
    // title as far as they ever will.
    if (stagingStore !== null) {
      const cleanup = await purgeStagingObjects(stagingStore, staged.uploaded)
      ingest.staging = {
        uploaded: cleanup.uploaded,
        restored: staged.restored,
        deleted: cleanup.deleted,
        orphaned: cleanup.orphaned,
      }
      if (cleanup.error !== null) ingest.staging.error = cleanup.error
    }

    assertNotCancelled(signal)
    if (hook !== null) await hook({ core: finalCore, descriptor, signal })
    assertNotCancelled(signal)
    return ingest === null ? { core: finalCore, descriptor } : { core: finalCore, descriptor, ingest }
  } catch (error) {
    await closeUnreturnedCore(finalCore, error)
    // A failed write must not leave the bucket paying for a staging copy of a
    // title nobody will ever finish. What cannot be deleted is named on the
    // error rather than forgotten.
    if (stagingStore !== null && error !== null && typeof error === 'object') {
      const cleanup = await purgeStagingObjects(stagingStore, staged.uploaded)
      if (cleanup.orphaned.length > 0) {
        error.orphanedStagingKeys = cleanup.orphaned
        if (cleanup.error !== null) error.stagingCleanupError = cleanup.error
      }
    }
    throw error
  }
}

export async function verifyStaticAssetDescriptor(core, descriptor) {
  if (!core || !descriptor) return false

  try {
    const expected = createStaticAssetManifest({
      treeHash: descriptor.treeHash,
      blockLength: descriptor.length,
      byteLength: descriptor.byteLength,
      blockSize: descriptor.blockSize,
    })

    if (descriptor.kind !== STATIC_ASSET_KIND || descriptor.assetId !== expected.assetId) return false
    if (!b4a.equals(normalizeBytes(descriptor.key, 32, 'key'), expected.key)) return false

    await core.ready()
    if (!b4a.equals(normalizeBytes(core.key, 32, 'core.key'), expected.key)) return false
    if (core.length !== expected.length || core.byteLength !== expected.byteLength) return false

    return b4a.equals(normalizeBytes(await core.treeHash(), 32, 'core.treeHash'), expected.treeHash)
  } catch {
    return false
  }
}
