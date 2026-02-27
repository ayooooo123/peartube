/**
 * MemorySegmentStore - in-memory HLS segment storage for Chromecast casting.
 *
 * Stores fMP4 init segment and a sliding window of media segments.
 * Generates HLS manifests for Chromecast consumption.
 *
 * API used by FMP4Segmenter:
 *   store.writeInit(Buffer)              — store the init segment (moov box)
 *   store.registerSegmentMeta(name, dur) — register segment metadata before data arrives
 *   store.stageSegment(name, data)       — stage segment data
 *   store.finalizeSegment(name)          — mark segment as ready to serve
 *   store.setFinished()                  — mark transcoding complete (adds EXT-X-ENDLIST)
 *
 * API used by cast-transcoder HTTP server:
 *   store.getInit()                      — returns init Buffer or null
 *   store.getSegment(name)               — returns segment Buffer or null
 *   store.getSegmentCount()              — returns number of finalized segments
 *   store.generateManifest()             — returns HLS manifest string or null
 *   store.debugSnapshot()                — returns debug info object
 *   store.destroy()                      — release all memory
 */
export class MemorySegmentStore {
  constructor({ maxSegments = 50, isFmp4 = true } = {}) {
    this.maxSegments = maxSegments
    this.isFmp4 = isFmp4

    this._init = null          // Buffer: fMP4 init segment (moov)
    this._segments = new Map() // name -> { data: Buffer, duration: number, finalized: boolean }
    this._segmentOrder = []    // ordered list of segment names (for manifest + eviction)
    this._finished = false     // true when transcoding is complete
    this._destroyed = false
  }

  // ─── Write API (called by FMP4Segmenter) ────────────────────────────────────

  writeInit(data) {
    if (this._destroyed) return
    this._init = Buffer.isBuffer(data) ? data : Buffer.from(data)
  }

  registerSegmentMeta(name, duration) {
    if (this._destroyed) return
    if (!this._segments.has(name)) {
      this._segments.set(name, { data: null, duration: duration || 6, finalized: false })
      this._segmentOrder.push(name)
      this._evictOldSegments()
    }
  }

  stageSegment(name, data) {
    if (this._destroyed) return
    const entry = this._segments.get(name)
    if (entry) {
      entry.data = Buffer.isBuffer(data) ? data : Buffer.from(data)
    }
  }

  finalizeSegment(name) {
    if (this._destroyed) return
    const entry = this._segments.get(name)
    if (entry) {
      entry.finalized = true
    }
  }

  setFinished() {
    if (this._destroyed) return
    this._finished = true
  }

  // ─── Read API (called by HTTP server) ───────────────────────────────────────

  getInit() {
    return this._init || null
  }

  getSegment(name) {
    if (this._destroyed) return null
    const entry = this._segments.get(name)
    if (!entry || !entry.finalized || !entry.data) return null
    return entry.data
  }

  getSegmentCount() {
    if (this._destroyed) return 0
    let count = 0
    for (const entry of this._segments.values()) {
      if (entry.finalized) count++
    }
    return count
  }

  /**
   * Generate HLS manifest. Returns null if init segment or no finalized segments yet.
   */
  generateManifest() {
    if (this._destroyed) return null
    if (!this._init) return null

    const finalized = this._segmentOrder.filter(name => {
      const entry = this._segments.get(name)
      return entry && entry.finalized
    })

    if (finalized.length === 0) return null

    // Compute max target duration (ceiling of all segment durations)
    let maxDuration = 6
    for (const name of finalized) {
      const entry = this._segments.get(name)
      if (entry && entry.duration > maxDuration) maxDuration = entry.duration
    }

    // Compute media sequence (first segment index in current window)
    const firstSegName = finalized[0]
    const firstSegIndex = this._parseSegmentIndex(firstSegName)
    const mediaSequence = firstSegIndex >= 0 ? firstSegIndex : 0

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-MAP:URI="init.mp4"',
    ]

    for (const name of finalized) {
      const entry = this._segments.get(name)
      const dur = entry ? entry.duration : 6
      lines.push(`#EXTINF:${dur.toFixed(3)},`)
      lines.push(name)
    }

    if (this._finished) {
      lines.push('#EXT-X-ENDLIST')
    }

    return lines.join('\n') + '\n'
  }

  debugSnapshot() {
    return {
      hasInit: !!this._init,
      initSize: this._init ? this._init.length : 0,
      totalSegments: this._segmentOrder.length,
      finalizedSegments: this.getSegmentCount(),
      finished: this._finished,
      segments: this._segmentOrder.slice(-5).map(name => {
        const entry = this._segments.get(name)
        return {
          name,
          size: entry?.data?.length || 0,
          finalized: entry?.finalized || false,
        }
      }),
    }
  }

  destroy() {
    this._destroyed = true
    this._init = null
    this._segments.clear()
    this._segmentOrder = []
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _evictOldSegments() {
    while (this._segmentOrder.length > this.maxSegments) {
      const oldest = this._segmentOrder.shift()
      this._segments.delete(oldest)
    }
  }

  _parseSegmentIndex(name) {
    // seg-00000.m4s → 0, seg-00001.m4s → 1, etc.
    const match = name && name.match(/seg-(\d+)\.m4s$/)
    return match ? parseInt(match[1], 10) : -1
  }
}
