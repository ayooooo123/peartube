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
  trustedClientsCount = 0
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
    authorizedClients: count(trustedClientsCount)
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
    `creators: total=${status.creators?.totalCreators || 0} archived=${status.creators?.videosArchived || 0} unseeded=${status.creators?.videosUnseeded || 0}`
  ]
  return lines.join('\n')
}
