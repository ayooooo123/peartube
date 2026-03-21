import bareProcess from 'bare-process'
import { startHost } from '../../host/src/start-host.js'
import { createBackend } from '../../backend/src/backend-entry.js'
import { createProtocolClient } from '../../protocol/src/create-client.js'
import { PROTOCOL_EVENTS } from '../../protocol/src/event-map.js'

import { buildBrowseSnapshot, buildSearchResults } from './bridge-core.mjs'
import * as bridgeRPC from './native-rpc.mjs'

globalThis.process = bareProcess

function writeLog(level, args) {
  const rendered = args.map((value) => {
    if (typeof value === 'string') return value

    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }).join(' ')

  try {
    process.stderr?.write?.(`[native-host-sidecar:${level}] ${rendered}\n`)
  } catch {}
}

console.log = (...args) => writeLog('log', args)
console.info = (...args) => writeLog('info', args)
console.warn = (...args) => writeLog('warn', args)
console.error = (...args) => writeLog('error', args)

function formatError(error) {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.stack || error.message

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function createEmitter() {
  const listeners = new Map()

  return {
    add(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
    },
    remove(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    emit(event, value) {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const listener of eventListeners) listener(value)
    }
  }
}

function createLoopbackPair() {
  const endpointA = createEndpoint()
  const endpointB = createEndpoint()
  endpointA.connect(endpointB)
  endpointB.connect(endpointA)
  return [endpointA.transport, endpointB.transport]
}

function createEndpoint() {
  const emitter = createEmitter()
  let peer = null
  let destroyed = false

  const transport = {
    on(event, listener) {
      emitter.add(event, listener)
      return transport
    },
    once(event, listener) {
      const wrapped = (value) => {
        emitter.remove(event, wrapped)
        listener(value)
      }
      emitter.add(event, wrapped)
      return transport
    },
    off(event, listener) {
      emitter.remove(event, listener)
      return transport
    },
    removeListener(event, listener) {
      emitter.remove(event, listener)
      return transport
    },
    write(chunk) {
      if (destroyed || !peer) return false
      const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      queueMicrotask(() => peer?.emit('data', payload))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) transport.write(chunk)
      destroyed = true
      queueMicrotask(() => {
        peer?.emit('end')
        peer?.emit('close')
        emitter.emit('close')
      })
      return transport
    },
    destroy(error) {
      destroyed = true
      queueMicrotask(() => {
        if (error) peer?.emit('error', error)
        peer?.emit('close')
        emitter.emit('close')
      })
      return transport
    }
  }

  return {
    transport,
    connect(other) {
      peer = other
    },
    emit(event, value) {
      emitter.emit(event, value)
    }
  }
}

function withTimeout(task, fallback, timeoutMs = 3000) {
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]).catch(() => fallback)
}

function createBridgeState() {
  return {
    hostSession: null,
    client: null,
    currentStoragePath: null,
  }
}

function defaultStoragePath() {
  return process?.env?.PEARTUBE_NATIVE_STORAGE_PATH || '.peartube-native'
}

function writeStderr(line) {
  try {
    process.stderr?.write?.(`${line}\n`)
  } catch {}
}

function writeBridgeFrame(frame) {
  const output = process.stdout
  if (!output?.write) {
    throw new Error('Native host sidecar stdout is unavailable')
  }

  output.write(frame)
}

function listFromResponse(value, key) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.[key])) return value[key]
  return []
}

function emitBridgeEvent(command, codec, payload, onError) {
  try {
    writeBridgeFrame(
      bridgeRPC.encodeEventFrame({
        command,
        data: bridgeRPC.encodePayload(codec, payload),
      })
    )
  } catch (error) {
    onError?.(`Bridge event write failed: ${formatError(error)}`)
  }
}

async function createNativeSidecarBackend(options = {}) {
  const [
    backendSession,
    mobileHandlersModule,
    thumbnailModule,
    pathModule,
    fsModule,
  ] = await Promise.all([
    createBackend(options),
    import('../../app/backend/mobile-handlers.mjs'),
    import('../../backend/src/thumbnail.js'),
    import('bare-path'),
    import('bare-fs'),
  ])

  const backend = backendSession?.backend
  const rpc = backendSession?.rpc
  const attachMobileHandlers = mobileHandlersModule?.attachMobileHandlers

  if (backend && rpc && typeof attachMobileHandlers === 'function') {
    const path = pathModule?.default ?? pathModule
    const fs = fsModule?.default ?? fsModule
    const generateAndStoreThumbnail = thumbnailModule?.generateAndStoreThumbnail
    const transcoder = {
      startTranscode: async () => ({ success: false, error: 'Transcoding is not wired in the native sidecar yet.' }),
      stopTranscode: () => ({ success: false, error: 'Transcoding is not wired in the native sidecar yet.' }),
      getStatus: () => ({ status: 'unavailable', progress: 0, bytesWritten: 0, error: 'Transcoding is not wired in the native sidecar yet.' }),
    }

    attachMobileHandlers(backend, {
      api: backend.api,
      identityManager: backend.identityManager,
      uploadManager: backend.uploadManager,
      ctx: backend.ctx,
      initializeIdentityFromMnemonic: backend.initializeIdentityFromMnemonic?.bind?.(backend)
        ?? backend.initializeIdentityFromMnemonic,
      rpc,
      fs,
      path,
      generateAndStoreThumbnail,
      transcoder,
      storagePath: options.storagePath,
    })

    console.log('[native-host-sidecar] Attached shared app handler layer')
  }

  return backendSession
}

async function ensureHostBooted(state, storagePath, onError) {
  if (state.hostSession && state.client) {
    return state.client.ready()
  }

  const [hostStream, clientStream] = createLoopbackPair()
  const hostSession = await startHost({
    platform: 'desktop',
    storagePath,
    entrypoint: 'native-sidecar',
    args: [],
    stream: hostStream,
    createBackendImpl: createNativeSidecarBackend,
  })

  const client = createProtocolClient({ stream: clientStream })

  client.events.on(PROTOCOL_EVENTS.LOG, (payload) => {
    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.hostLog,
      bridgeRPC.hostLogEventCodec,
      { message: payload?.message || 'Host log event' },
      onError
    )
  })
  client.events.on(PROTOCOL_EVENTS.HOST_READY, (payload) => {
    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.hostReady,
      bridgeRPC.hostReadyEventCodec,
      { blobServerPort: payload?.blobServerPort ?? null },
      onError
    )
  })
  client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (payload) => {
    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.hostError,
      bridgeRPC.hostErrorEventCodec,
      { message: payload?.message || 'Unknown host error' },
      onError
    )
  })

  state.hostSession = hostSession
  state.client = client
  state.currentStoragePath = storagePath

  return client.ready()
}

async function loadBrowseSnapshot(state) {
  const client = state.client
  if (!client) throw new Error('Host client is not ready')

  const [feedResult, subscriptionsResult, identitiesResult, publishResult] = await Promise.all([
    withTimeout(() => client.feed.getPublicFeed({}), { entries: [] }),
    withTimeout(() => client.feed.getSubscriptions({}), { subscriptions: [] }),
    withTimeout(() => client.identity.getIdentities({}), { identities: [] }),
    withTimeout(() => client.feed.isChannelPublished({}), { published: false }),
  ])

  const fetchChannelData = createChannelDataFetcher(client)
  const identities = listFromResponse(identitiesResult, 'identities')

  return buildBrowseSnapshot({
    feedEntries: listFromResponse(feedResult, 'entries'),
    subscriptions: listFromResponse(subscriptionsResult, 'subscriptions'),
    identities,
    fetchChannelData,
    activeChannelPublished: Boolean(publishResult?.published),
  })
}

function createChannelDataFetcher(client) {
  const channelCache = new Map()

  return async function fetchChannelData(source) {
    const cacheKey = `${source.channelKey}:${source.publicBeeKey || ''}`
    if (channelCache.has(cacheKey)) return channelCache.get(cacheKey)

    const resultPromise = Promise.all([
      withTimeout(() => client.channel.getChannelMeta({
        channelKey: source.channelKey,
        publicBeeKey: source.publicBeeKey || undefined,
      }), {}),
      withTimeout(() => client.video.listVideos({
        channelKey: source.channelKey,
        publicBeeKey: source.publicBeeKey || undefined,
        limit: 6,
        offset: 0,
      }), { videos: [] }),
    ]).then(([channelMeta, videosResult]) => ({
      channelMeta,
      videos: listFromResponse(videosResult, 'videos'),
    }))

    channelCache.set(cacheKey, resultPromise)
    return resultPromise
  }
}

async function shutdownBridge(state) {
  await state.hostSession?.terminate?.()
  state.hostSession = null
  state.client = null
  state.currentStoragePath = null
}

async function mutateAndReload(state, mutate) {
  if (!state.client) throw new Error('Host client is not ready')
  await mutate(state.client)
  return loadBrowseSnapshot(state)
}

async function handleRequest(state, request, onError) {
  const { command, data = null } = request || {}

  if (command === bridgeRPC.BRIDGE_COMMANDS.bootstrap) {
    const params = bridgeRPC.decodePayload(bridgeRPC.bootstrapRequestCodec, data)
    const ready = await ensureHostBooted(
      state,
      params.storagePath || defaultStoragePath(),
      onError
    )
    const snapshot = await loadBrowseSnapshot(state)

    return {
      blobServerPort: ready?.blobServerPort ?? null,
      protocolVersion: ready?.protocolVersion ?? 1,
      storagePath: state.currentStoragePath,
      snapshot,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.refreshBrowse) {
    const snapshot = await loadBrowseSnapshot(state)
    return { snapshot }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.searchVideos) {
    const params = bridgeRPC.decodePayload(bridgeRPC.searchRequestCodec, data)
    const rawResponse = await withTimeout(
      () => state.client?.search.globalSearchVideos({
        query: params.query,
        topK: params.topK,
      }),
      { results: [] },
      5000
    )
    const fetchChannelData = createChannelDataFetcher(state.client)
    const results = await buildSearchResults({
      results: rawResponse?.results || rawResponse || [],
      fetchChannelData,
    })

    return {
      query: params.query,
      results,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.createIdentity) {
    const params = bridgeRPC.decodePayload(bridgeRPC.createIdentityRequestCodec, data)
    return mutateAndReload(state, async (client) => {
      await client.identity.createIdentity({ name: params.name })
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.refreshFeed) {
    return mutateAndReload(state, async (client) => {
      await client.feed.refreshFeed({})
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.publishActiveChannel) {
    return mutateAndReload(state, async (client) => {
      await client.feed.submitToFeed({})
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.subscribeChannel) {
    const params = bridgeRPC.decodePayload(bridgeRPC.subscribeChannelRequestCodec, data)
    return mutateAndReload(state, async (client) => {
      await client.feed.subscribeChannel({ channelKey: params.channelKey })
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.unsubscribeChannel) {
    const params = bridgeRPC.decodePayload(bridgeRPC.subscribeChannelRequestCodec, data)
    return mutateAndReload(state, async (client) => {
      await client.feed.unsubscribeChannel({ channelKey: params.channelKey })
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.uploadVideo) {
    const params = bridgeRPC.decodePayload(bridgeRPC.uploadVideoRequestCodec, data)
    return mutateAndReload(state, async (client) => {
      await client.transfer.uploadVideo({
        filePath: params.filePath,
        title: params.title,
        description: params.description || '',
        category: params.category || '',
      })
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.resolvePlayback) {
    const params = bridgeRPC.decodePayload(bridgeRPC.resolvePlaybackRequestCodec, data)
    const videoRef = params.videoPath || params.videoId

    await withTimeout(
      () => state.client?.video.prefetchVideo({
        channelKey: params.channelKey,
        videoId: videoRef,
        publicBeeKey: params.publicBeeKey || undefined,
      }),
      { success: false },
      3000
    )

    const response = await state.client?.video.getVideoUrl({
      channelKey: params.channelKey,
      videoId: videoRef,
      publicBeeKey: params.publicBeeKey || undefined,
      blobId: params.blobId || undefined,
      blobsCoreKey: params.blobsCoreKey || undefined,
      mimeType: params.mimeType || undefined,
    })

    if (!response?.url) {
      throw new Error(`Playback URL was not resolved for video ${params.videoId}`)
    }

    return {
      videoId: params.videoId,
      url: response.url,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.resolveThumbnail) {
    const params = bridgeRPC.decodePayload(bridgeRPC.resolveThumbnailRequestCodec, data)
    const response = await state.client?.video.getVideoThumbnail({
      channelKey: params.channelKey,
      videoId: params.videoPath || params.videoId,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return {
      videoId: params.videoId,
      url: response?.dataUrl || response?.url || null,
      exists: Boolean(response?.exists && (response?.dataUrl || response?.url)),
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.shutdown) {
    await shutdownBridge(state)
    return { success: true }
  }

  throw new Error(`Unsupported native bridge command: ${command}`)
}

async function main() {
  const state = createBridgeState()
  const parser = bridgeRPC.createRPCFrameParser()

  const reportFatal = (label, error) => {
    const message = `${label}: ${formatError(error)}`

    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.hostError,
      bridgeRPC.hostErrorEventCodec,
      { message }
    )
    writeStderr(`[native-host-sidecar] ${message}`)
  }

  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => {
      reportFatal('Unhandled rejection', reason)
      return true
    })

    Bare.on('uncaughtException', (error) => {
      reportFatal('Uncaught exception', error)
      return true
    })
  }

  process.stdin?.on?.('data', async (chunk) => {
    let messages

    try {
      messages = parser.push(chunk)
    } catch (error) {
      reportFatal('RPC frame parse failed', error)
      return
    }

    for (const message of messages) {
      if (message.kind !== 'request') continue

      try {
        const result = await handleRequest(state, message, reportFatal)
        let payload = null

        if (message.command === bridgeRPC.BRIDGE_COMMANDS.bootstrap) {
          payload = bridgeRPC.encodePayload(bridgeRPC.bootstrapResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.refreshBrowse) {
          payload = bridgeRPC.encodePayload(bridgeRPC.browseSnapshotCodec, result.snapshot)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.searchVideos) {
          payload = bridgeRPC.encodePayload(bridgeRPC.searchResponseCodec, result)
        } else if (
          message.command === bridgeRPC.BRIDGE_COMMANDS.createIdentity ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.refreshFeed ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.publishActiveChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.subscribeChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.unsubscribeChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.uploadVideo
        ) {
          payload = bridgeRPC.encodePayload(bridgeRPC.browseSnapshotCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.resolvePlayback) {
          payload = bridgeRPC.encodePayload(bridgeRPC.resolvePlaybackResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.resolveThumbnail) {
          payload = bridgeRPC.encodePayload(bridgeRPC.resolveThumbnailResponseCodec, result)
        }

        writeBridgeFrame(bridgeRPC.encodeResponseFrame({
          id: message.id,
          data: payload,
        }))
      } catch (error) {
        writeBridgeFrame(bridgeRPC.encodeErrorResponseFrame({
          id: message.id,
          message: error?.message ?? String(error),
          code: 'BRIDGE_REQUEST_FAILED',
          errno: 0,
        }))
      }
    }
  })

  process.stdin?.on?.('end', () => {
    void shutdownBridge(state).finally(() => {
      try {
        Bare.exit(0)
      } catch {}
    })
  })
}

await main()
