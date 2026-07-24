/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
import { createHostError, HOST_ERROR_CODES, PROTOCOL_VERSION } from './contracts.js'
import DefaultHRPC from '@peartube/spec'
import { createGeneratedAppRpcClient } from '@peartube/spec/app-rpc-adapter'

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

function isTransientStartupStatusError(error) {
  const message = error?.message ?? String(error)
  return /backend not ready/i.test(message)
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

function createNetworkStatusCaller(rpc, ready, events) {
  return async (request = {}) => {
    const response = await createMethodCaller(rpc, ready, 'getSwarmStatus')(request)
    const status = normalizeNetworkStatusPayload(response)
    events.emit(PROTOCOL_EVENTS.NETWORK_STATUS, status)
    return status
  }
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
            const failureCode = error?.code || 'ERR'
            const failureMessage = error?.message || String(error)
            await appendDebugLine(
              `[createProtocolClient] getStatus failed ${failureCode} ${failureMessage}, waiting for eventReady`
            )
            if (!isTransientStartupStatusError(error)) {
              console.warn('[createProtocolClient] getStatus handshake failed:', failureCode, failureMessage)
              if (error?.stack) {
                console.warn(error.stack)
              }
            }
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

  const appRpc = createGeneratedAppRpcClient({
    rpc,
    ready,
    createMissingMethodError(methodName) {
      return createHostError(
        HOST_ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Missing HRPC method: ${methodName}`
      )
    },
    normalizeError: normalizeProtocolError
  })

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
      getSwarmStatus: createNetworkStatusCaller(rpc, ready, events),
      getBlobServerPort: createMethodCaller(rpc, ready, 'getBlobServerPort')
    },
    identity: appRpc.identity,
    feed: appRpc.feed,
    channel: appRpc.channel,
    mediaGraph: appRpc.mediaGraph,
    video: appRpc.video,
    watch: appRpc.watch,
    transfer: appRpc.transfer,
    search: appRpc.search,
    shell: appRpc.shell
  }
}
