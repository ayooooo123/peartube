/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
import { createHostError, HOST_ERROR_CODES, PROTOCOL_VERSION } from '@peartube/host'
import DefaultHRPC from '@peartube/spec'

import { PROTOCOL_EVENT_BINDINGS, PROTOCOL_EVENTS } from './event-map.js'

function resolveDebugLogPath() {
  return globalThis?.process?.env?.PEARTUBE_NATIVE_WORKLET_DEBUG_LOG || null
}

async function appendDebugLine(line) {
  const filePath = resolveDebugLogPath()
  if (!filePath) return

  try {
    const fsModule = await import('bare-fs')
    const fs = fsModule?.default ?? fsModule
    if (typeof fs?.appendFileSync !== 'function') return
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const NAMESPACE_METHODS = Object.freeze({
  identity: {
    createIdentity: 'createIdentity',
    getIdentity: 'getIdentity',
    getIdentities: 'getIdentities',
    setActiveIdentity: 'setActiveIdentity',
    recoverIdentity: 'recoverIdentity',
    createDeviceInvite: 'createDeviceInvite',
    pairDevice: 'pairDevice',
    listDevices: 'listDevices',
    bootstrapDevice: 'bootstrapDevice',
    attestDevice: 'attestDevice',
    verifyAttestation: 'verifyAttestation'
  },
  feed: {
    getCanonicalFeed: 'getCanonicalFeed',
    getPublicFeed: 'getPublicFeed',
    refreshFeed: 'refreshFeed',
    submitToFeed: 'submitToFeed',
    unpublishFromFeed: 'unpublishFromFeed',
    isChannelPublished: 'isChannelPublished',
    subscribeChannel: 'subscribeChannel',
    unsubscribeChannel: 'unsubscribeChannel',
    getSubscriptions: 'getSubscriptions',
    joinChannel: 'joinChannel',
    hideChannel: 'hideChannel',
    pinChannel: 'pinChannel',
    unpinChannel: 'unpinChannel',
    getPinnedChannels: 'getPinnedChannels'
  },
  channel: {
    getChannel: 'getChannel',
    getChannelMeta: 'getChannelMeta',
    updateChannel: 'updateChannel',
    updateChannelAvatar: 'updateChannelAvatar'
  },
  video: {
    listVideos: 'listVideos',
    getVideoUrl: 'getVideoUrl',
    getVideoData: 'getVideoData',
    getVideoMetadata: 'getVideoMetadata',
    getVideoThumbnail: 'getVideoThumbnail',
    getVideoStats: 'getVideoStats',
    prefetchVideo: 'prefetchVideo',
    deleteVideo: 'deleteVideo',
    updateVideoMetadata: 'updateVideoMetadata',
    setVideoThumbnail: 'setVideoThumbnail',
    setVideoThumbnailFromFile: 'setVideoThumbnailFromFile',
    addComment: 'addComment',
    listComments: 'listComments',
    hideComment: 'hideComment',
    removeComment: 'removeComment',
    addReaction: 'addReaction',
    removeReaction: 'removeReaction',
    getReactions: 'getReactions'
  },
  watch: {
    logWatchEvent: 'logWatchEvent',
    getRecommendations: 'getRecommendations',
    getVideoRecommendations: 'getVideoRecommendations'
  },
  transfer: {
    uploadVideo: 'uploadVideo',
    downloadVideo: 'downloadVideo',
    getSeedingStatus: 'getSeedingStatus',
    setSeedingConfig: 'setSeedingConfig',
    getStorageStats: 'getStorageStats',
    setStorageLimit: 'setStorageLimit',
    clearCache: 'clearCache'
  },
  search: {
    searchVideos: 'searchVideos',
    globalSearchVideos: 'globalSearchVideos',
    indexVideoVectors: 'indexVideoVectors'
  },
  shell: {
    pickVideoFile: 'pickVideoFile',
    pickImageFile: 'pickImageFile',
    getTranscodeSettings: 'getTranscodeSettings',
    setTranscodeSettings: 'setTranscodeSettings',
    mpvAvailable: 'mpvAvailable',
    mpvCreate: 'mpvCreate',
    mpvLoadFile: 'mpvLoadFile',
    mpvPlay: 'mpvPlay',
    mpvPause: 'mpvPause',
    mpvSeek: 'mpvSeek',
    mpvGetState: 'mpvGetState',
    mpvRenderFrame: 'mpvRenderFrame',
    mpvDestroy: 'mpvDestroy',
    castAvailable: 'castAvailable',
    castStartDiscovery: 'castStartDiscovery',
    castStopDiscovery: 'castStopDiscovery',
    castGetDevices: 'castGetDevices',
    castAddManualDevice: 'castAddManualDevice',
    castConnect: 'castConnect',
    castDisconnect: 'castDisconnect',
    castPlay: 'castPlay',
    castPause: 'castPause',
    castResume: 'castResume',
    castStop: 'castStop',
    castSeek: 'castSeek',
    castSetVolume: 'castSetVolume',
    castGetState: 'castGetState',
    castIsConnected: 'castIsConnected'
  }
})

function createEmitter() {
  const listeners = new Map()

  return {
    emit(event, value) {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const listener of eventListeners) listener(value)
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event)?.delete(listener)
    }
  }
}

function normalizeReadyPayload(payload = {}) {
  const status = payload?.status ?? payload

  return {
    blobServerPort: status?.blobServerPort ?? null,
    blobServerReady: Boolean(status?.blobServerReady),
    blobServerError: status?.blobServerError ?? null,
    protocolVersion: status?.protocolVersion ?? PROTOCOL_VERSION
  }
}

function normalizeProtocolError(error, fallbackCode = HOST_ERROR_CODES.HOST_START_FAILED) {
  if (error instanceof Error && error.code) return error

  const message = error instanceof Error ? error.message : String(error)
  return createHostError(fallbackCode, message, { cause: error })
}

function normalizeHostErrorPayload(payload) {
  if (payload instanceof Error && payload.code) return payload

  return createHostError(
    payload?.code ?? HOST_ERROR_CODES.HOST_START_FAILED,
    payload?.message ?? 'Unknown host error',
    { retryable: Boolean(payload?.retryable) }
  )
}

function parseOptionalJson(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeNetworkStatusPayload(payload = {}) {
  const swarmConnections = payload?.swarmConnections ?? payload?.peerCount ?? 0
  const peerCount = payload?.peerCount ?? swarmConnections
  const network = payload?.network ?? parseOptionalJson(payload?.networkJson)
  const startupTiming = payload?.startupTiming ?? parseOptionalJson(payload?.startupTimingJson)
  const doctor = payload?.doctor ?? parseOptionalJson(payload?.doctorJson)
  const directPeerDial = payload?.directPeerDial ?? parseOptionalJson(payload?.directPeerDialJson) ?? doctor?.feed?.directPeerDial ?? null

  return {
    connected: Boolean(payload?.connected ?? (swarmConnections > 0 || peerCount > 0)),
    peerCount,
    swarmConnections,
    swarmPeers: payload?.swarmPeers ?? 0,
    feedConnections: payload?.feedConnections ?? 0,
    feedEntries: payload?.feedEntries ?? 0,
    channelsLoaded: payload?.channelsLoaded ?? 0,
    swarmOffline: Boolean(payload?.swarmOffline),
    swarmOfflineReason: payload?.swarmOfflineReason ?? null,
    swarmListenResolved: Boolean(payload?.swarmListenResolved),
    peerPoolJoined: Boolean(payload?.peerPoolJoined),
    publicFeedDiscoveryJoined: Boolean(payload?.publicFeedDiscoveryJoined),
    feedTopicHex: payload?.feedTopicHex ?? null,
    recommendedBoundary: payload?.recommendedBoundary ?? doctor?.recommendedBoundary ?? null,
    network,
    startupTiming,
    doctor,
    directPeerDial
  }
}

function createTransportClosedError(reason) {
  const suffix = reason ? `: ${reason}` : ''
  return createHostError(
    HOST_ERROR_CODES.TRANSPORT_DISCONNECTED,
    `Transport closed before host became ready${suffix}`,
    { retryable: true }
  )
}

function createMethodCaller(rpc, ready, methodName) {
  return async (request = {}) => {
    await ready()

    const method = rpc?.[methodName]
    if (typeof method !== 'function') {
      throw createHostError(
        HOST_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Missing HRPC method: ${methodName}`
      )
    }

    try {
      return await method.call(rpc, request)
    } catch (error) {
      throw normalizeProtocolError(error)
    }
  }
}

function createNetworkStatusCaller(rpc, ready) {
  return async (request = {}) => {
    const response = await createMethodCaller(rpc, ready, 'getSwarmStatus')(request)
    const status = normalizeNetworkStatusPayload(response)
    return status
  }
}

function createNamespace(rpc, ready, definitions) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, methodName]) => [name, createMethodCaller(rpc, ready, methodName)])
  )
}

function bindTransport(stream, events, emitHostError) {
  if (!stream || typeof stream.on !== 'function') return

  let closed = false
  const emitClosed = (reason) => {
    if (closed) return
    closed = true
    events.emit(PROTOCOL_EVENTS.TRANSPORT_CLOSED, reason ? { reason } : {})
  }

  stream.on('end', () => emitClosed('end'))
  stream.on('close', () => emitClosed('close'))
  stream.on('error', (error) => {
    emitHostError(
      createHostError(
        HOST_ERROR_CODES.TRANSPORT_DISCONNECTED,
        error?.message ?? 'Transport disconnected',
        { cause: error, retryable: true }
      )
    )
    emitClosed('error')
  })
}

function loadDefaultHRPC() {
  return DefaultHRPC?.default ?? DefaultHRPC
}

export function createProtocolClient({ stream, HRPCImpl } = {}) {
  if (!stream || typeof stream !== 'object') {
    throw new Error('createProtocolClient requires a stream transport')
  }

  const events = createEmitter()
  const rpc = new (HRPCImpl ?? loadDefaultHRPC())(stream)
  void appendDebugLine('[createProtocolClient] HRPC client constructed')

  let lastReady = null
  const emitHostReady = (payload) => {
    const normalized = normalizeReadyPayload(payload)
    if (
      lastReady &&
      lastReady.blobServerPort === normalized.blobServerPort &&
      lastReady.blobServerReady === normalized.blobServerReady &&
      lastReady.blobServerError === normalized.blobServerError &&
      lastReady.protocolVersion === normalized.protocolVersion
    ) {
      return normalized
    }

    lastReady = normalized
    events.emit(PROTOCOL_EVENTS.HOST_READY, normalized)
    return normalized
  }

  const emitHostError = (error) => {
    const normalized = normalizeProtocolError(error)
    events.emit(PROTOCOL_EVENTS.HOST_ERROR, {
      code: normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED,
      message: normalized.message,
      retryable: Boolean(normalized.retryable)
    })
    return normalized
  }

  for (const [handlerName, eventName] of PROTOCOL_EVENT_BINDINGS) {
    const register = rpc?.[handlerName]
    if (typeof register !== 'function') continue

    register.call(rpc, (payload) => {
      if (eventName === PROTOCOL_EVENTS.HOST_READY) {
        emitHostReady(payload)
        return
      }

      if (eventName === PROTOCOL_EVENTS.HOST_ERROR) {
        emitHostError(normalizeHostErrorPayload(payload))
        return
      }

      events.emit(eventName, payload)
    })
  }

  bindTransport(stream, events, emitHostError)

  let readyPromise = null
  const ready = async () => {
    if (lastReady) return lastReady

    if (!readyPromise) {
      void appendDebugLine('[createProtocolClient] ready() creating readyPromise')
      readyPromise = new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          offReady?.()
          offError?.()
          offClosed?.()
        }
        const settleResolve = (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        }
        const settleReject = (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }

        const offReady = events.on(PROTOCOL_EVENTS.HOST_READY, (payload) => {
          settleResolve(normalizeReadyPayload(payload))
        })
        const offError = events.on(PROTOCOL_EVENTS.HOST_ERROR, (payload) => {
          settleReject(normalizeHostErrorPayload(payload))
        })
        const offClosed = events.on(PROTOCOL_EVENTS.TRANSPORT_CLOSED, (payload) => {
          settleReject(createTransportClosedError(payload?.reason))
        })

        ;(async () => {
          try {
            await appendDebugLine('[createProtocolClient] getStatus request start')
            const statusResponse = await rpc.getStatus({})
            await appendDebugLine('[createProtocolClient] getStatus response received')
            const status = normalizeReadyPayload(statusResponse)

            if (status.protocolVersion !== PROTOCOL_VERSION) {
              throw createHostError(
                HOST_ERROR_CODES.PROTOCOL_VERSION_MISMATCH,
                HOST_ERROR_CODES.PROTOCOL_VERSION_MISMATCH
              )
            }

            settleResolve(emitHostReady(status))
          } catch (error) {
            await appendDebugLine(
              `[createProtocolClient] getStatus failed ${error?.code || 'ERR'} ${error?.message || String(error)}, waiting for eventReady`
            )
            // Don't reject on getStatus failure — the backend may still be
            // initializing. Let the eventReady / eventError listeners settle
            // the promise instead. Only reject immediately for version mismatch.
            if (error?.code === HOST_ERROR_CODES.PROTOCOL_VERSION_MISMATCH) {
              settleReject(emitHostError(error))
            }
          }
        })()
      })
    }

    return readyPromise
  }

  const getNetworkStatus = async (request = {}) => {
    const status = await createNetworkStatusCaller(rpc, ready)(request)
    events.emit(PROTOCOL_EVENTS.NETWORK_STATUS, status)
    return status
  }

  return {
    stream,
    rpc,
    events,
    ready,
    close() {
      stream?.destroy?.()
    },
    system: {
      getStatus: createMethodCaller(rpc, ready, 'getStatus'),
      getSwarmStatus: getNetworkStatus,
      getBlobServerPort: createMethodCaller(rpc, ready, 'getBlobServerPort')
    },
    identity: createNamespace(rpc, ready, NAMESPACE_METHODS.identity),
    feed: createNamespace(rpc, ready, NAMESPACE_METHODS.feed),
    channel: createNamespace(rpc, ready, NAMESPACE_METHODS.channel),
    video: createNamespace(rpc, ready, NAMESPACE_METHODS.video),
    watch: createNamespace(rpc, ready, NAMESPACE_METHODS.watch),
    transfer: createNamespace(rpc, ready, NAMESPACE_METHODS.transfer),
    search: createNamespace(rpc, ready, NAMESPACE_METHODS.search),
    shell: createNamespace(rpc, ready, NAMESPACE_METHODS.shell)
  }
}
