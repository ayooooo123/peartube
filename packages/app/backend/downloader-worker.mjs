/**
 * Downloader Worker
 *
 * Runs in a separate thread, handles HTTP range requests with priority queue.
 * Communicates with main thread via bare-channel for non-blocking sync reads.
 *
 * Features:
 * - Priority queue (HIGH for seeks/Cues, NORMAL for sequential)
 * - Two concurrent connections (tail for Cues, head for sequential)
 * - Sparse buffer cache for downloaded ranges
 * - Responds to seek hints from main thread
 */

import Worker from 'bare-worker'
import Channel from 'bare-channel'
import http from 'bare-http1'

// Priority levels
const PRIORITY_HIGH = 0   // Seeks, Cues
const PRIORITY_NORMAL = 1 // Sequential reads

// Chunk sizes
const CHUNK_SIZE = 2 * 1024 * 1024      // 2MB per request
const CUES_PREFETCH_SIZE = 10 * 1024 * 1024  // 10MB for MKV Cues
const MAX_CACHE_SIZE = 50 * 1024 * 1024      // 50MB cache

/**
 * Cached byte range
 */
class CachedRange {
  constructor(start, data) {
    this.start = start
    this.end = start + data.byteLength
    this.data = data
    this.lastAccess = Date.now()
  }

  contains(offset, length) {
    return offset >= this.start && (offset + length) <= this.end
  }

  read(offset, length) {
    if (!this.contains(offset, length)) return null
    this.lastAccess = Date.now()
    const localOffset = offset - this.start
    return this.data.slice(localOffset, localOffset + length)
  }
}

/**
 * Priority queue for fetch requests
 */
class FetchQueue {
  constructor() {
    this.high = []
    this.normal = []
  }

  add(request) {
    if (request.priority === PRIORITY_HIGH) {
      this.high.push(request)
    } else {
      this.normal.push(request)
    }
  }

  next() {
    // Always process HIGH priority first
    if (this.high.length > 0) {
      return this.high.shift()
    }
    return this.normal.shift()
  }

  isEmpty() {
    return this.high.length === 0 && this.normal.length === 0
  }

  // Cancel overlapping normal requests when high priority arrives
  cancelOverlapping(offset, length) {
    const end = offset + length
    this.normal = this.normal.filter(req => {
      const reqEnd = req.offset + req.length
      const overlaps = !(reqEnd <= offset || req.offset >= end)
      return !overlaps
    })
  }

  clear() {
    this.high = []
    this.normal = []
  }
}

/**
 * HTTP Downloader with priority queue and caching
 */
class Downloader {
  constructor(url, fileSize, dataPort, cmdPort) {
    this.url = url
    this.fileSize = fileSize
    this.parsedUrl = new URL(url)
    this.dataPort = dataPort  // For sending data to main
    this.cmdPort = cmdPort    // For receiving commands from main

    // Cache
    this.cache = []
    this.cacheSize = 0

    // Queue
    this.queue = new FetchQueue()
    this.activeRequests = 0
    this.maxConcurrent = 2  // Two connections

    // Current read position (tracked for sequential prefetch)
    this.currentPos = 0
    this.prefetchAhead = CHUNK_SIZE * 2  // Prefetch 4MB ahead

    // Stats
    this.bytesDownloaded = 0
    this.cacheHits = 0
    this.cacheMisses = 0

    // State
    this.running = true
    this.initializing = true

    console.log('[Downloader] Created for', url.substring(0, 60), 'size:', Math.round(fileSize / 1024 / 1024) + 'MB')
  }

  /**
   * Start the downloader - prefetch start and end of file
   */
  async start() {
    // Prefetch start of file (format detection, headers)
    const startSize = Math.min(CUES_PREFETCH_SIZE, this.fileSize)
    this.queueFetch(0, startSize, PRIORITY_HIGH)

    // Prefetch end of file (MKV Cues/index)
    if (this.fileSize > CUES_PREFETCH_SIZE * 2) {
      const endOffset = this.fileSize - CUES_PREFETCH_SIZE
      this.queueFetch(endOffset, CUES_PREFETCH_SIZE, PRIORITY_HIGH)
    }

    // Start processing queue
    this.processQueue()

    // Listen for commands from main thread
    this.listenForCommands()
  }

  /**
   * Listen for commands (seek, read requests) from main thread
   */
  async listenForCommands() {
    while (this.running) {
      try {
        const cmd = await this.cmdPort.read()
        if (cmd === null) break

        this.handleCommand(cmd)
      } catch (err) {
        console.error('[Downloader] Command read error:', err.message)
        break
      }
    }
  }

  /**
   * Handle command from main thread
   */
  handleCommand(cmd) {
    switch (cmd.type) {
      case 'read':
        // Main thread wants data at offset
        this.handleReadRequest(cmd.offset, cmd.length)
        break

      case 'seek':
        // Main thread is seeking - prioritize this range
        this.handleSeek(cmd.offset)
        break

      case 'stop':
        this.running = false
        this.queue.clear()
        break

      default:
        console.warn('[Downloader] Unknown command:', cmd.type)
    }
  }

  /**
   * Handle read request - check cache or queue fetch
   */
  handleReadRequest(offset, length) {
    // Check cache first
    const cached = this.readFromCache(offset, length)
    if (cached) {
      this.cacheHits++
      this.sendData(offset, cached)
      return
    }

    this.cacheMisses++

    // Queue fetch with high priority (main is waiting)
    this.queueFetch(offset, Math.max(length, CHUNK_SIZE), PRIORITY_HIGH)

    // Also prefetch ahead
    const prefetchOffset = offset + CHUNK_SIZE
    if (prefetchOffset < this.fileSize) {
      this.queueFetch(prefetchOffset, CHUNK_SIZE, PRIORITY_NORMAL)
    }
  }

  /**
   * Handle seek - prioritize fetching this region
   */
  handleSeek(offset) {
    this.currentPos = offset

    // Cancel normal priority requests that are far from seek target
    this.queue.cancelOverlapping(0, offset - CHUNK_SIZE * 2)
    this.queue.cancelOverlapping(offset + CHUNK_SIZE * 4, this.fileSize)

    // Check if near end (likely Cues lookup)
    if (offset > this.fileSize - CUES_PREFETCH_SIZE) {
      const cuesStart = this.fileSize - CUES_PREFETCH_SIZE
      if (!this.hasInCache(cuesStart, CUES_PREFETCH_SIZE)) {
        this.queueFetch(cuesStart, CUES_PREFETCH_SIZE, PRIORITY_HIGH)
      }
    }

    // Queue the seek target region
    if (!this.hasInCache(offset, CHUNK_SIZE)) {
      this.queueFetch(offset, CHUNK_SIZE, PRIORITY_HIGH)
    }
  }

  /**
   * Queue a fetch request
   */
  queueFetch(offset, length, priority) {
    // Clamp to file bounds
    const actualLength = Math.min(length, this.fileSize - offset)
    if (actualLength <= 0) return

    // Skip if already cached
    if (this.hasInCache(offset, actualLength)) return

    this.queue.add({ offset, length: actualLength, priority })
    this.processQueue()
  }

  /**
   * Process the fetch queue
   */
  async processQueue() {
    while (!this.queue.isEmpty() && this.activeRequests < this.maxConcurrent && this.running) {
      const request = this.queue.next()
      if (!request) break

      // Skip if now cached (another request may have filled it)
      if (this.hasInCache(request.offset, request.length)) continue

      this.activeRequests++
      this.doFetch(request.offset, request.length)
        .then(data => {
          if (data && data.byteLength > 0) {
            this.addToCache(request.offset, data)
            this.sendData(request.offset, data)
          }
        })
        .catch(err => {
          console.error('[Downloader] Fetch error:', err.message)
          this.sendError(err.message)
        })
        .finally(() => {
          this.activeRequests--
          this.processQueue()  // Process next in queue
        })
    }
  }

  /**
   * Perform HTTP range fetch
   */
  doFetch(offset, length) {
    return new Promise((resolve, reject) => {
      const end = offset + length - 1

      const options = {
        method: 'GET',
        hostname: this.parsedUrl.hostname,
        port: this.parsedUrl.port || 80,
        path: this.parsedUrl.pathname + this.parsedUrl.search,
        headers: {
          'Range': `bytes=${offset}-${end}`
        }
      }

      const chunks = []
      let bytesReceived = 0

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        res.on('data', (chunk) => {
          chunks.push(chunk)
          bytesReceived += chunk.byteLength
        })

        res.on('end', () => {
          const data = Buffer.concat(chunks)
          this.bytesDownloaded += data.byteLength
          resolve(data)
        })

        res.on('error', reject)
      })

      req.on('error', reject)
      req.setTimeout(30000, () => {
        req.destroy()
        reject(new Error('HTTP timeout'))
      })

      req.end()
    })
  }

  /**
   * Check if range is in cache
   */
  hasInCache(offset, length) {
    for (const range of this.cache) {
      if (range.contains(offset, length)) return true
    }
    return false
  }

  /**
   * Read from cache
   */
  readFromCache(offset, length) {
    for (const range of this.cache) {
      const data = range.read(offset, length)
      if (data) return data
    }
    return null
  }

  /**
   * Add data to cache with LRU eviction
   */
  addToCache(offset, data) {
    const range = new CachedRange(offset, data)
    this.cache.push(range)
    this.cacheSize += data.byteLength

    // Evict old entries if over limit
    while (this.cacheSize > MAX_CACHE_SIZE && this.cache.length > 1) {
      let oldestIdx = 0
      let oldestTime = Infinity
      for (let i = 0; i < this.cache.length - 1; i++) {
        if (this.cache[i].lastAccess < oldestTime) {
          oldestTime = this.cache[i].lastAccess
          oldestIdx = i
        }
      }
      const evicted = this.cache.splice(oldestIdx, 1)[0]
      this.cacheSize -= evicted.data.byteLength
    }
  }

  /**
   * Send data to main thread via channel
   */
  sendData(offset, data) {
    try {
      this.dataPort.writeSync({
        type: 'data',
        offset,
        length: data.byteLength,
        buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      })
    } catch (err) {
      console.error('[Downloader] Failed to send data:', err.message)
    }
  }

  /**
   * Send error to main thread
   */
  sendError(message) {
    try {
      this.dataPort.writeSync({ type: 'error', message })
    } catch (err) {
      console.error('[Downloader] Failed to send error:', err.message)
    }
  }

  /**
   * Send EOF to main thread
   */
  sendEof() {
    try {
      this.dataPort.writeSync({ type: 'eof' })
    } catch (err) {
      console.error('[Downloader] Failed to send EOF:', err.message)
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      bytesDownloaded: this.bytesDownloaded,
      cacheSize: this.cacheSize,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses
    }
  }

  /**
   * Cleanup
   */
  destroy() {
    this.running = false
    this.queue.clear()
    this.cache = []
    this.cacheSize = 0
    console.log('[Downloader] Destroyed, stats:', this.getStats())
  }
}

// ============================================
// Worker Entry Point
// ============================================

let downloader = null

Worker.parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'init': {
      console.log('[DownloaderWorker] Init received')

      // Create channels from handles
      const dataChannel = Channel.from(msg.dataChannelHandle)
      const cmdChannel = Channel.from(msg.cmdChannelHandle)

      const dataPort = dataChannel.connect()
      const cmdPort = cmdChannel.connect()

      // Create downloader
      downloader = new Downloader(msg.url, msg.fileSize, dataPort, cmdPort)

      // Start downloading
      await downloader.start()

      // Signal ready
      Worker.parentPort.postMessage({ type: 'ready', fileSize: msg.fileSize })
      break
    }

    case 'stop': {
      if (downloader) {
        downloader.destroy()
        downloader = null
      }
      Worker.parentPort.postMessage({ type: 'stopped' })
      break
    }

    case 'stats': {
      const stats = downloader ? downloader.getStats() : {}
      Worker.parentPort.postMessage({ type: 'stats', stats })
      break
    }

    default:
      console.warn('[DownloaderWorker] Unknown message type:', msg.type)
  }
})

console.log('[DownloaderWorker] Started')
