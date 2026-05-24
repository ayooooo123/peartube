import b4a from 'b4a'

import { normalizeBlobRefInput, parseBlobRef } from './blob-ref.js'
import { retainSwarmDiscovery } from './storage.js'

function getCorePeerCount(core) {
  const peers = core?.peers
  if (Array.isArray(peers)) return peers.length
  if (typeof peers?.length === 'number') return peers.length
  if (typeof peers?.size === 'number') return peers.size
  if (peers && typeof peers.values === 'function') return Array.from(peers.values()).length
  return 0
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

    this.warmDirectBlobRef(ref.blobsCoreKey, keyBuffer)

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

  async retainBlobCorePeers(blobsCoreKey, blobsCore = this.getBlobCore(blobsCoreKey)) {
    const ctx = this.ctx
    if (!blobsCore) return { peerCount: 0, retained: false }

    try {
      await blobsCore.ready()
      if (ctx.swarm && blobsCore.discoveryKey) {
        retainSwarmDiscovery(ctx, blobsCore.discoveryKey, {
          label: `blobs:${String(blobsCoreKey).slice(0, 16)}`,
        })
      }
      blobsCore.update().catch(() => {})
      return { peerCount: getCorePeerCount(blobsCore), retained: Boolean(blobsCore.discoveryKey) }
    } catch {
      return { peerCount: getCorePeerCount(blobsCore), retained: false }
    }
  }

  async waitForBlobCorePeers(blobsCoreKey, { minPeers = 1, timeoutMs = 1500, pollMs = 100 } = {}) {
    const blobsCore = this.getBlobCore(blobsCoreKey)
    if (!blobsCore) return { peerCount: 0, retained: false, timedOut: false }

    const startedAt = Date.now()
    let status = await this.retainBlobCorePeers(blobsCoreKey, blobsCore)
    while (status.peerCount < minPeers && Date.now() - startedAt < timeoutMs) {
      await wait(pollMs)
      status = {
        ...status,
        peerCount: getCorePeerCount(blobsCore),
      }
    }

    return {
      ...status,
      timedOut: status.peerCount < minPeers,
      elapsedMs: Date.now() - startedAt,
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

  async preparePlayback({
    driveKey,
    videoPath,
    publicBeeKey,
    blobId,
    blobsCoreKey,
    mimeType,
    resolveUrl,
    warmup,
    getStats,
  }) {
    let warmupStarted = false

    const result = resolveUrl
      ? await resolveUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      : this.resolveDirectBlobUrl({ blobsCoreKey, blobId, mimeType })

    try {
      if (warmup) {
        warmupStarted = true
        Promise.resolve(warmup(driveKey, videoPath, publicBeeKey)).catch((err) => {
          console.log('[BlobPlaybackService] preparePlayback warmup failed:', err?.message || err)
        })
      }
    } catch (err) {
      console.log('[BlobPlaybackService] preparePlayback warmup failed:', err?.message || err)
    }

    if (blobsCoreKey) {
      this.waitForBlobCorePeers(blobsCoreKey, { minPeers: 1, timeoutMs: 1500, pollMs: 100 }).catch((err) => {
        console.log('[BlobPlaybackService] preparePlayback peer warmup failed:', err?.message || err)
      })
    }

    return {
      url: result.url,
      stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
      warmupStarted,
      peerWarmupStarted: Boolean(blobsCoreKey),
    }
  }
}

export function createBlobPlaybackService(ctx) {
  return new BlobPlaybackService({ ctx })
}
