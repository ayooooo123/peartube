import test from 'brittle'

import {
  computeForwardFillRange,
  PlaybackForwardFill,
  DEFAULT_FORWARD_FILL_CONFIG,
} from '../src/playback-forward-fill.js'
import { subscribeBlobPlayhead } from '../src/blob-range-priority.js'

const MB = 1024 * 1024

// A blob: 80,000 blocks of ~64KB = ~5GB, mapped at core block offset 1000.
const BLOCK_BYTES = 64 * 1024
const BLOCK_LENGTH = 80000
const BYTE_LENGTH = BLOCK_LENGTH * BLOCK_BYTES
const BLOCK_OFFSET = 1000

const cfg = {
  lookAheadBytes: 128 * MB,
  minAdvanceBytes: 16 * MB,
  minIntervalMs: 1000,
  maxTrackedCores: 4,
}

function eventAtBlock(windowStart) {
  return {
    coreKeyHex: 'aa'.repeat(32),
    blockOffset: BLOCK_OFFSET,
    blockLength: BLOCK_LENGTH,
    byteLength: BYTE_LENGTH,
    windowStart,
    windowEnd: windowStart + 256,
  }
}

test('computeForwardFillRange anchors a deep window ahead of the playhead', (t) => {
  const playhead = BLOCK_OFFSET + Math.floor((100 * MB) / BLOCK_BYTES)
  const range = computeForwardFillRange(eventAtBlock(playhead), cfg, null)
  t.ok(range, 'a fill range is produced')
  t.is(range.start, playhead, 'starts at the playhead')
  const lookAheadBlocks = Math.ceil((128 * MB) / BLOCK_BYTES)
  t.is(range.end, playhead + lookAheadBlocks, 'reaches the full look-ahead ahead of the playhead')
})

test('computeForwardFillRange clamps the window to the end of the blob', (t) => {
  // Playhead near the end: only a few MB remain before EOF.
  const playhead = BLOCK_OFFSET + BLOCK_LENGTH - 100
  const range = computeForwardFillRange(eventAtBlock(playhead), cfg, null)
  t.ok(range)
  t.is(range.end, BLOCK_OFFSET + BLOCK_LENGTH, 'never requests past the last block')
})

test('computeForwardFillRange skips re-anchoring until the playhead advances enough', (t) => {
  const anchor = BLOCK_OFFSET + Math.floor((100 * MB) / BLOCK_BYTES)
  // Advanced only ~4MB past the last anchor -> below the 16MB cadence threshold.
  const small = anchor + Math.floor((4 * MB) / BLOCK_BYTES)
  t.is(computeForwardFillRange(eventAtBlock(small), cfg, anchor), null, 'no churn for tiny advances')

  // Advanced ~20MB past the last anchor -> re-anchors.
  const big = anchor + Math.floor((20 * MB) / BLOCK_BYTES)
  const range = computeForwardFillRange(eventAtBlock(big), cfg, anchor)
  t.ok(range, 're-anchors once the playhead moves past the cadence threshold')
  t.is(range.start, big)
})

test('computeForwardFillRange returns null at or past EOF', (t) => {
  const event = eventAtBlock(BLOCK_OFFSET + BLOCK_LENGTH)
  t.is(computeForwardFillRange(event, cfg, null), null)
})

test('PlaybackForwardFill downloads ahead and re-anchors as the playhead advances', async (t) => {
  const cores = new Map()
  const store = {
    get(key) {
      const hex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(hex)) {
        cores.set(hex, {
          hex,
          closed: false,
          downloadCalls: [],
          destroyed: [],
          closeCount: 0,
          async ready() {},
          download(opts) {
            const range = { opts, destroy: () => { range._destroyed = true; this.destroyed.push(opts) } }
            this.downloadCalls.push(opts)
            return range
          },
          async close() { this.closeCount += 1; this.closed = true },
        })
      }
      return cores.get(hex)
    },
  }

  const fill = new PlaybackForwardFill({ store, config: cfg, log: () => {} })
  const coreKeyHex = 'aa'.repeat(32)
  const playhead = BLOCK_OFFSET + Math.floor((100 * MB) / BLOCK_BYTES)

  // First playhead event -> one deep download anchored at the playhead.
  fill.onPlayhead(eventAtBlock(playhead))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const core = cores.get(coreKeyHex)
  t.is(core.downloadCalls.length, 1, 'anchored one read-ahead window')
  t.is(core.downloadCalls[0].start, playhead, 'window starts at the playhead')
  t.is(core.downloadCalls[0].linear, true, 'fills front-to-back in play order')

  // A second event immediately after is throttled (no new download).
  fill.onPlayhead(eventAtBlock(playhead + 100))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(core.downloadCalls.length, 1, 'throttled within minIntervalMs')

  // After the throttle elapses, a large advance re-anchors and drops the stale range.
  fill.config.minIntervalMs = 0
  const advanced = playhead + Math.floor((20 * MB) / BLOCK_BYTES)
  fill.onPlayhead(eventAtBlock(advanced))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(core.downloadCalls.length, 2, 'anchored a fresh window after advancing')
  t.is(core.downloadCalls[1].start, advanced, 're-anchored at the new playhead')
  t.is(core.destroyed.length, 1, 'destroyed the stale request window')
})

test('PlaybackForwardFill bounds open core sessions to maxTrackedCores', async (t) => {
  const closed = []
  const store = {
    get(key) {
      const hex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      return {
        hex,
        closed: false,
        async ready() {},
        download(opts) { return { opts, destroy() {} } },
        async close() { closed.push(hex); this.closed = true },
      }
    },
  }

  const fill = new PlaybackForwardFill({ store, config: { ...cfg, maxTrackedCores: 2 }, log: () => {} })
  const playhead = BLOCK_OFFSET + Math.floor((100 * MB) / BLOCK_BYTES)

  for (const prefix of ['aa', 'bb', 'cc']) {
    fill.onPlayhead({ ...eventAtBlock(playhead), coreKeyHex: prefix.repeat(32) })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  t.is(fill.coreState.size, 2, 'keeps only maxTrackedCores fill sessions')
  t.ok(closed.includes('aa'.repeat(32)), 'evicted and closed the oldest core session')
})

test('PlaybackForwardFill.start subscribes to the blob playhead', (t) => {
  const store = { get() { return { async ready() {}, download() { return { destroy() {} } }, async close() {} } } }
  const fill = new PlaybackForwardFill({ store, config: cfg, log: () => {} })
  fill.start()
  t.ok(fill.unsubscribe, 'holds an unsubscribe handle')
  fill.stop()
  t.absent(fill.unsubscribe, 'cleared on stop')
})

test('default look-ahead is deep but bounded', (t) => {
  const c = DEFAULT_FORWARD_FILL_CONFIG
  t.ok(c.lookAheadBytes >= 64 * MB, 'deep enough to outpace playback bitrate')
  t.ok(c.lookAheadBytes <= 512 * MB, 'still bounded so on-disk footprint stays small')
  t.is(typeof subscribeBlobPlayhead, 'function')
})
