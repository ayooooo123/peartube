import { createProtocolClient, PROTOCOL_EVENTS } from '@peartube/protocol'

export type HostReadyData = {
  blobServerPort: number | null
  protocolVersion: 1
}

export type HostErrorData = {
  code: string
  message: string
  retryable: boolean
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
    waitUntilReady(): Promise<{ blobServerPort: number | null; protocolVersion: 1 }>
    terminate(): Promise<void>
    onLifecycle(cb: (event:
      | { type: 'host.ready', data: { blobServerPort: number | null; protocolVersion: 1 } }
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
  waitUntilReady(): Promise<HostReadyData>
  terminate(): Promise<void>
  onLifecycle(cb: (event: PlatformLifecycleEvent) => void): () => void
}

type ReadyCallback = (data: HostReadyData) => void
type ErrorCallback = (data: { message: string; code?: string; retryable?: boolean }) => void
type VideoStatsCallback = (data: any) => void
type UploadProgressCallback = (data: any) => void
type DownloadProgressCallback = (data: any) => void
type FeedUpdateCallback = (data: any) => void
type CastDeviceFoundCallback = (data: any) => void
type CastDeviceLostCallback = (data: any) => void
type CastPlaybackStateCallback = (data: any) => void
type CastTimeUpdateCallback = (data: any) => void

type PlatformCallbacks = {
  ready: ReadyCallback[]
  error: ErrorCallback[]
  videoStats: VideoStatsCallback[]
  uploadProgress: UploadProgressCallback[]
  downloadProgress: DownloadProgressCallback[]
  feedUpdate: FeedUpdateCallback[]
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
  createProtocolClientImpl?: typeof createProtocolClient
}

function removeCallback<T>(callbacks: T[], callback: T) {
  const index = callbacks.indexOf(callback)
  if (index !== -1) callbacks.splice(index, 1)
}

function createCallbackStore(): PlatformCallbacks {
  return {
    ready: [],
    error: [],
    videoStats: [],
    uploadProgress: [],
    downloadProgress: [],
    feedUpdate: [],
    castDeviceFound: [],
    castDeviceLost: [],
    castPlaybackState: [],
    castTimeUpdate: []
  }
}

function safeDispatch<T>(callbacks: T[], value: Parameters<Extract<T, (...args: any[]) => unknown>>[0]) {
  for (const callback of callbacks) {
    try {
      ;(callback as (data: typeof value) => void)(value)
    } catch (error) {
      console.error('[Platform RPC] Event callback failed:', error)
    }
  }
}

export function createPlatformRpcBridge(options: PlatformRpcBridgeOptions) {
  const callbacks = createCallbackStore()
  const createClient = options.createProtocolClientImpl ?? createProtocolClient

  let session: PlatformRunnerSession | null = null
  let client: ReturnType<typeof createProtocolClient> | null = null
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

  const bindClientEvents = (nextClient: ReturnType<typeof createProtocolClient>) => {
    protocolUnsubscribes = [
      nextClient.events.on(PROTOCOL_EVENTS.UPLOAD_PROGRESS, (data: any) => safeDispatch(callbacks.uploadProgress, data)),
      nextClient.events.on(PROTOCOL_EVENTS.DOWNLOAD_PROGRESS, (data: any) => safeDispatch(callbacks.downloadProgress, data)),
      nextClient.events.on(PROTOCOL_EVENTS.FEED_UPDATED, (data: any) => safeDispatch(callbacks.feedUpdate, data)),
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
        return () => removeCallback(callbacks.ready, callback)
      },
      onError(callback: ErrorCallback) {
        callbacks.error.push(callback)
        return () => removeCallback(callbacks.error, callback)
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
      onFeedUpdate(callback: FeedUpdateCallback) {
        callbacks.feedUpdate.push(callback)
        return () => removeCallback(callbacks.feedUpdate, callback)
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

        const nextClient = createClient({ stream: nextSession.stream })

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
        dispatchError({
          message: error instanceof Error ? error.message : String(error)
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
