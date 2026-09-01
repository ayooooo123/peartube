/**
 * PlaybackWindowCache - bounded on-disk cache for the actively-playing video.
 *
 * Streaming playback fetches each byte range from peers as the player reads
 * through the file, and those blocks stay written in the blob core. Watching a
 * very large video front-to-back would therefore cache the whole file on disk,
 * regardless of the seed-storage quota (which only acts between watches).
 *
 * This follows the blob-server playhead and clears blocks the player has
 * already passed — keeping a bounded seek-back buffer behind the playhead and
 * the read-ahead window ahead of it — so any single video has a bounded
 * footprint while it plays. It only ever clears blocks strictly *behind* the
 * playhead (minus the buffer) and never touches the preserved container head,
 * so forward playback and short seek-backs are never disrupted. A far seek-back
 * past the buffer simply re-fetches, which is the intended trade-off.
 */

import { subscribeBlobPlayhead } from './blob-range-priority.js'

const MB = 1024 * 1024

export const DEFAULT_PLAYBACK_WINDOW_CONFIG = {
  // Keep the container head (init segment / faststart moov + first GOPs) so the
  // demuxer can re-init and short seeks to the start stay instant.
  headKeepBytes: 16 * MB,
  // Seek-back buffer: how much already-played video to retain behind the
  // playhead so short rewinds don't re-buffer.
  readBehindBytes: 32 * MB,
  // Don't bother clearing until at least this much has accumulated behind the
  // buffer — batches clears so we aren't opening a core session per request.
  minClearBytes: 16 * MB,
  // Per-core throttle: at most one clear pass this often.
  minIntervalMs: 4000,
}

/**
 * Pure range math: given a playhead event and the retention config, return the
 * absolute core block range [start, end) that is safe to clear behind the
 * playhead, or null if there is nothing worth clearing yet.
 *
 * @param {{ blockOffset: number, blockLength: number, byteLength: number, windowStart: number }} event
 * @param {{ headKeepBytes: number, readBehindBytes: number, minClearBytes: number }} config
 * @param {number} [alreadyClearedEnd] - exclusive end of the last cleared range for this core
 * @returns {{ start: number, end: number, bytesPerBlock: number } | null}
 */
export function computeTrailingClearRange(event, config, alreadyClearedEnd = 0) {
  const blockOffset = Number(event?.blockOffset)
  const blockLength = Number(event?.blockLength)
  const byteLength = Number(event?.byteLength)
  const windowStart = Number(event?.windowStart)

  if (!Number.isInteger(blockOffset) || blockOffset < 0) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!Number.isFinite(byteLength) || byteLength <= 0) return null
  if (!Number.isInteger(windowStart) || windowStart < blockOffset) return null

  const bytesPerBlock = Math.max(1, byteLength / blockLength)
  const headKeepBlocks = Math.ceil(Math.max(0, config.headKeepBytes) / bytesPerBlock)
  const readBehindBlocks = Math.ceil(Math.max(0, config.readBehindBytes) / bytesPerBlock)

  // Never clear at or ahead of the playhead, nor inside the seek-back buffer.
  const clearEnd = windowStart - readBehindBlocks
  // Preserve the head, and only clear the part not already cleared.
  const clearStart = Math.max(blockOffset + headKeepBlocks, Math.max(0, alreadyClearedEnd))

  if (clearEnd <= clearStart) return null
  if ((clearEnd - clearStart) * bytesPerBlock < Math.max(0, config.minClearBytes)) return null

  return { start: clearStart, end: clearEnd, bytesPerBlock }
}

export class PlaybackWindowCache {
  /**
   * @param {{ store: import('corestore'), enabled?: boolean, config?: Partial<typeof DEFAULT_PLAYBACK_WINDOW_CONFIG>, log?: (...args: any[]) => void }} options
   */
  constructor({ store, enabled = true, config = {}, log = console.log } = {}) {
    this.store = store
    this.enabled = enabled !== false
    this.config = { ...DEFAULT_PLAYBACK_WINDOW_CONFIG, ...config }
    this.log = typeof log === 'function' ? log : () => {}
    /** @type {Map<string, { lastClearedEnd: number, lastClearAt: number, clearing: boolean }>} */
    this.coreState = new Map()
    this.unsubscribe = null
  }

  start() {
    if (!this.enabled || this.unsubscribe) return
    this.unsubscribe = subscribeBlobPlayhead((event) => this.onPlayhead(event))
  }

  stop() {
    try { this.unsubscribe?.() } catch { /* best effort */ }
    this.unsubscribe = null
    this.coreState.clear()
  }

  onPlayhead(event) {
    if (!this.enabled || !this.store || !event?.coreKeyHex) return
    const state = this.coreState.get(event.coreKeyHex) || { lastClearedEnd: 0, lastClearAt: 0, clearing: false }

    const now = Date.now()
    if (state.clearing) return
    if (now - state.lastClearAt < this.config.minIntervalMs) return

    const range = computeTrailingClearRange(event, this.config, state.lastClearedEnd)
    if (!range) return

    state.clearing = true
    state.lastClearAt = now
    this.coreState.set(event.coreKeyHex, state)

    // Fire-and-forget: clearing must never block or throw into the serving path.
    this.clearRange(event.coreKeyHex, range.start, range.end)
      .then((cleared) => { if (cleared) state.lastClearedEnd = range.end })
      .catch((err) => this.log('[PlaybackWindowCache] clear failed:', err?.message))
      .finally(() => { state.clearing = false })
  }

  async clearRange(coreKeyHex, start, end) {
    // S3-backed cores have their own confirm-before-delete residency sweep.
    // Hypercore.clear() also removes Merkle proof nodes at range boundaries;
    // once the block data lives only in S3, losing one of those leaf hashes
    // makes its content-addressed object impossible to restore.
    if (!this.enabled) return false
    let core = null
    try {
      core = this.store.get(Buffer.from(coreKeyHex, 'hex'))
      await core.ready?.()
      if (typeof core.clear !== 'function') return false
      await core.clear(start, end)
      this.log('[PlaybackWindowCache] trimmed played-back blocks:', coreKeyHex.slice(0, 16), start, end)
      return true
    } finally {
      // store.get() opened a fresh session; release it so trimming does not
      // accumulate open core sessions.
      try { await core?.close?.() } catch { /* best effort */ }
    }
  }
}

export function createPlaybackWindowCache(options) {
  return new PlaybackWindowCache(options)
}
