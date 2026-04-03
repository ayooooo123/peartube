import { PROTOCOL_VERSION } from '@peartube/host'

function noop() {}

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

function toCallback(fn) {
  return typeof fn === 'function' ? fn : noop
}

function getBlobServerPort(backend) {
  return backend?.ctx?.blobServer?.port || backend?.ctx?.blobServerPort || 0
}

function getIdentityCount(backend) {
  return backend?.identityManager?.getIdentities?.().length || 0
}

function buildSharedSystemHandlers(backend) {
  return {
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

export async function attachSharedAppHandlers(options = {}) {
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

  if (!autoAttachSharedAppHandlers) {
    return false
  }

  const { attachMobileHandlers } = await loadSharedAppHandlers()
  if (typeof attachMobileHandlers !== 'function') {
    return false
  }

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

export async function createBackend(opts = {}) {
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
    throw new Error('createBackend requires a non-empty storagePath')
  }

  if (!stream || typeof stream !== 'object') {
    throw new Error('createBackend requires a duplex stream transport')
  }

  if (platform !== 'mobile' && platform !== 'desktop') {
    throw new Error('createBackend requires platform to be "mobile" or "desktop"')
  }

  let rpc = null

  try {
    await appendDebugLine('[createBackend] importing orchestrator/storage/spec/handlers')
    const [
      { createBackendContext },
      { shutdownBackend },
      specModule,
      { registerSharedHandlers },
    ] = await Promise.all([
      import('./orchestrator.js'),
      import('./storage.js'),
      import('@peartube/spec'),
      import('./hrpc-handlers.js'),
    ])

    const HRPC = specModule?.default ?? specModule
    await appendDebugLine('[createBackend] creating backend context')
    const backend = await createBackendContext({
      storagePath,
      onStatsUpdate: onVideoStats,
      ...lifecycleOptions
    })
    await appendDebugLine('[createBackend] backend context ready')
    backend.sharedHandlers = {
      ...(backend.sharedHandlers || {}),
      ...buildSharedSystemHandlers(backend)
    }

    await appendDebugLine('[createBackend] constructing HRPC')
    rpc = new HRPC(stream)

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
      await appendDebugLine('[createBackend] shared app handler adapters attached')
    }

    await appendDebugLine('[createBackend] registering shared handlers')
    registerSharedHandlers(rpc, backend)
    await appendDebugLine('[createBackend] shared handlers registered')

    const readyPayload = { blobServerPort: getBlobServerPort(backend), protocolVersion: PROTOCOL_VERSION }
    await appendDebugLine(
      `[createBackend] invoking ready callback blobServerPort=${readyPayload.blobServerPort} protocolVersion=${readyPayload.protocolVersion}`
    )
    readyCallback(readyPayload)
    try {
      rpc.eventReady?.(readyPayload)
      await appendDebugLine('[createBackend] rpc.eventReady emitted')
    } catch {}

    let destroyed = false
    const destroy = async () => {
      if (destroyed) return
      destroyed = true
      await shutdownBackend(backend?.ctx)
    }

    return { rpc, backend, destroy }
  } catch (err) {
    await appendDebugLine(`[createBackend] error ${err?.message || String(err)}`)
    errorCallback(err)
    try {
      rpc?.eventError?.({
        code: err?.code || 'HOST_START_FAILED',
        message: err?.message || String(err),
        retryable: false
      })
    } catch {}
    throw err
  }
}

export default {
  createBackend
}
