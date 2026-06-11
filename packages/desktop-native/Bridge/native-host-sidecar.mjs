/* eslint-disable no-empty, no-undef, @typescript-eslint/no-require-imports */
import bareProcess from 'bare-process'
import os from 'bare-os'
import HRPC from '../../spec/spec/hrpc/index.js'
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
import { attachMobileHandlers } from '../../backend/src/mobile-handlers.js'
import * as thumbnailModule from '../../backend/src/thumbnail.js'

if (!globalThis.process) {
  globalThis.process = bareProcess
}

const runtimeLabel = globalThis?.process?.env?.PEARTUBE_NATIVE_EMBEDDED_BAREKIT
  ? 'native-host-embedded'
  : 'native-host-sidecar'

let bareFFmpeg = null
let ffmpegLoadError = null
let ffmpegLoadPromise = null
let bareHttp1Promise = null
let platformPromise = null
let transcoderModule = null
let transcoderModulePromise = null

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

async function ensureTranscoderModule() {
  if (transcoderModule) return transcoderModule
  if (!transcoderModulePromise) {
    transcoderModulePromise = import('../../backend/src/transcode/transcoder.mjs')
      .then((module) => {
        transcoderModule = module?.default ?? module
        return transcoderModule
      })
      .catch((error) => {
        transcoderModulePromise = null
        throw error
      })
  }

  return transcoderModulePromise
}

function createLazyTranscoder() {
  return {
    async startTranscode(...args) {
      const module = await ensureTranscoderModule()
      return module.startTranscode(...args)
    },
    async stopTranscode(...args) {
      const module = await ensureTranscoderModule()
      return module.stopTranscode(...args)
    },
    async getStatus(...args) {
      const module = await ensureTranscoderModule()
      return module.getStatus(...args)
    },
  }
}

let castTranscoderModule = null
let castTranscoderModulePromise = null

async function ensureCastTranscoderModule() {
  if (castTranscoderModule) return castTranscoderModule
  if (!castTranscoderModulePromise) {
    castTranscoderModulePromise = import('../../backend/src/transcode/cast-transcoder.mjs')
      .then((module) => {
        castTranscoderModule = module?.default ?? module
        return castTranscoderModule
      })
      .catch((error) => {
        castTranscoderModulePromise = null
        throw error
      })
  }

  return castTranscoderModulePromise
}

// Lazy cast-transcoder wrapper used by the AVPlayer compatibility layer. Methods
// are async so the underlying module loads on first use; the runtime helper
// awaits them all.
function createLazyCastTranscoder() {
  return {
    async startCompatTranscode(...args) {
      const module = await ensureCastTranscoderModule()
      return module.startCompatTranscode(...args)
    },
    async getCastHlsUrl(...args) {
      const module = await ensureCastTranscoderModule()
      return module.getCastHlsUrl(...args)
    },
    async getCastStatus(...args) {
      const module = await ensureCastTranscoderModule()
      return module.getCastStatus(...args)
    },
    async stopCastTranscode(...args) {
      const module = await ensureCastTranscoderModule()
      return module.stopCastTranscode(...args)
    },
  }
}

function createKeepAliveCleanup() {
  let keepAliveTimer = setInterval(() => {}, 1 << 30)

  return function cleanupKeepAlive() {
    if (!keepAliveTimer) return
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
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
  const override = process?.env?.PEARTUBE_NATIVE_STORAGE_PATH
  if (override && override.length > 0) return override
  return `${os.homedir()}/.peartube`
}

function writeStderr(line) {
  try {
    process.stderr?.write?.(`${line}\n`)
  } catch {}
}

let hrpc = null

function listFromResponse(value, key) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.[key])) return value[key]
  return []
}

function emitBridgeEvent(eventName, payload, onError) {
  try {
    if (!hrpc) return
    switch (eventName) {
      case 'ready':
        hrpc.eventReady(payload)
        break
      case 'error':
        hrpc.eventError(payload)
        break
      case 'log':
        hrpc.eventLog(payload)
        break
      case 'feedUpdate':
        hrpc.eventFeedUpdate(payload)
        break
      case 'uploadProgress':
        hrpc.eventUploadProgress(payload)
        break
    }
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
    createBackend(options),
    import('bare-path'),
    import('bare-fs'),
  ])

  const backend = backendSession?.backend
  const rpc = backendSession?.rpc

  if (backend && rpc && typeof attachMobileHandlers === 'function') {
    const path = pathModule?.default ?? pathModule
    const fs = fsModule?.default ?? fsModule
    const generateAndStoreThumbnail = thumbnailModule?.generateAndStoreThumbnail
    const transcoder = createLazyTranscoder()

    // Route AVPlayer-incompatible codecs (MKV/Opus/AC-3/DTS, …) through a
    // local-HLS bare-ffmpeg transcode — the codec coverage bare-mpv used to provide.
    // Off by default — enable with PEARTUBE_AVPLAYER_COMPAT=1 for on-device validation.
    const avplayerCompatEnabled = globalThis.process?.env?.PEARTUBE_AVPLAYER_COMPAT === '1'

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
      ...(avplayerCompatEnabled ? { castTranscoder: createLazyCastTranscoder(), player: 'avplayer' } : {}),
      storagePath: options.storagePath,
    })
    if (avplayerCompatEnabled) console.log(`[${runtimeLabel}] AVPlayer compatibility layer enabled`)

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
      emitBridgeEvent('feedUpdate', { channelKey: 'feed', action: 'update' }, onError)
    },
  })

  const client = createProtocolClient({ stream: clientStream })

  client.events.on(PROTOCOL_EVENTS.LOG, (payload) => {
    emitBridgeEvent('log', { level: 'info', message: payload?.message || 'Host log event', timestamp: 0 }, onError)
  })
  client.events.on(PROTOCOL_EVENTS.HOST_READY, (payload) => {
    emitBridgeEvent('ready', { blobServerPort: payload?.blobServerPort ?? 0 }, onError)
  })
  client.events.on(PROTOCOL_EVENTS.HOST_ERROR, (payload) => {
    emitBridgeEvent('error', { code: 0, message: payload?.message || 'Unknown host error' }, onError)
  })
  client.events.on(PROTOCOL_EVENTS.UPLOAD_PROGRESS, (payload) => {
    emitBridgeEvent('uploadProgress', {
      videoId: payload?.videoId || '',
      progress: payload?.progress ?? 0,
      bytesUploaded: payload?.bytesUploaded ?? 0,
      totalBytes: payload?.totalBytes ?? 0,
      speed: payload?.speed ?? '',
      eta: payload?.eta ?? '',
    }, onError)
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

async function shutdownBridge(state, cleanupKeepAlive = null) {
  cleanupKeepAlive?.()
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

// Map bridge-core video objects to HRPC desktop-browse-video schema field names
function toSchemaVideo(v) {
  return {
    id: v.id || '',
    backendVideoId: v.backendVideoID || v.backendVideoId || v.id || '',
    channelKey: v.channelKey || '',
    publicBeeKey: v.publicBeeKey || '',
    title: v.title || '',
    channelName: v.channelName || '',
    durationText: v.durationText || '',
    summary: v.summary || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    accentHex: v.accentHex || '',
    sections: Array.isArray(v.sections) ? v.sections : [],
    thumbnailUrl: v.thumbnailURL || v.thumbnailUrl || '',
    path: v.path || '',
    blobId: v.blobId || '',
    blobsCoreKey: v.blobsCoreKey || '',
    mimeType: v.mimeType || '',
    width: v.width || 0,
    height: v.height || 0,
  }
}

function toSchemaSnapshot(snapshot) {
  if (!snapshot) return createEmptyBrowseSnapshot()
  const s = snapshot.sections || {}
  const mapVideos = (arr) => (Array.isArray(arr) ? arr : []).map(toSchemaVideo)
  return {
    generatedAt: snapshot.generatedAt || Date.now(),
    sections: {
      home: mapVideos(s.home),
      subscriptions: mapVideos(s.subscriptions),
      library: mapVideos(s.library),
      studio: mapVideos(s.studio),
      diagnostics: mapVideos(s.diagnostics),
    },
    stats: {
      homeCount: snapshot.stats?.homeCount || 0,
      subscriptionCount: snapshot.stats?.subscriptionCount || 0,
      libraryCount: snapshot.stats?.libraryCount || 0,
      channelCount: snapshot.stats?.channelCount || 0,
    },
    state: {
      subscriptionChannelKeys: snapshot.state?.subscriptionChannelKeys || [],
      identityChannelKeys: snapshot.state?.identityChannelKeys || [],
      activeIdentityName: snapshot.state?.activeIdentityName || '',
      activeIdentityChannelKey: snapshot.state?.activeIdentityChannelKey || '',
      activeChannelPublished: Boolean(snapshot.state?.activeChannelPublished),
    },
  }
}

function registerHandlers(hrpcInstance, state, reportFatal, cleanupKeepAlive = null) {
  hrpcInstance.onDesktopBootstrap(async (req) => {
    const ready = await ensureHostBooted(
      state,
      req.storagePath || defaultStoragePath(),
      reportFatal
    )
    const snapshot = await loadBrowseSnapshot(state)

    if (!Number.isSafeInteger(ready?.protocolVersion)) {
      throw new Error('Host ready payload missing protocolVersion')
    }

    return {
      blobServerPort: ready?.blobServerPort ?? 0,
      protocolVersion: ready.protocolVersion,
      storagePath: state.currentStoragePath || '',
      snapshot: toSchemaSnapshot(snapshot),
    }
  })

  hrpcInstance.onDesktopRefreshBrowse(async () => {
    const snapshot = await loadBrowseSnapshot(state)
    return { snapshot: toSchemaSnapshot(snapshot) }
  })

  hrpcInstance.onDesktopShutdown(async () => {
    await shutdownBridge(state, cleanupKeepAlive)
    return { success: true }
  })

  hrpcInstance.onGlobalSearchVideos(async (req) => {
    const rawResponse = await withTimeout(
      () => state.client?.search.globalSearchVideos({
        query: req.query,
        topK: req.topK,
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
      results,
    }
  })

  hrpcInstance.onCreateIdentity(async (req) => {
    const snapshot = await mutateAndReload(
      state,
      async (client) => {
        await client.identity.createIdentity({ name: req.name })
      },
      { responseBuilder: loadIdentityMutationSnapshot }
    )
    return { identity: snapshot }
  })

  hrpcInstance.onRefreshFeed(async () => {
    await mutateAndReload(state, async (client) => {
      await client.feed.refreshFeed({})
    })
    return { success: true }
  })

  hrpcInstance.onSubmitToFeed(async () => {
    await mutateAndReload(state, async (client) => {
      await client.feed.submitToFeed({})
    })
    return { success: true }
  })

  hrpcInstance.onSubscribeChannel(async (req) => {
    await mutateAndReload(state, async (client) => {
      await client.feed.subscribeChannel({ channelKey: req.channelKey })
    })
    return { success: true }
  })

  hrpcInstance.onUnsubscribeChannel(async (req) => {
    await mutateAndReload(state, async (client) => {
      await client.feed.unsubscribeChannel({ channelKey: req.channelKey })
    })
    return { success: true }
  })

  hrpcInstance.onUploadVideo(async (req) => {
    await mutateAndReload(state, async (client) => {
      await client.transfer.uploadVideo({
        filePath: req.filePath,
        title: req.title,
        description: req.description || '',
        category: req.category || '',
      })
    })
    return { video: {} }
  })

  hrpcInstance.onGetChannelMeta(async (req) => {
    const fetchChannelData = createChannelDataFetcher(state.client)
    const result = await fetchChannelData({
      channelKey: req.channelKey,
      publicBeeKey: req.publicBeeKey || undefined,
    }, {
      limit: 0,
      offset: 0,
    })
    const channelMeta = result?.channelMeta || {}

    return {
      channelKey: req.channelKey,
      publicBeeKey: req.publicBeeKey || '',
      avatarURL: channelMeta?.avatar || '',
      name: channelMeta?.name || '',
      description: channelMeta?.description || '',
      videoCount: channelMeta?.videoCount ?? 0,
    }
  })

  hrpcInstance.onListVideos(async (req) => {
    const fetchChannelData = createChannelDataFetcher(state.client)
    const result = await fetchChannelData({
      channelKey: req.channelKey,
      publicBeeKey: req.publicBeeKey || undefined,
    }, {
      limit: req.limit || 100,
      offset: req.offset || 0,
    })
    const nativeVideos = buildChannelWorkspaceVideos({
      channelKey: req.channelKey,
      publicBeeKey: req.publicBeeKey || null,
      channelMeta: result?.channelMeta || {},
      videos: Array.isArray(result?.videos) ? result.videos : [],
      sourceKind: req.publicBeeKey ? 'channel' : 'identity',
      sections: req.publicBeeKey ? ['library'] : ['studio', 'library'],
    })

    return {
      videos: nativeVideos,
    }
  })

  hrpcInstance.onUpdateChannel(async (req) => {
    const response = await state.client?.channel.updateChannel({
      name: req.name || undefined,
      description: req.description || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  })

  hrpcInstance.onUpdateChannelAvatar(async (req) => {
    const response = await state.client?.channel.updateChannelAvatar({
      filePath: req.filePath,
      mimeType: req.mimeType || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  })

  hrpcInstance.onUpdateVideoMetadata(async (req) => {
    const response = await state.client?.video.updateVideoMetadata({
      channelKey: req.channelKey,
      videoId: req.videoId,
      title: req.title || undefined,
      description: req.description || undefined,
      category: req.category || undefined,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  })

  hrpcInstance.onDeleteVideo(async (req) => {
    const response = await state.client?.video.deleteVideo({
      channelKey: req.channelKey,
      videoId: req.videoId,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  })

  hrpcInstance.onSetVideoThumbnailFromFile(async (req) => {
    const response = await state.client?.video.setVideoThumbnailFromFile({
      videoId: req.videoId,
      filePath: req.filePath,
    })
    return normalizeMutationResponse(response, { includeQueued: false })
  })

  hrpcInstance.onPreparePlayback(async (req) => {
    return resolvePlaybackViaClient({
      client: state.client,
      params: req,
      log: (message) => console.log(`[${runtimeLabel}] ${message}`),
      prefetchTimeoutMs: 7000,
    })
  })

  hrpcInstance.onGetVideoStats(async (req) => {
    const videoRef = req.videoId
    const raw = await state.client?.video.getVideoStats({
      channelKey: req.channelKey,
      videoId: videoRef,
    })
    const s = raw?.stats ?? raw ?? {}

    return {
      stats: {
        videoId: videoRef || '',
        channelKey: req.channelKey || '',
        status: s.status ?? 'unknown',
        progress: s.progress ?? 0,
        totalBlocks: s.totalBlocks ?? 0,
        downloadedBlocks: s.downloadedBlocks ?? 0,
        totalBytes: s.totalBytes ?? 0,
        downloadedBytes: s.downloadedBytes ?? 0,
        peerCount: s.peerCount ?? 0,
        speedMBps: String(s.speedMBps ?? '0'),
        uploadSpeedMBps: s.uploadSpeedMBps ?? '',
        elapsed: s.elapsed ?? 0,
        isComplete: Boolean(s.isComplete),
      },
    }
  })

  hrpcInstance.onAddComment(async (req) => {
    const response = await state.client?.video.addComment({
      channelKey: req.channelKey,
      videoId: req.videoId,
      text: req.text,
      parentId: req.parentId || undefined,
      authorChannelKey: req.authorChannelKey || undefined,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  })

  hrpcInstance.onListComments(async (req) => {
    const response = await state.client?.video.listComments({
      channelKey: req.channelKey,
      videoId: req.videoId,
      page: req.page,
      limit: req.limit,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return normalizeCommentsResponse(response, req.videoId)
  })

  hrpcInstance.onHideComment(async (req) => {
    const response = await state.client?.video.hideComment({
      channelKey: req.channelKey,
      videoId: req.videoId,
      commentId: req.commentId,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return {
      success: Boolean(response?.success),
      error: response?.error || '',
    }
  })

  hrpcInstance.onRemoveComment(async (req) => {
    const response = await state.client?.video.removeComment({
      channelKey: req.channelKey,
      videoId: req.videoId,
      commentId: req.commentId,
      authorChannelKey: req.authorChannelKey || undefined,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  })

  hrpcInstance.onAddReaction(async (req) => {
    const response = await state.client?.video.addReaction({
      channelKey: req.channelKey,
      videoId: req.videoId,
      reactionType: req.reactionType,
      authorChannelKey: req.authorChannelKey || undefined,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  })

  hrpcInstance.onRemoveReaction(async (req) => {
    const response = await state.client?.video.removeReaction({
      channelKey: req.channelKey,
      videoId: req.videoId,
      authorChannelKey: req.authorChannelKey || undefined,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return normalizeMutationResponse(response)
  })

  hrpcInstance.onGetReactions(async (req) => {
    const response = await state.client?.video.getReactions({
      channelKey: req.channelKey,
      videoId: req.videoId,
      authorChannelKey: req.authorChannelKey || undefined,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return {
      success: Boolean(response?.success),
      counts: normalizeReactionCounts(response?.counts),
      userReaction: response?.userReaction || '',
      error: response?.error || '',
    }
  })

  hrpcInstance.onGetVideoThumbnail(async (req) => {
    const response = await state.client?.video.getVideoThumbnail({
      channelKey: req.channelKey,
      videoId: req.videoId,
      publicBeeKey: req.publicBeeKey || undefined,
    })

    return {
      url: response?.url || '',
      dataUrl: response?.dataUrl || '',
      exists: Boolean(response?.exists && (response?.dataUrl || response?.url)),
    }
  })

  hrpcInstance.onFfmpegDecodeAvailable(async () => {
    await loadBareFFmpeg()
    return {
      available: bareFFmpeg !== null,
      error: bareFFmpeg ? '' : (ffmpegLoadError || 'bare-ffmpeg not available'),
    }
  })
}

async function main() {
  const state = createBridgeState()
  let keepAliveCleanup = createKeepAliveCleanup()

  // bare-rpc expects a duplex stream with on('data'), on('error'), on('drain'), write(), destroy()
  const stream = {
    write(data) { return process.stdout.write(data) },
    destroy(err) {
      process.stdin?.destroy?.(err)
      process.stdout?.destroy?.(err)
    },
    on(event, cb) {
      if (event === 'drain') {
        process.stdout?.on?.(event, cb)
      } else {
        process.stdin?.on?.(event, cb)
      }
      return stream
    },
    once(event, cb) {
      if (event === 'drain') {
        process.stdout?.once?.(event, cb)
      } else {
        process.stdin?.once?.(event, cb)
      }
      return stream
    },
    removeListener(event, cb) {
      if (event === 'drain') {
        process.stdout?.removeListener?.(event, cb)
      } else {
        process.stdin?.removeListener?.(event, cb)
      }
      return stream
    },
  }

  hrpc = new HRPC(stream)

  const reportFatal = (label, error) => {
    const message = `${label}: ${formatError(error)}`
    emitBridgeEvent('error', { code: 0, message })
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

  registerHandlers(hrpc, state, reportFatal, keepAliveCleanup)

  process.stdin?.resume?.()

  process.stdin?.on?.('end', () => {
    const cleanup = keepAliveCleanup
    keepAliveCleanup = null
    void shutdownBridge(state, cleanup).finally(() => {
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
