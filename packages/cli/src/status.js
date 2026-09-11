import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { summarizeCreatorsFromCatalog } from './creators.js'

function summarizeCreators(creators) {
  let videosArchived = 0
  let videosUnseeded = 0
  let classifiedMovies = 0
  let classifiedTv = 0
  for (const creator of creators) {
    videosArchived += Number(creator.videosArchived || 0) || 0
    videosUnseeded += Number(creator.videosUnseeded || 0) || 0
    classifiedMovies += Number(creator.classification?.movie || 0) || 0
    classifiedTv += Number(creator.classification?.tv || 0) || 0
  }
  return {
    totalCreators: creators.length,
    videosArchived,
    videosUnseeded,
    classifiedMovies,
    classifiedTv
  }
}

function count(value) {
  const next = Number(value)
  return Number.isSafeInteger(next) && next >= 0 ? next : 0
}

// A byte reading that may not exist on this runtime. `count` folds an
// unmeasurable signal into 0, which reads exactly like a measured zero; a
// capacity number has to keep the two apart, so presence is decided BEFORE any
// conversion. `Number(null)` is 0, so converting first turned every signal a
// runtime without statfs cannot read into a volume with nothing left on it —
// the precise misreading this helper exists to prevent. A measurement is a
// number; anything else is the absence of one.
function measured(value) {
  if (typeof value !== 'number') return null
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedErrorCodes(values) {
  const result = []
  for (const value of Array.isArray(values) ? values : []) {
    const code = String(value || '').toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || result.includes(code)) continue
    result.push(code)
    if (result.length >= 8) break
  }
  return result
}

function boundedSelectedIndexers(policy) {
  const selected = Array.isArray(policy.selectedIndexers) ? policy.selectedIndexers : []
  const countHint = Math.min(8, count(policy.selectedIndexerCount ?? selected.length))
  return Array.from({ length: countHint }, (_, index) => {
    const status = String(selected[index]?.status || 'unknown')
    return {
      id: `selected-${index + 1}`,
      status: ['active', 'pending', 'offline', 'error'].includes(status) ? status : 'unknown'
    }
  })
}

function buildEffectivePolicy(policy) {
  const permissions = {
    contribute: policy.permissions?.contribute === true,
    archive: policy.permissions?.archive === true
  }
  const effectiveRole = ['watch-only', 'contributor', 'archive-enabled'].includes(policy.effectiveRole)
    ? policy.effectiveRole
    : 'watch-only'
  return {
    policyVersion: count(policy.policyVersion),
    consentVersion: count(policy.consentVersion),
    migrationRequired: policy.migrationRequired !== false,
    effectiveRole,
    permissions
  }
}

function buildBudgets(policy, retention) {
  return {
    contribution: {
      configuredBytes: count(policy.contributionBudgetBytes),
      usedBytes: count(retention.contributionUsedBytes)
    },
    archive: {
      configuredBytes: count(policy.archiveBudgetBytes),
      usedBytes: count(retention.archiveUsedBytes)
    }
  }
}

function buildAcquisitionsByState(acquisitionStatus) {
  const acquisitionsByState = {}
  for (const state of ['queued', 'acquiring', 'verifying', 'publishing', 'completed', 'failed', 'cancelled']) {
    acquisitionsByState[state] = count(acquisitionStatus.acquisitionsByState?.[state])
  }
  return acquisitionsByState
}

function collectErrors(acquisitionStatus, network, publisher) {
  return boundedErrorCodes([
    ...(acquisitionStatus.lastErrors || []),
    ...(network.lastErrors || []),
    publisher.lastErrorCode
  ])
}

function buildPublicWork(publicWork, publisher, archive, acquisitionStatus, acquisitionsByState) {
  return {
    activeAnnouncements: count(publicWork.activeAnnouncements ??
      (count(publisher.catalogs) + count(archive.activePledgeCount))),
    activeServes: count(publicWork.activeServes),
    servedBytes: count(publicWork.servedBytes),
    activeAcquisitions: count(acquisitionStatus.activeAcquisitions),
    acquisitionsByState
  }
}

function buildBlockOffload(blockOffload) {
  return {
    enabled: blockOffload?.enabled === true,
    windowBytes: count(blockOffload?.windowBytes),
    restored: count(blockOffload?.restored),
    residentBytes: count(blockOffload?.residentBytes)
  }
}

// Named field by field on purpose: this file is world-readable to anything
// that can read the relay's storage directory, and a passthrough spread
// would be one careless caller away from writing a bucket name or a key
// into it.
function buildCapacity(capacity) {
  return {
    localUsedBytes: measured(capacity?.localUsedBytes),
    localFreeBytes: measured(capacity?.localFreeBytes),
    localHeadroomBytes: measured(capacity?.localHeadroomBytes),
    effectiveCapacityBytes: measured(capacity?.effectiveCapacityBytes)
  }
}

export function buildRelayStatus({
  config,
  catalog,
  runtimeStats = {},
  acquisitionStatus = {},
  creators = null,
  trustedClientsCount = 0,
  // null unless the operator enabled S3 block offload. Only current residency
  // and restore activity are reported; transfer totals are not durable
  // inventory and reset when the relay restarts.
  blockOffload = null,
  capacity = null
}) {
  const channels = catalog.getChannels()
  const summary = catalog.getSummary()
  const creatorRecords = Array.isArray(creators) ? creators : summarizeCreatorsFromCatalog(channels)
  const network = runtimeStats.network || {}
  const publisher = runtimeStats.publisher || {}
  const policy = runtimeStats.policy || {}
  const archive = runtimeStats.archive || {}
  const retention = runtimeStats.seedRetention?.retention || {}
  const publicWork = runtimeStats.publicWork || {}
  const acquisitionsByState = buildAcquisitionsByState(acquisitionStatus)

  return {
    generatedAt: Date.now(),
    mode: String(config.mode || 'unknown').slice(0, 32),
    effectivePolicy: buildEffectivePolicy(policy),
    budgets: buildBudgets(policy, retention),
    publicWork: buildPublicWork(publicWork, publisher, archive, acquisitionStatus, acquisitionsByState),
    selectedIndexers: boundedSelectedIndexers(policy),
    lastErrors: collectErrors(acquisitionStatus, network, publisher),
    network: {
      status: String(network.status || 'unknown').slice(0, 32),
      peers: count(network.peers),
      connections: count(network.connections),
      offline: network.offline === true
    },
    summary: {
      totalChannels: count(summary.totalChannels),
      protectedChannels: count(summary.protectedChannels),
      evictableChannels: Math.max(0, channels.length - count(summary.protectedChannels)),
      usedBytes: count(summary.usedBytes)
    },
    creators: summarizeCreators(creatorRecords),
    authorizedClients: count(trustedClientsCount),
    blockOffload: buildBlockOffload(blockOffload),
    capacity: buildCapacity(capacity)
  }
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

function formatPolicyLines(status) {
  const policy = status.effectivePolicy || {}
  const contribution = status.budgets?.contribution || {}
  const archive = status.budgets?.archive || {}
  return [
    `mode: ${status.mode || 'unknown'}`,
    `role: ${policy.effectiveRole || 'watch-only'} migrationRequired=${policy.migrationRequired !== false} consentVersion=${policy.consentVersion || 0}`,
    `permissions: contribute=${policy.permissions?.contribute === true} archive=${policy.permissions?.archive === true}`,
    `contributionBudget: ${contribution.usedBytes || 0}/${contribution.configuredBytes || 0} bytes`,
    `archiveBudget: ${archive.usedBytes || 0}/${archive.configuredBytes || 0} bytes`
  ]
}

function formatWorkAndNetworkLines(status) {
  const work = status.publicWork || {}
  const network = status.network || {}
  const summary = status.summary || {}
  const acquisitionsFormatted = Object.entries(work.acquisitionsByState || {})
    .map(([state, value]) => `${state}=${value}`)
    .join(' ')
  return [
    `publicWork: announcements=${work.activeAnnouncements || 0} serves=${work.activeServes || 0} servedBytes=${work.servedBytes || 0} acquisitions=${work.activeAcquisitions || 0}`,
    `acquisitions: ${acquisitionsFormatted}`,
    `network: status=${network.status || 'unknown'} peers=${network.peers || 0} connections=${network.connections || 0} offline=${network.offline === true}`,
    `channels: total=${summary.totalChannels || 0} protected=${summary.protectedChannels || 0} evictable=${summary.evictableChannels || 0}`
  ]
}

function formatSystemLines(status) {
  const blockOffload = status.blockOffload || {}
  const creators = status.creators || {}
  const selectedIndexers = (status.selectedIndexers || []).map(indexer => `${indexer.id}:${indexer.status}`).join(',') || 'none'
  const lastErrors = (status.lastErrors || []).join(',') || 'none'
  return [
    `selectedIndexers: ${selectedIndexers}`,
    `lastErrors: ${lastErrors}`,
    `authorizedClients: ${status.authorizedClients || 0}`,
    `blockOffload: enabled=${blockOffload.enabled === true} windowBytes=${blockOffload.windowBytes || 0} residentBytes=${blockOffload.residentBytes || 0} restored=${blockOffload.restored || 0}`,
    `creators: total=${creators.totalCreators || 0} archived=${creators.videosArchived || 0} unseeded=${creators.videosUnseeded || 0}`
  ]
}

export function formatRelayStatus(status) {
  const lines = [
    ...formatPolicyLines(status),
    ...formatWorkAndNetworkLines(status),
    ...formatSystemLines(status)
  ]
  return lines.join('\n')
}
