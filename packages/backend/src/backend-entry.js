function noop() {}
const PROTOCOL_VERSION = 1

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

export async function createBackend(opts = {}) {
  const {
    storagePath,
    stream,
    platform = 'desktop',
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
      { attachMobileHandlers },
    ] = await Promise.all([
      import('./orchestrator.js'),
      import('./storage.js'),
      import('../../spec/spec/hrpc/index.js'),
      import('./hrpc-handlers.js'),
      import('../../app/backend/mobile-handlers.mjs'),
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

    attachMobileHandlers(backend, {
      api: backend.api,
      identityManager: backend.identityManager,
      uploadManager: backend.uploadManager,
      ctx: backend.ctx,
      initializeIdentityFromMnemonic:
        typeof backend.initializeIdentityFromMnemonic === 'function'
          ? backend.initializeIdentityFromMnemonic.bind(backend)
          : async () => ({ needsRestart: false }),
      rpc,
      fs: null,
      path: null,
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
    await appendDebugLine('[createBackend] mobile-style handler adapters attached')

    await appendDebugLine('[createBackend] constructing HRPC')
    rpc = new HRPC(stream)
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
