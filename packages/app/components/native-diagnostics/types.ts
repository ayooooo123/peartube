export interface StorageStats {
  usedBytes: number
  maxBytes: number
  usedGB: string
  maxGB: number
  seedCount: number
  pinnedCount: number
  totalStorageBytes?: number | null
  totalStorageGB?: string | null
  untrackedStorageBytes?: number | null
  untrackedStorageGB?: string | null
  ownedOriginalBytes?: number | null
  immutablePublicationBytes?: number | null
  pledgedArchiveBytes?: number | null
  localCacheBytes?: number | null
  thumbnailBytes?: number | null
  indexBytes?: number | null
  temporaryTransferBytes?: number | null
  totalCategorizedBytes?: number | null
  evictableBytes?: number | null
  protectedBytes?: number | null
}

export interface SeedingStatus {
  status?: {
    enabled?: boolean
    usedStorage?: number
    maxStorage?: number
    seedingCount?: number
  } | null
}

export interface ScopedNetworkTopic {
  purpose: 'bootstrap' | 'publisher' | 'asset' | 'archive' | string
  topicHex: string
  scopeId: string
  modes: string[]
  sessions: number
  range?: { start?: number; end?: number } | null
  coreKey?: string | null
  publisherId?: string | null
}

export interface ScopedNetworkSession {
  peerId: string
  purpose: string
  topicHex: string
  state: string
}

export interface ScopedNetworkDiagnostics {
  status?: string
  protocolMajor?: number
  networkId?: string
  topics?: ScopedNetworkTopic[]
  sessions?: ScopedNetworkSession[]
  counters?: Record<string, number>
}

export interface SwarmStatus {
  connected?: boolean
  peerCount?: number
  swarmConnections?: number
  swarmPeers?: number
  network?: ScopedNetworkDiagnostics | null
  swarmOffline?: boolean
  swarmOfflineReason?: string | null
  swarmListenResolved?: boolean
  peerPoolJoined?: boolean
  /** JSON-encoded fallback — the HRPC wire schema carries nested diagnostics as strings. */
  networkJson?: string | null
  startupTimingJson?: string | null
  recommendedBoundary?: string | null
}
