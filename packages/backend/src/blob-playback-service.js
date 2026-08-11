import b4a from 'b4a'

import { normalizeAssetCoreRefV2 } from './assets/rendition.js'
import { normalizeBlobRefInput, parseBlobRef } from './blob-ref.js'
import { attachBlobPlaybackProfile } from './blob-playback-profile.js'
import { retainSwarmDiscovery } from './storage.js'

const MEDIA_TYPES = new Map([
  ['m4a', 'audio/mp4'],
  ['mkv', 'video/x-matroska'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['mpegts', 'video/mp2t'],
  ['ts', 'video/mp2t'],
  ['webm', 'video/webm'],
])
const SAFE_MEDIA_TYPE = /^(?:audio|video)\/[A-Za-z0-9][A-Za-z0-9.+-]{0,126}$/

function safeMediaType(value) {
  if (typeof value !== 'string') return 'application/octet-stream'
  const normalized = value.trim().toLowerCase()
  if (SAFE_MEDIA_TYPE.test(normalized)) return normalized
  return MEDIA_TYPES.get(normalized) || 'application/octet-stream'
}

function getCorePeerList(core) {
  const peers = core?.peers
  if (Array.isArray(peers)) return peers
  if (peers && typeof peers.values === 'function') return Array.from(peers.values())
  return []
}

function getCorePeerCount(core) {
  const peers = core?.peers
  if (Array.isArray(peers)) return peers.length
  if (typeof peers?.length === 'number') return peers.length
  if (typeof peers?.size === 'number') return peers.size
  if (peers && typeof peers.values === 'function') return Array.from(peers.values()).length
  return 0
}

function getPeerKey(peer) {
  try {
    const key = peer?.remotePublicKey || peer?.publicKey || peer?.key || peer?.id || peer?.stream?.remotePublicKey
    if (!key) return null
    const hex = typeof key === 'string' ? key : b4a.toString(key, 'hex')
    return /^[a-f0-9]{64}$/i.test(hex) ? hex : null
  } catch {
    return null
  }
}

export class BlobPlaybackService {
  constructor({ ctx, findingPeerLeaseMs = 10_000, maxStaticAssetEntries = 128 }) {
    this.ctx = ctx
    this.findingPeerLeaseMs = Math.max(0, Number(findingPeerLeaseMs) || 0)
    this.findingPeerLeases = new WeakMap()
    this.maxStaticAssetEntries = Number.isSafeInteger(maxStaticAssetEntries) && maxStaticAssetEntries > 0
      ? maxStaticAssetEntries
      : 128
  }

  releaseStaticAssetEntry(entry) {
    if (!entry || entry.released) return
    entry.released = true
    const releases = entry.authorizations instanceof Map
      ? [...entry.authorizations.values()]
      : (typeof entry.release === 'function' ? [entry.release] : [])
    entry.authorizations?.clear?.()
    for (const release of releases) {
      try {
        Promise.resolve(release()).catch(() => {})
      } catch {
        // Static-entry eviction is best effort; the authorization was already removed.
      }
    }
  }

  hasStaticAssetAuthorization(assetId, authorizationKey) {
    if (typeof assetId !== 'string' || typeof authorizationKey !== 'string') return false
    return Boolean(this.ctx?.staticAssetPlaybackEntries
      ?.get(assetId)
      ?.authorizations
      ?.has(authorizationKey))
  }

  resolveDirectBlobUrl({ blobsCoreKey, blobId, mimeType = 'video/mp4' }) {
    const ctx = this.ctx
    const ref = parseBlobRef({ blobsCoreKey, blobId, mimeType })
    if (!ref) {
      if (!blobsCoreKey || String(blobsCoreKey).length !== 64) {
        throw new Error('Invalid blobsCoreKeyHex')
      }
      throw new Error('Invalid blob ID format')
    }

    if (!ctx.blobServer) {
      throw new Error('BlobServer not initialized')
    }

    const keyBuffer = b4a.from(ref.blobsCoreKey, 'hex')
    const url = ctx.blobServer.getLink(keyBuffer, {
      blob: ref.blob,
      type: ref.mimeType || mimeType || 'video/mp4',
      host: ctx.blobServerHost || '127.0.0.1',
      port: ctx.blobServer?.port || ctx.blobServerPort,
    })

    // Join the blob core to swarm discovery so the blob server has peers to
    // stream byte ranges from on demand. This is required for playback — it is
    // not prewarming; no blocks are fetched until the player requests them.
    this.warmDirectBlobRef(ref.blobsCoreKey, keyBuffer)

    // Make the blob's playback profile (keyframe index + moov position)
    // available to range prioritization before the player's first range
    // request: stored profile when this device probed the file, remote
    // header probe otherwise. Best-effort and detached — URL resolution
    // must never wait on it.
    attachBlobPlaybackProfile(ctx, {
      blobsCoreKey: ref.blobsCoreKey,
      blobId: ref.blob,
      mimeType: ref.mimeType || mimeType,
    }).catch(() => {})

    return { url }
  }

  prepareStaticAssetRegistration({ coreRef, scheduler, mimeType = 'video/mp4', authorizationKey, release } = {}) {
    const ctx = this.ctx
    const normalized = normalizeAssetCoreRefV2(coreRef, 'coreRef')
    const existingEntries = ctx.staticAssetPlaybackEntries
    const entries = existingEntries || new Map()
    let entry = entries.get(normalized.assetId)
    const reused = Boolean(entry)
    if (entry) {
      if (entry.coreRef.kind !== normalized.kind ||
          entry.coreRef.key !== normalized.key ||
          entry.coreRef.treeHash !== normalized.treeHash ||
          entry.coreRef.length !== normalized.length ||
          entry.coreRef.byteLength !== normalized.byteLength ||
          entry.coreRef.blockSize !== normalized.blockSize) {
        throw new Error('static playback asset identity collision')
      }
    } else if (typeof scheduler?.requestRange !== 'function' || typeof scheduler?.seek !== 'function') {
      throw new Error('verified static playback scheduler is required')
    }

    const authorizations = entry?.authorizations instanceof Map
      ? entry.authorizations
      : new Map()
    let addAuthorization = false
    if (authorizationKey != null) {
      if (typeof authorizationKey !== 'string' || authorizationKey.length === 0) {
        throw new Error('static playback authorization key is invalid')
      }
      addAuthorization = !authorizations.has(authorizationKey)
      if (addAuthorization && typeof release !== 'function') {
        throw new Error('static playback authorization release is required')
      }
    }
    const effectiveMimeType = entry?.mimeType || safeMediaType(mimeType)
    if (!entry) {
      entry = {
        coreRef: normalized,
        scheduler,
        mimeType: effectiveMimeType,
        authorizations,
        released: false,
      }
    } else if (entry.authorizations !== authorizations) {
      entry.authorizations = authorizations
    }

    const commit = () => {
      if (addAuthorization) authorizations.set(authorizationKey, release)
      if (!existingEntries) ctx.staticAssetPlaybackEntries = entries
      if (reused) {
        entries.delete(normalized.assetId)
        entries.set(normalized.assetId, entry)
      } else {
        entries.set(normalized.assetId, entry)
        while (entries.size > this.maxStaticAssetEntries) {
          const oldestAssetId = entries.keys().next().value
          const oldest = entries.get(oldestAssetId)
          entries.delete(oldestAssetId)
          this.releaseStaticAssetEntry(oldest)
        }
      }
      return { entry, normalized, effectiveMimeType, reused }
    }
    return { entry, normalized, effectiveMimeType, reused, commit }
  }

  resolveStaticAssetUrl(input = {}) {
    const ctx = this.ctx
    if (!ctx?.blobServer?.getLink) throw new Error('BlobServer not initialized')
    const registration = this.prepareStaticAssetRegistration(input)
    const capabilityUrl = ctx.blobServer.getLink(b4a.from(registration.normalized.key, 'hex'), {
      blob: {
        blockOffset: 0,
        blockLength: registration.normalized.length,
        byteOffset: 0,
        byteLength: registration.normalized.byteLength,
      },
      type: registration.effectiveMimeType,
      host: ctx.blobServerHost || '127.0.0.1',
      port: ctx.blobServer?.port || ctx.blobServerPort,
    })
    if (typeof capabilityUrl !== 'string') throw new Error('BlobServer returned an invalid capability URL')
    const separator = capabilityUrl.includes('?') ? '&' : '?'
    const { entry, normalized, reused } = registration.commit()
    return {
      url: `${capabilityUrl}${separator}pt_static_asset=${normalized.assetId}`,
      scheduler: entry.scheduler,
      reused,
    }
  }

  resolveStaticAssetStream(input = {}) {
    if (typeof input.authorizationKey !== 'string' || input.authorizationKey.length === 0) {
      throw new Error('route stream authorization key is required')
    }
    const { entry, normalized, effectiveMimeType } = this.prepareStaticAssetRegistration(input).commit()
    let released = false
    return Object.freeze({
      assetId: normalized.assetId,
      byteLength: normalized.byteLength,
      blockSize: normalized.blockSize,
      mimeType: effectiveMimeType,
      etag: `"${normalized.treeHash}"`,
      seek: request => entry.scheduler.seek(request),
      requestRange: request => entry.scheduler.requestRange(request),
      release: async () => {
        if (released) return false
        released = true
        return this.releaseStaticAssetAuthorization(normalized.assetId, input.authorizationKey)
      },
    })
  }

  async releaseStaticAssetAuthorization(assetId, authorizationKey) {
    const entries = this.ctx?.staticAssetPlaybackEntries
    const entry = entries?.get(assetId)
    const release = entry?.authorizations instanceof Map
      ? entry.authorizations.get(authorizationKey)
      : null
    if (typeof release !== 'function') return false
    entry.authorizations.delete(authorizationKey)
    try {
      await release()
    } finally {
      if (entry.authorizations.size === 0 && entries.get(assetId) === entry) {
        entries.delete(assetId)
        entry.released = true
      }
    }
    return true
  }

  scheduleFindingPeerRelease(core, lease) {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(() => {
      if (this.findingPeerLeases.get(core) !== lease) return
      this.findingPeerLeases.delete(core)
      try {
        lease.done()
      } catch {
        // Discovery teardown is best effort after the lease has left the registry.
      }
    }, this.findingPeerLeaseMs)
    lease.timer.unref?.()
  }

  retainFindingPeers(core) {
    if (!core || typeof core.findingPeers !== 'function') return

    const activeLease = this.findingPeerLeases.get(core)
    if (activeLease) {
      this.scheduleFindingPeerRelease(core, activeLease)
      return
    }

    let done
    try {
      done = core.findingPeers()
    } catch {
      return
    }
    if (typeof done !== 'function') return

    const lease = { done, timer: null }
    this.findingPeerLeases.set(core, lease)
    this.scheduleFindingPeerRelease(core, lease)
  }

  getBlobCore(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex')) {
    const ctx = this.ctx
    if (!ctx.store) return null
    try {
      return ctx.store.get({ key: keyBuffer })
    } catch {
      return null
    }
  }

  warmDirectBlobRef(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex')) {
    const blobsCore = this.getBlobCore(blobsCoreKey, keyBuffer)
    this.retainBlobCorePeers(blobsCoreKey, blobsCore).catch(() => {})
  }

  async retainBlobCorePeers(blobsCoreKey, blobsCore = this.getBlobCore(blobsCoreKey)) {
    const ctx = this.ctx
    if (!blobsCore) return { peerCount: 0, blobPeerIds: [], retained: false, retainedDiscoveryStatus: 'core-unavailable' }

    try {
      await blobsCore.ready()
      this.retainFindingPeers(blobsCore)
      const label = `blobs:${String(blobsCoreKey).slice(0, 16)}`
      let retained = false
      if (ctx.swarm && blobsCore.discoveryKey) {
        retained = Boolean(retainSwarmDiscovery(ctx, blobsCore.discoveryKey, { label }))
      }
      blobsCore.update().catch(() => {})
      const peers = getCorePeerList(blobsCore)
      return {
        peerCount: getCorePeerCount(blobsCore),
        blobPeerIds: peers.map(getPeerKey).filter(Boolean),
        retained,
        retainedDiscoveryLabel: label,
        retainedDiscoveryStatus: retained ? 'retained' : 'not-retained',
      }
    } catch {
      return { peerCount: getCorePeerCount(blobsCore), blobPeerIds: [], retained: false, retainedDiscoveryStatus: 'error' }
    }
  }

  async resolveFromMetadata(meta, { channel } = {}) {
    if (!meta) {
      throw new Error('Video metadata not found')
    }
    if (!meta.blobId) {
      throw new Error('Video is missing blobId (not synced yet)')
    }

    const directRef = parseBlobRef(meta)
    if (directRef) {
      return this.resolveDirectBlobUrl(directRef)
    }

    if (!channel || typeof channel.getBlobEntry !== 'function') {
      throw new Error('Failed to load channel')
    }

    const blobEntry = await channel.getBlobEntry(meta)
    if (!blobEntry?.blobsKey) {
      throw new Error('Video blob not accessible (not synced yet)')
    }

    const blobsCoreKey = b4a.toString(blobEntry.blobsKey, 'hex')
    const blobId = normalizeBlobRefInput(blobEntry.blobId) || normalizeBlobRefInput(meta.blobId)
    return this.resolveDirectBlobUrl({
      blobsCoreKey,
      blobId,
      mimeType: meta.mimeType || 'video/mp4',
    })
  }

  /**
   * Resolve a playable blob-server URL and return it immediately. Playback is
   * pure on-demand streaming: the URL points at the local blob server, which
   * fetches byte ranges from peers as the player requests them. No head-block
   * warmup or peer pre-fetching happens here.
   */
  async preparePlayback({
    driveKey,
    videoPath,
    publicBeeKey,
    blobId,
    blobsCoreKey,
    mimeType,
    resolveUrl,
    getStats,
  }) {
    const result = resolveUrl
      ? await resolveUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      : this.resolveDirectBlobUrl({ blobsCoreKey, blobId, mimeType })

    return {
      url: result.url,
      stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
    }
  }
}

export function createBlobPlaybackService(ctx) {
  return new BlobPlaybackService({
    ctx,
    maxStaticAssetEntries: ctx?.maxStaticAssetPlaybackEntries,
  })
}
