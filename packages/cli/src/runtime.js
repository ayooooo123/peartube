export async function createRelayRuntime({ config, logger }) {
  const [
    { initializeStorage, loadChannel, loadPublicBee },
    { PublicFeedManager },
    { CacheManager },
    { readPrimaryKeyFile, writePrimaryKeyFile }
  ] = await Promise.all([
    import('@peartube/backend/storage'),
    import('@peartube/backend/public-feed'),
    import('./cache-manager.js'),
    import('../../backend/src/identity-key-file.js')
  ])

  const storageRoot = config.storage.path

  // IMPORTANT: backend storage expects the top-level relay storage root here.
  // The nested `<root>/corestore` directory is part of the normal on-disk layout.
  // Relay runtime bypasses the backend orchestrator, so it must persist/reuse the
  // Corestore primaryKey itself. Otherwise each restart opens the same storage
  // with a new random primary key, which can produce device-file/Corestore errors.
  let primaryKey = null
  try {
    primaryKey = await readPrimaryKeyFile(storageRoot)
  } catch (err) {
    logger.runtime?.warn('Failed to read relay primary-key file', {
      error: err?.message || String(err),
      storageRoot,
    })
  }

  const ctx = await initializeStorage({
    storagePath: storageRoot,
    primaryKey,
    wrapTimeout: true
  })

  if (!primaryKey && ctx?.store?.primaryKey) {
    try {
      await writePrimaryKeyFile(storageRoot, ctx.store.primaryKey)
      logger.runtime?.info('Persisted relay Corestore primary key', { storageRoot })
    } catch (err) {
      logger.runtime?.warn('Failed to persist relay primary-key file', {
        error: err?.message || String(err),
        storageRoot,
      })
    }
  }

  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb)
  const cacheManager = new CacheManager(ctx.store, ctx.metaDb, config?.storage?.maxBytes || 0)
  let candidateHandler = null

  function emitFeedEntries() {
    if (typeof candidateHandler !== 'function') return

    for (const entry of publicFeed.entries.values()) {
      if (!entry?.driveKey) continue
      candidateHandler({
        channelKey: entry.driveKey,
        publicBeeKey: entry.publicBeeKey || null,
        source: 'discovered'
      })
    }
  }

  ctx.swarm.on('connection', (conn, info) => {
    publicFeed.handleConnection(conn, info)
  })

  publicFeed.setOnFeedUpdate(() => {
    try {
      for (const entry of publicFeed.entries.values()) {
        if (entry?.driveKey && entry?.publicBeeKey) {
          cacheManager.addChannel(entry.driveKey, entry.publicBeeKey, 'discovered').catch(() => {})
        }
      }
      emitFeedEntries()
    } catch (err) {
      logger.runtime?.error('Feed update failed', { error: err?.message || String(err) })
    }
  })

  return {
    ctx,
    publicFeed,
    cacheManager,
    setCandidateHandler(handler) {
      candidateHandler = handler
    },
    async start() {
      logger.runtime?.info('Initializing relay runtime', {
        storagePath: config.storage.path,
        storageRoot,
        mode: config.mode,
        policy: config.policy
      })
      await cacheManager.init()
      await publicFeed.start()

      // Restore mirrored/cached channels as actively served feed entries so the
      // relay behaves like a real serving peer even when original publishers are offline.
      for (const channel of cacheManager.getChannels()) {
        if (!channel?.driveKey || !channel?.publicBeeKey) continue
        try {
          await loadPublicBee(ctx, channel.publicBeeKey)
          await publicFeed.submitChannel(channel.driveKey, channel.publicBeeKey)
        } catch (err) {
          logger.runtime?.debug('Failed to restore cached mirrored channel', {
            channelKey: channel.driveKey,
            error: err?.message || String(err)
          })
        }
      }

      logger.runtime?.info('Relay runtime started', this.getNetworkStats())
      emitFeedEntries()
    },
    requestFeedSync() {
      try {
        return publicFeed.requestFeedsFromPeers?.() || 0
      } catch (err) {
        logger.feed?.warn('Initial feed sync request failed', {
          error: err?.message || String(err)
        })
        return 0
      }
    },
    async resolveCandidate(candidate) {
      const resolved = {
        ...candidate,
        channelKey: candidate.channelKey || candidate.driveKey
      }

      if (resolved.publicBeeKey) {
        try {
          const bee = await loadPublicBee(ctx, resolved.publicBeeKey)
          const meta = await bee.getMetadata().catch(() => null)
          resolved.ownerKey = resolved.ownerKey || meta?.createdBy || meta?.publicKey || null
        } catch (err) {
          logger.runtime?.debug('Public bee metadata lookup failed', {
            channelKey: resolved.channelKey,
            error: err?.message || String(err)
          })
        }
      }

      if (!resolved.publicBeeKey || !resolved.ownerKey) {
        try {
          const channel = await loadChannel(ctx, resolved.channelKey)
          const meta = await channel.getMetadata().catch(() => null)
          resolved.publicBeeKey = resolved.publicBeeKey || channel.publicBeeKey || meta?.publicBeeKey || null
          resolved.ownerKey = resolved.ownerKey || meta?.createdBy || meta?.publicKey || null
        } catch (err) {
          logger.runtime?.debug('Channel metadata lookup failed', {
            channelKey: resolved.channelKey,
            error: err?.message || String(err)
          })
        }
      }

      if (!resolved.ownerKey && resolved.publicBeeKey) {
        try {
          const bee = await loadPublicBee(ctx, resolved.publicBeeKey)
          const meta = await bee.getMetadata().catch(() => null)
          resolved.ownerKey = meta?.createdBy || meta?.publicKey || null
        } catch (err) {
          logger.runtime?.debug('Owner fallback lookup failed', {
            channelKey: resolved.channelKey,
            error: err?.message || String(err)
          })
        }
      }

      return resolved
    },
    getNetworkStats() {
      const feedStats = publicFeed.getStats?.() || {}
      return {
        peers: ctx.swarm?.peers?.size || 0,
        connections: ctx.swarm?.connections?.size || 0,
        feedPeers: feedStats.peerCount || 0,
        feedConnections: publicFeed.feedConnections?.size || 0,
        feedEntries: feedStats.totalEntries || 0
      }
    },
    async close() {
      try { publicFeed.stop() } catch {}
      try { await ctx.swarm.destroy() } catch {}
      try { ctx.blobServer?.close?.() } catch {}
      try { await ctx.store.close() } catch {}
    }
  }
}
