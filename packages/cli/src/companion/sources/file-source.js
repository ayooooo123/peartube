import b4a from 'b4a'
import nodeFs from 'node:fs'

const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

export class FileSourceError extends Error {
  constructor (code, message, recoverable = true) {
    super(message)
    this.name = 'FileSourceError'
    this.code = code
    this.recoverable = recoverable
  }
}

function fail (code, message, recoverable = true) {
  throw new FileSourceError(code, message, recoverable)
}

/**
 * Direct file / WebDAV source client for PearTube Companion.
 * Used when media already resides on local disk or an authenticated WebDAV mount
 * (e.g. library recordings, completed downloads from external engines, or NAS storage).
 */
export class FileSourceClient {
  constructor ({
    fs = nodeFs,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowedPaths = [],
    defaultWebdavBase = '',
    webdavUsername = '',
    webdavPassword = '',
    fetchImpl = globalThis.fetch
  } = {}) {
    this.fs = fs
    this.chunkBytes = Number.isSafeInteger(chunkBytes) && chunkBytes > 0 ? chunkBytes : DEFAULT_CHUNK_BYTES
    this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
    this.allowedPaths = Array.isArray(allowedPaths) ? allowedPaths.map(p => String(p).trim()).filter(Boolean) : []
    this.defaultWebdavBase = typeof defaultWebdavBase === 'string' ? defaultWebdavBase.trim() : ''
    this.webdavUsername = typeof webdavUsername === 'string' ? webdavUsername.trim() : ''
    this.webdavPassword = typeof webdavPassword === 'string' ? webdavPassword.trim() : ''
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  }

  _isPathAllowed (filePath) {
    if (this.allowedPaths.length === 0) return true
    return this.allowedPaths.some(prefix => filePath === prefix || filePath.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
  }

  _resolveDescriptor (descriptor = {}) {
    const cap = typeof descriptor.capability === 'object' && descriptor.capability !== null ? descriptor.capability : {}
    const rawFilePath = descriptor.filePath ?? cap.filePath
    const filePath = typeof rawFilePath === 'string' && rawFilePath.trim()
      ? rawFilePath.trim()
      : null

    const rawWebdavUrl = descriptor.webdavUrl ?? cap.webdavUrl
    let webdavUrl = typeof rawWebdavUrl === 'string' && rawWebdavUrl.trim()
      ? rawWebdavUrl.trim()
      : null

    const rawWebdavPath = descriptor.webdavPath ?? cap.webdavPath
    if (!webdavUrl && typeof rawWebdavPath === 'string' && rawWebdavPath.trim() && this.defaultWebdavBase) {
      const cleanPath = rawWebdavPath.trim().replace(/^\/+/, '')
      webdavUrl = `${this.defaultWebdavBase.replace(/\/+$/, '')}/${cleanPath}`
    }

    if (!filePath && !webdavUrl) {
      fail('FILE_DESCRIPTOR_INVALID', 'File source descriptor requires filePath, webdavUrl, or webdavPath', false)
    }

    if (filePath && !this._isPathAllowed(filePath)) {
      fail('FILE_ACCESS_DENIED', `Access to path is not allowed by relay configuration: ${filePath}`, false)
    }

    return { filePath, webdavUrl }
  }

  _authHeaders (descriptor = {}) {
    const headers = { 'User-Agent': 'peartube-relay/1.0' }
    const user = descriptor.username || this.webdavUsername
    const pass = descriptor.password || this.webdavPassword
    if (user || pass) {
      const token = b4a.toString(b4a.from(`${user}:${pass}`), 'base64')
      headers.Authorization = `Basic ${token}`
    }
    return headers
  }

  async head (descriptor = {}) {
    const { filePath, webdavUrl } = this._resolveDescriptor(descriptor)

    // Option 1: Local file on disk
    if (filePath && this.fs && typeof this.fs.statSync === 'function') {
      try {
        const stat = this.fs.statSync(filePath)
        if (!stat.isFile()) {
          fail('FILE_NOT_REGULAR', `Specified filePath is not a regular file: ${filePath}`, false)
        }
        const length = stat.size
        if (length <= 0) {
          fail('FILE_EMPTY', `Specified filePath is empty: ${filePath}`, false)
        }
        const etag = `"${stat.mtimeMs.toFixed(0)}:${length}"`
        return { length, etag, mimeType: 'video/mp4' }
      } catch (err) {
        if (err instanceof FileSourceError) throw err
        if (!webdavUrl) {
          fail('FILE_NOT_FOUND', `Failed to stat local file: ${err?.message || String(err)}`, false)
        }
      }
    }

    // Option 2: WebDAV endpoint
    if (webdavUrl) {
      let response
      try {
        response = await this.fetchImpl(webdavUrl, {
          method: 'HEAD',
          headers: this._authHeaders(descriptor),
          signal: descriptor.signal || null
        })
      } catch (err) {
        fail('WEBDAV_UNREACHABLE', `WebDAV HEAD request failed: ${err?.message || String(err)}`, true)
      }

      if (!response.ok) {
        fail('WEBDAV_ERROR', `WebDAV HEAD returned HTTP ${response.status}`, response.status >= 500)
      }

      const lengthHeader = response.headers?.get?.('content-length') ?? response.headers?.['content-length']
      const length = Number(lengthHeader)
      if (!Number.isSafeInteger(length) || length <= 0) {
        fail('LENGTH_INVALID', `WebDAV HEAD returned invalid Content-Length: ${lengthHeader}`, true)
      }

      const etagHeader = response.headers?.get?.('etag') ?? response.headers?.etag
      const etag = typeof etagHeader === 'string' && etagHeader.trim()
        ? etagHeader.trim()
        : `"${length}"`

      const mimeTypeHeader = response.headers?.get?.('content-type') ?? response.headers?.['content-type']
      const mimeType = typeof mimeTypeHeader === 'string' && mimeTypeHeader.includes('/')
        ? mimeTypeHeader.split(';')[0].trim()
        : 'video/mp4'

      return { length, etag, mimeType }
    }

    fail('SOURCE_UNAVAILABLE', 'No usable file or WebDAV source found in descriptor', false)
  }

  async getRange (descriptor = {}) {
    const { start, end, onChunk, signal = null } = descriptor
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      fail('RANGE_INVALID', `Invalid range [${start}, ${end}]`, false)
    }
    if (typeof onChunk !== 'function') {
      fail('CALLBACK_REQUIRED', 'onChunk callback is required', false)
    }

    const { filePath, webdavUrl } = this._resolveDescriptor(descriptor)

    // Option 1: Local file read via file descriptor
    if (filePath && this.fs && typeof this.fs.openSync === 'function') {
      let fd = null
      try {
        fd = this.fs.openSync(filePath, 'r')
        const totalBytes = end - start + 1
        const readBufferSize = Math.min(totalBytes, 1024 * 1024)
        const buffer = b4a.alloc(readBufferSize)
        let remaining = totalBytes
        let currentOffset = start

        while (remaining > 0) {
          if (signal?.aborted) {
            fail('CANCELLED', 'Range read cancelled', true)
          }
          const bytesToRead = Math.min(remaining, readBufferSize)
          const bytesRead = this.fs.readSync(fd, buffer, 0, bytesToRead, currentOffset)
          if (bytesRead === 0) break
          onChunk(buffer.subarray(0, bytesRead))
          remaining -= bytesRead
          currentOffset += bytesRead
        }

        if (remaining > 0) {
          fail('UNEXPECTED_EOF', `Local file read hit unexpected EOF, missing ${remaining} bytes`, true)
        }
        return
      } catch (err) {
        if (err instanceof FileSourceError) throw err
        if (!webdavUrl) {
          fail('FILE_READ_FAILED', `Local file read failed: ${err?.message || String(err)}`, true)
        }
      } finally {
        if (fd !== null) {
          try { this.fs.closeSync(fd) } catch {}
        }
      }
    }

    // Option 2: WebDAV range stream
    if (webdavUrl) {
      let response
      try {
        response = await this.fetchImpl(webdavUrl, {
          method: 'GET',
          headers: {
            ...this._authHeaders(descriptor),
            Range: `bytes=${start}-${end}`
          },
          signal
        })
      } catch (err) {
        if (signal?.aborted) throw err
        fail('WEBDAV_UNREACHABLE', `WebDAV range read failed: ${err?.message || String(err)}`, true)
      }

      if (response.status !== 206 && response.status !== 200) {
        fail('RANGE_FAILED', `WebDAV range request returned HTTP ${response.status}`, response.status >= 500)
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
        fail('BODY_UNREADABLE', 'Response body has no reader or arrayBuffer', true)
      }

      if (totalStreamed !== expectedBytes) {
        fail('BYTES_MISMATCH', `Streamed ${totalStreamed} bytes, expected ${expectedBytes}`, true)
      }
      return
    }

    fail('SOURCE_UNAVAILABLE', 'No usable file or WebDAV source found for range read', false)
  }

  async revoke () {}
}

export function createFileSourceClient (options = {}) {
  return new FileSourceClient(options)
}
