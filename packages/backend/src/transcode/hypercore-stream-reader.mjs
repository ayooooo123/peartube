/**
 * HypercoreStreamReader - Read video data directly from Hypercore with accurate byte-to-block mapping
 *
 * Uses Hypercore's native seek() method (Merkle tree based) to accurately map byte positions
 * to block indices. This avoids the estimation errors that caused crashes with random seeks.
 *
 * DESIGN:
 * 1. During initialize(), build a block boundary index using core.seek()
 * 2. Prefetch initial + tail blocks for header and MKV cues
 * 3. After initialize(), all reads are synchronous using the precomputed index
 */

console.log('[HypercoreStreamReader] === MODULE LOADED ===')

// SEEK constants matching FFmpeg's whence values
const SEEK_SET = 0
const SEEK_CUR = 1
const SEEK_END = 2
const AVSEEK_SIZE = 0x10000 // FFmpeg's size query

// Cache configuration
const BLOCK_SIZE = 65536 // Hyperblobs default block size
// NOTE: CACHE_MAX_BLOCKS is only used for streaming (non-local) videos
// For fully-local videos, we load ALL blocks with no eviction limit
const CACHE_MAX_BLOCKS = 2048 // ~128MB cache for streaming mode
const INITIAL_PREFETCH_BLOCKS = 512 // Prefetch 32MB initially
const TAIL_PREFETCH_BLOCKS = 64 // Prefetch 4MB from tail (for MKV cues)
const INDEX_SAMPLE_INTERVAL = 1024 * 1024 // Sample every 1MB for block boundary index
const LOOKAHEAD_BLOCKS = 512 // Prefetch 32MB ahead of read position
const PREFETCH_BATCH_SIZE = 64 // How many blocks to request at once

export class HypercoreStreamReader {
  /**
   * @param {Hypercore} blobsCore - The Hypercore containing blob data
   * @param {Object} blobInfo - Blob location info
   * @param {number} blobInfo.blockOffset - Starting block index
   * @param {number} blobInfo.blockLength - Number of blocks
   * @param {number} blobInfo.byteOffset - Absolute byte offset in hypercore
   * @param {number} blobInfo.byteLength - Total byte length of blob
   */
  constructor(blobsCore, blobInfo) {
    console.log('[HypercoreStreamReader] Constructor called with blobInfo:', JSON.stringify(blobInfo))
    this.core = blobsCore
    this.startBlock = blobInfo.blockOffset
    this.blockCount = blobInfo.blockLength
    this.endBlock = this.startBlock + this.blockCount
    this.totalSize = blobInfo.byteLength

    // The absolute byte offset where this blob starts in the hypercore
    // Used for core.seek() which needs absolute positions
    this.blobByteOffset = blobInfo.byteOffset

    // Block cache - simple Map
    this.cache = new Map() // blockIndex -> { data: Buffer, size: number }
    this.cacheOrder = [] // Track insertion order for eviction

    // Current read position (byte offset from start of blob)
    this.position = 0

    // Block boundary index - maps byte positions to [blockIndex, offsetInBlock]
    // Built during initialize() using core.seek()
    this.blockIndex = new Map() // bytePosition -> { block: number, offset: number }
    this.blockBoundaries = [] // Sorted array of { bytePos, block, offset } for binary search

    // Block size tracking (actual sizes from loaded blocks)
    this.blockSizes = new Map() // blockIndex -> actual byte size

    // Stats
    this.readCount = 0
    this.seekCount = 0
    this.cacheHits = 0
    this.cacheMisses = 0

    // State flags
    this.initialized = false
    this._destroyed = false
    this._fullyLocalMode = false // When true, no eviction - all blocks stay in cache

    // Look-ahead prefetch state using Hypercore's download() API
    this._downloadRange = null
    this._lastPrefetchStart = -1
    this._prefetchPromise = null
  }

  /**
   * Initialize reader by:
   * 1. Check if video is fully synced locally
   * 2. Building block boundary index using core.seek()
   * 3. Prefetching blocks - ALL if local, or initial+tail if remote
   */
  async initialize() {
    console.log('[HypercoreStreamReader] Initializing...')
    console.log('[HypercoreStreamReader] Total blocks:', this.blockCount, 'Total size:', Math.round(this.totalSize / 1024 / 1024) + 'MB')
    const startTime = Date.now()

    // Check if all blocks are available locally using core.has()
    const isFullyLocal = await this.core.has(this.startBlock, this.endBlock)
    console.log('[HypercoreStreamReader] Fully local:', isFullyLocal)

    // Step 1: Build block boundary index using Hypercore's native seek
    console.log('[HypercoreStreamReader] Building block boundary index...')
    await this._buildBlockIndex()

    if (isFullyLocal) {
      // ALL blocks are local - load them all into cache
      // This is CRITICAL: FFmpeg does NOT handle EAGAIN/retry properly
      // We MUST have all blocks cached before FFmpeg starts reading
      console.log('[HypercoreStreamReader] Loading ALL', this.blockCount, 'blocks (fully local)...')
      
      // Enable fully-local mode - disables cache eviction
      this._fullyLocalMode = true
      const estimatedMemMB = Math.round((this.blockCount * BLOCK_SIZE) / 1024 / 1024)
      console.log('[HypercoreStreamReader] Estimated memory usage:', estimatedMemMB, 'MB')
      
      const BATCH_SIZE = 100
      let failedBlocks = []
      
      for (let i = 0; i < this.blockCount; i += BATCH_SIZE) {
        if (this._destroyed) break
        
        const batchEnd = Math.min(i + BATCH_SIZE, this.blockCount)
        const promises = []
        
        for (let j = i; j < batchEnd; j++) {
          const blockIndex = this.startBlock + j
          if (!this.cache.has(blockIndex)) {
            promises.push(
              this._loadBlock(blockIndex).then(success => {
                if (!success) failedBlocks.push(blockIndex)
                return success
              })
            )
          }
        }
        
        await Promise.all(promises)
        
        if (i % 500 === 0 && i > 0) {
          const pct = Math.round((this.cache.size / this.blockCount) * 100)
          console.log('[HypercoreStreamReader] Loaded', this.cache.size, '/', this.blockCount, 'blocks (' + pct + '%)...')
        }
      }
      
      // Verify ALL blocks were loaded
      if (failedBlocks.length > 0) {
        console.error('[HypercoreStreamReader] FAILED to load', failedBlocks.length, 'blocks:', 
          failedBlocks.slice(0, 10).join(', '), failedBlocks.length > 10 ? '...' : '')
        
        // Retry failed blocks one more time with wait: true
        console.log('[HypercoreStreamReader] Retrying', failedBlocks.length, 'failed blocks with wait: true...')
        for (const blockIndex of failedBlocks) {
          if (this._destroyed) break
          try {
            const data = await this.core.get(blockIndex, { wait: true, timeout: 5000 })
            if (data) {
              const copy = Buffer.allocUnsafe(data.length)
              data.copy(copy)
              this.cache.set(blockIndex, { data: copy, size: copy.length })
              this.cacheOrder.push(blockIndex)
              this.blockSizes.set(blockIndex, copy.length)
            }
          } catch (err) {
            console.error('[HypercoreStreamReader] Retry failed for block', blockIndex, ':', err?.message)
          }
        }
      }
      
      // Final verification
      const missingBlocks = []
      for (let i = 0; i < this.blockCount; i++) {
        const blockIndex = this.startBlock + i
        if (!this.cache.has(blockIndex)) {
          missingBlocks.push(blockIndex)
        }
      }
      
      if (missingBlocks.length > 0) {
        console.error('[HypercoreStreamReader] CRITICAL: Still missing', missingBlocks.length, 'blocks after retry')
        console.error('[HypercoreStreamReader] Missing blocks:', missingBlocks.slice(0, 20).join(', '))
        // Don't throw - let it try anyway, but log the warning
      } else {
        console.log('[HypercoreStreamReader] SUCCESS: All', this.blockCount, 'blocks loaded into cache')
      }
    } else {
      // Not fully local - use initial + tail prefetch strategy
      const initialBlocks = Math.min(INITIAL_PREFETCH_BLOCKS, this.blockCount)
      console.log('[HypercoreStreamReader] Prefetching first', initialBlocks, 'blocks...')

      for (let i = 0; i < initialBlocks; i++) {
        if (this._destroyed) break
        const blockIndex = this.startBlock + i
        await this._loadBlock(blockIndex)
      }

      const tailBlocks = Math.min(TAIL_PREFETCH_BLOCKS, this.blockCount)
      console.log('[HypercoreStreamReader] Prefetching last', tailBlocks, 'blocks...')

      for (let i = 0; i < tailBlocks; i++) {
        if (this._destroyed) break
        const blockIndex = this.endBlock - 1 - i
        if (!this.cache.has(blockIndex)) {
          await this._loadBlock(blockIndex)
        }
      }
    }

    const elapsed = Date.now() - startTime
    console.log('[HypercoreStreamReader] Initialized with', this.cache.size, 'blocks,',
      this.blockBoundaries.length, 'index samples in', elapsed + 'ms')
    console.log('[HypercoreStreamReader] Cache coverage:', Math.round((this.cache.size / this.blockCount) * 100) + '%')

    if (this.cache.size === 0) {
      console.error('[HypercoreStreamReader] Failed to load any blocks - cannot initialize')
      throw new Error('HypercoreStreamReader: No blocks available locally')
    }

    this.initialized = true
    return this
  }

  /**
   * Build block boundary index using Hypercore's native seek()
   * Sample every INDEX_SAMPLE_INTERVAL bytes to create anchor points
   */
  async _buildBlockIndex() {
    const samples = Math.ceil(this.totalSize / INDEX_SAMPLE_INTERVAL) + 1
    console.log('[HypercoreStreamReader] Sampling', samples, 'positions for block index...')

    // Always include position 0
    this.blockBoundaries.push({ bytePos: 0, block: this.startBlock, offset: 0 })

    for (let i = 1; i < samples; i++) {
      if (this._destroyed) break

      const bytePos = Math.min(i * INDEX_SAMPLE_INTERVAL, this.totalSize - 1)

      try {
        // core.seek() takes absolute byte position, returns [blockIndex, offsetInBlock]
        const absoluteBytePos = this.blobByteOffset + bytePos
        const result = await this.core.seek(absoluteBytePos, {
          start: this.startBlock,
          end: this.endBlock
        })

        if (result) {
          const [blockIndex, offsetInBlock] = result
          this.blockBoundaries.push({
            bytePos,
            block: blockIndex,
            offset: offsetInBlock
          })
        }
      } catch (err) {
        // Skip this sample if seek fails
        if (!this._destroyed) {
          console.warn('[HypercoreStreamReader] seek failed at', bytePos, ':', err?.message)
        }
      }
    }

    // Always include end position
    if (this.totalSize > 0) {
      try {
        const absoluteBytePos = this.blobByteOffset + this.totalSize - 1
        const result = await this.core.seek(absoluteBytePos, {
          start: this.startBlock,
          end: this.endBlock
        })
        if (result) {
          const [blockIndex, offsetInBlock] = result
          this.blockBoundaries.push({
            bytePos: this.totalSize - 1,
            block: blockIndex,
            offset: offsetInBlock
          })
        }
      } catch (err) {
        // Ignore
      }
    }

    // Sort by byte position for binary search
    this.blockBoundaries.sort((a, b) => a.bytePos - b.bytePos)

    // Remove duplicates
    this.blockBoundaries = this.blockBoundaries.filter((item, index, arr) => {
      return index === 0 || item.bytePos !== arr[index - 1].bytePos
    })

    console.log('[HypercoreStreamReader] Block index built with', this.blockBoundaries.length, 'samples')
  }

  /**
   * Load a single block into cache (async, only called during initialize)
   */
  async _loadBlock(blockIndex) {
    if (this._destroyed || !this.core) return false
    if (this.cache.has(blockIndex)) return true
    if (blockIndex < this.startBlock || blockIndex >= this.endBlock) return false

    try {
      const data = await this.core.get(blockIndex, { wait: false })

      if (this._destroyed) return false

      if (data) {
        const copy = Buffer.allocUnsafe(data.length)
        data.copy(copy)

        // Only evict old blocks if NOT in fully-local mode
        // In fully-local mode, we need ALL blocks in cache for FFmpeg
        if (!this._fullyLocalMode) {
          while (this.cache.size >= CACHE_MAX_BLOCKS && this.cacheOrder.length > 0) {
            const oldestBlock = this.cacheOrder.shift()
            this.cache.delete(oldestBlock)
            this.blockSizes.delete(oldestBlock)
          }
        }

        this.cache.set(blockIndex, { data: copy, size: copy.length })
        this.cacheOrder.push(blockIndex)
        this.blockSizes.set(blockIndex, copy.length)

        return true
      }
    } catch (err) {
      if (!this._destroyed) {
        console.warn('[HypercoreStreamReader] Failed to load block', blockIndex, ':', err?.message)
      }
    }

    return false
  }

  /**
   * Trigger look-ahead prefetch from a given block using Hypercore's native download API
   * This uses the same mechanism as hyperblobs Prefetcher
   */
  _triggerLookahead(fromBlock) {
    if (this._destroyed) return
    
    // Only update if we've moved significantly (avoid constant range updates)
    if (fromBlock <= this._lastPrefetchStart + PREFETCH_BATCH_SIZE) return
    
    this._lastPrefetchStart = fromBlock
    
    // Cancel previous download range
    if (this._downloadRange) {
      try { this._downloadRange.destroy() } catch {}
      this._downloadRange = null
    }
    
    const endBlock = Math.min(fromBlock + LOOKAHEAD_BLOCKS, this.endBlock)
    
    // Use Hypercore's download() to prefetch the range
    // This is the same approach used by hyperblobs Prefetcher
    try {
      this._downloadRange = this.core.download({
        start: fromBlock,
        end: endBlock,
        linear: true // Download sequentially for video playback
      })
      
      // Also load blocks into our cache as they become available
      this._prefetchPromise = this._loadRangeIntoCache(fromBlock, endBlock)
    } catch (err) {
      console.warn('[HypercoreStreamReader] Failed to start download range:', err?.message)
    }
  }
  
  /**
   * Load a range of blocks into our cache (background)
   */
  async _loadRangeIntoCache(startBlock, endBlock) {
    let loaded = 0
    for (let i = startBlock; i < endBlock && !this._destroyed; i++) {
      if (!this.cache.has(i)) {
        const success = await this._loadBlock(i)
        if (success) loaded++
      }
    }
    if (loaded > 0 && (this.readCount <= 10 || this.readCount % 1000 === 0)) {
      console.log('[HypercoreStreamReader] Prefetched', loaded, 'blocks from', startBlock, 'to', endBlock, 'cache:', this.cache.size)
    }
  }

  /**
   * Convert byte position to block index using precomputed index
   * Uses binary search on blockBoundaries for O(log n) lookup
   */
  _positionToBlock(pos) {
    if (this.blockBoundaries.length === 0) {
      // Fallback to estimation if index not built
      return this.startBlock + Math.floor(pos / BLOCK_SIZE)
    }

    // Binary search for the largest boundary <= pos
    let left = 0
    let right = this.blockBoundaries.length - 1
    let best = this.blockBoundaries[0]

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const entry = this.blockBoundaries[mid]

      if (entry.bytePos <= pos) {
        best = entry
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    // best.block is the block containing best.bytePos
    // If pos > best.bytePos, we need to account for the offset
    if (pos === best.bytePos) {
      return best.block
    }

    // pos is between best and the next sample
    // Use known block sizes to refine, or estimate
    const bytesFromBest = pos - best.bytePos
    let currentBlock = best.block
    let bytesAccum = best.offset // Start from the offset within the block

    // Walk forward using known block sizes
    while (bytesAccum < bytesFromBest + best.offset && currentBlock < this.endBlock) {
      const blockSize = this.blockSizes.get(currentBlock) || BLOCK_SIZE
      const remainingInBlock = blockSize - (currentBlock === best.block ? best.offset : 0)

      if (bytesAccum + remainingInBlock > bytesFromBest + best.offset) {
        // Found the block
        return currentBlock
      }

      bytesAccum += remainingInBlock
      currentBlock++
    }

    return Math.min(currentBlock, this.endBlock - 1)
  }

  /**
   * Get byte offset within a block for a given position
   */
  _getOffsetInBlock(pos, blockIndex) {
    // Find the boundary entry for this block or before it
    let blockStartPos = 0

    for (const entry of this.blockBoundaries) {
      if (entry.block === blockIndex) {
        // This entry tells us the byte position at offset entry.offset in this block
        blockStartPos = entry.bytePos - entry.offset
        break
      }
      if (entry.block > blockIndex) {
        break
      }
      // Accumulate position from previous blocks
      blockStartPos = entry.bytePos
    }

    // Calculate offset within the block
    const offset = pos - blockStartPos

    // Sanity check
    const blockSize = this.blockSizes.get(blockIndex) || BLOCK_SIZE
    if (offset < 0 || offset >= blockSize) {
      // Fallback: estimate based on position within overall file
      const estimatedBlockStart = (blockIndex - this.startBlock) * BLOCK_SIZE
      return pos - estimatedBlockStart
    }

    return offset
  }

  /**
   * Synchronous read for IOContext
   */
  syncRead(buffer) {
    if (this._destroyed || !this.initialized) {
      return -1
    }

    this.readCount++

    if (this.position >= this.totalSize) {
      return 0 // EOF
    }

    const requestedBytes = buffer.length
    let bytesWritten = 0
    let currentPos = this.position

    // Trigger look-ahead prefetch based on current position
    const currentBlock = this._positionToBlock(currentPos)
    this._triggerLookahead(currentBlock)

    while (bytesWritten < requestedBytes && currentPos < this.totalSize) {
      const blockIndex = this._positionToBlock(currentPos)
      let cached = this.cache.get(blockIndex)

      if (!cached) {
        this.cacheMisses++
        
        // CRITICAL: FFmpeg does NOT retry on EAGAIN for input streams.
        // Once it gets EAGAIN or 0, subsequent reads fail with EOF.
        // The ONLY solution is to ensure ALL blocks are loaded during initialize().
        // If we hit this code path, something went wrong during initialization.
        
        console.error('[HypercoreStreamReader] FATAL: Cache miss at block', blockIndex,
          'pos:', Math.round(currentPos / 1024 / 1024) + 'MB',
          'cache:', this.cache.size, 'total:', this.blockCount,
          'misses:', this.cacheMisses)
        console.error('[HypercoreStreamReader] This should NOT happen if video is fully local.')
        console.error('[HypercoreStreamReader] Cache contains blocks:', 
          Array.from(this.cache.keys()).slice(0, 10).join(', '), '...')
        console.error('[HypercoreStreamReader] Looking for block:', blockIndex, 
          'range:', this.startBlock, '-', this.endBlock)
        
        // Trigger lookahead anyway in case we can recover
        this._triggerLookahead(blockIndex)
        
        // Return what we have so far
        // If bytesWritten > 0, return partial read (FFmpeg will call again)
        // If bytesWritten == 0, this is fatal - FFmpeg will see EOF
        if (bytesWritten === 0) {
          console.error('[HypercoreStreamReader] FATAL: No data available, FFmpeg will see EOF')
          // Return 0 which becomes AVERROR_EOF - at least FFmpeg handles it gracefully
          return 0
        }
        break
      }

      this.cacheHits++

      const offsetInBlock = this._getOffsetInBlock(currentPos, blockIndex)

      if (offsetInBlock < 0 || offsetInBlock >= cached.size) {
        console.error('[HypercoreStreamReader] Invalid offset', offsetInBlock,
          'in block', blockIndex, 'size', cached.size, 'pos:', currentPos)
        break
      }

      const availableInBlock = cached.size - offsetInBlock
      const remainingToRead = requestedBytes - bytesWritten
      const remainingInFile = this.totalSize - currentPos
      const toRead = Math.min(availableInBlock, remainingToRead, remainingInFile)

      if (toRead <= 0) break

      cached.data.copy(buffer, bytesWritten, offsetInBlock, offsetInBlock + toRead)

      bytesWritten += toRead
      currentPos += toRead
    }

    this.position = currentPos

    if (this.readCount === 1 || this.readCount % 2000 === 0) {
      const pct = Math.round((this.position / this.totalSize) * 100)
      console.log('[HypercoreStreamReader] Read #' + this.readCount + ':', bytesWritten + 'B',
        'pos:', Math.round(this.position / 1024 / 1024) + 'MB',
        '(' + pct + '%)',
        'cache:', this.cache.size,
        'hits:', this.cacheHits, 'misses:', this.cacheMisses)
    }

    return bytesWritten
  }

  /**
   * Seek for IOContext
   */
  seek(offset, whence) {
    if (this._destroyed) {
      return -1
    }

    this.seekCount++

    if (whence === AVSEEK_SIZE) {
      return this.totalSize
    }

    let newPos
    switch (whence) {
      case SEEK_SET:
        newPos = offset
        break
      case SEEK_CUR:
        newPos = this.position + offset
        break
      case SEEK_END:
        newPos = this.totalSize + offset
        break
      default:
        return -1
    }

    newPos = Math.max(0, Math.min(newPos, this.totalSize))

    if (this.seekCount <= 5 || this.seekCount % 100 === 0) {
      console.log('[HypercoreStreamReader] Seek #' + this.seekCount + ':',
        Math.round(this.position / 1024 / 1024) + 'MB ->',
        Math.round(newPos / 1024 / 1024) + 'MB')
    }

    this.position = newPos
    return newPos
  }

  /**
   * Create IOContext for bare-ffmpeg
   */
  createIOContext(ffmpeg) {
    if (!this.initialized) {
      throw new Error('Must call initialize() before createIOContext()')
    }

    const self = this

    const ioContext = new ffmpeg.IOContext(128 * 1024, {
      onread: (buffer) => {
        try {
          return self.syncRead(buffer)
        } catch (err) {
          console.error('[HypercoreStreamReader] FATAL onread error:', err?.message || err)
          return -1
        }
      },
      onseek: (offset, whence) => {
        try {
          return self.seek(offset, whence)
        } catch (err) {
          console.error('[HypercoreStreamReader] FATAL onseek error:', err?.message || err)
          return -1
        }
      }
    })

    console.log('[HypercoreStreamReader] IOContext created, totalSize:', this.totalSize,
      'blocks:', this.blockCount, 'cached:', this.cache.size,
      'indexSamples:', this.blockBoundaries.length)

    return ioContext
  }

  getStats() {
    return {
      totalSize: this.totalSize,
      position: this.position,
      cacheSize: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      readCount: this.readCount,
      seekCount: this.seekCount,
      indexSamples: this.blockBoundaries.length,
      progress: Math.round((this.position / this.totalSize) * 100)
    }
  }

  destroy() {
    console.log('[HypercoreStreamReader] Destroying - stats:', JSON.stringify(this.getStats()))

    this._destroyed = true
    this.initialized = false

    this.cache.clear()
    this.cacheOrder = []
    this.blockSizes.clear()
    this.blockBoundaries = []
    this.blockIndex.clear()

    this.core = null
  }
}

export default HypercoreStreamReader
