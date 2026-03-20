import { createHostError, HOST_ERROR_CODES, PROTOCOL_VERSION } from './contracts.js'

function noop() {}

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
    createBackendImpl
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

export async function startHost(options = {}) {
  validateStartOptions(options)

  const {
    platform = 'desktop',
    storagePath,
    entrypoint,
    args = [],
    stream,
    createBackendImpl
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

  try {
    const backendSession = await createBackend({
      platform,
      storagePath,
      stream,
      entrypoint,
      args,
      onReady(payload = {}) {
        const readyData = {
          blobServerPort: payload?.blobServerPort ?? null,
          protocolVersion: payload?.protocolVersion ?? PROTOCOL_VERSION
        }

        settleReady(readyData)
        emitLifecycle({ type: 'host.ready', data: readyData })
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
      }
    })

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
    emitLifecycle({
      type: 'host.error',
      code: normalized.code ?? HOST_ERROR_CODES.HOST_START_FAILED,
      message: normalized.message,
      retryable: Boolean(normalized.retryable)
    })
    throw normalized
  }
}
