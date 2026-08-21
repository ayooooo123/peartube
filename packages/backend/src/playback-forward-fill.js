/**
 * PlaybackForwardFill - keep a deep read-ahead window downloading ahead of the
 * actively-playing video's playhead.
 *
 * Streaming playback resolves a blob-server URL and the server fetches byte
 * ranges from peers as the player requests them. The per-request priority
 * window (blob-range-priority.js) only reaches ~16MB ahead and is re-armed per
 * HTTP range request, so once the player's own buffer is full it stops asking
 * and the download collapses to the video's consumption bitrate — even when the
 * connected peer(s) could deliver many times faster. That leaves no cushion, so
 * any network jitter rebuffers.
 *
 * This is the symmetric counterpart to PlaybackWindowCache: both follow the
 * blob-server playhead (subscribeBlobPlayhead). The cache trims blocks *behind*
 * the playhead; this fill downloads a large bounded window *ahead* of it,
 * continuously re-anchoring as the playhead advances. Together they bound the
 * on-disk footprint of a single watch (head + read-behind + this read-ahead)
 * while keeping a deep, rebuffer-resistant buffer in front of the player.
 *
 * Downloads use `linear: true` so the window fills front-to-back (play order):
 * the contiguous bytes the player is about to read land first. hypercore never
 * re-requests blocks that are already local, so re-anchoring the window as the
 * playhead moves only fetches the new holes ahead.
 */

import { subscribeBlobPlayhead } from './blob-range-priority.js'

const MB = 1024 * 1024

export const DEFAULT_FORWARD_FILL_CONFIG = {
  // How far ahead of the playhead to keep downloading. The per-request priority
  // window is only ~16MB; this is the deep cushion that lets a fast peer build
  // a real buffer instead of the download settling at playback bitrate.
  lookAheadBytes: 128 * MB,
  // Don't re-anchor the window on every playhead tick — only once the playhead
  // has advanced this far past the last anchor. Bounds how often we tear down
  // and recreate download ranges.
  minAdvanceBytes: 16 * MB,
  // Per-core throttle: at most one re-anchor this often.
  minIntervalMs: 1000,
  // Bound how many blob cores we keep a fill session open for at once.
  maxTrackedCores: 4,
  // Static prefetch shares the scheduler's 64 MiB global transfer budget.
  maxStaticFillBytes: 64 * MB,
  staticDeadlineMs: 15_000,
}

/**
 * Pure range math: given a playhead event and the retention config, return the
 * absolute core block range [start, end) to keep downloading ahead of the
 * playhead, or null if there is nothing new worth anchoring yet.
 *
 * @param {{ blockOffset: number, blockLength: number, byteLength: number, windowStart: number }} event
 * @param {{ lookAheadBytes: number, minAdvanceBytes: number }} config
 * @param {number|null} [lastAnchorBlock] - the block we last anchored the fill at, or null
 * @returns {{ start: number, end: number, bytesPerBlock: number } | null}
 */
export function computeForwardFillRange(event, config, lastAnchorBlock = null) {
  const blockOffset = Number(event?.blockOffset)
  const blockLength = Number(event?.blockLength)
  const byteLength = Number(event?.byteLength)
  const windowStart = Number(event?.windowStart)

  if (!Number.isInteger(blockOffset) || blockOffset < 0) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!Number.isFinite(byteLength) || byteLength <= 0) return null
  if (!Number.isInteger(windowStart) || windowStart < blockOffset) return null

  const blobEndBlock = blockOffset + blockLength
  if (windowStart >= blobEndBlock) return null

  const bytesPerBlock = Math.max(1, byteLength / blockLength)
  const lookAheadBlocks = Math.max(1, Math.ceil(Math.max(0, config.lookAheadBytes) / bytesPerBlock))
  const minAdvanceBlocks = Math.max(1, Math.ceil(Math.max(0, config.minAdvanceBytes) / bytesPerBlock))

  const start = windowStart
  const end = Math.min(blobEndBlock, start + lookAheadBlocks)
  if (end <= start) return null

  // Skip churn: if the playhead has not advanced past the cadence threshold
  // since the last anchor, the existing range still covers the cushion.
  if (lastAnchorBlock != null && start - lastAnchorBlock < minAdvanceBlocks) {
    // ...unless the window has already reached the end of the blob, in which
    // case there is nothing left to extend regardless.
    return null
  }

  return { start, end, bytesPerBlock }
}

export class PlaybackForwardFill {
  /**
   * @param {{ store: import('corestore'), staticAssetEntries?: Map<string, any>, config?: Partial<typeof DEFAULT_FORWARD_FILL_CONFIG>, log?: (...args: any[]) => void }} options
   */
  constructor({ store, staticAssetEntries = new Map(), config = {}, log = console.log } = {}) {
    this.store = store
    this.staticAssetEntries = staticAssetEntries
    this.config = { ...DEFAULT_FORWARD_FILL_CONFIG, ...config }
    this.log = typeof log === 'function' ? log : () => {}
    /** @type {Map<string, { core: any, range: any, anchorBlock: number, lastFillAt: number, opening: boolean }>} */
    this.coreState = new Map()
    this.unsubscribe = null
    this.stopped = false
    this.generation = 0
  }

  start() {
    if (this.unsubscribe) return
    this.stopped = false
    this.generation += 1
    this.unsubscribe = subscribeBlobPlayhead((event) => this.onPlayhead(event))
  }

  async stop() {
    this.stopped = true
    this.generation += 1
    try { this.unsubscribe?.() } catch { /* best effort */ }
    this.unsubscribe = null
    const closing = Array.from(this.coreState.values(), (state) => this._releaseState(state))
    this.coreState.clear()
    await Promise.all(closing)
  }

  onPlayhead(event) {
    if (this.stopped || !event?.coreKeyHex) return
    const isStatic = typeof event.staticAssetId === 'string'
    if (!isStatic && !this.store) return
    const state = this.coreState.get(event.coreKeyHex) || null

    const now = Date.now()
    if (!isStatic && state?.opening) return
    if (state && now - state.lastFillAt < this.config.minIntervalMs) return

    const range = computeForwardFillRange(event, this.config, state ? state.anchorBlock : null)
    if (!range) return

    if (isStatic) {
      const entry = this.staticAssetEntries.get(event.staticAssetId)
      if (!entry || entry.coreRef?.assetId !== event.staticAssetId || typeof entry.scheduler?.requestRange !== 'function') return
      this.anchorStaticFill(event.coreKeyHex, entry, range.start, range.end)
        .catch((err) => this.log('[PlaybackForwardFill] static fill failed:', err?.errorCode || err?.message))
      return
    }

    // Fire-and-forget: filling must never block or throw into the serving path.
    this.anchorFill(event.coreKeyHex, range.start, range.end)
      .catch((err) => this.log('[PlaybackForwardFill] fill failed:', err?.message))
  }

  async anchorStaticFill(coreKeyHex, entry, start, end) {
    if (this.stopped) return
    let state = this.coreState.get(coreKeyHex)
    if (!state) {
      state = { core: null, range: null, controller: null, anchorBlock: -1, lastFillAt: 0, opening: false, released: false }
      this.coreState.set(coreKeyHex, state)
    }
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    state.anchorBlock = start
    state.lastFillAt = Date.now()
    state.released = false
    this._enforceTrackedLimit(coreKeyHex)

    const byteStart = start * entry.coreRef.blockSize
    const requestedEnd = Math.min(entry.coreRef.byteLength, end * entry.coreRef.blockSize)
    const byteEnd = Math.min(requestedEnd, byteStart + this.config.maxStaticFillBytes)
    entry.scheduler.seek({ byteStart })
    const result = await entry.scheduler.requestRange({
      assetId: entry.coreRef.assetId,
      byteStart,
      byteEnd,
      deadlineMs: this.config.staticDeadlineMs,
      priority: 'prefetch',
      materialize: false,
      signal: controller.signal,
    })
    if (result?.status !== 'ok') {
      const error = new Error(result?.errorCode || 'static forward fill unavailable')
      error.errorCode = result?.errorCode || 'NO_VERIFIED_SOURCE'
      throw error
    }
    if (state.controller === controller) state.controller = null
  }

  async anchorFill(coreKeyHex, start, end) {
    if (this.stopped) return
    const generation = this.generation
    let state = this.coreState.get(coreKeyHex)
    if (!state) {
      state = { core: null, range: null, anchorBlock: -1, lastFillAt: 0, opening: true, released: false }
      this.coreState.set(coreKeyHex, state)
    } else {
      state.opening = true
      state.released = false
    }
    state.lastFillAt = Date.now()

    try {
      if (!state.core || state.core.closed === true) {
        const core = this.store.get(Buffer.from(coreKeyHex, 'hex'))
        state.core = core
        await core.ready?.()
        if (
          this.stopped ||
          generation !== this.generation ||
          state.released ||
          this.coreState.get(coreKeyHex) !== state ||
          state.core !== core
        ) {
          if (state.core === core) {
            state.core = null
            try { await core.close?.() } catch { /* best effort */ }
          }
          return
        }
      }
      if (typeof state.core.download !== 'function') return

      // Drop the previous, shallower range before anchoring the new one so peer
      // bandwidth refocuses on the bytes ahead of the current playhead. Blocks
      // already downloaded by it stay local (hypercore keeps them), so this only
      // moves the *request* window forward, it does not discard data.
      if (state.range) {
        try { state.range.destroy?.() } catch { /* best effort */ }
        state.range = null
      }

      state.range = state.core.download({ start, end, linear: true })
      state.anchorBlock = start
      try {
        this.log('[PlaybackForwardFill] read-ahead:', coreKeyHex.slice(0, 16), `blocks ${start}-${end} (${end - start})`)
      } catch { /* diagnostics only */ }

      // Keep the open-session pool bounded (Map preserves insertion order = LRU).
      this._enforceTrackedLimit(coreKeyHex)
    } finally {
      const current = this.coreState.get(coreKeyHex)
      if (current) current.opening = false
    }
  }

  _enforceTrackedLimit(keepKey) {
    while (this.coreState.size > this.config.maxTrackedCores) {
      const oldestKey = this.coreState.keys().next().value
      if (oldestKey === keepKey || oldestKey == null) break
      const oldest = this.coreState.get(oldestKey)
      this.coreState.delete(oldestKey)
      void this._releaseState(oldest)
    }
  }

  _releaseState(state) {
    if (!state) return Promise.resolve()
    state.released = true
    state.controller?.abort()
    state.controller = null
    if (state.range) {
      try { state.range.destroy?.() } catch { /* best effort */ }
      state.range = null
    }
    const core = state.core
    state.core = null
    if (!core) return Promise.resolve()
    try {
      return Promise.resolve(core.close?.()).catch(() => {})
    } catch {
      return Promise.resolve()
    }
  }
}

export function createPlaybackForwardFill(options) {
  return new PlaybackForwardFill(options)
}
