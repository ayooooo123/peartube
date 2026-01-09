/**
 * ChannelStreamReader
 *
 * Provides IOContext-compatible sync read/seek using bare-channel
 * to communicate with a downloader worker thread.
 *
 * Key features:
 * - readSync() blocks natively (no event loop deadlock)
 * - Sends seek hints to worker for prefetching
 * - Creates IOContext for bare-ffmpeg
 */

import Worker from 'bare-worker'
import Channel from 'bare-channel'
import http from 'bare-http1'

// Chunk size for read requests
const READ_CHUNK_SIZE = 64 * 1024  // 64KB per read

function getWorkerOverride() {
  try {
    const override = globalThis?.__PEARTUBE_WORKER_PATH__
    if (typeof override === 'string' && override.trim()) {
      return override.trim()
    }
  } catch {}
  return null
}

function normalizeWorkerSpec(spec) {
  if (!spec) return null
  if (spec instanceof URL) return spec

  const value = String(spec).trim()
  if (!value) return null

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  if (hasScheme) {
    try {
      return new URL(value)
    } catch {
      return value
    }
  }

  if (value.startsWith('/')) {
    try {
      return new URL(`file://${value}`)
    } catch {
      return value
    }
  }

  try {
    return new URL(value, import.meta.url)
  } catch {
    return value
  }
}

function formatWorkerSpec(spec) {
  return spec instanceof URL ? spec.href : String(spec)
}

/**
 * ChannelStreamReader - sync reads via bare-channel
 */
export class ChannelStreamReader {
  constructor(url, fileSize) {
    this.url = url
    this.fileSize = fileSize

    // Channels for communication with worker
    this.dataChannel = null
    this.cmdChannel = null
    this.dataPort = null
    this.cmdPort = null

    // Worker
    this.worker = null
    this.workerReady = false
    this.workerUrl = null

    // Read buffer - stores data received from worker
    this.buffer = new Map()  // offset -> { data, end }

    // Current position for IOContext
    this.currentPos = 0

    // Stats
    this.bytesRead = 0
    this.readCalls = 0

    console.log('[ChannelStreamReader] Created for', url.substring(0, 60), 'size:', Math.round(fileSize / 1024 / 1024) + 'MB')
  }

  /**
   * Start the worker and wait for it to be ready
   */
  async start() {
    const overridePath = getWorkerOverride()
    const pathsToTry = [
      ...(overridePath ? [overridePath] : []),
      './downloader-worker.mjs',           // Source file (dev)
      './downloader-worker.bundle.js',     // Bundled worker (same dir)
      '../downloader-worker.bundle.js',    // Bundled worker (parent dir)
      '../../downloader-worker.bundle.js', // Bundled worker (grandparent dir)
      '/downloader-worker.bundle.js',      // Bundled worker (root)
    ]

    let lastError = null

    for (const pathToTry of pathsToTry) {
      const workerSpec = normalizeWorkerSpec(pathToTry)
      if (!workerSpec) {
        continue
      }

      try {
        await this.startWorker(workerSpec)
        this.workerUrl = workerSpec
        return
      } catch (err) {
        lastError = err
        const message = err?.message || ''
        if (!message.includes('WORKER_NOT_AVAILABLE') && !message.includes('MODULE_NOT_FOUND')) {
          throw err
        }
      }
    }

    throw lastError || new Error('WORKER_NOT_AVAILABLE: Worker module not found')
  }

  async startWorker(workerSpec) {
    return new Promise((resolve, reject) => {
      const dataChannel = new Channel()
      const cmdChannel = new Channel()
      const dataPort = dataChannel.connect()
      const cmdPort = cmdChannel.connect()

      const cleanupAttempt = (workerInstance) => {
        try { workerInstance?.terminate?.() } catch {}
        try { dataPort.close() } catch {}
        try { cmdPort.close() } catch {}
      }

      let workerInstance

      try {
        console.log('[ChannelStreamReader] Trying worker path:', formatWorkerSpec(workerSpec))
        workerInstance = new Worker(workerSpec)
      } catch (err) {
        cleanupAttempt(workerInstance)
        reject(new Error('WORKER_NOT_AVAILABLE: Worker module not found'))
        return
      }

      let ready = false
      const timeout = setTimeout(() => {
        if (!ready) {
          cleanupAttempt(workerInstance)
          reject(new Error('WORKER_NOT_AVAILABLE: Worker initialization timeout'))
        }
      }, 30000)

      workerInstance.on('error', (err) => {
        clearTimeout(timeout)
        cleanupAttempt(workerInstance)
        const message = err?.message || ''
        if (message.includes('MODULE_NOT_FOUND') || err?.code === 'MODULE_NOT_FOUND') {
          reject(new Error('WORKER_NOT_AVAILABLE: Worker module not found'))
        } else {
          reject(err)
        }
      })

      workerInstance.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          ready = true
          this.worker = workerInstance
          this.workerReady = true
          this.dataChannel = dataChannel
          this.cmdChannel = cmdChannel
          this.dataPort = dataPort
          this.cmdPort = cmdPort
          console.log('[ChannelStreamReader] Worker ready')
          resolve()
        } else if (msg.type === 'stopped') {
          console.log('[ChannelStreamReader] Worker stopped')
        }
      })

      workerInstance.postMessage({
        type: 'init',
        url: this.url,
        fileSize: this.fileSize,
        dataChannelHandle: dataChannel.handle,
        cmdChannelHandle: cmdChannel.handle
      })
    })
  }

  /**
   * Request data from worker and wait for response
   */
  requestData(offset, length) {
    // Send read request to worker
    this.cmdPort.writeSync({
      type: 'read',
      offset,
      length
    })

    // Block until we receive data response
    while (true) {
      const msg = this.dataPort.readSync()
      if (msg === null) {
        throw new Error('Channel closed unexpectedly')
      }

      if (msg.type === 'data') {
        // Store in buffer
        const data = Buffer.from(msg.buffer)
        this.buffer.set(msg.offset, {
          data,
          end: msg.offset + data.byteLength
        })

        // Check if this satisfies our request
        if (msg.offset <= offset && msg.offset + data.byteLength >= offset + length) {
          return
        }
        // Keep waiting for more data
      } else if (msg.type === 'error') {
        throw new Error(msg.message)
      } else if (msg.type === 'eof') {
        return
      }
    }
  }

  /**
   * Read from buffer at offset
   */
  readFromBuffer(offset, length) {
    for (const [bufOffset, buf] of this.buffer) {
      if (bufOffset <= offset && buf.end >= offset + length) {
        const localOffset = offset - bufOffset
        return buf.data.subarray(localOffset, localOffset + length)
      }
    }
    return null
  }

  /**
   * Synchronous read for IOContext
   */
  syncRead(buffer) {
    this.readCalls++

    if (this.currentPos >= this.fileSize) {
      return 0  // EOF
    }

    const toRead = Math.min(buffer.length, this.fileSize - this.currentPos)

    // Try to read from buffer
    let data = this.readFromBuffer(this.currentPos, toRead)

    if (!data) {
      // Request data from worker (blocks until available)
      try {
        this.requestData(this.currentPos, toRead)
        data = this.readFromBuffer(this.currentPos, toRead)
      } catch (err) {
        console.error('[ChannelStreamReader] Read error:', err.message)
        return -1
      }
    }

    if (!data) {
      // Still no data - likely EOF or error
      return 0
    }

    const bytesToCopy = Math.min(data.byteLength, buffer.length)
    data.copy(buffer, 0, 0, bytesToCopy)
    this.currentPos += bytesToCopy
    this.bytesRead += bytesToCopy

    // Clean up old buffer entries
    this.cleanupBuffer()

    return bytesToCopy
  }

  /**
   * Synchronous seek for IOContext
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

    // Log large seeks (likely MKV Cues lookup)
    if (Math.abs(newPos - this.currentPos) > 1024 * 1024) {
      console.log('[ChannelStreamReader] Seek:', Math.round(this.currentPos / 1024 / 1024) + 'MB →', Math.round(newPos / 1024 / 1024) + 'MB')

      // Send seek hint to worker for prefetching
      try {
        this.cmdPort.writeSync({
          type: 'seek',
          offset: newPos
        })
      } catch (err) {
        // Non-critical - worker may prefetch slower
      }
    }

    this.currentPos = newPos
    return this.currentPos
  }

  /**
   * Clean up old buffer entries to manage memory
   */
  cleanupBuffer() {
    // Keep only entries within 10MB of current position
    const keepWindow = 10 * 1024 * 1024
    const toDelete = []

    for (const [offset, buf] of this.buffer) {
      if (buf.end < this.currentPos - keepWindow || offset > this.currentPos + keepWindow) {
        toDelete.push(offset)
      }
    }

    for (const offset of toDelete) {
      this.buffer.delete(offset)
    }
  }

  /**
   * Create IOContext for bare-ffmpeg
   */
  createIOContext(ffmpeg) {
    const self = this

    const ioContext = new ffmpeg.IOContext(65536, {
      onread: (buffer) => {
        return self.syncRead(buffer)
      },

      onseek: (offset, whence) => {
        return self.syncSeek(offset, whence)
      }
    })

    ioContext._reader = this
    ioContext._cleanup = () => {
      console.log('[ChannelStreamReader] Cleanup - bytes read:', Math.round(self.bytesRead / 1024 / 1024) + 'MB, read calls:', self.readCalls)
    }

    return ioContext
  }

  /**
   * Stop the worker and cleanup
   */
  destroy() {
    console.log('[ChannelStreamReader] Destroying')

    if (this.worker) {
      this.worker.postMessage({ type: 'stop' })
      setTimeout(() => {
        try {
          this.worker.terminate?.()
        } catch {}
      }, 1000)
    }

    if (this.dataPort) {
      try { this.dataPort.close() } catch {}
    }
    if (this.cmdPort) {
      try { this.cmdPort.close() } catch {}
    }

    this.buffer.clear()
  }
}

/**
 * Get file size from HTTP HEAD/Range request
 */
export async function getHttpFileSize(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }

    const options = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Range': 'bytes=0-0'
      }
    }

    const req = http.request(options, (res) => {
      const contentRange = res.headers['content-range']
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) {
          const size = parseInt(match[1], 10)
          res.on('data', () => {})
          res.on('end', () => resolve(size))
          return
        }
      }

      const contentLength = parseInt(res.headers['content-length'], 10) || 0
      res.on('data', () => {})
      res.on('end', () => resolve(contentLength))
    })

    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('HTTP timeout'))
    })
    req.end()
  })
}

export default ChannelStreamReader
