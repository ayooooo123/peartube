function buildNetworkDoctor({
  dht,
  peerPoolJoined,
  publicFeedDiscoveryJoined,
  directPeerDial,
  networkDebug,
  swarmPeers,
  swarmConnections,
  connecting,
  feedConnections,
  feedEntries
}) {
  const doctor = {
    dht: {
      bootstrapped: dht?.bootstrapped ?? null,
      firewalled: dht?.firewalled ?? null,
      online: dht?.online ?? null,
      ephemeral: dht?.ephemeral ?? null,
    },
    discovery: {
      peerPoolJoined: Boolean(peerPoolJoined),
      publicFeedDiscoveryJoined: Boolean(publicFeedDiscoveryJoined),
      discoveredPeers: directPeerDial?.discoveredPeers || 0,
      recentPeers: networkDebug?.hyperswarm?.recentPeers || [],
    },
    socket: {
      swarmPeers: swarmPeers || 0,
      swarmConnections: swarmConnections || 0,
      connecting: connecting || 0,
      recentConnections: networkDebug?.hyperswarm?.recentConnections || [],
      peerStates: networkDebug?.hyperswarm?.peerStates || [],
    },
    feed: {
      feedConnections: feedConnections || 0,
      feedEntries: feedEntries || 0,
      directPeerDial: directPeerDial || null,
    },
    recommendedBoundary: null,
  }
  if (doctor.discovery.discoveredPeers === 0 && doctor.dht.bootstrapped === false) doctor.recommendedBoundary = 'dht-bootstrap'
  else if (doctor.discovery.discoveredPeers > 0 && doctor.socket.swarmConnections === 0) doctor.recommendedBoundary = 'transport-socket'
  else if (doctor.socket.swarmConnections > 0 && doctor.feed.feedConnections === 0) doctor.recommendedBoundary = 'protomux-feed-open'
  else if (doctor.feed.feedConnections > 0 && doctor.feed.feedEntries === 0) doctor.recommendedBoundary = 'feed-gossip'
  else doctor.recommendedBoundary = 'content-playback-or-ui'
  return doctor
}

export async function createRelayRuntime({ config, logger } = {}) {
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
    // Docker/bind-mounted relay volumes can trip device-file inode/mtime validation
    // across clean container restarts even with the same persisted primary key.
    // The relay is a single-writer service, so disable device-file enforcement here.
    corestoreAllowBackup: true,
    // A relay without Hyperswarm is not a degraded local app; it cannot
    // discover peers, gossip inventory, or serve retained content to the network.
    requireNetwork: true
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

  function discoveryAcceptsCandidates() {
    if (config?.policy === 'allowlist') return false
    if (config?.discovery?.enabled === false) return false
    if (config?.discovery?.seedDiscovered === false) return false
    return true
  }

  function getFeedEntries() {
    return Array.from(publicFeed.getFeed?.() || publicFeed.entries.values())
  }

  function seedFeedEntries(reason) {
    return seeder.seedFeedEntries(getFeedEntries()).catch((err) => {
      logger.runtime?.warn('Relay feed-entry seeding refresh failed', {
        reason,
        error: err?.message || String(err)
      })
    })
  }

  function emitFeedEntries() {
    if (typeof candidateHandler !== 'function') return
    if (!discoveryAcceptsCandidates()) return

    for (const entry of getFeedEntries()) {
      if (!entry?.driveKey || !entry?.publicBeeKey) continue
      candidateHandler({
        channelKey: entry.driveKey,
        publicBeeKey: entry.publicBeeKey || null,
        source: entry.source === 'relay-cache' ? 'relay-cache' : 'discovered',
        previewVideos: Array.isArray(entry.previewVideos) ? entry.previewVideos : []
      })
    }
  }

  ctx.swarm.on('peer', (peer, topic) => {
    try {
      publicFeed.handleDiscoveredPeer(peer, topic)
    } catch (err) {
      logger.runtime?.warn('Shared-topic peer discovery promotion failed', { error: err?.message || String(err) })
    }
  })

  ctx.swarm.on('connection', (conn, info) => {
    publicFeed.handleConnection(conn, info)
  })

  publicFeed.setOnFeedUpdate(() => {
    try {
      for (const entry of publicFeed.entries.values()) {
        if (entry?.driveKey && entry?.publicBeeKey) {
          cacheManager.addChannel(entry.driveKey, entry.publicBeeKey, 'discovered', {
            previewVideos: Array.isArray(entry.previewVideos) ? entry.previewVideos : []
          }).catch(() => {})
        }
      }
      seedFeedEntries('feed-update')
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
    async publishRelayCatalogEntry(entry) {
      if (!entry?.driveKey || !entry?.publicBeeKey) return null
      const catalogEntry = {
        schema: 'peartube.relayCatalog',
        catalogVersion: 1,
        source: 'relay-cache',
        relayRole: 'cache',
        relayServing: true,
        ...entry,
        driveKey: entry.driveKey,
        publicBeeKey: entry.publicBeeKey,
        previewVideos: Array.isArray(entry.previewVideos) ? entry.previewVideos : []
      }
      await publicFeed.submitRelayCatalogEntry?.(catalogEntry)
      return catalogEntry
    },
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
      // PearTube backend before joining the feed swarm. Otherwise initial
      // HAVE_FEED messages can omit playable relay-cache preview refs.
      if (typeof this.api.getAvailabilityHints === 'function') {
        publicFeed.setAvailabilityHintProvider((requests, conn) => this.api.getAvailabilityHints(requests, conn))
      }
      if (typeof this.api.getFeedSnapshotEntries === 'function') {
        publicFeed.setFeedSnapshotProvider((entries) => this.api.getFeedSnapshotEntries(entries, { limitPerChannel: 3 }))
      }

      await publicFeed.start()

      logger.runtime?.info('Relay runtime started', this.getNetworkStats())
      await seeder.seedCachedChannels(cacheManager).catch((err) => {
        logger.runtime?.warn('Relay seeding refresh failed', { error: err?.message || String(err) })
      })
      await seedFeedEntries('startup')
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
    runPeerRecovery(reason = 'relay-runtime') {
      return publicFeed.runBoundedPeerRecovery?.(reason) || { queued: 0, reason: 'unsupported' }
    },
    getNetworkStats() {
      const feedStats = publicFeed.getStats?.() || {}
      const storageStats = getNetworkStats?.() || {}
      return {
        peers: ctx.swarm?.peers?.size || 0,
        connections: ctx.swarm?.connections?.size || 0,
        feedPeers: feedStats.peerCount || 0,
        feedConnections: feedStats.feedConnections || 0,
        feedChannelCandidates: feedStats.feedChannelCandidates || 0,
        candidateConnections: feedStats.candidateConnections || 0,
        rememberedPeerCandidates: feedStats.rememberedPeerCandidates || 0,
        feedEntries: feedStats.totalEntries || 0,
        dht: {
          bootstrapped: ctx.swarm?.dht?.bootstrapped ?? null,
          firewalled: ctx.swarm?.dht?.firewalled ?? null,
          online: ctx.swarm?.dht?.online ?? null,
          ephemeral: ctx.swarm?.dht?.ephemeral ?? null
        },
        publicFeedDiscoveryJoined: Boolean(publicFeed.feedDiscovery),
        blindPeer: blindPeer.getStats?.() || null,
        peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
        directPeerDial: feedStats.directPeerDial || null,
        doctor: buildNetworkDoctor({
          dht: ctx.swarm?.dht,
          peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
          publicFeedDiscoveryJoined: Boolean(publicFeed?.feedDiscovery),
          directPeerDial: feedStats.directPeerDial || null,
          networkDebug: storageStats,
          swarmPeers: ctx.swarm?.peers?.size || 0,
          swarmConnections: ctx.swarm?.connections?.size || 0,
          connecting: Number(ctx.swarm?.connecting || 0),
          feedConnections: feedStats.feedConnections || 0,
          feedEntries: feedStats.totalEntries || 0,
        }),
        hyperswarm: storageStats?.hyperswarm || null,
        swarmOffline: Boolean(ctx.swarm?._peartubeOffline),
        swarmOfflineReason: ctx.swarm?._peartubeOfflineReason || null,
        swarmListenResolved: Boolean(ctx.swarm?._peartubeListenResolved),
        seeding: seeder.getStats(),
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
