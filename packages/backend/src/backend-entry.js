import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function noop() {}

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
    const [{ createBackendContext }, { shutdownBackend }, specModule] = await Promise.all([
      import('./orchestrator.js'),
      import('./storage.js'),
      import('@peartube/spec')
    ])

    const HRPC = specModule?.default ?? specModule
    const backend = await createBackendContext({
      storagePath,
      onStatsUpdate: onVideoStats,
      ...lifecycleOptions
    })

    const rpc = new HRPC(stream)
    const { registerSharedHandlers } = require('./hrpc-handlers')
    await registerSharedHandlers(rpc, backend, { platform })

    readyCallback({ blobServerPort: getBlobServerPort(backend) })

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
