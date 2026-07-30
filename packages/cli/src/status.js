import { existsSync, mkdirSync, readFileSync, writeFileSync } from '#fs'
import { retentionClassPriority } from './admission.js'
import { rankUnseededTargets, summarizeCreatorsFromCatalog } from './creators.js'

const UNSEEDED_TARGET_LIMIT = 25

function sortEvictionCandidates(channels) {
  return [...channels].sort((left, right) => {
    const priorityDiff = retentionClassPriority(left.retentionClass) - retentionClassPriority(right.retentionClass)
    if (priorityDiff !== 0) return priorityDiff
    return (left.mirroredAt || 0) - (right.mirroredAt || 0)
  })
}

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

export function buildRelayStatus({ config, catalog, runtimeStats = {}, creators = null, trustedClientsCount = 0 }) {
  const channels = catalog.getChannels()
  const summary = catalog.getSummary()
  const creatorRecords = Array.isArray(creators) ? creators : summarizeCreatorsFromCatalog(channels)
if (status.library) {
    const items = status.library.items || {}
    lines.push(
      `library: folders=${status.library.folders} items=${status.library.totalItems ?? 0} bytes=${status.library.bytes ?? 0}${status.library.capBytes ? `/${status.library.capBytes}` : ''}`,
      `libraryStates: published=${items.published || 0} durable=${items.durable || 0} selfOnly=${items['self-only'] || 0} pendingApproval=${items['pending-approval'] || 0} failed=${items.failed || 0} unseeded=${items.unseeded || 0}`,
      `libraryImports: paused=${Boolean(status.library.importsPaused)}${status.library.importsPausedReason ? ` reason=${status.library.importsPausedReason}` : ''}`,
      `libraryHiverelay: enabled=${Boolean(status.library.hiverelay?.enabled)} endpoint=${status.library.hiverelay?.endpoint || 'none'}`
    )
    if (Array.isArray(status.library.awaitingPublicConfirmation) && status.library.awaitingPublicConfirmation.length > 0) {
      lines.push('libraryAwaitingPublicConfirmation:')
      for (const path of status.library.awaitingPublicConfirmation) {
        lines.push(`- ${path}`)
      }
    }
  }

  const unseededTargets = rankUnseededTargets(creatorRecords, { limit: UNSEEDED_TARGET_LIMIT })

  return {
    creators: {
      ...summarizeCreators(creatorRecords),
      unseededTargets
    },
    ...(library ? { library } : {}),
    ...(quota ? { quota } : {}),
    generatedAt: Date.now(),
    mode: config.mode,
    policy: config.policy,
    storage: {
      path: config.storage.path,
      maxBytes: config.storage.maxBytes
    },
    summary: {
      ...summary,
      evictableChannels: channels.length - summary.protectedChannels
    },
    runtime: {
      network: runtimeStats.network || {},
      publisher: runtimeStats.publisher || {},
      bootstrap: runtimeStats.bootstrap || {},
      assets: runtimeStats.assets || {},
      seedRetention: runtimeStats.seedRetention || {},
      archive: runtimeStats.archive || {},
      storage: runtimeStats.storage || {},
      authorizedClients: Number(trustedClientsCount) || 0
    },
    evictionCandidates: sortEvictionCandidates(channels).map((channel) => ({
      channelKey: channel.channelKey,
      ownerKey: channel.ownerKey || null,
      retentionClass: channel.retentionClass,
      bytes: channel.bytes || 0,
      mirroredAt: channel.mirroredAt || null
    })),
    channels
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
  const network = status.runtime.network || {}
  const publisher = status.runtime.publisher || {}
  const bootstrap = status.runtime.bootstrap || {}
  const assets = status.runtime.assets || {}
  const seedRetention = status.runtime.seedRetention || {}
  const archive = status.runtime.archive || {}
  const storage = status.runtime.storage || {}
  const lines = [
    `mode: ${status.mode}`,
    `policy: ${status.policy}`,
    `storage: ${status.summary.usedBytes}/${status.storage.maxBytes} bytes`,
    `channels: ${status.summary.totalChannels}`,
    `protected: ${status.summary.protectedChannels}`,
    `evictable: ${status.summary.evictableChannels}`,
    `network: peers=${network.peers || 0} connections=${network.connections || 0} offline=${Boolean(network.offline)} reason=${network.offlineReason || 'none'} listenResolved=${Boolean(network.listenResolved)}`,
    `dht: bootstrapped=${network.dht?.bootstrapped ?? null} firewalled=${network.dht?.firewalled ?? null} online=${network.dht?.online ?? null}`,
    `publisher: catalogs=${publisher.catalogs || 0} followed=${publisher.followed || 0} lastError=${publisher.lastErrorCode || 'none'}`,
    `bootstrap: joined=${Boolean(bootstrap.joined)} locators=${bootstrap.locators || 0} rejected=${bootstrap.rejected || 0} limit=${bootstrap.maxLocators || 0}`,
    `assets: retainedRenditions=${assets.retainedRenditions || 0} activeSessions=${assets.activeSessions || 0} limit=${assets.maxSessions || 0}`,
    `archive: active=${archive.activePledgeCount || 0} healthy=${archive.healthyPledgeCount || 0} failed=${archive.failedPledgeCount || 0}`,
    `seedRetention: activeSeeds=${seedRetention.activeSeeds || 0} pinnedChannels=${seedRetention.pinnedChannels || 0} storageUsedBytes=${seedRetention.storageUsedBytes || 0}`,
    `storageDiagnostics: categorizedBytes=${storage.totalCategorizedBytes || 0} protectedBytes=${storage.protectedBytes || 0} success=${Boolean(storage.success)}`,
    `authorizedClients: ${status.runtime.authorizedClients || 0}`,
    `creators: total=${status.creators?.totalCreators || 0} archived=${status.creators?.videosArchived || 0} unseeded=${status.creators?.videosUnseeded || 0} movies=${status.creators?.classifiedMovies || 0} tv=${status.creators?.classifiedTv || 0}`
  ]

  const unseededTargets = Array.isArray(status.creators?.unseededTargets) ? status.creators.unseededTargets : []
  if (unseededTargets.length > 0) {
    lines.push('unseededTargets:')
    for (const target of unseededTargets.slice(0, 10)) {
      lines.push(`- ${target.name} (${target.videosUnseeded}/${target.videosArchived} unseeded)`)
    }
  }

  if (status.evictionCandidates.length > 0) {
    lines.push('evictionCandidates:')
    for (const candidate of status.evictionCandidates) {
      lines.push(`- ${candidate.channelKey} (${candidate.retentionClass}, ${candidate.bytes} bytes)`)
    }
  }

  return lines.join('\n')
}
