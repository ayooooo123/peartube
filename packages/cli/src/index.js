import goodbye from 'graceful-goodbye'
import { initPeer } from './init.js'
import { downloadChannelBlobs, downloadAllCachedChannels } from './blob-downloader.js'
import { createCliLogger } from './cli-logger.js'
import b4a from 'b4a'

/**
 * @param {{ storagePath: string, maxStorageMB: number, pinnedChannels?: string[], debug?: boolean }} opts
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function startPeer ({ storagePath, maxStorageMB, pinnedChannels = [], debug = false }) {
  const log = createCliLogger(debug)
  const maxBytes = maxStorageMB * 1024 * 1024

  log.peer.info('Starting peartube-peer', { storage: storagePath, maxStorage: maxStorageMB, pinnedChannels: pinnedChannels.length })

  const { ctx, publicFeed, cacheManager } = await initPeer({ storagePath, maxBytes, pinnedChannels })

  const publicKey = ctx.swarm.keyPair?.publicKey
  if (publicKey) {
    log.peer.info('Peer listening', { publicKey: b4a.toString(publicKey, 'hex') })
  }

  // Wire feed updates → background blob downloads
  // Chain on top of the handler initPeer already installed
  const originalOnFeedUpdate = publicFeed.onFeedUpdate
  publicFeed.setOnFeedUpdate(() => {
    // Call original handler first (adds channels to cacheManager)
    if (originalOnFeedUpdate) originalOnFeedUpdate()

    setImmediate(async () => {
      const entries = [...publicFeed.entries.values()]
      for (const entry of entries) {
        if (!entry.driveKey || !entry.publicBeeKey) continue
        try {
          const stats = await downloadChannelBlobs(ctx, entry.publicBeeKey, entry.driveKey, log.download)
          if (stats.bytesDownloaded > 0) {
            await cacheManager.updateChannelSize(entry.driveKey, stats.bytesDownloaded)
            log.cache.info('Channel size updated', { driveKey: entry.driveKey.slice(0, 16), bytes: stats.bytesDownloaded })
          }
        } catch {}
      }
      await cacheManager.enforceQuota()
    })
  })

  const statsInterval = setInterval(() => {
    const stats = cacheManager.getStats()
    log.peer.info('Stats', {
      connections: ctx.swarm.connections?.size || 0,
      channels: stats.totalChannels,
      storage: stats.totalBytes,
      peers: ctx.swarm.peers?.size || 0
    })
  }, 60_000)
  statsInterval.unref()

  const rescanInterval = setInterval(async () => {
    try {
      const totals = await downloadAllCachedChannels(ctx, cacheManager, log.download)
      if (totals.bytesDownloaded > 0) {
        await cacheManager.enforceQuota()
        log.cache.info('Rescan complete', totals)
      }
    } catch {}
  }, 5 * 60_000)
  rescanInterval.unref()

  // Shared close promise ensures multiple callers (signal handlers + goodbye) coordinate
  let closePromise = null
  function close () {
    if (closePromise) return closePromise
    closePromise = (async () => {
      log.peer.info('Shutting down')
      clearInterval(statsInterval)
      clearInterval(rescanInterval)
      try { publicFeed.stop() } catch {}
      try { await ctx.swarm.destroy() } catch {}
      try { await ctx.store.close() } catch {}
      log.peer.info('Shutdown complete')
    })()
    return closePromise
  }

  goodbye(close)

  // goodbye exits with 130 on signals; these handlers override to exit 0
  const onSignal = async () => { await close(); process.exit(0) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  return { close }
}
