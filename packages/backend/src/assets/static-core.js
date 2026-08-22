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
 *   { createOffloader }  bounded ingest — see writeStaticAsset.
 */
function normalizeOffload(offload) {
  if (offload === null || offload === undefined) return { hook: null, createOffloader: null }
  if (typeof offload === 'function') return { hook: offload, createOffloader: null }
  if (typeof offload === 'object' && typeof offload.createOffloader === 'function') {
    return { hook: null, createOffloader: (input) => offload.createOffloader(input) }
  }
  throw new Error('offload must be a function or an object with createOffloader()')
}

function assertOffloader(offloader) {
  if (!offloader || typeof offloader.track !== 'function' || typeof offloader.drain !== 'function') {
    throw new Error('createOffloader() must return a block offloader with track() and drain()')
  }
  return offloader
}

function sourceNotReopenableError() {
  const error = new Error(
    'bounded offload ingest reads the source twice and this source can only be read once: pass createSource(), a function returning a fresh iterable, instead of a one-shot source'
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
 * `onAppended(index, byteLength)` is optional and, when absent, this is the
 * append loop it always was. Bounded ingest uses it to drop each staged
 * block's DATA the moment the block is durably written, keeping the merkle tree
 * the append built and nothing else.
 */
async function appendCanonicalSource(core, source, { blockSize, signal, onAppended = null }) {
  await eachCanonicalBlock(source, {
    blockSize,
    signal,
    async onBlock(block, index) {
      await core.append(block)
      if (onAppended !== null) await onAppended(index, block.byteLength)
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
 * Second pass: re-read the source and move it into the finished core one block
 * at a time, giving each block up to the object store as soon as the window
 * says so.
 *
 * Per block: stage the bytes, transplant them, drop the staged copy, then let
 * the offloader take the oldest end. So the only block data on local disk at
 * any moment is the window the offloader has not given up yet plus the one
 * block being moved — never the title.
 *
 * The bytes are checked against the staged tree BEFORE they are written.
 * `copyPrologue` verifies the source core's roots against the prologue, but it
 * does not hash the block data it copies, so a source that read back
 * differently on the second pass would otherwise put bytes the tree does not
 * commit to into a core whose key says otherwise — unprovable to every peer
 * that asked for it. A mismatch fails the write instead.
 */
async function ingestBoundedSource({ staging, finalCore, descriptor, source, offloader, signal }) {
  const stagingStorage = staging.core.state.storage
  let blocks = 0
  let bytes = 0
  let peakLocalBytes = 0

  await eachCanonicalBlock(source, {
    blockSize: ASSET_BLOCK_SIZE,
    signal,
    async onBlock(block, index) {
      if (index >= descriptor.length) {
        throw sourceChangedError(`block ${index} is past the end of the tree the asset key was derived from`, index)
      }
      const expectedHash = await stagedLeafHash(stagingStorage, index)
      if (expectedHash === null) {
        throw sourceChangedError(`block ${index} has no leaf in the tree the asset key was derived from`, index)
      }
      if (!b4a.equals(crypto.data(block), expectedHash)) {
        throw sourceChangedError(`block ${index} does not match the tree the asset key was derived from`, index)
      }

      // Both copies of this block are on local disk between the two writes
      // below: the staged one the transplant reads and the final one it writes.
      // That pair, on top of the window the offloader has not given up yet, is
      // the peak this whole path exists to bound.
      const local = residentBytesOf(offloader) + (2 * block.byteLength)
      if (local > peakLocalBytes) peakLocalBytes = local

      await putStagedBlockData(stagingStorage, index, block)
      assertNotCancelled(signal)
      await copyStaticPrologue({ sourceState: staging.core.state, target: finalCore })
      assertNotCancelled(signal)
      // Redundant now rather than lost: the finished core holds it durably, and
      // nothing has been uploaded yet, so no local delete here can be the
      // delete of a block whose only other copy is remote.
      await dropStagedBlockData(stagingStorage, index)
      assertNotCancelled(signal)

      offloader.track(index, block.byteLength)
      await offloader.drain()
      assertNotCancelled(signal)

      blocks++
      bytes += block.byteLength
    },
  })

  if (blocks !== descriptor.length || bytes !== descriptor.byteLength) {
    throw sourceChangedError(
      `it ended at ${blocks} block(s) and ${bytes} byte(s), but the asset key was derived from ${descriptor.length} block(s) and ${descriptor.byteLength} byte(s)`,
      blocks
    )
  }

  if (blocks > 0) {
    // `copyPrologue` sets the contiguous-length hint from the run of blocks one
    // call saw, and here every call sees exactly one, so the finished core is
    // told the truth once at the end. It is only a fast path — a full core
    // answers `has()` for every block either way — but a core that lies about
    // it is a core somebody debugs twice.
    finalCore.core.updateContiguousLength({ drop: false, start: 0, length: 1 })
    await finalCore.core.flushHints()
  }

  return {
    blocks,
    bytes,
    peakLocalBytes,
    windowBytes: Number.isSafeInteger(offloader.windowBytes) ? offloader.windowBytes : null,
    offload: typeof offloader.stats === 'function' ? offloader.stats() : null,
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
 * function, and `offload` decides which of the two shapes it takes.
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
 *      offloader over the finished core, and then the source is re-read and
 *      moved into that core one block at a time, the offloader giving up the
 *      oldest end as it goes (see ingestBoundedSource).
 *
 * Peak local block data is then the offload window plus the single block being
 * moved, whatever the title's size — reported as `ingest.peakLocalBytes`.
 *
 * Pass 2 needs the source again, so bounded ingest requires `createSource()`
 * (or an array); a one-shot source is refused rather than buffered.
 */
export async function writeStaticAsset({
  store,
  source = null,
  createSource = null,
  signal,
  offload = null,
} = {}) {
  assertWriteInput(store, source, createSource)
  const { hook, createOffloader } = normalizeOffload(offload)
  const resolved = resolveSource({ source, createSource })
  if (createOffloader !== null && !resolved.reopenable) throw sourceNotReopenableError()
  assertNotCancelled(signal)

  const randomId = b4a.toString(crypto.randomBytes(16), 'hex')
  const stagingName = `asset-staging-${randomId}`
  const stagingKeyPair = await store.createKeyPair(stagingName)
  const staging = store.get({ keyPair: stagingKeyPair })

  let finalCore = null
  let descriptor = null
  let ingest = null
  try {
    try {
      await staging.ready()
      await appendCanonicalSource(staging, resolved.open(), {
        blockSize: ASSET_BLOCK_SIZE,
        signal,
        onAppended: createOffloader === null
          ? null
          : (index) => dropStagedBlockData(staging.core.state.storage, index),
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
        ingest = await ingestBoundedSource({
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

    assertNotCancelled(signal)
    if (hook !== null) await hook({ core: finalCore, descriptor, signal })
    assertNotCancelled(signal)
    return ingest === null ? { core: finalCore, descriptor } : { core: finalCore, descriptor, ingest }
  } catch (error) {
    await closeUnreturnedCore(finalCore, error)
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
