/**
 * FMP4Segmenter - parses fragmented MP4 byte stream into HLS segments.
 *
 * Receives raw bytes from bare-ffmpeg's IOContext `onwrite` callback.
 * Splits at moof box boundaries and stores segments in a MemorySegmentStore.
 *
 * Duration tracking:
 *   Call `notifyKeyframe(pts, timeBase)` from the transcode loop whenever
 *   a video keyframe packet is written. The segmenter uses PTS deltas to
 *   compute real segment durations for accurate HLS manifests.
 *
 * @example
 *   const segmenter = new FMP4Segmenter(store, { targetDuration: 6 })
 *   // In IOContext onwrite:
 *   onwrite: (buf) => { segmenter.write(Buffer.from(buf)); return buf.length }
 *   // In transcode loop (on video keyframe):
 *   segmenter.notifyKeyframe(packet.pts, videoStream.timeBase)
 *   // After transcoding:
 *   segmenter.finish()
 */
export class FMP4Segmenter {
  constructor(store, { targetDuration = 6 } = {}) {
    this.store = store
    this.targetDuration = targetDuration

    this.buffer = Buffer.alloc(0)
    this.initChunks = []
    this.currentSegmentChunks = []
    this.headerParsed = false
    this.segmentIndex = 0

    // PTS-based duration tracking
    this._lastKeyframePts = null   // PTS of last keyframe that started a segment
    this._currentKeyframePts = null // PTS of current keyframe (triggers flush of previous segment)
    this._timeBaseNum = 0
    this._timeBaseDen = 0
    this._pendingDuration = null   // Duration computed from PTS delta, applied on next flush
  }

  static MAX_SEGMENT_BYTES = 32 * 1024 * 1024

  /**
   * Notify the segmenter that a video keyframe was written.
   * Call this from the transcode loop BEFORE outputFormat.writeFrame()
   * so the PTS is captured before the moof box arrives in write().
   *
   * @param {number} pts - Presentation timestamp of the keyframe packet
   * @param {{ numerator: number, denominator: number }} timeBase - Stream time base
   */
  notifyKeyframe(pts, timeBase) {
    if (pts == null || !Number.isFinite(pts)) return
    if (!timeBase || !timeBase.denominator) return

    this._timeBaseNum = timeBase.numerator || 1
    this._timeBaseDen = timeBase.denominator || 1

    if (this._lastKeyframePts === null) {
      // First keyframe — no previous segment to compute duration for
      this._lastKeyframePts = pts
      return
    }

    // Compute duration of the segment that's about to be flushed
    const ptsDelta = pts - this._lastKeyframePts
    const duration = (ptsDelta * this._timeBaseNum) / this._timeBaseDen

    if (duration > 0 && duration < 300) {
      // Sane duration (< 5 minutes) — store it for the next flush
      this._pendingDuration = duration
    }

    this._lastKeyframePts = pts
  }

  write(chunk) {
    if (!chunk || chunk.length === 0) return 0

    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    this._processBoxes()
    return chunk.length
  }

  finish() {
    this._processBoxes()

    if (this.headerParsed && this.currentSegmentChunks.length > 0) {
      this._flushSegment()
    } else if (!this.headerParsed && this.initChunks && this.initChunks.length > 0) {
      this.store.writeInit(Buffer.concat(this.initChunks))
      this.initChunks = null
    }

    this.store.setFinished()
  }

  _processBoxes() {
    for (;;) {
      if (this.buffer.length < 8) break

      const size32 = this.buffer.readUInt32BE(0)
      let headerSize = 8
      let boxSize = size32

      if (size32 === 1) {
        if (this.buffer.length < 16) break
        const extSize = Number(this.buffer.readBigUInt64BE(8))
        if (!Number.isFinite(extSize) || extSize < 16) break
        headerSize = 16
        boxSize = extSize
      } else if (size32 === 0) {
        break
      }

      if (!Number.isFinite(boxSize) || boxSize < headerSize) break
      if (this.buffer.length < boxSize) break

      const boxType = this.buffer.toString('ascii', 4, 8)
      const boxData = this.buffer.subarray(0, boxSize)
      this.buffer = this.buffer.subarray(boxSize)

      if (!this.headerParsed) {
        if (boxType === 'moof') {
          this.headerParsed = true
          this.store.writeInit(Buffer.concat(this.initChunks))
          this.initChunks = null
          this.currentSegmentChunks = [boxData]
        } else {
          this.initChunks.push(boxData)
        }
        continue
      }

      if (boxType === 'moof') {
        if (this.currentSegmentChunks.length > 0) {
          this._flushSegment()
        }
        this.currentSegmentChunks = [boxData]
      } else {
        this.currentSegmentChunks.push(boxData)
      }
    }
  }

  _flushSegment() {
    let totalSize = 0
    for (const chunk of this.currentSegmentChunks) {
      totalSize += chunk.length
      if (totalSize > FMP4Segmenter.MAX_SEGMENT_BYTES) {
        throw new Error(`Cast segment exceeds safe size (${totalSize} bytes)`)
      }
    }
    const segData = Buffer.concat(this.currentSegmentChunks, totalSize)
    const name = `seg-${String(this.segmentIndex).padStart(5, '0')}.m4s`

    // Use PTS-derived duration if available, otherwise fall back to targetDuration
    const duration = this._pendingDuration != null ? this._pendingDuration : this.targetDuration
    this._pendingDuration = null

    this.store.registerSegmentMeta(name, duration)
    this.store.stageSegment(name, segData)
    this.store.finalizeSegment(name)

    this.segmentIndex += 1
    this.currentSegmentChunks = []
  }
}
