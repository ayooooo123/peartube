import bareProcess from 'bare-process'
import http1 from 'bare-http1'
import os from 'bare-os'
import { startHost } from '../../host/src/start-host.js'
import { readIdentityKeyFile } from '../../backend/src/identity-key-file.js'
import { createProtocolClient } from '../../protocol/src/create-client.js'
import { PROTOCOL_EVENTS } from '../../protocol/src/event-map.js'

import {
  buildBrowseSnapshot,
  buildIdentityMutationSnapshot,
  buildSearchResults,
  createEmptyBrowseSnapshot,
  mergeVideoMetadata,
} from './bridge-core.mjs'
import * as bridgeRPC from './native-rpc.mjs'
import { resolvePlaybackViaClient } from './playback-resolution.mjs'

if (!globalThis.process?.stdin || !globalThis.process?.stdout || !globalThis.process?.stderr) {
  globalThis.process = bareProcess
}

const currentPlatform = os.platform()
const isMpvSupported = currentPlatform === 'darwin' || currentPlatform === 'linux' || currentPlatform === 'win32'
const defaultMpvWidth = 1280
const defaultMpvHeight = 720
const DIAGNOSTIC_READ_IDENTITY_KEY_FILE_COMMAND = 255

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

async function loadBareMpv() {
  if (MpvPlayer || mpvLoadError) return
  if (mpvLoadPromise) return mpvLoadPromise

  mpvLoadPromise = (async () => {
    try {
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

      console.log('[native-host-worklet] bare-mpv loaded')
    } catch (error) {
      mpvLoadError = error?.message || String(error)
      console.warn('[native-host-worklet] bare-mpv not available:', mpvLoadError)
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

      console.log('[native-host-worklet] bare-ffmpeg loaded')
    } catch (error) {
      ffmpegLoadError = error?.message || String(error)
      console.warn('[native-host-worklet] bare-ffmpeg not available:', ffmpegLoadError)
    }
  })()

  return ffmpegLoadPromise
}

if (!isMpvSupported) {
  mpvLoadError = `bare-mpv not available on ${currentPlatform}`
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
    mpvFrameServer = http1.createServer(handleMpvFrameRequest)
    mpvFrameServer.on('error', (error) => reject(error))
    mpvFrameServer.listen(0, '127.0.0.1', () => {
      mpvFrameServerPort = mpvFrameServer.address().port || 0
      resolve(mpvFrameServerPort)
    })
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
    process.stderr?.write?.(`[native-host-worklet:${level}] ${rendered}\n`)
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

if (process?.env) {
  process.env.PEARTUBE_NATIVE_EMBEDDED_BAREKIT = '1'
}

function writeStderr(line) {
  try {
    process.stderr?.write?.(`${line}\n`)
  } catch {}
}

let debugFs = null
let debugLogPath = null

function resolveDebugLogPath() {
  if (debugLogPath !== null) return debugLogPath
  debugLogPath = process?.env?.PEARTUBE_NATIVE_WORKLET_DEBUG_LOG || null
  return debugLogPath
}

function getDebugFs() {
  if (debugFs !== null) return debugFs

  if (typeof require !== 'function') {
    debugFs = null
    return debugFs
  }

  try {
    const required = require('bare-fs')
    debugFs = required?.default || required
  } catch {
    debugFs = null
  }

  return debugFs
}

function writeDebugLog(line) {
  const filePath = resolveDebugLogPath()
  if (!filePath) return

  const fs = getDebugFs()
  if (!fs?.appendFileSync) return

  try {
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`)
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
  const { createBackend } = await import('../../backend/src/backend-entry.js')
  return createBackend({
    ...options,
    platform: 'desktop',
    autoAttachSharedAppHandlers: true,
    disableStandalonePrimaryKeyFile: true,
  })
}

async function ensureHostBooted(state, storagePath, onError) {
  if (state.hostSession && state.client) {
    writeDebugLog(`[bootstrap] reusing host session for ${storagePath}`)
    return state.client.ready()
  }

  writeDebugLog(`[bootstrap] starting host for ${storagePath}`)

  for (const addonName of ['rocksdb-native', 'quickbit-native', 'sodium-native']) {
    try {
      require(addonName)
      writeDebugLog(`[bootstrap] ${addonName} loaded`)
    } catch (error) {
      writeDebugLog(`[bootstrap] ${addonName} failed: ${formatError(error)}`)
    }
  }

  const [hostStream, clientStream] = createLoopbackPair()
  const hostSession = await startHost({
    platform: 'desktop',
    storagePath,
    entrypoint: 'native-worklet',
    args: [],
    stream: hostStream,
    createBackendImpl: createNativeSidecarBackend,
    onFeedUpdate() {
      state.feedUpdateCount++
      state.lastFeedUpdateAt = Date.now()
      writeDebugLog(`[feed] update received count=${state.feedUpdateCount}`)
      emitBridgeEvent(
        bridgeRPC.BRIDGE_EVENTS.feedUpdated,
        bridgeRPC.feedUpdatedEventCodec,
        { channelKey: 'feed', action: 'update' },
        onError
      )
    },
  })

  const client = createProtocolClient({ stream: clientStream })

  state.hostSession = hostSession
  state.client = client
  state.currentStoragePath = storagePath

  writeDebugLog('[bootstrap] waiting for client.ready()')
  return client.ready()
}

function encodeResultPayload(command, result) {
  if (command === DIAGNOSTIC_READ_IDENTITY_KEY_FILE_COMMAND) {
    if (Buffer.isBuffer(result)) return result
    if (typeof result === 'string') return Buffer.from(result)
    return Buffer.from(JSON.stringify(result ?? null))
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.bootstrap) {
    return bridgeRPC.encodePayload(bridgeRPC.bootstrapResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.refreshBrowse) {
    return bridgeRPC.encodePayload(bridgeRPC.browseSnapshotCodec, result.snapshot)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.shutdown) {
    return bridgeRPC.encodePayload(bridgeRPC.shutdownResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.searchVideos) {
    return bridgeRPC.encodePayload(bridgeRPC.searchResponseCodec, result)
  }

  if (
    command === bridgeRPC.BRIDGE_COMMANDS.createIdentity ||
    command === bridgeRPC.BRIDGE_COMMANDS.refreshFeed ||
    command === bridgeRPC.BRIDGE_COMMANDS.publishActiveChannel ||
    command === bridgeRPC.BRIDGE_COMMANDS.subscribeChannel ||
    command === bridgeRPC.BRIDGE_COMMANDS.unsubscribeChannel ||
    command === bridgeRPC.BRIDGE_COMMANDS.uploadVideo
  ) {
    return bridgeRPC.encodePayload(bridgeRPC.browseSnapshotCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.addComment) {
    return bridgeRPC.encodePayload(bridgeRPC.addCommentResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.listComments) {
    return bridgeRPC.encodePayload(bridgeRPC.listCommentsResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.hideComment) {
    return bridgeRPC.encodePayload(bridgeRPC.hideCommentResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.removeComment) {
    return bridgeRPC.encodePayload(bridgeRPC.removeCommentResponseCodec, result)
  }

  if (
    command === bridgeRPC.BRIDGE_COMMANDS.addReaction ||
    command === bridgeRPC.BRIDGE_COMMANDS.removeReaction
  ) {
    return bridgeRPC.encodePayload(bridgeRPC.reactionMutationResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.getReactions) {
    return bridgeRPC.encodePayload(bridgeRPC.getReactionsResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.resolvePlayback) {
    return bridgeRPC.encodePayload(bridgeRPC.resolvePlaybackResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.resolveThumbnail) {
    return bridgeRPC.encodePayload(bridgeRPC.resolveThumbnailResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.getVideoStats) {
    return bridgeRPC.encodePayload(bridgeRPC.videoStatsResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvAvailable) {
    return bridgeRPC.encodePayload(bridgeRPC.mpvAvailableResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.ffmpegDecodeAvailable) {
    return bridgeRPC.encodePayload(bridgeRPC.ffmpegDecodeAvailableResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvCreate) {
    return bridgeRPC.encodePayload(bridgeRPC.mpvCreateResponseCodec, result)
  }

  if (
    command === bridgeRPC.BRIDGE_COMMANDS.mpvLoadFile ||
    command === bridgeRPC.BRIDGE_COMMANDS.mpvPlay ||
    command === bridgeRPC.BRIDGE_COMMANDS.mpvPause ||
    command === bridgeRPC.BRIDGE_COMMANDS.mpvSeek ||
    command === bridgeRPC.BRIDGE_COMMANDS.mpvDestroy
  ) {
    return bridgeRPC.encodePayload(bridgeRPC.mpvPlayerCommandResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvGetState) {
    return bridgeRPC.encodePayload(bridgeRPC.mpvGetStateResponseCodec, result)
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.mpvRenderFrame) {
    return bridgeRPC.encodePayload(bridgeRPC.mpvRenderFrameResponseCodec, result)
  }

  return Buffer.alloc(0)
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
  const feedEntries = listFromResponse(feedResult, 'entries')
  const subscriptions = listFromResponse(subscriptionsResult, 'subscriptions')
  const feedStats = feedResult?.stats || {}

  writeDebugLog(
    `[snapshot] feedEntries=${feedEntries.length} subscriptions=${subscriptions.length} identities=${identities.length} feedUpdates=${state.feedUpdateCount} feedPeers=${feedStats.peerCount ?? 0} feedTotal=${feedStats.totalEntries ?? 0}`
  )

  const snapshot = await buildBrowseSnapshot({
    feedEntries,
    subscriptions,
    identities,
    fetchChannelData,
    activeChannelPublished: Boolean(publishResult?.published),
  })

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

  writeDebugLog(
    `[snapshot] identity mutation snapshot identities=${identities.length} ` +
    `active=${snapshot.state.activeIdentityChannelKey || 'none'}`
  )

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

  return async function fetchChannelData(source) {
    const cacheKey = `${source.channelKey}:${source.publicBeeKey || ''}`
    if (channelCache.has(cacheKey)) return channelCache.get(cacheKey)

    const resultPromise = (async () => {
      try {
        const channelMeta = await withTimeout(() => client.channel.getChannelMeta({
          channelKey: source.channelKey,
          publicBeeKey: source.publicBeeKey || undefined,
        }), {})
        const videosResult = await withTimeout(() => client.video.listVideos({
          channelKey: source.channelKey,
          publicBeeKey: source.publicBeeKey || undefined,
          limit: 6,
          offset: 0,
        }), { videos: [] })
        const listedVideos = listFromResponse(videosResult, 'videos')
        const videos = []

        for (const video of listedVideos) {
          try {
            const metadata = await fetchVideoMetadata(source, video)
            videos.push(mergeVideoMetadata(video, metadata))
          } catch (error) {
            writeDebugLog(
              `[snapshot] video metadata failed channel=${source.channelKey.slice(0, 12)} ` +
              `video=${video?.id || 'unknown'} error=${error?.message || String(error)}`
            )
            videos.push(mergeVideoMetadata(video, null))
          }
        }

        return {
          channelMeta,
          videos,
        }
      } catch (error) {
        writeDebugLog(
          `[snapshot] channel fetch failed channel=${source.channelKey.slice(0, 12)} ` +
          `publicBee=${source.publicBeeKey?.slice(0, 12) || 'none'} error=${error?.message || String(error)}`
        )
        return {
          channelMeta: {},
          videos: [],
        }
      }
    })()

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

function normalizeMutationResponse(response) {
  return {
    success: Boolean(response?.success),
    queued: Boolean(response?.queued),
    error: response?.error || null,
    commentId: response?.commentId || null,
  }
}

async function handleRequest(state, request, onError) {
  const { command, data = null } = request || {}
  writeDebugLog(`[request] command=${command}`)

  if (command === DIAGNOSTIC_READ_IDENTITY_KEY_FILE_COMMAND) {
    const storagePath = data ? Buffer.from(data).toString('utf8') : defaultStoragePath()
    writeDebugLog(`[diagnostic] readIdentityKeyFile start storagePath=${storagePath}`)
    const result = await readIdentityKeyFile(storagePath)
    writeDebugLog(`[diagnostic] readIdentityKeyFile end present=${Boolean(result)}`)
    return result ? 'present' : 'missing'
  }

  if (command === bridgeRPC.BRIDGE_COMMANDS.bootstrap) {
    const params = bridgeRPC.decodePayload(bridgeRPC.bootstrapRequestCodec, data)
    writeDebugLog(`[bootstrap] decoded storagePath=${params.storagePath || defaultStoragePath()}`)
    const ready = await ensureHostBooted(
      state,
      params.storagePath || defaultStoragePath(),
      onError
    )
    writeDebugLog(`[bootstrap] host ready blobPort=${ready?.blobServerPort ?? 'null'}`)
    const snapshot = await loadBrowseSnapshot(state)
    writeDebugLog(`[bootstrap] browse snapshot loaded home=${snapshot?.stats?.homeCount ?? 'unknown'}`)

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
      const response = await client.feed.refreshFeed({})
      writeDebugLog(`[feed] refresh requested peerCount=${response?.peerCount ?? 0}`)
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
    return resolvePlaybackViaClient({
      client: state.client,
      params,
      log: (message) => console.log(`[native-host-worklet] ${message}`),
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
  writeDebugLog('[main] native host worklet booting')

  const reportFatal = (label, error) => {
    const message = `${label}: ${formatError(error)}`
    writeStderr(`[native-host-worklet] ${message}`)
    writeDebugLog(`[fatal] ${message}`)
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

  if (!globalThis?.BareKit || typeof BareKit.on !== 'function') {
    throw new Error('BareKit push bridge is unavailable in the native worklet')
  }

  BareKit.on('push', async (payload, reply) => {
    let request = null

    try {
      request = bridgeRPC.decodePayload(bridgeRPC.pushRequestCodec, payload)
      writeDebugLog(`[push] received command=${request.command}`)
      const result = await handleRequest(state, request, reportFatal)
      writeDebugLog(`[push] replying success command=${request.command}`)
      reply(null, encodeResultPayload(request.command, result))
    } catch (error) {
      reportFatal('Push request failed', error)
      writeDebugLog(`[push] replying error command=${request?.command ?? 'unknown'} message=${error?.message ?? String(error)}`)
      reply(new Error(error?.message ?? String(error)), null)
    }
  })
}

main().catch((error) => {
  const message = formatError(error)
  writeStderr(`[native-host-worklet] Bootstrap failed: ${message}`)
  writeDebugLog(`[main] bootstrap failed: ${message}`)
})
