import test from 'brittle'

import {
  computeTrailingClearRange,
  PlaybackWindowCache,
  DEFAULT_PLAYBACK_WINDOW_CONFIG,
} from '../src/playback-window-cache.js'
import { subscribeBlobPlayhead } from '../src/blob-range-priority.js'

const MB = 1024 * 1024

// A blob: 80,000 blocks of ~64KB = ~5GB, mapped at core block offset 1000.
const BLOCK_BYTES = 64 * 1024
const BLOCK_LENGTH = 80000
const BYTE_LENGTH = BLOCK_LENGTH * BLOCK_BYTES
const BLOCK_OFFSET = 1000

const cfg = {
  headKeepBytes: 16 * MB,
  readBehindBytes: 32 * MB,
  minClearBytes: 16 * MB,
  minIntervalMs: 4000,
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

test('computeTrailingClearRange returns null near the start of playback', (t) => {
  // Playhead only a few MB in: head + seek-back buffer still covers everything.
  const headBlocks = Math.ceil((16 * MB) / BLOCK_BYTES)
  const behindBlocks = Math.ceil((32 * MB) / BLOCK_BYTES)
  const earlyWindow = BLOCK_OFFSET + headBlocks + behindBlocks - 10
  t.is(computeTrailingClearRange(eventAtBlock(earlyWindow), cfg), null)
})

test('computeTrailingClearRange clears consumed blocks behind the seek-back buffer', (t) => {
  // Playhead ~200MB into the blob.
  const playheadBlock = BLOCK_OFFSET + Math.floor((200 * MB) / BLOCK_BYTES)
  const range = computeTrailingClearRange(eventAtBlock(playheadBlock), cfg)
  t.ok(range, 'a clear range is produced')

  const headBlocks = Math.ceil((16 * MB) / BLOCK_BYTES)
  const behindBlocks = Math.ceil((32 * MB) / BLOCK_BYTES)
  t.is(range.start, BLOCK_OFFSET + headBlocks, 'starts right after the preserved head')
  t.is(range.end, playheadBlock - behindBlocks, 'ends a seek-back buffer behind the playhead')
  t.ok(range.end < playheadBlock, 'never clears at or ahead of the playhead')
})

test('computeTrailingClearRange only clears the newly-passed region', (t) => {
  const playheadBlock = BLOCK_OFFSET + Math.floor((200 * MB) / BLOCK_BYTES)
  const alreadyCleared = BLOCK_OFFSET + Math.floor((100 * MB) / BLOCK_BYTES)
  const range = computeTrailingClearRange(eventAtBlock(playheadBlock), cfg, alreadyCleared)
  t.is(range.start, alreadyCleared, 'resumes from the last cleared offset, not the head')
})

test('computeTrailingClearRange never trims a video smaller than head + buffer', (t) => {
  // Tiny blob (~8MB) fits entirely inside the preserved regions.
  const smallByteLength = 8 * MB
  const smallBlocks = Math.ceil(smallByteLength / BLOCK_BYTES)
  const event = {
    coreKeyHex: 'bb'.repeat(32),
    blockOffset: 0,
    blockLength: smallBlocks,
    byteLength: smallByteLength,
    windowStart: smallBlocks - 1,
    windowEnd: smallBlocks,
  }
  t.is(computeTrailingClearRange(event, cfg), null)
})

test('PlaybackWindowCache trims played-back blocks and throttles repeats', async (t) => {
  const cores = new Map()
  const store = {
    get(key) {
      const hex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      if (!cores.has(hex)) {
        cores.set(hex, {
          hex,
          clearCalls: [],
          closeCount: 0,
          async ready() {},
          async clear(start, end) { this.clearCalls.push({ start, end }) },
          async close() { this.closeCount += 1 },
        })
      }
      return cores.get(hex)
    },
  }

  const cache = new PlaybackWindowCache({ store, config: cfg, log: () => {} })
  const coreKeyHex = 'aa'.repeat(32)
  const playheadBlock = BLOCK_OFFSET + Math.floor((200 * MB) / BLOCK_BYTES)

  // First playhead update past the buffer -> one clear.
  cache.onPlayhead(eventAtBlock(playheadBlock))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const core = cores.get(coreKeyHex)
  t.is(core.clearCalls.length, 1, 'cleared once')
  t.ok(core.closeCount >= 1, 'released the temporary core session')
  const behindBlocks = Math.ceil((32 * MB) / BLOCK_BYTES)
  t.is(core.clearCalls[0].end, playheadBlock - behindBlocks)

  // A second update immediately after is throttled (no new clear).
  cache.onPlayhead(eventAtBlock(playheadBlock + 100))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(core.clearCalls.length, 1, 'throttled within minIntervalMs')

  // After the throttle window, advancing further clears the newly-passed region.
  cache.config.minIntervalMs = 0
  const advanced = playheadBlock + Math.floor((100 * MB) / BLOCK_BYTES)
  cache.onPlayhead(eventAtBlock(advanced))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(core.clearCalls.length, 2, 'cleared again after throttle elapsed')
  t.is(core.clearCalls[1].start, playheadBlock - behindBlocks, 'resumed from the prior cleared end')
})

test('PlaybackWindowCache.start subscribes to the blob playhead', (t) => {
  const cleared = []
  const store = {
    get() {
      return {
        async ready() {},
        async clear(start, end) { cleared.push({ start, end }) },
        async close() {},
      }
    },
  }
  const cache = new PlaybackWindowCache({ store, config: cfg, log: () => {} })
  cache.start()
  t.ok(cache.unsubscribe, 'holds an unsubscribe handle')
  cache.stop()
  t.absent(cache.unsubscribe, 'cleared on stop')
})

test('default config keeps a bounded footprint well under a typical quota', (t) => {
  const c = DEFAULT_PLAYBACK_WINDOW_CONFIG
  const footprint = c.headKeepBytes + c.readBehindBytes
  t.ok(footprint < 1024 * MB, 'retained window is far below a multi-GB quota')
  // subscribeBlobPlayhead is the wiring used by start(); just assert it exists.
  t.is(typeof subscribeBlobPlayhead, 'function')
})
