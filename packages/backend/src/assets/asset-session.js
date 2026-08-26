import b4a from 'b4a'

import { createPlaybackError } from '../playback/errors.js'
import { listAssetRanges as listLocalAssetRanges } from './availability.js'
import { normalizeAssetCoreRefV2 } from './rendition.js'
import { createStaticAssetManifest } from './static-core.js'

const DEFAULT_MAX_ACTIVE_CORES = 4

function coreKeyOf(rendition = {}) {
  let coreRef
  try {
    coreRef = normalizeAssetCoreRefV2(rendition.core)
  } catch {
    coreRef = null
  }
  return coreRef?.key || rendition.core?.key || rendition.coreKey || null
}

function normalizeKey(value) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    return value.byteLength === 32 ? b4a.toString(value, 'hex') : null
  }
  const next = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(next) ? next : null
}

function coreLengthOf(rendition = {}) {
  let coreRef
  try {
    coreRef = normalizeAssetCoreRefV2(rendition.core)
  } catch {
    coreRef = null
  }
  const length = Number(coreRef?.length ?? rendition.core?.length ?? rendition.coreLength)
  return Number.isSafeInteger(length) && length > 0 ? length : 0
}
function normalizeRange(range = {}) {
  const start = Number(range.start)
  const end = Number(range.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null
  return { start, end }
}

/**
 * A scoped asset session: the only door remote media bytes come through.
 *
 * The scope is one signed manifest. A session opens the exact immutable cores
 * that manifest names and nothing else, refuses reads outside a rendition's
 * declared block range, and caps how many cores one session may hold open. It
 * has no notion of a URL, an origin, or a fallback: there is no code path here
 * that can fetch bytes over HTTP.
 */
function createManifestAssetSession(options) {
  const renditions = new Map()
  const active = new Map()
  const openCore = typeof options.openCore === 'function' ? options.openCore : async key => key
  const maxActiveCores = Number.isSafeInteger(options.maxActiveCores) && options.maxActiveCores > 0
    ? options.maxActiveCores
    : DEFAULT_MAX_ACTIVE_CORES
  let closed = false

  for (const rendition of options.manifest?.body?.renditions || []) {
    if (!rendition?.renditionId) continue
    renditions.set(rendition.renditionId, rendition)
  }

  function authorizedRendition(renditionId) {
    const rendition = renditions.get(renditionId)
    if (!rendition || rendition.blocked || rendition.superseded) return null
    return rendition
  }

  return {
    async authorizeCore({ renditionId, coreKey } = {}) {
      if (closed) return false
      const rendition = authorizedRendition(renditionId)
      if (!rendition) return false
      const expected = normalizeKey(coreKeyOf(rendition))
      const requested = normalizeKey(coreKey)
      if (!expected || !requested || expected !== requested) return false
      if (active.has(renditionId)) return true
      // A session that would exceed its core budget fails with a bounded code
      // instead of quietly holding more of the device's resources.
      if (active.size >= maxActiveCores) throw createPlaybackError('SESSION_LIMIT')
      active.set(renditionId, await openCore(requested, { rendition }))
      return true
    },

    /**
     * Every read is checked against the rendition's signed block range. A
     * request past the manifest's declared length is a range mismatch, not a
     * short read, so preparation can move to another equivalent source.
     */
    authorizeRange({ renditionId, range } = {}) {
      if (closed) return false
      const rendition = authorizedRendition(renditionId)
      if (!rendition || !active.has(renditionId)) return false
      const target = normalizeRange(range)
      if (!target) return false
      const length = coreLengthOf(rendition)
      return length > 0 && target.end <= length
    },

    isAuthorizedCore(coreKey) {
      const requested = normalizeKey(coreKey)
      if (!requested) return false
      for (const rendition of renditions.values()) {
        if (rendition.blocked || rendition.superseded) continue
        if (normalizeKey(coreKeyOf(rendition)) === requested) return true
      }
      return false
    },

    activeCoreCount() {
      return active.size
    },

    close() {
      closed = true
      for (const core of active.values()) {
        try { core?.close?.() } catch {}
      }
      active.clear()
    },
  }
}

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

function createStaticAssetSession(options) {
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
  let readyHandle = null
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
  function validateProofMetadata({ index, proof, byteLength, peerId = null, transferId = null } = {}) {
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
    const handle = core
    if (!handle || readyHandle !== handle) throw new Error('asset session core is not ready')
    if (emptyCoreState(handle)) {
      if (!proof.upgrade || proof.upgrade.start !== 0 || proof.upgrade.length !== coreRef.length) {
        throw new Error('fresh asset core requires an exact descriptor-length upgrade proof')
      }
    } else if (!exactCoreState(handle, coreRef)) {
      const cause = new Error('asset core state conflicts with the verified descriptor')
      return quarantineCore(handle, cause, { peerId, transferId }).then(
        () => { throw cause },
        error => { throw error },
      )
    } else if (proof.upgrade && (proof.upgrade.length !== coreRef.length || proof.upgrade.start !== 0)) {
      throw new Error('asset block proof length does not match the verified descriptor')
    }
    return expectedBytes
  }


  async function quarantineCore(handle, cause, context = null) {
    if (!handle || typeof handle !== 'object') return
    const existing = quarantines.get(handle)
    if (existing) return existing
    if (core === handle) {
      core = null
      readyPromise = null
      readyHandle = null
      if (injected) permanentlyPoisoned = true
    }
    const operation = (async () => {
      let closeError = null
      try {
        await handle.close?.()
      } catch (error) {
        closeError = error
      }
      let callbackError = null
      try {
        await options.onQuarantine?.({ cause, context, core: handle, permanent: injected })
      } catch (error) {
        callbackError = error
      }
      if (callbackError || closeError) {
        throw new AggregateError(
          [closeError, callbackError].filter(Boolean),
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
        readyHandle = handle
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

  async function readVerifiedBlock(index, { isActive } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coreRef.length) {
      throw new Error('asset block index exceeds the verified descriptor length')
    }
    assertActive(isActive, 'asset block read is closed')
    const handle = await ready()
    assertActive(isActive, 'asset block read is closed')
    if (!exactCoreState(handle, coreRef)) {
      if (emptyCoreState(handle)) throw new Error('verified asset block is unavailable')
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    let present
    let value
    try {
      present = await handle.has(index)
      assertActive(isActive, 'asset block read is closed')
      if (!present) throw new Error('verified asset block is unavailable')
      value = await handle.get(index, { wait: false })
    } catch (cause) {
      if (cause?.message === 'verified asset block is unavailable') throw cause
      await quarantineCore(handle, cause)
      throw cause
    }
    assertActive(isActive, 'asset block read is closed')
    if (!b4a.isBuffer(value) || value.byteLength !== expectedBlockBytes(coreRef, index)) {
      const error = new Error('verified asset block does not match the descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    if (!exactCoreState(handle, coreRef)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error)
      throw error
    }
    return value
  }

  async function verifyBlockOnce({ index, proof, value, peerId = null, transferId = null, isActive } = {}) {
    assertActive(isActive, 'asset block request is closed')
    const handle = await ready()
    if (closed) throw new Error('asset session is closed')
    assertActive(isActive, 'asset block request is closed')

    const stateIsExact = exactCoreState(handle, coreRef)
    if (!stateIsExact && !emptyCoreState(handle)) {
      const error = new Error('asset core state conflicts with the verified descriptor')
      await quarantineCore(handle, error, { peerId, transferId })
      throw error
    }
    const metadataValidation = validateProofMetadata({
      index,
      proof,
      byteLength: b4a.isBuffer(value) ? value.byteLength : null,
      peerId,
      transferId,
    })
    if (metadataValidation && typeof metadataValidation.then === 'function') await metadataValidation
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
      await quarantineCore(handle, cause, { peerId, transferId })
      throw new Error('asset block proof verification failed', { cause })
    }
    if (applied !== true) {
      const cause = new Error('core.applyProof rejected the asset block')
      await quarantineCore(handle, cause, { peerId, transferId })
      throw new Error('asset block proof verification failed', { cause })
    }

    try {
      assertExactCoreState(handle, coreRef)
      if (!await handle.has(index)) throw new Error('verified asset block was not committed')
    } catch (cause) {
      await quarantineCore(handle, cause, { peerId, transferId })
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
      readyHandle = null
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
    readVerifiedBlock,
    listAssetRanges,
    verifyBlock,
    close,
  }
}

/**
 * Two session shapes share this door.
 *
 * A `coreRef` names one verified static asset core: the archive/transfer path
 * that proves individual blocks against a reconstructed static manifest. A
 * `manifest` names a set of signed renditions: the playback path that opens
 * only the cores that manifest declares, within their signed block ranges.
 */
export function createAssetSession(options = {}) {
  if (options.coreRef != null) return createStaticAssetSession(options)
  return createManifestAssetSession(options)
}
