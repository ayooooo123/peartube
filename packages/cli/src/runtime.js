export async function createRelayRuntime({ config, logger }) {
  const [
    { initializeStorage, loadChannel, loadPublicBee, getNetworkStats },
    { PublicFeedManager },
    { CacheManager },
    { createRelaySeeder },
    { createRelayBlindPeer },
    { readPrimaryKeyFile, writePrimaryKeyFile }
  ] = await Promise.all([
    import('@peartube/backend/storage'),
    import('@peartube/backend/public-feed'),
    import('./cache-manager.js'),
    import('./seeding.js'),
    import('@peartube/backend/relay-blind-peer'),
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
    wrapTimeout: true,
    swarmPort: config?.network?.port || null,
    // Docker/bind-mounted relay volumes can trip device-file inode/mtime validation
    // across clean container restarts even with the same persisted primary key.
    // The relay is a single-writer service, so disable device-file enforcement here.
    corestoreAllowBackup: true
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
  const blindPeer = await createRelayBlindPeer({
    ctx,
    storagePath: storageRoot,
    enabled: config?.network?.blindPeer !== false,
    trustedPeerKeys: config?.network?.trustedBlindPeerClients || [],
    logger: logger.runtime || logger.relay || logger
  })
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee,
    blindPeer,
    logger: logger.runtime || logger.relay || logger
  })
  let candidateHandler = null

  function emitFeedEntries() {
    if (typeof candidateHandler !== 'function') return

    for (const entry of publicFeed.getFeed?.() || publicFeed.entries.values()) {
      if (!entry?.driveKey || !entry?.publicBeeKey) continue
      candidateHandler({
        channelKey: entry.driveKey,
        publicBeeKey: entry.publicBeeKey || null,
        source: entry.relayRole === 'cache' || entry.source === 'relay-cache' ? 'relay-cache' : 'discovered',
        relayServing: Boolean(entry.relayServing),
        previewVideos: Array.isArray(entry.previewVideos) ? entry.previewVideos : []
      })
    }
  }

  ctx.swarm.on('connection', (conn, info) => {
    publicFeed.handleConnection(conn, info)
  })
  ctx.swarm.on('peer', (peer, topic) => {
    publicFeed.handleDiscoveredPeer(peer, topic)
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
    seeder,
    identityManager: null,
    uploadManager: null,
    api: null,
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

      const [{ createIdentityManager }, { createUploadManager }, { createApi }] = await Promise.all([
        import('@peartube/backend/identity'),
        import('@peartube/backend/upload'),
        import('@peartube/backend/api')
      ])
      this.identityManager = createIdentityManager({ ctx })
      await this.identityManager.loadIdentities()
      this.uploadManager = createUploadManager({ ctx })
      this.api = createApi({ ctx, publicFeed, seedingManager: null, videoStats: null })

      // Use the same feed snapshot and availability-hint plumbing as the normal
      // PearTube backend. Without these providers the relay can gossip channel
      // keys, but phones do not learn that the relay has playable local bytes.
      if (typeof this.api.getAvailabilityHints === 'function') {
        publicFeed.setAvailabilityHintProvider((requests, conn) => this.api.getAvailabilityHints(requests, conn))
      }
      if (typeof this.api.getFeedSnapshotEntries === 'function') {
        publicFeed.setFeedSnapshotProvider((entries) => this.api.getFeedSnapshotEntries(entries, { limitPerChannel: 3 }))
      }

      // Restore mirrored/cached channels as relay catalog entries, not as
      // user-published channels. This keeps the relay contract explicit: it is
      // serving/cache infrastructure for these publicBee/blob cores.
      for (const channel of cacheManager.getChannels()) {
        if (!channel?.driveKey || !channel?.publicBeeKey) continue
        try {
          const seedStats = await seeder.seedChannel(channel)
          await publicFeed.submitRelayCatalogEntry({
            ...(seedStats?.catalogEntry || {}),
            driveKey: channel.driveKey,
            publicBeeKey: channel.publicBeeKey,
            channelName: seedStats?.catalogEntry?.channelName || channel.channelName || null,
            videoCount: seedStats?.videos || channel.videoCount || 0,
            previewVideos: seedStats?.catalogEntry?.previewVideos || channel.previewVideos || [],
            relayRole: 'cache',
            relayServing: true,
          })
        } catch (err) {
          logger.runtime?.debug('Failed to restore cached mirrored channel', {
            channelKey: channel.driveKey,
            error: err?.message || String(err)
          })
        }
      }

      logger.runtime?.info('Relay runtime started', this.getNetworkStats())
      await seeder.seedCachedChannels(cacheManager).catch((err) => {
        logger.runtime?.warn('Relay seeding refresh failed', { error: err?.message || String(err) })
      })
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
      const storageStats = getNetworkStats?.() || {}
      return {
        peers: ctx.swarm?.peers?.size || 0,
        connections: ctx.swarm?.connections?.size || 0,
        feedPeers: feedStats.peerCount || 0,
        feedConnections: publicFeed.feedConnections?.size || 0,
        feedEntries: feedStats.totalEntries || 0,
        dht: {
          bootstrapped: ctx.swarm?.dht?.bootstrapped ?? null,
          firewalled: ctx.swarm?.dht?.firewalled ?? null,
          online: ctx.swarm?.dht?.online ?? null
        },
        publicFeedDiscoveryJoined: Boolean(publicFeed.feedDiscovery),
        blindPeer: blindPeer.getStats?.() || null,
        peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
        directPeerDial: feedStats.directPeerDial || null,
        hyperswarm: storageStats?.hyperswarm || null,
        swarmOffline: Boolean(ctx.swarm?._peartubeOffline),
        swarmOfflineReason: ctx.swarm?._peartubeOfflineReason || null,
        swarmListenResolved: Boolean(ctx.swarm?._peartubeListenResolved),
        seeding: seeder.getStats(),
        relayCatalogEntries: Array.from(publicFeed.entries?.values?.() || []).filter(e => e?.relayRole === 'cache' || e?.source === 'relay-cache').length,
        relayServingEntries: Array.from(publicFeed.entries?.values?.() || []).filter(e => e?.relayServing).length,
        relayPlayablePreviewVideos: Array.from(publicFeed.entries?.values?.() || []).reduce((total, e) => {
          const videos = Array.isArray(e?.previewVideos) ? e.previewVideos : []
          return total + videos.filter(v => v?.availability === 'playable' && v?.blobId && v?.blobsCoreKey).length
        }, 0)
      }
    },
    async close() {
      try { publicFeed.stop() } catch (err) { logger.runtime?.debug('Public feed close failed', { error: err?.message || String(err) }) }
      try { await seeder.close() } catch (err) { logger.runtime?.debug('Relay seeder close failed', { error: err?.message || String(err) }) }
      try { await blindPeer.close?.() } catch (err) { logger.runtime?.debug('Relay blind peer close failed', { error: err?.message || String(err) }) }
      try { await ctx.swarm.destroy() } catch (err) { logger.runtime?.debug('Swarm close failed', { error: err?.message || String(err) }) }
      try { ctx.blobServer?.close?.() } catch (err) { logger.runtime?.debug('Blob server close failed', { error: err?.message || String(err) }) }
      try { await ctx.store.close() } catch (err) { logger.runtime?.debug('Store close failed', { error: err?.message || String(err) }) }
    }
  }
}
