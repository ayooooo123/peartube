/**
 * Live Core Writer
 *
 * Appends a live stream to a single-writer hypercore in the live-core-format
 * block layout. Implements the segment-store interface that FMP4Segmenter
 * drives (writeInit / registerSegmentMeta / stageSegment / finalizeSegment /
 * setFinished), so the existing segmenter pipes encoder output straight into
 * the core:
 *
 *   encoder bytes → FMP4Segmenter → LiveCoreWriter → core.append(...)
 *
 * The segmenter calls synchronously from the transcode loop while hypercore
 * appends are async, so appends are serialized on an internal promise chain.
 * Callers observe failures via flush() or the 'error' state.
 */

import {
  encodeStreamDescriptor,
  encodeEndOfStream,
  isMediaFragmentBlock,
  FIRST_MEDIA_BLOCK,
  DEFAULT_TARGET_FRAGMENT_DURATION_S,
} from './live-core-format.js'

export class LiveCoreWriter {
  constructor(core, descriptor = {}) {
    this.core = core
    this.descriptor = {
      targetFragmentDuration: DEFAULT_TARGET_FRAGMENT_DURATION_S,
      ...descriptor,
    }

    this.state = 'created' // created → live → finished | error
    this.error = null
    this.mediaBlocks = 0
    this.segmentDurations = [] // seconds, parallel to appended media blocks

    this._initWritten = false
    this._pendingDurations = new Map() // segment name → duration
    this._staged = new Map() // segment name → Buffer
    this._tail = Promise.resolve()
  }

  /**
   * Append the stream descriptor (block 0). Must run on a fresh core before
   * the segmenter writes anything.
   */
  async open() {
    await this.core.ready()
    if (this.core.length !== 0) {
      throw new Error(`Live core is not fresh (length ${this.core.length}); live sessions never resume a core`)
    }
    this._append(encodeStreamDescriptor(this.descriptor))
    this.state = 'live'
    await this.flush()
    return this
  }

  // ─── FMP4Segmenter store interface ─────────────────────────────────────────

  writeInit(buffer) {
    if (this._initWritten) return
    this._initWritten = true
    this._append(buffer)
  }

  registerSegmentMeta(name, duration) {
    if (Number.isFinite(duration) && duration > 0) {
      this._pendingDurations.set(name, duration)
    }
  }

  stageSegment(name, data) {
    this._staged.set(name, data)
  }

  finalizeSegment(name) {
    const data = this._staged.get(name)
    this._staged.delete(name)
    if (!data || data.length === 0) return
    if (!isMediaFragmentBlock(data)) {
      this._fail(new Error(`Live segment ${name} does not start with a moof box`))
      return
    }

    const duration = this._pendingDurations.get(name)
    this._pendingDurations.delete(name)
    this.segmentDurations.push(
      Number.isFinite(duration) && duration > 0
        ? duration
        : this.descriptor.targetFragmentDuration
    )
    this.mediaBlocks++
    this._append(data)
  }

  setFinished() {
    if (this.state !== 'live') return
    this.state = 'finished'
    this._append(encodeEndOfStream({ mediaBlocks: this.mediaBlocks }))
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Wait for every queued append to land (or surface the first failure). */
  async flush() {
    await this._tail
    if (this.error) throw this.error
  }

  get liveEdgeBlock() {
    return FIRST_MEDIA_BLOCK + this.mediaBlocks - 1
  }

  _append(block) {
    if (this.error) return
    this._tail = this._tail.then(async () => {
      if (this.error) return
      try {
        await this.core.append(block)
      } catch (err) {
        this._fail(err)
      }
    })
  }

  _fail(err) {
    if (this.error) return
    this.error = err
    this.state = 'error'
  }
}
