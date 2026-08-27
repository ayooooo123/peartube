import b4a from 'b4a'

import { createPlaybackError } from '../playback/errors.js'
import { createVerifiedBlockEngine } from '../network/verified-block-engine.js'
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
        try { core?.close?.() } catch { /* Best-effort session cleanup. */ }
      }
      active.clear()
    },
  }
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
  const engine = createVerifiedBlockEngine()
  const source = engine.createSource({
    resourceId: coreRef.assetId,
    coreRef,
    descriptor,
    store: options.store,
    core: options.core,
    ownsCore: options.ownsCore,
    onQuarantine: options.onQuarantine,
  })

  const session = {
    assetId: coreRef.assetId,
    coreRef,
    descriptor,
    get core() { return source.core },
    get poisoned() { return source.poisoned },
    ready: source.ready,
    validateProofMetadata: source.validateProofMetadata,
    hasVerifiedBlock: source.has,
    readVerifiedBlock: source.read,
    async listAssetRanges({ cursor = null, limit, isActive } = {}) {
      return source.listRanges({
        cursor,
        limit,
        isActive,
        list: ({ core, cursor, limit, isActive }) => listLocalAssetRanges({
          assetId: descriptor.key,
          core,
          coreLength: coreRef.length,
          byteLength: coreRef.byteLength,
          cursor,
          limit,
          startBlock: options.startBlock ?? 0,
          endBlock: options.endBlock ?? coreRef.length,
          isActive,
        }),
      })
    },
    verifyBlock: source.apply,
    async close() {
      await source.close()
      await engine.close()
    },
  }
  Object.defineProperties(session, {
    blockEngine: { value: engine },
    blockSource: { value: source },
  })
  return session
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
