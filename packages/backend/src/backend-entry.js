function noop() {}
const PROTOCOL_VERSION = 1

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
    const [{ createBackendContext }, { shutdownBackend }, specModule, { registerSharedHandlers }] = await Promise.all([
      import('./orchestrator.js'),
      import('./storage.js'),
      import('../../spec/spec/hrpc/index.js'),
      import('./hrpc-handlers.js')
    ])

    const HRPC = specModule?.default ?? specModule
    const backend = await createBackendContext({
      storagePath,
      onStatsUpdate: onVideoStats,
      ...lifecycleOptions
    })
    backend.sharedHandlers = {
      ...(backend.sharedHandlers || {}),
      ...buildSharedSystemHandlers(backend)
    }

    rpc = new HRPC(stream)
    registerSharedHandlers(rpc, backend)

    const readyPayload = { blobServerPort: getBlobServerPort(backend), protocolVersion: PROTOCOL_VERSION }
    readyCallback(readyPayload)
    try {
      rpc.eventReady?.(readyPayload)
    } catch {}

    let destroyed = false
    const destroy = async () => {
      if (destroyed) return
      destroyed = true
      await shutdownBackend(backend?.ctx)
    }

    return { rpc, backend, destroy }
  } catch (err) {
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
