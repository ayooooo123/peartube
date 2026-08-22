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

function assertWriteInput(store, source) {
  if (!store || typeof store.get !== 'function') throw new Error('store is required')
  if (!source || (
    typeof source[Symbol.asyncIterator] !== 'function' &&
    typeof source[Symbol.iterator] !== 'function'
  )) {
    throw new Error('source is required')
  }
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

async function appendCanonicalSource(core, source, { blockSize, signal }) {
  let partial = null
  let partialLength = 0

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
        await core.append(partial)
        assertNotCancelled(signal)
        partial = null
        partialLength = 0
      }
    }

    while (chunk.byteLength - offset >= blockSize) {
      await core.append(chunk.subarray(offset, offset + blockSize))
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
  if (partialLength > 0) await core.append(partial.subarray(0, partialLength))
  assertNotCancelled(signal)
}

async function copyStaticPrologue({ sourceState, target }) {
  await target.ready()
  // Hypercore 11.35.1 exposes this internal operation as Core.copyPrologue(sourceState).
  await target.core.copyPrologue(sourceState)
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
 * `offload` is optional and, when absent, this function behaves byte for byte
 * as it always has. When supplied it is `({ core, descriptor, signal })` and is
 * called once, on the finished asset core, after the prologue has been copied
 * and the descriptor verified — the first moment every block is durably
 * written, every merkle leaf exists, and the core's key is the content-
 * addressed key the network will ask for. It runs after the staging core is
 * removed, so the staging bytes are already back on the volume before a single
 * byte is uploaded.
 *
 * It cannot run earlier. The prologue copy reads the staging core through
 * `storage.createBlockStream()`, which is not the restoring read path that
 * offload-storage.js intercepts, so staging block data has to stay resident
 * until the copy completes.
 */
export async function writeStaticAsset({ store, source, signal, offload = null } = {}) {
  assertWriteInput(store, source)
  if (offload !== null && typeof offload !== 'function') {
    throw new Error('offload must be a function')
  }
  assertNotCancelled(signal)

  const randomId = b4a.toString(crypto.randomBytes(16), 'hex')
  const stagingName = `asset-staging-${randomId}`
  const stagingKeyPair = await store.createKeyPair(stagingName)
  const staging = store.get({ keyPair: stagingKeyPair })

  let finalCore = null
  let descriptor = null
  try {
    try {
      await staging.ready()
      await appendCanonicalSource(staging, source, {
        blockSize: ASSET_BLOCK_SIZE,
        signal,
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
      await copyStaticPrologue({
        sourceState: staging.core.state,
        target: finalCore,
      })
      assertNotCancelled(signal)
      const verified = await verifyStaticAssetDescriptor(finalCore, descriptor)
      assertNotCancelled(signal)
      if (!verified) throw new Error('static asset verification failed')
    } finally {
      await removeStagingCore(staging)
    }

    assertNotCancelled(signal)
    if (offload !== null) await offload({ core: finalCore, descriptor, signal })
    assertNotCancelled(signal)
    return { core: finalCore, descriptor }
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
