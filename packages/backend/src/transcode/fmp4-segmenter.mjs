/**
 * FMP4Segmenter - parses fragmented MP4 byte stream into HLS segments.
 *
 * Receives raw bytes from bare-ffmpeg's IOContext `onwrite` callback.
 * Splits at moof box boundaries and stores segments in a MemorySegmentStore.
 *
 * @example
 *   const segmenter = new FMP4Segmenter(store, { targetDuration: 6 })
 *   // In IOContext onwrite:
 *   onwrite: (buf) => { segmenter.write(Buffer.from(buf)); return buf.length }
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
    const segData = Buffer.concat(this.currentSegmentChunks)
    const name = `seg-${String(this.segmentIndex).padStart(5, '0')}.m4s`

    this.store.registerSegmentMeta(name, this.targetDuration)
    this.store.stageSegment(name, segData)
    this.store.finalizeSegment(name)

    this.segmentIndex += 1
    this.currentSegmentChunks = []
  }
}
