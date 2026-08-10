import b4a from 'b4a'

import { listAssetRanges as listLocalAssetRanges } from './availability.js'
import { normalizeAssetCoreRefV2 } from './rendition.js'
import { createStaticAssetManifest } from './static-core.js'

function expectedBlockBytes(coreRef, index) {
  if (index < coreRef.length - 1) return coreRef.blockSize
  return coreRef.byteLength - ((coreRef.length - 1) * coreRef.blockSize)
}

function assertExactCoreState(core, coreRef) {
  if (core.length !== coreRef.length) throw new Error('asset core length does not match the verified descriptor')
  if (core.byteLength !== coreRef.byteLength) throw new Error('asset core byte length does not match the verified descriptor')
}

export function createAssetSession(options = {}) {
  const coreRef = normalizeAssetCoreRefV2(options.coreRef, 'coreRef')
  const descriptor = createStaticAssetManifest({
    treeHash: coreRef.treeHash,
    blockLength: coreRef.length,
    byteLength: coreRef.byteLength,
    blockSize: coreRef.blockSize,
  })
  if (descriptor.assetId !== coreRef.assetId || b4a.toString(descriptor.key, 'hex') !== coreRef.key) {
    throw new Error('asset key and assetId must match the reconstructed static manifest')
  }

  let core = options.core || null
  let ownsCore = options.ownsCore === true
  if (!core) {
    if (!options.store || typeof options.store.get !== 'function') throw new Error('corestore is required')
    core = options.store.get({
      key: descriptor.key,
      manifest: descriptor.hypercoreManifest,
      writable: false,
    })
    ownsCore = options.ownsCore !== false
  }

  let readyPromise = null
  let closed = false
  let closePromise = null

  async function ready() {
    if (closed) throw new Error('asset session is closed')
    if (!readyPromise) {
      readyPromise = Promise.resolve(core.ready?.()).then(() => {
        const key = core.key
        if (!key || !b4a.equals(b4a.from(key), descriptor.key)) {
          throw new Error('opened asset core key does not match the reconstructed static manifest')
        }
        return core
      })
    }
    return readyPromise
  }

  async function listAssetRanges({ cursor = null, limit } = {}) {
    await ready()
    if (closed) throw new Error('asset session is closed')
    assertExactCoreState(core, coreRef)
    return listLocalAssetRanges({
      assetId: descriptor.key,
      core,
      coreLength: coreRef.length,
      byteLength: coreRef.byteLength,
      cursor,
      limit,
      startBlock: options.startBlock ?? 0,
      endBlock: options.endBlock ?? coreRef.length,
    })
  }

  async function verifyBlock({ index, proof, value } = {}) {
    await ready()
    if (closed) throw new Error('asset session is closed')
    assertExactCoreState(core, coreRef)
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) {
      throw new Error('asset block index exceeds the verified descriptor length')
    }
    if (!b4a.isBuffer(value) || value.byteLength !== expectedBlockBytes(coreRef, index)) {
      throw new Error('asset block value length does not match the verified descriptor')
    }
    if (!proof || typeof proof !== 'object' || !proof.block || proof.block.index !== index || proof.block.value !== null) {
      throw new Error('asset block proof metadata is invalid')
    }
    if (proof.upgrade && proof.upgrade.length !== coreRef.length) {
      throw new Error('asset block proof length does not match the verified descriptor')
    }

    const candidate = {
      ...proof,
      block: { ...proof.block, value },
    }
    let applied
    try {
      applied = await core.applyProof(candidate)
    } catch (cause) {
      throw new Error('asset block proof verification failed', { cause })
    }
    if (applied !== true) throw new Error('asset block proof verification failed')
    if (closed) throw new Error('asset session is closed')
    assertExactCoreState(core, coreRef)
    if (!await core.has(index)) throw new Error('verified asset block was not committed')
    return { index }
  }

  async function close() {
    if (closePromise) return closePromise
    closed = true
    closePromise = ownsCore && typeof core.close === 'function'
      ? Promise.resolve(core.close())
      : Promise.resolve()
    return closePromise
  }

  return {
    assetId: coreRef.assetId,
    coreRef,
    descriptor,
    core,
    ready,
    listAssetRanges,
    verifyBlock,
    close,
  }
}
