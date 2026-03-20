function noop() {}
const PROTOCOL_VERSION = 1

function toCallback(fn) {
  return typeof fn === 'function' ? fn : noop
}

function getBlobServerPort(backend) {
  return backend?.ctx?.blobServer?.port || backend?.ctx?.blobServerPort || 0
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

  try {
    const [{ createBackendContext }, { shutdownBackend }, specModule, { registerSharedHandlers }] = await Promise.all([
      import('./orchestrator.js'),
      import('./storage.js'),
      import('@peartube/spec'),
      import('./hrpc-handlers.js')
    ])

    const HRPC = specModule?.default ?? specModule
    const backend = await createBackendContext({
      storagePath,
      onStatsUpdate: onVideoStats,
      ...lifecycleOptions
    })

    const rpc = new HRPC(stream)
    registerSharedHandlers(rpc, backend)

    readyCallback({ blobServerPort: getBlobServerPort(backend), protocolVersion: PROTOCOL_VERSION })

    let destroyed = false
    const destroy = async () => {
      if (destroyed) return
      destroyed = true
      await shutdownBackend(backend?.ctx)
    }

    return { rpc, backend, destroy }
  } catch (err) {
    errorCallback(err)
    throw err
  }
}

export default {
  createBackend
}
