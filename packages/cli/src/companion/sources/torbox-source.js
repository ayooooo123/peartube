import b4a from 'b4a'

const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api'
const LINK_TTL_MS = 15 * 60 * 1000 // 15 min cache before re-verifying

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

function extractParams (opts = {}) {
  const cap = typeof opts.capability === 'object' && opts.capability !== null ? opts.capability : {}
  const torrentId = opts.torrentId ?? opts.itemId ?? cap.torrentId ?? cap.itemId ?? null
  const fileId = opts.fileId ?? opts.fileIndex ?? cap.fileId ?? cap.fileIndex ?? 0
  return { torrentId, fileId }
}

/**
 * Direct TorBox source client for PearTube Companion.
 * Connects directly to TorBox API to request and refresh download links,
 * and streams ranges from TorBox CDN without proxying through MediaStorm.
 */
export class TorBoxSourceClient {
  constructor ({
    apiKey,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    apiBase = TORBOX_API_BASE,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new TypeError('TorBoxSourceClient requires a non-empty apiKey')
    }
    this.apiKey = apiKey.trim()
    this.chunkBytes = Number.isSafeInteger(chunkBytes) && chunkBytes > 0 ? chunkBytes : DEFAULT_CHUNK_BYTES
    this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
    this.apiBase = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : TORBOX_API_BASE
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    this._cachedLinks = new Map() // `${torrentId}:${fileId}` -> { url, cachedAt }
  }

  async _fetchDownloadLink (torrentId, fileId, { forceFresh = false, signal = null } = {}) {
    const key = `${torrentId}:${fileId}`
    const cached = this._cachedLinks.get(key)
    if (!forceFresh && cached && (Date.now() - cached.cachedAt) < LINK_TTL_MS) {
      return cached.url
    }

    const endpoint = `${this.apiBase}/torrents/requestdl?token=${encodeURIComponent(this.apiKey)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(fileId)}`

    let response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'peartube-relay/1.0',
          Accept: 'application/json'
        },
        signal
      })
    } catch (err) {
      fail('TORBOX_API_UNREACHABLE', `TorBox API requestdl failed: ${err?.message || String(err)}`, true)
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
      fail('TORBOX_RESPONSE_INVALID', 'TorBox API returned non-JSON response', true)
    }

    if (!body || !body.success) {
      const detail = body?.detail || body?.error || 'Unknown error'
      fail('TORBOX_REQUEST_FAILED', `TorBox requestdl error: ${detail}`, true)
    }

    let downloadUrl = null
    if (typeof body.data === 'string') {
      downloadUrl = body.data.trim()
    } else if (body.data && typeof body.data.link === 'string') {
      downloadUrl = body.data.link.trim()
    }

    if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
      fail('TORBOX_LINK_MISSING', 'TorBox requestdl did not return a valid download link', true)
    }

    this._cachedLinks.set(key, { url: downloadUrl, cachedAt: Date.now() })
    return downloadUrl
  }

  /**
   * Head probe to determine content length, ETag, and MIME type.
   */
  async head (opts = {}) {
    const { torrentId, fileId } = extractParams(opts)
    const signal = opts.signal || null

    if (torrentId == null || fileId == null) {
      fail('TORBOX_PARAMS_INVALID', 'torrentId and fileId are required for TorBox head', false)
    }

    const downloadUrl = await this._fetchDownloadLink(torrentId, fileId, { signal })

    let response
    try {
      response = await this.fetchImpl(downloadUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': 'peartube-relay/1.0' },
        signal
      })
    } catch (err) {
      fail('TORBOX_CDN_UNREACHABLE', `TorBox CDN HEAD failed: ${err?.message || String(err)}`, true)
    }

    // If CDN link expired, retry once with forceFresh
    if (response.status === 401 || response.status === 403 || response.status === 410) {
      const freshUrl = await this._fetchDownloadLink(torrentId, fileId, { forceFresh: true, signal })
      try {
        response = await this.fetchImpl(freshUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'peartube-relay/1.0' },
          signal
        })
      } catch (err) {
        fail('TORBOX_CDN_UNREACHABLE', `TorBox CDN HEAD retry failed: ${err?.message || String(err)}`, true)
      }
    }

    if (!response.ok) {
      fail('TORBOX_CDN_ERROR', `TorBox CDN HEAD returned HTTP ${response.status}`, response.status >= 500)
    }

    const lengthHeader = response.headers?.get?.('content-length') ?? response.headers?.['content-length']
    const length = Number(lengthHeader)
    if (!Number.isSafeInteger(length) || length <= 0) {
      fail('TORBOX_LENGTH_INVALID', `TorBox CDN HEAD returned invalid content-length: ${lengthHeader}`, true)
    }

    const etagHeader = response.headers?.get?.('etag') ?? response.headers?.etag
    const etag = typeof etagHeader === 'string' && etagHeader.trim()
      ? etagHeader.trim()
      : `"${torrentId}:${fileId}:${length}"`

    const mimeTypeHeader = response.headers?.get?.('content-type') ?? response.headers?.['content-type']
    const mimeType = typeof mimeTypeHeader === 'string' && mimeTypeHeader.includes('/')
      ? mimeTypeHeader.split(';')[0].trim()
      : 'video/mp4'

    return { length, etag, mimeType }
  }

  /**
   * Reads a byte range [start, end] and yields buffer parts to onChunk.
   * Seamlessly re-requests the download link if the CDN returns 401/403/410.
   */
  async getRange (opts = {}) {
    const { start, end, onChunk, signal = null } = opts
    const { torrentId, fileId } = extractParams(opts)

    if (torrentId == null || fileId == null) {
      fail('TORBOX_PARAMS_INVALID', 'torrentId and fileId are required for TorBox getRange', false)
    }
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      fail('TORBOX_RANGE_INVALID', `Invalid range [${start}, ${end}]`, false)
    }
    if (typeof onChunk !== 'function') {
      fail('TORBOX_CALLBACK_REQUIRED', 'onChunk callback is required', false)
    }

    let downloadUrl = await this._fetchDownloadLink(torrentId, fileId, { signal })

    let response
    try {
      response = await this.fetchImpl(downloadUrl, {
        method: 'GET',
        headers: {
          Range: `bytes=${start}-${end}`,
          'User-Agent': 'peartube-relay/1.0'
        },
        signal
      })
    } catch (err) {
      if (signal?.aborted) throw err
      fail('TORBOX_CDN_UNREACHABLE', `TorBox CDN range read failed: ${err?.message || String(err)}`, true)
    }

    // If CDN link expired, retry once with forceFresh
    if (response.status === 401 || response.status === 403 || response.status === 410) {
      downloadUrl = await this._fetchDownloadLink(torrentId, fileId, { forceFresh: true, signal })
      try {
        response = await this.fetchImpl(downloadUrl, {
          method: 'GET',
          headers: {
            Range: `bytes=${start}-${end}`,
            'User-Agent': 'peartube-relay/1.0'
          },
          signal
        })
      } catch (err) {
        if (signal?.aborted) throw err
        fail('TORBOX_CDN_UNREACHABLE', `TorBox CDN range read retry failed: ${err?.message || String(err)}`, true)
      }
    }

    if (response.status !== 206 && response.status !== 200) {
      fail('TORBOX_RANGE_FAILED', `TorBox CDN range request failed with HTTP ${response.status}`, response.status >= 500)
    }

    let totalStreamed = 0
    const expectedBytes = end - start + 1

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel().catch(() => {})
            fail('CANCELLED', 'Range read cancelled', true)
          }
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            const buf = ArrayBuffer.isView(value) ? value : b4a.from(value)
            onChunk(buf)
            totalStreamed += buf.byteLength
          }
        }
      } finally {
        reader.releaseLock?.()
      }
    } else if (typeof response.arrayBuffer === 'function') {
      const ab = await response.arrayBuffer()
      const buf = b4a.from(ab)
      onChunk(buf)
      totalStreamed += buf.byteLength
    } else {
      fail('TORBOX_BODY_UNREADABLE', 'Response body has no reader or arrayBuffer', true)
    }

    if (totalStreamed !== expectedBytes) {
      fail('TORBOX_BYTES_MISMATCH', `Streamed ${totalStreamed} bytes, expected ${expectedBytes}`, true)
    }
  }

  async revoke () {
    // No remote resource to tear down on TorBox
  }
}

export function createTorBoxSourceClient (options = {}) {
  return new TorBoxSourceClient(options)
}
