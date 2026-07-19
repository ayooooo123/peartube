import type { PROTOCOL_VERSION } from '@peartube/host'
import { PROTOCOL_EVENTS } from '@peartube/host/events'

export type HostProtocolVersion = typeof PROTOCOL_VERSION

export type ContentArtwork = {
  role: string
  blobId: string | null
  blobsCoreKey: string | null
  mimeType: string | null
  remoteUrl: string | null
}

export type ChannelSource = {
  provider: string
  identityKey: string
  sourceId: string | null
  identityUrl: string | null
  handle: string | null
  displayName: string | null
}

export type ChannelCatalogProfile = {
  channelKey: string
  name: string
  description: string | null
  profileKind: string | null
  mediaProvider: string | null
  mediaId: string | null
  originalLanguage: string | null
  releaseDate: number
  releaseYear: number
  createdAt: number
  updatedAt: number
  sources: ChannelSource[] | null
  artwork: ContentArtwork[] | null
}

export type ChannelCatalogGroupSummary = {
  id: string
  kind: string
  title: string
  itemCount: number
  seasonNumber: number
}

export type ChannelCatalogItem = {
  id: string
  title: string
  description: string | null
  contentKind: string | null
  channelKey: string
  publicBeeKey: string | null
  sourceProvider: string | null
  sourceVideoId: string | null
  identityUrl: string | null
  sourceCreatorId: string | null
  sourceCreatorUrl: string | null
  sourcePublishedAt: number
  mediaProvider: string | null
  mediaId: string | null
  seasonNumber: number
  episodeNumber: number
  originalAirDate: number
  duration: number
  blobId: string | null
  blobsCoreKey: string | null
  mimeType: string | null
  thumbnailUrl: string | null
  thumbnailBlobId: string | null
  thumbnailBlobsCoreKey: string | null
  thumbnailMimeType: string | null
  provenanceVersion: string | null
  contentFingerprint: string | null
  publicationState: string | null
}

export type ContentCatalogRequest = {
  channelKey: string
  publicBeeKey?: string
}

export type ContentCatalogResponse = {
  success: boolean
  errorCode: string | null
  error: string | null
  profile: ChannelCatalogProfile | null
  groups: ChannelCatalogGroupSummary[] | null
}

export type ContentItemsRequest = {
  channelKey: string
  publicBeeKey?: string
  groupId: string
  cursor?: string
  limit?: number
}

type ContentItemsProtocolRequest = ContentItemsRequest & {
  limitProvided?: boolean
}

export type ChannelCatalogPage = {
  group: ChannelCatalogGroupSummary | null
  items: ChannelCatalogItem[] | null
  nextCursor: string | null
}

export type ContentItemsResponse = ChannelCatalogPage & {
  success: boolean
  errorCode: string | null
  error: string | null
}

type BlobServerStatus = {
  blobServerPort: number | null
  blobServerReady?: boolean
  blobServerError?: string | null
}

export type HostReadyData = BlobServerStatus & {
  protocolVersion: HostProtocolVersion
}

export type HostErrorData = {
  code: string
  message: string
  retryable: boolean
}

export type NetworkStatusData = {
  connected?: boolean
  peerCount?: number
  swarmConnections?: number
  swarmPeers?: number
  feedConnections?: number
  feedEntries?: number
  channelsLoaded?: number
  swarmOffline?: boolean
  swarmOfflineReason?: string | null
  swarmListenResolved?: boolean
  peerPoolJoined?: boolean
  publicFeedDiscoveryJoined?: boolean
  feedTopicHex?: string | null
  recommendedBoundary?: string | null
  network?: any
  startupTiming?: any
  doctor?: any
  directPeerDial?: any
}

export type PlatformLifecycleEvent =
  | { type: 'host.ready'; data: HostReadyData }
  | ({ type: 'host.error' } & HostErrorData)
  | { type: 'transport.closed'; reason?: string }

/**
type PlatformRunner = {
  start(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): Promise<{
    stream: any
    waitUntilReady(): Promise<{ blobServerPort: number | null; protocolVersion: HostProtocolVersion }>
    terminate(): Promise<void>
    onLifecycle(cb: (event:
      | { type: 'host.ready', data: { blobServerPort: number | null; protocolVersion: HostProtocolVersion } }
      | { type: 'host.error', code: string, message: string, retryable: boolean }
      | { type: 'transport.closed', reason?: string }
    ) => void): () => void
  }>
}
 */
export type PlatformRunner = {
  start(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): Promise<PlatformRunnerSession>
}

export type PlatformRunnerSession = {
  stream: any
  client?: ProtocolClientLike
  waitUntilReady(): Promise<HostReadyData>
  terminate(): Promise<void>
  onLifecycle(cb: (event: PlatformLifecycleEvent) => void): () => void
}
type ChannelCatalogMethods = {
  getContentCatalog(request: ContentCatalogRequest): Promise<ContentCatalogResponse>
  getContentItems(request: ContentItemsProtocolRequest): Promise<ContentItemsResponse>
}

type ChannelCatalogProtocolClient = {
  ready(): Promise<HostReadyData>
  channel: Partial<ChannelCatalogMethods> & Record<string, (request?: unknown) => Promise<unknown>>
}

export type ProtocolClientLike = ChannelCatalogProtocolClient & {
  rpc: any
  events: {
    on(event: string, listener: (payload: any) => void): () => void
  }
  system?: {
    getSwarmStatus?(request?: any): Promise<NetworkStatusData>
  }
}

type ReadyCallback = (data: HostReadyData) => void
type ErrorCallback = (data: { message: string; code?: string; retryable?: boolean }) => void
type VideoStatsCallback = (data: any) => void
type UploadProgressCallback = (data: any) => void
type DownloadProgressCallback = (data: any) => void
type TranscodeProgressCallback = (data: any) => void
type FeedUpdateCallback = (data: any) => void
type NetworkStatusCallback = (data: NetworkStatusData) => void
type CastDeviceFoundCallback = (data: any) => void
type CastDeviceLostCallback = (data: any) => void
type CastPlaybackStateCallback = (data: any) => void
type CastTimeUpdateCallback = (data: any) => void
type LogCallback = (data: { level?: string; message: string; timestamp?: number }) => void

type PlatformCallbacks = {
  ready: ReadyCallback[]
  error: ErrorCallback[]
  log: LogCallback[]
  videoStats: VideoStatsCallback[]
  uploadProgress: UploadProgressCallback[]
  downloadProgress: DownloadProgressCallback[]
  transcodeProgress: TranscodeProgressCallback[]
  feedUpdate: FeedUpdateCallback[]
  networkStatus: NetworkStatusCallback[]
  castDeviceFound: CastDeviceFoundCallback[]
  castDeviceLost: CastDeviceLostCallback[]
  castPlaybackState: CastPlaybackStateCallback[]
  castTimeUpdate: CastTimeUpdateCallback[]
}

type PlatformRpcBridgeOptions = {
  platform: 'mobile' | 'desktop'
  runner: PlatformRunner
  entrypoint: string
  getStoragePath(): string
  getArgs?(): string[]
  createProtocolClientImpl?: (options: { stream: any }) => ProtocolClientLike
}

function removeCallback<T>(callbacks: T[], callback: T) {
  const index = callbacks.indexOf(callback)
  if (index !== -1) callbacks.splice(index, 1)
}

function createCallbackStore(): PlatformCallbacks {
  return {
    ready: [],
    error: [],
    log: [],
    videoStats: [],
    uploadProgress: [],
    downloadProgress: [],
    feedUpdate: [],
    transcodeProgress: [],
    networkStatus: [],
    castDeviceFound: [],
    castDeviceLost: [],
    castPlaybackState: [],
    castTimeUpdate: []
  }
}

function safeDispatch<T>(callbacks: T[], value: Parameters<Extract<T, (...args: any[]) => unknown>>[0]) {
  for (const callback of callbacks) {
    try {
      const typedCallback = callback as (data: typeof value) => void
      typedCallback(value)
    } catch (error) {
      console.error('[Platform RPC] Event callback failed:', error)
    }
  }
}

export function createPlatformRpcBridge(options: PlatformRpcBridgeOptions) {
  const callbacks = createCallbackStore()
  const createClient = options.createProtocolClientImpl

  let session: PlatformRunnerSession | null = null
  let client: ProtocolClientLike | null = null
  let initPromise: Promise<void> | null = null
  let blobServerPort: number | null = null
  let initialized = false
  let lifecycleUnsubscribe: (() => void) | null = null
  let protocolUnsubscribes: Array<() => void> = []
  let lastReady: HostReadyData | null = null

  const dispatchReady = (data: HostReadyData) => {
    if (
      lastReady &&
      lastReady.blobServerPort === data.blobServerPort &&
      lastReady.blobServerReady === data.blobServerReady &&
      lastReady.blobServerError === data.blobServerError &&
      lastReady.protocolVersion === data.protocolVersion
    ) {
      return
    }

    lastReady = data
    blobServerPort = data.blobServerPort
    safeDispatch(callbacks.ready, data)
  }

  const dispatchError = (data: { message: string; code?: string; retryable?: boolean }) => {
    safeDispatch(callbacks.error, data)
  }

  const teardownSubscriptions = () => {
    lifecycleUnsubscribe?.()
    lifecycleUnsubscribe = null

    for (const unsubscribe of protocolUnsubscribes) unsubscribe()
    protocolUnsubscribes = []
  }

  const bindClientEvents = (nextClient: ProtocolClientLike) => {
    protocolUnsubscribes = [
      nextClient.events.on(PROTOCOL_EVENTS.UPLOAD_PROGRESS, (data: any) => safeDispatch(callbacks.uploadProgress, data)),
      nextClient.events.on(PROTOCOL_EVENTS.LOG, (data: any) => safeDispatch(callbacks.log, data)),
      nextClient.events.on(PROTOCOL_EVENTS.DOWNLOAD_PROGRESS, (data: any) => safeDispatch(callbacks.downloadProgress, data)),
      nextClient.events.on(PROTOCOL_EVENTS.FEED_UPDATED, (data: any) => safeDispatch(callbacks.feedUpdate, data)),
      nextClient.events.on(PROTOCOL_EVENTS.TRANSCODE_PROGRESS, (data: any) => safeDispatch(callbacks.transcodeProgress, data)),
      nextClient.events.on(PROTOCOL_EVENTS.NETWORK_STATUS, (data: any) => safeDispatch(callbacks.networkStatus, data)),
      nextClient.events.on(PROTOCOL_EVENTS.VIDEO_STATS, (data: any) => safeDispatch(callbacks.videoStats, data)),
      nextClient.events.on(PROTOCOL_EVENTS.CAST_DEVICE_FOUND, (data: any) => safeDispatch(callbacks.castDeviceFound, data)),
      nextClient.events.on(PROTOCOL_EVENTS.CAST_DEVICE_LOST, (data: any) => safeDispatch(callbacks.castDeviceLost, data)),
      nextClient.events.on(PROTOCOL_EVENTS.CAST_PLAYBACK_STATE, (data: any) => safeDispatch(callbacks.castPlaybackState, data)),
      nextClient.events.on(PROTOCOL_EVENTS.CAST_TIME_UPDATE, (data: any) => safeDispatch(callbacks.castTimeUpdate, data))
    ]
  }

  const handleLifecycle = (event: PlatformLifecycleEvent) => {
    if (event.type === 'host.ready') {
      dispatchReady(event.data)
      return
    }

    if (event.type === 'host.error') {
      dispatchError({
        code: event.code,
        message: event.message,
        retryable: event.retryable
      })
      return
    }

    dispatchError({
      code: 'TRANSPORT_CLOSED',
      message: event.reason ? `Transport closed: ${event.reason}` : 'Transport closed'
    })
  }

  return {
    events: {
      onReady(callback: ReadyCallback) {
        callbacks.ready.push(callback)
        if (lastReady) {
          try {
            callback(lastReady)
          } catch (error) {
            console.error('[Platform RPC] ready callback failed:', error)
          }
        }
        return () => removeCallback(callbacks.ready, callback)
      },
      onError(callback: ErrorCallback) {
        callbacks.error.push(callback)
        return () => removeCallback(callbacks.error, callback)
      },
      onLog(callback: LogCallback) {
        callbacks.log.push(callback)
        return () => removeCallback(callbacks.log, callback)
      },
      onVideoStats(callback: VideoStatsCallback) {
        callbacks.videoStats.push(callback)
        return () => removeCallback(callbacks.videoStats, callback)
      },
      onUploadProgress(callback: UploadProgressCallback) {
        callbacks.uploadProgress.push(callback)
        return () => removeCallback(callbacks.uploadProgress, callback)
      },
      onDownloadProgress(callback: DownloadProgressCallback) {
        callbacks.downloadProgress.push(callback)
        return () => removeCallback(callbacks.downloadProgress, callback)
      },
      onTranscodeProgress(callback: TranscodeProgressCallback) {
        callbacks.transcodeProgress.push(callback)
        return () => removeCallback(callbacks.transcodeProgress, callback)
      },
      onFeedUpdate(callback: FeedUpdateCallback) {
        callbacks.feedUpdate.push(callback)
        return () => removeCallback(callbacks.feedUpdate, callback)
      },
      onNetworkStatus(callback: NetworkStatusCallback) {
        callbacks.networkStatus.push(callback)
        return () => removeCallback(callbacks.networkStatus, callback)
      },
      onCastDeviceFound(callback: CastDeviceFoundCallback) {
        callbacks.castDeviceFound.push(callback)
        return () => removeCallback(callbacks.castDeviceFound, callback)
      },
      onCastDeviceLost(callback: CastDeviceLostCallback) {
        callbacks.castDeviceLost.push(callback)
        return () => removeCallback(callbacks.castDeviceLost, callback)
      },
      onCastPlaybackState(callback: CastPlaybackStateCallback) {
        callbacks.castPlaybackState.push(callback)
        return () => removeCallback(callbacks.castPlaybackState, callback)
      },
      onCastTimeUpdate(callback: CastTimeUpdateCallback) {
        callbacks.castTimeUpdate.push(callback)
        return () => removeCallback(callbacks.castTimeUpdate, callback)
      }
    },

    async init() {
      if (initialized) return
      if (initPromise) return initPromise

      initPromise = (async () => {
        const nextSession = await options.runner.start({
          platform: options.platform,
          storagePath: options.getStoragePath(),
          entrypoint: options.entrypoint,
          args: options.getArgs?.() ?? []
        })

        const nextClient = nextSession.client ?? createClient?.({ stream: nextSession.stream })

        if (!nextClient) {
          throw new Error('Platform runner did not provide a protocol client')
        }

        session = nextSession
        client = nextClient

        teardownSubscriptions()
        lifecycleUnsubscribe = nextSession.onLifecycle(handleLifecycle)
        bindClientEvents(nextClient)

        const readyData = await nextSession.waitUntilReady()
        dispatchReady(readyData)
        initialized = true
      })()

      try {
        await initPromise
      } catch (error) {
        const activeSession = session
        teardownSubscriptions()
        session = null
        client = null
        initialized = false
        blobServerPort = null
        lastReady = null
        await activeSession?.terminate?.().catch(() => {})
        dispatchError({
          code: (error as any)?.code,
          message: error instanceof Error ? error.message : String(error),
          retryable: Boolean((error as any)?.retryable)
        })
        throw error
      } finally {
        initPromise = null
      }
    },

    async terminate() {
      teardownSubscriptions()
      initialized = false
      blobServerPort = null
      lastReady = null

      const activeSession = session
      session = null
      client = null

      await activeSession?.terminate()
    },

    isInitialized() {
      return initialized
    },

    getBlobServerPort() {
      return blobServerPort
    },

    getClient() {
      return client
    },

    getRpc() {
      return client?.rpc ?? null
    }
  }
}

export function createChannelCatalogRpc(ensureClient: () => ChannelCatalogProtocolClient) {
  return {
    async getContentCatalog(request: ContentCatalogRequest): Promise<ContentCatalogResponse> {
      const client = ensureClient()
      await client.ready()
      const channel = client.channel
      if (!channel.getContentCatalog) throw new Error('Host protocol client does not expose channel.getContentCatalog')
      return channel.getContentCatalog(request)
    },
    async getContentItems(request: ContentItemsRequest): Promise<ContentItemsResponse> {
      const client = ensureClient()
      await client.ready()
      const channel = client.channel
      if (!channel.getContentItems) throw new Error('Host protocol client does not expose channel.getContentItems')
      const protocolRequest: ContentItemsProtocolRequest = Object.hasOwn(request, 'limit')
        ? { ...request, limitProvided: true }
        : request
      return channel.getContentItems(protocolRequest)
    }
  }
}

/**
 * Personal-sync RPC methods (playlists / watch history / settings / at-rest
 * encryption provisioning). Shared by the native and web flat `rpc` clients so
 * the surface stays identical across platforms. Pass each platform's local
 * `ensureRPC` accessor.
 */
export function createPersonalRpc(ensureRPC: () => any) {
  return {
    // Playlists
    async getPlaylists() {
      return ensureRPC().getPlaylists({});
    },
    async getPlaylistItems(playlistIdOrReq: string | { playlistId: string }) {
      const req = typeof playlistIdOrReq === 'string' ? { playlistId: playlistIdOrReq } : playlistIdOrReq;
      return ensureRPC().getPlaylistItems(req);
    },
    async createPlaylist(req: { name?: string; description?: string } = {}) {
      return ensureRPC().createPlaylist(req);
    },
    async updatePlaylist(req: { id: string; name?: string; description?: string }) {
      return ensureRPC().updatePlaylist(req);
    },
    async deletePlaylist(idOrReq: string | { id: string }) {
      const req = typeof idOrReq === 'string' ? { id: idOrReq } : idOrReq;
      return ensureRPC().deletePlaylist(req);
    },
    async addToPlaylist(req: { playlistId: string; channelKey?: string; videoId?: string; videoKey?: string }) {
      return ensureRPC().addToPlaylist(req);
    },
    async removeFromPlaylist(req: { playlistId: string; videoKey: string }) {
      return ensureRPC().removeFromPlaylist(req);
    },

    // Watch history / resume
    async logWatchHistory(req: { channelKey?: string; videoId?: string; videoKey?: string; title?: string; duration?: number; position?: number; completed?: boolean; timestamp?: number }) {
      return ensureRPC().logWatchHistory(req);
    },
    async getWatchHistory(req: { limit?: number } = {}) {
      return ensureRPC().getWatchHistory(req);
    },
    async getResumePosition(videoKeyOrReq: string | { videoKey: string }) {
      const req = typeof videoKeyOrReq === 'string' ? { videoKey: videoKeyOrReq } : videoKeyOrReq;
      return ensureRPC().getResumePosition(req);
    },
    async listResumePositions() {
      return ensureRPC().listResumePositions({});
    },

    // Settings
    async setPersonalSetting(keyOrReq: string | { key: string; value?: string }, value?: string) {
      const req = typeof keyOrReq === 'string' ? { key: keyOrReq, value } : keyOrReq;
      return ensureRPC().setPersonalSetting(req);
    },
    async getPersonalSettings() {
      return ensureRPC().getPersonalSettings({});
    },

    // At-rest encryption provisioning (keychain-backed)
    async provisionPersonalEncryption(req: { secret?: string } = {}) {
      return ensureRPC().provisionPersonalEncryption(req);
    }
  };
}
