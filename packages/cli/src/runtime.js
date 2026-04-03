export async function createRelayRuntime({ config, logger }) {
  const [
    { initializeStorage, loadChannel, loadPublicBee },
    { PublicFeedManager },
    { CacheManager },
    { loadBareOrNodeFsModule, loadBareOrNodePathModule }
  ] = await Promise.all([
    import('@peartube/backend/storage'),
    import('@peartube/backend/public-feed'),
    import('./cache-manager.js'),
    import('../../backend/src/runtime-modules.js')
  ])

  const fs = await loadBareOrNodeFsModule()
  const path = await loadBareOrNodePathModule()

  const storageRoot = config.storage.path
  const legacyNestedCorestorePath = config?.paths?.corestore || path.join(storageRoot, 'corestore')

  // Normalize old relay layouts that nested backend storage under <root>/corestore.
  // Backend storage expects the top-level storage root and derives sibling files like
  // CORESTORE, primary-key, swarm-key.json, db/, etc from that root.
  try {
    const nestedMarker = path.join(legacyNestedCorestorePath, 'CORESTORE')
    const rootMarker = path.join(storageRoot, 'CORESTORE')
    const nestedExists = await fs.access(nestedMarker).then(() => true).catch(() => false)
    const rootExists = await fs.access(rootMarker).then(() => true).catch(() => false)

    if (nestedExists && !rootExists) {
      logger.runtime?.warn('Migrating legacy nested relay corestore layout into storage root', {
        from: legacyNestedCorestorePath,
        to: storageRoot,
      })
      const entries = await fs.readdir(legacyNestedCorestorePath)
      for (const entry of entries) {
        const from = path.join(legacyNestedCorestorePath, entry)
        const to = path.join(storageRoot, entry)
        const alreadyExists = await fs.access(to).then(() => true).catch(() => false)
        if (alreadyExists) continue
        await fs.rename(from, to).catch(async () => {
          const stat = await fs.stat(from)
          if (stat.isDirectory()) {
            await fs.cp(from, to, { recursive: true, force: false })
          } else {
            await fs.copyFile(from, to)
          }
        })
      }
    }
  } catch (err) {
    logger.runtime?.warn('Legacy relay storage normalization skipped', {
      error: err?.message || String(err),
      storageRoot,
      legacyNestedCorestorePath,
    })
  }

  const ctx = await initializeStorage({
    storagePath: storageRoot,
    wrapTimeout: true
  })

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
