import b4a from 'b4a'

import { createSourceReader } from '@peartube/backend/assets'

// TorBox source grants for the v2 acquisition flow: torrent and usenet.
//
// In v1 this was a source registry keyed off a torrentId/fileId descriptor the
// archival client sent at ingest time. v2 has no privileged client: an
// acquisition is requested against a resolution, and the bytes come from a
// source GRANT the requester attaches - a bearer token scoped to that one
// acquisition. This module is the relay side of that grant: it turns a token
// into a resumable SourceReader that streams TorBox CDN ranges.
//
// The token is opaque to the relay. The archival client mints it as
// base64url(JSON({ kind, usenetId|torrentId, fileId })) - the minimum the
// relay needs to ask TorBox for a download link. Usenet downloads use
// /usenet/requestdl, torrents /torrents/requestdl; both return the same shape
// of CDN link. The grant's sha256/length fields carry the identity the reader
// must reproduce, so a token pointing at different bytes than the acquisition
// verified is refused by the source reader contract itself
// (sourceChangedError on describe mismatch).

const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api'
const LINK_TTL_MS = 15 * 60 * 1000
const RANGE_ATTEMPTS = 4
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/
// TorBox route names are not a plural rule: torrents live under /torrents but
// usenet under /usenet (singular). Map explicitly.
const KIND_PATHS = Object.freeze({ usenet: 'usenet', torrent: 'torrents' })

export class TorBoxSourceError extends Error {
  constructor (code, message, recoverable = true) {
    super(message)
    this.name = 'TorBoxSourceError'
    this.code = code
    this.recoverable = recoverable
  }
}

function fail (code, message, recoverable = true) {
  throw new TorBoxSourceError(code, message, recoverable)
}

function decodeGrantToken (token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    fail('SOURCE_GRANT_INVALID', 'TorBox grant token is malformed', false)
  }
  let decoded
  try {
    const padded = token.replaceAll('-', '+').replaceAll('_', '/')
    decoded = JSON.parse(b4a.toString(b4a.from(padded, 'base64'), 'utf8'))
  } catch {
    fail('SOURCE_GRANT_INVALID', 'TorBox grant token is not decodable', false)
  }
  const kind = decoded?.kind || (decoded?.usenetId !== undefined ? 'usenet' : decoded?.torrentId !== undefined ? 'torrent' : null)
  if (!Object.hasOwn(KIND_PATHS, kind)) {
    fail('SOURCE_GRANT_INVALID', 'TorBox grant token does not name a usenet or torrent source', false)
  }
  const rawId = kind === 'usenet'
    ? (decoded?.usenetId ?? decoded?.usenet_id)
    : (decoded?.torrentId ?? decoded?.torrent_id)
  const fileId = decoded?.fileId ?? decoded?.file_id ?? 0
  if (rawId === null || rawId === undefined ||
      !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 0 ||
      !Number.isSafeInteger(Number(fileId)) || Number(fileId) < 0) {
    fail('SOURCE_GRANT_INVALID', 'TorBox grant token does not name a retrievable file', false)
  }
  return { kind, id: String(rawId), fileId: Number(fileId) }
}

function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('aborted'))
    }, { once: true })
  })
}

export function createTorBoxSourceGrants ({
  apiKey = '',
  chunkBytes = DEFAULT_CHUNK_BYTES,
  apiBase = TORBOX_API_BASE,
  fetchImpl = null,
  now = Date.now,
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function') throw new TypeError('TorBox source grants require a fetch implementation')
  if (typeof now !== 'function') throw new TypeError('TorBox source grants require a now function')

  const links = new Map()
  let closed = false

  async function fetchDownloadLink ({ kind, id, fileId }, { forceFresh = false, signal = null } = {}) {
    const key = `${kind}:${id}:${fileId}`
    const cached = links.get(key)
    if (!forceFresh && cached && (now() - cached.cachedAt) < LINK_TTL_MS) return cached.url

    const endpoint = `${apiBase}/${KIND_PATHS[kind]}/requestdl?token=${encodeURIComponent(apiKey)}&${kind}_id=${encodeURIComponent(id)}&file_id=${encodeURIComponent(fileId)}`
    let response
    try {
      response = await fetchFn(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'peartube-relay/1.0',
          Accept: 'application/json'
        },
        signal
      })
    } catch (error) {
      fail('TORBOX_API_UNREACHABLE', `TorBox API requestdl failed: ${error?.message || String(error)}`)
    }
    if (response.status === 401 || response.status === 403) {
      fail('TORBOX_AUTH_FAILED', 'TorBox API key is invalid or unauthorized', false)
    }
    if (!response.ok) {
      fail('TORBOX_API_ERROR', `TorBox API requestdl returned HTTP ${response.status}`, response.status >= 500)
    }
    let body
    try {
      body = await response.json()
    } catch {
      fail('TORBOX_RESPONSE_INVALID', 'TorBox API returned a non-JSON response')
    }
    if (!body || body.success !== true) {
      fail('TORBOX_REQUEST_FAILED', `TorBox requestdl error: ${body?.detail || body?.error || 'unknown error'}`)
    }
    const url = typeof body.data === 'string'
      ? body.data.trim()
      : (typeof body.data?.link === 'string' ? body.data.link.trim() : null)
    if (!url || !/^https?:\/\//i.test(url)) {
      fail('TORBOX_LINK_MISSING', 'TorBox requestdl did not return a valid download link')
    }
    links.set(key, { url, cachedAt: now() })
    return url
  }

  async function headThroughLink (source, signal) {
    const attempt = (url) => fetchFn(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'peartube-relay/1.0' },
      signal
    })
    let response = await attempt(await fetchDownloadLink(source, { signal }))
    if (response.status === 401 || response.status === 403 || response.status === 410) {
      response = await attempt(await fetchDownloadLink(source, { forceFresh: true, signal }))
    }
    return response
  }

  return Object.freeze({
    adapterId: 'torbox',
    enabled: typeof apiKey === 'string' && apiKey.trim().length > 0,
    async resolve ({ token, etag = null, length = null, sha256 = null, contentType = null, signal = null } = {}) {
      if (closed) {
        const error = new Error('TorBox source grants are closed')
        error.code = 'SOURCE_GRANT_UNAVAILABLE'
        throw error
      }
      if (!this.enabled) {
        const error = new Error('TorBox is not configured (set PEARTUBE_TORBOX_API_KEY or archive.torbox.apiKey)')
        error.code = 'SOURCE_GRANT_UNAVAILABLE'
        throw error
      }
      const source = decodeGrantToken(token)
      const fallbackEtag = `torbox:${source.kind}:${source.id}:${source.fileId}`
      const grantSignal = signal

      let description = null
      if (Number.isSafeInteger(length) && length > 0) {
        description = {
          identity: sha256
            ? { kind: 'sha256', value: sha256 }
            : { kind: 'etag', value: etag || `${fallbackEtag}:${length}` },
          byteLength: length,
          mimeType: contentType && contentType.includes('/') ? contentType.split(';')[0].trim() : 'video/mp4'
        }
      }

      return createSourceReader({
        resumable: true,
        maxReadBytes: chunkBytes,
        async describe ({ signal: describeSignal } = {}) {
          if (description) return description
          const response = await headThroughLink(source, describeSignal || signal)
          if (!response.ok) {
            fail('TORBOX_CDN_ERROR', `TorBox CDN HEAD returned HTTP ${response.status}`, response.status >= 500)
          }
          const lengthHeader = response.headers?.get?.('content-length') ?? response.headers?.['content-length']
          const byteLength = Number(lengthHeader)
          if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
            fail('TORBOX_LENGTH_INVALID', `TorBox CDN HEAD returned invalid content-length: ${lengthHeader}`)
          }
          const etagHeader = response.headers?.get?.('etag') ?? response.headers?.etag
          const identity = typeof etagHeader === 'string' && etagHeader.trim()
            ? { kind: 'etag', value: etagHeader.trim() }
            : { kind: 'etag', value: `${fallbackEtag}:${byteLength}` }
          const mimeHeader = response.headers?.get?.('content-type') ?? response.headers?.['content-type']
          const mimeType = typeof mimeHeader === 'string' && mimeHeader.includes('/')
            ? mimeHeader.split(';')[0].trim()
            : 'video/mp4'
          description = { identity, byteLength, mimeType }
          return description
        },
        open ({ offset, length: readLength, signal: openSignal } = {}) {
          return (async function * () {
            if (!readLength || readLength <= 0) return
            const signal = openSignal || grantSignal
            const end = offset + readLength
            let streamed = 0
            let lastError = null
            for (let attempt = 1; attempt <= RANGE_ATTEMPTS; attempt++) {
              if (signal?.aborted) throw signal.reason || new Error('aborted')
              let downloadUrl
              try {
                downloadUrl = await fetchDownloadLink(source, { forceFresh: attempt > 1, signal })
              } catch (error) {
                lastError = error
                if (error instanceof TorBoxSourceError && error.recoverable === false) throw error
                if (attempt === RANGE_ATTEMPTS) throw error
                await sleep(attempt * 1000, signal)
                continue
              }
              const rangeStart = offset + streamed
              if (rangeStart >= end) return
              try {
                const response = await fetchFn(downloadUrl, {
                  method: 'GET',
                  headers: {
                    Range: `bytes=${rangeStart}-${end - 1}`,
                    'User-Agent': 'peartube-relay/1.0'
                  },
                  signal
                })
                if (response.status === 401 || response.status === 403 || response.status === 410) {
                  throw new Error(`CDN token expired: HTTP ${response.status}`)
                }
                if (response.status !== 206 && response.status !== 200) {
                  throw new Error(`TorBox CDN range request returned HTTP ${response.status}`)
                }
                if (response.body && typeof response.body.getReader === 'function') {
                  const reader = response.body.getReader()
                  try {
                    while (true) {
                      if (signal?.aborted) {
                        await reader.cancel().catch(() => {})
                        throw signal.reason || new Error('aborted')
                      }
                      const { done, value } = await reader.read()
                      if (done) break
                      if (value && value.byteLength > 0) {
                        const chunk = value instanceof Uint8Array ? value : b4a.from(value)
                        streamed += chunk.byteLength
                        yield chunk
                      }
                    }
                  } finally {
                    reader.releaseLock?.()
                  }
                } else if (typeof response.arrayBuffer === 'function') {
                  const buffer = await response.arrayBuffer()
                  const chunk = b4a.from(buffer)
                  streamed += chunk.byteLength
                  yield chunk
                } else {
                  throw new Error('Unsupported TorBox CDN response body')
                }
                if (streamed === readLength) return
                throw new Error(`Streamed ${streamed} bytes, expected ${readLength}`)
              } catch (error) {
                lastError = error
                if (signal?.aborted) throw error
                if (attempt < RANGE_ATTEMPTS) await sleep(attempt * 1000, signal)
              }
            }
            fail('TORBOX_CDN_UNREACHABLE', `TorBox CDN range read failed after ${RANGE_ATTEMPTS} attempts: ${lastError?.message || String(lastError)}`)
          })()
        },
        async close () {}
      })
    },
    async revoke () {
      return false
    },
    async close () {
      closed = true
      links.clear()
    }
  })
}
