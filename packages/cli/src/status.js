import { existsSync, readFileSync, writeFileSync } from '#fs'
import { retentionClassPriority } from './admission.js'

function sortEvictionCandidates(channels) {
  return [...channels].sort((left, right) => {
    const priorityDiff = retentionClassPriority(left.retentionClass) - retentionClassPriority(right.retentionClass)
    if (priorityDiff !== 0) return priorityDiff
    return (left.mirroredAt || 0) - (right.mirroredAt || 0)
  })
}

export function buildRelayStatus({ config, catalog, runtimeStats = {} }) {
  const channels = catalog.getChannels()
  const summary = catalog.getSummary()

  return {
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
      feedEntries: runtimeStats.feedEntries || 0,
      dht: {
        bootstrapped: runtimeStats.dht?.bootstrapped ?? null,
        firewalled: runtimeStats.dht?.firewalled ?? null,
        online: runtimeStats.dht?.online ?? null
      },
      publicFeedDiscoveryJoined: Boolean(runtimeStats.publicFeedDiscoveryJoined),
      blindPeer: runtimeStats.blindPeer || runtimeStats.seeding?.blindPeer || null,
      peerPoolJoined: Boolean(runtimeStats.peerPoolJoined),
      swarmOffline: Boolean(runtimeStats.swarmOffline),
      swarmOfflineReason: runtimeStats.swarmOfflineReason || null,
      swarmListenResolved: Boolean(runtimeStats.swarmListenResolved),
      seeding: {
        channels: runtimeStats.seeding?.channels || 0,
        videos: runtimeStats.seeding?.videos || 0,
        publicBeeCores: runtimeStats.seeding?.publicBeeCores || 0,
        blobCores: runtimeStats.seeding?.blobCores || 0,
        discoveryHandles: runtimeStats.seeding?.discoveryHandles || 0,
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
  writeFileSync(statusPath, JSON.stringify(status, null, 2))
}

export function readRelayStatus(statusPath) {
  if (!statusPath || !existsSync(statusPath)) return null
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

export function formatRelayStatus(status) {
  const lines = [
    `mode: ${status.mode}`,
    `policy: ${status.policy}`,
    `storage: ${status.summary.usedBytes}/${status.storage.maxBytes} bytes`,
    `channels: ${status.summary.totalChannels}`,
    `protected: ${status.summary.protectedChannels}`,
    `evictable: ${status.summary.evictableChannels}`,
    `peers: ${status.runtime.peers}`,
    `connections: ${status.runtime.connections}`,
    `feedPeers: ${status.runtime.feedPeers}`,
    `feedConnections: ${status.runtime.feedConnections}`,
    `feedEntries: ${status.runtime.feedEntries}`,
    `dht: bootstrapped=${status.runtime.dht.bootstrapped} firewalled=${status.runtime.dht.firewalled} online=${status.runtime.dht.online}`,
    `network: offline=${status.runtime.swarmOffline} reason=${status.runtime.swarmOfflineReason || 'none'} listenResolved=${status.runtime.swarmListenResolved} peerPoolJoined=${status.runtime.peerPoolJoined} publicFeedDiscoveryJoined=${status.runtime.publicFeedDiscoveryJoined}`,
    `blindPeer: enabled=${Boolean(status.runtime.blindPeer?.enabled)} key=${status.runtime.blindPeer?.publicKey || 'none'} mirroredCores=${status.runtime.blindPeer?.mirroredCores || 0} mirroredAutobases=${status.runtime.blindPeer?.mirroredAutobases || 0}`,
    `seeding: channels=${status.runtime.seeding.channels} videos=${status.runtime.seeding.videos} publicBeeCores=${status.runtime.seeding.publicBeeCores} blobCores=${status.runtime.seeding.blobCores} discoveryHandles=${status.runtime.seeding.discoveryHandles}`
  ]

  if (status.evictionCandidates.length > 0) {
    lines.push('evictionCandidates:')
    for (const candidate of status.evictionCandidates) {
      lines.push(`- ${candidate.channelKey} (${candidate.retentionClass}, ${candidate.bytes} bytes)`)
    }
  }

  return lines.join('\n')
}
