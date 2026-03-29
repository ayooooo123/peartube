export async function createRelayRuntime({ config, logger }) {
  const [{ initializeStorage, loadChannel, loadPublicBee }, { PublicFeedManager }] = await Promise.all([
    import('@peartube/backend/storage'),
    import('@peartube/backend/public-feed')
  ])

  const ctx = await initializeStorage({
    storagePath: config.storage.path,
    wrapTimeout: true
  })

  const publicFeed = new PublicFeedManager(ctx.swarm, ctx.metaDb)
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
      emitFeedEntries()
    } catch (err) {
      logger.runtime?.error('Feed update failed', { error: err?.message || String(err) })
    }
  })

  return {
    ctx,
    publicFeed,
    setCandidateHandler(handler) {
      candidateHandler = handler
    },
    async start() {
      logger.runtime?.info('Initializing relay runtime', {
        storagePath: config.storage.path,
        mode: config.mode,
        policy: config.policy
      })
      await publicFeed.start()
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
