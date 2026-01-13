/**
 * StreamingHttpReader
 *
 * Provides efficient HTTP range-request reading for bare-ffmpeg transcoding.
 * Handles MKV files with Cues at end via priority queue and two-connection approach.
 *
 * Key features:
 * - Priority queue for seek requests (Cues = HIGH, sequential = NORMAL)
 * - Sparse buffer map for caching downloaded byte ranges
 * - Pre-fetches last 10MB for MKV Cues on initialization
 * - Creates IOContext for bare-ffmpeg with sync read/seek callbacks
 */

import http from 'bare-http1'

// Priority levels for fetch queue
const PRIORITY_HIGH = 0   // MKK Cues, critical seeks
const PRIORITY_NORMAL = 1 // Sequential reads

// Default chunk size for HTTP range requests
const CHUNK_SIZE = 4 * 1024 * 1024 // 4MB chunks (larger for fewer requests)

// Cues prefetch size (last N bytes of file)
const CUES_PREFETCH_SIZE = 15 * 1024 * 1024 // 15MB (MKV Cues can be large)

// Start prefetch size - INCREASED to avoid sync read deadlock on BareKit
// The busy-wait sync read blocks the event loop, preventing HTTP callbacks
// So we must prefetch ALL data we'll need before starting the decode loop
const START_PREFETCH_SIZE = 100 * 1024 * 1024 // 100MB for headers + initial video data

// Max cached data size before eviction
const MAX_CACHE_SIZE = 150 * 1024 * 1024 // 150MB (increased to hold prefetch)

// Max concurrent HTTP connections
const MAX_CONCURRENT_FETCHES = 3

// Prefetch ahead distance for sequential reads
const PREFETCH_AHEAD = 8 * 1024 * 1024 // 8MB ahead

/**
 * Represents a cached byte range
 */
class CachedRange {
  constructor(start, data) {
    this.start = start
    this.end = start + data.length
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
    return this.data.subarray(localOffset, localOffset + length)
  }
}

/**
 * Priority queue for fetch requests
 */
class FetchQueue {
  constructor() {
    this.queue = []
    this.processing = false
  }

  add(request) {
    // Insert by priority (lower number = higher priority)
    let inserted = false
    for (let i = 0; i < this.queue.length; i++) {
      if (request.priority < this.queue[i].priority) {
        this.queue.splice(i, 0, request)
        inserted = true
        break
      }
    }
    if (!inserted) {
      this.queue.push(request)
    }
  }

  next() {
    return this.queue.shift()
  }

  isEmpty() {
    return this.queue.length === 0
  }

  hasPending(offset, length) {
    return this.queue.some(req =>
      req.offset <= offset && (req.offset + req.length) >= (offset + length)
    )
  }
}

/**
 * StreamingHttpReader - reads from HTTP with priority queue and caching
 */
export class StreamingHttpReader {
  constructor(url, fileSize) {
    this.url = url
    this.fileSize = fileSize
    this.parsedUrl = new URL(url)

    // Sparse buffer map - array of CachedRange
    this.cache = []
    this.cacheSize = 0

    // Priority queue for fetch requests
    this.fetchQueue = new FetchQueue()

    // Pending fetch promises keyed by "offset:length"
    this.pendingFetches = new Map()

    // Active fetch count for concurrency control
    this.activeFetches = 0

    // Current read position (for IOContext)
    this.currentPos = 0

    // Track last read position for sequential detection
    this.lastReadPos = 0
    this.sequentialReads = 0

    // Stats
    this.bytesDownloaded = 0
    this.cacheHits = 0
    this.cacheMisses = 0

    // Init prefetch state
    this.initPrefetched = false
    this.initPrefetchPromise = null

    // Background prefetch tracking
    this.backgroundPrefetches = new Set()

    console.log('[StreamingHttpReader] Created for', url.substring(0, 60), 'size:', Math.round(fileSize / 1024 / 1024) + 'MB')
  }

  /**
   * Pre-fetch both start and end of file for FFmpeg initialization
   * - Start: Format detection, headers, first keyframe
   * - End: MKV Cues/index for seeking
   * Call this before creating IOContext
   */
  async prefetchForInit() {
    if (this.initPrefetched) return
    if (this.initPrefetchPromise) return this.initPrefetchPromise

    // Prefetch sizes
    const startSize = Math.min(START_PREFETCH_SIZE, this.fileSize)
    const endOffset = Math.max(0, this.fileSize - CUES_PREFETCH_SIZE)
    const endSize = this.fileSize - endOffset

    // Also prefetch a middle chunk for files that have index in middle
    const midOffset = Math.floor(this.fileSize / 2)
    const midSize = Math.min(CHUNK_SIZE, this.fileSize - midOffset)

    console.log('[StreamingHttpReader] Pre-fetching start (0-' + Math.round(startSize / 1024 / 1024) + 'MB), mid (' + Math.round(midOffset / 1024 / 1024) + 'MB), and end (' + Math.round(endOffset / 1024 / 1024) + 'MB-' + Math.round(this.fileSize / 1024 / 1024) + 'MB)...')

    // Start all prefetches in parallel (up to MAX_CONCURRENT_FETCHES)
    const fetches = [
      // Fetch start of file (for format detection, headers) - HIGH priority
      this.fetchRange(0, startSize, PRIORITY_HIGH),
      // Fetch end of file (for MKV Cues/index) - HIGH priority
      endOffset > startSize ? this.fetchRange(endOffset, endSize, PRIORITY_HIGH) : Promise.resolve(null)
    ]

    // Add middle prefetch if file is large enough and doesn't overlap
    if (this.fileSize > START_PREFETCH_SIZE + CUES_PREFETCH_SIZE + CHUNK_SIZE * 2) {
      fetches.push(this.fetchRange(midOffset, midSize, PRIORITY_NORMAL))
    }

    this.initPrefetchPromise = Promise.all(fetches)
      .then((results) => {
        this.initPrefetched = true
        const totalPrefetched = results.reduce((sum, d) => sum + (d?.length || 0), 0)
        console.log('[StreamingHttpReader] Init pre-fetch complete -', Math.round(totalPrefetched / 1024 / 1024) + 'MB cached')
      })
      .catch(err => {
        console.error('[StreamingHttpReader] Init pre-fetch failed:', err.message)
        throw err
      })

    return this.initPrefetchPromise
  }

  /**
   * Legacy alias for prefetchCues
   */
  async prefetchCues() {
    return this.prefetchForInit()
  }

  /**
   * Fetch a byte range from HTTP
   * Returns cached data if available, otherwise queues fetch
   */
  async fetchRange(offset, length, priority = PRIORITY_NORMAL) {
    // Clamp to file size
    const actualLength = Math.min(length, this.fileSize - offset)
    if (actualLength <= 0) return Buffer.alloc(0)

    // Check cache first
    const cached = this.readFromCache(offset, actualLength)
    if (cached) {
      this.cacheHits++
      return cached
    }

    this.cacheMisses++

    // Check if already fetching this range
    const key = `${offset}:${actualLength}`
    if (this.pendingFetches.has(key)) {
      return this.pendingFetches.get(key)
    }

    // Create fetch promise
    const fetchPromise = this._doFetch(offset, actualLength, priority)
    this.pendingFetches.set(key, fetchPromise)

    try {
      const data = await fetchPromise
      return data
    } finally {
      this.pendingFetches.delete(key)
    }
  }

  /**
   * Internal: perform HTTP range fetch with concurrency control
   */
  async _doFetch(offset, length, priority) {
    // Wait for a slot if at max concurrent
    while (this.activeFetches >= MAX_CONCURRENT_FETCHES) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    this.activeFetches++

    try {
      return await this._doFetchInternal(offset, length, priority)
    } finally {
      this.activeFetches--
    }
  }

  /**
   * Internal: actual HTTP range fetch
   */
  _doFetchInternal(offset, length, priority) {
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
          bytesReceived += chunk.length
        })

        res.on('end', () => {
          const data = Buffer.concat(chunks)
          this.bytesDownloaded += data.length

          // Add to cache
          this.addToCache(offset, data)

          resolve(data)
        })

        res.on('error', reject)
      })

      req.on('error', reject)
      req.setTimeout(30000, () => {
        req.destroy()
        reject(new Error('HTTP request timeout'))
      })

      req.end()
    })
  }

  /**
   * Read from cache if available
   */
  readFromCache(offset, length) {
    for (const range of this.cache) {
      if (range.contains(offset, length)) {
        return range.read(offset, length)
      }
    }
    return null
  }

  /**
   * Add data to cache, evicting old entries if needed
   */
  addToCache(offset, data) {
    // Check if this range overlaps/extends existing ranges
    // For simplicity, just add as new range (could optimize with merge)
    const newRange = new CachedRange(offset, data)
    this.cache.push(newRange)
    this.cacheSize += data.length

    // Evict old entries if over limit
    while (this.cacheSize > MAX_CACHE_SIZE && this.cache.length > 1) {
      // Find oldest accessed range (excluding most recent)
      let oldestIdx = 0
      let oldestTime = Infinity
      for (let i = 0; i < this.cache.length - 1; i++) {
        if (this.cache[i].lastAccess < oldestTime) {
          oldestTime = this.cache[i].lastAccess
          oldestIdx = i
        }
      }
      const evicted = this.cache.splice(oldestIdx, 1)[0]
      this.cacheSize -= evicted.data.length
    }
  }

  /**
   * Start background prefetch for position (fire and forget)
   */
  _backgroundPrefetch(offset, length) {
    const key = `${offset}:${length}`
    if (this.backgroundPrefetches.has(key)) return
    if (this.hasInCache(offset, length)) return

    this.backgroundPrefetches.add(key)
    this.fetchRange(offset, length, PRIORITY_NORMAL)
      .catch(() => {}) // Ignore errors for background prefetch
      .finally(() => this.backgroundPrefetches.delete(key))
  }

  /**
   * Check if range is fully in cache
   */
  hasInCache(offset, length) {
    for (const range of this.cache) {
      if (range.contains(offset, length)) return true
    }
    return false
  }

  /**
   * Synchronous read for IOContext - blocks until data available
   * This is called from FFmpeg's synchronous read callback
   */
  syncRead(buffer) {
    if (this.currentPos >= this.fileSize) {
      return 0 // EOF
    }

    const toRead = Math.min(buffer.length, this.fileSize - this.currentPos)

    // Detect sequential reads and trigger prefetch ahead
    const isSequential = (this.currentPos === this.lastReadPos + buffer.length) ||
                         (Math.abs(this.currentPos - this.lastReadPos) < CHUNK_SIZE)
    if (isSequential) {
      this.sequentialReads++
      // Prefetch ahead for sequential access
      if (this.sequentialReads > 2) {
        const prefetchOffset = this.currentPos + CHUNK_SIZE
        if (prefetchOffset < this.fileSize) {
          this._backgroundPrefetch(prefetchOffset, Math.min(PREFETCH_AHEAD, this.fileSize - prefetchOffset))
        }
      }
    } else {
      this.sequentialReads = 0
    }
    this.lastReadPos = this.currentPos

    // Try cache first
    const cached = this.readFromCache(this.currentPos, toRead)
    if (cached) {
      cached.copy(buffer, 0, 0, cached.length)
      this.currentPos += cached.length
      return cached.length
    }

    // Cache miss - need to fetch synchronously
    // WARNING: This busy-wait can deadlock on BareKit because it blocks the event loop
    console.warn('[StreamingHttpReader] CACHE MISS at', Math.round(this.currentPos / 1024 / 1024) + 'MB - this may cause deadlock on mobile')
    // This is tricky because FFmpeg needs sync reads but HTTP is async
    // We use a busy-wait approach (not ideal but necessary)

    // Queue the fetch with larger chunk size
    const fetchSize = Math.max(toRead, CHUNK_SIZE)
    const fetchPromise = this.fetchRange(this.currentPos, fetchSize, PRIORITY_HIGH)

    // Busy-wait for fetch to complete
    let data = null
    let error = null
    let done = false

    fetchPromise
      .then(d => { data = d; done = true })
      .catch(e => { error = e; done = true })

    // Spin wait with longer intervals to reduce CPU burn
    // Note: This is still problematic on mobile (BareKit) because
    // the spin blocks the JS event loop preventing HTTP callbacks
    const startTime = Date.now()
    const timeout = 60000 // 60 second timeout (longer for slow connections)
    let spinCount = 0

    while (!done) {
      // Check timeout
      if (Date.now() - startTime > timeout) {
        console.error('[StreamingHttpReader] Sync read timeout at', Math.round(this.currentPos / 1024 / 1024) + 'MB after', Math.round((Date.now() - startTime) / 1000) + 's')
        return -1 // Error
      }

      // Yield to allow async callbacks to run
      // Longer interval = less CPU burn but slower response
      const spinStart = Date.now()
      while (Date.now() - spinStart < 5) {
        // Spin for 5ms (increased from 1ms)
      }

      spinCount++
      // Log progress every ~1 second
      if (spinCount % 200 === 0 && !done) {
        console.log('[StreamingHttpReader] Waiting for data at', Math.round(this.currentPos / 1024 / 1024) + 'MB...', Math.round((Date.now() - startTime) / 1000) + 's')
      }
    }

    if (error) {
      console.error('[StreamingHttpReader] Sync read error:', error.message)
      return -1
    }

    // Read from newly cached data
    const actualRead = Math.min(data.length, toRead)
    data.copy(buffer, 0, 0, actualRead)
    this.currentPos += actualRead
    return actualRead
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

    // Log seeks and trigger prefetch for large jumps
    const seekDistance = Math.abs(newPos - this.currentPos)
    if (seekDistance > 1024 * 1024) {
      console.log('[StreamingHttpReader] Seek:', Math.round(this.currentPos / 1024 / 1024) + 'MB →', Math.round(newPos / 1024 / 1024) + 'MB')

      // Reset sequential read counter on large seek
      this.sequentialReads = 0

      // Trigger prefetch for the seek target (if not already cached)
      if (!this.hasInCache(newPos, CHUNK_SIZE)) {
        this._backgroundPrefetch(newPos, Math.min(CHUNK_SIZE * 2, this.fileSize - newPos))
      }

      // If seeking to end of file, also prefetch MKV Cues region
      if (newPos > this.fileSize - CUES_PREFETCH_SIZE) {
        const cuesStart = Math.max(0, this.fileSize - CUES_PREFETCH_SIZE)
        if (!this.hasInCache(cuesStart, CUES_PREFETCH_SIZE)) {
          this._backgroundPrefetch(cuesStart, CUES_PREFETCH_SIZE)
        }
      }
    }

    this.currentPos = newPos
    return this.currentPos
  }

  /**
   * Create IOContext for bare-ffmpeg
   * Must call prefetchCues() first for MKV files
   */
  createIOContext(ffmpeg) {
    const self = this

    // Use larger buffer for IOContext (128KB instead of 64KB)
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
      // Stats logging on cleanup
      const hitRate = self.cacheHits + self.cacheMisses > 0
        ? Math.round((self.cacheHits / (self.cacheHits + self.cacheMisses)) * 100)
        : 0
      console.log('[StreamingHttpReader] Stats - downloaded:', Math.round(self.bytesDownloaded / 1024 / 1024) + 'MB, cache hits:', self.cacheHits, 'misses:', self.cacheMisses, '(' + hitRate + '% hit rate)')
    }

    return ioContext
  }

  /**
   * Get current stats
   */
  getStats() {
    const hitRate = this.cacheHits + this.cacheMisses > 0
      ? Math.round((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100)
      : 0
    return {
      bytesDownloaded: this.bytesDownloaded,
      cacheSize: this.cacheSize,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate,
      activeFetches: this.activeFetches,
      pendingFetches: this.pendingFetches.size,
      backgroundPrefetches: this.backgroundPrefetches.size
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    const stats = this.getStats()
    console.log('[StreamingHttpReader] Destroying - downloaded:', Math.round(stats.bytesDownloaded / 1024 / 1024) + 'MB, hit rate:', stats.hitRate + '%')
    this.cache = []
    this.cacheSize = 0
    this.pendingFetches.clear()
    this.backgroundPrefetches.clear()
  }
}

export default StreamingHttpReader
