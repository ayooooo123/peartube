/**
 * TempFileReader - Progressive Download
 *
 * Downloads video from HTTP URL to a temp file while providing
 * truly synchronous file reads for bare-ffmpeg IOContext.
 *
 * Progressive approach:
 * 1. Start downloading to temp file (async, non-blocking)
 * 2. Wait until initial buffer is ready (e.g., 50MB)
 * 3. Begin transcoding with sync reads from temp file
 * 4. Download continues in parallel, staying ahead of transcode
 *
 * This solves the deadlock issue on BareKit/mobile where the
 * StreamingHttpReader's busy-wait spin loop blocks the event loop.
 *
 * Why this works:
 * - fs.readSync() is truly synchronous - no event loop needed
 * - Download runs async in background, writing to temp file
 * - Transcoding is CPU-bound, typically slower than local HTTP download
 * - Initial buffer ensures transcoding never catches up to download
 */

import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import http from 'bare-http1'

// Initial buffer before starting transcode
// Keep this small for faster startup - we'll handle catching up gracefully
const MIN_INITIAL_BUFFER = 20 * 1024 * 1024   // 20MB minimum - quick start
const MIN_INITIAL_BUFFER_PCT = 0.02           // 2% of file
const MAX_INITIAL_BUFFER = 50 * 1024 * 1024   // 50MB max - balance between startup time and buffer

// Max time to wait for initial buffer before proceeding (avoid indefinite stalls)
const BUFFER_WAIT_TIMEOUT_MS = 30000

// Tail prefetch to grab MKV Cues near end of file
const TAIL_PREFETCH_BYTES = 10 * 1024 * 1024 // 10MB
const TAIL_PREFETCH_TIMEOUT_MS = 30000

// Abort if download stalls for too long (no new bytes)
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000

// How far ahead download should stay (warn if closer)
const MIN_LEAD_BYTES = 10 * 1024 * 1024 // 10MB

// Download chunk size for progress logging
const LOG_INTERVAL_BYTES = 10 * 1024 * 1024 // Log every 10MB for better visibility

/**
 * TempFileReader - progressive download with sync reads
 * 
 * @param {string} url - URL to download from
 * @param {number} fileSize - Total file size in bytes
 * @param {Object} [options] - Options
 * @param {string} [options.tempDir] - Temp directory path
 * @param {boolean} [options.waitForComplete] - If true, wait for full download before starting reads
 */
export class TempFileReader {
  constructor(url, fileSize, options = {}) {
    // Support legacy signature: (url, fileSize, tempDir)
    if (typeof options === 'string') {
      options = { tempDir: options }
    }
    
    this.url = url
    this.fileSize = fileSize
    this.parsedUrl = new URL(url)
    
    // If video is fully synced, wait for complete download to avoid async/sync deadlock
    this.waitForComplete = options.waitForComplete || false

    // Generate unique temp file path
    // os.tmpdir() can crash on some Android environments, so use fallbacks
    let tmpDir = options.tempDir
    if (!tmpDir) {
      try {
        tmpDir = os.tmpdir()
      } catch (e) {
        console.warn('[TempFileReader] os.tmpdir() failed:', e?.message)
        tmpDir = '/tmp'  // Fallback
      }
    }
    const uniqueId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    this.tempPath = path.join(tmpDir, `hls-download-${uniqueId}.tmp`)

    // File handles
    this.writeFd = null  // For async download writes
    this.readFd = null   // For sync transcoder reads

    // Download state
    this.downloadedBytes = 0
    this.downloadComplete = false
    this.downloadError = null
    this.downloadAborted = false
    this.downloadRequest = null

    // Current read position
    this.currentPos = 0

    // Stats
    this.readCount = 0
    this.seekCount = 0
    this.waitCount = 0  // Times we had to wait for download

    // Calculate initial buffer size
    this.initialBufferSize = Math.min(
      Math.max(MIN_INITIAL_BUFFER, Math.floor(fileSize * MIN_INITIAL_BUFFER_PCT)),
      MAX_INITIAL_BUFFER,
      fileSize
    )

    // Tail prefetch (for MKV cues)
    this.tailBytes = Math.min(TAIL_PREFETCH_BYTES, this.fileSize)
    this.tailStart = Math.max(0, this.fileSize - this.tailBytes)
    this.tailDownloaded = 0
    this.tailComplete = this.fileSize <= this.initialBufferSize
    this.tailError = null
    this.tailRequest = null
    this.tailPromise = null
    this.downloadPromise = null

    // Buffer wait coordination (avoid timer-only polling)
    this._bufferWaitTarget = null
    this._bufferWaitResolve = null
    this._bufferWaitReject = null
    this._bufferWaitTimer = null

    console.log('[TempFileReader] Created for', url.substring(0, 60))
    console.log('[TempFileReader] File size:', Math.round(fileSize / 1024 / 1024) + 'MB')
    console.log('[TempFileReader] Initial buffer:', Math.round(this.initialBufferSize / 1024 / 1024) + 'MB',
      '(min=' + Math.round(MIN_INITIAL_BUFFER / 1024 / 1024) + 'MB,',
      'pct=' + Math.round(MIN_INITIAL_BUFFER_PCT * 100) + '%,',
      'max=' + Math.round(MAX_INITIAL_BUFFER / 1024 / 1024) + 'MB)')
    console.log('[TempFileReader] Temp file:', this.tempPath)
  }

  /**
   * Start download and wait for initial buffer
   * Returns when enough data is buffered to start transcoding
   * @param {function} onProgress - Optional progress callback (downloadedBytes, totalBytes)
   */
  async startDownload(onProgress) {
    console.log('[TempFileReader] Starting progressive download...')

    // Create temp file for writing
    this.writeFd = fs.openSync(this.tempPath, 'w')

    // Prefetch tail first so MKV cues are available before FFmpeg starts.
    // Some environments appear to serialize HTTP reads, so doing tail first
    // avoids waiting on a long full-file download.
    this.tailPromise = this._prefetchTail()
    await this._waitForTail(TAIL_PREFETCH_TIMEOUT_MS)

    // Start download in background after tail prefetch attempt
    this.downloadPromise = this._downloadInBackground(onProgress)

    // If video is fully synced (isComplete flag), wait for entire download
    // This avoids the async/sync mismatch that causes deadlocks
    if (this.waitForComplete) {
      console.log('[TempFileReader] Video is fully synced, waiting for complete download...')
      const downloadStart = Date.now()
      await this.downloadPromise
      const downloadTime = Date.now() - downloadStart
      console.log('[TempFileReader] Full download complete in', Math.round(downloadTime / 1000) + 's')
    } else {
      // Wait for initial buffer only (risky for partially synced videos)
      console.log('[TempFileReader] Waiting for initial buffer...')
      await this._waitForBuffer(this.initialBufferSize)
    }

    // Open file for sync reading (separate fd)
    this.readFd = fs.openSync(this.tempPath, 'r')
    console.log('[TempFileReader] File ready for reading, size:', Math.round(this.downloadedBytes / 1024 / 1024) + 'MB, read fd:', this.readFd)

    // Do not return the download promise here (would block until full download).
    // Expose it via the return object to avoid Promise assimilation by async/await.
    if (this.tailPromise) {
      this.tailPromise.catch(() => {})
    }
    return {
      downloadPromise: this.downloadPromise,
      tailPromise: this.tailPromise
    }
  }

  /**
   * Download file in background
   */
  _downloadInBackground(onProgress) {
    return new Promise((resolve, reject) => {
      const options = {
        method: 'GET',
        hostname: this.parsedUrl.hostname,
        port: this.parsedUrl.port || 80,
        path: this.parsedUrl.pathname + this.parsedUrl.search
      }

      let lastLoggedBytes = 0
      let lastProgressAt = Date.now()
      const downloadStart = Date.now()
      let settled = false
      let idleTimer = null

      const finalize = (err) => {
        if (settled) return
        settled = true
        if (idleTimer) {
          clearInterval(idleTimer)
          idleTimer = null
        }
        if (err) {
          this.downloadError = err
          reject(err)
          return
        }
        resolve()
      }

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}`)
          this.downloadError = err
          res.resume()
          finalize(err)
          return
        }

        res.on('data', (chunk) => {
          if (this.downloadAborted) return
          lastProgressAt = Date.now()

          try {
            // Write chunk to temp file
            fs.writeSync(this.writeFd, chunk, 0, chunk.length, this.downloadedBytes)
            this.downloadedBytes += chunk.length

            // Log progress
            if (this.downloadedBytes - lastLoggedBytes >= LOG_INTERVAL_BYTES) {
              const pct = Math.round((this.downloadedBytes / this.fileSize) * 100)
              console.log('[TempFileReader] Download:', Math.round(this.downloadedBytes / 1024 / 1024) + 'MB (' + pct + '%)')
              lastLoggedBytes = this.downloadedBytes

              if (onProgress) {
                onProgress(this.downloadedBytes, this.fileSize)
              }
            }

            // Resolve buffer waiters as soon as threshold is reached
            this._maybeResolveBufferWait()
          } catch (err) {
            console.error('[TempFileReader] Write error:', err.message)
            this.downloadError = err
            this._maybeResolveBufferWait()
          }
        })

        res.on('end', () => {
          this.downloadComplete = true
          console.log('[TempFileReader] Download complete:', Math.round(this.downloadedBytes / 1024 / 1024) + 'MB')

          // Close write fd
          if (this.writeFd !== null) {
            try { fs.closeSync(this.writeFd) } catch {}
            this.writeFd = null
          }

          this._maybeResolveBufferWait()
          finalize()
        })

        res.on('error', (err) => {
          console.error('[TempFileReader] Download error:', err.message)
          this._maybeResolveBufferWait()
          finalize(err)
        })
      })

      req.on('error', (err) => {
        this._maybeResolveBufferWait()
        finalize(err)
      })

      this.downloadRequest = req

      idleTimer = setInterval(() => {
        if (settled || this.downloadAborted || this.downloadComplete) return
        const idleFor = Date.now() - lastProgressAt
        if (idleFor >= DOWNLOAD_IDLE_TIMEOUT_MS) {
          const elapsed = Math.round((Date.now() - downloadStart) / 1000)
          const idleSecs = Math.round(idleFor / 1000)
          const err = new Error(`Download stalled for ${idleSecs}s (elapsed ${elapsed}s)`)
          console.error('[TempFileReader] Download idle timeout:', err.message)
          try { req.destroy() } catch {}
          finalize(err)
        }
      }, 1000)

      req.end()
    })
  }

  /**
   * Prefetch tail bytes for MKV cues (range request)
   */
  _prefetchTail() {
    if (this.tailComplete || this.tailBytes <= 0 || this.fileSize <= this.initialBufferSize) {
      this.tailComplete = true
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const options = {
        method: 'GET',
        hostname: this.parsedUrl.hostname,
        port: this.parsedUrl.port || 80,
        path: this.parsedUrl.pathname + this.parsedUrl.search,
        headers: {
          Range: `bytes=${this.tailStart}-${this.fileSize - 1}`
        }
      }

      const req = http.request(options, (res) => {
        if (res.statusCode !== 206) {
          this.tailError = new Error(`Tail prefetch status ${res.statusCode}`)
          console.warn('[TempFileReader] Tail prefetch failed:', this.tailError.message)
          res.resume()
          resolve()
          return
        }

        res.on('data', (chunk) => {
          if (this.downloadAborted) return
          try {
            fs.writeSync(this.writeFd, chunk, 0, chunk.length, this.tailStart + this.tailDownloaded)
            this.tailDownloaded += chunk.length
          } catch (err) {
            this.tailError = err
            console.error('[TempFileReader] Tail write error:', err.message)
          }
        })

        res.on('end', () => {
          this.tailComplete = true
          console.log('[TempFileReader] Tail prefetch complete:', Math.round(this.tailDownloaded / 1024 / 1024) + 'MB')
          resolve()
        })

        res.on('error', (err) => {
          this.tailError = err
          console.error('[TempFileReader] Tail prefetch error:', err.message)
          resolve()
        })
      })

      req.on('error', (err) => {
        this.tailError = err
        console.error('[TempFileReader] Tail prefetch request error:', err.message)
        resolve()
      })

      this.tailRequest = req

      req.setTimeout(TAIL_PREFETCH_TIMEOUT_MS, () => {
        req.destroy()
        this.tailError = new Error('Tail prefetch timeout')
        console.warn('[TempFileReader] Tail prefetch timeout')
        resolve()
      })

      req.end()
    })
  }

  /**
   * Wait for tail prefetch to complete or timeout
   */
  _waitForTail(timeoutMs) {
    if (this.tailComplete || this.tailBytes <= 0 || this.fileSize <= this.initialBufferSize) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const start = Date.now()
      const check = () => {
        if (this.tailComplete || this.tailError || this.downloadComplete) {
          resolve()
          return
        }

        if (Date.now() - start >= timeoutMs) {
          console.warn('[TempFileReader] Tail prefetch timeout, continuing without full tail')
          resolve()
          return
        }

        setTimeout(check, 50)
      }

      check()
    })
  }

  /**
   * Wait until specified bytes are downloaded
   */
  _waitForBuffer(targetBytes) {
    return new Promise((resolve, reject) => {
      if (this._bufferWaitTimer) {
        clearTimeout(this._bufferWaitTimer)
        this._bufferWaitTimer = null
      }
      this._bufferWaitTarget = targetBytes
      this._bufferWaitResolve = resolve
      this._bufferWaitReject = reject
      this._bufferWaitTimer = setTimeout(() => {
        if (!this._bufferWaitResolve) return
        const downloadedMb = Math.round(this.downloadedBytes / 1024 / 1024)
        const targetMb = Math.round((this._bufferWaitTarget || 0) / 1024 / 1024)
        console.warn('[TempFileReader] Initial buffer timeout after',
          Math.round(BUFFER_WAIT_TIMEOUT_MS / 1000) + 's,',
          'downloaded:', downloadedMb + 'MB',
          'target:', targetMb + 'MB')
        const resolveWait = this._bufferWaitResolve
        const rejectWait = this._bufferWaitReject
        this._bufferWaitResolve = null
        this._bufferWaitReject = null
        this._bufferWaitTarget = null
        this._bufferWaitTimer = null
        if (this.downloadedBytes > 0 || this.downloadComplete) {
          resolveWait()
        } else {
          rejectWait(new Error('Initial buffer timeout - no data downloaded'))
        }
      }, BUFFER_WAIT_TIMEOUT_MS)
      this._maybeResolveBufferWait()
    })
  }

  _maybeResolveBufferWait() {
    if (!this._bufferWaitResolve) return

    if (this.downloadError) {
      const reject = this._bufferWaitReject
      this._bufferWaitResolve = null
      this._bufferWaitReject = null
      this._bufferWaitTarget = null
      if (this._bufferWaitTimer) {
        clearTimeout(this._bufferWaitTimer)
        this._bufferWaitTimer = null
      }
      reject(this.downloadError)
      return
    }

    if (this.downloadedBytes >= (this._bufferWaitTarget || 0) || this.downloadComplete) {
      const resolve = this._bufferWaitResolve
      this._bufferWaitResolve = null
      this._bufferWaitReject = null
      this._bufferWaitTarget = null
      if (this._bufferWaitTimer) {
        clearTimeout(this._bufferWaitTimer)
        this._bufferWaitTimer = null
      }
      const downloadedMb = Math.round(this.downloadedBytes / 1024 / 1024)
      const targetMb = Math.round((this._bufferWaitTarget || 0) / 1024 / 1024)
      console.log('[TempFileReader] Initial buffer ready:', downloadedMb + 'MB',
        'target:', targetMb + 'MB')
      resolve()
    }
  }

  /**
   * Synchronous read for IOContext
   * This is truly synchronous - no event loop involvement
   */
  syncRead(buffer) {
    if (this.readFd === null) {
      console.error('[TempFileReader] syncRead called before startDownload!')
      return -1
    }

    if (this.downloadError) {
      console.error('[TempFileReader] syncRead download error:', this.downloadError.message)
      // Return 0 (EOF) instead of -1 to avoid FFmpeg native crash
      return 0
    }

    if (this.currentPos >= this.fileSize) {
      return 0 // EOF
    }

    let toRead = Math.min(buffer.length, this.fileSize - this.currentPos)

    // Check if enough data is downloaded
    const endPos = this.currentPos + toRead
    const availableToRead = this._getAvailableBytes(this.currentPos, toRead)

    // If we've caught up to the download, return EOF immediately
    // IMPORTANT: We cannot spin-wait here because it blocks the event loop,
    // which prevents the HTTP download from receiving more data (deadlock!)
    if (!this.downloadComplete && availableToRead <= 0) {
      this.waitCount++
      console.error('[TempFileReader] Transcoder caught up to download! STOPPING.',
        'pos:', Math.round(this.currentPos / 1024 / 1024) + 'MB',
        'downloaded:', Math.round(this.downloadedBytes / 1024 / 1024) + 'MB',
        'fileSize:', Math.round(this.fileSize / 1024 / 1024) + 'MB')
      console.error('[TempFileReader] This usually means the video is still being P2P synced.',
        'Wait for the video to fully download before casting.')
      // Return EOF (0) instead of error (-1) to avoid FFmpeg crash
      // Transcoding will end early but app won't crash
      return 0
    }
    if (availableToRead > 0 && availableToRead < toRead) {
      toRead = availableToRead
    }

    // Warn if lead is getting small
    const currentLead = this.downloadedBytes - this.currentPos
    if (!this.downloadComplete && this.currentPos < this.downloadedBytes && currentLead < MIN_LEAD_BYTES && this.readCount % 100 === 0) {
      console.warn('[TempFileReader] Low download lead:', Math.round(currentLead / 1024) + 'KB')
    }

    try {
      // fs.readSync is truly synchronous - no callbacks, no event loop
      const bytesRead = fs.readSync(this.readFd, buffer, 0, toRead, this.currentPos)
      this.currentPos += bytesRead
      this.readCount++

      // Log occasionally
      if (this.readCount === 1 || this.readCount % 2000 === 0) {
        const pct = Math.round((this.currentPos / this.fileSize) * 100)
        console.log('[TempFileReader] Read progress:', pct + '%',
          'pos:', Math.round(this.currentPos / 1024 / 1024) + 'MB',
          'lead:', Math.round(currentLead / 1024 / 1024) + 'MB')
      }

      return bytesRead
    } catch (err) {
      console.error('[TempFileReader] syncRead error:', err.message)
      return -1
    }
  }

  /**
   * Seek for IOContext
   */
  syncSeek(offset, whence) {
    const SEEK_SET = 0
    const SEEK_CUR = 1
    const SEEK_END = 2
    const AVSEEK_SIZE = 0x10000

    if (whence === AVSEEK_SIZE) {
      return this.fileSize
    }

    let newPos = this.currentPos
    if (whence === SEEK_SET) {
      newPos = offset
    } else if (whence === SEEK_CUR) {
      newPos += offset
    } else if (whence === SEEK_END) {
      newPos = this.fileSize + offset
    }

    newPos = Math.max(0, Math.min(newPos, this.fileSize))

    // Log significant seeks
    const seekDistance = Math.abs(newPos - this.currentPos)
    if (seekDistance > 1024 * 1024) {
      this.seekCount++
      console.log('[TempFileReader] Seek #' + this.seekCount + ':',
        Math.round(this.currentPos / 1024 / 1024) + 'MB ->',
        Math.round(newPos / 1024 / 1024) + 'MB')
    }

    this.currentPos = newPos
    return this.currentPos
  }

  _getAvailableBytes(start, requested) {
    if (this.downloadComplete) return requested
    if (start < this.downloadedBytes) {
      return Math.min(requested, this.downloadedBytes - start)
    }
    if (this.tailComplete && start >= this.tailStart && start < this.tailStart + this.tailDownloaded) {
      return Math.min(requested, (this.tailStart + this.tailDownloaded) - start)
    }
    return 0
  }

  /**
   * Create IOContext for bare-ffmpeg
   * Must call startDownload() first and wait for it!
   */
  createIOContext(ffmpeg) {
    if (this.readFd === null) {
      throw new Error('Must call startDownload() and wait before createIOContext()')
    }

    const self = this

    // Use larger buffer for IOContext (128KB)
    const ioContext = new ffmpeg.IOContext(128 * 1024, {
      onread: (buffer) => {
        return self.syncRead(buffer)
      },

      onseek: (offset, whence) => {
        return self.syncSeek(offset, whence)
      }
    })

    ioContext._reader = this
    ioContext._cleanup = () => {
      console.log('[TempFileReader] IOContext cleanup - reads:', self.readCount,
        'seeks:', self.seekCount, 'waits:', self.waitCount)
    }

    return ioContext
  }

  /**
   * Abort download (call when transcoding is cancelled)
   */
  abort() {
    this.downloadAborted = true
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      downloadedBytes: this.downloadedBytes,
      downloadComplete: this.downloadComplete,
      tailDownloaded: this.tailDownloaded,
      tailComplete: this.tailComplete,
      tailStart: this.tailStart,
      fileSize: this.fileSize,
      currentPos: this.currentPos,
      readCount: this.readCount,
      seekCount: this.seekCount,
      waitCount: this.waitCount,
      lead: this.downloadedBytes - this.currentPos,
      tempPath: this.tempPath
    }
  }

  /**
   * Cleanup resources and temp file
   */
  destroy() {
    console.log('[TempFileReader] Destroying - reads:', this.readCount,
      'seeks:', this.seekCount, 'waits:', this.waitCount)

    this.downloadAborted = true

    // Close file handles
    if (this.writeFd !== null) {
      try { fs.closeSync(this.writeFd) } catch {}
      this.writeFd = null
    }

    if (this.readFd !== null) {
      try { fs.closeSync(this.readFd) } catch {}
      this.readFd = null
    }

    if (this.downloadRequest) {
      try { this.downloadRequest.destroy() } catch {}
      this.downloadRequest = null
    }

    if (this.tailRequest) {
      try { this.tailRequest.destroy() } catch {}
      this.tailRequest = null
    }

    // Delete temp file
    try {
      fs.unlinkSync(this.tempPath)
      console.log('[TempFileReader] Temp file deleted')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[TempFileReader] Error deleting temp file:', err.message)
      }
    }
  }
}

export default TempFileReader
