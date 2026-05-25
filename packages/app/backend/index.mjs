/* eslint-disable no-empty, no-undef, @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-expressions */
/**
 * PearTube Mobile Backend Entry
 *
 * The module now exposes a testable `startMobileBackend()` entry that routes
 * lifecycle through `@peartube/host`, while preserving the existing BareKit
 * mobile runtime under the default `createMobileRuntimeBackend()` path.
 */

import { startHost } from '@peartube/host/start-host'
import { PROTOCOL_VERSION } from '@peartube/host'
import { createJsonFrameParser, encodeJsonFrame } from '@peartube/platform/ipc-json-framing'
import { attachLazyCastHandlers } from './lazy-cast-handlers.mjs'

let HRPC = null
let createBackendContext = null
let setIsShuttingDown = null
let shutdownBackend = null
let setCastActive = null
let isCastActive = null
let prefetchVideoForCast = null
let generateAndStoreThumbnail = null
let path = null
let fs = null
let b4a = null
let http1 = null
let transcoder = null
let castTranscoder = null
let fsNativeExtensions = null
let transcoderPromise = null
let castTranscoderPromise = null
let thumbnailModule = null
let thumbnailModulePromise = null
let httpModulePromise = null
let fsNativeExtensionsPromise = null

async function loadBackendModules() {
  const [
    specMod,
    orchestratorMod,
    storageMod,
    pathMod,
    fsMod,
    b4aMod
  ] = await Promise.all([
    import('@peartube/spec'),
    import('@peartube/backend/orchestrator'),
    import('@peartube/backend/storage'),
    import('bare-path'),
    import('bare-fs'),
    import('b4a')
  ])

  HRPC = specMod?.default ?? specMod
  createBackendContext = orchestratorMod?.createBackendContext
  setIsShuttingDown = orchestratorMod?.setIsShuttingDown
  shutdownBackend = storageMod?.shutdownBackend
  setCastActive = storageMod?.setCastActive
  isCastActive = storageMod?.isCastActive
  prefetchVideoForCast = storageMod?.prefetchVideoForCast
  path = pathMod?.default ?? pathMod
  fs = fsMod?.default ?? fsMod
  b4a = b4aMod?.default ?? b4aMod

  const checks = {
    HRPC,
    createBackendContext,
    setIsShuttingDown,
    shutdownBackend,
    setCastActive,
    isCastActive,
    prefetchVideoForCast,
    path,
    fs,
    b4a
  }

  const missing = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length) {
    throw new Error(`Missing required backend modules: ${missing.join(', ')}`)
  }
}

async function ensureBackendThumbnailModule() {
  if (thumbnailModule) return thumbnailModule
  if (!thumbnailModulePromise) {
    thumbnailModulePromise = import('@peartube/backend/thumbnail')
      .then((module) => {
        thumbnailModule = module
        generateAndStoreThumbnail = module?.generateAndStoreThumbnail
        return module
      })
      .catch((error) => {
        thumbnailModulePromise = null
        throw error
      })
  }

  return thumbnailModulePromise
}

async function ensureHttpModule() {
  if (http1) return http1
  if (!httpModulePromise) {
    httpModulePromise = import('bare-http1')
      .then((module) => {
        http1 = module?.default ?? module
        return http1
      })
      .catch((error) => {
        httpModulePromise = null
        throw error
      })
  }

  return httpModulePromise
}

async function ensureFsNativeExtensionsModule() {
  if (fsNativeExtensions) return fsNativeExtensions
  if (!fsNativeExtensionsPromise) {
    fsNativeExtensionsPromise = import('fs-native-extensions')
      .then((module) => {
        fsNativeExtensions = module?.default ?? module
        return fsNativeExtensions
      })
      .catch(() => {
        fsNativeExtensions = null
        return null
      })
  }

  return fsNativeExtensionsPromise
}

async function ensureTranscoderModule() {
  if (transcoder) return transcoder
  if (!transcoderPromise) {
    transcoderPromise = import('./transcoder.mjs')
      .then((module) => {
        transcoder = module
        return module
      })
      .catch((error) => {
        transcoderPromise = null
        throw error
      })
  }

  return transcoderPromise
}

async function ensureCastTranscoderModule() {
  if (castTranscoder) return castTranscoder
  if (!castTranscoderPromise) {
    castTranscoderPromise = import('@peartube/backend/transcode/cast-transcoder')
      .then((module) => {
        castTranscoder = module
        return module
      })
      .catch((error) => {
        castTranscoderPromise = null
        throw error
      })
  }

  return castTranscoderPromise
}

function formatError(error) {
  if (!error) return 'Unknown error'
  if (error instanceof Error) return error.stack || error.message || String(error)
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function attachUnhandledHandlers(reportBackendError) {
  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('unhandledRejection', (reason) => {
      try {
        console.error('[Backend] Unhandled rejection:', formatError(reason))
      } catch {}
      return true
    })

    Bare.on('uncaughtException', (error) => {
      try {
        console.error('[Backend] Uncaught exception:', formatError(error))
      } catch {}
      return true
    })
  }

  const proc = typeof process !== 'undefined' ? process : null
  if (proc?.on) {
    proc.on('unhandledRejection', (reason) => reportBackendError('Unhandled rejection', reason))
    proc.on('uncaughtException', (error) => reportBackendError('Uncaught exception', error))
  }

  if (typeof globalThis?.addEventListener === 'function') {
    globalThis.addEventListener('unhandledrejection', (event) => {
      reportBackendError('Unhandled rejection', event?.reason ?? event)
      event?.preventDefault?.()
    })

    globalThis.addEventListener('error', (event) => {
      reportBackendError('Uncaught error', event?.error ?? event?.message ?? event)
    })
  }
}

function attachMobileOnlyRpcHandlers(rpc, api) {
  if (typeof rpc.onSearchVideos === 'function') {
    rpc.onSearchVideos(async (request) => {
      try {
        const raw = await api.searchVideos(request.channelKey, request.query, {
          topK: request.topK || 10,
          federated: Boolean(request.federated)
        })

        return {
          results: (raw || []).map((result) => ({
            id: String(result.id || ''),
            score: result.score != null ? String(result.score) : null,
            metadata: result.metadata ? JSON.stringify(result.metadata) : null
          }))
        }
      } catch {
        return { results: [] }
      }
    })
  }

  if (typeof rpc.onGetRecommendations === 'function') {
    rpc.onGetRecommendations(async () => ({ success: true, recommendations: [] }))
  }

  if (typeof rpc.onGetVideoRecommendations === 'function') {
    rpc.onGetVideoRecommendations(async () => ({ success: true, recommendations: [] }))
  }

  if (typeof rpc.onIndexVideoVectors === 'function') {
    rpc.onIndexVideoVectors(async (request) => {
      try {
        const result = await api.indexVideoVectors?.(request.channelKey, request.videoId)
        return { success: Boolean(result?.success), error: result?.error || null }
      } catch (error) {
        return { success: false, error: error?.message }
      }
    })
  }

  if (typeof rpc.onLogWatchEvent === 'function') {
    rpc.onLogWatchEvent(async () => ({ success: true }))
  }

  if (typeof rpc.onRetrySyncChannel === 'function') {
    rpc.onRetrySyncChannel(async (request) => {
      try {
        await api.retrySyncChannel?.(request.channelKey)
        return { success: true }
      } catch (error) {
        return { success: false, error: error?.message }
      }
    })
  }
}

function resolveMobileStoragePath(providedStoragePath) {
  if (providedStoragePath) return providedStoragePath

  let bareStorageDir = ''
  try {
    bareStorageDir = require('bare-storage').persistent()
  } catch {}

  return Bare?.argv?.[0] || bareStorageDir || ''
}

function parseMobileLaunchArgs(args = []) {
  const first = args[0]
  if (typeof first !== 'string' || !first.trim().startsWith('{')) {
    return { launchOptions: null, workerArgs: args }
  }

  try {
    const parsed = JSON.parse(first)
    if (parsed?.__peartubeLaunchOptions === true) {
      return { launchOptions: parsed, workerArgs: args.slice(1) }
    }
  } catch {}

  return { launchOptions: null, workerArgs: args }
}

export async function startMobileBackend(options = {}) {
  const {
    storagePath: providedStoragePath,
    stream = globalThis.BareKit?.IPC,
    entrypoint = 'mobile-entry',
    args = (typeof Bare !== 'undefined' && Array.isArray(Bare?.argv)) ? Bare.argv.slice(1) : [],
    startHostImpl = startHost,
    createBackendImpl = createMobileRuntimeBackend,
    attachMobileHandlersImpl,
    attachCastHandlersImpl
  } = options

  const storagePath = resolveMobileStoragePath(providedStoragePath)

  return startHostImpl({
    platform: 'mobile',
    storagePath,
    entrypoint,
    args,
    stream,
    createBackendImpl: async (hostOptions) => {
      const backendSession = await createBackendImpl({
        ...hostOptions,
        storagePath: hostOptions.storagePath || storagePath,
        stream: hostOptions.stream || stream,
        args: hostOptions.args ?? args
      })

      if (backendSession?.backend && typeof attachMobileHandlersImpl === 'function') {
        attachMobileHandlersImpl(backendSession.backend, backendSession.handlerDeps ?? {})
      }

      if (backendSession?.backend && typeof attachCastHandlersImpl === 'function') {
        attachCastHandlersImpl(backendSession.backend, backendSession.handlerDeps ?? {})
      }

      return backendSession
    }
  })
}

export async function createMobileRuntimeBackend(options = {}) {
  const {
    storagePath,
    stream,
    args = [],
    onReady = () => {},
    onError = () => {}
  } = options

  if (!stream) throw new Error('createMobileRuntimeBackend requires a stream transport')
  if (!storagePath) throw new Error('createMobileRuntimeBackend requires a storagePath')

  const IPC = stream
  const { launchOptions, workerArgs } = parseMobileLaunchArgs(args)
  const workerBundlePath = workerArgs[0] || ''
  if (workerBundlePath) globalThis.__PEARTUBE_WORKER_PATH__ = workerBundlePath

  let rpc = null
  let handlersRegistered = false
  let ownerLockFd = -1
  let backendCtx = null
  let closeCastProxyServer = () => {}
  let feedRefreshInterval = null
  let shutdownInFlight = null

  function reportBackendError(label, error) {
    const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : 'Unknown error')
    console.error(`[Backend] ${label}:`, message)
    if (error?.stack) console.error(error.stack)
    try {
      rpc?.eventError?.({ message: `${label}: ${message}` })
    } catch {}
    try {
      onError(error instanceof Error ? error : new Error(message))
    } catch {}
  }

  function ensureRpc() {
    if (rpc) return true

    try {
      rpc = new HRPC(IPC)

      try {
        const rawRpc = rpc?._rpc
        if (rawRpc && !rawRpc._peartubeCompat) {
          const originalOnRequest = rawRpc._onrequest
          rawRpc._onrequest = async (request) => {
            try {
              const hasPayload = Boolean(request?.data && request.data.length > 0)
              if (request?.command === 16 && !hasPayload) request.command = 18
              if (request?.command === 24 && hasPayload) request.command = 30
            } catch {}

            if (!handlersRegistered) throw new Error('Backend not ready')

            try {
              return await originalOnRequest(request)
            } catch (error) {
              reportBackendError(`HRPC request failed (${request?.command})`, error)
              throw error
            }
          }
          rawRpc._peartubeCompat = true
        }
      } catch {}

      return true
    } catch (error) {
      console.log('[Backend] HRPC init failed:', error?.message)
      return false
    }
  }

  function ipcLog(message) {
    try {
      rpc?.eventLog?.({ level: 'info', message, timestamp: Date.now() })
    } catch {}
  }

  function closeOwnerLock() {
    if (ownerLockFd === -1) return
    const fd = ownerLockFd
    ownerLockFd = -1
    try { fsNativeExtensions?.unlock?.(fd) } catch {}
    try { fs.close(fd, () => {}) } catch {}
  }

  async function acquireOwnerLock(storageDir) {
    const extensions = await ensureFsNativeExtensionsModule()
    const tryLock = extensions?.tryLock
    if (typeof tryLock !== 'function') return

    const lockPath = path.join(storageDir, 'backend-owner.lock')
    const fd = await new Promise((resolve, reject) => {
      fs.open(lockPath, 'a+', (error, handle) => error ? reject(error) : resolve(handle))
    })

    let acquired = false
    for (let index = 0; index < 10; index++) {
      try {
        acquired = tryLock(fd)
      } catch {}
      if (acquired) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    if (!acquired) {
      try { fs.close(fd, () => {}) } catch {}
      return
    }

    ownerLockFd = fd
  }

function removeStaleLocks(storageDir) {
  try { fs.unlinkSync(path.join(storageDir, 'CORESTORE')) } catch (error) { if (error.code !== 'ENOENT') console.log('[Backend] CORESTORE cleanup skipped:', error.message) }
  try { fs.unlinkSync(path.join(storageDir, 'LOCK')) } catch (error) { if (error.code !== 'ENOENT') console.log('[Backend] LOCK cleanup skipped:', error.message) }
  try { fs.unlinkSync(path.join(storageDir, 'primary', 'LOCK')) } catch (error) { if (error?.code !== 'ENOENT') {} }
  try { fs.unlinkSync(path.join(storageDir, 'db', 'LOCK')) } catch (error) { if (error?.code !== 'ENOENT') {} }

  function removeDirRecursive(dir) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          const file = path.join(dir, entry)
          try {
            fs.statSync(file).isDirectory() ? removeDirRecursive(file) : fs.unlinkSync(file)
          } catch {}
        }
        fs.rmdirSync(dir)
      } catch {}
    }

    for (const name of ['logs', 'LOG', 'LOG.old', 'IDENTITY', 'CURRENT', 'MANIFEST-000001']) {
      const filePath = path.join(storageDir, name)
      try {
        fs.statSync(filePath).isDirectory() ? removeDirRecursive(filePath) : fs.unlinkSync(filePath)
      } catch {}
    }
  }

  const ipcFrameParser = createJsonFrameParser()

  function parseIpcMessage(chunk) {
    const messages = ipcFrameParser.push(chunk)
    return messages.length > 0 ? messages[0] : null
  }

  function encodeIpcMessage(value) {
    return b4a.from(encodeJsonFrame(value))
  }

  attachUnhandledHandlers(reportBackendError)
  await loadBackendModules()
  ensureRpc()

  const storageDir = path.join(storagePath, 'peartube-data')
  try { fs.mkdirSync(storageDir, { recursive: true }) } catch {}

  try {
    const lockPath = path.join(storageDir, 'backend-owner.lock')
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) {
        let alive = false
        try {
          process.kill(pid, 0)
          alive = true
        } catch {}
        if (!alive) fs.unlinkSync(lockPath)
      }
    }
  } catch {}

  await acquireOwnerLock(storageDir)
  ipcLog('[init] owner lock done')

  removeStaleLocks(storageDir)
  ipcLog('[init] CORESTORE + LOCK cleanup done')

  let backend = null
  try {
    ipcLog('[init] createBackendContext starting')
    backend = await createBackendContext({
      storagePath: storageDir,
      corestoreWaitForLock: false,
      network: launchOptions?.network,
      swarmOptions: launchOptions?.swarmOptions,
      ipcLog,
      onFeedUpdate: () => {
        try {
          rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' })
        } catch {}
      },
      onStatsUpdate: (driveKey, videoPath, stats) => {
        try {
          rpc?.eventVideoStats?.({
            stats: { videoId: videoPath, channelKey: driveKey, ...stats }
          })
        } catch {}
      }
    })
  } catch (error) {
    reportBackendError('Backend init failed', error)
    closeOwnerLock()
    throw error
  }

  const {
    ctx,
    api,
    identityManager,
    uploadManager,
    publicFeed,
    initializeIdentityFromMnemonic
  } = backend

  backendCtx = ctx

  ensureRpc()
  if (!rpc) {
    throw new Error('Failed to initialize HRPC transport')
  }

  const lazyTranscoder = {
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
    async probeMedia(...args) {
      const module = await ensureTranscoderModule()
      return module.probeMedia(...args)
    },
    async loadBareFfmpeg(...args) {
      const module = await ensureTranscoderModule()
      return module.loadBareFfmpeg(...args)
    }
  }

  const { attachMobileHandlers } = await import('./mobile-handlers.mjs')
  attachMobileHandlers(backend, {
    api,
    identityManager,
    uploadManager,
    ctx,
    initializeIdentityFromMnemonic,
    rpc,
    fs,
    path,
    generateAndStoreThumbnail: async (...args) => {
      const module = await ensureBackendThumbnailModule()
      return module.generateAndStoreThumbnail(...args)
    },
    transcoder: lazyTranscoder,
    storagePath
  })

  let castCleanup = { enterHeadlessMode: null, closeCastProxyServer: null }
  let castHandlersReadyPromise = null
  const ensureCastHandlersAttached = async () => {
    if (!castHandlersReadyPromise) {
      castHandlersReadyPromise = (async () => {
        const [
          { attachCastHandlers },
          transcoderModule,
          castTranscoderModule,
          httpModule,
        ] = await Promise.all([
          import('./mobile-cast.mjs'),
          ensureTranscoderModule(),
          ensureCastTranscoderModule(),
          ensureHttpModule(),
        ])

        castCleanup = attachCastHandlers(backend, {
          rpc,
          ctx,
          api,
          setCastActive,
          isCastActive,
          prefetchVideoForCast,
          http1: httpModule,
          path,
          fs,
          transcoder: transcoderModule,
          castTranscoder: castTranscoderModule,
          storagePath
        })

        closeCastProxyServer = castCleanup.closeCastProxyServer || (() => {})
      })().catch((error) => {
        castHandlersReadyPromise = null
        throw error
      })
    }

    return castHandlersReadyPromise
  }

  attachLazyCastHandlers(backend, ensureCastHandlersAttached)

  const { registerSharedHandlers } = await import('@peartube/backend/hrpc-handlers')
  registerSharedHandlers(rpc, backend)
  handlersRegistered = true
  attachMobileOnlyRpcHandlers(rpc, api)

  async function destroy() {
    if (shutdownInFlight) return shutdownInFlight

    shutdownInFlight = (async () => {
      setIsShuttingDown(true)
      if (feedRefreshInterval) clearInterval(feedRefreshInterval)
      await shutdownBackend(ctx)
      closeCastProxyServer('host-terminate')
      closeOwnerLock()
    })().finally(() => {
      shutdownInFlight = null
    })

    return shutdownInFlight
  }

  if (IPC?.on) {
    IPC.on('data', (chunk) => {
      const message = parseIpcMessage(chunk)
      if (message?.type !== 'shutdown') return

      destroy()
        .then(() => {
          try {
            IPC.write(encodeIpcMessage({ type: 'shutdown-complete' }))
          } catch {}
        })
        .catch(() => {})
    })

    IPC.on('close', () => castCleanup.enterHeadlessMode?.('ipc-close'))
    IPC.on('end', () => castCleanup.enterHeadlessMode?.('ipc-end'))
  }

  async function restoreFeedCache() {
    try {
      const cache = await ctx.metaDb.get('public-feed-cache').catch(() => null)
      const entries = cache?.value || []
      if (!Array.isArray(entries) || entries.length === 0) return
      for (const entry of entries) {
        try {
          if (typeof entry === 'object' && entry.driveKey) {
            publicFeed.addEntry(entry.driveKey, 'peer', entry.publicBeeKey || null)
          } else if (typeof entry === 'string') {
            publicFeed.addEntry(entry, 'peer')
          }
        } catch {}
      }
    } catch {}
  }

  async function persistFeedCache() {
    try {
      await ctx.metaDb.put(
        'public-feed-cache',
        publicFeed.getFeed().map((entry) => ({
          driveKey: entry.driveKey,
          publicBeeKey: entry.publicBeeKey || null
        }))
      )
    } catch {}
  }

  await restoreFeedCache()

  const blobPort = ctx.blobServer?.port || ctx.blobServerPort || 0
  onReady({ blobServerPort: blobPort, protocolVersion: PROTOCOL_VERSION })

  try {
    rpc.eventReady({
      blobServerPort: blobPort,
      blobServerHost: ctx.blobServerHost || '127.0.0.1'
    })
    rpc.eventFeedUpdate({ channelKey: 'feed', action: 'update' })
  } catch (error) {
    console.error('[Backend] Failed to send eventReady:', error.message)
  }

  feedRefreshInterval = setInterval(() => {
    try {
      publicFeed.requestFeedsFromPeers()
      persistFeedCache()
    } catch {}
  }, 30000)

  publicFeed.setOnFeedUpdate(() => {
    persistFeedCache()
    try {
      rpc?.eventFeedUpdate?.({ channelKey: 'feed', action: 'update' })
    } catch {}
  })

  if (typeof Bare !== 'undefined' && Bare?.on) {
    Bare.on('exit', () => {
      if (!backendCtx?._isShutdown) destroy().catch(() => {})
      return true
    })
  }

  if (typeof process !== 'undefined' && process?.on) {
    process.on('exit', () => closeOwnerLock())
  }

  if (typeof process !== 'undefined' && process?.env?.PEARTUBE_PRELOAD_FFMPEG === '1') {
    lazyTranscoder.loadBareFfmpeg().catch(() => {})
  }

  return {
    rpc,
    backend,
    handlerDeps: {
      api,
      identityManager,
      uploadManager,
      ctx,
      initializeIdentityFromMnemonic,
      rpc,
      fs,
      path,
      generateAndStoreThumbnail: async (...args) => {
        const module = await ensureBackendThumbnailModule()
        return module.generateAndStoreThumbnail(...args)
      },
      transcoder: lazyTranscoder,
      storagePath
    },
    destroy
  }
}

if (globalThis.BareKit?.IPC && (typeof Bare !== 'undefined')) {
  await startMobileBackend()
}
