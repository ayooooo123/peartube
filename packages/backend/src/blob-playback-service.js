import b4a from 'b4a'

import { normalizeBlobRefInput, parseBlobRef } from './blob-ref.js'
import { retainSwarmDiscovery } from './storage.js'

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

  warmDirectBlobRef(blobsCoreKey, keyBuffer = b4a.from(blobsCoreKey, 'hex')) {
    const ctx = this.ctx
    if (!ctx.store) return

    try {
      const blobsCore = ctx.store.get(keyBuffer)
      blobsCore.ready().then(() => {
        if (ctx.swarm && blobsCore.discoveryKey) {
          try {
            retainSwarmDiscovery(ctx, blobsCore.discoveryKey, {
              label: `blobs:${String(blobsCoreKey).slice(0, 16)}`,
            })
          } catch { /* best effort */ }
        }
        blobsCore.update().catch(() => {})
      }).catch(() => {})
    } catch { /* best effort */ }
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
    let warmupStarted = true

    try {
      await Promise.resolve(warmup?.(driveKey, videoPath, publicBeeKey))
    } catch (err) {
      warmupStarted = false
      console.log('[BlobPlaybackService] preparePlayback warmup failed:', err?.message || err)
    }

    const result = resolveUrl
      ? await resolveUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      : this.resolveDirectBlobUrl({ blobsCoreKey, blobId, mimeType })

    return {
      url: result.url,
      stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
      warmupStarted,
    }
  }
}

export function createBlobPlaybackService(ctx) {
  return new BlobPlaybackService({ ctx })
}
