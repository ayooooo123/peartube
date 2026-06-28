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

export function buildRelayStatus({ config, catalog, runtimeStats = {}, creators = null }) {
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
  const firstDialError = status.runtime.directPeerDial?.peers
    ?.find((peer) => peer?.lastError)
    ?.lastError || null
  const lines = [
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
    `blobAvailability: playable=${status.runtime.seeding.blobAvailability?.playable || 0} unavailable=${status.runtime.seeding.blobAvailability?.unavailable || 0} unknown=${status.runtime.seeding.blobAvailability?.unknown || 0}`,
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
