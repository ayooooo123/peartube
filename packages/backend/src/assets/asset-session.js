import b4a from 'b4a'

import { listAssetRanges as listLocalAssetRanges } from './availability.js'
import { normalizeAssetCoreRefV2 } from './rendition.js'
import { createStaticAssetManifest } from './static-core.js'

function expectedBlockBytes(coreRef, index) {
  if (index < coreRef.length - 1) return coreRef.blockSize
  return coreRef.byteLength - ((coreRef.length - 1) * coreRef.blockSize)
}

function exactCoreState(core, coreRef) {
  return core.length === coreRef.length && core.byteLength === coreRef.byteLength
}

function emptyCoreState(core) {
  return core.length === 0 && core.byteLength === 0
}

function assertExactCoreState(core, coreRef) {
  if (core.length !== coreRef.length) throw new Error('asset core length does not match the verified descriptor')
  if (core.byteLength !== coreRef.byteLength) throw new Error('asset core byte length does not match the verified descriptor')
}

function assertActive(isActive, message) {
  if (typeof isActive === 'function' && !isActive()) throw new Error(message)
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

  const store = options.store?.get ? options.store : null
  const injected = options.core != null
  let core = options.core || null
  let ownsCore = options.ownsCore === true
  let readyPromise = null
  let quarantinePromise = null
  let permanentlyPoisoned = false
  let closed = false
  let closePromise = null
  let verificationQueue = Promise.resolve()
  const quarantines = new WeakMap()

  function openExactCore() {
    if (!store) throw new Error('asset session core is poisoned')
    const opened = store.get({
      key: descriptor.key,
      manifest: descriptor.hypercoreManifest,
      writable: false,
    })
    ownsCore = true
    return opened
  }

  if (!core) core = openExactCore()
  function validateProofMetadata({ index, proof, byteLength } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) {
      throw new Error('asset block index exceeds the verified descriptor length')
    }
    const expectedBytes = expectedBlockBytes(coreRef, index)
    if (byteLength !== expectedBytes) {
      throw new Error('asset block value length does not match the verified descriptor')
    }
    if (!proof || typeof proof !== 'object' || !proof.block || proof.block.index !== index || proof.block.value !== null) {
      throw new Error('asset block proof metadata is invalid')
    }
    if (proof.upgrade && (proof.upgrade.length !== coreRef.length || proof.upgrade.start !== 0)) {
      throw new Error('asset block proof length does not match the verified descriptor')
    }
    return expectedBytes
  }


  async function quarantineCore(handle, cause) {
    if (!handle || typeof handle !== 'object') return
    const existing = quarantines.get(handle)
    if (existing) return existing
    if (core === handle) {
      core = null
      readyPromise = null
      if (injected) permanentlyPoisoned = true
    }
    const operation = (async () => {
      let callbackError = null
      try {
        await options.onQuarantine?.({ cause, core: handle, permanent: injected })
      } catch (error) {
        callbackError = error
      }
      let closeError = null
      try {
        await handle.close?.()
      } catch (error) {
        closeError = error
      }
      if (callbackError || closeError) {
        throw new AggregateError(
          [callbackError, closeError].filter(Boolean),
          'asset core quarantine failed'
        )
      }
    })()
    quarantines.set(handle, operation)
    quarantinePromise = operation
    try {
      await operation
    } finally {
      if (quarantinePromise === operation) quarantinePromise = null
    }
  }

  async function ready() {
    if (closed) throw new Error('asset session is closed')
    if (permanentlyPoisoned) throw new Error('asset session core is poisoned')
    if (quarantinePromise) await quarantinePromise
    if (closed) throw new Error('asset session is closed')
    if (permanentlyPoisoned) throw new Error('asset session core is poisoned')
    if (!core) core = openExactCore()
    const handle = core
    if (!readyPromise) {
      readyPromise = Promise.resolve(handle.ready?.()).then(() => {
        const key = handle.key
        if (!key || !b4a.equals(b4a.from(key), descriptor.key)) {
          throw new Error('opened asset core key does not match the reconstructed static manifest')
        }
        return handle
      })
    }
    try {
      return await readyPromise
    } catch (error) {
      await quarantineCore(handle, error)
      throw error
    }
  }

  async function listAssetRanges({ cursor = null, limit, isActive } = {}) {
    assertActive(isActive, 'asset inventory scan was cancelled')
    const handle = await ready()
    assertActive(isActive, 'asset inventory scan was cancelled')
    if (closed) throw new Error('asset session is closed')
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    return listLocalAssetRanges({
      assetId: descriptor.key,
      core: handle,
      coreLength: coreRef.length,
      byteLength: coreRef.byteLength,
      cursor,
      limit,
      startBlock: options.startBlock ?? 0,
      endBlock: options.endBlock ?? coreRef.length,
      isActive,
    })
  }

  async function hasVerifiedBlock(index, { isActive } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) {
      throw new Error('asset block index exceeds the verified descriptor length')
    }
    assertActive(isActive, 'asset block request is closed')
    const handle = await ready()
    assertActive(isActive, 'asset block request is closed')
    if (emptyCoreState(handle)) return false
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    let present
    try {
      present = await handle.has(index)
    } catch (cause) {
      await quarantineCore(handle, cause)
      throw cause
    }
    assertActive(isActive, 'asset block request is closed')
    return present === true
  }

  async function verifyBlockOnce({ index, proof, value, isActive } = {}) {
    assertActive(isActive, 'asset block request is closed')
    const handle = await ready()
    if (closed) throw new Error('asset session is closed')
    assertActive(isActive, 'asset block request is closed')

    const stateIsExact = exactCoreState(handle, coreRef)
    if (!stateIsExact && !emptyCoreState(handle)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    validateProofMetadata({ index, proof, byteLength: b4a.isBuffer(value) ? value.byteLength : null })
    if (!stateIsExact && !proof.upgrade) {
      throw new Error('fresh asset core requires an exact descriptor-length upgrade proof')
    }
    assertActive(isActive, 'asset block request is closed')

    const candidate = {
      ...proof,
      block: { ...proof.block, value },
    }
    let applied
    try {
      applied = await handle.applyProof(candidate)
    } catch (cause) {
      await quarantineCore(handle, cause)
      throw new Error('asset block proof verification failed', { cause })
    }
    if (applied !== true) {
      const cause = new Error('core.applyProof rejected the asset block')
      await quarantineCore(handle, cause)
      throw new Error('asset block proof verification failed', { cause })
    }

    try {
      assertExactCoreState(handle, coreRef)
      if (!await handle.has(index)) throw new Error('verified asset block was not committed')
    } catch (cause) {
      await quarantineCore(handle, cause)
      throw new Error('asset block proof verification failed', { cause })
    }
    if (closed) throw new Error('asset session is closed')
    if (typeof isActive === 'function' && !isActive()) throw new Error('asset block request is closed')
    return { index }
  }

  function verifyBlock(input = {}) {
    const operation = verificationQueue.then(() => verifyBlockOnce(input))
    verificationQueue = operation.catch(() => {})
    return operation
  }

  async function close() {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      await verificationQueue
      if (quarantinePromise) await quarantinePromise
      const handle = core
      core = null
      readyPromise = null
      if (handle && ownsCore) await handle.close?.()
    })()
    return closePromise
  }

  return {
    assetId: coreRef.assetId,
    coreRef,
    descriptor,
    get core() { return core },
    get poisoned() { return permanentlyPoisoned },
    ready,
    validateProofMetadata,
    hasVerifiedBlock,
    listAssetRanges,
    verifyBlock,
    close,
  }
}
