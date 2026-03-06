/**
 * MemorySegmentStore - in-memory HLS segment storage for Chromecast casting.
 *
 * Stores fMP4 init segment and a sliding window of media segments.
 * Generates HLS manifests for Chromecast consumption.
 *
 * Manifest behaviour:
 *   - While transcoding is in progress, generates a live-style manifest
 *     (no EXT-X-PLAYLIST-TYPE) with a sliding window of segments.
 *   - Once transcoding completes (setFinished), switches to
 *     EXT-X-PLAYLIST-TYPE:VOD with EXT-X-ENDLIST.
 *   - TARGETDURATION is computed dynamically from actual segment durations.
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
  constructor({ maxSegments = 50, isFmp4 = true, startupPinned = false, startupPinnedSegments = 120 } = {}) {
    this.maxSegments = maxSegments
    this.isFmp4 = isFmp4
    this.startupPinned = !!startupPinned
    this.startupPinnedSegments = Number.isFinite(startupPinnedSegments) ? Math.max(1, Math.floor(startupPinnedSegments)) : 120

    this._init = null          // Buffer: fMP4 init segment (moov)
    this._segments = new Map() // name -> { data: Buffer, duration: number, finalized: boolean }
    this._segmentOrder = []    // ordered list of segment names (for manifest + eviction)
    this._finished = false     // true when transcoding is complete
    this._destroyed = false
    this._maxDuration = 0      // track max segment duration for TARGETDURATION
  }

  // ─── Write API (called by FMP4Segmenter) ────────────────────────────────────

  writeInit(data) {
    if (this._destroyed) return
    this._init = Buffer.isBuffer(data) ? data : Buffer.from(data)
  }

  registerSegmentMeta(name, duration) {
    if (this._destroyed) return
    const dur = (duration && Number.isFinite(duration) && duration > 0) ? duration : 6
    if (!this._segments.has(name)) {
      this._segments.set(name, { data: null, duration: dur, finalized: false })
      this._segmentOrder.push(name)
      if (dur > this._maxDuration) this._maxDuration = dur
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

  setStartupPinned(pinned) {
    if (this._destroyed) return
    this.startupPinned = !!pinned
    this._evictOldSegments()
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
   *
   * Live (during transcode): no playlist type, sliding window, no ENDLIST.
   * VOD (after finish):      EXT-X-PLAYLIST-TYPE:VOD + EXT-X-ENDLIST.
   */
  generateManifest() {
    if (this._destroyed) return null
    if (!this._init) return null

    const finalized = this._segmentOrder.filter(name => {
      const entry = this._segments.get(name)
      return entry && entry.finalized && !!entry.data
    })

    // Keep only a contiguous segment run to avoid serving playlists with holes.
    const contiguous = []
    let expectedIndex = null
    for (const name of finalized) {
      const index = this._parseSegmentIndex(name)
      if (index < 0) break
      if (expectedIndex == null) {
        contiguous.push(name)
        expectedIndex = index + 1
        continue
      }
      if (index !== expectedIndex) break
      contiguous.push(name)
      expectedIndex = index + 1
    }

    if (contiguous.length === 0) return null

    // Compute max target duration dynamically from actual segment durations
    let maxDuration = 0
    for (const name of contiguous) {
      const entry = this._segments.get(name)
      if (entry && entry.duration > maxDuration) maxDuration = entry.duration
    }
    // Also consider global max in case evicted segments had larger durations
    if (this._maxDuration > maxDuration) maxDuration = this._maxDuration
    // Ensure at least 1 second
    if (maxDuration < 1) maxDuration = 6

    // Compute media sequence (first segment index in current window)
    const firstSegName = contiguous[0]
    const firstSegIndex = this._parseSegmentIndex(firstSegName)
    const mediaSequence = firstSegIndex >= 0 ? firstSegIndex : 0

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    ]

    // During transcoding, use EVENT playlist type for better Chromecast behavior.
    // Once finished, switch to VOD + ENDLIST.
    if (this._finished) {
      lines.push('#EXT-X-PLAYLIST-TYPE:VOD')
    } else {
      lines.push('#EXT-X-PLAYLIST-TYPE:EVENT')
    }

    lines.push('#EXT-X-MAP:URI="init.mp4"')

    for (const name of contiguous) {
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
      maxDuration: this._maxDuration,
      segments: this._segmentOrder.slice(-5).map(name => {
        const entry = this._segments.get(name)
        return {
          name,
          size: entry?.data?.length || 0,
          duration: entry?.duration || 0,
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
    const startupFloor = this.startupPinned ? this.startupPinnedSegments : 0
    const effectiveMax = Number.isFinite(this.maxSegments)
      ? Math.max(this.maxSegments, startupFloor)
      : this.maxSegments
    while (this._segmentOrder.length > effectiveMax) {
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
