import { createCliLogger } from './cli-logger.js'
import { evaluateCandidate } from './admission.js'
import { RelayCatalog } from './catalog.js'
import { buildRelayStatus, writeRelayStatus } from './status.js'
import { createArchiveConsole } from './archive-console.js'
import { createArchiveJobStore, createArchiveManager, createArchivePublisher, createYtDlpDownloader } from './archive-manager.js'
import { createLocalDriveMirrorState, mirrorLocalDriveToRelayChannel } from './local-drive-mirror.js'

const MIRROR_RETRY_COOLDOWN_MS = 5 * 60_000

export async function createRelayService({
  config,
  runtimeFactory,
  mirrorChannel,
  writeStatusFile = writeRelayStatus,
  logger = createCliLogger(config?.logging?.level || 'info'),
  catalog = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  fsModule = null,
  pathModule = null,
  spawnFn = null,
  nowFn = Date.now
}) {
  if (!config) throw new Error('config is required')
  if (typeof runtimeFactory !== 'function') throw new Error('runtimeFactory is required')
  if (typeof mirrorChannel !== 'function') throw new Error('mirrorChannel is required')

  const relayCatalog = catalog || await RelayCatalog.open({
    storagePath: config.storage.path,
    catalogPath: config.paths.catalog
  })
  const runtime = await runtimeFactory({ config, logger })

  let closed = false
  let currentStatus = null
  let queue = Promise.resolve()
  let heartbeatTimer = null
  let localMirrorTimer = null
  let localMirrorRunning = false
  let archiveConsole = null
  const localMirrorState = createLocalDriveMirrorState()

  function createLocalDrivePublisher(runtimeFsModule) {
    return createArchivePublisher({
      identityManager: runtime.identityManager,
      uploadManager: runtime.uploadManager,
      api: runtime.api,
      runtime,
      fs: runtimeFsModule
    })
  }

  function getPreviewBlobSignature(previewVideos) {
    if (!Array.isArray(previewVideos) || previewVideos.length === 0) return ''
    return previewVideos
      .filter((video) => video?.blobsCoreKey && video?.blobId)
      .map((video) => [
        String(video.blobsCoreKey).toLowerCase(),
        String(video.blobId),
        video?.thumbnailBlobsCoreKey ? String(video.thumbnailBlobsCoreKey).toLowerCase() : '',
        video?.thumbnailBlobId ? String(video.thumbnailBlobId) : ''
      ].join(':'))
      .sort()
      .join('|')
  }

  function getAcceptedRefreshDecision(existing, candidate, now) {
    const unavailable = {
      refresh: false,
      skip: false,
      incomingSignature: ''
    }
    if (!existing?.channelKey) return unavailable
    if (!Array.isArray(candidate?.previewVideos)) return unavailable

    const incomingSignature = getPreviewBlobSignature(candidate.previewVideos)
    const existingSignature = getPreviewBlobSignature(existing.previewVideos)
    if (!incomingSignature) return unavailable

    const lastAttemptSignature = existing.lastMirrorPreviewSignature || ''
    const lastAttemptAt = Number(existing.lastMirrorAttemptAt || 0) || 0
    const retryAfterMs = MIRROR_RETRY_COOLDOWN_MS - (now - lastAttemptAt)
    if (!existingSignature && lastAttemptSignature === incomingSignature && retryAfterMs > 0) {
      return {
        refresh: false,
        skip: true,
        reason: 'preview-refresh-cooldown',
        incomingSignature,
        retryAfterMs
      }
    }

    return {
      refresh: true,
      skip: false,
      reason: 'accepted-preview-refresh',
      incomingSignature,
      retryAfterMs: 0
    }
  }

  async function runLocalMirrorOnce(localMirrorConfig = config.archive?.localMirror || {}) {
    if (!localMirrorConfig?.enabled) return null
    if (localMirrorRunning) return { skipped: true, reason: 'already-running' }
    localMirrorRunning = true
    try {
      const runtimeFsModule = fsModule || await import('#fs')
      const runtimePathModule = pathModule || await import('#path')
      const result = await mirrorLocalDriveToRelayChannel({
        rootPath: localMirrorConfig.path,
        channelName: localMirrorConfig.channelName || 'Local Drive Mirror',
        description: localMirrorConfig.description || '',
        recursive: localMirrorConfig.recursive !== false,
        maxFiles: Number.isFinite(Number(localMirrorConfig.maxFiles)) ? Number(localMirrorConfig.maxFiles) : Infinity,
        fs: runtimeFsModule,
        path: runtimePathModule,
        logger,
        state: localMirrorState,
        publisher: createLocalDrivePublisher(runtimeFsModule)
      })
      if (result?.imported || result?.failed) {
        logger.archive.info('Local mirror scan complete', {
          path: localMirrorConfig.path,
          scanned: result.scanned,
          imported: result.imported,
          skipped: result.skipped,
          failed: result.failed
        })
        await persistStatus()
      }
      return result
    } catch (err) {
      logger.archive.error('Local mirror scan failed', {
        path: localMirrorConfig.path || null,
        error: err?.message || String(err)
      })
      return { error: err?.message || String(err) }
    } finally {
      localMirrorRunning = false
    }
  }

  async function persistStatus() {
    currentStatus = buildRelayStatus({
      config,
      catalog: relayCatalog,
      runtimeStats: runtime.getNetworkStats?.() || {}
    })

    await Promise.resolve(writeStatusFile(config.paths.status, currentStatus))
    return currentStatus
  }

  async function processCandidate(candidate) {
    if (closed) {
      return { accepted: false, reason: 'closed' }
    }

    const now = Number(nowFn()) || Date.now()
    const resolved = runtime.resolveCandidate
      ? await runtime.resolveCandidate(candidate)
      : candidate

    const existingChannel = relayCatalog.getChannel(resolved.channelKey)
    const refreshDecision = getAcceptedRefreshDecision(existingChannel, resolved, now)
    const refreshAcceptedChannel = refreshDecision.refresh

    if (refreshDecision.skip) {
      const retentionClass = existingChannel.retentionClass || resolved.retentionClass || 'discovery'
      await relayCatalog.upsertChannel({
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || existingChannel.ownerKey || null,
        publicBeeKey: resolved.publicBeeKey || existingChannel.publicBeeKey || null,
        source: resolved.source || existingChannel.source || 'discovered',
        retentionClass,
        lastDecisionReason: refreshDecision.reason,
        lastSeenAt: now
      })
      logger.mirror.debug('Accepted channel refresh skipped during mirror retry cooldown', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || existingChannel.ownerKey || null,
        retryAfterMs: Math.ceil(refreshDecision.retryAfterMs)
      })
      await persistStatus()
      return { accepted: true, retentionClass, reason: refreshDecision.reason }
    }

    const decision = refreshAcceptedChannel
      ? {
        accepted: true,
        reason: refreshDecision.reason,
        retentionClass: existingChannel.retentionClass || resolved.retentionClass || 'discovery'
      }
      : evaluateCandidate({
        candidate: resolved,
        config,
        acceptedChannels: new Set(relayCatalog.getChannels().map((channel) => channel.channelKey)),
        ownerCounts: relayCatalog.getOwnerCounts()
      })

    if (!decision.accepted) {
      logger.admission.info('Candidate rejected', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        source: resolved.source || 'discovered',
        reason: decision.reason
      })
      await persistStatus()
      return decision
    }

    const baseRecord = {
      channelKey: resolved.channelKey,
      ownerKey: resolved.ownerKey || null,
      publicBeeKey: resolved.publicBeeKey || null,
      source: resolved.source || 'discovered',
      retentionClass: decision.retentionClass,
      lastDecisionReason: decision.reason,
      lastSeenAt: now
    }
    const incomingPreviewSignature = refreshDecision.incomingSignature || getPreviewBlobSignature(resolved.previewVideos)
    const mirrorAttemptRecord = incomingPreviewSignature
      ? {
        lastMirrorAttemptAt: now,
        lastMirrorPreviewSignature: incomingPreviewSignature
      }
      : {}

    await relayCatalog.upsertChannel(baseRecord)

    try {
      logger.admission.info('Candidate accepted', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        source: resolved.source || 'discovered',
        retentionClass: decision.retentionClass,
        reason: decision.reason
      })

      const mirrorStats = await mirrorChannel(resolved, {
        config,
        runtime,
        logger,
        catalog: relayCatalog,
        decision
      })

      const mirrorUnavailableVideos = Array.isArray(mirrorStats?.unavailableVideos) ? mirrorStats.unavailableVideos : []
      const hasUnavailableVideos = mirrorUnavailableVideos.length > 0
      const mirrorReturnedPreviewVideos = Array.isArray(mirrorStats?.previewVideos)
      const refreshedPreviewVideos = mirrorReturnedPreviewVideos
        ? mirrorStats.previewVideos
        : (hasUnavailableVideos
            ? []
            : (Array.isArray(existingChannel?.previewVideos) && existingChannel.previewVideos.length > 0
                ? existingChannel.previewVideos
                : undefined))

      await relayCatalog.upsertChannel({
        ...baseRecord,
        ...mirrorAttemptRecord,
        bytes: mirrorStats?.bytesDownloaded || 0,
        videosFound: mirrorStats?.videosFound || 0,
        videosDownloaded: mirrorStats?.videosDownloaded || 0,
        mirroredAt: now,
        lastError: mirrorStats?.lastError || null,
        previewVideos: refreshedPreviewVideos,
        unavailableVideos: hasUnavailableVideos ? mirrorUnavailableVideos : [],
        videoCount: Number(mirrorStats?.videoCount || mirrorStats?.videosDownloaded || mirrorStats?.videosFound || 0) || 0,
        manifestUpdatedAt: now
      })

      if (refreshAcceptedChannel) {
        logger.mirror.info('Accepted channel refreshed from preview refs', {
          channelKey: resolved.channelKey,
          ownerKey: resolved.ownerKey || null,
          videosDownloaded: mirrorStats?.videosDownloaded || 0,
          bytesDownloaded: mirrorStats?.bytesDownloaded || 0
        })
      }

      if (resolved.publicBeeKey) {
        const seedPreviewVideos = Array.isArray(mirrorStats?.previewVideos)
          ? mirrorStats.previewVideos
          : (hasUnavailableVideos ? [] : (Array.isArray(resolved.previewVideos) ? resolved.previewVideos : []))
        const persistedPreviewVideos = seedPreviewVideos.length > 0
          ? seedPreviewVideos
          : (hasUnavailableVideos || mirrorReturnedPreviewVideos ? [] : (Array.isArray(existingChannel?.previewVideos) ? existingChannel.previewVideos : []))
        await runtime.cacheManager?.addChannel?.(resolved.channelKey, resolved.publicBeeKey, 'discovered', {
          previewVideos: seedPreviewVideos,
          clearPreviewVideos: hasUnavailableVideos
        }).catch(() => {})
        const seedStats = await runtime.seeder?.seedChannel?.({
          driveKey: resolved.channelKey,
          publicBeeKey: resolved.publicBeeKey,
          previewVideos: seedPreviewVideos
        }).catch(() => null)
        const catalogEntry = seedStats?.catalogEntry || {
          schema: 'peartube.relayCatalog',
          catalogVersion: 1,
          driveKey: resolved.channelKey,
          publicBeeKey: resolved.publicBeeKey,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          previewVideos: persistedPreviewVideos,
          unavailableVideos: mirrorUnavailableVideos,
          videoCount: Number(mirrorStats?.videoCount || mirrorStats?.videosDownloaded || mirrorStats?.videosFound || persistedPreviewVideos.length || 0) || 0,
          manifestUpdatedAt: now
        }
        await runtime.publishRelayCatalogEntry?.(catalogEntry).catch(() => {})
      }

      logger.mirror.info('Channel mirrored', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        retentionClass: decision.retentionClass,
        bytesDownloaded: mirrorStats?.bytesDownloaded || 0,
        videosFound: mirrorStats?.videosFound || 0,
        videosDownloaded: mirrorStats?.videosDownloaded || 0
      })
    } catch (err) {
      await relayCatalog.upsertChannel({
        ...baseRecord,
        ...mirrorAttemptRecord,
        videosDownloaded: 0,
        bytes: 0,
        previewVideos: [],
        videoCount: 0,
        lastError: err?.message || String(err)
      })

      logger.mirror.error('Channel mirror failed', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        retentionClass: decision.retentionClass,
        error: err?.message || String(err)
      })
    }

    await persistStatus()
    return { accepted: true, retentionClass: decision.retentionClass, reason: decision.reason }
  }

  async function publishArchiveJobToFeed(job) {
    if (closed) return { published: false, reason: 'closed' }
    if (job?.status !== 'completed') return { published: false, reason: 'not-completed' }
    if (!job?.channelKey || !job?.publicBeeKey || !job?.previewVideo?.id) {
      return { published: false, reason: 'missing-refs' }
    }

    const previewVideos = [{
      ...job.previewVideo,
      publicBeeKey: job.publicBeeKey || job.previewVideo.publicBeeKey || null,
      channelKey: job.channelKey,
      driveKey: job.channelKey,
      relayBacked: true,
      source: job.previewVideo.source || 'relay-cache',
      relayRole: job.previewVideo.relayRole || 'cache',
      relayServing: true,
      availability: job.previewVideo.availability || 'playable',
      byteAvailability: job.previewVideo.byteAvailability || job.previewVideo.availability || 'playable'
    }]
    const manifestUpdatedAt = Number(job.completedAt || job.updatedAt || nowFn()) || Date.now()

    await relayCatalog.upsertChannel({
      channelKey: job.channelKey,
      publicBeeKey: job.publicBeeKey,
      source: 'archive-job',
      retentionClass: 'private',
      relayRole: 'cache',
      relayServing: true,
      lastDecisionReason: 'archive-completed',
      lastSeenAt: manifestUpdatedAt,
      mirroredAt: manifestUpdatedAt,
      previewVideos,
      unavailableVideos: [],
      videoCount: previewVideos.length,
      manifestUpdatedAt
    })

    await runtime.cacheManager?.addChannel?.(job.channelKey, job.publicBeeKey, 'private', {
      previewVideos
    }).catch(() => {})
    await runtime.publicFeed?.submitChannel?.(job.channelKey, job.publicBeeKey, {
      channelName: job.channelName || previewVideos[0]?.channelName || null,
      previewVideos,
      videoCount: previewVideos.length,
      manifestUpdatedAt
    }).catch(() => {})
    const seedStats = await runtime.seeder?.seedChannel?.({
      driveKey: job.channelKey,
      publicBeeKey: job.publicBeeKey,
      previewVideos
    }).catch(() => null)
    const catalogEntry = seedStats?.catalogEntry || {
      schema: 'peartube.relayCatalog',
      catalogVersion: 1,
      driveKey: job.channelKey,
      publicBeeKey: job.publicBeeKey,
      source: 'relay-cache',
      relayRole: 'cache',
      relayServing: true,
      previewVideos,
      unavailableVideos: [],
      videoCount: previewVideos.length,
      manifestUpdatedAt
    }
    await runtime.publishRelayCatalogEntry?.(catalogEntry).catch(() => {})
    await persistStatus()
    return { published: true, previewVideos: previewVideos.length }
  }

  function scheduleCandidate(candidate) {
    queue = queue.then(() => processCandidate(candidate))
    return queue
  }

  const service = {
    config,
    logger,
    runtime,
    catalog: relayCatalog,
    async start() {
      logger.relay.info('Relay starting', {
        mode: config.mode,
        policy: config.policy,
        storagePath: config.storage.path,
        maxBytes: config.storage.maxBytes,
        configuredChannels: config.admission.channels?.length || 0,
        configuredOwners: config.admission.owners?.length || 0
      })

      runtime.setCandidateHandler?.((candidate) => scheduleCandidate({
        source: 'discovered',
        ...candidate
      }))

      await runtime.start?.()

      for (const channelKey of config.admission.channels || []) {
        await scheduleCandidate({
          channelKey,
          source: 'config'
        })
      }

      const status = await persistStatus()
      logger.relay.info('Relay started', {
        peers: status.runtime.peers,
        connections: status.runtime.connections,
        feedPeers: status.runtime.feedPeers,
        feedConnections: status.runtime.feedConnections,
        feedEntries: status.runtime.feedEntries,
        mirroredChannels: status.summary.totalChannels
      })

      if (runtime.ctx?.metaDb) {
        const store = createArchiveJobStore({ metaDb: runtime.ctx.metaDb })
        const jobs = await store.listJobs().catch(() => [])
        for (const job of jobs) {
          if (job?.status === 'completed') {
            await publishArchiveJobToFeed(job).catch((err) => {
              logger.archive.warn('Completed archive job feed publication failed', {
                id: job.id || null,
                videoId: job.videoId || null,
                error: err?.message || String(err)
              })
            })
          }
        }
      }

      if (config.archive?.uiEnabled) {
        const runtimeFsModule = fsModule || await import('#fs')
        const runtimePathModule = pathModule || await import('#path')
        archiveConsole = await createArchiveConsole({
          service,
          logger,
          host: config.archive.uiHost || '127.0.0.1',
          port: config.archive.uiPort || 8174,
          downloader: createYtDlpDownloader({
            bin: config.archive.ytDlpPath,
            outputDir: config.archive.tmpPath,
            format: config.archive.format,
            ffmpegPath: config.archive.ffmpegPath,
            cookiesPath: config.archive.cookiesPath,
            jsRuntime: config.archive.jsRuntime,
            ytDlpExtraArgs: config.archive.ytDlpExtraArgs,
            ytDlpRetryExtraArgs: config.archive.ytDlpRetryExtraArgs,
            spawnFn: spawnFn || undefined,
            fs: runtimeFsModule,
            path: runtimePathModule
          }),
          publisher: createArchivePublisher({
            identityManager: runtime.identityManager,
            uploadManager: runtime.uploadManager,
            api: runtime.api,
            runtime,
            fs: runtimeFsModule
          })
        })
        await archiveConsole.start()
      }

      if (config.archive?.localMirror?.enabled) {
        const pollMs = Math.max(1, Number(config.archive.localMirror.poll || 30)) * 1000
        const triggerLocalMirrorScan = () => runLocalMirrorOnce().catch((err) => {
          logger.archive.error('Local mirror periodic scan failed', { error: err?.message || String(err) })
          return { error: err?.message || String(err) }
        })
        localMirrorTimer = setIntervalFn(triggerLocalMirrorScan, pollMs)
        localMirrorTimer?.unref?.()
        triggerLocalMirrorScan()
        logger.archive.info('Local directory mirror started', {
          path: config.archive.localMirror.path,
          pollSeconds: Math.round(pollMs / 1000),
          channelName: config.archive.localMirror.channelName
        })
      }

      heartbeatTimer = setIntervalFn(async () => {
        try {
          const heartbeatStatus = await persistStatus()
          const directPeerDial = heartbeatStatus.runtime.directPeerDial || {}
          if ((heartbeatStatus.runtime.peers || 0) > 0 && (heartbeatStatus.runtime.connections || 0) === 0) {
            logger.status.warn('Relay discovered peers without sockets', {
              peers: heartbeatStatus.runtime.peers,
              connections: heartbeatStatus.runtime.connections,
              discoveredPeers: directPeerDial.discoveredPeers || 0,
              pending: directPeerDial.pending || 0,
              queued: directPeerDial.queued || 0,
              skipped: directPeerDial.skipped || 0,
              failed: directPeerDial.failed || 0,
              connected: directPeerDial.connected || 0,
              lastReason: directPeerDial.lastReason || null,
              swarmConnecting: directPeerDial.swarmConnecting || 0,
              swarmAllConnections: directPeerDial.swarmAllConnections || 0,
              swarmExplicitPeers: directPeerDial.swarmExplicitPeers || 0,
              swarmQueueSize: directPeerDial.swarmQueueSize || 0,
              dialPeers: Array.isArray(directPeerDial.peers) ? directPeerDial.peers : [],
              hyperswarm: heartbeatStatus.runtime.hyperswarm || null
            })
          }
          const dht = heartbeatStatus.runtime.dht || {}
          if ((heartbeatStatus.runtime.peers || 0) === 0 && dht.bootstrapped === false) {
            logger.status.warn('Relay DHT has no discovered peers and is not bootstrapped', {
              peers: heartbeatStatus.runtime.peers || 0,
              connections: heartbeatStatus.runtime.connections || 0,
              bootstrapped: dht.bootstrapped,
              firewalled: dht.firewalled ?? null,
              online: dht.online ?? null,
              ephemeral: dht.ephemeral ?? null,
              publicFeedDiscoveryJoined: Boolean(heartbeatStatus.runtime.publicFeedDiscoveryJoined),
              peerPoolJoined: Boolean(heartbeatStatus.runtime.peerPoolJoined),
              swarmListenResolved: Boolean(heartbeatStatus.runtime.swarmListenResolved),
              swarmOffline: Boolean(heartbeatStatus.runtime.swarmOffline),
              swarmOfflineReason: heartbeatStatus.runtime.swarmOfflineReason || null,
              hyperswarm: heartbeatStatus.runtime.hyperswarm || null
            })
          }
          if ((heartbeatStatus.runtime.peers || 0) > 0 && (heartbeatStatus.runtime.connections || 0) === 0) {
            const recovery = runtime.runPeerRecovery?.('relay-heartbeat') || null
            if (recovery) {
              logger.status.warn('Relay observed peers without sockets; leaving dialing to Hyperswarm', recovery)
            }
          }
          logger.status.info('Relay heartbeat', {
            peers: heartbeatStatus.runtime.peers,
            connections: heartbeatStatus.runtime.connections,
            feedPeers: heartbeatStatus.runtime.feedPeers,
            feedConnections: heartbeatStatus.runtime.feedConnections,
            feedEntries: heartbeatStatus.runtime.feedEntries,
            mirroredChannels: heartbeatStatus.summary.totalChannels,
            discoveredPeers: directPeerDial.discoveredPeers || 0,
            dialPending: directPeerDial.pending || 0,
            dialQueued: directPeerDial.queued || 0,
            dialSkipped: directPeerDial.skipped || 0,
            dialFailed: directPeerDial.failed || 0,
            dialConnected: directPeerDial.connected || 0,
            dialLastReason: directPeerDial.lastReason || null
          })
        } catch (err) {
          logger.status.error('Relay heartbeat failed', {
            error: err?.message || String(err)
          })
        }
      }, 30_000)

      return service
    },
    async processCandidate(candidate) {
      return scheduleCandidate(candidate)
    },
    async publishArchiveJobToFeed(job) {
      return publishArchiveJobToFeed(job)
    },
    async enqueueArchiveJob(input, { runNow = false } = {}) {
      if (!runtime.ctx?.metaDb) throw new Error('archive jobs require relay runtime metadata storage')
      const runtimeFsModule = fsModule || await import('#fs')
      const runtimePathModule = pathModule || await import('#path')
      const store = createArchiveJobStore({ metaDb: runtime.ctx.metaDb })
      const manager = createArchiveManager({
        store,
        logger,
        downloader: createYtDlpDownloader({
          bin: config.archive?.ytDlpPath,
          outputDir: config.archive?.tmpPath || './peartube-relay/archive-tmp',
          format: config.archive?.format,
          ffmpegPath: config.archive?.ffmpegPath,
          cookiesPath: config.archive?.cookiesPath,
          jsRuntime: config.archive?.jsRuntime,
          ytDlpExtraArgs: config.archive?.ytDlpExtraArgs,
          ytDlpRetryExtraArgs: config.archive?.ytDlpRetryExtraArgs,
          spawnFn: spawnFn || undefined,
          fs: runtimeFsModule,
          path: runtimePathModule
        }),
        publisher: createArchivePublisher({
          identityManager: runtime.identityManager,
          uploadManager: runtime.uploadManager,
          api: runtime.api,
          runtime,
          fs: runtimeFsModule
        }),
        onCompleted: (job) => service.publishArchiveJobToFeed(job)
      })
      const job = await manager.enqueue(input)
      if (runNow) return manager.runJob(job.id)
      return job
    },
    async mirrorLocalDrive(input = {}) {
      return runLocalMirrorOnce({
        enabled: true,
        path: input.path || input.rootPath,
        channelName: input.channelName || 'Local Drive Mirror',
        description: input.description || '',
        recursive: input.recursive !== false,
        maxFiles: Number.isFinite(Number(input.maxFiles)) ? Number(input.maxFiles) : Infinity
      })
    },
    getStatus() {
      return currentStatus || buildRelayStatus({
        config,
        catalog: relayCatalog,
        runtimeStats: runtime.getNetworkStats?.() || {}
      })
    },
    async close() {
      closed = true
      if (heartbeatTimer) {
        clearIntervalFn(heartbeatTimer)
        heartbeatTimer = null
      }
      if (localMirrorTimer) {
        clearIntervalFn(localMirrorTimer)
        localMirrorTimer = null
      }
      if (archiveConsole) {
        await archiveConsole.close().catch(() => {})
        archiveConsole = null
      }
      await queue.catch(() => {})
      await runtime.close?.()
      await persistStatus()
    }
  }

  return service
}
