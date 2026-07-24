import {
  attachSharedAppHandlers,
  buildSharedSystemHandlers,
  requireHostProtocolVersion
} from './runtime.js'
import { createBackendContext } from './orchestrator.js'
import { createUniversalCore } from './universal-core.js'
import { registerSharedHandlers } from './hrpc-handlers.js'

function noop() {}

function toCallback(fn) {
  return typeof fn === 'function' ? fn : noop
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
    protocolVersion,
    HRPCImpl = null,
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

  const hostProtocolVersion = requireHostProtocolVersion(
    protocolVersion,
    'createBackend'
  )

  let core = null
  let backend = null
  let rpc = null
  let destroyPromise = null

  function destroy() {
    if (!destroyPromise) {
      destroyPromise = Promise.resolve().then(() => core?.shutdown?.())
    }
    return destroyPromise
  }

  try {
    core = createUniversalCore({
      storagePath,
      platform,
      runtime: { stream },
      hrpc: null,
      createBackendContext,
      onStatsUpdate: onVideoStats,
      ...lifecycleOptions
    })

    backend = await core.init()
    backend.sharedHandlers = {
      ...(backend.sharedHandlers || {}),
      ...buildSharedSystemHandlers(backend, { protocolVersion: hostProtocolVersion })
    }

    const resolvedHRPCImpl = HRPCImpl || (await import('@peartube/spec'))
    const HRPC = resolvedHRPCImpl?.default ?? resolvedHRPCImpl
    rpc = new HRPC(stream)
    if (core.services) core.services.hrpc = rpc
    backend.universalCore = core

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
    if (attachedSharedAppHandlers && typeof opts.ipcLog === 'function') {
      opts.ipcLog('shared app handler adapters attached')
    }

    registerSharedHandlers(rpc, backend)
    await core.start()

    const readyPayload = { ...getBlobServerStatus(backend), protocolVersion: hostProtocolVersion }
    readyCallback(readyPayload)
    try {
      rpc.eventReady?.(readyPayload)
    } catch {
      // Older HRPC shims may not expose ready events.
    }

    return {
      core,
      runtime: core,
      backend,
      rpc,
      destroy
    }
  } catch (error) {
    errorCallback(error)
    try {
      rpc?.eventError?.({
        code: error?.code || 'HOST_START_FAILED',
        message: error?.message || String(error),
        retryable: false
      })
    } catch {
      // Preserve the original startup error if event emission fails.
    }
    await destroy()
    throw error
  }
}

export { attachSharedAppHandlers }

export default {
  createBackend,
  attachSharedAppHandlers
}
