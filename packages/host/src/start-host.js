/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
import { createHostError, HOST_ERROR_CODES, PROTOCOL_VERSION } from './contracts.js'

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

function createLifecycleController() {
  const listeners = new Set()

  return {
    emit(event) {
      for (const listener of listeners) listener(event)
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function validateStartOptions(options) {
  const {
    platform = 'desktop',
    storagePath,
    entrypoint,
    args = [],
    stream,
    createBackendImpl,
    onFeedUpdate,
    onVideoStats,
    network,
    swarmOptions
  } = options

  if (platform !== 'desktop' && platform !== 'mobile') {
    throw new Error('startHost requires platform to be "mobile" or "desktop"')
  }

  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    throw new Error('startHost requires a non-empty storagePath')
  }

  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    throw new Error('startHost requires a non-empty entrypoint')
  }

  if (!Array.isArray(args)) {
    throw new Error('startHost requires args to be an array when provided')
  }

  if (!stream || typeof stream !== 'object') {
    throw new Error('startHost requires a duplex stream transport')
  }

  if (createBackendImpl !== undefined && typeof createBackendImpl !== 'function') {
    throw new Error('startHost requires createBackendImpl to be a function when provided')
  }

  if (onFeedUpdate !== undefined && typeof onFeedUpdate !== 'function') {
    throw new Error('startHost requires onFeedUpdate to be a function when provided')
  }

  if (onVideoStats !== undefined && typeof onVideoStats !== 'function') {
    throw new Error('startHost requires onVideoStats to be a function when provided')
  }
}

async function loadCreateBackend() {
  const module = await import('@peartube/backend/backend-entry')
  return module.createBackend
}

function normalizeHostError(error, fallbackCode = HOST_ERROR_CODES.HOST_START_FAILED) {
  if (error instanceof Error && error.code) return error

  const message = error instanceof Error ? error.message : String(error)
  return createHostError(fallbackCode, message, { cause: error })
}

function normalizeReadyPayload(payload = {}) {
  return {
    blobServerPort: payload?.blobServerPort ?? null,
    blobServerReady: Boolean(payload?.blobServerReady),
    blobServerError: payload?.blobServerError ?? null,
    protocolVersion: payload?.protocolVersion ?? PROTOCOL_VERSION
  }
}

export async function startHost(options = {}) {
  validateStartOptions(options)

  const {
    platform = 'desktop',
    storagePath,
    entrypoint,
    args = [],
    stream,
    createBackendImpl,
    onFeedUpdate,
    onVideoStats,
    network,
    swarmOptions
  } = options

  const lifecycle = createLifecycleController()
  const onLifecycle = typeof options.onLifecycle === 'function' ? options.onLifecycle : noop
  const emitLifecycle = (event) => {
    lifecycle.emit(event)
    onLifecycle(event)
  }

  let settleReady = noop
  let failReady = noop
  let readySettled = false
  const readyPromise = new Promise((resolve, reject) => {
    settleReady = (value) => {
      if (readySettled) return
      readySettled = true
      resolve(value)
    }
    failReady = (error) => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
  })

  const createBackend = createBackendImpl ?? await loadCreateBackend()
  await appendDebugLine(`[startHost] createBackend loaded platform=${platform} storagePath=${storagePath}`)

  try {
    await appendDebugLine('[startHost] invoking createBackend')
    const backendSession = await createBackend({
      platform,
      storagePath,
      stream,
      entrypoint,
      args,
      protocolVersion: PROTOCOL_VERSION,
      network,
      swarmOptions,
      onFeedUpdate,
      onVideoStats,
      onReady(payload = {}) {
        const readyData = normalizeReadyPayload(payload)

        settleReady(readyData)
        emitLifecycle({ type: 'host.ready', data: readyData })
        void appendDebugLine(
          `[startHost] onReady blobServerPort=${readyData.blobServerPort} protocolVersion=${readyData.protocolVersion}`
        )
      },
      onError(error) {
        const normalized = normalizeHostError(error)
        failReady(normalized)
        emitLifecycle({
          type: 'host.error',
          code: normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED,
          message: normalized.message,
          retryable: Boolean(normalized.retryable)
        })
        void appendDebugLine(
          `[startHost] onError code=${normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED} message=${normalized.message}`
        )
      }
    })
    await appendDebugLine('[startHost] createBackend resolved')

    let terminated = false

    return {
      stream,
      entrypoint,
      args,
      waitUntilReady() {
        return readyPromise
      },
      async terminate() {
        if (terminated) return
        terminated = true
        await backendSession?.destroy?.()
      },
      onLifecycle(listener) {
        return lifecycle.on(listener)
      }
    }
  } catch (error) {
    const normalized = normalizeHostError(error)
    failReady(normalized)
    await appendDebugLine(
      `[startHost] createBackend threw code=${normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED} message=${normalized.message}`
    )
    emitLifecycle({
      type: 'host.error',
      code: normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED,
      message: normalized.message,
      retryable: Boolean(normalized.retryable)
    })
    throw normalized
  }
}
