import { createCliLogger } from './cli-logger.js'
import { RelayCatalog } from './catalog.js'
import { buildRelayStatus, writeRelayStatus } from './status.js'
import { createArchiveConsole } from './archive-console.js'
import { createArchiveJobStore, createArchiveManager, createArchivePublisher, createDeferredPublisher, createYtDlpDownloader, createRoutingDownloader } from './archive-manager.js'
import { createDirectDownloader } from './media/direct-download.js'
import { createLocalDriveMirrorState, mirrorLocalDriveToRelayChannel } from './local-drive-mirror.js'
import { RelayCreators, creatorIdFromClassifiedSource } from './creators.js'
import { RelayClassificationStore } from './classification/store.js'
import { createTmdbClassifier, createTmdbDiscoverClient } from './classification/tmdb.js'
import { RelaySettings, resolveTmdbOptions } from './settings.js'
import { TrustedClients, mergeTrustedClientKeys } from './trusted-clients.js'
import { classifySourceUrl } from './archive/source-id.js'
import { createStorageGuard } from './storage-guard.js'
import { createCompanionServer } from './companion/server.js'
import tmdbFetch from '#fetch'


export async function createRelayService({
  config,
  runtimeFactory,
  writeStatusFile = writeRelayStatus,
  logger = createCliLogger(config?.logging?.level || 'info'),
  catalog = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  fsModule = null,
  pathModule = null,
  spawnFn = null,
  nowFn = Date.now,
  companionServerFactory = createCompanionServer
}) {
  if (!config) throw new Error('config is required')
  if (typeof runtimeFactory !== 'function') throw new Error('runtimeFactory is required')

  const relayCatalog = catalog || await RelayCatalog.open({
    storagePath: config.storage.path,
    catalogPath: config.paths.catalog
  })
  const relayCreators = await RelayCreators.open({
    storagePath: config.storage.path,
    creatorsPath: config.paths.creators
  })
  const relaySettings = await RelaySettings.open({ storagePath: config.storage.path })

  // Storage threshold gate: refuse new ingestion (discovery mirroring, archive
  // imports) once actual storage-dir usage reaches storage.maxBytes, or free
  // disk drops below storage.minFreeBytes, so the relay stops growing instead
  // of crashing the whole process with ENOSPC. Degrades gracefully when the
  // injected fs module lacks statfs/stat primitives (e.g. Bare builds).
  const guardFsModule = fsModule || await import('#fs')
  const storageGuard = createStorageGuard({
    storagePath: config.storage.path,
    maxBytes: config.storage.maxBytes || 0,
    minFreeBytes: config.storage.minFreeBytes || 0,
    statfsSync: guardFsModule?.statfsSync || null,
    statSync: guardFsModule?.statSync || null,
    readdirSync: guardFsModule?.readdirSync || null,
    log: (...args) => logger.status?.debug?.(args.map(String).join(' ')),
    now: nowFn
  })
  const classificationStore = await RelayClassificationStore.open({
    storagePath: config.storage.path,
    classificationPath: config.paths.classification
  })
  const tmdbOptions = () => ({ ...resolveTmdbOptions(config, relaySettings), fetchFn: tmdbFetch })
  let classifier = createTmdbClassifier(tmdbOptions())
  let tmdbDiscover = createTmdbDiscoverClient(tmdbOptions())

  // Merge persisted operator-authorized client keys into the bounded seed-pin
  // policy before the universal backend starts.
  const trustedClients = await TrustedClients.open({
    storagePath: config.storage.path,
    trustedClientsPath: config.paths.trustedClients
  })
  config.seedPin = config.seedPin || {}
  config.seedPin.trustedClients = mergeTrustedClientKeys(
    config.seedPin.trustedClients,
    trustedClients.keys()
  )

  const runtime = await runtimeFactory({ config, logger })

  let closed = false
  let started = false
  let startPromise = null
  let currentStatus = null
  let queue = Promise.resolve()
  let heartbeatTimer = null
  let localMirrorTimer = null
  let localMirrorRunning = false
  let archiveConsole = null
  let companionServer = null
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

  function refreshClassifier() {
    const opts = tmdbOptions()
    classifier = createTmdbClassifier(opts)
    tmdbDiscover = createTmdbDiscoverClient(opts)
    return classifier
  }

  // Best-effort movie/TV classification. Cached, and never throws so archiving
  // never depends on TMDB availability.
  async function classifyPreviewVideo(video) {
    if (!video?.id) return video
    if (video.classification?.tmdbId) {
      await classificationStore.set({ videoId: video.id, title: video.title }, video.classification).catch(() => {})
      return video
    }
    try {
      const result = await classificationStore.classifyVideo({
        classifier,
        videoId: video.id,
        title: video.title
      })
      return result ? { ...video, classification: result } : video
    } catch {
      return video
    }
  }

  async function syncCreators() {
    try {
      await relayCreators.syncFromCatalog(relayCatalog.getChannels())
    } catch (err) {
      logger.status?.debug?.('Creator sync failed', { error: err?.message || String(err) })
    }
  }

  async function persistStatus() {
    const runtimeStats = typeof runtime.getDiagnostics === 'function'
      ? await runtime.getDiagnostics()
      : {}
    currentStatus = buildRelayStatus({
      config,
      catalog: relayCatalog,
      runtimeStats,
      trustedClientsCount: trustedClients.list().length
    })

    await Promise.resolve(writeStatusFile(config.paths.status, currentStatus))
    return currentStatus
  }

  async function processCandidate(candidate) {
    if (closed) return { accepted: false, reason: 'closed' }
    if (!candidate?.publisherId || !candidate?.namespaceDescriptor) {
      return { accepted: false, reason: 'publisher-descriptor-required' }
    }
    if (!storageGuard.canIngest()) {
      const snapshot = storageGuard.snapshot()
      return {
        accepted: false,
        reason: snapshot.overBudget ? 'storage-over-budget' : 'storage-low'
      }
    }
    try {
      const followed = await runtime.followPublisher({
        publisherId: candidate.publisherId,
        namespaceDescriptor: candidate.namespaceDescriptor
      })
      const catalog = await runtime.resolvePublisherCatalog({
        publisherId: candidate.publisherId
      })
      await persistStatus()
      return {
        accepted: followed?.status === 'following' || followed?.status === 'already-following',
        reason: followed?.status || 'publisher-follow-failed',
        publisherId: candidate.publisherId,
        catalog
      }
    } catch (error) {
      logger.admission?.warn?.('Publisher catalog follow failed', {
        error: error?.message || String(error)
      })
      return { accepted: false, reason: 'publisher-follow-failed' }
    }
  }

  async function publishArchiveJob(job) {
    if (closed) return { published: false, reason: 'closed' }
    if (job?.status !== 'completed') return { published: false, reason: 'not-completed' }
    if (job?.publish === false) return { published: false, reason: 'not-published' }
    if (!job?.publisherId || !job?.previewVideo?.id) {
      return { published: false, reason: 'missing-publisher-assets' }
    }

    const classifiedPreview = await classifyPreviewVideo(job.previewVideo)
    const publication = classifiedPreview?.immutablePublication
    const published = await runtime.publishPublisherCatalog({
      publisherId: job.publisherId
    })
    if (published?.status !== 'published' && published?.status !== 'already-published') {
      return { published: false, reason: published?.status || 'catalog-publication-failed' }
    }

    const retained = []
    if (publication?.manifest && publication?.renditionId) {
      retained.push(await runtime.retainRendition({
        manifest: publication.manifest,
        renditionId: publication.renditionId
      }))
    }
    if (classifiedPreview?.archivePledge && classifiedPreview?.blobsCoreKey) {
      const [start, length] = String(classifiedPreview.blobId || '').split(':').map(Number)
      if (Number.isSafeInteger(start) && Number.isSafeInteger(length) && length > 0) {
        retained.push(await runtime.retainArchive({
          pledge: classifiedPreview.archivePledge,
          coreKey: classifiedPreview.blobsCoreKey,
          start,
          end: start + length
        }))
      }
    }

    const observedAt = Number(job.completedAt || job.updatedAt || nowFn()) || Date.now()
    const existing = relayCatalog.getChannel(job.channelKey)
    const previews = new Map((existing?.previewVideos || []).filter(video => video?.id).map(video => [video.id, video]))
    previews.set(classifiedPreview.id, classifiedPreview)
    const previewVideos = Array.from(previews.values())
    await relayCatalog.upsertChannel({
      channelKey: job.channelKey,
      publisherId: job.publisherId,
      publicBeeKey: job.publicBeeKey || null,
      source: 'archive-job',
      retentionClass: 'private',
      lastDecisionReason: 'archive-completed',
      lastSeenAt: observedAt,
      mirroredAt: observedAt,
      previewVideos,
      unavailableVideos: [],
      videoCount: previewVideos.length,
      manifestUpdatedAt: observedAt
    })
    await syncCreators()
    await persistStatus()
    return { published: true, previewVideos: previewVideos.length, retained: retained.length }
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
    creators: relayCreators,
    classificationStore,
    settings: relaySettings,
    trustedClients,
    storageGuard,
    canIngest: () => storageGuard.canIngest(),
    canArchive: () => storageGuard.hasMinFreeDisk(),
    getClassifier() {
      return classifier
    },
    async discoverTmdb({ query = '', type = 'movie', page = 1 } = {}) {
      if (!tmdbDiscover?.enabled) return []
      return tmdbDiscover.search({ query, type, page })
    },
    async discoverTmdbSeasons({ tmdbId } = {}) {
      if (!tmdbDiscover?.enabled) return []
      return tmdbDiscover.seasons({ tmdbId })
    },
    async discoverTmdbEpisodes({ tmdbId, season } = {}) {
      if (!tmdbDiscover?.enabled) return []
      return tmdbDiscover.episodes({ tmdbId, season })
    },
    getTrustedClients() {
      return trustedClients.list()
    },
    // Persist operator authorization for bounded catalog and seed-retention
    // requests, then refresh the universal runtime policy when supported.
    async authorizeClient({ key, label = null } = {}) {
      const record = await trustedClients.add({ key, label })
      config.seedPin.trustedClients = mergeTrustedClientKeys(
        config.seedPin.trustedClients,
        trustedClients.keys()
      )
      const liveApplied = Boolean(await runtime.refreshAuthorization?.(config.seedPin.trustedClients).catch?.(() => false))
      logger.relay?.info?.('Authorized trusted client device', { key: record.key, label: record.label, liveApplied })
      await persistStatus()
      return { client: record, liveApplied }
    },
    async revokeClient(key) {
      const removed = await trustedClients.remove(key)
      if (removed) {
        config.seedPin.trustedClients = mergeTrustedClientKeys([], trustedClients.keys())
        await runtime.refreshAuthorization?.(config.seedPin.trustedClients).catch?.(() => false)
        await persistStatus()
      }
      return { removed: Boolean(removed) }
    },
    getLinkDescriptor() {
      return {
        schema: 'peartube.relayLink',
        version: 2,
        seedPin: {
          enabled: config.seedPin.enabled !== false,
          authorizedClients: trustedClients.list().length
        },
        archive: {
          enabled: config.archive?.enabled !== false
        }
      }
    },
    async setTmdbSettings({ apiKey, enabled } = {}) {
      if (apiKey !== undefined) await relaySettings.set('tmdbApiKey', String(apiKey || '').trim())
      if (enabled !== undefined) await relaySettings.set('tmdbEnabled', Boolean(enabled))
      refreshClassifier()
      return resolveTmdbOptions(config, relaySettings)
    },
    getCreatorTargets({ limit = 0 } = {}) {
      return relayCreators.getTargets({ limit })
    },
    // Register a creator (by their channel/source URL) in the creators DB and
    // enqueue an archive job for that URL, attributed to the creator. The
    // creators DB then tracks how many of their videos remain unseeded.
    async addCreatorSource({ url, label = null, publish = true, runNow = true } = {}) {
      const classified = classifySourceUrl(url)
      if (!classified.type) throw new Error(`Unsupported creator/source URL: ${url}`)
      const creatorId = creatorIdFromClassifiedSource(classified)
      const handle = classified.kind === 'handle' ? classified.identifier : null
      const name = label || handle || creatorId
      const creator = await relayCreators.upsertCreator({
        creatorId,
        manual: true,
        label: label || null,
        name,
        handle,
        sourceType: classified.type,
        sourceUrls: [classified.normalizedUrl]
      })
      await syncCreators()
      const job = await service.enqueueArchiveJob({
        url: classified.normalizedUrl,
        channelName: name,
        creatorSourceId: creatorId,
        creatorName: name,
        creatorHandle: handle,
        sourceType: classified.type,
        sourceUrl: classified.normalizedUrl,
        publish
      }, { runNow })
      return { creator, job }
    },
    async start() {
      if (closed) throw new Error('relay service is closed')
      if (started) return service
      if (startPromise) return startPromise
      startPromise = (async () => {
      logger.relay.info('Relay starting', {
        mode: config.mode,
        policy: config.policy,
        storagePath: config.storage.path,
        maxBytes: config.storage.maxBytes,
        configuredChannels: config.admission.channels?.length || 0,
        configuredOwners: config.admission.owners?.length || 0
      })

      try {

      const bootStartedAt = Date.now()
      runtime.setCandidateHandler?.((candidate) => scheduleCandidate({
        source: 'discovered',
        ...candidate
      }))

      // Bring the archive web console up FIRST — before the slow, network-bound
      // runtime bring-up (swarm join + channel seeding) — so the operator web UI
      // is reachable within seconds instead of waiting minutes on boot. The
      // console only needs metaDb (opened by the runtime factory, already ready)
      // to serve browse/discover/settings/upload pages. The archive *publisher*
      // needs managers created during runtime.start(), so it is bound lazily: an
      // archive submitted in the brief pre-ready window waits for the publisher
      // (see below) rather than failing and discarding the upload.
      const deferredPublisher = createDeferredPublisher()
      if (config.archive?.uiEnabled) {
        const runtimeFsModule = fsModule || await import('#fs')
        const runtimePathModule = pathModule || await import('#path')
        archiveConsole = await createArchiveConsole({
          service,
          logger,
          host: config.archive.uiHost || '127.0.0.1',
          port: config.archive.uiPort || 8174,
          uploadDir: config.archive.tmpPath,
          downloader: createRoutingDownloader({
            directDownloader: createDirectDownloader({
              outputDir: config.archive.tmpPath,
              fs: runtimeFsModule,
              path: runtimePathModule
            }),
            ytDlpDownloader: createYtDlpDownloader({
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
            })
          }),
          publisher: deferredPublisher.publisher
        })
        await archiveConsole.start()
        logger.relay.info('Relay archive WebUI listening', {
          host: config.archive.uiHost || '127.0.0.1',
          port: config.archive.uiPort || 8174,
          bootMs: Date.now() - bootStartedAt
        })
      }
      if (config.companion?.enabled !== false) {
        companionServer = await companionServerFactory({
          service,
          config: config.companion,
          clock: nowFn,
          logger
        })
        await companionServer.start()
      }

      const runtimeStartedAt = Date.now()
      await runtime.start?.()
      logger.relay.info('Relay runtime network ready', { runtimeStartMs: Date.now() - runtimeStartedAt })

      // Managers exist now — bind the real archive publisher behind the lazy proxy.
      if (config.archive?.uiEnabled) {
        const runtimeFsModule = fsModule || await import('#fs')
        deferredPublisher.bind(createArchivePublisher({
          identityManager: runtime.identityManager,
          uploadManager: runtime.uploadManager,
          api: runtime.api,
          runtime,
          fs: runtimeFsModule
        }))
      }


      const status = await persistStatus()
      logger.relay.info('Relay started', {
        peers: status.runtime.network?.peers || 0,
        connections: status.runtime.network?.connections || 0,
        publisherCatalogs: status.runtime.publisher?.catalogs || 0,
        bootstrapLocators: status.runtime.bootstrap?.locators || 0,
        retainedRenditions: status.runtime.assets?.retainedRenditions || 0,
        archivedChannels: status.summary.totalChannels
      })

      // Reconcile completed archives against authenticated publisher catalogs
      // and authorized asset retention without blocking operator startup.
      if (runtime.ctx?.metaDb) {
        void (async () => {
          const store = createArchiveJobStore({ metaDb: runtime.ctx.metaDb })
          const jobs = await store.listJobs().catch(() => [])
          for (const job of jobs) {
            if (closed) break
            if (job?.status !== 'completed' || job?.publish === false) continue
            await publishArchiveJob(job).catch((err) => {
              logger.archive.warn('Completed archive reconciliation failed', {
                id: job.id || null,
                videoId: job.videoId || null,
                error: err?.message || String(err)
              })
            })
          }
        })().catch(() => {})
      }

      // Populate the persisted creators DB from the restored catalog so the
      // console/CLI creator views are accurate on boot (then refreshed on the
      // heartbeat and on archive completion). Runs after the console is already
      // listening, so it never delays the web UI.
      await syncCreators()

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
          await syncCreators()
          const heartbeatStatus = await persistStatus()
          const network = heartbeatStatus.runtime.network || {}
          if ((network.peers || 0) > 0 && (network.connections || 0) === 0) {
            logger.status.warn('Relay discovered peers without sockets', {
              peers: network.peers,
              connections: network.connections,
              networkStatus: network.status || 'unknown'
            })
          }
          if ((network.peers || 0) === 0 && network.dht?.bootstrapped === false) {
            logger.status.warn('Relay DHT has no discovered peers and is not bootstrapped', {
              peers: network.peers || 0,
              connections: network.connections || 0,
              bootstrapped: network.dht.bootstrapped,
              firewalled: network.dht.firewalled ?? null,
              online: network.dht.online ?? null,
              listenResolved: Boolean(network.listenResolved),
              offline: Boolean(network.offline),
              offlineReason: network.offlineReason || null
            })
          }
          logger.status.info('Relay heartbeat', {
            peers: network.peers || 0,
            connections: network.connections || 0,
            publisherCatalogs: heartbeatStatus.runtime.publisher?.catalogs || 0,
            followedPublishers: heartbeatStatus.runtime.publisher?.followed || 0,
            bootstrapLocators: heartbeatStatus.runtime.bootstrap?.locators || 0,
            retainedRenditions: heartbeatStatus.runtime.assets?.retainedRenditions || 0,
            activeArchivePledges: heartbeatStatus.runtime.archive?.activePledgeCount || 0,
            activeSeeds: heartbeatStatus.runtime.seedRetention?.activeSeeds || 0
          })
        } catch (err) {
          logger.status.error('Relay heartbeat failed', {
            error: err?.message || String(err)
          })
        }
      }, 30_000)


      return service
      } catch (error) {
        if (heartbeatTimer) {
          clearIntervalFn(heartbeatTimer)
          heartbeatTimer = null
        }
        if (localMirrorTimer) {
          clearIntervalFn(localMirrorTimer)
          localMirrorTimer = null
        }
        if (companionServer) {
          await companionServer.close().catch(() => {})
          companionServer = null
        }
        if (archiveConsole) {
          await archiveConsole.close().catch(() => {})
          archiveConsole = null
        }
        try {
          await runtime.close?.()
        } catch {
          // Preserve the startup error after best-effort runtime cleanup.
        }
        throw error
      }
      })()
      try {
        const result = await startPromise
        started = true
        return result
      } catch (error) {
        startPromise = null
        throw error
      }
    },
    async processCandidate(candidate) {
      return scheduleCandidate(candidate)
    },
    async publishArchiveJob(job) {
      return publishArchiveJob(job)
    },
    async searchIndexCandidates(selector, { cursor = null, limit = undefined, signal = null } = {}) {
      if (cursor !== null || !selector?.namespace || !selector?.identifier || !selector?.kind) {
        const error = new Error('Index search selector is unsupported')
        error.code = 'INDEX_SEARCH_UNSUPPORTED'
        throw error
      }
      if (typeof runtime.api?.searchIndexCandidates !== 'function') {
        const error = new Error('Index candidate search is unsupported')
        error.code = 'INDEX_SEARCH_UNSUPPORTED'
        throw error
      }
      return runtime.api.searchIndexCandidates(selector, { limit, signal })
    },
    async verifyIndexCandidate(candidateRef, { signal = null } = {}) {
      if (typeof runtime.api?.verifyIndexCandidate !== 'function') {
        const error = new Error('Index candidate verification is unsupported')
        error.code = 'INDEX_VERIFICATION_UNSUPPORTED'
        throw error
      }
      return runtime.api.verifyIndexCandidate(candidateRef, { signal })
    },
    async enqueueArchiveJob(input, { runNow = false } = {}) {
      if (!runtime.ctx?.metaDb) throw new Error('archive jobs require relay runtime metadata storage')
      // Deliberate uploads are the relay's purpose; they are only refused when
      // the disk is genuinely low (ENOSPC risk), NOT when the evictable
      // discovery cache merely filled the logical storage.maxBytes budget.
      if (!storageGuard.hasMinFreeDisk()) {
        const snap = storageGuard.snapshot()
        logger.status?.warn?.('Storage floor reached; refusing archive ingestion', {
          freeBytes: snap.freeBytes,
          minFreeBytes: snap.minFreeBytes
        })
        throw new Error(`relay storage low on disk (free ${snap.freeBytes ?? 'unknown'} < floor ${snap.minFreeBytes}); free space before archiving`)
      }
      const runtimeFsModule = fsModule || await import('#fs')
      const runtimePathModule = pathModule || await import('#path')
      const store = createArchiveJobStore({ metaDb: runtime.ctx.metaDb })
      const manager = createArchiveManager({
        store,
        logger,
        canIngest: () => storageGuard.hasMinFreeDisk(),
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
        onCompleted: (job) => service.publishArchiveJob(job)
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
    getCompanionState() {
      return companionServer?.state?.() || {
        enabled: false,
        transport: config.companion?.transport || 'unix'
      }
    },
    getStatus() {
      return currentStatus || buildRelayStatus({
        config,
        catalog: relayCatalog,
        runtimeStats: {}
      })
    },
    async close() {
      closed = true
      if (startPromise && !started) await startPromise.catch(() => {})
      if (heartbeatTimer) {
        clearIntervalFn(heartbeatTimer)
        heartbeatTimer = null
      }
      if (localMirrorTimer) {
        clearIntervalFn(localMirrorTimer)
        localMirrorTimer = null
      }
      if (companionServer) {
        await companionServer.close().catch(() => {})
        companionServer = null
      }
      if (archiveConsole) {
        await archiveConsole.close().catch(() => {})
        archiveConsole = null
      }
      await queue.catch(() => {})
      await persistStatus()
      await runtime.close?.()
    }
  }

  return service
}
