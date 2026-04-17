import { PROTOCOL_VERSION } from '@peartube/host'

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
  } catch {}
}

function getBlobServerPort(backend) {
  return backend?.ctx?.blobServer?.port || backend?.ctx?.blobServerPort || 0
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
        blobServerPort: getBlobServerPort(backend),
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
          blobServerPort: getBlobServerPort(backend)
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

async function attachSharedAppHandlers(options) {
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
  let disposed = false
  let disposeRequested = false
  let initPromise = null

  const dispose = async () => {
    disposeRequested = true
    if (disposed) return
    disposed = true

    if (!backend) return

    const { shutdownBackend } = await import('./storage.js')
    await shutdownBackend(backend?.ctx)
  }

  const init = async () => {
    if (backend) return { backend, rpc, dispose }
    if (initPromise) return initPromise

    initPromise = (async () => {
      try {
        await appendDebugLine('[runtime] importing orchestrator/spec/handlers')
        const [
          { createBackendContext },
          specModule,
          { registerSharedHandlers },
        ] = await Promise.all([
          import('./orchestrator.js'),
          import('@peartube/spec'),
          import('./hrpc-handlers.js'),
        ])

        const HRPC = specModule?.default ?? specModule
        await appendDebugLine('[runtime] creating backend context')
        backend = await createBackendContext({
          storagePath,
          onStatsUpdate: onVideoStats,
          ...lifecycleOptions
        })

        if (disposeRequested) {
          const { shutdownBackend } = await import('./storage.js')
          await shutdownBackend(backend?.ctx)
          return { backend, rpc, dispose }
        }
        backend.sharedHandlers = {
          ...(backend.sharedHandlers || {}),
          ...buildSharedSystemHandlers(backend)
        }

        rpc = new HRPC(stream)

        if (disposeRequested) {
          const { shutdownBackend } = await import('./storage.js')
          await shutdownBackend(backend?.ctx)
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

        const readyPayload = { blobServerPort: getBlobServerPort(backend), protocolVersion: PROTOCOL_VERSION }
        readyCallback(readyPayload)
        try {
          rpc.eventReady?.(readyPayload)
        } catch {}

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
        } catch {}
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
