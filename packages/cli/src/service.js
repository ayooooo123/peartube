import b4a from 'b4a'
import { createCliLogger } from './cli-logger.js'
import { RelayCatalog } from './catalog.js'
import { buildRelayStatus, writeRelayStatus } from './status.js'
import { createArchiveConsole, createArchiveHttpSurface } from './archive-console.js'
import { createRelayPublisherShell } from './publisher-shell.js'
import { createArchivePublisher, createYtDlpDownloader } from './archive-manager.js'
import { createLocalDriveMirrorState, mirrorLocalDriveToRelayChannel } from './local-drive-mirror.js'
import { RelayCreators, creatorIdFromClassifiedSource } from './creators.js'
import { RelayClassificationStore } from './classification/store.js'
import { createTmdbClassifier, createTmdbDiscoverClient } from './classification/tmdb.js'
import { RelaySettings, resolveTmdbOptions } from './settings.js'
import { TrustedClients, mergeTrustedClientKeys } from './trusted-clients.js'
import { classifySourceUrl } from './archive/source-id.js'
import { createRelayBlockOffload } from './archive/block-offload.js'
import { createStorageGuard } from './storage-guard.js'
import { createCompanionServer } from './companion/server.js'
import { createLegacyIngestMigrationStore } from './companion/legacy-ingest-migration-store.js'
import tmdbFetch from '#fetch'

const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{43}$/
function selectorForMediaCoordinates(source = {}) {
  const coordinates = source.mediaCoordinates || source
  const namespace = String(coordinates.mediaProvider || coordinates.namespace || '').trim()
  const identifier = String(coordinates.mediaId || coordinates.identifier || '').trim()
  if (!namespace || !identifier) return null
  if (coordinates.contentKind === 'episode') {
    const season = Number(coordinates.seasonNumber)
    const episode = Number(coordinates.episodeNumber)
    if (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1) return null
    return { namespace, identifier, kind: 'episode', season, episode }
  }
  return { namespace, identifier, kind: coordinates.contentKind || 'movie' }
}

// The last path segment, and only that: a relay records what the source called
// the file, never where it lived on the machine that submitted it.
function sourceFileNameOf(value) {
  const name = String(value || '').split(/[/\\]/).pop().trim()
  return name && name.length <= 255 ? name : null
}

function createStreamAsset(opened) {
  const asset = Object.freeze({
    assetId: opened.assetId,
    byteLength: opened.byteLength,
    mimeType: opened.contentType,
    etag: `"asset-${opened.assetId}"`,
    async requestRange({ byteStart, byteEnd, signal: rangeSignal } = {}) {
      if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
          byteStart < 0 || byteEnd <= byteStart || byteEnd > opened.byteLength) {
        return { status: 'unavailable', verified: false, bytes: b4a.alloc(0) }
      }
      const expectedLength = byteEnd - byteStart
      const chunks = []
      let received = 0
      for await (const chunk of opened.read({ start: byteStart, length: expectedLength, signal: rangeSignal })) {
        if (rangeSignal?.aborted) throw rangeSignal.reason || new Error('stream range aborted')
        const bytes = b4a.from(chunk)
        received += bytes.byteLength
        if (received > expectedLength) {
          return { status: 'unavailable', verified: false, bytes: b4a.alloc(0) }
        }
        chunks.push(bytes)
      }
      if (received !== expectedLength) {
        return { status: 'unavailable', verified: false, bytes: b4a.alloc(0) }
      }
      return { status: 'ok', verified: true, bytes: b4a.concat(chunks, received) }
    },
    release: () => opened.close?.()
  })
  return {
    publicationId: opened.publicationId,
    renditionId: opened.renditionId,
    assetId: opened.assetId,
    asset
  }
}
function createProviderMachineService(runtime, options = {}) {

  const provider = runtime?.provider
  if (!provider) return null
  const warming = new Set()
  async function warmPublishedCandidate(candidate, options = {}) {
    const requestedStart = Number.isSafeInteger(options.byteStart) && options.byteStart >= 0
      ? options.byteStart
      : null
    const key = `${candidate.publicationId}:${candidate.renditionId}:${requestedStart ?? 'startup'}`
    if (warming.has(key) || typeof runtime.api?.openMediaRendition !== 'function') return
    warming.add(key)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    timeout.unref?.()
    let opened = null
    try {
      opened = await runtime.api.openMediaRendition({
        publicationId: candidate.publicationId,
        renditionId: candidate.renditionId,
        signal: controller.signal
      })
      if (!opened?.success || typeof opened.read !== 'function') return
      let ranges
      if (requestedStart !== null && requestedStart < opened.byteLength) {
        const length = Math.min(opened.byteLength - requestedStart, 4 * 1024 * 1024)
        ranges = [{ start: requestedStart, length }]
      } else {
        const headLength = Math.min(opened.byteLength, 16 * 1024 * 1024)
        const tailLength = Math.min(opened.byteLength - headLength, 4 * 1024 * 1024)
        ranges = [{ start: 0, length: headLength }]
        if (tailLength > 0) ranges.push({ start: opened.byteLength - tailLength, length: tailLength })
      }
      await Promise.all(ranges.map(async range => {
        for await (const _chunk of opened.read({ ...range, signal: controller.signal })) {
          if (controller.signal.aborted) break
        }
      }))
    } catch {
      // Warming is opportunistic. Playback still owns the authoritative read.
    } finally {
      clearTimeout(timeout)
      await opened?.close?.().catch(() => {})
      warming.delete(key)
    }
  }
  return Object.freeze({
    ...provider,
    async search(input = {}) {
      const result = await provider.search(input)
      const releaseFileNames = options.releaseFileNames?.() || {}
      const candidates = (result?.candidates || []).map(candidate => {
        const override = releaseFileNames[`${candidate.publicationId}:${candidate.renditionId}`] ||
          releaseFileNames[candidate.publicationId]
        return override ? { ...candidate, sourceFileName: override } : candidate
      })
      const projected = Array.isArray(result) ? candidates : { ...result, candidates }
      const published = candidates.find(candidate =>
        candidate?.kind === 'published' && candidate.publicationId && candidate.renditionId)
      if (published) warmPublishedCandidate(published)
      return projected
    },
    issueLocalResolution(input) {
      if (typeof runtime?.issueLocalProviderResolution === 'function') {
        return runtime.issueLocalProviderResolution(input)
      }
      throw new Error('Local resolution is unsupported')
    },
    async ensureAcquisitionPolicy(publisherId) {
      if (typeof options.ensureAcquisitionPolicy === 'function') {
        return options.ensureAcquisitionPolicy(publisherId)
      }
      return null
    },
    async getPolicy(input) {
      if (typeof provider.getPolicy === 'function') return provider.getPolicy(input)
      if (typeof runtime.api?.getNetworkPolicy === 'function') {
        const result = await runtime.api.getNetworkPolicy()
        if (result?.success === true) return result.policy
      }
      return null
    },
    async setPolicy(input = {}) {
      const nextPolicy = input?.policy || input
      const expectedRevision = typeof input?.expectedRevision === 'number' ? input.expectedRevision : (typeof input?.revision === 'number' ? input.revision : undefined)
      if (typeof provider.setPolicy === 'function' && expectedRevision !== undefined) {
        try {
          return await provider.setPolicy({ policy: nextPolicy, expectedRevision })
        } catch {
          // fallback to api
        }
      }
      if (typeof runtime.api?.setNetworkPolicy === 'function') {
        const result = await runtime.api.setNetworkPolicy(nextPolicy)
        if (result?.success === true) return result.policy
        const error = new Error(result?.error || 'Network policy rejected')
        error.code = result?.errorCode || 'POLICY_REJECTED'
        throw error
      }
      if (typeof provider.setPolicy === 'function') {
        return provider.setPolicy(input)
      }
      throw new Error('Policy service is unavailable')
    },
    async openStream({ candidateRef, signal, localTransport = false } = {}) {
      const resolved = await provider.resolve({ ref: candidateRef, signal })
      if (resolved.kind !== 'published' || !resolved.publicationId || !resolved.renditionId) {
        const error = new Error('A verified publication is required before streaming')
        error.code = 'ACQUISITION_REQUIRED'
        throw error
      }
      const openMethod = localTransport && typeof runtime.api.openMediaRenditionUrl === 'function'
        ? 'openMediaRenditionUrl'
        : 'openMediaRendition'
      const opened = await runtime.api[openMethod]({
        publicationId: resolved.publicationId,
        renditionId: resolved.renditionId,
        signal
      })
      if (!opened?.success) {
        const error = new Error(opened?.error || 'Verified rendition is unavailable')
        error.code = opened?.errorCode || 'PROVIDER_STREAM_UNAVAILABLE'
        throw error
      }
      if (openMethod === 'openMediaRenditionUrl') {
        return {
          schemaVersion: 1,
          streamId: opened.assetId,
          publicationId: opened.publicationId,
          renditionId: opened.renditionId,
          assetId: opened.assetId,
          byteLength: opened.byteLength,
          mimeType: opened.contentType,
          capability: null,
          expiresAt: Date.now() + 5 * 60 * 1000,
          etag: `"asset-${opened.assetId}"`,
          url: opened.url
        }
      }
      return createStreamAsset(opened)
    },
    async openPublication({
      publicationId,
      renditionId,
      startOffsetSeconds = 0,
      durationSeconds = 0,
      signal,
      localTransport = false
    } = {}) {
      const openMethod = localTransport && typeof runtime.api?.openMediaRenditionUrl === 'function'
        ? 'openMediaRenditionUrl'
        : 'openMediaRendition'
      if (typeof runtime.api?.[openMethod] !== 'function') {
        const error = new Error('Deterministic publication playback is unavailable')
        error.code = 'PROVIDER_STREAM_UNAVAILABLE'
        throw error
      }
      const opened = await runtime.api[openMethod]({ publicationId, renditionId, signal })
      if (!opened?.success) {
        const error = new Error(opened?.error || 'Verified rendition is unavailable')
        error.code = opened?.errorCode || 'PROVIDER_STREAM_UNAVAILABLE'
        throw error
      }
      if (Number.isFinite(startOffsetSeconds) && startOffsetSeconds > 0 &&
          Number.isFinite(durationSeconds) && durationSeconds > 0 && Number.isSafeInteger(opened.byteLength) &&
          opened.byteLength > 0) {
        const fraction = Math.min(1, startOffsetSeconds / durationSeconds)
        const byteStart = Math.min(opened.byteLength - 1, Math.floor(opened.byteLength * fraction))
        await warmPublishedCandidate({ publicationId, renditionId }, { byteStart })
      }
      if (openMethod === 'openMediaRenditionUrl') {
        return {
          schemaVersion: 1,
          streamId: opened.assetId,
          publicationId: opened.publicationId,
          renditionId: opened.renditionId,
          assetId: opened.assetId,
          byteLength: opened.byteLength,
          mimeType: opened.contentType,
          capability: null,
          expiresAt: Date.now() + 5 * 60 * 1000,
          etag: `"asset-${opened.assetId}"`,
          url: opened.url
        }
      }
      return createStreamAsset(opened)
    },
  })
}



// 0 means "any free port", so the default must not swallow it.
function archiveUiPort(config) {
  const port = Number(config?.archive?.uiPort)
  return Number.isSafeInteger(port) && port >= 0 ? port : 8174
}

function archiveUiHost(config) {
  return config?.archive?.uiHost || '127.0.0.1'
}

function liveFreeDiskHeadroom({ fsModule, path, minFreeBytes = 0, log = null }) {
  const floor = Number.isFinite(Number(minFreeBytes)) && Number(minFreeBytes) > 0 ? Math.floor(Number(minFreeBytes)) : 0
  return () => {
    if (!path || typeof fsModule?.statfsSync !== 'function') return null
    try {
      const st = fsModule.statfsSync(path)
      const bsize = Number(st?.bsize) || 0
      const bavail = Number(st?.bavail) || 0
      if (bsize <= 0 || bavail < 0) return null
      return Math.max(0, (bavail * bsize) - floor)
    } catch (err) {
      log?.('[archive-headroom] statfs failed', err?.message || String(err))
      return null
    }
  }
}

function maybeSameVolume(fsModule, left, right) {
  if (typeof fsModule?.statSync !== 'function' || !left || !right) return true
  try {
    return fsModule.statSync(left).dev === fsModule.statSync(right).dev
  } catch {
    return true
  }
}

function archiveWriteHeadroom({ tmpHeadroom, storageHeadroom, sharedVolume = true }) {
  return () => ({
    tmp: typeof tmpHeadroom === 'function' ? tmpHeadroom() : null,
    storage: typeof storageHeadroom === 'function' ? storageHeadroom() : null,
    sharedVolume
  })
}

// Bind the operator's HTTP surface before anything reads the store.
//
// Everything below this line walks storage: the relay catalog, the creators DB,
// and above all the universal backend, whose bring-up rebuilds the media graph,
// runs the publication-v1 migration and registers seed-pin before it hands back
// a context. On a large store that is minutes, and it can stall indefinitely on
// a core waiting for a peer. Binding after it is what left a populated relay
// answering P2P traffic with its console port closed forever, indistinguishable
// from a dead process.
//
// The surface answers as a warming relay until the console adopts it, so the
// bind is unconditional and readiness is what arrives late.
export async function createRelayService(options = {}) {
  const uiEnabled = Boolean(options.config?.archive?.uiEnabled)
  const archiveHttp = options.archiveHttp || (uiEnabled
    ? createArchiveHttpSurface({
      host: archiveUiHost(options.config),
      port: archiveUiPort(options.config),
      logger: options.logger
    })
    : null)
  await archiveHttp?.listen()
  try {
    return await buildRelayService({ ...options, archiveHttp })
  } catch (error) {
    // The relay never came up, so the socket must not outlive it.
    await archiveHttp?.close().catch(() => {})
    throw error
  }
}

async function buildRelayService({
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
  archiveHttp = null,
  companionServerFactory = createCompanionServer,
  archiveConsoleFactory = createArchiveConsole
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

  // Block offload, decided before the runtime exists because it changes how the
  // Corestore is opened: the storage is wrapped so a block whose data now lives
  // in the bucket is still restored, verified and served. Off by default, and
  // when it is off nothing is wrapped and nothing is injected. Enabled with a
  // half-configured bucket throws here rather than downgrading to local-only.
  const blockOffload = await createRelayBlockOffload({ config, logger, fetchImpl: tmdbFetch })
  if (blockOffload) {
    logger.relay?.info?.('S3 block offload enabled', {
      windowBytes: blockOffload.windowBytes,
      bucket: blockOffload.bucket,
      prefix: blockOffload.prefix
    })
  } else {
    logger.relay?.info?.('Relay block offload disabled; block data stays on the local volume')
  }

  const runtime = await runtimeFactory({ config, logger, blockOffload })

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
  let publisherShell = null
  const localMirrorState = createLocalDriveMirrorState()

  function completePolicyControl(policy) {
    return policy?.policyVersion === 2 &&
      policy?.consentVersion === 1 &&
      policy?.migrationRequired === false &&
      typeof policy?.contributeWatchedMedia === 'boolean' &&
      typeof policy?.archiveEnabled === 'boolean' &&
      Number.isSafeInteger(policy?.contributionBudgetBytes) &&
      policy.contributionBudgetBytes >= 0 &&
      Number.isSafeInteger(policy?.archiveBudgetBytes) &&
      policy.archiveBudgetBytes >= 0 &&
      ['disabled', 'manual', 'enabled'].includes(policy?.uploadPermission) &&
      Number.isSafeInteger(policy?.uploadCeilingBytes) &&
      policy.uploadCeilingBytes >= 0
  }

  // The budget the operator authorized for this retention class and how much of
  // it is already spent, or null when the class is not permitted at all: a
  // caller has to be able to tell "never consented" from "consented and full".
  function retentionBudget(retentionClass) {
    const policy = runtime.ctx?.networkPolicyRuntime?.getPolicy?.()
    if (policy?.policyVersion !== 2 || policy.migrationRequired === true) return null
    const contribution = retentionClass === 'contribution-cache'
    const allowed = contribution
      ? policy.contributeWatchedMedia === true
      : retentionClass === 'archive-pin' && policy.archiveEnabled === true
    if (!allowed) return null
    const budget = Number(contribution ? policy.contributionBudgetBytes : policy.archiveBudgetBytes)
    if (!Number.isSafeInteger(budget) || budget <= 0) return null
    const usage = runtime.seedingManager?.getRetentionBudgetStatus?.() || {}
    const used = Number(contribution ? usage.contributionUsedBytes : usage.archiveUsedBytes) || 0
    return { budget, used, remaining: Math.max(0, budget - used) }
  }

  function retentionPermission(retentionClass, requestedBytes = 0) {
    const authorized = retentionBudget(retentionClass)
    if (authorized === null) return false
    return authorized.used + Math.max(0, Number(requestedBytes) || 0) <= authorized.budget
  }

  // What `bytes` of media actually costs THIS volume.
  //
  // Without block offload every archived byte is a byte on this disk, so the
  // cost is the byte count itself. With offload the ingest holds one window of
  // block data plus the two blocks in flight and the bucket takes the rest, so
  // the cost is the window plus the merkle bookkeeping the bucket never takes
  // — tens of megabytes for a title of any size. This is the same number the
  // archive download guard already sizes its requirement with, so the two
  // gates cannot disagree about what an offloading ingest needs from the disk.
  function localFootprintBytes(bytes) {
    if (!blockOffload) return Math.max(0, Number(bytes) || 0)
    return blockOffload.localWorkingBytes(bytes)
  }

  // Whether the volume can still hold what a request costs it.
  //
  // Consulted only with offload on. Without offload the aggregate guard is
  // already this volume's boundary and a second gate here would refuse ingests
  // the relay accepts today. With offload on it is what stops the bucket from
  // turning a full disk into an accepted ingest: the title no longer has to
  // fit, but the window still does. Headroom that cannot be measured fails
  // open, exactly as the storage guard does on a runtime with no statfs.
  function localVolumeAdmits(bytes) {
    const headroom = storageGuard.headroomBytes()
    if (headroom === null) return true
    return localFootprintBytes(bytes) <= headroom
  }

  function canRetain(request = {}) {
    const requestedBytes = request.expected?.byteLength || 0
    if (!storageGuard.canIngest()) return false
    if (blockOffload && !localVolumeAdmits(requestedBytes)) return false
    return retentionPermission(request.retentionClass, requestedBytes)
  }

  // The largest title this volume would actually admit, at most `ceiling`.
  //
  // A title's local cost is not flat: the window and the two blocks in flight
  // are, but the merkle tree and bitfield the bucket never takes grow with the
  // title, so a volume that can hold the window is not thereby a volume that
  // can hold any title. Advertising against a zero-byte probe is what made the
  // relay pledge a terabyte it would then refuse.
  //
  // Found by asking `localFootprintBytes` — which is monotone in the title
  // size — rather than by inverting it here: the footprint formula belongs to
  // storage-guard.js, and a second copy of it in this file would go stale the
  // day the window or the block size moves. The common case costs one probe;
  // only a disk-bound relay pays the search, once per capacity report.
  function largestAdmissibleBytes(ceiling) {
    if (storageGuard.headroomBytes() === null) return ceiling
    if (localVolumeAdmits(ceiling)) return ceiling
    let low = 0
    let high = ceiling
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2)
      if (localVolumeAdmits(mid)) low = mid
      else high = mid - 1
    }
    return low
  }

  // Bytes this relay can still take on for the archive network.
  //
  // Without block offload that is the local volume's headroom: every pledged
  // byte lands on this disk. With offload the pledged bytes land in the bucket
  // and only a window of them is ever here, so what bounds a new pledge is the
  // operator's archive budget rather than the disk — which is the whole reason
  // a relay with an 8 MiB window can hold a terabyte. The volume keeps its
  // veto, and it is the same veto admission applies: the number pledged here is
  // a title `canIngest` would take, so the relay never advertises work it is
  // about to refuse.
  function archiveCapacityBytes() {
    const localHeadroom = storageGuard.headroomBytes()
    if (!blockOffload) return localHeadroom
    const authorized = retentionBudget('archive-pin')
    const ceiling = authorized === null ? localHeadroom : authorized.remaining
    if (ceiling === null) return null
    return largestAdmissibleBytes(ceiling)
  }

  // Capacity is admission policy, not an object-store inventory. S3 objects are
  // proven per completed publication; process-local transfer counters reset and
  // include temporary staging copies, so they do not belong here.
  function capacityStats() {
    const snapshot = storageGuard.snapshot()
    return {
      localUsedBytes: snapshot.usedBytes,
      localFreeBytes: snapshot.freeBytes,
      localHeadroomBytes: storageGuard.headroomBytes(),
      effectiveCapacityBytes: archiveCapacityBytes()
    }
  }

  function createLocalDrivePublisher(runtimeFsModule) {
    return createArchivePublisher({
      identityManager: runtime.identityManager,
      storagePath: config.storage?.path,
      uploadManager: runtime.uploadManager,
      api: runtime.api,
      runtime,
      fs: runtimeFsModule,
      canPublish: retentionPermission,
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
    const [runtimeStats, acquisitionStatus] = await Promise.all([
      Promise.resolve()
        .then(() => typeof runtime.getDiagnostics === 'function' ? runtime.getDiagnostics() : {})
        .catch(() => ({ network: { lastErrors: ['RUNTIME_STATUS_UNAVAILABLE'] } })),
      Promise.resolve()
        .then(() => runtime.provider?.getStatus?.() || {})
        .catch(() => ({
          acquisitionsByState: {},
          activeAcquisitions: 0,
          lastErrors: ['ACQUISITION_STATUS_UNAVAILABLE']
        }))
    ])
    currentStatus = buildRelayStatus({
      config,
      catalog: relayCatalog,
      runtimeStats,
      acquisitionStatus,
      trustedClientsCount: trustedClients.list().length,
      blockOffload: blockOffload?.stats() || null,
      capacity: capacityStats()
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

  // One ceiling governs the local store and the archive pledges this relay
  // takes on for other relays, so the relay's live capacity is pushed into the
  // archive network every time it is re-evaluated. A relay with no room left
  // declines new pledges; it never drops the ones it already made.
  //
  // With block offload that ceiling stopped being the local volume: pledged
  // block data lives in the bucket, so a relay whose disk is smaller than its
  // archive budget can still take pledges for the difference.
  async function refreshArchiveCapacity() {
    if (typeof runtime.applyArchiveCapacity !== 'function') return null
    try {
      const result = await runtime.applyArchiveCapacity({ headroomBytes: archiveCapacityBytes() })
      if (result?.applied === false && result.reason !== 'reseed-disabled') {
        logger.status?.debug?.('Archive capacity was not applied', { reason: result.reason })
      }
      return result
    } catch (err) {
      logger.status?.warn?.('Archive capacity update failed', { error: err?.message || String(err) })
      return null
    }
  }

  // The byte ranges of the rendition this relay just retained, named the way a
  // possession challenge names them. The archive network derives the same
  // ranges from the signed manifest; these travel with the request so status
  // can read the archivists' evidence back for this exact rendition.
  function renditionLocators(publication) {
    const rendition = (publication?.manifest?.body?.renditions || [])
      .find((candidate) => candidate.renditionId === publication.renditionId)
    const core = rendition?.core
    if (!core?.key || !Number.isSafeInteger(core.length) || core.length < 1) return []
    return [{ coreKey: core.key, start: 0, end: core.length, renditionId: publication.renditionId }]
  }

  async function publishArchiveJob(job) {
    if (!retentionPermission('archive-pin')) return { published: false, reason: 'archive-consent-required' }
    if (closed) return { published: false, reason: 'closed' }
    if (job?.status !== 'completed') return { published: false, reason: 'not-completed' }
    if (job?.publish === false) return { published: false, reason: 'not-published' }
    if (!job?.publisherId || !job?.previewVideo?.id) {
      return { published: false, reason: 'missing-publisher-assets' }
    }

    const classifiedPreview = await classifyPreviewVideo(job.previewVideo)
    const publication = classifiedPreview?.immutablePublication
    const published = await runtime.publishPublisherCatalog({
      publisherId: job.publisherId,
      retentionClass: 'archive-pin'
    })
    // 'refreshed' means the local publisher scope already existed and was
    // rebound, which is a successful publication.
    if (published?.status !== 'published' && published?.status !== 'already-published' && published?.status !== 'refreshed') {
      return { published: false, reason: published?.status || 'catalog-publication-failed' }
    }

    const retained = []
    let mirrorRequested = false
    if (publication?.manifest && publication?.renditionId) {
      retained.push(await runtime.retainRendition({
        manifest: publication.manifest,
        renditionId: publication.renditionId,
        retentionClass: 'archive-pin'
      }))
      // Now that this relay holds the bytes, ask peer relays to mirror them.
      // An archive request that fails or is unavailable is recorded and left
      // there: a publication that reached the network is published whether or
      // not anyone else agreed to keep a copy, and saying otherwise would make
      // the relay refuse to publish the moment the archive network hiccuped.
      if (publication.publicationId && typeof runtime.requestArchiveMirror === 'function') {
        try {
          const mirror = await runtime.requestArchiveMirror({
            publicationId: publication.publicationId,
            renditionId: publication.renditionId,
            locators: renditionLocators(publication)
          })
          mirrorRequested = mirror?.requested === true
          if (!mirrorRequested) {
            logger.archive?.warn?.('Archive mirror request was not published', {
              publicationId: publication.publicationId,
              renditionId: publication.renditionId,
              reason: mirror?.errorCode || mirror?.reason || mirror?.status || 'unknown'
            })
          }
        } catch (err) {
          logger.archive?.warn?.('Archive mirror request failed', {
            publicationId: publication.publicationId,
            renditionId: publication.renditionId,
            error: err?.message || String(err)
          })
        }
      }
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
    return { published: true, previewVideos: previewVideos.length, retained: retained.length, mirrorRequested }
  }

  function scheduleCandidate(candidate) {
    queue = queue.then(() => processCandidate(candidate))
    return queue
  }
  const s3Config = config.archive?.s3 || {}
  const s3Configured = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']
    .every((field) => typeof s3Config[field] === 'string' && s3Config[field].length > 0)

  function providerPrincipal(publisherId) {
    return {
      id: config.companion.client,
      principalId: config.companion.client,
      publisherId,
      isLocal: true,
      publisherIds: [publisherId],
      scopes: new Set(config.companion.scopes || ['*'])
    }
  }

  async function ensureLocalAcquisitionPolicy(publisherId) {
    const current = await runtime.provider.getAcquisitionPolicy()
    const allowedPublisherIds = [...new Set([...(current.allowedPublisherIds || []), publisherId])].sort()
    const allowedAdapterIds = [...new Set([...(current.allowedAdapterIds || []), 'local-file', 'companion-callback', 'torbox'])].sort()
    // Archives run in parallel: a relay serializing to one job at a time makes
    // every watched title wait behind the one in front, and a feature-length
    // remux ahead of a 20-minute episode blocks it for hours. The shared byte
    // rate below still bounds total throughput, so parallelism costs bandwidth
    // only when there is bandwidth to spend.
    const maxConcurrentJobs = 4
    const maxConcurrentPerRequester = 4
    const needsUpdate = current.migrationRequired === true ||
      current.enabled !== true ||
      current.requesterMode !== 'allowlisted' ||
      current.maxConcurrentJobs !== maxConcurrentJobs ||
      current.maxConcurrentPerRequester !== maxConcurrentPerRequester ||
      !allowedPublisherIds.every(id => (current.allowedPublisherIds || []).includes(id)) ||
      !allowedAdapterIds.every(id => (current.allowedAdapterIds || []).includes(id))
    if (!needsUpdate) return current
    const capacity = Number(config.storage?.maxBytes) || 107374182400
    return runtime.provider.setAcquisitionPolicy({
      policy: {
        policyVersion: 1,
        consentVersion: 1,
        migrationRequired: false,
        enabled: true,
        acceptPublicRequests: false,
        requesterMode: 'allowlisted',
        allowedPublisherIds,
        allowedAdapterIds,
        maxQueuedJobs: 64,
        maxConcurrentJobs,
        maxConcurrentPerRequester,
        maxRequestBytes: 64 * 1024,
        maxAcquireBytesPer24h: capacity,
        maxAcquireBytesPerSecond: 64 * 1024 * 1024,
        maxStagingBytes: capacity,
        minFreeDiskBytes: Math.max(1, Number(config.storage?.minFreeBytes) || 1),
        maxJobRuntimeMs: 24 * 60 * 60 * 1000,
        sourceGrantTtlMs: 24 * 60 * 60 * 1000,
        publicRequestsPerMinute: 1,
        maxAttempts: 3,
        retryBaseMs: 1000,
        retryMaxMs: 60 * 1000
      },
      expectedRevision: current.revision,
      consent: true
    })
  }

  async function requestLocalFileAcquisition(input = {}) {
    if (!publisherShell) throw new Error('Relay publisher is not initialized')
    const local = await publisherShell.ensureLocalPublisher()
    const publisherId = local.publisherId
    const policy = await ensureLocalAcquisitionPolicy(publisherId)
    const principal = providerPrincipal(publisherId)
    const baseIdempotencyKey = String(input.idempotencyKey || '')
    let requestKey = baseIdempotencyKey
    let acquisition = null
    for (let attempt = 0; attempt < 8; attempt++) {
      const resolution = runtime.issueLocalProviderResolution({
        title: input.title,
        selector: input.selector,
        publisherId,
        idempotencyKey: requestKey,
        expectedBytes: input.expectedBytes,
        // The archival source named this file; the relay keeps that name so two
        // versions of one work stay distinguishable after publication.
        sourceFileName: sourceFileNameOf(input.sourceFileName)
      })
      acquisition = await runtime.provider.requestAcquisition({
        idempotencyKey: requestKey,
        request: {
          schemaVersion: 1,
          resolutionRef: resolution.resolutionRef,
          publisherId,
          retentionClass: input.retentionClass || 'archive-pin',
          sourceFileName: sourceFileNameOf(input.sourceFileName)
        },
        principal
      })
      const terminalRetry = acquisition.state === 'cancelled' ||
        (acquisition.state === 'failed' && acquisition.recoverable !== true)
      if (!terminalRetry) break
      requestKey = `${baseIdempotencyKey.slice(0, 96)}:retry:${acquisition.acquisitionId}`
    }
    if (acquisition === null) throw new Error('Local acquisition request did not return a result')
    if (acquisition.state === 'cancelled' || (acquisition.state === 'failed' && acquisition.recoverable !== true)) {
      const error = new Error('Local acquisition retry chain is exhausted')
      error.code = 'ACQUISITION_RETRY_EXHAUSTED'
      throw error
    }
    if (acquisition.state !== 'queued') return { ...acquisition, sourceAccepted: false }
    const grant = runtime.localFileSourceGrants.issue({
      acquisitionId: acquisition.acquisitionId,
      principalId: principal.principalId,
      path: input.path,
      mimeType: input.mimeType || 'application/octet-stream',
      expiresAt: nowFn() + policy.sourceGrantTtlMs,
      dispose: input.dispose || null
    })
    try {
      const attached = await runtime.provider.attachSourceGrant({
        acquisitionId: acquisition.acquisitionId,
        grant,
        principal
      })
      return { ...attached, sourceAccepted: true }
    } catch (error) {
      await runtime.localFileSourceGrants.revoke(grant.token)
      if (error?.code === 'ACQUISITION_NOT_QUEUED') {
        const latest = await runtime.provider.getAcquisition({
          acquisitionId: acquisition.acquisitionId,
          principal
        })
        if (latest) return { ...latest, sourceAccepted: false }
      }
      await runtime.provider.cancelAcquisition({
        acquisitionId: acquisition.acquisitionId,
        principal
      }).catch(() => {})
      throw error
    }
  }

  const service = {
    requestLocalFileAcquisition,
    async listAcquisitions(request = {}) {
      if (!publisherShell) return []
      const local = await publisherShell.ensureLocalPublisher()
      const page = await runtime.provider.listAcquisitions({
        ...request,
        principal: providerPrincipal(local.publisherId)
      })
      return page.items
    },
    async getAcquisition(acquisitionId) {
      if (!publisherShell) return null
      const local = await publisherShell.ensureLocalPublisher()
      return runtime.provider.getAcquisition({
        acquisitionId,
        principal: providerPrincipal(local.publisherId)
      })
    },
    async cancelAcquisition(acquisitionId) {
      if (!publisherShell) return null
      const local = await publisherShell.ensureLocalPublisher()
      return runtime.provider.cancelAcquisition({
        acquisitionId,
        principal: providerPrincipal(local.publisherId)
      })
    },
    async retryAcquisition(acquisitionId) {
      if (!publisherShell) return null
      const local = await publisherShell.ensureLocalPublisher()
      return runtime.provider.retryAcquisition({
        acquisitionId,
        principal: providerPrincipal(local.publisherId)
      })
    },
    async forgetAcquisition(acquisitionId) {
      if (!publisherShell) return null
      const local = await publisherShell.ensureLocalPublisher()
      return runtime.provider.forgetAcquisition({
        acquisitionId,
        principal: providerPrincipal(local.publisherId)
      })
    },
    async retractPublication(publicationId) {
      if (!runtime.retractPublication) throw new Error('Publication retraction is not supported by this runtime')
      const local = publisherShell ? await publisherShell.ensureLocalPublisher() : null
      return runtime.retractPublication({
        publicationId,
        ...(local?.publisherId ? { publisherId: local.publisherId } : {})
      })
    },
    async deleteRelease(target) {
      const raw = typeof target === 'object' && target !== null ? (target.id || target.publicationId || target.acquisitionId) : String(target || '')
      const id = String(raw || '').trim()
      if (!id) return { id: '', done: false, reason: 'invalid release target' }
      let publicationId = null
      let renditionId = null
      let acquisitionId = null
      if (id.startsWith('acq_')) {
        acquisitionId = id
      } else if (id.includes(':')) {
        const parts = id.split(':')
        publicationId = parts[0]
        renditionId = parts[1] || null
      } else if (/^[0-9a-f]{64}$/i.test(id)) {
        publicationId = id
      } else {
        acquisitionId = id
      }
      let localRetracted = false
      let remoteBlocked = false
      let failureReason = null
      if (publicationId) {
        const local = publisherShell ? await publisherShell.ensureLocalPublisher().catch(() => null) : null
        const localPublisherId = local?.publisherId || null
        let isLocalPublication = false
        if (localPublisherId) {
          try {
            const pub = await (runtime.api?.getPublication?.(publicationId) ||
              runtime.verifiedQueryView?.getPublication?.({ publicationId }))
            const pubPublisherId = pub?.publisherId || pub?.body?.publisherId || null
            if (pubPublisherId && pubPublisherId === localPublisherId) isLocalPublication = true
          } catch { /* absent publication remains non-local */ }
        }
        if (isLocalPublication && runtime.retractPublication) {
          try {
            const outcome = await runtime.retractPublication({
              publicationId,
              publisherId: localPublisherId
            })
            if (outcome?.done === true) localRetracted = true
          } catch (err) {
            logger?.archive?.warn?.('Retracting local publication failed', { publicationId, error: err?.message || String(err) })
          }
        }
        if (renditionId && typeof runtime.scopedNetwork?.releaseAuthorizedRendition === 'function') {
          await runtime.scopedNetwork.releaseAuthorizedRendition({
            renditionId,
            ownerId: publicationId || id
          }).catch(() => {})
        }
        if (!localRetracted) {
          const currentBlocked = relaySettings.get('blockedReleases', [])
          const toAdd = [id, publicationId, ...(renditionId ? [renditionId] : [])]
          const updatedBlocked = Array.from(new Set([...currentBlocked, ...toAdd]))
          await relaySettings.set('blockedReleases', updatedBlocked)
          remoteBlocked = true
        }
      }
      if (acquisitionId && runtime.provider?.forgetAcquisition) {
        try {
          const local = publisherShell ? await publisherShell.ensureLocalPublisher().catch(() => null) : null
          const result = await runtime.provider.forgetAcquisition({
            acquisitionId,
            principal: providerPrincipal(local?.publisherId || 'local-provider')
          })
          if (result?.forgotten === true) localRetracted = true
          else if (!localRetracted && !remoteBlocked) failureReason = result?.reason || 'acquisition record could not be forgotten'
        } catch (err) {
          if (!localRetracted && !remoteBlocked) failureReason = err?.message || String(err)
        }
      }
      const done = localRetracted || remoteBlocked
      if (!done) {
        return { id, done: false, reason: failureReason || 'nothing was deleted' }
      }
      return { id, done: true, state: 'deleted', ...(remoteBlocked ? { scope: 'local-block' } : { scope: 'retracted' }) }
    },
    // A getter because residency and restore activity change while the relay
    // runs. Durable bucket inventory is not guessed from process-local totals.
    get s3() {
      return {
        configured: s3Configured,
        endpoint: s3Config.endpoint || '',
        bucket: s3Config.bucket || '',
        region: s3Config.region || 'us-east-1',
        prefix: s3Config.prefix || '',
        offload: blockOffload
          ? blockOffload.stats()
          : { enabled: false, windowBytes: 0, restored: 0, residentBytes: 0 }
      }
    },
    config,
    logger,
    runtime,
    catalog: relayCatalog,
    creators: relayCreators,
    classificationStore,
    settings: relaySettings,
    trustedClients,
    storageGuard,
    canIngest: request => canRetain(request),
    canArchive: () => canRetain({ retentionClass: 'archive-pin' }),
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
    async applyNetworkPolicy(policy) {
      const controlledPolicy = completePolicyControl(policy)
        ? policy
        : {
            policyVersion: 2,
            consentVersion: 0,
            migrationRequired: true,
            contributeWatchedMedia: false,
            archiveEnabled: false,
            contributionBudgetBytes: 0,
            archiveBudgetBytes: 0,
            uploadPermission: 'disabled',
            uploadCeilingBytes: 0
          }
      if (!runtime.api || typeof runtime.api.setNetworkPolicy !== 'function') {
        throw new Error('network policy control is unavailable')
      }
      const result = await runtime.api.setNetworkPolicy({
        policyVersion: controlledPolicy.policyVersion,
        consentVersion: controlledPolicy.consentVersion,
        migrationRequired: controlledPolicy.migrationRequired,
        contributeWatchedMedia: controlledPolicy.contributeWatchedMedia,
        archiveEnabled: controlledPolicy.archiveEnabled,
        contributionBudgetBytes: controlledPolicy.contributionBudgetBytes,
        contributionBudgetBytesPresent: true,
        archiveBudgetBytes: controlledPolicy.archiveBudgetBytes,
        archiveBudgetBytesPresent: true,
        uploadPermission: controlledPolicy.uploadPermission,
        uploadCeilingBytes: controlledPolicy.uploadCeilingBytes,
        uploadCeilingBytesPresent: true,
        retentionMode: controlledPolicy.archiveEnabled ? 'archive-pledges' : 'none'
      })
      if (!result?.success) {
        const error = new Error(result?.errorCode || 'POLICY_APPLY_FAILED')
        error.code = result?.errorCode || 'POLICY_APPLY_FAILED'
        throw error
      }
      const effective = result.policy
      if (!effective || typeof effective !== 'object') {
        throw new Error('network policy result is unavailable')
      }
      const policyControlApplied = effective?.policyVersion === 2 &&
        effective?.consentVersion === 1 &&
        effective?.migrationRequired === false
      return {
        policyVersion: effective.policyVersion,
        consentVersion: effective.consentVersion,
        migrationRequired: effective.migrationRequired,
        effectiveRole: effective.effectiveRole,
        permissions: { ...effective.permissions },
        contributionBudgetBytes: effective.contributionBudgetBytes,
        archiveBudgetBytes: effective.archiveBudgetBytes,
        uploadPermission: effective.uploadPermission,
        uploadCeilingBytes: effective.uploadCeilingBytes,
        acquisitionReady: policyControlApplied
      }
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
    // Creator sources remain catalogue inputs in this cutover. Their old
    // archive-job executor is gone; a concrete title must enter through v2.
    async addCreatorSource({ url, label = null } = {}) {
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
      return { creator, job: null }
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

      const companionFsModule = fsModule || await import('#fs')
      const companionPathModule = pathModule || await import('#path')
      const archiveSpoolRoot = companionPathModule.join(config.storage.path, 'companion', 'archive-spool')
      publisherShell = createRelayPublisherShell({
        api: runtime.api,
        storagePath: config.storage?.path,
        fs: companionFsModule,
        logger
      })
      const archivePublisher = createArchivePublisher({
        identityManager: runtime.identityManager,
        storagePath: config.storage?.path,
        uploadManager: runtime.uploadManager,
        api: runtime.api,
        runtime,
        fs: companionFsModule,
        publisherShell,
        canPublish: retentionPermission
      })
      if (runtime.ctx?.metaDb) {
        if (typeof runtime.provider?.migrateLegacyIngest !== 'function') {
          throw new Error('ProviderService legacy acquisition migration is unavailable')
        }
        await runtime.provider.migrateLegacyIngest({
          legacyStore: createLegacyIngestMigrationStore({ bee: runtime.ctx.metaDb, now: nowFn }),
          legacyPrincipalId: config.companion.client,
          legacyPublisherId: config.companion.publisherId,
          now: nowFn
        })
      }
      if (config.archive?.uiEnabled) {
        const runtimeFsModule = companionFsModule
        const runtimePathModule = companionPathModule
        try { runtimeFsModule?.mkdirSync?.(archiveSpoolRoot, { recursive: true }) } catch { /* Admission reports missing storage later. */ }
        const tmpHeadroom = liveFreeDiskHeadroom({
          fsModule: runtimeFsModule,
          path: archiveSpoolRoot,
          minFreeBytes: config.storage.minFreeBytes || 0,
          log: (...args) => logger.status?.debug?.(args.map(String).join(' '))
        })
        // The archive temp volume is bounded by free disk. The persisted copy
        // is bounded by BOTH free disk and storage.maxBytes; reservations below
        // subtract concurrent staged/copy bytes from that aggregate room.
        const persistedHeadroom = () => storageGuard.headroomBytes()
        const archiveHeadroom = archiveWriteHeadroom({
          tmpHeadroom,
          storageHeadroom: persistedHeadroom,
          sharedVolume: true
        })
        const archiveStorageReservations = {
          bytes: 0,
          invalidate: () => storageGuard.invalidate()
        }
        archiveConsole = await archiveConsoleFactory({
          service,
          logger,
          host: archiveUiHost(config),
          port: archiveUiPort(config),
          uploadDir: archiveSpoolRoot,
          uploadStorageHeadroom: archiveHeadroom,
          storageReservations: archiveStorageReservations,
          publisher: archivePublisher,
          downloader: createYtDlpDownloader({
            bin: config.archive.ytDlpPath,
            outputDir: companionPathModule.join(archiveSpoolRoot, 'uploads'),
            format: config.archive.format,
            ffmpegPath: config.archive.ffmpegPath,
            cookiesPath: config.archive.cookiesPath,
            jsRuntime: config.archive.jsRuntime,
            storageHeadroom: archiveHeadroom,
            storageReservations: archiveStorageReservations,
            onStorageChanged: () => storageGuard.invalidate(),
            ytDlpExtraArgs: config.archive.ytDlpExtraArgs,
            ytDlpRetryExtraArgs: config.archive.ytDlpRetryExtraArgs,
            spawnFn: spawnFn || undefined,
            fs: runtimeFsModule,
            path: runtimePathModule
          }),
          httpSurface: archiveHttp,
        })
        await archiveConsole.start()
        // The one line that separates "still opening the store" from "stuck":
        // everything the console reads is answerable from here on.
        logger.relay.info('Relay archive console ready', {
          host: archiveUiHost(config),
          port: archiveHttp ? archiveHttp.port : archiveUiPort(config),
          bootMs: Date.now() - bootStartedAt
        })
      }
      if (config.companion?.enabled !== false) {
        if (!runtime.provider) throw new Error('Relay runtime did not expose ProviderService')
        const localPub = publisherShell ? await publisherShell.ensureLocalPublisher().catch((err) => {
          logger.relay?.warn?.('Relay local publisher setup failed', { error: err?.message || String(err) })
          return null
        }) : null
        logger.relay.info('Local publisher resolved', { publisherId: localPub?.publisherId })
        if (localPub?.publisherId && (!config.companion.publisherId || !/^[0-9a-f]{64}$/.test(config.companion.publisherId))) {
          config.companion.publisherId = localPub.publisherId
        }
        if (localPub?.publisherId) {
          await ensureLocalAcquisitionPolicy(localPub.publisherId).catch((err) => {
            logger.relay?.warn?.('Ensure acquisition policy failed', { error: err?.message || String(err) })
          })
        }
        companionServer = await companionServerFactory({
          service: createProviderMachineService(runtime, {
            ensureAcquisitionPolicy: ensureLocalAcquisitionPolicy,
            releaseFileNames: () => relaySettings.get('releaseFileNames', {})
          }),
          config: config.companion,
          clock: nowFn,
          logger
        })
        if (archiveConsole && typeof archiveConsole.setCompanionHandler === 'function') {
          archiveConsole.setCompanionHandler(companionServer.handleRequest)
        }
        const uiPort = archiveHttp ? archiveHttp.port : archiveUiPort(config)
        const uiActive = Boolean(config.archive?.uiEnabled && archiveConsole)
        const separatePort = Boolean(config.companion?.hasExplicitPort && config.companion.port !== uiPort)
        if (!uiActive || separatePort) {
          logger.relay.info('Starting companion server listener...', { port: config.companion.port })
          await companionServer.start()
          logger.relay.info('Companion server started!')
        } else {
          companionServer.setPublicAddress?.({
            host: archiveUiHost(config),
            port: uiPort
          })
          logger.relay.info('Companion API mounted on unified archive UI server', { port: uiPort })
        }
      }

      const runtimeStartedAt = Date.now()
      await runtime.start?.()
      logger.relay.info('Relay runtime network ready', { runtimeStartMs: Date.now() - runtimeStartedAt })
      // The publisher root is CLI-owned, so the backend cannot restore a
      // writable binding by itself: restoreLocalPublisherScopes() finds nothing
      // at boot and the relay joins no publisher scope and announces no
      // bootstrap locator. Consumers can connect and still discover nothing
      // until some archive job happens to bind the catalog. Bind it here so a
      // restarted relay is discoverable immediately.
      //
      // One shell instance is shared with the archive publisher; two would race
      // over the same publisher-root file.

      try {
        const local = await publisherShell.ensureLocalPublisher()
        const published = await runtime.publishPublisherCatalog({ publisherId: local.publisherId })
        logger.relay.info('Relay publisher catalog announced', {
          publisherId: local.publisherId,
          status: published?.status || 'unknown'
        })
      } catch (error) {
        // An empty relay has no accepted publication to announce yet. That is
        // normal on a fresh install and must not stop startup; a genuine
        // provisioning failure is a different matter and says so.
        const message = error?.message || String(error)
        if (/no accepted publication or claim/.test(message)) {
          logger.relay.info('Relay publisher catalog has nothing to announce yet')
        } else {
          logger.relay.warn('Relay publisher catalog announcement failed', { error: message })
        }
      }


      // Hand the archive network this relay's real headroom before it can be
      // offered any pledge. Restored pledges are already in place by now, so
      // the ceiling is computed above them, never under them.
      await refreshArchiveCapacity()


      const status = await persistStatus()
      const networkStatus = status.network || {}
      const publicWorkStatus = status.publicWork || {}
      logger.relay.info('Relay started', {
        peers: networkStatus.peers || 0,
        connections: networkStatus.connections || 0,
        activeAnnouncements: publicWorkStatus.activeAnnouncements || 0,
        activeServes: publicWorkStatus.activeServes || 0,
        activeAcquisitions: publicWorkStatus.activeAcquisitions || 0,
        archivedChannels: status.summary?.totalChannels || 0
      })


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
          // Headroom moves as the relay archives, evicts and grows. Re-derive
          // it before status is written so what the archive network will accept
          // and what status reports are the same number.
          storageGuard.invalidate()
          await refreshArchiveCapacity()
          const heartbeatStatus = await persistStatus()
          const network = heartbeatStatus.network || {}
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
          const publicWork = heartbeatStatus.publicWork || {}
          logger.status.info('Relay heartbeat', {
            peers: network.peers || 0,
            connections: network.connections || 0,
            activeAnnouncements: publicWork.activeAnnouncements || 0,
            activeServes: publicWork.activeServes || 0,
            servedBytes: publicWork.servedBytes || 0,
            activeAcquisitions: publicWork.activeAcquisitions || 0
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
    async openStreamAsset(candidate, { signal = null } = {}) {
      if (typeof runtime.api?.openVerifiedCandidateStream !== 'function') {
        const error = new Error('Verified asset streaming is unsupported')
        error.code = 'STREAM_ASSET_UNSUPPORTED'
        throw error
      }
      return runtime.api.openVerifiedCandidateStream(candidate, { signal })
    },
    async getVerifiedMediaCatalog(request = {}) {
      if (typeof runtime.api?.getMediaCatalog !== 'function') {
        return { success: false, errorCode: 'VERIFIED_QUERY_UNAVAILABLE', items: [], nextCursor: null }
      }
      const page = await runtime.api.getMediaCatalog(request)
      if (page?.success !== true || !Array.isArray(page.items)) return page
      const blocked = new Set(relaySettings.get('blockedReleases', []))
      if (blocked.size > 0) {
        page.items = page.items.filter(item => {
          if (blocked.has(item.publicationId) || blocked.has(item.id)) return false
          if (Array.isArray(item.sources)) {
            item.sources = item.sources.filter(src =>
              !blocked.has(src.publicationId) &&
              !blocked.has(src.renditionId) &&
              !blocked.has(`${src.publicationId}:${src.renditionId}`)
            )
            if (item.sources.length === 0) return false
          }
          if (Array.isArray(item.publications)) {
            item.publications = item.publications.filter(pub =>
              !blocked.has(pub.publicationId) &&
              !blocked.has(pub.renditionId) &&
              !blocked.has(`${pub.publicationId}:${pub.renditionId}`)
            )
            if (item.publications.length === 0 && !Array.isArray(item.sources)) return false
          }
          return true
        })
      }
      if (typeof runtime.api?.searchIndexCandidates !== 'function') return page
      const searches = new Map()
      const items = []
      for (const item of page.items) {
        const sources = []
        for (const source of item?.sources || []) {
          const selector = selectorForMediaCoordinates(source)
          let candidateRef = null
          if (selector) {
            const key = JSON.stringify(selector)
            let candidates = searches.get(key)
            if (!candidates) {
              candidates = Promise.resolve(runtime.api.searchIndexCandidates(selector, { limit: 64 }))
                .catch(() => [])
              searches.set(key, candidates)
            }
            const match = (await candidates).find(candidate =>
              candidate?.publication?.publicationId === source.publicationId &&
              (!source.renditionId || candidate?.rendition?.renditionId === source.renditionId))
            if (CANDIDATE_REF_PATTERN.test(match?.candidateRef || '')) candidateRef = match.candidateRef
          }
          sources.push(candidateRef ? { ...source, candidateRef } : source)
        }
        const candidateRef = sources.find(source => CANDIDATE_REF_PATTERN.test(source?.candidateRef || ''))?.candidateRef || null
        items.push({ ...item, sources, ...(candidateRef ? { candidateRef } : {}) })
      }
      return { ...page, items }
    },
    async getVerifiedManifest(publicationId) {
      if (typeof publicationId !== 'string' || !publicationId) return null
      const view = runtime.verifiedQueryView || runtime.backend?.verifiedQueryView || runtime.ctx?.verifiedQueryView
      if (typeof view?.getManifest === 'function') {
        return view.getManifest({ publicationId })
      }
      if (typeof runtime.api?.getPublicationManifest === 'function') {
        const result = await runtime.api.getPublicationManifest({ publicationId })
        return result?.manifest || result || null
      }
      return null
    },
    // Whether this relay itself holds every block of a publication's rendition.
    // Read-only: it inspects the local bitfield and pulls nothing, so an
    // operator console can ask on every refresh without changing the answer.
    async getLocalResidency({ publicationId, renditionId = null } = {}) {
      if (typeof runtime.api?.getLocalRangeResidency !== 'function') return null
      const result = await runtime.api.getLocalRangeResidency({ publicationId, renditionId }).catch(() => null)
      return result?.success === true ? result : null
    },
    getArchiveMirrorRequests() {
      return runtime.getArchiveMirrorRequests?.() || []
    },
    async getVerifiedEntityArtwork(request = {}) {
      if (typeof runtime.api?.getEntityArtwork !== 'function') return null
      return runtime.api.getEntityArtwork(request)
    },
    async openVerifiedPlayback(candidateRef, { signal = null } = {}) {
      if (!CANDIDATE_REF_PATTERN.test(candidateRef || '')) return null
      const state = companionServer?.state?.()
      if (state?.enabled !== true || state.transport !== 'tcp' ||
          typeof companionServer.dispatchInProcess !== 'function') return null
      const opened = await companionServer.dispatchInProcess({
        method: 'POST',
        url: '/api/v2/streams/open',
        body: { candidateRef },
        signal
      })
      if (opened?.statusCode !== 200 || typeof opened.body?.url !== 'string') return null
      return {
        ...opened.body,
        transport: state.transport,
        host: state.host,
        port: state.port
      }
    },
    async getPublication(publicationId) {
      return service.getVerifiedManifest(publicationId)
    },
    async enqueueArchiveJob(input, { runNow = false } = {}) {
      if (!archiveConsole?.manager?.enqueue) {
        const error = new Error('Archive submission is unavailable')
        error.code = 'ACQUISITION_UNAVAILABLE'
        throw error
      }
      const queued = await archiveConsole.manager.enqueue(input)
      if (!runNow) return queued
      const acquisitionId = queued.acquisitionId || queued.id
      if (!acquisitionId || typeof runtime.provider?.getAcquisition !== 'function') return queued
      const principal = {
        id: config.companion.client,
        publisherId: config.companion.publisherId,
        scopes: new Set(config.companion.scopes || ['*'])
      }
      let acquisition = await runtime.provider.getAcquisition({ acquisitionId, principal })
      while (acquisition && !['completed', 'failed', 'cancelled'].includes(acquisition.state)) {
        await new Promise(resolve => setTimeout(resolve, 100))
        acquisition = await runtime.provider.getAcquisition({ acquisitionId, principal })
      }
      return acquisition || queued
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
      const baseState = companionServer?.state?.() || {
        enabled: false,
        transport: 'tcp'
      }
      if (baseState.enabled && !baseState.port && archiveConsole) {
        return {
          ...baseState,
          host: archiveUiHost(config),
          port: archiveHttp ? archiveHttp.port : archiveUiPort(config)
        }
      }
      return baseState
    },
    getStatus() {
      return currentStatus || buildRelayStatus({
        config,
        catalog: relayCatalog,
        runtimeStats: {},
        blockOffload: blockOffload?.stats() || null,
        capacity: capacityStats()
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
      if (companionServer) {
        await companionServer.close().catch(() => {})
        companionServer = null
      }
      if (archiveConsole) {
        await archiveConsole.close().catch(() => {})
        archiveConsole = null
      }
      // The surface outlives the console when the relay never got far enough to
      // build one, which is exactly the case a shutdown has to clean up after.
      await archiveHttp?.close().catch(() => {})
      await queue.catch(() => {})
      await persistStatus()
      await runtime.close?.()
    }
  }

  return service
}
