/**
 * HypercoreIOReader - Read video data directly from Hypercore blocks
 *
 * For fully-synced videos, this eliminates temp files and HTTP streaming
 * by reading directly from the local Hypercore storage.
 *
 * Architecture:
 * - Pre-loads blocks into memory buffer for sync IOContext access
 * - Handles byte offsets within blocks (Hyperblobs format)
 * - Provides seek support for FFmpeg demuxing
 *
 * Usage:
 *   const reader = new HypercoreIOReader(blobsCore, blobInfo)
 *   await reader.preload()
 *   const ioContext = reader.createIOContext(ffmpeg)
 */

console.log('[HypercoreIOReader] === MODULE LOADED ===')

// SEEK constants matching FFmpeg's whence values
const SEEK_SET = 0
const SEEK_CUR = 1
const SEEK_END = 2
const AVSEEK_SIZE = 0x10000 // FFmpeg's size query

export class HypercoreIOReader {
  /**
   * @param {Hypercore} blobsCore - The Hypercore containing blob data
   * @param {Object} blobInfo - Blob location info
   * @param {number} blobInfo.blockOffset - Starting block index
   * @param {number} blobInfo.blockLength - Number of blocks
   * @param {number} blobInfo.byteOffset - Byte offset within first block
   * @param {number} blobInfo.byteLength - Total byte length of blob
   */
  constructor(blobsCore, blobInfo) {
    console.log('[HypercoreIOReader] Constructor called with blobInfo:', JSON.stringify(blobInfo))
    this.core = blobsCore
    this.blockOffset = blobInfo.blockOffset
    this.blockLength = blobInfo.blockLength
    this.byteLength = blobInfo.byteLength

    // NOTE: blobInfo.byteOffset is the ABSOLUTE byte position in the hypercore,
    // not the offset within the first block. For Hyperdrive videos, the blob
    // typically starts at offset 0 of its first block.
    // We calculate the actual offset within the first block if needed.
    // For now, assume offset 0 since that's where the MKV header is found.
    this.byteOffset = 0
    console.log('[HypercoreIOReader] Using byteOffset=0 (blob starts at beginning of first block)')

    // Calculated values
    this.startBlock = this.blockOffset
    this.endBlock = this.blockOffset + this.blockLength

    // State
    this.position = 0
    this.blocks = new Map() // blockIndex -> Buffer
    this.totalSize = this.byteLength
    this.preloaded = false

    // Stats
    this.readCount = 0
    this.seekCount = 0
    this.bytesRead = 0
  }

  /**
   * Check if the video data is fully synced locally
   */
  async isFullySynced() {
    // Quick check via contiguousLength
    if (this.core.contiguousLength >= this.endBlock) {
      return true
    }

    // Check individual blocks
    for (let i = this.startBlock; i < this.endBlock; i++) {
      const hasBlock = await this.core.has(i)
      if (!hasBlock) {
        return false
      }
    }
    return true
  }

  /**
   * Preload all blocks into memory for sync access
   * Call this before creating IOContext
   */
  async preload() {
    console.log('[HypercoreIOReader] >>> preload() ENTRY <<<')
    console.log('[HypercoreIOReader] Preloading', this.blockLength, 'blocks from', this.startBlock, 'to', this.endBlock, '...')
    const startTime = Date.now()

    // Don't try to load everything at once for large videos - batch it
    // Use smaller batches to avoid overwhelming native Hypercore and causing memory corruption
    const BATCH_SIZE = 100
    const totalBlocks = this.endBlock - this.startBlock

    if (totalBlocks > BATCH_SIZE) {
      console.log('[HypercoreIOReader] Large video, loading in batches of', BATCH_SIZE)
    }

    let loadedCount = 0
    let errorCount = 0

    for (let batchStart = this.startBlock; batchStart < this.endBlock; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, this.endBlock)
      const batchPromises = []

      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(
          this.core.get(i).then(data => {
            if (data) {
              // CRITICAL: Make a defensive copy to avoid native write-after-free
              // The native Hypercore may reuse/free the buffer after returning
              const copy = Buffer.alloc(data.length)
              data.copy(copy)
              this.blocks.set(i, copy)
              loadedCount++
            } else {
              console.warn('[HypercoreIOReader] Block', i, 'returned null/undefined')
              errorCount++
            }
          }).catch(err => {
            console.error('[HypercoreIOReader] Failed to load block', i, ':', err?.message)
            errorCount++
          })
        )
      }

      await Promise.all(batchPromises)

      // Log progress for large videos
      if (totalBlocks > BATCH_SIZE) {
        const progress = Math.round(((batchEnd - this.startBlock) / totalBlocks) * 100)
        if (progress % 25 === 0 || batchEnd === this.endBlock) {
          console.log('[HypercoreIOReader] Preload progress:', progress + '%,', loadedCount, 'blocks loaded')
        }
      }
    }

    this.preloaded = true
    const elapsed = Date.now() - startTime

    let totalBytes = 0
    for (const block of this.blocks.values()) {
      if (block) totalBytes += block.length
    }

    console.log('[HypercoreIOReader] Preloaded', loadedCount, '/', this.blockLength, 'blocks,',
      Math.round(totalBytes / 1024 / 1024) + 'MB in', elapsed + 'ms',
      errorCount > 0 ? '(' + errorCount + ' errors)' : '')

    if (loadedCount === 0) {
      throw new Error('Failed to load any blocks')
    }

    return this
  }

  /**
   * Get a specific block (must be preloaded)
   */
  getBlock(index) {
    const block = this.blocks.get(index)
    if (!block) {
      console.error('[HypercoreIOReader] Block not preloaded:', index)
      return null
    }
    return block
  }

  /**
   * Calculate which block and offset within block for a given byte position
   */
  getBlockPosition(bytePos) {
    // Account for byteOffset in first block
    const adjustedPos = bytePos + this.byteOffset

    let currentPos = 0
    for (let i = this.startBlock; i < this.endBlock; i++) {
      const block = this.getBlock(i)
      if (!block) return null

      const blockStart = (i === this.startBlock) ? this.byteOffset : 0
      const blockEnd = block.length
      const blockDataLen = blockEnd - blockStart

      if (currentPos + blockDataLen > bytePos) {
        // Found the block
        const offsetInBlock = (i === this.startBlock)
          ? this.byteOffset + (bytePos - currentPos)
          : (bytePos - currentPos)
        return { blockIndex: i, offsetInBlock }
      }
      currentPos += blockDataLen
    }

    return null // Past end
  }

  /**
   * Synchronous read for IOContext
   * @param {Buffer} buffer - Output buffer to fill
   * @returns {number} Bytes read, or negative for error/EOF
   */
  syncRead(buffer) {
    if (!this.preloaded) {
      console.error('[HypercoreIOReader] Not preloaded!')
      return -1  // Error: not initialized
    }

    this.readCount++
    const requestedLen = buffer.length

    if (this.position >= this.totalSize) {
      // EOF - return 0, NOT -1 (which signals error to FFmpeg)
      if (this.readCount <= 10) {
        console.log('[HypercoreIOReader] EOF at position', this.position)
      }
      return 0
    }

    let bytesWritten = 0
    let remainingToRead = Math.min(requestedLen, this.totalSize - this.position)

    while (remainingToRead > 0) {
      const pos = this.getBlockPosition(this.position)
      if (!pos) {
        console.warn('[HypercoreIOReader] getBlockPosition returned null at position', this.position)
        break // Past end
      }

      const block = this.getBlock(pos.blockIndex)
      if (!block) {
        console.warn('[HypercoreIOReader] Block', pos.blockIndex, 'not loaded!')
        break
      }

      // Calculate how much we can read from this block
      const availableInBlock = block.length - pos.offsetInBlock
      if (availableInBlock <= 0) {
        console.warn('[HypercoreIOReader] Block', pos.blockIndex, 'has no available bytes at offset', pos.offsetInBlock)
        break
      }
      const toRead = Math.min(remainingToRead, availableInBlock)

      // Copy data to output buffer
      block.copy(buffer, bytesWritten, pos.offsetInBlock, pos.offsetInBlock + toRead)

      bytesWritten += toRead
      this.position += toRead
      remainingToRead -= toRead
    }

    this.bytesRead += bytesWritten

    if (this.readCount <= 10 || this.readCount % 500 === 0) {
      console.log('[HypercoreIOReader] Read #' + this.readCount + ':', bytesWritten,
        'bytes at pos', this.position - bytesWritten,
        'total:', Math.round(this.bytesRead / 1024 / 1024) + 'MB')
    }

    // Return 0 for EOF (no bytes available), positive for success
    // Only return -1 for actual errors (not preloaded)
    return bytesWritten
  }

  /**
   * Seek for IOContext
   * @param {number} offset - Seek offset
   * @param {number} whence - SEEK_SET, SEEK_CUR, SEEK_END, or AVSEEK_SIZE
   * @returns {number} New position, or -1 for error
   */
  seek(offset, whence) {
    this.seekCount++

    // Handle AVSEEK_SIZE - FFmpeg asking for total size
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
        console.warn('[HypercoreIOReader] Unknown whence:', whence)
        return -1
    }

    // Clamp to valid range
    if (newPos < 0) newPos = 0
    if (newPos > this.totalSize) newPos = this.totalSize

    this.position = newPos

    if (this.seekCount <= 5 || this.seekCount % 100 === 0) {
      console.log('[HypercoreIOReader] Seek #' + this.seekCount + ':',
        'whence=' + whence, 'offset=' + offset, '-> pos=' + newPos)
    }

    return newPos
  }

  /**
   * Create IOContext for bare-ffmpeg
   * @param {Object} ffmpeg - bare-ffmpeg module
   * @returns {IOContext}
   */
  createIOContext(ffmpeg) {
    if (!this.preloaded) {
      throw new Error('Must call preload() before createIOContext()')
    }

    const self = this

    // Use 128KB buffer for IOContext
    const ioContext = new ffmpeg.IOContext(128 * 1024, {
      onread: (buffer) => {
        return self.syncRead(buffer)
      },
      onseek: (offset, whence) => {
        return self.seek(offset, whence)
      }
    })

    console.log('[HypercoreIOReader] IOContext created, totalSize:', this.totalSize,
      'blocks:', this.blockLength)

    return ioContext
  }

  /**
   * Get reader stats
   */
  getStats() {
    return {
      totalSize: this.totalSize,
      position: this.position,
      blocksLoaded: this.blocks.size,
      readCount: this.readCount,
      seekCount: this.seekCount,
      bytesRead: this.bytesRead,
      progress: Math.round((this.position / this.totalSize) * 100)
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    console.log('[HypercoreIOReader] Destroying - reads:', this.readCount,
      'seeks:', this.seekCount, 'bytesRead:', Math.round(this.bytesRead / 1024 / 1024) + 'MB')
    this.blocks.clear()
    this.preloaded = false
  }
}

/**
 * Create a HypercoreIOReader from video metadata and context
 *
 * @param {Object} ctx - Backend context with store
 * @param {Object} video - Video metadata with blobId field
 * @returns {Promise<HypercoreIOReader>}
 */
export async function createReaderFromVideo(ctx, video) {
  // Parse blob ID string if needed
  let blobInfo = video.blobId
  if (typeof blobInfo === 'string') {
    const parts = blobInfo.split(':').map(Number)
    blobInfo = {
      blockOffset: parts[0],
      blockLength: parts[1],
      byteOffset: parts[2],
      byteLength: parts[3]
    }
  }

  // Get the blobs core
  const blobsKeyHex = video.blobsCoreKey
  const blobsCore = ctx.store.get(Buffer.from(blobsKeyHex, 'hex'))
  await blobsCore.ready()

  const reader = new HypercoreIOReader(blobsCore, blobInfo)

  // Check if fully synced
  const synced = await reader.isFullySynced()
  if (!synced) {
    throw new Error('Video not fully synced - use streaming reader instead')
  }

  return reader
}

export default HypercoreIOReader
