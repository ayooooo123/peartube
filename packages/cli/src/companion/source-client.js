import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { request as requestHTTP } from '#http'
import { request as requestHTTPS } from '#https'

import { signControlRequest } from './auth.js'

const SOURCE_PREFIX = '/internal/peartube/v2/sources/'
const CAPABILITY = /^[A-Za-z0-9._~-]{16,256}$/
const CLIENT = /^[A-Za-z0-9._-]{1,128}$/
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_SOURCE_BYTES = 5 * 1024 * 1024 * 1024

export class SourceCallbackError extends Error {
  constructor (code, recoverable = true) {
    super(code)
    this.name = 'SourceCallbackError'
    this.code = code
    this.recoverable = recoverable
  }
}

function fail (code, recoverable = true) {
  throw new SourceCallbackError(code, recoverable)
}

function validETag (value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 256 ||
      value.charCodeAt(0) !== 0x22 || value.charCodeAt(value.length - 1) !== 0x22) {
    return false
  }
  for (let index = 1; index < value.length - 1; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function normalizedOrigin (value) {
  if (typeof value !== 'string' || !value) throw new TypeError('source callback origin is required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('source callback origin is invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new TypeError('source callback origin must be an exact HTTP(S) origin')
  }
  return parsed.origin
}

function base64Url (bytes) {
  return b4a.toString(bytes, 'base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function singleHeader (response, name) {
  const lower = name.toLowerCase()
  if (Array.isArray(response.rawHeaders)) {
    let value = null
    let count = 0
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      if (String(response.rawHeaders[index]).toLowerCase() !== lower) continue
      count++
      value = String(response.rawHeaders[index + 1])
    }
    if (count !== 1) return null
    return value
  }
  const value = response.headers?.[lower]
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : null
  return value == null ? null : String(value)
}

function absentHeader (response, name) {
  const lower = name.toLowerCase()
  if (Array.isArray(response.rawHeaders)) {
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      if (String(response.rawHeaders[index]).toLowerCase() === lower) return false
    }
    return true
  }
  return response.headers?.[lower] == null
}

function exactIntegerHeader (response, name) {
  const value = singleHeader(response, name)
  if (value == null || !/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

// The relay's decision to keep or discard a part-downloaded title turns on the
// `recoverable` flag below, so the statuses a granted source promises are mapped
// deliberately rather than lumped together:
//
//   3xx  a grant must never redirect; following one would fetch bytes nothing
//        authorised. Permanent.
//   401  the grant's TTL lapsed. RECOVERABLE — the companion asks for a fresh
//        grant and resumes from the last confirmed offset. A long archive
//        outliving its grant is the most likely interruption there is, and it is
//        not a reason to throw away a download.
//   403  the grant belongs to another job, or the shared secret is wrong. No
//        retry fixes a misconfiguration.
//   404  the file behind the grant is gone.
//   410  the grant was revoked, or the upstream length stopped matching what the
//        grant was issued for — an identity change either way.
//   412  If-Match failed: the source is serving different bytes than the ones
//        the staged prefix was read under.
//   416  the range is outside the length the grant stated.
//   else 429 and 5xx are upstream throttling or a re-resolve in flight, which is
//        exactly what a retry is for.
function mapStatus (status) {
  if (status >= 300 && status < 400) fail('SOURCE_REDIRECT', false)
  if (status === 401) fail('SOURCE_AUTH_FAILED')
  if (status === 403) fail('SOURCE_AUTH_FAILED', false)
  if (status === 404 || status === 410) fail('SOURCE_GRANT_UNAVAILABLE', false)
  if (status === 412) fail('SOURCE_ETAG_MISMATCH', false)
  if (status === 416) fail('SOURCE_RANGE_INVALID', false)
  fail('SOURCE_UNAVAILABLE')
}

function finishResponse (response) {
  return new Promise((resolve, reject) => {
    response.once('error', () => reject(new SourceCallbackError('SOURCE_RESPONSE_FAILED')))
    response.once('end', resolve)
    response.resume?.()
  })
}

export function createSourceCallbackClient ({
  origin,
  client,
  sharedSecret,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  clock = Date.now,
  randomBytes = crypto.randomBytes,
  httpRequest = requestHTTP,
  httpsRequest = requestHTTPS
} = {}) {
  const callbackOrigin = normalizedOrigin(origin)
  if (!CLIENT.test(client || '')) throw new TypeError('source callback client identity is invalid')
  if (typeof sharedSecret !== 'string' || !/^[a-f0-9]{64}$/.test(sharedSecret)) {
    throw new TypeError('source callback shared secret must be 64 lowercase hexadecimal characters')
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > DEFAULT_CHUNK_BYTES) {
    throw new TypeError('source callback chunkBytes must be between 1 and 4194304')
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('source callback request timeout must be positive')
  }
  if (typeof clock !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('source callback clock and random source are required')
  }
  const transport = callbackOrigin.startsWith('https:') ? httpsRequest : httpRequest

  function requestPath (capability) {
    if (typeof capability !== 'string' || !CAPABILITY.test(capability)) fail('SOURCE_CAPABILITY_INVALID', false)
    return SOURCE_PREFIX + encodeURIComponent(capability)
  }

  function headersFor ({ method, path, jobId, etag = null }) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
      fail('SOURCE_JOB_INVALID', false)
    }
    const nonceBytes = b4a.from(randomBytes(24))
    if (nonceBytes.byteLength !== 24) throw new TypeError('source callback random source must return 24 bytes')
    const nonce = base64Url(nonceBytes)
    nonceBytes.fill(0)
    const headers = {
      ...signControlRequest({
        method,
        path,
        timestamp: Number(clock()),
        nonce,
        client,
        secret: sharedSecret
      }),
      'X-PearTube-Job-ID': jobId,
      'Accept-Encoding': 'identity'
    }
    if (etag != null) headers['If-Match'] = etag
    return headers
  }

  function open ({ method, path, headers, signal, onResponse }) {
    return new Promise((resolve, reject) => {
      let settled = false
      let response = null
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', abort)
        fn(value)
      }
      const abort = () => {
        const error = new SourceCallbackError('CANCELLED', false)
        response?.destroy?.(error)
        request?.destroy?.(error)
        finish(reject, error)
      }
      const timer = setTimeout(() => {
        const error = new SourceCallbackError('SOURCE_TIMEOUT')
        response?.destroy?.(error)
        request?.destroy?.(error)
        finish(reject, error)
      }, requestTimeoutMs)
      timer?.unref?.()
      let request
      try {
        request = transport(callbackOrigin + path, { method, headers }, incoming => {
          response = incoming
          Promise.resolve().then(() => onResponse(incoming)).then(
            value => finish(resolve, value),
            error => {
              incoming.destroy?.(error)
              finish(reject, error instanceof SourceCallbackError ? error : new SourceCallbackError('SOURCE_RESPONSE_FAILED'))
            }
          )
        })
      } catch {
        finish(reject, new SourceCallbackError('SOURCE_UNAVAILABLE'))
        return
      }
      request.once('error', error => {
        if (settled) return
        finish(reject, error instanceof SourceCallbackError ? error : new SourceCallbackError('SOURCE_UNAVAILABLE'))
      })
      if (signal) {
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener?.('abort', abort, { once: true })
      }
      request.end()
    })
  }

  async function head ({ capability, jobId, etag, length, signal = null }) {
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SOURCE_BYTES) {
      fail('SOURCE_LENGTH_MISMATCH', false)
    }
    if (!validETag(etag)) fail('SOURCE_ETAG_MISMATCH', false)
    const path = requestPath(capability)
    return open({
      method: 'HEAD',
      path,
      signal,
      headers: headersFor({ method: 'HEAD', path, jobId, etag }),
      async onResponse (response) {
        if (response.statusCode !== 200) mapStatus(response.statusCode || 0)
        const responseLength = exactIntegerHeader(response, 'content-length')
        const responseETag = singleHeader(response, 'etag')
        const contentType = singleHeader(response, 'content-type')
        const encoding = singleHeader(response, 'content-encoding')
        if (responseLength !== length) fail('SOURCE_LENGTH_MISMATCH', false)
        if (responseETag !== etag) fail('SOURCE_ETAG_MISMATCH', false)
        if (contentType == null || !MIME_TYPE.test(contentType.toLowerCase())) fail('SOURCE_METADATA_INVALID', false)
        if (!absentHeader(response, 'transfer-encoding') || (encoding != null && encoding !== 'identity')) {
          fail('SOURCE_METADATA_INVALID', false)
        }
        await finishResponse(response)
        return { length: responseLength, etag: responseETag, mimeType: contentType.toLowerCase() }
      }
    })
  }

  async function getRange ({ capability, jobId, etag, length, start, end, onChunk, signal = null }) {
    if (!validETag(etag)) fail('SOURCE_ETAG_MISMATCH', false)
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SOURCE_BYTES ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= length ||
        end - start + 1 > chunkBytes || typeof onChunk !== 'function') {
      fail('SOURCE_RANGE_INVALID', false)
    }
    const path = requestPath(capability)
    const expectedBytes = end - start + 1
    const headers = headersFor({ method: 'GET', path, jobId, etag })
    headers.Range = `bytes=${start}-${end}`
    return open({
      method: 'GET',
      path,
      headers,
      signal,
      onResponse (response) {
        if (response.statusCode !== 206) mapStatus(response.statusCode || 0)
        if (singleHeader(response, 'etag') !== etag) fail('SOURCE_ETAG_MISMATCH', false)
        if (singleHeader(response, 'content-range') !== `bytes ${start}-${end}/${length}` ||
            exactIntegerHeader(response, 'content-length') !== expectedBytes ||
            !absentHeader(response, 'transfer-encoding')) {
          fail('SOURCE_RANGE_INVALID', false)
        }
        const encoding = singleHeader(response, 'content-encoding')
        if (encoding != null && encoding !== 'identity') fail('SOURCE_RANGE_INVALID', false)
        return new Promise((resolve, reject) => {
          let received = 0
          let ended = false
          const rejectOnce = error => {
            if (ended) return
            ended = true
            reject(error)
          }
          response.on('data', raw => {
            if (ended) return
            const chunk = b4a.from(raw)
            if (received + chunk.byteLength > expectedBytes) {
              response.destroy?.()
              rejectOnce(new SourceCallbackError('SOURCE_RANGE_OVERRUN', false))
              return
            }
            try {
              onChunk(chunk, received)
            } catch {
              response.destroy?.()
              rejectOnce(new SourceCallbackError('SOURCE_WRITE_FAILED'))
              return
            }
            received += chunk.byteLength
          })
          response.once('aborted', () => rejectOnce(new SourceCallbackError('SOURCE_RANGE_SHORT')))
          response.once('error', () => rejectOnce(new SourceCallbackError('SOURCE_RANGE_SHORT')))
          response.once('end', () => {
            if (ended) return
            ended = true
            if (received !== expectedBytes) reject(new SourceCallbackError('SOURCE_RANGE_SHORT'))
            else resolve(received)
          })
        })
      }
    })
  }

  async function revoke ({ capability, jobId }) {
    const path = requestPath(capability)
    return open({
      method: 'DELETE',
      path,
      headers: headersFor({ method: 'DELETE', path, jobId }),
      onResponse: async response => {
        if (response.statusCode !== 204 && response.statusCode !== 404 && response.statusCode !== 410) {
          mapStatus(response.statusCode || 0)
        }
        await finishResponse(response)
        return true
      }
    })
  }

  return Object.freeze({ chunkBytes, head, getRange, revoke })
}
