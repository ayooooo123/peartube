import b4a from 'b4a'

import { normalizeBlobRefInput, parseBlobRef } from './blob-ref.js'
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getWarmupTimeoutMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return 5500
  return Math.max(0, ms)
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

  async warmSelectedBlobRef({ blobsCoreKey, blobId, timeoutMs = 1200 }) {
    const ref = parseBlobRef({ blobsCoreKey, blobId, mimeType: 'video/mp4' })
    const diagnostics = {
      blobsCoreKey: ref?.blobsCoreKey || blobsCoreKey || null,
      blobId: blobId ? String(blobId) : null,
      peerCount: 0,
      blobPeerIds: [],
      hasHeadBlock: false,
      contiguousBlocks: 0,
      readyForPlayback: false,
      error: null,
    }

    const blobsCore = ref ? this.getBlobCore(ref.blobsCoreKey) : null
    if (!blobsCore) {
      diagnostics.error = ref ? 'core-unavailable' : 'invalid-blob-ref'
      return diagnostics
    }

    try {
      await blobsCore.ready()
      await this.retainBlobCorePeers(ref.blobsCoreKey, blobsCore)
      try {
        await Promise.race([
          blobsCore.update({ wait: true }),
          wait(Math.max(1, timeoutMs)),
        ])
      } catch { /* best effort */ }

      const start = ref.blob.blockOffset
      const headEnd = Math.min(start + Math.max(1, ref.blob.blockLength || 1), start + 1)
      try {
        diagnostics.hasHeadBlock = Boolean(await blobsCore.has?.(start, headEnd))
        diagnostics.contiguousBlocks = diagnostics.hasHeadBlock ? 1 : 0
      } catch { /* best effort */ }

      const peers = getCorePeerList(blobsCore)
      diagnostics.peerCount = getCorePeerCount(blobsCore)
      diagnostics.blobPeerIds = peers.map(getPeerKey).filter(Boolean)
      diagnostics.readyForPlayback = diagnostics.hasHeadBlock || diagnostics.peerCount > 0
      return diagnostics
    } catch (err) {
      diagnostics.error = err?.message || String(err)
      return diagnostics
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
    warmupTimeoutMs,
    getStats,
    warmSelectedBlob = false,
    selectedBlobWarmupTimeoutMs = 1200,
  }) {
    let warmupStarted = false
    let warmupResult = null

    const result = resolveUrl
      ? await resolveUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType)
      : this.resolveDirectBlobUrl({ blobsCoreKey, blobId, mimeType })
    const url = typeof result?.url === 'string' && result.url.length > 0 ? result.url : null
    if (!url) {
      throw new Error('Playback URL unavailable')
    }

    try {
      if (warmup) {
        warmupStarted = true
        const warmupPromise = Promise.resolve(warmup(driveKey, videoPath, publicBeeKey)).catch((err) => {
          console.log('[BlobPlaybackService] preparePlayback warmup failed:', err?.message || err)
          return { success: false, error: err?.message || String(err) }
        })
        const timeoutMs = getWarmupTimeoutMs(warmupTimeoutMs)
        warmupResult = await Promise.race([
          warmupPromise,
          wait(timeoutMs).then(() => ({ success: false, timedOut: true })),
        ])
      }
    } catch (err) {
      console.log('[BlobPlaybackService] preparePlayback warmup failed:', err?.message || err)
      warmupResult = { success: false, error: err?.message || String(err) }
    }

    if (blobsCoreKey) {
      const selectedBlobWarmup = warmSelectedBlob && blobId
        ? await this.warmSelectedBlobRef({
          blobsCoreKey,
          blobId,
          timeoutMs: selectedBlobWarmupTimeoutMs,
        })
        : null
      const peerWarmup = this.waitForBlobCorePeers(blobsCoreKey, { minPeers: 1, timeoutMs: 1500, pollMs: 100 }).catch((err) => {
        console.log('[BlobPlaybackService] preparePlayback peer warmup failed:', err?.message || err)
        return { peerCount: 0, retained: false, timedOut: false }
      })
      return {
        url,
        stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
        warmupStarted,
        warmupResult,
        peerWarmupStarted: true,
        selectedBlobWarmup,
        peerWarmup: await Promise.race([
          peerWarmup,
          wait(0).then(() => ({ peerCount: 0, retained: false, timedOut: false })),
        ]),
      }
    }

    return {
      url,
      stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
      warmupStarted,
      warmupResult,
      peerWarmupStarted: false,
    }
  }
}

export function createBlobPlaybackService(ctx) {
  return new BlobPlaybackService({ ctx })
}
