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

export function buildRelayStatus({
  config,
  catalog,
  runtimeStats = {},
  ingestStatus = {},
  creators = null,
  trustedClientsCount = 0,
  // null unless the operator enabled block offload. Media block data living in
  // an object store changes what "this relay holds the title" means, so it is
  // reported rather than inferred from byte counters that no longer match disk.
  blockOffload = null,
  // null unless the caller measured it. Capacity divides between the local
  // volume and the object store once block offload is on, and a status file
  // that reports only one of the two describes a relay that does not exist.
  capacity = null
}) {
  const channels = catalog.getChannels()
  const summary = catalog.getSummary()
  const creatorRecords = Array.isArray(creators) ? creators : summarizeCreatorsFromCatalog(channels)
  const network = runtimeStats.network || {}
  const publisher = runtimeStats.publisher || {}
  const assets = runtimeStats.assets || {}
  const archive = runtimeStats.archive || {}
  const retention = runtimeStats.seedRetention?.retention || {}
  const policy = runtimeStats.policy || {}
  const permissions = {
    contribute: policy.permissions?.contribute === true,
    archive: policy.permissions?.archive === true
  }
  const publicWork = runtimeStats.publicWork || {}
  const jobsByState = {}
  for (const state of ['queued', 'acquiring', 'verifying', 'publishing', 'completed', 'failed', 'cancelled']) {
    jobsByState[state] = count(ingestStatus.jobsByState?.[state])
  }
  const errors = boundedErrorCodes([
    ...(ingestStatus.lastErrors || []),
    ...(network.lastErrors || []),
    publisher.lastErrorCode
  ])

  return {
    generatedAt: Date.now(),
    mode: String(config.mode || 'unknown').slice(0, 32),
    effectivePolicy: {
      policyVersion: count(policy.policyVersion),
      consentVersion: count(policy.consentVersion),
      migrationRequired: policy.migrationRequired !== false,
      effectiveRole: ['watch-only', 'contributor', 'archive-enabled'].includes(policy.effectiveRole)
        ? policy.effectiveRole
        : 'watch-only',
      permissions
    },
    budgets: {
      contribution: {
        configuredBytes: count(policy.contributionBudgetBytes),
        usedBytes: count(retention.contributionUsedBytes)
      },
      archive: {
        configuredBytes: count(policy.archiveBudgetBytes),
        usedBytes: count(retention.archiveUsedBytes)
      }
    },
    publicWork: {
      activeAnnouncements: count(publicWork.activeAnnouncements ??
        (count(publisher.catalogs) + count(archive.activePledgeCount))),
      activeUploads: count(publicWork.activeUploads ?? assets.activeUploads),
      uploadedBytes: count(publicWork.uploadedBytes ?? assets.uploadedBytes),
      activeAcquisitions: count(ingestStatus.activeAcquisitions),
      jobsByState
    },
    selectedIndexers: boundedSelectedIndexers(policy),
    lastErrors: errors,
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
    blockOffload: {
      enabled: blockOffload?.enabled === true,
      windowBytes: count(blockOffload?.windowBytes),
      blocksOffloaded: count(blockOffload?.blocksOffloaded),
      bytesOffloaded: count(blockOffload?.bytesOffloaded),
      restored: count(blockOffload?.restored),
      residentBytes: count(blockOffload?.residentBytes)
    },
    // Named field by field on purpose: this file is world-readable to anything
    // that can read the relay's storage directory, and a passthrough spread
    // would be one careless caller away from writing a bucket name or a key
    // into it.
    capacity: {
      localUsedBytes: measured(capacity?.localUsedBytes),
      localFreeBytes: measured(capacity?.localFreeBytes),
      localHeadroomBytes: measured(capacity?.localHeadroomBytes),
      residentBytes: count(capacity?.residentBytes),
      offloadedBytes: count(capacity?.offloadedBytes),
      effectiveCapacityBytes: measured(capacity?.effectiveCapacityBytes)
    }
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

export function formatRelayStatus(status) {
  const policy = status.effectivePolicy || {}
  const contribution = status.budgets?.contribution || {}
  const archive = status.budgets?.archive || {}
  const work = status.publicWork || {}
  const lines = [
    `mode: ${status.mode || 'unknown'}`,
    `role: ${policy.effectiveRole || 'watch-only'} migrationRequired=${policy.migrationRequired !== false} consentVersion=${policy.consentVersion || 0}`,
    `permissions: contribute=${policy.permissions?.contribute === true} archive=${policy.permissions?.archive === true}`,
    `contributionBudget: ${contribution.usedBytes || 0}/${contribution.configuredBytes || 0} bytes`,
    `archiveBudget: ${archive.usedBytes || 0}/${archive.configuredBytes || 0} bytes`,
    `publicWork: announcements=${work.activeAnnouncements || 0} uploads=${work.activeUploads || 0} uploadedBytes=${work.uploadedBytes || 0} acquisitions=${work.activeAcquisitions || 0}`,
    `jobs: ${Object.entries(work.jobsByState || {}).map(([state, value]) => `${state}=${value}`).join(' ')}`,
    `network: status=${status.network?.status || 'unknown'} peers=${status.network?.peers || 0} connections=${status.network?.connections || 0} offline=${status.network?.offline === true}`,
    `channels: total=${status.summary?.totalChannels || 0} protected=${status.summary?.protectedChannels || 0} evictable=${status.summary?.evictableChannels || 0}`,
    `selectedIndexers: ${(status.selectedIndexers || []).map(indexer => `${indexer.id}:${indexer.status}`).join(',') || 'none'}`,
    `lastErrors: ${(status.lastErrors || []).join(',') || 'none'}`,
    `authorizedClients: ${status.authorizedClients || 0}`,
    `blockOffload: enabled=${status.blockOffload?.enabled === true} windowBytes=${status.blockOffload?.windowBytes || 0} blocks=${status.blockOffload?.blocksOffloaded || 0} bytes=${status.blockOffload?.bytesOffloaded || 0} restored=${status.blockOffload?.restored || 0}`,
    `creators: total=${status.creators?.totalCreators || 0} archived=${status.creators?.videosArchived || 0} unseeded=${status.creators?.videosUnseeded || 0}`
  ]
  return lines.join('\n')
}
