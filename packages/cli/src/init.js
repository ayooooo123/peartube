import { initializeStorage, loadPublicBee } from '@peartube/backend/storage'
import { PublicFeedManager } from '@peartube/backend/public-feed'
import { CacheManager } from './cache-manager.js'

/**
 * @param {{ storagePath: string, maxBytes: number, pinnedChannels?: string[] }} options
 * @returns {Promise<{ ctx: any, publicFeed: PublicFeedManager, cacheManager: CacheManager }>}
 */
export async function initPeer ({ storagePath, maxBytes, pinnedChannels = [] }) {
  const ctx = await initializeStorage({ storagePath, wrapTimeout: true })

  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb)

  const cacheManager = new CacheManager(ctx.store, ctx.metaDb, maxBytes)
  await cacheManager.init()

  ctx.swarm.on('connection', (conn, info) => {
    publicFeed.handleConnection(conn, info)
  })

  publicFeed.setOnFeedUpdate(() => {
    for (const entry of publicFeed.entries.values()) {
      if (entry.driveKey && entry.publicBeeKey) {
        cacheManager.addChannel(entry.driveKey, entry.publicBeeKey, 'discovered').catch(() => {})
      }
    }
  })

  await publicFeed.start()

  for (const key of pinnedChannels) {
    try {
      await cacheManager.pinChannel(key, key)
      await loadPublicBee(ctx, key)
    } catch (err) {
      console.error('[initPeer] Failed to pin channel:', key.slice(0, 16), err.message)
    }
  }

  return { ctx, publicFeed, cacheManager }
}
