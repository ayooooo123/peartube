import test from 'brittle'
import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  prioritizeBlobServerRangeRequest,
  releaseAllPrioritizedBlobRanges,
  subscribeBlobPlayhead,
} from '../src/blob-range-priority.js'

const blobIdEncoding = {
  preencode(state, blob) {
    c.uint.preencode(state, blob.blockOffset)
    c.uint.preencode(state, blob.blockLength)
    c.uint.preencode(state, blob.byteOffset)
    c.uint.preencode(state, blob.byteLength)
  },
  encode(state, blob) {
    c.uint.encode(state, blob.blockOffset)
    c.uint.encode(state, blob.blockLength)
    c.uint.encode(state, blob.byteOffset)
    c.uint.encode(state, blob.byteLength)
  },
  decode(state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state),
    }
  },
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const apiSource = readFileSync(resolve(__dirname, '../src/api.js'), 'utf8')

function createRangeRequest({ rangeStart, rangeEnd } = {}) {
  const key = Buffer.from('c'.repeat(64), 'hex')
  const blob = {
    blockOffset: 10,
    blockLength: 100,
    byteOffset: 4096,
    byteLength: 100 * 65536,
  }
  const encodedBlob = z32.encode(c.encode(blobIdEncoding, blob))
  const req = {
    method: 'GET',
    url: `/?key=${HypercoreID.encode(key)}&blob=${encodedBlob}&type=video%2Fmp4&token=test-token`,
    headers: { range: `bytes=${rangeStart}-${rangeEnd}` },
  }
  return { key, blob, req }
}

function createMockBlobServer() {
  return {
    token: 'test-token',
    async _getCore() {
      return {
        closed: false,
        download: (options) => ({
          done: () => new Promise(() => {}),
          destroy: () => {},
          _options: options,
        }),
        close() {},
      }
    },
  }
}

test('new prioritized windows are published to playhead subscribers (seek refocus hook)', async (t) => {
  releaseAllPrioritizedBlobRanges()
  const events = []
  const unsubscribe = subscribeBlobPlayhead((event) => events.push(event))

  const blobServer = createMockBlobServer()
  const first = createRangeRequest({ rangeStart: 4 * 65536, rangeEnd: (5 * 65536) - 1 })
  await prioritizeBlobServerRangeRequest(blobServer, first.req, { readAheadBytes: 0 })

  t.is(events.length, 1, 'creating a prioritized window emits one playhead event')
  t.is(events[0].coreKeyHex, 'c'.repeat(64))
  t.is(events[0].windowStart, 14)
  t.is(events[0].windowEnd, 15)

  // A request inside the fresh window reuses the in-flight download — the
  // playhead has not meaningfully moved, so no event should fire (otherwise
  // the background fill would churn its range on every contiguous read).
  await prioritizeBlobServerRangeRequest(blobServer, first.req, { readAheadBytes: 0 })
  t.is(events.length, 1, 'reused windows do not re-emit')

  // A far seek creates a new window and must notify subscribers so the
  // background full-file fill can re-anchor past it instead of competing for
  // peer bandwidth from the front of the file.
  const second = createRangeRequest({ rangeStart: 90 * 65536, rangeEnd: (91 * 65536) - 1 })
  await prioritizeBlobServerRangeRequest(blobServer, second.req, { readAheadBytes: 0 })
  t.is(events.length, 2, 'a seek emits a new playhead event')
  t.is(events[1].windowStart, 100)

  unsubscribe()
  releaseAllPrioritizedBlobRanges()
})

test('prefetch range completion handlers reject hypercore cancellation resolutions', (t) => {
  // hypercore v11 resolves range.done() with `false` (instead of rejecting)
  // when a range is destroyed or its session closes. Every done() handler in
  // the prefetch path must check the resolved value: treating cancellation as
  // completion marked partially downloaded videos "Saved on this device",
  // deleted their resume intent, registered full-size seeds against the cache
  // quota, and resurrected zombie full-file downloads from cancelled head
  // prefetches.
  const handlers = apiSource.match(/\.done\(\)\.then\(\((completed)\)/g) || []
  t.ok(handlers.length >= 4, `all prefetch done() handlers receive the resolved value (found ${handlers.length}, expected fill+head+tail+mid)`)

  const unguarded = apiSource.match(/\.done\(\)\.then\(\(\)\s*=>/g) || []
  t.is(unguarded.length, 0, 'no prefetch done() handler ignores the resolved value')

  t.ok(/completed === false \|\| fillCancelled \|\| currentFillRange !== fillRange/.test(apiSource),
    'the full-download completion path guards against cancelled and re-anchored ranges')

  t.ok(/const unsubscribePlayhead = subscribeBlobPlayhead/.test(apiSource),
    'the background fill subscribes to playhead events so seeks re-anchor it past the prioritized window')
})
