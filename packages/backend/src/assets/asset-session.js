import { renditionDrmRejectionCode } from '../playback/drm-capability.js'
import { createPlaybackError } from '../playback/errors.js'

const DEFAULT_MAX_ACTIVE_CORES = 4

function coreKeyOf(rendition = {}) {
  return rendition.core?.key || rendition.coreKey || null
}

function normalizeKey(value) {
  const next = String(value || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(next) ? next : null
}

function coreLengthOf(rendition = {}) {
  const length = Number(rendition.core?.length ?? rendition.coreLength)
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
 *
 * `capabilities` is what this device can decrypt, and a protected rendition is
 * authorized only when it names a DRM system that list claims. The selector
 * already refuses such a source, so reaching this check means something skipped
 * selection: the session refuses rather than opening the core, because opening
 * it is what starts pulling ciphertext nothing on this device can play. There
 * is no capability, key, or license held here — only the public system name off
 * the signed descriptor.
 */
export function createAssetSession(options = {}) {
  const renditions = new Map()
  const active = new Map()
  const openCore = typeof options.openCore === 'function' ? options.openCore : async key => key
  const capabilities = options.capabilities || {}
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
      // Before the core opens, not after: a bounded code lets preparation stop
      // instead of reporting a range mismatch for a device-capability fact.
      const drmRejection = renditionDrmRejectionCode(rendition, capabilities)
      if (drmRejection) throw createPlaybackError(drmRejection)
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
