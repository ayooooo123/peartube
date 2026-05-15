import { PROTOCOL_VERSION } from '@peartube/host'
import { createUniversalCore, createUniversalHrpcSurface } from './universal-core.js'

function noop() {}

function toCallback(fn) {
  return typeof fn === 'function' ? fn : noop
}

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
  } catch {
    // Debug logging must never affect backend startup.
  }
}

function getBlobServerStatus(backend) {
  const ctx = backend?.ctx
  const port = Number(ctx?.blobServer?.port || ctx?.blobServerPort || 0) || 0
  const error = ctx?.blobServer?._peartubeListenError || ctx?.blobServerError || null
  return {
    blobServerPort: port > 0 ? port : null,
    blobServerReady: port > 0 && !error,
    blobServerError: error ? (error?.message || String(error)) : null
  }
}

function getBlobServerPort(backend) {
  return getBlobServerStatus(backend).blobServerPort || 0
}

function getIdentityCount(backend) {
  return backend?.identityManager?.getIdentities?.().length || 0
}

function buildSharedSystemHandlers(backend) {
  return {
    async DesktopBootstrap(req) {
      const emptySnapshot = {
        generatedAt: Date.now(),
        sections: { home: [], subscriptions: [], library: [], studio: [], diagnostics: [] },
        stats: { homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0 },
        state: { subscriptionChannelKeys: [], identityChannelKeys: [], activeIdentityName: '', activeIdentityChannelKey: '', activeChannelPublished: false }
      }
      return {
        ...getBlobServerStatus(backend),
        protocolVersion: PROTOCOL_VERSION,
        storagePath: req?.storagePath || '',
        snapshot: emptySnapshot
      }
    },
    async DesktopShutdown() {
      return { success: true }
    },
    async DesktopRefreshBrowse() {
      return {
        snapshot: {
          generatedAt: Date.now(),
          sections: { home: [], subscriptions: [], library: [], studio: [], diagnostics: [] },
          stats: { homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0 },
          state: { subscriptionChannelKeys: [], identityChannelKeys: [], activeIdentityName: '', activeIdentityChannelKey: '', activeChannelPublished: false }
        }
      }
    },
    async FfmpegDecodeAvailable() {
      return { available: false, error: 'Not supported on this platform' }
    },
    async GetStatus() {
      return {
        status: {
          ready: true,
          hasIdentity: getIdentityCount(backend) > 0,
          ...getBlobServerStatus(backend)
        }
      }
    },
    async GetBlobServerPort() {
      return { port: getBlobServerPort(backend) }
    },
    async GetSwarmStatus() {
      const swarmStatus = backend?.api?.getSwarmStatus?.() || {}
      const peerCount = swarmStatus.peerCount ?? swarmStatus.swarmConnections ?? 0

      return {
        connected: peerCount > 0,
        peerCount
      }
    }
  }
}

export async function attachSharedAppHandlers(options) {
  const {
    backend,
    api,
    identityManager,
    uploadManager,
    ctx,
    rpc,
    storagePath,
    autoAttachSharedAppHandlers = false,
    loadSharedAppHandlers = () => import('./mobile-handlers.js')
  } = options

  if (!autoAttachSharedAppHandlers) return false

  const { attachMobileHandlers } = await loadSharedAppHandlers()
  if (typeof attachMobileHandlers !== 'function') return false

  attachMobileHandlers(backend, {
    api,
    identityManager,
    uploadManager,
    ctx,
    initializeIdentityFromMnemonic:
      typeof backend?.initializeIdentityFromMnemonic === 'function'
        ? backend.initializeIdentityFromMnemonic.bind(backend)
        : async () => ({ needsRestart: false }),
    rpc,
    fs: null,
    path: null,
    storagePath,
    generateAndStoreThumbnail: async () => null,
    transcoder: {
      async startTranscode() {
        return { success: false, error: 'Transcoding is not wired in the embedded native host yet.' }
      },
      stopTranscode() {
        return { success: false, error: 'Transcoding is not wired in the embedded native host yet.' }
      },
      getStatus() {
        return { status: 'unavailable', progress: 0, bytesWritten: 0, error: 'Transcoding is not wired in the embedded native host yet.' }
      }
    }
  })

  return true
}

export function createBackendRuntime(opts = {}) {
  const {
    storagePath,
    stream,
    platform = 'desktop',
    autoAttachSharedAppHandlers = false,
    loadSharedAppHandlers,
    onReady,
    onError,
    onVideoStats,
    ...lifecycleOptions
  } = opts

  const readyCallback = toCallback(onReady)
  const errorCallback = toCallback(onError)

  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    throw new Error('createBackendRuntime requires a non-empty storagePath')
  }

  if (!stream || typeof stream !== 'object') {
    throw new Error('createBackendRuntime requires a duplex stream transport')
  }

  if (platform !== 'mobile' && platform !== 'desktop') {
    throw new Error('createBackendRuntime requires platform to be "mobile" or "desktop"')
  }

  let backend = null
  let rpc = null
  let core = null
  let disposed = false
  let disposeRequested = false
  let initPromise = null

  const dispose = async () => {
    disposeRequested = true
    if (disposed) return
    disposed = true

    if (!backend && !core) return

    if (core && typeof core.shutdown === 'function') {
      await core.shutdown()
      return
    }

    const { shutdownBackend } = await import('./storage.js')
    await shutdownBackend(backend?.ctx)
  }

  const init = async () => {
    if (backend) return { backend, rpc, dispose }
    if (initPromise) return initPromise

    initPromise = (async () => {
      try {
        await appendDebugLine('[runtime] importing spec/handlers')
        const [
          specModule,
          { registerSharedHandlers },
        ] = await Promise.all([
          import('@peartube/spec'),
          import('./hrpc-handlers.js'),
        ])

        const HRPC = specModule?.default ?? specModule
        await appendDebugLine('[runtime] creating universal core')
        core = createUniversalCore({
          storagePath,
          platform,
          runtime: { stream },
          hrpc: null,
          onStatsUpdate: onVideoStats,
          ...lifecycleOptions
        })
        backend = await core.init()

        if (disposeRequested) {
          await core.shutdown()
          return { backend, rpc, dispose }
        }
        backend.sharedHandlers = {
          ...(backend.sharedHandlers || {}),
          ...buildSharedSystemHandlers(backend)
        }

        rpc = new HRPC(stream)
        if (core.services) core.services.hrpc = rpc
        if (backend) backend.universalCore = core

        if (disposeRequested) {
          await core.shutdown()
          return { backend, rpc, dispose }
        }

        const attachedSharedAppHandlers = await attachSharedAppHandlers({
          backend,
          api: backend.api,
          identityManager: backend.identityManager,
          uploadManager: backend.uploadManager,
          ctx: backend.ctx,
          rpc,
          storagePath,
          autoAttachSharedAppHandlers,
          loadSharedAppHandlers
        })
        if (attachedSharedAppHandlers) {
          await appendDebugLine('[runtime] shared app handler adapters attached')
        }

        registerSharedHandlers(rpc, backend)
        const universalHandlers = createUniversalHrpcSurface(core)
        for (const [name, handler] of Object.entries(universalHandlers)) {
          if (typeof rpc.respond === 'function') rpc.respond(name, handler)
          else rpc[name] = handler
        }
        await core.start()

        const blobStatus = getBlobServerStatus(backend)
        const readyPayload = { ...blobStatus, protocolVersion: PROTOCOL_VERSION }
        readyCallback(readyPayload)
        if (blobStatus.blobServerError) {
          try {
            rpc.eventError?.({
              code: 'BLOB_SERVER_UNAVAILABLE',
              message: blobStatus.blobServerError,
              retryable: true
            })
          } catch {
            // Preserve backend readiness if degraded error emission fails.
          }
        }
        try {
          rpc.eventReady?.(readyPayload)
        } catch {
          // Older HRPC shims may not expose ready events.
        }

        return { backend, rpc, dispose }
      } catch (err) {
        await appendDebugLine(`[runtime] error ${err?.message || String(err)}`)
        errorCallback(err)
        try {
          rpc?.eventError?.({
            code: err?.code || 'HOST_START_FAILED',
            message: err?.message || String(err),
            retryable: false
          })
        } catch {
          // Preserve the original startup error if event emission fails.
        }
        throw err
      } finally {
        initPromise = null
      }
    })()

    return initPromise
  }

  return {
    init,
    dispose,
    get backend() { return backend },
    get rpc() { return rpc },
    get ready() { return Boolean(backend && rpc) },
  }
}

export default {
  createBackendRuntime
}
