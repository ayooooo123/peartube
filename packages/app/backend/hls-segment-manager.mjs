/**
 * HlsSegmentManager
 *
 * Manages HLS/MPEGTS segment creation, storage, and playlist generation
 * for real-time transcoding to Chromecast.
 *
 * Key features:
 * - Keyframe-based segmentation with 8s max cap
 * - Hybrid memory + disk storage
 * - EVENT playlist type (append-only, no sliding window)
 * - Dynamic TARGETDURATION calculation
 * - All segments retained until destroy() for full seek support
 */

import fs from 'bare-fs'
import path from 'bare-path'

// Segment duration targets
const TARGET_SEGMENT_DURATION = 2 // Target 2 seconds
const MAX_SEGMENT_DURATION = 4    // Hard cap at 4 seconds

// Storage settings
const MAX_MEMORY_SEGMENTS = 30     // Keep 30 most recent in memory (~150MB)
// CRITICAL: Keep ALL segments for Chromecast compatibility
// Chromecast buffers ahead and may seek back - sliding window causes 503 errors
const MAX_PLAYLIST_SEGMENTS = 99999  // Effectively unlimited
const SEGMENT_TTL_MS = 2 * 60 * 60 * 1000 // 2 hour TTL (for very long videos)

/**
 * Represents a single HLS segment
 */
class Segment {
  constructor(index, startTime) {
    this.index = index
    this.startTime = startTime  // PTS in seconds
    this.duration = 0           // Duration in seconds
    this.data = null            // Buffer (in memory) or null (on disk)
    this.diskPath = null        // Path if spilled to disk
    this.size = 0               // Size in bytes
    this.createdAt = Date.now()
    this.complete = false
  }

  isExpired() {
    return Date.now() - this.createdAt > SEGMENT_TTL_MS
  }

  isInMemory() {
    return this.data !== null
  }
}

/**
 * HlsSegmentManager - creates and manages HLS segments
 */
export class HlsSegmentManager {
  constructor(sessionId, tempDir) {
    this.sessionId = sessionId
    this.tempDir = tempDir || '/tmp'
    this.segmentDir = path.join(this.tempDir, `hls-${sessionId}`)

    // Segment storage
    this.segments = new Map() // index -> Segment
    this.currentSegment = null
    this.nextSegmentIndex = 0

    // Playlist state
    this.mediaSequence = 0     // First segment index in playlist
    this.isComplete = false    // Transcoding finished

    // Packet accumulator for current segment
    this.packetBuffer = []
    this.currentSegmentStartPts = 0
    this.currentSegmentDuration = 0

    // MPEGTS header (PAT/PMT) to prepend to each segment
    // This is required for each HLS segment to be independently playable
    this.mpegtsHeader = null

    // Stats
    this.totalSegments = 0
    this.totalBytes = 0
    this.memoryUsage = 0
    this.diskUsage = 0

    // Create segment directory
    this._ensureDir()

    console.log('[HlsSegmentManager] Created for session', sessionId)
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.segmentDir, { recursive: true })
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error('[HlsSegmentManager] Failed to create dir:', err.message)
      }
    }
  }

  /**
   * Set the MPEGTS header (PAT/PMT) to prepend to each segment.
   * This must be called after FFmpeg writeHeader() with the header data.
   * Each HLS segment needs PAT/PMT to be independently playable.
   * @param {Buffer} header - The MPEGTS header data
   */
  setMpegtsHeader(header) {
    // CRITICAL: Manual byte-by-byte copy for maximum safety
    const len = header.length
    this.mpegtsHeader = Buffer.alloc(len)
    for (let i = 0; i < len; i++) {
      this.mpegtsHeader[i] = header[i]
    }
    console.log('[HlsSegmentManager] MPEGTS header set, size:', len, 'bytes')
  }

  /**
   * Start a new segment
   */
  _startNewSegment(pts) {
    // Finalize previous segment first
    if (this.currentSegment && this.packetBuffer.length > 0) {
      this._finalizeCurrentSegment()
    }

    const index = this.nextSegmentIndex++
    this.currentSegment = new Segment(index, pts)
    this.currentSegmentStartPts = pts
    this.currentSegmentDuration = 0
    this.packetBuffer = []

    console.log('[HlsSegmentManager] Started segment', index, 'at PTS', pts.toFixed(2))
  }

  /**
   * Finalize and store current segment
   */
  _finalizeCurrentSegment() {
    if (!this.currentSegment || this.packetBuffer.length === 0) return

    // Concatenate all packets into segment data
    let data = Buffer.concat(this.packetBuffer)

    // CRITICAL: Prepend MPEGTS header (PAT/PMT) to EVERY segment
    // HLS requires each segment to be independently playable.
    // Without PAT/PMT, the decoder doesn't know the stream structure.
    if (this.mpegtsHeader) {
      data = Buffer.concat([this.mpegtsHeader, data])
      console.log('[HlsSegmentManager] Prepended PAT/PMT header to segment', this.currentSegment.index)
    } else {
      console.warn('[HlsSegmentManager] WARNING: No MPEGTS header set, segment may not be playable!')
    }

    this.currentSegment.data = data
    this.currentSegment.size = data.length
    this.currentSegment.duration = this.currentSegmentDuration
    this.currentSegment.complete = true

    // Store segment
    this.segments.set(this.currentSegment.index, this.currentSegment)
    this.totalSegments++
    this.totalBytes += data.length
    this.memoryUsage += data.length

    console.log('[HlsSegmentManager] Finalized segment', this.currentSegment.index,
      'duration:', this.currentSegment.duration.toFixed(2) + 's',
      'size:', Math.round(data.length / 1024) + 'KB')

    // Manage memory by spilling old segments to disk
    this._manageMemory()

    // Clean up expired and out-of-window segments
    this._cleanupSegments()

    this.packetBuffer = []
  }

  /**
   * Write a packet to the current segment
   * @param {Buffer} packet - MPEGTS packet data
   * @param {boolean} isKeyframe - Whether this packet contains a keyframe
   * @param {number} pts - Presentation timestamp in seconds
   */
  writePacket(packet, isKeyframe, pts) {
    // Very first line - verify this function is called at all
    if (this.packetBuffer.length === 0 && !this.currentSegment) {
      console.log('[HlsSegmentManager] writePacket FIRST CALL: packet size=' + (packet?.length || 0) + ' keyframe=' + isKeyframe + ' pts=' + pts)
    }

    // Start first segment
    if (!this.currentSegment) {
      this._startNewSegment(pts)
    }

    // Calculate duration so far
    const segmentDuration = pts - this.currentSegmentStartPts

    // Debug logging for first few calls and periodically
    if (this.totalSegments === 0 && (this.packetBuffer.length < 5 || this.packetBuffer.length % 100 === 0)) {
      console.log('[HlsSegmentManager] writePacket: pts=' + pts.toFixed(2) +
        ' startPts=' + this.currentSegmentStartPts.toFixed(2) +
        ' duration=' + segmentDuration.toFixed(2) +
        ' bufferLen=' + this.packetBuffer.length +
        ' keyframe=' + isKeyframe)
    }

    // Check if we should start a new segment:
    // 1. At keyframe if we've reached target duration, OR
    // 2. Hard cap reached regardless of keyframe
    const shouldSplit = (
      (isKeyframe && segmentDuration >= TARGET_SEGMENT_DURATION) ||
      (segmentDuration >= MAX_SEGMENT_DURATION)
    )

    if (shouldSplit && this.packetBuffer.length > 0) {
      console.log('[HlsSegmentManager] Splitting segment: duration=' + segmentDuration.toFixed(2) + ' keyframe=' + isKeyframe)
      // Finalize current segment with duration up to this keyframe
      this.currentSegmentDuration = segmentDuration
      this._finalizeCurrentSegment()

      // Start new segment at this keyframe
      this._startNewSegment(pts)
    }

    // Update duration tracking
    this.currentSegmentDuration = pts - this.currentSegmentStartPts

    // Add packet to buffer - manual byte-by-byte copy for maximum safety
    const len = packet.length
    const packetCopy = Buffer.alloc(len)
    for (let i = 0; i < len; i++) {
      packetCopy[i] = packet[i]
    }
    this.packetBuffer.push(packetCopy)
  }

  /**
   * Close the current segment and mark transcoding as complete
   */
  closeCurrentSegment() {
    if (this.currentSegment && this.packetBuffer.length > 0) {
      this._finalizeCurrentSegment()
    }
    this.isComplete = true
    this.currentSegment = null
    console.log('[HlsSegmentManager] Transcoding complete, total segments:', this.totalSegments)
  }

  /**
   * Spill older segments to disk to manage memory
   */
  _manageMemory() {
    // Count in-memory segments
    let memorySegments = []
    for (const [index, segment] of this.segments) {
      if (segment.isInMemory()) {
        memorySegments.push({ index, segment })
      }
    }

    // Sort by index (oldest first)
    memorySegments.sort((a, b) => a.index - b.index)

    // Spill oldest to disk if over limit
    while (memorySegments.length > MAX_MEMORY_SEGMENTS) {
      const { index, segment } = memorySegments.shift()
      this._spillToDisk(segment)
    }
  }

  /**
   * Write segment to disk and free memory
   */
  _spillToDisk(segment) {
    if (!segment.isInMemory()) return

    const filename = `segment${segment.index}.ts`
    const filepath = path.join(this.segmentDir, filename)

    try {
      fs.writeFileSync(filepath, segment.data)
      segment.diskPath = filepath
      this.diskUsage += segment.size
      this.memoryUsage -= segment.size
      segment.data = null // Free memory

      console.log('[HlsSegmentManager] Spilled segment', segment.index, 'to disk')
    } catch (err) {
      console.error('[HlsSegmentManager] Failed to spill segment:', err.message)
    }
  }

  /**
   * Clean up expired and out-of-window segments
   */
  _cleanupSegments() {
    const toDelete = []

    for (const [index, segment] of this.segments) {
      // Check if outside playlist window
      const outsideWindow = index < this.mediaSequence

      // Check if expired by TTL
      const expired = segment.isExpired()

      if (outsideWindow || expired) {
        toDelete.push(index)
      }
    }

    for (const index of toDelete) {
      this._deleteSegment(index)
    }

    // Update media sequence if we have too many segments
    this._updateMediaSequence()
  }

  /**
   * Update media sequence to maintain sliding window
   */
  _updateMediaSequence() {
    if (!this.isComplete) {
      // Only slide window during live transcoding
      const segmentCount = this.segments.size
      if (segmentCount > MAX_PLAYLIST_SEGMENTS) {
        // Find the new media sequence
        const indices = Array.from(this.segments.keys()).sort((a, b) => a - b)
        const toRemove = segmentCount - MAX_PLAYLIST_SEGMENTS

        for (let i = 0; i < toRemove; i++) {
          this._deleteSegment(indices[i])
        }

        this.mediaSequence = indices[toRemove]
        console.log('[HlsSegmentManager] Sliding window, new media sequence:', this.mediaSequence)
      }
    }
  }

  /**
   * Delete a segment from memory and disk
   */
  _deleteSegment(index) {
    const segment = this.segments.get(index)
    if (!segment) return

    // Free memory
    if (segment.isInMemory()) {
      this.memoryUsage -= segment.size
    }

    // Delete from disk
    if (segment.diskPath) {
      try {
        fs.unlinkSync(segment.diskPath)
        this.diskUsage -= segment.size
      } catch (err) {
        // Ignore file not found
      }
    }

    this.segments.delete(index)
  }

  /**
   * Get segment data (loads from disk if necessary)
   * @param {number} index - Segment index
   * @returns {Buffer|null} - Segment data or null if not found
   */
  getSegment(index) {
    const segment = this.segments.get(index)
    if (!segment || !segment.complete) {
      return null
    }

    // Return from memory if available - manual copy for maximum safety
    if (segment.isInMemory()) {
      const len = segment.data.length
      const copy = Buffer.alloc(len)
      for (let i = 0; i < len; i++) {
        copy[i] = segment.data[i]
      }
      return copy
    }

    // Load from disk - fs.readFileSync should return a new buffer
    if (segment.diskPath) {
      try {
        return fs.readFileSync(segment.diskPath)
      } catch (err) {
        console.error('[HlsSegmentManager] Failed to read segment from disk:', err.message)
        return null
      }
    }

    return null
  }

  /**
   * Add a complete segment (API compatible with HlsHyperblobsSegmentManager)
   * @param {number} index - Segment index
   * @param {number} duration - Segment duration in seconds
   * @param {Buffer} data - Complete MPEGTS segment data
   */
  async addSegment(index, duration, data) {
    this._ensureDir()

    // Use segment data as-is - MPEGTS muxer should be configured to include PAT/PMT at keyframes
    const segmentData = data

    const segment = new Segment(index, 0)
    segment.duration = duration
    segment.size = segmentData.length
    segment.complete = true

    // Store in memory first
    segment.data = segmentData

    this.segments.set(index, segment)
    this.totalSegments++

    console.log('[HlsSegmentManager] Segment', index, 'added:', segmentData.length, 'bytes, duration:', duration.toFixed(2) + 's')

    // Manage memory - spill to disk if too many in memory
    this._manageMemory()
  }

  /**
   * Mark transcoding as complete (called by transcoder after all segments are done)
   */
  finish() {
    if (this.currentSegment && this.packetBuffer.length > 0) {
      this._finalizeCurrentSegment()
    }
    this.isComplete = true
    this.currentSegment = null
    console.log('[HlsSegmentManager] Transcoding complete via finish(), total segments:', this.totalSegments)
  }

  /**
   * Check if segment is ready (complete)
   */
  hasSegment(index) {
    const segment = this.segments.get(index)
    return segment && segment.complete
  }

  /**
   * Get the highest available segment index
   */
  getHighestSegmentIndex() {
    let max = -1
    for (const [index, segment] of this.segments) {
      if (segment.complete && index > max) {
        max = index
      }
    }
    return max
  }

  /**
   * Generate HLS playlist (m3u8)
   * @returns {string} - Playlist content
   */
  generatePlaylist() {
    // Get sorted list of complete segments in playlist window
    const playlistSegments = []
    for (const [index, segment] of this.segments) {
      if (segment.complete && index >= this.mediaSequence) {
        playlistSegments.push(segment)
      }
    }
    playlistSegments.sort((a, b) => a.index - b.index)

    console.log('[HlsSegmentManager] generatePlaylist: total segments in map:', this.segments.size, 
      'complete segments for playlist:', playlistSegments.length,
      'mediaSequence:', this.mediaSequence,
      'isComplete:', this.isComplete)

    if (playlistSegments.length === 0) {
      // Return minimal valid playlist
      console.log('[HlsSegmentManager] generatePlaylist: returning empty playlist (no segments yet)')
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        ''
      ].join('\n')
    }

    // Calculate TARGETDURATION as ceil(max segment duration)
    let maxDuration = TARGET_SEGMENT_DURATION
    for (const segment of playlistSegments) {
      if (segment.duration > maxDuration) {
        maxDuration = segment.duration
      }
    }
    const targetDuration = Math.ceil(maxDuration)

    const firstSegmentIndex = playlistSegments[0].index
    const lastSegmentIndex = playlistSegments[playlistSegments.length - 1].index

    // Build playlist
    // Desktop-compatible simple playlist format
    // Chromecast works better with minimal tags (no EVENT/START/INDEPENDENT-SEGMENTS)
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSegmentIndex}`
    ]

    for (const segment of playlistSegments) {
      lines.push(`#EXTINF:${segment.duration.toFixed(3)},`)
      // Segment filename uses the actual segment index for consistency
      lines.push(`segment${segment.index}.ts`)
      lines.push('') // Ensure newline after each segment URL
    }

    // Log segment count for debugging playlist updates
    console.log('[HlsSegmentManager] Playlist generated with', playlistSegments.length, 'segments, last index:', lastSegmentIndex, 'isComplete:', this.isComplete)

    // Add ENDLIST if transcoding is complete
    // This signals to Chromecast that no more segments will be added
    if (this.isComplete) {
      lines.push('#EXT-X-ENDLIST')
    }
    const playlist = lines.join('\n')
    
    // Log first few lines for debugging
    const previewLines = playlist.split('\n').slice(0, 8).join('\n')
    console.log('[HlsSegmentManager] Playlist content before preview:', playlist)
    const preview = playlist.split('\n').slice(0, 8).join('\n')
    console.log('[HlsSegmentManager] generatePlaylist preview:\n' + preview + '\n...')
    
    return playlist
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    return {
      totalSegments: this.totalSegments,
      activeSegments: this.segments.size,
      mediaSequence: this.mediaSequence,
      memoryUsageMB: Math.round(this.memoryUsage / 1024 / 1024 * 10) / 10,
      diskUsageMB: Math.round(this.diskUsage / 1024 / 1024 * 10) / 10,
      totalMB: Math.round(this.totalBytes / 1024 / 1024 * 10) / 10,
      isComplete: this.isComplete,
      playlistReady: this.totalSegments > 0  // Ready when we have at least one segment
    }
  }

  /**
   * Full cleanup on session end
   */
  destroy() {
    console.log('[HlsSegmentManager] Destroying, stats:', this.getStats())

    // Delete all segments
    for (const index of this.segments.keys()) {
      this._deleteSegment(index)
    }

    // Remove segment directory
    try {
      fs.rmdirSync(this.segmentDir)
    } catch (err) {
      // Ignore errors
    }

    this.segments.clear()
    this.currentSegment = null
    this.packetBuffer = []
  }
}

export default HlsSegmentManager
