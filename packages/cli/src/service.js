import { createCliLogger } from './cli-logger.js'
import { evaluateCandidate } from './admission.js'
import { AlertStore } from './alerts.js'
import { RelayCatalog } from './catalog.js'
import { RELAY_ROLE_ARCHIVER, RELAY_ROLE_CACHE, RELAY_ROLE_PUBLIC_INDEX } from './constants.js'
import { ModerationRuleStore } from './moderation-store.js'
import { normalizeModerationConfig } from './moderation.js'
import { ReportStore } from './reports.js'
import { buildRelayStatus, writeRelayStatus } from './status.js'
import { createArchiveConsole } from './archive-console.js'
import { createArchiveJobStore, createArchiveManager, createArchivePublisher, createYtDlpDownloader } from './archive-manager.js'
import { createLocalDriveMirrorState, mirrorLocalDriveToRelayChannel } from './local-drive-mirror.js'

const MIRROR_RETRY_COOLDOWN_MS = 5 * 60_000
const STORAGE_CONCENTRATION_THRESHOLD = 0.5
const STORAGE_PRESSURE_THRESHOLD = 0.85
const ARCHIVE_FAILURE_ALERT_THRESHOLD = 3
const BLOCKED_REAPPEARANCE_ALERT_THRESHOLD = 3
const ARCHIVE_SOURCE_VOLUME_ALERT_THRESHOLD = 5

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

  const persistedModerationRules = config.paths?.moderation
    ? (await ModerationRuleStore.open({
        storagePath: config.storage.path,
        moderationPath: config.paths.moderation
      }).catch(() => null))?.getRules?.() || []
    : []
  config.moderation = normalizeModerationConfig({
    ...(config.moderation || {}),
    rules: [
      ...(Array.isArray(config.moderation?.rules) ? config.moderation.rules : []),
      ...persistedModerationRules
    ]
  })

  const alertStore = config.paths?.alerts
    ? await AlertStore.open({
      storagePath: config.storage.path,
      alertsPath: config.paths.alerts,
      nowFn
    })
    : null
  let reportStore = config.paths?.reports
    ? await ReportStore.open({
      storagePath: config.storage.path,
      reportsPath: config.paths.reports,
      nowFn
    })
    : null

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

  function budgetPercent(bytes, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0
    return Math.round((Number(bytes || 0) / maxBytes) * 100)
  }

  async function recordStorageAlerts() {
    if (!alertStore) return
    const maxBytes = Number(config.storage?.maxBytes || 0)
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return

    const channels = relayCatalog.getChannels()
    const ownerBytes = new Map()
    const summary = relayCatalog.getSummary()

    if ((Number(summary.usedBytes || 0) / maxBytes) >= STORAGE_PRESSURE_THRESHOLD) {
      await ensureOperatorAlert({
        severity: 'warning',
        category: 'storage',
        targetType: 'storage',
        target: 'relay-cache',
        summary: `Relay cache storage is using ${budgetPercent(summary.usedBytes, maxBytes)}% of configured budget`,
        suggestedActions: ['review-cache', 'evict', 'increase-budget']
      })
    }

    for (const channel of channels) {
      const channelKey = channel.channelKey || channel.driveKey
      const bytes = Number(channel.bytes || 0) || 0
      if (channel.ownerKey) ownerBytes.set(channel.ownerKey, (ownerBytes.get(channel.ownerKey) || 0) + bytes)
      if (!channelKey || bytes <= 0) continue
      if ((bytes / maxBytes) >= STORAGE_CONCENTRATION_THRESHOLD) {
        await ensureOperatorAlert({
          severity: 'warning',
          category: 'storage',
          targetType: 'channelKey',
          target: channelKey,
          summary: `Channel channelKey:${channelKey} is using ${budgetPercent(bytes, maxBytes)}% of relay cache budget`,
          suggestedActions: ['review', 'quarantine', 'evict']
        })
      }
    }

    for (const [ownerKey, bytes] of ownerBytes) {
      if ((bytes / maxBytes) >= STORAGE_CONCENTRATION_THRESHOLD) {
        await ensureOperatorAlert({
          severity: 'warning',
          category: 'storage',
          targetType: 'ownerKey',
          target: ownerKey,
          summary: `Owner ownerKey:${ownerKey} is using ${budgetPercent(bytes, maxBytes)}% of relay cache budget`,
          suggestedActions: ['review', 'watch', 'quarantine']
        })
      }
    }
  }

  async function recordNetworkAlerts(runtimeStats = {}) {
    if (!alertStore) return
    if (!config.discovery?.enabled) return

    const summary = relayCatalog.getSummary()
    const acceptedChannels = Number(summary.totalChannels || 0) || 0
    const feedPeerCount = Number(runtimeStats.feedPeers ?? runtimeStats.feedChannelCandidates ?? 0) || 0
    const feedConnections = Number(runtimeStats.feedConnections || 0) || 0
    const feedEntries = Number(runtimeStats.feedEntries || 0) || 0
    const publicFeedObserved = feedPeerCount > 0 || feedConnections > 0 || feedEntries > 0 || Boolean(runtimeStats.publicFeedDiscoveryJoined)

    if ((feedPeerCount > 0 || feedConnections > 0) && acceptedChannels === 0) {
      await ensureOperatorAlert({
        severity: 'warning',
        category: 'network',
        targetType: 'public-feed',
        target: 'accepted-entries',
        summary: 'Public feed has peers but no accepted entries',
        suggestedActions: ['review-admission', 'review-moderation', 'check-feed']
      })
    }

    const roles = Array.isArray(config.roles) ? config.roles : []
    const relayCacheRole = roles.includes(RELAY_ROLE_CACHE)
    const seededChannels = Number(runtimeStats.seeding?.channels || 0) || 0
    const seededVideos = Number(runtimeStats.seeding?.videos || 0) || 0
    if (relayCacheRole && publicFeedObserved && acceptedChannels === 0 && seededChannels === 0 && seededVideos === 0) {
      await ensureOperatorAlert({
        severity: 'warning',
        category: 'network',
        targetType: 'relay-cache',
        target: 'empty',
        summary: 'Relay cache is serving no content while discovery is enabled',
        suggestedActions: ['review-discovery', 'review-admission', 'check-seeding']
      })
    }
  }

  function getArchiveSourceHost(url) {
    try {
      return new URL(url).hostname || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async function recordArchiveJobAlert(input = {}) {
    if (!input?.url) return null
    const host = getArchiveSourceHost(input.url)
    return addOperatorAlert({
      severity: 'warning',
      category: 'archive',
      targetType: 'source',
      target: host,
      summary: `Archive job queued from public source ${host}`,
      suggestedActions: ['review-archive-job', 'confirm-publisher-role']
    })
  }

  async function recordArchiveSourceVolumeAlert(job = {}, { store, input } = {}) {
    if (!job?.id) return null
    const archiveStore = store || (runtime.ctx?.metaDb ? createArchiveJobStore({ metaDb: runtime.ctx.metaDb }) : null)
    if (!archiveStore) return null

    const privateInput = input?.url ? input : await archiveStore.getPrivateInput(job.id).catch(() => null)
    if (!privateInput?.url) return null
    const host = getArchiveSourceHost(privateInput.url)
    const jobs = await archiveStore.listJobs().catch(() => [])
    let sourceCount = 0

    for (const archiveJob of jobs) {
      const archiveInput = await archiveStore.getPrivateInput(archiveJob.id).catch(() => null)
      if (archiveInput?.url && getArchiveSourceHost(archiveInput.url) === host) sourceCount += 1
    }

    if (sourceCount < ARCHIVE_SOURCE_VOLUME_ALERT_THRESHOLD) return null
    return ensureOperatorAlert({
      severity: 'warning',
      category: 'archive',
      targetType: 'source',
      target: host,
      summary: `Archive source ${host} queued ${ARCHIVE_SOURCE_VOLUME_ALERT_THRESHOLD} or more jobs`,
      suggestedActions: ['review-archive-source', 'pause-archive-source', 'confirm-publisher-role']
    })
  }

  async function recordArchivePublishAlert(job = {}) {
    if (!job?.channelKey || !job?.previewVideo?.id) return null
    return addOperatorAlert({
      severity: 'warning',
      category: 'archive',
      targetType: 'channelKey',
      target: job.channelKey,
      summary: `Archive published video ${job.previewVideo.id} into channelKey:${job.channelKey}`,
      suggestedActions: ['review-archive-channel', 'confirm-publisher-role']
    })
  }

  async function recordArchiveFailureAlert(job = {}, { store } = {}) {
    if (!job?.id || job.status !== 'failed') return null
    const archiveStore = store || (runtime.ctx?.metaDb ? createArchiveJobStore({ metaDb: runtime.ctx.metaDb }) : null)
    if (!archiveStore) return null

    const privateInput = await archiveStore.getPrivateInput(job.id).catch(() => null)
    if (!privateInput?.url) return null
    const host = getArchiveSourceHost(privateInput.url)
    const jobs = await archiveStore.listJobs().catch(() => [])
    let failedCount = 0

    for (const archiveJob of jobs) {
      if (archiveJob?.status !== 'failed') continue
      const input = await archiveStore.getPrivateInput(archiveJob.id).catch(() => null)
      if (input?.url && getArchiveSourceHost(input.url) === host) failedCount += 1
    }

    if (failedCount < ARCHIVE_FAILURE_ALERT_THRESHOLD) return null
    return ensureOperatorAlert({
      severity: 'critical',
      category: 'archive',
      targetType: 'source',
      target: host,
      summary: `Archive source ${host} has ${ARCHIVE_FAILURE_ALERT_THRESHOLD} or more failed jobs`,
      suggestedActions: ['review-archive-source', 'pause-archive-source', 'check-downloader']
    })
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
    const runtimeStats = runtime.getNetworkStats?.() || {}
    await recordStorageAlerts()
    await recordNetworkAlerts(runtimeStats)
    currentStatus = buildRelayStatus({
      config,
      catalog: relayCatalog,
      runtimeStats,
      alerts: alertStore?.getAlerts({ limit: Infinity }) || [],
      reports: reportStore?.getReports({ limit: Infinity }) || []
    })

    await Promise.resolve(writeStatusFile(config.paths.status, currentStatus))
    return currentStatus
  }

  async function addOperatorAlert(alert) {
    if (!alertStore) return null
    try {
      return await alertStore.addAlert(alert)
    } catch (err) {
      logger.status.warn('Relay alert write failed', {
        category: alert?.category || null,
        targetType: alert?.targetType || null,
        target: alert?.target || null,
        error: err?.message || String(err)
      })
      return null
    }
  }

  async function ensureOperatorAlert(alert) {
    if (!alertStore) return null
    try {
      return await alertStore.ensureAlert(alert)
    } catch (err) {
      logger.status.warn('Relay alert write failed', {
        category: alert?.category || null,
        targetType: alert?.targetType || null,
        target: alert?.target || null,
        error: err?.message || String(err)
      })
      return null
    }
  }

  async function getReportStore() {
    if (!reportStore) {
      reportStore = await ReportStore.open({
        storagePath: config.storage.path,
        reportsPath: config.paths?.reports,
        nowFn
      })
    }
    return reportStore
  }

  async function recordPostureAlerts() {
    const roles = Array.isArray(config.roles) ? config.roles : []

    if (roles.includes(RELAY_ROLE_PUBLIC_INDEX)) {
      await ensureOperatorAlert({
        severity: 'info',
        category: 'posture',
        targetType: 'role',
        target: RELAY_ROLE_PUBLIC_INDEX,
        summary: 'Public index stores public channel and video metadata for discovery',
        suggestedActions: ['review-posture', 'configure-roles']
      })
    }

    if (roles.includes(RELAY_ROLE_ARCHIVER)) {
      await ensureOperatorAlert({
        severity: 'warning',
        category: 'posture',
        targetType: 'role',
        target: RELAY_ROLE_ARCHIVER,
        summary: 'Archive role publishes operator-selected content',
        suggestedActions: ['review-archive-sources', 'separate-node-roles']
      })
    }
  }

  async function recordModerationAlert(decision = {}, candidate = {}) {
    const moderation = decision.moderation || {}
    const targetType = moderation.targetType || (candidate.channelKey ? 'channelKey' : 'ownerKey')
    const target = moderation.target || candidate.channelKey || candidate.ownerKey || 'unknown'

    if (decision.reason === 'moderation-blocked') {
      const alert = await addOperatorAlert({
        severity: 'warning',
        category: 'moderation',
        targetType,
        target,
        summary: `Blocklisted ${targetType}:${target} appeared in public feed gossip`,
        suggestedActions: ['review', 'keep-blocked']
      })
      if (Number(alert?.occurrences || 0) >= BLOCKED_REAPPEARANCE_ALERT_THRESHOLD) {
        await ensureOperatorAlert({
          severity: 'critical',
          category: 'network',
          targetType,
          target,
          summary: `Blocked ${targetType}:${target} repeatedly reappeared in public feed gossip`,
          suggestedActions: ['review-gossip', 'keep-blocked', 'check-peers']
        })
      }
      return
    }

    if (decision.reason === 'moderation-quarantined') {
      await addOperatorAlert({
        severity: 'critical',
        category: 'moderation',
        targetType,
        target,
        summary: `Quarantine applied to ${targetType}:${target}`,
        suggestedActions: ['review', 'block', 'allow']
      })
      return
    }

    if (moderation.action === 'watch') {
      await addOperatorAlert({
        severity: 'warning',
        category: 'moderation',
        targetType,
        target,
        summary: `Watched ${targetType}:${target} appeared in public feed gossip`,
        suggestedActions: ['review', 'quarantine', 'block']
      })
    }
  }

  async function recordUnknownOwnerAlert(candidate = {}, { source = 'discovered' } = {}) {
    const channelKey = candidate.channelKey || candidate.driveKey
    if (!channelKey || candidate.ownerKey) return
    if (source === 'archive-job' || source === 'local') return

    await ensureOperatorAlert({
      severity: 'warning',
      category: 'moderation',
      targetType: 'channelKey',
      target: channelKey,
      summary: `Accepted channelKey:${channelKey} has no verified owner key`,
      suggestedActions: ['review', 'watch', 'quarantine']
    })
  }

  function moderationStateForAction(action) {
    if (action === 'block') return 'blocked'
    if (action === 'quarantine') return 'quarantined'
    if (action === 'watch') return 'watched'
    if (action === 'allow') return 'allowed'
    return action || 'review'
  }

  function mergeRuntimeModerationRule(rule) {
    const existingRules = Array.isArray(config.moderation?.rules) ? config.moderation.rules : []
    const rules = existingRules.filter((entry) => entry.id !== rule.id)
    rules.push(rule)
    config.moderation = normalizeModerationConfig({
      ...(config.moderation || {}),
      rules
    })
  }

  async function applyCatalogModerationRule(rule) {
    if (rule.targetType !== 'channelKey') return null
    const existing = relayCatalog.getChannel(rule.target)
    if (!existing) return null

    const now = Number(nowFn()) || Date.now()
    const state = moderationStateForAction(rule.action)
    return relayCatalog.upsertChannel({
      channelKey: rule.target,
      moderation: {
        ...existing.moderation,
        ...rule,
        state,
        matchedAt: now
      },
      relayServing: rule.action === 'block' || rule.action === 'quarantine' ? false : existing.relayServing,
      lastDecisionReason: `operator-${rule.action}`,
      lastSeenAt: now
    })
  }

  const basePublishRelayCatalogEntry = typeof runtime.publishRelayCatalogEntry === 'function'
    ? runtime.publishRelayCatalogEntry.bind(runtime)
    : null

  async function persistRuntimeRelayCatalogEntry(entry = {}) {
    const channelKey = entry.channelKey || entry.driveKey
    const publicBeeKey = entry.publicBeeKey || null
    if (!channelKey || !publicBeeKey) return null
    const existing = relayCatalog.getChannel(channelKey)

    const previewVideos = Array.isArray(entry.previewVideos) ? entry.previewVideos : []
    const unavailableVideos = Array.isArray(entry.unavailableVideos) ? entry.unavailableVideos : []
    const manifestUpdatedAt = Number(entry.manifestUpdatedAt || entry.mirroredAt || entry.lastSeenAt || nowFn()) || Date.now()
    const source = entry.source === 'relay-cache' && existing?.source === 'archive-job'
      ? existing.source
      : (entry.source || existing?.source || 'relay-cache')
    const retentionClass = entry.retentionClass || existing?.retentionClass || (source === 'archive-job' ? 'private' : 'discovery')
    const record = {
      ...entry,
      channelKey,
      driveKey: entry.driveKey || channelKey,
      publicBeeKey,
      source,
      retentionClass,
      relayRole: entry.relayRole || 'cache',
      relayServing: entry.relayServing === true,
      lastSeenAt: Number(entry.lastSeenAt || manifestUpdatedAt) || manifestUpdatedAt,
      mirroredAt: Number(entry.mirroredAt || manifestUpdatedAt) || manifestUpdatedAt,
      previewVideos,
      unavailableVideos,
      videoCount: Number(entry.videoCount || previewVideos.length || unavailableVideos.length || 0) || 0,
      manifestUpdatedAt
    }

    const persisted = await relayCatalog.upsertChannel(record)
    await persistStatus()
    return persisted
  }

  runtime.publishRelayCatalogEntry = async (entry = {}) => {
    const published = basePublishRelayCatalogEntry
      ? await basePublishRelayCatalogEntry(entry)
      : entry
    const catalogEntry = published && typeof published === 'object'
      ? { ...entry, ...published }
      : entry
    const persisted = await persistRuntimeRelayCatalogEntry(catalogEntry)
    return published || persisted
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
      const source = existingChannel.source === 'archive-job' && (!resolved.source || resolved.source === 'discovered' || resolved.source === 'relay-cache')
        ? existingChannel.source
        : (resolved.source || existingChannel.source || 'discovered')
      await relayCatalog.upsertChannel({
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || existingChannel.ownerKey || null,
        publicBeeKey: resolved.publicBeeKey || existingChannel.publicBeeKey || null,
        source,
        retentionClass,
        lastDecisionReason: refreshDecision.reason,
        lastSeenAt: now
      })
      logger.mirror.debug('Accepted channel refresh skipped during mirror retry cooldown', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || existingChannel.ownerKey || null,
        retryAfterMs: Math.ceil(refreshDecision.retryAfterMs)
      })
      await recordUnknownOwnerAlert({
        ...resolved,
        ownerKey: resolved.ownerKey || existingChannel.ownerKey || null
      }, { source })
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
      await recordModerationAlert(decision, resolved)
      if (decision.reason === 'moderation-quarantined' && resolved.channelKey) {
        await relayCatalog.upsertChannel({
          channelKey: resolved.channelKey,
          ownerKey: resolved.ownerKey || null,
          publicBeeKey: resolved.publicBeeKey || null,
          source: resolved.source || 'discovered',
          retentionClass: resolved.retentionClass || 'discovery',
          lastDecisionReason: decision.reason,
          lastSeenAt: now,
          moderation: {
            ...decision.moderation,
            state: 'quarantined',
            matchedAt: now
          }
        })
      }
      logger.admission.info('Candidate rejected', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        source: resolved.source || 'discovered',
        reason: decision.reason
      })
      await persistStatus()
      return decision
    }

    await recordModerationAlert(decision, resolved)

    const acceptedSource = existingChannel?.source === 'archive-job' && (!resolved.source || resolved.source === 'discovered' || resolved.source === 'relay-cache')
      ? existingChannel.source
      : (resolved.source || 'discovered')
    await recordUnknownOwnerAlert(resolved, { source: acceptedSource })
    const moderationRecord = decision.moderation?.action === 'watch'
      ? {
          moderation: {
            ...decision.moderation,
            state: 'watched',
            matchedAt: now
          }
        }
      : {}
    const baseRecord = {
      channelKey: resolved.channelKey,
      ownerKey: resolved.ownerKey || null,
      publicBeeKey: resolved.publicBeeKey || null,
      source: acceptedSource,
      retentionClass: decision.retentionClass,
      lastDecisionReason: decision.reason,
      lastSeenAt: now,
      ...moderationRecord
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
        const catalogEntry = {
          ...(seedStats?.catalogEntry || {
            schema: 'peartube.relayCatalog',
            catalogVersion: 1,
            driveKey: resolved.channelKey,
            publicBeeKey: resolved.publicBeeKey,
            source: 'relay-cache',
            relayRole: 'cache',
            relayServing: false,
            previewVideos: persistedPreviewVideos,
            unavailableVideos: mirrorUnavailableVideos,
            videoCount: Number(mirrorStats?.videoCount || mirrorStats?.videosDownloaded || mirrorStats?.videosFound || persistedPreviewVideos.length || 0) || 0,
            manifestUpdatedAt: now
          }),
          ...(baseRecord.source === 'archive-job'
              ? { source: 'archive-job', retentionClass: 'private', relayServing: true }
              : { relayServing: false })
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
      source: 'archive-job',
      retentionClass: 'private',
      relayRole: 'cache',
      relayServing: true,
      previewVideos,
      unavailableVideos: [],
      videoCount: previewVideos.length,
      manifestUpdatedAt
    }
    await runtime.publishRelayCatalogEntry?.({
      ...catalogEntry,
      source: 'archive-job',
      retentionClass: 'private'
    }).catch(() => {})
    await recordArchivePublishAlert(job)
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

      await recordPostureAlerts()

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
        onCompleted: (job) => service.publishArchiveJobToFeed(job),
        onFailed: (job) => service.recordArchiveJobFailure(job, { store })
      })
      const job = await manager.enqueue(input)
      await service.recordArchiveJobQueued(job, { store, input })
      if (runNow) return manager.runJob(job.id)
      return job
    },
    async recordArchiveJobQueued(job, { store, input } = {}) {
      const privateInput = input?.url
        ? input
        : (job?.id && store ? await store.getPrivateInput(job.id).catch(() => null) : null)
      await recordArchiveJobAlert(privateInput || input)
      const result = await recordArchiveSourceVolumeAlert(job, { store, input: privateInput || input })
      await persistStatus()
      return result
    },
    async recordArchiveJobFailure(job, { store } = {}) {
      const result = await recordArchiveFailureAlert(job, { store })
      await persistStatus()
      return result
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
    async addModerationRule(rule) {
      const store = await ModerationRuleStore.open({
        storagePath: config.storage.path,
        moderationPath: config.paths?.moderation
      })
      const added = await store.addRule(rule)
      mergeRuntimeModerationRule(added)
      await applyCatalogModerationRule(added)
      await persistStatus()
      return added
    },
    async submitModerationReport(report) {
      const store = await getReportStore()
      const added = await store.addReport(report)
      const reportsForTarget = store.getReports({
        targetType: added.targetType,
        target: added.target,
        limit: Infinity
      })
      await addOperatorAlert({
        severity: 'warning',
        category: 'moderation',
        targetType: added.targetType,
        target: added.target,
        summary: `Local report submitted for ${added.targetType}:${added.target} (${added.reason})`,
        suggestedActions: ['review', 'watch', 'quarantine', 'block']
      })
      const reportThreshold = Number(config.moderation?.reportThreshold || 0)
      if (reportThreshold > 0 && reportsForTarget.length >= reportThreshold) {
        await ensureOperatorAlert({
          severity: 'critical',
          category: 'moderation',
          targetType: added.targetType,
          target: added.target,
          summary: `Report threshold exceeded for ${added.targetType}:${added.target}`,
          suggestedActions: ['review', 'quarantine', 'block']
        })
      }
      await persistStatus()
      return added
    },
    getModerationTargetDetail({ targetType, target } = {}) {
      return relayCatalog.getTargetDetail({ targetType, target })
    },
    getModerationAudit() {
      const status = service.getStatus()
      const reviewQueue = Array.isArray(status.reviewQueue) ? status.reviewQueue : []
      const reports = reportStore?.getReports({ limit: Infinity }) || []
      return {
        schema: 'peartube.relayModerationAudit',
        version: 1,
        generatedAt: Number(nowFn()) || Date.now(),
        roles: status.roles || [],
        posture: status.posture || null,
        moderation: status.moderation || null,
        rules: Array.isArray(config.moderation?.rules) ? config.moderation.rules.map((rule) => ({ ...rule })) : [],
        reports,
        alerts: alertStore?.getAlerts({ includeAcknowledged: true, limit: Infinity }) || [],
        reviewQueue,
        targets: reviewQueue.map((item) => relayCatalog.getTargetDetail({
          targetType: item.targetType,
          target: item.target
        }))
      }
    },
    getStatus() {
      return currentStatus || buildRelayStatus({
        config,
        catalog: relayCatalog,
        runtimeStats: runtime.getNetworkStats?.() || {},
        alerts: alertStore?.getAlerts({ limit: Infinity }) || [],
        reports: reportStore?.getReports({ limit: Infinity }) || []
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
