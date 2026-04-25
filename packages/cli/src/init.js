import { createBackendContext } from '@peartube/backend/orchestrator'
import { shutdownBackend } from '@peartube/backend/storage'
import { CacheManager } from './cache-manager.js'

/**
 * Engine-first peer initializer kept for older CLI/service call sites.
 * PublicBee/Autobase discovery was removed; pinned channels now open engine state
 * and are tracked only in the relay cache metadata.
 *
 * @param {{ storagePath: string, maxBytes: number, pinnedChannels?: string[] }} options
 */
export async function initPeer ({ storagePath, maxBytes, pinnedChannels = [] }) {
  const backend = await createBackendContext({ storagePath })
  const ctx = backend.ctx
  ctx.store = ctx.store || createStoreFacade()
  const publicFeed = createPublicFeedFacade()
  const cacheManager = new CacheManager(ctx.store, ctx.metaDb, maxBytes)

  await cacheManager.init()

  for (const key of pinnedChannels) {
    if (!key) continue
    try {
      await cacheManager.pinChannel(key, key)
      await backend.engineAdapter?.ensureEngineForUiChannel?.(key)
    } catch (err) {
      console.error('[initPeer] Failed to pin engine channel:', key.slice(0, 16), err?.message || err)
    }
  }

  return {
    ctx,
    backend,
    publicFeed,
    cacheManager,
    async close() {
      publicFeed.stop()
      await shutdownBackend(ctx)
    }
  }
}

function createStoreFacade() {
  return {
    closed: false,
    get() {
      throw new Error('Legacy Corestore access removed from CLI init; use @peartube/engine')
    },
    async close() {
      this.closed = true
    }
  }
}

function createPublicFeedFacade() {
  return {
    entries: new Map(),
    feedConnections: new Set(),
    setOnFeedUpdate() {},
    async start() {},
    stop() {},
    handleConnection() {},
    async submitChannel(channelKey, publicBeeKey = null) {
      if (channelKey) this.entries.set(channelKey, { driveKey: channelKey, publicBeeKey })
      return true
    },
    requestFeedsFromPeers() { return 0 },
    getStats() { return { totalEntries: this.entries.size, peerCount: 0 } }
  }
}
