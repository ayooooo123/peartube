import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { retentionClassPriority } from './admission.js'
import { latestAlerts, summarizeAlerts } from './alerts.js'
import { summarizeModerationRules } from './moderation.js'
import { buildRelayPosture, describeRelayPosture, normalizeRelayRoles } from './relay-roles.js'

function sortEvictionCandidates(channels) {
  return [...channels].sort((left, right) => {
    const priorityDiff = retentionClassPriority(left.retentionClass) - retentionClassPriority(right.retentionClass)
    if (priorityDiff !== 0) return priorityDiff
    return (left.mirroredAt || 0) - (right.mirroredAt || 0)
  })
}

function reviewKey(item = {}) {
  return `${item.targetType || ''}\0${item.target || ''}`
}

function groupReports(reports = []) {
  const groups = new Map()

  for (const report of reports || []) {
    if (!report?.targetType || !report?.target) continue
    const key = reviewKey(report)
    const existing = groups.get(key) || {
      targetType: report.targetType,
      target: report.target,
      reports: [],
      latest: null
    }
    existing.reports.push(report)
    if (!existing.latest || (Number(report.createdAt || 0) || 0) >= (Number(existing.latest.createdAt || 0) || 0)) {
      existing.latest = report
    }
    groups.set(key, existing)
  }

  return groups
}

function buildReportReviewItem(group, catalog) {
  const detail = typeof catalog?.getTargetDetail === 'function'
    ? catalog.getTargetDetail({ targetType: group.targetType, target: group.target })
    : null
  const firstChannel = Array.isArray(detail?.channels) ? detail.channels[0] || null : null
  const latest = group.latest || {}
  return {
    id: `report:${group.targetType}:${group.target}`,
    targetType: group.targetType,
    target: group.target,
    state: 'reported',
    action: 'review',
    source: 'report',
    reason: latest.reason || null,
    comment: latest.comment || null,
    reporter: latest.reporter || null,
    reportCount: group.reports.length,
    latestReportAt: Number(latest.createdAt || 0) || null,
    channelKey: firstChannel?.channelKey || null,
    ownerKey: firstChannel?.ownerKey || null,
    publicBeeKey: firstChannel?.publicBeeKey || null,
    retentionClass: firstChannel?.retentionClass || null,
    bytes: Number(detail?.cacheStatus?.bytes || 0) || 0,
    videoCount: Number(detail?.cacheStatus?.videoCount || 0) || 0
  }
}

function buildReviewQueue({ catalogReviewQueue = [], reports = [], catalog }) {
  const reportGroups = groupReports(reports)
  if (!reportGroups.size) return catalogReviewQueue

  const reviewQueue = catalogReviewQueue.map((item) => {
    const group = reportGroups.get(reviewKey(item))
    if (!group) return item
    reportGroups.delete(reviewKey(item))
    const latest = group.latest || {}
    return {
      ...item,
      reportCount: group.reports.length,
      latestReportAt: Number(latest.createdAt || 0) || null,
      reportReason: latest.reason || null,
      reportComment: latest.comment || null,
      reporter: latest.reporter || null
    }
  })

  const reportItems = Array.from(reportGroups.values())
    .map((group) => buildReportReviewItem(group, catalog))
    .sort((left, right) => (left.latestReportAt || 0) - (right.latestReportAt || 0))

  return [...reviewQueue, ...reportItems]
}

export function withRelayAlerts(status, alerts = []) {
  const alertSummary = summarizeAlerts(alerts)
  return {
    ...status,
    alerts: {
      ...alertSummary,
      latest: latestAlerts(alerts, { limit: 5 })
    }
  }
}

export function buildRelayStatus({ config, catalog, runtimeStats = {}, alerts = [], reports = [] }) {
  const channels = catalog.getChannels()
  const summary = catalog.getSummary()
  const catalogModeration = typeof catalog.getModerationSummary === 'function'
    ? catalog.getModerationSummary()
    : { quarantinedChannels: 0 }
  const catalogReviewQueue = typeof catalog.getReviewQueue === 'function'
    ? catalog.getReviewQueue()
    : []
  const reviewQueue = buildReviewQueue({ catalogReviewQueue, reports, catalog })
  const roles = normalizeRelayRoles(config.roles, {
    archiveEnabled: Boolean(config.archive?.enabled || config.archive?.localMirror?.enabled)
  })
  const posture = buildRelayPosture(roles)
  return withRelayAlerts({
    generatedAt: Date.now(),
    roles,
    posture,
    mode: config.mode,
    policy: config.policy,
    storage: {
      path: config.storage.path,
      maxBytes: config.storage.maxBytes
    },
    moderation: {
      rules: summarizeModerationRules(config.moderation?.rules),
      quarantinedChannels: catalogModeration.quarantinedChannels || 0
    },
    reviewQueue,
    summary: {
      ...summary,
      evictableChannels: channels.length - summary.protectedChannels
    },
    runtime: {
      peers: runtimeStats.peers || 0,
      connections: runtimeStats.connections || 0,
      feedPeers: runtimeStats.feedPeers || 0,
      feedConnections: runtimeStats.feedConnections || 0,
      feedChannelCandidates: runtimeStats.feedChannelCandidates ?? runtimeStats.feedPeers ?? 0,
      candidateConnections: runtimeStats.candidateConnections ?? runtimeStats.feedChannelCandidates ?? runtimeStats.feedPeers ?? 0,
      rememberedPeerCandidates: runtimeStats.rememberedPeerCandidates ?? runtimeStats.directPeerDial?.discoveredPeers ?? 0,
      feedEntries: runtimeStats.feedEntries || 0,
      dht: {
        bootstrapped: runtimeStats.dht?.bootstrapped ?? null,
        firewalled: runtimeStats.dht?.firewalled ?? null,
        online: runtimeStats.dht?.online ?? null
      },
      publicFeedDiscoveryJoined: Boolean(runtimeStats.publicFeedDiscoveryJoined),
      blindPeer: runtimeStats.blindPeer || runtimeStats.seeding?.blindPeer || null,
      peerPoolJoined: Boolean(runtimeStats.peerPoolJoined),
      directPeerDial: runtimeStats.directPeerDial || null,
      doctor: runtimeStats.doctor || runtimeStats.swarmDoctor || null,
      hyperswarm: runtimeStats.hyperswarm || null,
      swarmOffline: Boolean(runtimeStats.swarmOffline),
      swarmOfflineReason: runtimeStats.swarmOfflineReason || null,
      swarmListenResolved: Boolean(runtimeStats.swarmListenResolved),
      seeding: {
        channels: runtimeStats.seeding?.channels || 0,
        videos: runtimeStats.seeding?.videos || 0,
        publicBeeCores: runtimeStats.seeding?.publicBeeCores || 0,
        blobCores: runtimeStats.seeding?.blobCores || 0,
        discoveryHandles: runtimeStats.seeding?.discoveryHandles || 0,
        blobAvailability: runtimeStats.seeding?.blobAvailability || null,
        lastSeededAt: runtimeStats.seeding?.lastSeededAt || null,
        lastError: runtimeStats.seeding?.lastError || null
      }
    },
    evictionCandidates: sortEvictionCandidates(channels).map((channel) => ({
      channelKey: channel.channelKey,
      ownerKey: channel.ownerKey || null,
      retentionClass: channel.retentionClass,
      bytes: channel.bytes || 0,
      mirroredAt: channel.mirroredAt || null
    })),
    channels
  }, alerts)
}

export function writeRelayStatus(statusPath, status) {
  if (statusPath) {
    const separatorIndex = Math.max(statusPath.lastIndexOf('/'), statusPath.lastIndexOf('\\'))
    if (separatorIndex > 0) mkdirSync(statusPath.slice(0, separatorIndex), { recursive: true })
  }
  writeFileSync(statusPath, JSON.stringify(status, null, 2))
}

export function readRelayStatus(statusPath) {
  if (!statusPath || !existsSync(statusPath)) return null
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

export function formatRelayStatus(status) {
  const firstDialError = status.runtime.directPeerDial?.peers
    ?.find((peer) => peer?.lastError)
    ?.lastError || null
  const roles = normalizeRelayRoles(status.roles)
  const posture = status.posture || buildRelayPosture(roles)
  const lines = [
    `roles: ${roles.join(',')}`,
    `posture: ${describeRelayPosture(posture)}`,
    `moderation: blocked=${status.moderation?.rules?.block || 0} quarantined=${status.moderation?.quarantinedChannels || 0} watched=${status.moderation?.rules?.watch || 0} allowed=${status.moderation?.rules?.allow || 0}`,
    `alerts: critical=${status.alerts?.critical || 0} warning=${status.alerts?.warning || 0} info=${status.alerts?.info || 0}`,
    `mode: ${status.mode}`,
    `policy: ${status.policy}`,
    `storage: ${status.summary.usedBytes}/${status.storage.maxBytes} bytes`,
    `channels: ${status.summary.totalChannels}`,
    `protected: ${status.summary.protectedChannels}`,
    `evictable: ${status.summary.evictableChannels}`,
    `peers: ${status.runtime.peers}`,
    `connections: ${status.runtime.connections}`,
    `feedPeerCandidates: ${status.runtime.feedChannelCandidates ?? status.runtime.feedPeers}`,
    `feedConnections: ${status.runtime.feedConnections}`,
    `rememberedPeerCandidates: ${status.runtime.rememberedPeerCandidates ?? status.runtime.directPeerDial?.discoveredPeers ?? 0}`,
    `feedEntries: ${status.runtime.feedEntries}`,
    `dht: bootstrapped=${status.runtime.dht.bootstrapped} firewalled=${status.runtime.dht.firewalled} online=${status.runtime.dht.online}`,
    `network: offline=${status.runtime.swarmOffline} reason=${status.runtime.swarmOfflineReason || 'none'} listenResolved=${status.runtime.swarmListenResolved} peerPoolJoined=${status.runtime.peerPoolJoined} publicFeedDiscoveryJoined=${status.runtime.publicFeedDiscoveryJoined}`,
    `directPeerDial: discovered=${status.runtime.directPeerDial?.discoveredPeers || 0} pending=${status.runtime.directPeerDial?.pending || 0} queued=${status.runtime.directPeerDial?.queued || 0} skipped=${status.runtime.directPeerDial?.skipped || 0} failed=${status.runtime.directPeerDial?.failed || 0} connected=${status.runtime.directPeerDial?.connected || 0} lastReason=${status.runtime.directPeerDial?.lastReason || 'none'} lastError=${firstDialError || 'none'}`,
    `doctor: boundary=${status.runtime.doctor?.recommendedBoundary || 'unknown'} discovered=${status.runtime.doctor?.discovery?.discoveredPeers ?? status.runtime.directPeerDial?.discoveredPeers ?? 0} sockets=${status.runtime.doctor?.socket?.swarmConnections ?? status.runtime.connections ?? 0} feedConnections=${status.runtime.doctor?.feed?.feedConnections ?? status.runtime.feedConnections ?? 0}`,
    `blindPeer: enabled=${Boolean(status.runtime.blindPeer?.enabled)} key=${status.runtime.blindPeer?.publicKey || 'none'} mirroredCores=${status.runtime.blindPeer?.mirroredCores || 0} mirroredAutobases=${status.runtime.blindPeer?.mirroredAutobases || 0}`,
    `seeding: channels=${status.runtime.seeding.channels} videos=${status.runtime.seeding.videos} publicBeeCores=${status.runtime.seeding.publicBeeCores} blobCores=${status.runtime.seeding.blobCores} discoveryHandles=${status.runtime.seeding.discoveryHandles}`,
    `blobAvailability: playable=${status.runtime.seeding.blobAvailability?.playable || 0} unavailable=${status.runtime.seeding.blobAvailability?.unavailable || 0} unknown=${status.runtime.seeding.blobAvailability?.unknown || 0}`
  ]

  if (status.evictionCandidates.length > 0) {
    lines.push('evictionCandidates:')
    for (const candidate of status.evictionCandidates) {
      lines.push(`- ${candidate.channelKey} (${candidate.retentionClass}, ${candidate.bytes} bytes)`)
    }
  }

  return lines.join('\n')
}
