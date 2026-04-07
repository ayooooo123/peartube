import bareProcess from 'bare-process'
import * as bridgeRPC from './native-rpc.mjs'
import { startHost } from '../../host/src/start-host.js'
import { createBackend } from '../../backend/src/backend-entry.js'
import { createProtocolClient } from '../../protocol/src/create-client.js'
import { PROTOCOL_EVENTS } from '../../protocol/src/event-map.js'
import {
  buildBrowseSnapshot,
  buildChannelWorkspaceVideos,
  buildIdentityMutationSnapshot,
  buildSearchResults,
  createEmptyBrowseSnapshot,
  mergeVideoMetadata,
} from './bridge-core.mjs'
import { resolvePlaybackViaClient } from './playback-resolution.mjs'
import * as mobileHandlersModule from '../../app/backend/mobile-handlers.mjs'
import * as thumbnailModule from '../../backend/src/thumbnail.js'

const defaultMpvWidth = 1280
const defaultMpvHeight = 720
if (!globalThis.process) {
  globalThis.process = bareProcess
}

const runtimeLabel = globalThis?.process?.env?.PEARTUBE_NATIVE_EMBEDDED_BAREKIT
  ? 'native-host-embedded'
  : 'native-host-sidecar'

let MpvPlayer = null
let mpvLoadError = null
let mpvLoadPromise = null
let bareFFmpeg = null
let ffmpegLoadError = null
let ffmpegLoadPromise = null
const mpvPlayers = new Map()
let mpvPlayerIdCounter = 0
let mpvFrameServer = null
let mpvFrameServerPort = 0
let mpvFrameServerReady = null
let bareHttp1Promise = null
let platformPromise = null

async function loadBareHTTP1() {
  if (bareHttp1Promise) return bareHttp1Promise

  bareHttp1Promise = import('bare-http1')
    .then((module) => module?.default ?? module)
    .catch((error) => {
      bareHttp1Promise = null
      throw error
    })

  return bareHttp1Promise
}

async function currentPlatform() {
  if (platformPromise) return platformPromise

  platformPromise = import('bare-os')
    .then((module) => {
      const bareOS = module?.default ?? module
      return bareOS?.platform?.() || 'unknown'
    })
    .catch((error) => {
      platformPromise = null
      throw error
    })

  return platformPromise
}

async function loadBareMpv() {
  if (MpvPlayer || mpvLoadError) return
  if (mpvLoadPromise) return mpvLoadPromise

  mpvLoadPromise = (async () => {
    try {
      const platform = await currentPlatform()
      const isMpvSupported = platform === 'darwin' || platform === 'linux' || platform === 'win32'
      if (!isMpvSupported) {
        mpvLoadError = `bare-mpv not available on ${platform}`
        return
      }

      if (typeof require === 'function') {
        const required = require('../../bare-mpv/index.js')
        MpvPlayer = required?.MpvPlayer ?? required?.default?.MpvPlayer ?? required?.default ?? required ?? null
        if (MpvPlayer) return
      }

      const imported = await import('../../bare-mpv/index.js')
      MpvPlayer = imported?.MpvPlayer ?? imported?.default?.MpvPlayer ?? imported?.default ?? null
      if (!MpvPlayer) {
        throw new Error('bare-mpv export missing MpvPlayer')
      }
    } catch (error) {
      mpvLoadError = error?.message || String(error)
      console.warn(`[${runtimeLabel}] bare-mpv not available:`, mpvLoadError)
    }
  })()

  return mpvLoadPromise
}

async function loadBareFFmpeg() {
  if (bareFFmpeg || ffmpegLoadError) return
  if (ffmpegLoadPromise) return ffmpegLoadPromise

  ffmpegLoadPromise = (async () => {
    try {
      let mod = null
      if (typeof require === 'function') {
        try {
          mod = require('bare-ffmpeg')
        } catch {}
      }

      if (!mod) {
        mod = await import('bare-ffmpeg')
      }

      bareFFmpeg = mod?.default ?? mod ?? null
      if (!bareFFmpeg) {
        throw new Error('bare-ffmpeg export missing')
      }
    } catch (error) {
      ffmpegLoadError = error?.message || String(error)
      console.warn(`[${runtimeLabel}] bare-ffmpeg not available:`, ffmpegLoadError)
    }
  })()

  return ffmpegLoadPromise
}

function handleMpvFrameRequest(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*' }

  try {
    if (req.method !== 'GET') {
      res.writeHead(405, cors)
      res.end()
      return
    }

    const parts = (req.url || '/').split('?')[0].split('/').filter(Boolean)
    if (parts[0] !== 'frame' || !parts[1]) {
      res.writeHead(404, cors)
      res.end()
      return
    }

    const state = mpvPlayers.get(decodeURIComponent(parts[1]))
    if (!state) {
      res.writeHead(404, cors)
      res.end()
      return
    }

    if (!state.player.needsRender()) {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const frameData = state.player.renderFrame()
    if (!frameData?.length) {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const buffer = Buffer.from(frameData)
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'no-store',
      'X-Frame-Width': String(state.width),
      'X-Frame-Height': String(state.height),
    })
    res.end(buffer)
  } catch {
    try {
      res.writeHead(500, cors)
      res.end()
    } catch {}
  }
}

async function ensureMpvFrameServer() {
  if (mpvFrameServerPort) return mpvFrameServerPort
  if (mpvFrameServerReady) return mpvFrameServerReady

  mpvFrameServerReady = new Promise((resolve, reject) => {
    const createServer = async () => {
      const http1 = await loadBareHTTP1()
      mpvFrameServer = http1.createServer(handleMpvFrameRequest)
      mpvFrameServer.on('error', (error) => reject(error))
      mpvFrameServer.listen(0, '127.0.0.1', () => {
        mpvFrameServerPort = mpvFrameServer.address().port || 0
        resolve(mpvFrameServerPort)
      })
    }

    void createServer().catch(reject)
  })

  return mpvFrameServerReady
}

async function destroyAllMpvPlayers() {
  for (const [playerId, state] of mpvPlayers) {
    try {
      state.player.destroy()
    } catch {}
    mpvPlayers.delete(playerId)
  }

  if (mpvFrameServer) {
    try {
      mpvFrameServer.close()
    } catch {}
    mpvFrameServer = null
    mpvFrameServerPort = 0
    mpvFrameServerReady = null
  }
}

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
    process.stderr?.write?.(`[${runtimeLabel}:${level}] ${rendered}\n`)
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
    feedUpdateCount: 0,
    lastFeedUpdateAt: null,
    lastBrowseSnapshot: createEmptyBrowseSnapshot(),
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
    pathModule,
    fsModule,
  ] = await Promise.all([
    createBackend({
      ...options,
      disableStandalonePrimaryKeyFile: true,
    }),
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

    console.log(`[${runtimeLabel}] Attached shared app handler layer`)
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
    onFeedUpdate() {
      state.feedUpdateCount += 1
      state.lastFeedUpdateAt = Date.now()
      console.log(`[${runtimeLabel}] feed updated count=${state.feedUpdateCount}`)
      emitBridgeEvent(
        bridgeRPC.BRIDGE_EVENTS.feedUpdated,
        bridgeRPC.feedUpdatedEventCodec,
        { channelKey: 'feed', action: 'update' },
        onError
      )
    },
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
  client.events.on(PROTOCOL_EVENTS.UPLOAD_PROGRESS, (payload) => {
    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.uploadProgress,
      bridgeRPC.uploadProgressEventCodec,
      {
        videoId: payload?.videoId || '',
        progress: payload?.progress ?? 0,
        bytesUploaded: payload?.bytesUploaded ?? null,
        totalBytes: payload?.totalBytes ?? null,
        speed: payload?.speed ?? null,
        eta: payload?.eta ?? null,
      },
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

  const feedEntries = listFromResponse(feedResult, 'entries')
  const subscriptions = listFromResponse(subscriptionsResult, 'subscriptions')
  const identities = listFromResponse(identitiesResult, 'identities')

  console.log(`[browse-snapshot] Feed: ${feedEntries.length} entries, Subs: ${subscriptions.length}, Identities: ${identities.length}`)
  for (const e of feedEntries) {
    console.log(`[browse-snapshot]   entry: ${(e.channelKey || e.driveKey || '').slice(0, 16)} source=${e.source} peers=${e.peerCount} bee=${!!e.publicBeeKey} previews=${(e.previewVideos || []).length}`)
  }

  const rawFetchChannelData = createChannelDataFetcher(client)
  const fetchChannelData = async (source, options) => {
    const result = await rawFetchChannelData(source, options)
    const videos = result?.videos || []
    console.log(`[browse-snapshot] fetchChannelData ${(source.channelKey || '').slice(0, 16)}: ${videos.length} videos, availability: [${videos.map(v => v?.availability || 'none').join(', ')}]`)
    return result
  }

  const snapshot = await buildBrowseSnapshot({
    feedEntries,
    subscriptions,
    identities,
    fetchChannelData,
    activeChannelPublished: Boolean(publishResult?.published),
  })

  console.log(`[browse-snapshot] Result: home=${snapshot.sections.home.length} subs=${snapshot.sections.subscriptions.length} lib=${snapshot.sections.library.length}`)

  state.lastBrowseSnapshot = snapshot
  return snapshot
}

async function loadIdentityMutationSnapshot(state) {
  const client = state.client
  if (!client) throw new Error('Host client is not ready')

  const [identitiesResult, publishResult] = await Promise.all([
    withTimeout(() => client.identity.getIdentities({}), { identities: [] }),
    withTimeout(() => client.feed.isChannelPublished({}), { published: false }),
  ])

  const identities = listFromResponse(identitiesResult, 'identities')
  const snapshot = buildIdentityMutationSnapshot({
    previousSnapshot: state.lastBrowseSnapshot,
    identities,
    activeChannelPublished: Boolean(publishResult?.published),
  })

  state.lastBrowseSnapshot = snapshot
  return snapshot
}

function createChannelDataFetcher(client) {
  const channelCache = new Map()
  const videoMetadataCache = new Map()

  async function fetchVideoMetadata(source, video) {
    const videoRef = video?.path || video?.id
    if (!videoRef) return null

    const cacheKey = `${source.channelKey}:${source.publicBeeKey || ''}:${videoRef}`
    if (!videoMetadataCache.has(cacheKey)) {
      videoMetadataCache.set(
        cacheKey,
        withTimeout(
          () => client.video.getVideoData({
            channelKey: source.channelKey,
            publicBeeKey: source.publicBeeKey || undefined,
            videoId: videoRef,
          }),
          { video: null },
          3000
        ).then((response) => response?.video || response || null)
      )
    }

    return videoMetadataCache.get(cacheKey)
  }

  return async function fetchChannelData(source, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 6
    const offset = Number.isFinite(options.offset) ? options.offset : 0
    const cacheKey = `${source.channelKey}:${source.publicBeeKey || ''}:${limit}:${offset}`
    if (channelCache.has(cacheKey)) return channelCache.get(cacheKey)

    const resultPromise = Promise.all([
      withTimeout(() => client.channel.getChannelMeta({
        channelKey: source.channelKey,
        publicBeeKey: source.publicBeeKey || undefined,
      }), {}),
      withTimeout(() => client.video.listVideos({
        channelKey: source.channelKey,
        publicBeeKey: source.publicBeeKey || undefined,
        limit,
        offset,
      }), { videos: [] }),
    ]).then(async ([channelMeta, videosResult]) => {
      const listedVideos = listFromResponse(videosResult, 'videos')
      const videos = await Promise.all(listedVideos.map(async (video) => {
        const metadata = await fetchVideoMetadata(source, video)
        return mergeVideoMetadata(video, metadata)
      }))

      return {
        channelMeta,
        videos,
      }
    })

    channelCache.set(cacheKey, resultPromise)
    return resultPromise
  }
}

async function shutdownBridge(state) {
  await destroyAllMpvPlayers()
  await state.hostSession?.terminate?.()
  state.hostSession = null
  state.client = null
  state.currentStoragePath = null
}

async function mutateAndReload(state, mutate, options = {}) {
  if (!state.client) throw new Error('Host client is not ready')
  await mutate(state.client)
  if (typeof options.responseBuilder === 'function') {
    return options.responseBuilder(state)
  }
  return loadBrowseSnapshot(state)
}

function normalizeComment(comment, videoId) {
  return {
    videoId,
    commentId: comment?.commentId || comment?.id || '',
    text: comment?.text || '',
    authorKeyHex: comment?.authorKeyHex || comment?.author || '',
    timestamp: comment?.timestamp || 0,
    parentId: comment?.parentId || null,
    isAdmin: Boolean(comment?.isAdmin),
  }
}

function normalizeCommentsResponse(response, videoId) {
  return {
    success: Boolean(response?.success),
    comments: Array.isArray(response?.comments)
      ? response.comments.map((comment) => normalizeComment(comment, videoId))
      : [],
    error: response?.error || null,
  }
}

function normalizeReactionCounts(counts) {
  if (Array.isArray(counts)) {
    return counts.map((entry) => ({
      reactionType: String(entry?.reactionType || ''),
      count: typeof entry?.count === 'number' ? entry.count : 0,
    }))
  }

  if (!counts || typeof counts !== 'object') {
    return []
  }

  return Object.entries(counts).map(([reactionType, count]) => ({
    reactionType,
    count: typeof count === 'number' ? count : 0,
  }))
}

function normalizeMutationResponse(response, { includeQueued = true } = {}) {
  return {
    success: Boolean(response?.success),
    queued: includeQueued ? Boolean(response?.queued) : false,
    error: response?.error || null,
    commentId: response?.commentId || null,
  }
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
      protocolVersion: ready?.protocolVersion ?? 2,
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
    return mutateAndReload(
      state,
      async (client) => {
        await client.identity.createIdentity({ name: params.name })
      },
      { responseBuilder: loadIdentityMutationSnapshot }
    )
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

  if (command === bridgeRPC.BRIDGE_COMMANDS.getChannelMeta) {
    const params = bridgeRPC.decodePayload(bridgeRPC.getChannelMetaRequestCodec, data)
    const fetchChannelData = createChannelDataFetcher(state.client)
    const result = await fetchChannelData({
      channelKey: params.channelKey,
      publicBeeKey: params.publicBeeKey || undefined,
    }, {
      limit: 0,
      offset: 0,
    })
    const channelMeta = result?.channelMeta || {}

    return {
      channelKey: params.channelKey,
      publicBeeKey: params.publicBeeKey || null,
      avatarURL: channelMeta?.avatar || null,
      name: channelMeta?.name || null,
      description: channelMeta?.description || null,
      videoCount: channelMeta?.videoCount ?? null,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.listChannelVideos) {
    const params = bridgeRPC.decodePayload(bridgeRPC.listChannelVideosRequestCodec, data)
    const fetchChannelData = createChannelDataFetcher(state.client)
    const result = await fetchChannelData({
      channelKey: params.channelKey,
      publicBeeKey: params.publicBeeKey || undefined,
    }, {
      limit: 100,
      offset: 0,
    })
    const nativeVideos = buildChannelWorkspaceVideos({
      channelKey: params.channelKey,
      publicBeeKey: params.publicBeeKey || null,
      channelMeta: result?.channelMeta || {},
      videos: Array.isArray(result?.videos) ? result.videos : [],
      sourceKind: params.publicBeeKey ? 'channel' : 'identity',
      sections: params.publicBeeKey ? ['library'] : ['studio', 'library'],
    })

    return {
      channelKey: params.channelKey,
      videos: nativeVideos,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.updateChannel) {
    const params = bridgeRPC.decodePayload(bridgeRPC.updateChannelRequestCodec, data)
    const response = await state.client?.channel.updateChannel({
      name: params.name || undefined,
      description: params.description || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.updateChannelAvatar) {
    const params = bridgeRPC.decodePayload(bridgeRPC.updateChannelAvatarRequestCodec, data)
    const response = await state.client?.channel.updateChannelAvatar({
      filePath: params.filePath,
      mimeType: params.mimeType || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.updateVideoMetadata) {
    const params = bridgeRPC.decodePayload(bridgeRPC.updateVideoMetadataRequestCodec, data)
    const response = await state.client?.video.updateVideoMetadata({
      channelKey: params.channelKey,
      videoId: params.videoId,
      title: params.title || undefined,
      description: params.description || undefined,
      category: params.category || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.deleteVideo) {
    const params = bridgeRPC.decodePayload(bridgeRPC.deleteVideoRequestCodec, data)
    const response = await state.client?.video.deleteVideo({
      channelKey: params.channelKey,
      videoId: params.videoId,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.setVideoThumbnailFromFile) {
    const params = bridgeRPC.decodePayload(bridgeRPC.setVideoThumbnailFromFileRequestCodec, data)
    const response = await state.client?.video.setVideoThumbnailFromFile({
      videoId: params.videoId,
      filePath: params.filePath,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.resolvePlayback) {
    const params = bridgeRPC.decodePayload(bridgeRPC.resolvePlaybackRequestCodec, data)
    return resolvePlaybackViaClient({
      client: state.client,
      params,
      log: (message) => console.log(`[${runtimeLabel}] ${message}`),
      prefetchTimeoutMs: 7000,
    })
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.getVideoStats) {
    const params = bridgeRPC.decodePayload(bridgeRPC.videoStatsRequestCodec, data)
    const videoRef = params.videoPath || params.videoId
    const stats = await state.client?.video.getVideoStats({
      channelKey: params.channelKey,
      videoId: videoRef,
    })

    return {
      success: true,
      status: stats?.stats?.status ?? stats?.status ?? 'unknown',
      progress: stats?.stats?.progress ?? stats?.progress ?? 0,
      totalBlocks: stats?.stats?.totalBlocks ?? stats?.totalBlocks ?? 0,
      downloadedBlocks: stats?.stats?.downloadedBlocks ?? stats?.downloadedBlocks ?? 0,
      totalBytes: stats?.stats?.totalBytes ?? stats?.totalBytes ?? 0,
      downloadedBytes: stats?.stats?.downloadedBytes ?? stats?.downloadedBytes ?? 0,
      peerCount: stats?.stats?.peerCount ?? stats?.peerCount ?? 0,
      swarmConnections: stats?.stats?.swarmConnections ?? stats?.swarmConnections ?? 0,
      speedMBps: String(stats?.stats?.speedMBps ?? stats?.speedMBps ?? '0'),
      uploadSpeedMBps: stats?.stats?.uploadSpeedMBps ?? stats?.uploadSpeedMBps ?? null,
      elapsed: stats?.stats?.elapsed ?? stats?.elapsed ?? 0,
      isComplete: Boolean(stats?.stats?.isComplete ?? stats?.isComplete),
      error: stats?.stats?.error ?? stats?.error ?? null,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.addComment) {
    const params = bridgeRPC.decodePayload(bridgeRPC.addCommentRequestCodec, data)
    const response = await state.client?.video.addComment({
      channelKey: params.channelKey,
      videoId: params.videoId,
      text: params.text,
      parentId: params.parentId || undefined,
      authorChannelKey: params.authorChannelKey || undefined,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.listComments) {
    const params = bridgeRPC.decodePayload(bridgeRPC.listCommentsRequestCodec, data)
    const response = await state.client?.video.listComments({
      channelKey: params.channelKey,
      videoId: params.videoId,
      page: params.page,
      limit: params.limit,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return normalizeCommentsResponse(response, params.videoId)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.hideComment) {
    const params = bridgeRPC.decodePayload(bridgeRPC.commentModerationRequestCodec, data)
    const response = await state.client?.video.hideComment({
      channelKey: params.channelKey,
      videoId: params.videoId,
      commentId: params.commentId,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return {
      success: Boolean(response?.success),
      error: response?.error || null,
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.removeComment) {
    const params = bridgeRPC.decodePayload(bridgeRPC.commentModerationRequestCodec, data)
    const response = await state.client?.video.removeComment({
      channelKey: params.channelKey,
      videoId: params.videoId,
      commentId: params.commentId,
      authorChannelKey: params.authorChannelKey || undefined,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.addReaction) {
    const params = bridgeRPC.decodePayload(bridgeRPC.addReactionRequestCodec, data)
    const response = await state.client?.video.addReaction({
      channelKey: params.channelKey,
      videoId: params.videoId,
      reactionType: params.reactionType,
      authorChannelKey: params.authorChannelKey || undefined,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.removeReaction) {
    const params = bridgeRPC.decodePayload(bridgeRPC.reactionRequestCodec, data)
    const response = await state.client?.video.removeReaction({
      channelKey: params.channelKey,
      videoId: params.videoId,
      authorChannelKey: params.authorChannelKey || undefined,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.getReactions) {
    const params = bridgeRPC.decodePayload(bridgeRPC.reactionRequestCodec, data)
    const response = await state.client?.video.getReactions({
      channelKey: params.channelKey,
      videoId: params.videoId,
      authorChannelKey: params.authorChannelKey || undefined,
      publicBeeKey: params.publicBeeKey || undefined,
    })

    return {
      success: Boolean(response?.success),
      counts: normalizeReactionCounts(response?.counts),
      userReaction: response?.userReaction || null,
      error: response?.error || null,
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

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvAvailable) {
    await loadBareMpv()
    return {
      available: MpvPlayer !== null,
      error: MpvPlayer ? null : (mpvLoadError || 'bare-mpv not available'),
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.ffmpegDecodeAvailable) {
    await loadBareFFmpeg()
    return {
      available: bareFFmpeg !== null,
      error: bareFFmpeg ? null : (ffmpegLoadError || 'bare-ffmpeg not available'),
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvCreate) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvCreateRequestCodec, data)
    await loadBareMpv()

    if (!MpvPlayer) {
      return {
        success: false,
        playerId: null,
        frameServerPort: null,
        error: mpvLoadError || 'bare-mpv not available',
      }
    }

    try {
      const width = Math.max(defaultMpvWidth, params.width || defaultMpvWidth)
      const height = Math.max(defaultMpvHeight, params.height || defaultMpvHeight)
      const frameServerPort = await ensureMpvFrameServer()
      const playerId = `mpv_${++mpvPlayerIdCounter}`
      const player = new MpvPlayer()
      if (player.initialize() !== 0) {
        throw new Error('Failed to initialize mpv')
      }
      player.initRender(width, height)
      mpvPlayers.set(playerId, { player, width, height })
      return { success: true, playerId, frameServerPort, error: null }
    } catch (error) {
      return {
        success: false,
        playerId: null,
        frameServerPort: null,
        error: error?.message || String(error),
      }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvLoadFile) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvLoadFileRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) {
      return { success: false, error: 'Player not found' }
    }

    try {
      stateEntry.player.loadFile(params.url)
      return { success: true, error: null }
    } catch (error) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvPlay) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvPlayerCommandRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) return { success: false, error: 'Player not found' }

    try {
      stateEntry.player.play()
      return { success: true, error: null }
    } catch (error) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvPause) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvPlayerCommandRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) return { success: false, error: 'Player not found' }

    try {
      stateEntry.player.pause()
      return { success: true, error: null }
    } catch (error) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvSeek) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvSeekRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) return { success: false, error: 'Player not found' }

    try {
      stateEntry.player.seek(params.time)
      return { success: true, error: null }
    } catch (error) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvGetState) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvPlayerCommandRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) {
      return { success: false, currentTime: 0, duration: 0, paused: true, error: 'Player not found' }
    }

    try {
      return {
        success: true,
        currentTime: stateEntry.player.currentTime || 0,
        duration: stateEntry.player.duration || 0,
        paused: stateEntry.player.paused ?? true,
        error: null,
      }
    } catch {
      return { success: false, currentTime: 0, duration: 0, paused: true, error: 'Failed to read state' }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvRenderFrame) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvPlayerCommandRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) {
      return {
        success: false,
        hasFrame: false,
        width: 0,
        height: 0,
        frameData: null,
        error: 'Player not found',
      }
    }

    try {
      if (!stateEntry.player.needsRender()) {
        return {
          success: true,
          hasFrame: false,
          width: stateEntry.width,
          height: stateEntry.height,
          frameData: null,
          error: null,
        }
      }

      const frameData = stateEntry.player.renderFrame()
      if (!frameData?.length) {
        return {
          success: true,
          hasFrame: false,
          width: stateEntry.width,
          height: stateEntry.height,
          frameData: null,
          error: null,
        }
      }

      return {
        success: true,
        hasFrame: true,
        width: stateEntry.width,
        height: stateEntry.height,
        frameData: Buffer.from(frameData),
        error: null,
      }
    } catch {
      return {
        success: false,
        hasFrame: false,
        width: stateEntry.width,
        height: stateEntry.height,
        frameData: null,
        error: 'render failed',
      }
    }
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvDestroy) {
    const params = bridgeRPC.decodePayload(bridgeRPC.mpvPlayerCommandRequestCodec, data)
    const stateEntry = mpvPlayers.get(params.playerId)
    if (!stateEntry) return { success: false, error: 'Player not found' }

    try {
      stateEntry.player.destroy()
    } catch {}
    mpvPlayers.delete(params.playerId)
    return { success: true, error: null }
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
  const keepAliveTimer = setInterval(() => {}, 1 << 30)

  const reportFatal = (label, error) => {
    const message = `${label}: ${formatError(error)}`

    emitBridgeEvent(
      bridgeRPC.BRIDGE_EVENTS.hostError,
      bridgeRPC.hostErrorEventCodec,
      { message }
    )
    writeStderr(`[${runtimeLabel}] ${message}`)
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

  process.stdin?.resume?.()

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
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.getChannelMeta) {
          payload = bridgeRPC.encodePayload(bridgeRPC.getChannelMetaResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.listChannelVideos) {
          payload = bridgeRPC.encodePayload(bridgeRPC.listChannelVideosResponseCodec, result)
        } else if (
          message.command === bridgeRPC.BRIDGE_COMMANDS.createIdentity ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.refreshFeed ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.publishActiveChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.subscribeChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.unsubscribeChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.uploadVideo
        ) {
          payload = bridgeRPC.encodePayload(bridgeRPC.browseSnapshotCodec, result)
        } else if (
          message.command === bridgeRPC.BRIDGE_COMMANDS.updateChannel ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.updateChannelAvatar ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.updateVideoMetadata ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.deleteVideo ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.setVideoThumbnailFromFile
        ) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mutationResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.addComment) {
          payload = bridgeRPC.encodePayload(bridgeRPC.addCommentResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.listComments) {
          payload = bridgeRPC.encodePayload(bridgeRPC.listCommentsResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.hideComment) {
          payload = bridgeRPC.encodePayload(bridgeRPC.hideCommentResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.removeComment) {
          payload = bridgeRPC.encodePayload(bridgeRPC.removeCommentResponseCodec, result)
        } else if (
          message.command === bridgeRPC.BRIDGE_COMMANDS.addReaction ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.removeReaction
        ) {
          payload = bridgeRPC.encodePayload(bridgeRPC.reactionMutationResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.getReactions) {
          payload = bridgeRPC.encodePayload(bridgeRPC.getReactionsResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.resolvePlayback) {
          payload = bridgeRPC.encodePayload(bridgeRPC.resolvePlaybackResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.resolveThumbnail) {
          payload = bridgeRPC.encodePayload(bridgeRPC.resolveThumbnailResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.getVideoStats) {
          payload = bridgeRPC.encodePayload(bridgeRPC.videoStatsResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.mpvAvailable) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mpvAvailableResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.ffmpegDecodeAvailable) {
          payload = bridgeRPC.encodePayload(bridgeRPC.ffmpegDecodeAvailableResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.mpvCreate) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mpvCreateResponseCodec, result)
        } else if (
          message.command === bridgeRPC.BRIDGE_COMMANDS.mpvLoadFile ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.mpvPlay ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.mpvPause ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.mpvSeek ||
          message.command === bridgeRPC.BRIDGE_COMMANDS.mpvDestroy
        ) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mpvPlayerCommandResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.mpvGetState) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mpvGetStateResponseCodec, result)
        } else if (message.command === bridgeRPC.BRIDGE_COMMANDS.mpvRenderFrame) {
          payload = bridgeRPC.encodePayload(bridgeRPC.mpvRenderFrameResponseCodec, result)
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
    clearInterval(keepAliveTimer)
    void shutdownBridge(state).finally(() => {
      try {
        Bare.exit(0)
      } catch {}
    })
  })
}

main().catch((error) => {
  writeStderr(`[${runtimeLabel}] startup failed: ${formatError(error)}`)

  try {
    Bare.exit(1)
  } catch {}

  throw error
})
