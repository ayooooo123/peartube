export interface StorageStats {
  usedBytes: number
  maxBytes: number
  usedGB: string
  maxGB: number
  seedCount: number
  pinnedCount: number
}

export interface SeedingStatus {
  status?: {
    enabled?: boolean
    usedStorage?: number
    maxStorage?: number
    seedingCount?: number
  } | null
}

export interface SwarmStatus {
  connected?: boolean
  peerCount?: number
  swarmConnections?: number
  swarmPeers?: number
  feedConnections?: number
  feedEntries?: number
  channelsLoaded?: number
  network?: {
    dht?: {
      bootstrapped?: boolean | null
      firewalled?: boolean | null
      online?: boolean | null
      ephemeral?: boolean | null
    }
    discovery?: {
      peerPoolJoined?: boolean
      publicFeedDiscoveryJoined?: boolean
      discoveredPeers?: number
      recentPeers?: unknown[]
    }
    socket?: {
      swarmPeers?: number
      swarmConnections?: number
      connecting?: number
      recentConnections?: unknown[]
      peerStates?: unknown[]
    }
    feed?: {
      feedConnections?: number
      feedEntries?: number
      directPeerDial?: { discoveredPeers?: number } | null
      lastHaveFeed?: {
        at?: number
        received?: number
        accepted?: number
        added?: number
        updated?: number
        rejected?: number
        lastRejectReason?: string | null
      } | null
    }
    recommendedBoundary?: string | null
  } | null
  swarmOffline?: boolean
  swarmOfflineReason?: string | null
  swarmListenResolved?: boolean
  peerPoolJoined?: boolean
  publicFeedDiscoveryJoined?: boolean
  feedTopicHex?: string | null
  /** JSON-encoded fallbacks — the HRPC wire schema carries these as strings. */
  networkJson?: string | null
  doctorJson?: string | null
  recommendedBoundary?: string | null
}
