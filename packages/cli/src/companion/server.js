import AbortController from 'abort-controller'

import b4a from 'b4a'

import { createServer as defaultCreateServer } from '#http'

import {
  CompanionAuthError,
  createBodyHasher,
  createNonceStore,
  prevalidateControlRequest,
  verifyPrevalidatedControlRequest
} from './auth.js'
import { createCompanionRouter } from './routes.js'
import { createCompanionStreamRoute } from './stream-route.js'

const MAX_ERROR_BYTES = 512

class CompanionRequestError extends Error {
  constructor (statusCode, code, message, closeConnection = false) {
    super(message)
    this.name = 'CompanionRequestError'
    this.statusCode = statusCode
    this.code = code
    this.closeConnection = closeConnection
  }
}

function publicError (error) {
  if (error instanceof CompanionAuthError || error instanceof CompanionRequestError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message
    }
  }
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Companion request failed'
  }
}

function sendJson (response, statusCode, value, headers = {}) {
  let body = b4a.from(JSON.stringify(value))
  if (statusCode >= 400 && body.byteLength > MAX_ERROR_BYTES) {
    body = b4a.from('{"error":{"code":"INTERNAL_ERROR","message":"Companion request failed"}}')
    statusCode = 500
  }
  response.statusCode = statusCode
  for (const [name, headerValue] of Object.entries(headers)) response.setHeader(name, headerValue)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', body.byteLength)
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function loopbackAddress (address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

function readBody (request, maxBodyBytes) {
  const declaredLength = request.headers?.['content-length']
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      request.pause?.()
      throw new CompanionRequestError(400, 'INVALID_CONTENT_LENGTH', 'Invalid companion content length', true)
    }
    if (parsedLength > maxBodyBytes) {
      request.pause?.()
      throw new CompanionRequestError(413, 'REQUEST_TOO_LARGE', 'Companion request body is too large', true)
    }
  }

  return new Promise((resolve, reject) => {
    const hasher = createBodyHasher()
    const chunks = []
    let bytes = 0
    let done = false
    const fail = (error) => {
      if (done) return
      done = true
      request.pause?.()
      error.closeConnection = true
      reject(error)
    }

    request.on('data', (chunk) => {
      if (done) return
      bytes += chunk.byteLength
      if (bytes > maxBodyBytes) {
        fail(new CompanionRequestError(413, 'REQUEST_TOO_LARGE', 'Companion request body is too large', true))
        return
      }
      const buffered = b4a.from(chunk)
      chunks.push(buffered)
      hasher.update(buffered)
    })
    request.once('end', () => {
      if (done) return
      done = true
      resolve({
        body: chunks.length === 0 ? b4a.alloc(0) : b4a.concat(chunks, bytes),
        bodyHash: hasher.digest()
      })
    })
    request.once('aborted', () => fail(new CompanionRequestError(400, 'REQUEST_ABORTED', 'Companion request was aborted', true)))
    request.once('error', () => fail(new CompanionRequestError(400, 'REQUEST_FAILED', 'Companion request failed', true)))
  })
}


function listen (server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener?.('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener?.('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options)
  })
}

function closeHttpServer (server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
  })
}

export function createCompanionServer ({
  service,
  config,
  clock = Date.now,
  nonceStore = null,
  capabilities = null,
  logger = null,
  createServer = null,
  requestDeadlineMs = 30_000,
  streamChunkBytes = undefined,
  streamWriteIdleMs = undefined
} = {}) {
  if (!service) throw new Error('service is required')
  if (!config) throw new Error('companion config is required')
  if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs <= 0) {
    throw new Error('companion request deadline must be a positive integer')
  }
  const publisherId = config.publisherId && /^[0-9a-f]{64}$/.test(config.publisherId) ? config.publisherId : config.client
  const principalBase = {
    id: config.client,
    publisherId,
    publisherIds: Object.freeze([publisherId]),
    allowedPublisherIds: Object.freeze([publisherId]),
    scopes: new Set(config.scopes || ['*'])
  }

  const replayStore = nonceStore || createNonceStore({ maxEntries: config.maxNonces })
  const router = createCompanionRouter({ service, config, clock, capabilities, logger })
  const streamRoute = createCompanionStreamRoute({
    capabilities: router.capabilities,
    service,
    streamChunkBytes,
    rangeDeadlineMs: requestDeadlineMs,
    streamWriteIdleMs
  })
  const connections = new Set()
  const firstRequestDeadlines = new Map()
  const activeRequests = new Set()
  const activeRequestControllers = new Set()
  let httpServer = null
  let started = false
  let lifecycle = Promise.resolve()
  let startPromise = null
  let closePromise = null
  let closing = false
  let publicState = { enabled: config.enabled !== false, transport: 'tcp' }

  async function handleRequest (request, response) {
    clearTimeout(firstRequestDeadlines.get(request.socket))
    firstRequestDeadlines.delete(request.socket)
    response.setHeader('connection', 'close')
    const streamRequest = streamRoute.matches(request.url)
    const controller = new AbortController()
    let deadline = null
    const cancelRequest = () => {
      controller.abort()
      request.socket?.destroy?.()
    }
    const armDeadline = () => {
      clearTimeout(deadline)
      deadline = setTimeout(cancelRequest, requestDeadlineMs)
      deadline.unref?.()
    }
    const onSocketClose = () => controller.abort()
    activeRequestControllers.add(controller)
    request.socket?.once?.('close', onSocketClose)
    if (!streamRequest) armDeadline()
    try {
      if (streamRequest) {
        await streamRoute.handle(request, response, { signal: controller.signal })
        return
      }
      const authMetadata = prevalidateControlRequest({
        headers: request.headers,
        client: config.client,
        clock,
        maxClockSkewMs: config.maxClockSkewMs
      })
      const bodyRecord = await readBody(request, config.maxBodyBytes)
      verifyPrevalidatedControlRequest({
        method: request.method,
        path: request.url,
        bodyHash: bodyRecord.bodyHash,
        metadata: authMetadata,
        secret: config.sharedSecret,
        nonceStore: replayStore
      })

      const routed = await router.dispatch({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: bodyRecord.body,
        principal: Object.freeze({
          ...principalBase,
          isLocal: loopbackAddress(request.socket?.remoteAddress)
        }),
        serverState: publicState,
        signal: controller.signal
      })
      sendJson(response, routed.statusCode, routed.body, routed.headers)
    } catch (error) {
      if (response.headersSent || response.writableEnded || response.destroyed) {
        try {
          response.destroy?.(error)
        } catch {
          // The transport may already be closed by the failed request.
        }
      } else {
        const safe = publicError(error)
        const destroyRequest = () => request.socket?.destroy?.()
        response.setHeader('connection', 'close')
        response.once?.('finish', destroyRequest)
        sendJson(response, safe.statusCode, {
          error: { code: safe.code, message: safe.message }
        })
      }
    } finally {
      clearTimeout(deadline)
      request.socket?.removeListener?.('close', onSocketClose)
      activeRequestControllers.delete(controller)
    }
  }

  function serialize (operation) {
    const pending = lifecycle.then(operation, operation)
    lifecycle = pending.then(() => {}, () => {})
    return pending
  }

  async function dispatchInProcess ({
    method = 'GET',
    url = '/',
    headers = {},
    body = null,
    signal = null
  } = {}) {
    if (!started || closing) throw new Error('companion server is not available')
    const encodedBody = body == null
      ? b4a.alloc(0)
      : b4a.isBuffer(body) || body instanceof Uint8Array
        ? b4a.from(body)
        : b4a.from(typeof body === 'string' ? body : JSON.stringify(body))
    if (encodedBody.byteLength > config.maxBodyBytes) {
      throw new CompanionRequestError(413, 'BODY_TOO_LARGE', 'Request body exceeds configured maximum')
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener?.('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const deadline = setTimeout(abort, requestDeadlineMs)
    deadline.unref?.()
    try {
      return await router.dispatch({
        method,
        url,
        headers,
        body: encodedBody,
        principal: Object.freeze({ ...principalBase, isLocal: true }),
        inProcess: true,
        serverState: publicState,
        signal: controller.signal
      })
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener?.('abort', abort)
    }
  }

  function finishStartFailure (pending) {
    if (startPromise === pending) startPromise = null
  }

  function finishClose (pending) {
    if (closePromise !== pending) return
    startPromise = null
    closePromise = null
    closing = false
  }

  return {
    state () {
      return { ...publicState }
    },
    dispatchInProcess,
    start () {
      if (closing) return Promise.reject(new Error('Companion server is closing'))
      if (startPromise) return startPromise
      const pending = serialize(async () => {
      if (started) return { ...publicState }
      if (config.enabled === false) {
        publicState = { enabled: false, transport: 'tcp' }
        return { ...publicState }
      }
      if (typeof config.sharedSecret !== 'string' || !/^[a-f0-9]{64}$/.test(config.sharedSecret)) {
        throw new Error('Companion shared secret must be 64 lowercase hexadecimal characters')
      }
      const serverFactory = createServer || defaultCreateServer
      httpServer = serverFactory((request, response) => {
        const activeRequest = handleRequest(request, response)
        activeRequests.add(activeRequest)
        void activeRequest.then(
          () => activeRequests.delete(activeRequest),
          () => activeRequests.delete(activeRequest)
        )
      })
      httpServer.on?.('connection', (socket) => {
        const destroy = () => socket.destroy?.()
        const firstRequestDeadline = setTimeout(destroy, requestDeadlineMs)
        firstRequestDeadline.unref?.()
        firstRequestDeadlines.set(socket, firstRequestDeadline)
        socket.setTimeout?.(requestDeadlineMs, destroy)
        connections.add(socket)
        socket.once?.('close', () => {
          clearTimeout(firstRequestDeadlines.get(socket))
          firstRequestDeadlines.delete(socket)
          connections.delete(socket)
        })
      })

      try {
        await listen(httpServer, { host: config.host, port: config.port })
        const address = httpServer.address()
        if (!address || typeof address === 'string') throw new Error('Companion TCP address could not be resolved')
        publicState = {
          enabled: true,
          transport: 'tcp',
          host: address.address,
          port: address.port
        }
        started = true
        logger?.companion?.info?.('Companion API listening', publicState)
        return { ...publicState }
      } catch (error) {
        for (const controller of activeRequestControllers) controller.abort()
        for (const connection of connections) connection.destroy?.()
        connections.clear()
        await closeHttpServer(httpServer)
        await Promise.allSettled([...activeRequests])
        router.capabilities.clear()
        await router.capabilities.drain?.()
        httpServer = null
        throw error
      }
      }).catch(async error => {
        router.capabilities.clear()
        await router.capabilities.drain?.()
        throw error
      })
      startPromise = pending
      void pending.then(
        () => {},
        () => finishStartFailure(pending)
      )
      return pending
    },
    close () {
      if (closePromise) return closePromise
      closing = true
      router.capabilities.clear()
      const pending = serialize(async () => {
      if (!httpServer) {
        started = false
        await router.capabilities.drain?.()
        return
      }
      for (const controller of activeRequestControllers) controller.abort()
      for (const connection of connections) connection.destroy?.()
      connections.clear()
      await closeHttpServer(httpServer)
      await Promise.allSettled([...activeRequests])
      router.capabilities.clear()
      await router.capabilities.drain?.()
      httpServer = null
      started = false
      })
      closePromise = pending
      void pending.then(
        () => finishClose(pending),
        () => finishClose(pending)
      )
      return pending
    }
  }
}
