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

function uniquePeerIds(values = []) {
  const ids = new Set()
  for (const value of values || []) {
    if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) ids.add(value.toLowerCase())
  }
  return Array.from(ids)
}

function jsonArray(values = []) {
  return JSON.stringify(uniquePeerIds(values))
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

  async waitForBlobCorePeers(blobsCoreKey, { minPeers = 1, timeoutMs = 1500, pollMs = 100 } = {}) {
    const blobsCore = this.getBlobCore(blobsCoreKey)
    if (!blobsCore) return { peerCount: 0, blobPeerIds: [], retained: false, timedOut: false }

    const startedAt = Date.now()
    let status = await this.retainBlobCorePeers(blobsCoreKey, blobsCore)
    while (status.peerCount < minPeers && Date.now() - startedAt < timeoutMs) {
      await wait(pollMs)
      const peers = getCorePeerList(blobsCore)
      status = {
        ...status,
        peerCount: getCorePeerCount(blobsCore),
        blobPeerIds: peers.map(getPeerKey).filter(Boolean),
      }
    }

    return {
      ...status,
      timedOut: status.peerCount < minPeers,
      elapsedMs: Date.now() - startedAt,
    }
  }

  async warmSelectedBlobRef({
    blobsCoreKey,
    blobId,
    timeoutMs = 1200,
    sourceFeedPeerIds = [],
    sourceRelayPeerIds = [],
    promotePeerHints = null,
  }) {
    const ref = parseBlobRef({ blobsCoreKey, blobId, mimeType: 'video/mp4' })
    const feedIds = uniquePeerIds(sourceFeedPeerIds)
    const relayIds = uniquePeerIds(sourceRelayPeerIds)
    const diagnostics = {
      blobsCoreKey: ref?.blobsCoreKey || blobsCoreKey || null,
      blobId: blobId ? String(blobId) : null,
      peerCount: 0,
      blobPeerIds: [],
      blobPeerIdsJson: '[]',
      sourceFeedPeerIdsJson: jsonArray(feedIds),
      sourceRelayPeerIdsJson: jsonArray(relayIds),
      retainedDiscoveryLabel: ref?.blobsCoreKey ? `blobs:${ref.blobsCoreKey.slice(0, 16)}` : null,
      retainedDiscoveryStatus: 'not-started',
      feedRelayAlsoBlobPeer: false,
      promotedPeerHintsJson: '[]',
      hasHeadBlock: false,
      contiguousBlocks: 0,
      readyForPlayback: false,
      error: null,
    }

    const blobsCore = ref ? this.getBlobCore(ref.blobsCoreKey) : null
    if (!blobsCore) {
      diagnostics.error = ref ? 'core-unavailable' : 'invalid-blob-ref'
      diagnostics.retainedDiscoveryStatus = 'core-unavailable'
      return diagnostics
    }

    const updatePeerDiagnostics = () => {
      const peers = getCorePeerList(blobsCore)
      const peerIds = uniquePeerIds(peers.map(getPeerKey).filter(Boolean))
      diagnostics.peerCount = getCorePeerCount(blobsCore)
      diagnostics.blobPeerIds = peerIds
      diagnostics.blobPeerIdsJson = JSON.stringify(peerIds)
      diagnostics.feedRelayAlsoBlobPeer = relayIds.some((id) => peerIds.includes(id)) || feedIds.some((id) => peerIds.includes(id))
    }

    const updateHeadAvailability = async () => {
      const start = ref.blob.blockOffset
      const headEnd = Math.min(start + Math.max(1, ref.blob.blockLength || 1), start + 1)
      try {
        diagnostics.hasHeadBlock = Boolean(await blobsCore.has?.(start, headEnd))
        diagnostics.contiguousBlocks = diagnostics.hasHeadBlock ? 1 : 0
      } catch { /* best effort */ }
      diagnostics.readyForPlayback = diagnostics.hasHeadBlock
    }

    try {
      await blobsCore.ready()
      const retained = await this.retainBlobCorePeers(ref.blobsCoreKey, blobsCore)
      diagnostics.retainedDiscoveryLabel = retained.retainedDiscoveryLabel || diagnostics.retainedDiscoveryLabel
      diagnostics.retainedDiscoveryStatus = retained.retainedDiscoveryStatus || (retained.retained ? 'retained' : 'not-retained')
      updatePeerDiagnostics()
      if (typeof promotePeerHints === 'function' && (feedIds.length > 0 || relayIds.length > 0)) {
        try {
          const promoted = promotePeerHints(uniquePeerIds([...feedIds, ...relayIds]), blobsCore.discoveryKey)
          diagnostics.promotedPeerHintsJson = JSON.stringify(Array.isArray(promoted) ? promoted.map((peer) => ({
            key: typeof peer?.key === 'string' ? peer.key.slice(0, 16) : null,
            connected: Boolean(peer?.connected),
            explicit: Boolean(peer?.explicit),
            relayAddresses: Number(peer?.relayAddresses || 0),
          })) : [])
        } catch (err) {
          diagnostics.promotedPeerHintsJson = JSON.stringify([{ error: err?.message || String(err) }])
        }
      }

      const startedAt = Date.now()
      try {
        await Promise.race([
          blobsCore.update({ wait: true }),
          wait(Math.max(1, Math.min(timeoutMs, 250))),
        ])
      } catch { /* best effort */ }

      updatePeerDiagnostics()
      await updateHeadAvailability()
      while (!diagnostics.hasHeadBlock && Date.now() - startedAt < timeoutMs) {
        await wait(Math.min(100, Math.max(1, timeoutMs - (Date.now() - startedAt))))
        updatePeerDiagnostics()
        await updateHeadAvailability()
      }

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
    getStats,
    warmSelectedBlob = false,
    selectedBlobWarmupTimeoutMs = 1200,
    sourceFeedPeerIds = [],
    sourceRelayPeerIds = [],
    promotePeerHints = null,
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
      const selectedBlobWarmup = warmSelectedBlob && blobId
        ? await this.warmSelectedBlobRef({
          blobsCoreKey,
          blobId,
          timeoutMs: selectedBlobWarmupTimeoutMs,
          sourceFeedPeerIds,
          sourceRelayPeerIds,
          promotePeerHints,
        })
        : null
      const peerWarmup = this.waitForBlobCorePeers(blobsCoreKey, { minPeers: 1, timeoutMs: 1500, pollMs: 100 }).catch((err) => {
        console.log('[BlobPlaybackService] preparePlayback peer warmup failed:', err?.message || err)
        return { peerCount: 0, blobPeerIds: [], retained: false, timedOut: false }
      })
      return {
        url: result.url,
        stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
        warmupStarted,
        peerWarmupStarted: true,
        selectedBlobWarmup,
        peerWarmup: await Promise.race([
          peerWarmup,
          wait(0).then(() => ({ peerCount: 0, blobPeerIds: [], retained: false, timedOut: false })),
        ]),
      }
    }

    return {
      url: result.url,
      stats: typeof getStats === 'function' ? getStats(driveKey, videoPath) : undefined,
      warmupStarted,
      peerWarmupStarted: false,
    }
  }
}

export function createBlobPlaybackService(ctx) {
  return new BlobPlaybackService({ ctx })
}
