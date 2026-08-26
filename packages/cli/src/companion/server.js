import AbortController from 'abort-controller'

import b4a from 'b4a'

import * as defaultFs from '#fs'
import {
  connectUnix as defaultConnectUnix,
  createServer as defaultCreateServer,
  createUnixServer as defaultCreateUnixServer
} from '#http'
import { dirname } from '#path'
import process from '#process'

import {
  CompanionAuthError,
  createBodyHasher,
  createNonceStore,
  prevalidateControlRequest,
  verifyPrevalidatedControlRequest
} from './auth.js'
import { createCompanionRouter } from './routes.js'
import { createCompanionStreamRoute } from './stream-route.js'
import { parseBoundary, receiveMultipartUpload } from '../multipart.js'

const MAX_UNIX_SOCKET_PATH_BYTES = 103
const MAX_ERROR_BYTES = 512
const SOCKET_PROBE_TIMEOUT_MS = 500
const DEFAULT_MAX_INGEST_BYTES = 500 * 1024 * 1024 * 1024
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024
// The one path prefix every companion route lives under. Exported because
// whoever wires the companion up has to know which prefix belongs to it — a
// shared HTTP listener routes on exactly this.
export const COMPANION_API_PREFIX = '/api/v2'
const INGEST_JOBS_PATH = `${COMPANION_API_PREFIX}/ingest/jobs`

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

function sameSocket (left, right) {
  return Boolean(
    left &&
    right &&
    left.isSocket?.() &&
    right.isSocket?.() &&
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

function sameDirectory (left, right) {
  return Boolean(
    left &&
    right &&
    left.isDirectory?.() &&
    right.isDirectory?.() &&
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

function ownedByCurrentUser (stat) {
  const uid = process.getuid?.()
  return Number.isSafeInteger(uid) && Number.isSafeInteger(stat?.uid) && stat.uid === uid
}

function statIfPresent (fs, path) {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function secureSocketNamespace (fs, socketPath, { create = false } = {}) {
  if (b4a.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`Companion Unix socket path must be at most ${MAX_UNIX_SOCKET_PATH_BYTES} bytes`)
  }
  const directoryPath = dirname(socketPath)
  let directory = statIfPresent(fs, directoryPath)
  if (!directory && create) {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
    directory = statIfPresent(fs, directoryPath)
  }
  if (
    !directory?.isDirectory?.() ||
    !ownedByCurrentUser(directory) ||
    !Number.isSafeInteger(directory.mode) ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Companion socket directory must be owner-only')
  }

  const parentPath = dirname(directoryPath)
  const parent = statIfPresent(fs, parentPath)
  if (
    !parent?.isDirectory?.() ||
    !Number.isSafeInteger(parent.mode) ||
    (parent.mode & 0o022) !== 0
  ) {
    throw new Error('Companion socket parent namespace must not be writable by other users')
  }
  return { path: directoryPath, identity: directory }
}

function assertSocketNamespaceUnchanged (fs, namespace) {
  const current = statIfPresent(fs, namespace?.path)
  if (!sameDirectory(namespace?.identity, current) || !ownedByCurrentUser(current)) {
    throw new Error('Companion socket namespace changed')
  }
}

export function probeUnixSocket (socketPath, { connectFn = defaultConnectUnix, timeoutMs = SOCKET_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let socket

    const finish = (error, live) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy?.()
      if (error) reject(error)
      else resolve(live)
    }

    try {
      socket = connectFn({ path: socketPath })
      socket.once?.('connect', () => finish(null, true))
      socket.once?.('error', (error) => {
        if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') finish(null, false)
        else finish(new Error('Unable to prove existing companion socket is stale'))
      })
      timer = setTimeout(() => {
        finish(new Error('Unable to prove existing companion socket is stale'))
      }, timeoutMs)
      timer.unref?.()
    } catch {
      finish(new Error('Unable to prove existing companion socket is stale'))
    }
  })
}

async function prepareUnixSocket ({ fs, socketPath, probeSocket, namespace }) {
  assertSocketNamespaceUnchanged(fs, namespace)
  const existing = statIfPresent(fs, socketPath)
  if (!existing) return
  if (!existing.isSocket?.()) {
    throw new Error('Companion socket path exists and is not a socket')
  }
  if (!ownedByCurrentUser(existing)) {
    throw new Error('Companion socket path is not owned by the current user')
  }
  if (await probeSocket(socketPath)) {
    throw new Error('Companion socket path is already in use')
  }

  assertSocketNamespaceUnchanged(fs, namespace)
  const current = statIfPresent(fs, socketPath)
  if (!current) return
  if (!sameSocket(existing, current) || !ownedByCurrentUser(current)) {
    throw new Error('Companion socket path changed during stale-socket check')
  }
  fs.unlinkSync(socketPath)
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

function requestContentType (request) {
  const value = request.headers?.['content-type']
  return Array.isArray(value) ? value[0] || '' : String(value || '')
}

function isMultipartIngestRequest (request) {
  return request.method === 'POST' &&
    request.url === INGEST_JOBS_PATH &&
    /^multipart\/form-data(?:\s*;|$)/i.test(requestContentType(request))
}

function assertMultipartContentLength (request, maxBytes) {
  const declaredLength = request.headers?.['content-length']
  if (declaredLength === undefined) return
  const parsedLength = Number(declaredLength)
  if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
    request.pause?.()
    throw new CompanionRequestError(400, 'INVALID_CONTENT_LENGTH', 'Invalid companion content length', true)
  }
  if (parsedLength > maxBytes) {
    request.pause?.()
    throw new CompanionRequestError(413, 'REQUEST_TOO_LARGE', 'Companion ingest request body is too large', true)
  }
}

function asMultipartRequestError (error) {
  if (error instanceof CompanionRequestError) return error
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400
  const code = typeof error?.code === 'string' ? error.code : 'INVALID_MULTIPART'
  const message = statusCode >= 500 ? 'Companion ingest staging failed' : (error?.message || 'Invalid multipart ingest request')
  return new CompanionRequestError(statusCode, code, message, true)
}

function encodeMultipartIngestBody (fields, file) {
  const spool = {
    path: file.relativePath,
    complete: true,
    mimeType: file.mimeType || 'application/octet-stream',
    byteLength: file.size,
    ...(Object.prototype.hasOwnProperty.call(fields, 'etag') ? { etag: fields.etag } : {})
  }
  return b4a.from(
    `{"idempotencyKey":${JSON.stringify(fields.idempotencyKey)},` +
    `"request":${fields.request},"spool":${JSON.stringify(spool)}}`
  )
}

function createIngestSpoolLease (staged) {
  let accepted = false
  return Object.freeze({
    get accepted () {
      return accepted
    },
    accept (spool) {
      if (!spool ||
          spool.filePath !== staged.path ||
          spool.relativePath !== staged.relativePath ||
          spool.byteLength !== staged.size) {
        return false
      }
      accepted = true
      return true
    }
  })
}

async function readMultipartIngest (request, {
  boundary,
  spoolRoot,
  maxIngestBytes,
  maxBodyBytes,
  fs,
  signal,
  onChunk
}) {
  const maxTotalBytes = maxIngestBytes + Math.max(MULTIPART_OVERHEAD_BYTES, maxBodyBytes)
  assertMultipartContentLength(request, maxTotalBytes)
  const hasher = createBodyHasher()
  try {
    const received = await receiveMultipartUpload(request, {
      boundary,
      uploadDir: spoolRoot,
      maxBytes: maxIngestBytes,
      maxTotalBytes,
      maxHeaderBytes: 8 * 1024,
      maxTextFieldBytes: maxBodyBytes,
      maxTextBytes: maxBodyBytes,
      maxFields: 3,
      strict: true,
      allowedFields: ['idempotencyKey', 'request', 'etag', 'file'],
      requiredFields: ['idempotencyKey', 'request'],
      fileField: 'file',
      fs,
      signal,
      onChunk: (chunk, totalBytes) => {
        hasher.update(b4a.from(chunk))
        onChunk?.(totalBytes)
      }
    })
    return {
      body: encodeMultipartIngestBody(received.fields, received.file),
      bodyHash: hasher.digest(),
      staged: received.file
    }
  } catch (error) {
    throw asMultipartRequestError(error)
  }
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

async function listenUnixProtected (server, socketPath, setUmask) {
  if (typeof setUmask !== 'function') {
    await listen(server, socketPath)
    return
  }
  const previous = setUmask(0o177)
  try {
    await listen(server, socketPath)
  } finally {
    setUmask(previous)
  }
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
  fs = defaultFs,
  createServer = null,
  createUnixServer = defaultCreateUnixServer,
  probeSocket = (socketPath) => probeUnixSocket(socketPath),
  setUmask = typeof process.umask === 'function' ? process.umask.bind(process) : null,
  requestDeadlineMs = 30_000,
  streamChunkBytes = undefined,
  streamWriteIdleMs = undefined,
  ingestSpoolRoot = null,
  maxIngestBytes = DEFAULT_MAX_INGEST_BYTES
} = {}) {
  if (!service) throw new Error('service is required')
  if (!config) throw new Error('companion config is required')
  if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs <= 0) {
    throw new Error('companion request deadline must be a positive integer')
  }
  if (!Number.isSafeInteger(maxIngestBytes) || maxIngestBytes <= 0 || maxIngestBytes > DEFAULT_MAX_INGEST_BYTES) {
    throw new Error('companion ingest byte limit is out of bounds')
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
  let socketIdentity = null
  let socketNamespace = null
  let publicState = { enabled: config.enabled !== false, transport: config.transport }

  async function handleRequest (request, response) {
    clearTimeout(firstRequestDeadlines.get(request.socket))
    firstRequestDeadlines.delete(request.socket)
    response.setHeader('connection', 'close')
    const streamRequest = streamRoute.matches(request.url)
    const multipartRequest = isMultipartIngestRequest(request)
    const controller = new AbortController()
    let staged = null
    let ingestSpoolLease = null
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
      let bodyRecord
      if (multipartRequest) {
        const boundary = parseBoundary(requestContentType(request))
        if (!boundary) throw new CompanionRequestError(400, 'INVALID_MULTIPART_BOUNDARY', 'Invalid multipart boundary', true)
        if (!ingestSpoolRoot) throw new CompanionRequestError(503, 'INGEST_STAGING_UNAVAILABLE', 'Companion ingest staging is unavailable', true)
        if (typeof service.canStageIngest === 'function' && !service.canStageIngest()) {
          throw new CompanionRequestError(503, 'INGEST_STAGING_UNAVAILABLE', 'Companion ingest staging is unavailable', true)
        }
        if (typeof service.canArchive === 'function' && !service.canArchive()) {
          throw new CompanionRequestError(507, 'STORAGE_ADMISSION_DENIED', 'Companion storage admission denied', true)
        }
        bodyRecord = await readMultipartIngest(request, {
          boundary,
          spoolRoot: ingestSpoolRoot,
          maxIngestBytes,
          maxBodyBytes: config.maxBodyBytes,
          fs,
          signal: controller.signal,
          onChunk: armDeadline
        })
        staged = bodyRecord.staged
        ingestSpoolLease = createIngestSpoolLease(staged)
      } else {
        bodyRecord = await readBody(request, config.maxBodyBytes)
      }
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
        clientIdentity: authMetadata.client,
        serverState: publicState,
        ingestSpoolLease,
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
      if (staged && !ingestSpoolLease?.accepted) {
        try { fs.rmSync(staged.dir, { recursive: true, force: true }) } catch {
          // Best-effort rejection cleanup; the lease was never transferred.
        }
      }
      request.socket?.removeListener?.('close', onSocketClose)
      activeRequestControllers.delete(controller)
    }
  }

  async function cleanupOwnedSocket () {
    if (config.transport !== 'unix' || !socketIdentity) return
    assertSocketNamespaceUnchanged(fs, socketNamespace)
    const current = statIfPresent(fs, config.socketPath)
    if (current && sameSocket(socketIdentity, current) && ownedByCurrentUser(current)) {
      fs.unlinkSync(config.socketPath)
    }
    socketIdentity = null
  }

  function serialize (operation) {
    const pending = lifecycle.then(operation, operation)
    lifecycle = pending.then(() => {}, () => {})
    return pending
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
    start () {
      if (closing) return Promise.reject(new Error('Companion server is closing'))
      if (startPromise) return startPromise
      const pending = serialize(async () => {
      if (started) return { ...publicState }
      if (config.enabled === false) {
        publicState = { enabled: false, transport: config.transport }
        return { ...publicState }
      }
      if (typeof config.sharedSecret !== 'string' || !/^[a-f0-9]{64}$/.test(config.sharedSecret)) {
        throw new Error('Companion shared secret must be 64 lowercase hexadecimal characters')
      }
      if (config.transport === 'unix') {
        socketNamespace = secureSocketNamespace(fs, config.socketPath, { create: true })
        await prepareUnixSocket({
          fs,
          socketPath: config.socketPath,
          probeSocket,
          namespace: socketNamespace
        })
      }

      const serverFactory = createServer || (
        config.transport === 'unix' ? createUnixServer : defaultCreateServer
      )
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
        if (config.transport === 'tcp') socket.setTimeout?.(requestDeadlineMs, destroy)
        connections.add(socket)
        socket.once?.('close', () => {
          clearTimeout(firstRequestDeadlines.get(socket))
          firstRequestDeadlines.delete(socket)
          connections.delete(socket)
        })
      })

      try {
        if (config.transport === 'unix') {
          await listenUnixProtected(httpServer, config.socketPath, setUmask)
          assertSocketNamespaceUnchanged(fs, socketNamespace)
          socketIdentity = fs.lstatSync(config.socketPath)
          if (!socketIdentity.isSocket?.() || !ownedByCurrentUser(socketIdentity)) {
            throw new Error('Companion socket ownership could not be verified')
          }
          fs.chmodSync(config.socketPath, 0o600)
          assertSocketNamespaceUnchanged(fs, socketNamespace)
          const protectedSocket = fs.lstatSync(config.socketPath)
          if (!sameSocket(socketIdentity, protectedSocket) || (protectedSocket.mode & 0o777) !== 0o600) {
            throw new Error('Companion socket permissions could not be secured')
          }
          socketIdentity = protectedSocket
          publicState = {
            enabled: true,
            transport: 'unix',
            socketPath: config.socketPath
          }
        } else if (config.transport === 'tcp') {
          await listen(httpServer, { host: config.host, port: config.port })
          const address = httpServer.address()
          if (!address || typeof address === 'string') throw new Error('Companion TCP address could not be resolved')
          publicState = {
            enabled: true,
            transport: 'tcp',
            host: address.address,
            port: address.port
          }
        } else {
          throw new Error('Unsupported companion transport')
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
        await cleanupOwnedSocket().catch(() => {})
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
        await cleanupOwnedSocket()
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
      await cleanupOwnedSocket()
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
