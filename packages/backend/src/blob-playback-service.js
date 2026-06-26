import b4a from 'b4a'

import { normalizeBlobRefInput, parseBlobRef } from './blob-ref.js'
import { attachBlobPlaybackProfile } from './blob-playback-profile.js'
import { prefetchBlobPlaybackStart } from './blob-range-priority.js'
import { retainSwarmDiscovery } from './storage.js'

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
  constructor({ ctx }) {
    this.ctx = ctx
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

    // Eagerly pull the opening GOPs (byte 0 forward) the moment playback is
    // prepared, so the native player's first range request lands against
    // already-downloading bytes instead of a cold P2P round trip. Profile-free
    // and runs in parallel with the probe below. Detached — URL resolution
    // must never wait on it.
    this.prefetchPlaybackStart(ref.blobsCoreKey, keyBuffer, ref.blob, null).catch(() => {})

    // Make the blob's playback profile (keyframe index + moov position)
    // available to range prioritization before the player's first range
    // request: stored profile when this device probed the file, remote
    // header probe otherwise. Once known, eagerly pull the tail moov for
    // back-moov MP4s — the very first thing the player blocks on — so it is
    // local before the player asks. Best-effort and detached.
    attachBlobPlaybackProfile(ctx, {
      blobsCoreKey: ref.blobsCoreKey,
      blobId: ref.blob,
      mimeType: ref.mimeType || mimeType,
    }).then((profile) => {
      if (profile?.moovPosition === 'back') {
        return this.prefetchPlaybackStart(ref.blobsCoreKey, keyBuffer, ref.blob, profile, {
          startPrefetchBytes: 0,
        })
      }
    }).catch(() => {})

    return { url }
  }

  getBlobCore(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex')) {
    const ctx = this.ctx
    if (!ctx.store) return null
    try {
      return ctx.store.get(keyBuffer)
    } catch {
      return null
    }
  }

  warmDirectBlobRef(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex')) {
    const blobsCore = this.getBlobCore(blobsCoreKey, keyBuffer)
    this.retainBlobCorePeers(blobsCoreKey, blobsCore).catch(() => {})
  }

  /**
   * Eagerly download the bytes the player needs to begin rendering (opening
   * GOPs, and the tail moov for back-moov MP4s) before the player issues its
   * first range request. Opens a short-lived core session, runs the bounded
   * prefetch, then closes it; downloaded blocks persist in shared storage for
   * the blob server to serve. Best-effort — never throws, never blocks the URL.
   *
   * @param {string} blobsCoreKey
   * @param {Buffer} [keyBuffer]
   * @param {Object} blob - blob descriptor ({ blockOffset, blockLength, byteLength, ... })
   * @param {Object|null} [profile] - playback profile (keyframe index + moov position)
   * @param {Object} [options] - forwarded to prefetchBlobPlaybackStart (e.g. startPrefetchBytes)
   */
  async prefetchPlaybackStart(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex'), blob, profile = null, options = {}) {
    const ctx = this.ctx
    if (!ctx?.store || !blob) return
    let core = null
    try {
      core = ctx.store.get(keyBuffer)
      await prefetchBlobPlaybackStart(core, blob, { ...options, profile })
    } catch {
      // Best-effort: playback never depends on the prefetch succeeding.
    } finally {
      if (core) {
        try {
          const closing = core.close?.()
          if (closing?.catch) closing.catch(() => {})
        } catch { /* best effort */ }
      }
    }
  }

  async retainBlobCorePeers(blobsCoreKey, blobsCore = this.getBlobCore(blobsCoreKey)) {
    const ctx = this.ctx
    if (!blobsCore) return { peerCount: 0, blobPeerIds: [], retained: false, retainedDiscoveryStatus: 'core-unavailable' }

    try {
      await blobsCore.ready()
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
  return new BlobPlaybackService({ ctx })
}
