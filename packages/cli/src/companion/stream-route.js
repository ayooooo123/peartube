import AbortController from 'abort-controller'
import b4a from 'b4a'

import { parseHttpByteRange } from '@peartube/backend'

import { CompanionContractError, decodeId, errorBody } from './contracts.js'

const STREAM_PATH = /^\/api\/v2\/stream\/([^/]+)\/([^/]+)$/
const DEFAULT_STREAM_CHUNK_BYTES = 256 * 1024
const MAX_STREAM_CHUNK_BYTES = 8 * 1024 * 1024
const DEFAULT_RANGE_DEADLINE_MS = 15_000
const DEFAULT_STREAM_WRITE_IDLE_MS = 30_000
const MAX_RESPONSE_WRITE_BYTES = 16 * 1024
const STRONG_ETAG = /^"[\x21\x23-\x7e]{1,256}"$/
const SAFE_MEDIA_TYPE = /^(?:audio|video)\/[A-Za-z0-9][A-Za-z0-9.+-]{0,126}$/

function contractError (statusCode, code, message, field = null) {
  return new CompanionContractError(statusCode, code, message, field)
}

function parseUrl (rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || b4a.byteLength(rawUrl) > 8192) {
    throw contractError(400, 'INVALID_URL', 'Invalid request URL')
  }
  try {
    return new URL(rawUrl, 'http://companion.invalid')
  } catch {
    throw contractError(400, 'INVALID_URL', 'Invalid request URL')
  }
}

function decodedSegment (value, field) {
  try {
    return decodeId(decodeURIComponent(value), field)
  } catch (error) {
    if (error instanceof CompanionContractError) throw error
    throw contractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  }
}

function capabilityToken (values) {
  for (const [field] of values) {
    if (field !== 'cap') throw contractError(400, 'UNKNOWN_FIELD', 'Unknown stream query field', field)
  }
  const tokens = values.getAll('cap')
  if (tokens.length !== 1) {
    throw contractError(400, tokens.length > 1 ? 'DUPLICATE_FIELD' : 'INVALID_FIELD', 'Stream capability is required', 'cap')
  }
  return tokens[0]
}

function safeMediaType (value) {
  return typeof value === 'string' && SAFE_MEDIA_TYPE.test(value)
    ? value
    : 'application/octet-stream'
}

function strongEtag (asset) {
  if (typeof asset.etag === 'string' && STRONG_ETAG.test(asset.etag)) return asset.etag
  return `"asset-${asset.assetId}"`
}

function normalizeAsset (asset, assetId) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || asset.assetId !== assetId ||
      !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 ||
      typeof asset.requestRange !== 'function') {
    throw contractError(502, 'BACKEND_CONTRACT_INVALID', 'Stream backend returned invalid asset metadata')
  }
  return {
    assetId,
    byteLength: asset.byteLength,
    mimeType: safeMediaType(asset.mimeType),
    etag: strongEtag(asset),
    seek: typeof asset.seek === 'function' ? asset.seek.bind(asset) : null,
    requestRange: asset.requestRange.bind(asset)
  }
}

function headerValue (headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : null
}

function selectedRange (headers, asset) {
  const rangeHeader = headerValue(headers, 'range')
  if (rangeHeader === null) return { statusCode: 200, start: 0, end: asset.byteLength - 1 }
  const ifRange = headerValue(headers, 'if-range')
  if (ifRange !== null && ifRange !== asset.etag) {
    return { statusCode: 200, start: 0, end: asset.byteLength - 1 }
  }
  const parsed = parseHttpByteRange(rangeHeader, asset.byteLength)
  if (!parsed) throw contractError(416, 'RANGE_NOT_SATISFIABLE', 'Requested byte range is not satisfiable', 'range')
  return { statusCode: 206, start: parsed.start, end: parsed.end }
}

function responseHeaders (asset, range) {
  const length = range.end - range.start + 1
  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': asset.mimeType,
    'Content-Length': String(length),
    ETag: asset.etag,
    ...(range.statusCode === 206
      ? { 'Content-Range': `bytes ${range.start}-${range.end}/${asset.byteLength}` }
      : {})
  }
}

function setHeaders (response, headers) {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
}

function sendError (request, response, error, { byteLength = null, allow = null } = {}) {
  if (response.headersSent || response.writableEnded || response.destroyed) return false
  const body = b4a.from(JSON.stringify(errorBody(error)))
  response.statusCode = error.statusCode
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Content-Length', String(body.byteLength))
  if (allow) response.setHeader('Allow', allow)
  if (Number.isSafeInteger(byteLength) && byteLength > 0) {
    response.setHeader('Accept-Ranges', 'bytes')
    if (error.statusCode === 416) response.setHeader('Content-Range', `bytes */${byteLength}`)
  }
  response.writeHead(error.statusCode)
  response.end(request.method === 'HEAD' ? undefined : body)
  return true
}

function abortError () {
  const error = new Error('stream request aborted')
  error.name = 'AbortError'
  return error
}

function streamWriteTimeoutError () {
  const error = new Error('stream response write stalled')
  error.code = 'STREAM_WRITE_TIMEOUT'
  return error
}

function waitForDrain (response, signal, idleMs, onStall) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const cleanup = () => {
      clearTimeout(timer)
      response.removeListener?.('drain', onDrain)
      response.removeListener?.('close', onClose)
      signal.removeEventListener?.('abort', onAbort)
    }
    const finish = (callback, value) => {
      if (settled) return false
      settled = true
      cleanup()
      callback(value)
      return true
    }
    const onDrain = () => finish(resolve)
    const onClose = () => finish(reject, abortError())
    const onAbort = () => finish(reject, abortError())
    const onTimeout = () => {
      const error = streamWriteTimeoutError()
      if (finish(reject, error)) onStall(error)
    }
    response.once?.('drain', onDrain)
    response.once?.('close', onClose)
    signal.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(onTimeout, idleMs)
    timer.unref?.()
    if (signal.aborted || response.destroyed || response.writableEnded) onAbort()
  })
}

async function writeChunk (response, bytes, signal, idleMs, onStall) {
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_RESPONSE_WRITE_BYTES) {
    const fragment = bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_RESPONSE_WRITE_BYTES))
    if (signal.aborted || response.destroyed || response.writableEnded) throw abortError()
    if (response.write.length < 2) {
      if (response.write(fragment) === false) await waitForDrain(response, signal, idleMs, onStall)
      continue
    }
    await new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        response.removeListener?.('error', onError)
        response.removeListener?.('close', onClose)
        signal.removeEventListener?.('abort', onAbort)
      }
      const finish = (callback, value) => {
        if (settled) return false
        settled = true
        cleanup()
        callback(value)
        return true
      }
      const onError = error => finish(reject, error)
      const onClose = () => finish(reject, abortError())
      const onAbort = () => finish(reject, abortError())
      const onTimeout = () => {
        const error = streamWriteTimeoutError()
        if (finish(reject, error)) onStall()
      }
      response.once?.('error', onError)
      response.once?.('close', onClose)
      signal.addEventListener?.('abort', onAbort, { once: true })
      timer = setTimeout(onTimeout, idleMs)
      timer.unref?.()
      try {
        response.write(fragment, error => error ? onError(error) : finish(resolve))
      } catch (error) {
        onError(error)
      }
      if (signal.aborted || response.destroyed || response.writableEnded) onAbort()
    })
  }
}

function verifiedChunk (result, expectedLength) {
  if (result?.status !== 'ok' || result.verified !== true ||
      !b4a.isBuffer(result.bytes) || result.bytes.byteLength !== expectedLength) {
    throw contractError(503, 'VERIFIED_SOURCE_UNAVAILABLE', 'Verified media source is unavailable')
  }
  return result.bytes
}

export function isCompanionStreamRoute (rawUrl) {
  try {
    return STREAM_PATH.test(parseUrl(rawUrl).pathname)
  } catch {
    return false
  }
}

export function createCompanionStreamRoute ({
  capabilities,
  service = null,
  streamChunkBytes = DEFAULT_STREAM_CHUNK_BYTES,
  rangeDeadlineMs = DEFAULT_RANGE_DEADLINE_MS,
  streamWriteIdleMs = DEFAULT_STREAM_WRITE_IDLE_MS
} = {}) {
  if (!capabilities || typeof capabilities.consume !== 'function' || typeof capabilities.close !== 'function') {
    throw new TypeError('stream capabilities are required')
  }
  if (!Number.isSafeInteger(streamChunkBytes) || streamChunkBytes < 1 || streamChunkBytes > MAX_STREAM_CHUNK_BYTES) {
    throw new TypeError('stream chunk bytes are out of bounds')
  }
  if (!Number.isSafeInteger(rangeDeadlineMs) || rangeDeadlineMs < 1) throw new TypeError('stream range deadline is invalid')
  if (!Number.isSafeInteger(streamWriteIdleMs) || streamWriteIdleMs < 1) throw new TypeError('stream write idle deadline is invalid')

  async function handle (request, response, { signal = null } = {}) {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : ''
    if (method !== 'GET' && method !== 'HEAD') {
      sendError({ ...request, method }, response, contractError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), { allow: 'GET, HEAD' })
      return true
    }

    let acquisition = null
    let asset = null
    let completed = false
    let token = null
    let writeStalled = false
    const controller = new AbortController()
    const abort = () => {
      if (!completed && !controller.signal.aborted) controller.abort()
    }
    const stallWrite = () => {
      if (writeStalled) return
      writeStalled = true
      if (!controller.signal.aborted) controller.abort()
      try {
        response.destroy?.()
      } catch {
        // The stalled response transport may already be closed.
      }
    }
    signal?.addEventListener?.('abort', abort, { once: true })
    request?.once?.('aborted', abort)
    response?.once?.('close', abort)

    try {
      const url = parseUrl(request.url)
      const match = url.pathname.match(STREAM_PATH)
      if (!match) throw contractError(404, 'NOT_FOUND', 'Companion stream route not found')
      const publicationId = decodedSegment(match[1], 'publicationId')
      const renditionId = decodedSegment(match[2], 'renditionId')
      token = capabilityToken(url.searchParams)
      acquisition = capabilities.consume(token, { publicationId, renditionId, method })
      const resolved = acquisition.asset || (typeof service?.resolveStreamAsset === 'function'
        ? await service.resolveStreamAsset({
            clientIdentity: acquisition.clientIdentity,
            publicationId,
            renditionId,
            assetId: acquisition.assetId,
            signal: controller.signal
          })
        : null)
      asset = normalizeAsset(resolved, acquisition.assetId)
      const range = selectedRange(request.headers || {}, asset)
      const headers = responseHeaders(asset, range)

      if (method === 'HEAD') {
        setHeaders(response, headers)
        response.statusCode = range.statusCode
        response.writeHead(range.statusCode)
        completed = true
        response.end()
        return true
      }

      asset.seek?.({ byteStart: range.start })
      let offset = range.start
      const firstEnd = Math.min(range.end + 1, offset + streamChunkBytes)
      const first = verifiedChunk(await asset.requestRange({
        assetId: asset.assetId,
        byteStart: offset,
        byteEnd: firstEnd,
        deadlineMs: rangeDeadlineMs,
        signal: controller.signal
      }), firstEnd - offset)
      if (controller.signal.aborted || response.destroyed || response.writableEnded) return true

      setHeaders(response, headers)
      response.statusCode = range.statusCode
      response.writeHead(range.statusCode)
      await writeChunk(response, first, controller.signal, streamWriteIdleMs, stallWrite)
      offset = firstEnd

      while (offset <= range.end) {
        const byteEnd = Math.min(range.end + 1, offset + streamChunkBytes)
        const bytes = verifiedChunk(await asset.requestRange({
          assetId: asset.assetId,
          byteStart: offset,
          byteEnd,
          deadlineMs: rangeDeadlineMs,
          signal: controller.signal
        }), byteEnd - offset)
        await writeChunk(response, bytes, controller.signal, streamWriteIdleMs, stallWrite)
        offset = byteEnd
      }

      completed = true
      response.end()
      return true
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || response.destroyed || response.writableEnded) return true
      if (response.headersSent) {
        try {
          const socket = response.socket
          response.end?.(() => {
            try {
              if (typeof socket?.end === 'function' && !socket.destroyed) socket.end()
            } catch {
              // The response is already terminal; the socket may have closed concurrently.
            }
          })
        } catch {
          try {
            response.destroy?.(error)
          } catch {
            // The failed response may already have destroyed its transport.
          }
        }
        return true
      }
      const known = error instanceof CompanionContractError
        ? error
        : contractError(502, 'BACKEND_FAILURE', 'Stream backend request failed')
      sendError({ ...request, method }, response, known, { byteLength: asset?.byteLength })
      return true
    } finally {
      completed = true
      signal?.removeEventListener?.('abort', abort)
      request?.removeListener?.('aborted', abort)
      response?.removeListener?.('close', abort)
      try {
        if (writeStalled && token !== null) capabilities.close(token)
      } finally {
        acquisition?.release()
      }
    }
  }

  return Object.freeze({ handle, matches: isCompanionStreamRoute })
}
