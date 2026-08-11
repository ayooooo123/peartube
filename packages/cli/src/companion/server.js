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
  verifyControlRequest
} from './auth.js'

const MAX_UNIX_SOCKET_PATH_BYTES = 103
const MAX_ERROR_BYTES = 512
const SOCKET_PROBE_TIMEOUT_MS = 500

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

function sendJson (response, statusCode, value) {
  let body = b4a.from(JSON.stringify(value))
  if (statusCode >= 400 && body.byteLength > MAX_ERROR_BYTES) {
    body = b4a.from('{"error":{"code":"INTERNAL_ERROR","message":"Companion request failed"}}')
    statusCode = 500
  }
  response.statusCode = statusCode
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

function readBodyHash (request, maxBodyBytes) {
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
      hasher.update(chunk)
    })
    request.once('end', () => {
      if (done) return
      done = true
      resolve(hasher.digest())
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
  logger = null,
  fs = defaultFs,
  createServer = null,
  createUnixServer = defaultCreateUnixServer,
  probeSocket = (socketPath) => probeUnixSocket(socketPath),
  setUmask = typeof process.umask === 'function' ? process.umask.bind(process) : null,
  requestDeadlineMs = 30_000
} = {}) {
  if (!service) throw new Error('service is required')
  if (!config) throw new Error('companion config is required')
  if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs <= 0) {
    throw new Error('companion request deadline must be a positive integer')
  }

  const replayStore = nonceStore || createNonceStore({ maxEntries: config.maxNonces })
  const connections = new Set()
  const firstRequestDeadlines = new Map()
  let httpServer = null
  let started = false
  let socketIdentity = null
  let socketNamespace = null
  let publicState = { enabled: config.enabled !== false, transport: config.transport }

  async function handleRequest (request, response) {
    clearTimeout(firstRequestDeadlines.get(request.socket))
    firstRequestDeadlines.delete(request.socket)
    response.setHeader('connection', 'close')
    const deadline = setTimeout(() => request.socket?.destroy?.(), requestDeadlineMs)
    deadline.unref?.()
    try {
      prevalidateControlRequest({
        headers: request.headers,
        client: config.client,
        clock,
        maxClockSkewMs: config.maxClockSkewMs
      })
      const bodyHash = await readBodyHash(request, config.maxBodyBytes)
      verifyControlRequest({
        method: request.method,
        path: request.url,
        bodyHash,
        headers: request.headers,
        secret: config.sharedSecret,
        client: config.client,
        clock,
        nonceStore: replayStore,
        maxClockSkewMs: config.maxClockSkewMs
      })

      if (request.method === 'GET' && request.url === '/api/v2/status') {
        sendJson(response, 200, { apiVersion: 2, status: 'available', implemented: false })
        return
      }
      if (request.url?.startsWith('/api/v2/')) {
        sendJson(response, 501, {
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Companion v2 route is not implemented'
          }
        })
        return
      }
      sendJson(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Companion route not found' }
      })
    } catch (error) {
      const safe = publicError(error)
      const destroyRequest = () => request.socket?.destroy?.()
      response.setHeader('connection', 'close')
      response.once?.('finish', destroyRequest)
      sendJson(response, safe.statusCode, {
        error: { code: safe.code, message: safe.message }
      })
    } finally {
      clearTimeout(deadline)
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

  return {
    state () {
      return { ...publicState }
    },
    async start () {
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
        void handleRequest(request, response)
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
        for (const connection of connections) connection.destroy?.()
        connections.clear()
        await closeHttpServer(httpServer)
        await cleanupOwnedSocket().catch(() => {})
        httpServer = null
        throw error
      }
    },
    async close () {
      if (!httpServer) {
        await cleanupOwnedSocket()
        started = false
        return
      }
      for (const connection of connections) connection.destroy?.()
      connections.clear()
      await closeHttpServer(httpServer)
      httpServer = null
      await cleanupOwnedSocket()
      started = false
    }
  }
}
