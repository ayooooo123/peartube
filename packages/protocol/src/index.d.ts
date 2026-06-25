export type ProtocolReadyData = {
  blobServerPort: number | null
  protocolVersion: 3
}

export type ProtocolNetworkStatus = {
  connected: boolean
  peerCount: number
  swarmConnections: number
  swarmPeers: number
  feedConnections: number
  feedEntries: number
  channelsLoaded: number
  swarmOffline: boolean
  swarmOfflineReason: string | null
  swarmListenResolved: boolean
  peerPoolJoined: boolean
  publicFeedDiscoveryJoined: boolean
  feedTopicHex: string | null
  recommendedBoundary: string | null
}

export const PROTOCOL_VERSION: 3

export const HOST_ERROR_CODES: {
  readonly HOST_START_FAILED: 'HOST_START_FAILED'
  readonly STORAGE_INIT_FAILED: 'STORAGE_INIT_FAILED'
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED'
  readonly TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED'
  readonly PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH'
  readonly CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE'
  readonly OFFLINE_UNAVAILABLE: 'OFFLINE_UNAVAILABLE'
  readonly REPLICATION_TIMEOUT: 'REPLICATION_TIMEOUT'
  readonly PLAYBACK_URL_UNAVAILABLE: 'PLAYBACK_URL_UNAVAILABLE'
  readonly PLAYER_LOAD_FAILED: 'PLAYER_LOAD_FAILED'
}

export const PROTOCOL_EVENTS: {
  readonly HOST_READY: 'host.ready'
  readonly HOST_ERROR: 'host.error'
  readonly LOG: 'log'
  readonly UPLOAD_PROGRESS: 'upload.progress'
  readonly DOWNLOAD_PROGRESS: 'download.progress'
  readonly FEED_UPDATED: 'feed.updated'
  readonly NETWORK_STATUS: 'network.status'
  readonly VIDEO_STATS: 'video.stats'
  readonly CAST_DEVICE_FOUND: 'cast.deviceFound'
  readonly CAST_DEVICE_LOST: 'cast.deviceLost'
  readonly CAST_PLAYBACK_STATE: 'cast.playbackState'
  readonly CAST_TIME_UPDATE: 'cast.timeUpdate'
  readonly TRANSPORT_CLOSED: 'transport.closed'
}

type ProtocolMethod = (request?: any) => Promise<any>

type ProtocolNamespace = Record<string, ProtocolMethod>

export function createProtocolClient(options: {
  stream: any
  HRPCImpl?: new (stream: any) => any
}): {
  stream: any
  rpc: any
  events: {
    on(event: string, listener: (payload: any) => void): () => void
  }
  ready(): Promise<ProtocolReadyData>
  close(): void
  system: ProtocolNamespace
  identity: ProtocolNamespace
  feed: ProtocolNamespace
  channel: ProtocolNamespace
  video: ProtocolNamespace
  watch: ProtocolNamespace
  transfer: ProtocolNamespace
  search: ProtocolNamespace
  shell: ProtocolNamespace
}
