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
  const unseededTargets = rankUnseededTargets(creatorRecords, { limit: UNSEEDED_TARGET_LIMIT })

  return {
    creators: {
      ...summarizeCreators(creatorRecords),
      unseededTargets
    },
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
      // Re-seeding, both directions. archiveRequests is what this relay asked
      // the network to mirror, each carrying the archivists' own possession
      // evidence; archiveParticipation is what it mirrors for other relays.
      archiveRequests: Array.isArray(runtimeStats.archiveRequests) ? runtimeStats.archiveRequests : [],
      archiveParticipation: runtimeStats.archiveParticipation || {},
      archiveHostDisk: runtimeStats.archiveHostDisk || {},
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
  // Re-seeding, both directions. Every number here is measured: a request this
  // relay published, and an archivist whose possession challenge for those
  // exact ranges passed. Nothing counts a peer that merely serves the bytes,
  // and no line claims the content is kept anywhere but here.
  const archiveRequests = Array.isArray(status.runtime.archiveRequests) ? status.runtime.archiveRequests : []
  const mirroring = status.runtime.archiveParticipation || {}
  const hostDisk = status.runtime.archiveHostDisk || {}
  const publishedRequests = archiveRequests.reduce((count, entry) => count + (entry?.status === 'published' ? 1 : 0), 0)
  const withEvidence = archiveRequests.reduce((count, entry) => count + ((entry?.archivists || 0) > 0 ? 1 : 0), 0)
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
    `creators: total=${status.creators?.totalCreators || 0} archived=${status.creators?.videosArchived || 0} unseeded=${status.creators?.videosUnseeded || 0} movies=${status.creators?.classifiedMovies || 0} tv=${status.creators?.classifiedTv || 0}`,
    `archiveRequests: total=${archiveRequests.length} published=${publishedRequests} failed=${archiveRequests.length - publishedRequests} withArchivistEvidence=${withEvidence}`,
    `archiveMirroring: enabled=${Boolean(mirroring.enabled)} reservedBytes=${mirroring.reservedBytes || 0} availableBytes=${mirroring.availableBytes || 0} capacityBytes=${mirroring.capacityBytes || 0} receivedPledges=${mirroring.receivedPledges || 0} acceptedRequests=${mirroring.acceptedRequests || 0} rejected=capacity:${mirroring.capacityRejections || 0}/random:${mirroring.randomRejections || 0}/authorization:${mirroring.authorizationRejections || 0}`,
    // A relay that cannot read its own disk is not cleared to promise anyone
    // durable storage, and this is where an operator sees why.
    `archiveHostDisk: measured=${Boolean(hostDisk.measured)} freeBytes=${hostDisk.freeBytes ?? 'unknown'} totalBytes=${hostDisk.totalBytes ?? 'unknown'} reason=${hostDisk.reason || 'none'}`,
  ]

  const unseededTargets = Array.isArray(status.creators?.unseededTargets) ? status.creators.unseededTargets : []
  if (unseededTargets.length > 0) {
    lines.push('unseededTargets:')
    for (const target of unseededTargets.slice(0, 10)) {
      lines.push(`- ${target.name} (${target.videosUnseeded}/${target.videosArchived} unseeded)`)
    }
  }

  if (archiveRequests.length > 0) {
    lines.push('archiveRequests:')
    for (const entry of archiveRequests) {
      lines.push(
        `- ${entry.publicationId}/${entry.renditionId} status=${entry.status || 'unknown'}` +
        ` archivists=${entry.archivists || 0} fresh=${entry.freshArchivists || 0}` +
        (entry.errorCode ? ` error=${entry.errorCode}` : '')
      )
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
