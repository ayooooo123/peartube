import test from 'brittle'
import { EventEmitter } from 'node:events'
import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'

import { serveVideoRangeHttpRequest } from '../src/video-range-http.js'
import { releaseAllPrioritizedBlobRanges, subscribeBlobPlayhead } from '../src/blob-range-priority.js'

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

class MockResponse extends EventEmitter {
  constructor(calls) {
    super()
    this.calls = calls
    this.headers = {}
    this.statusCode = 0
    this.headersSent = false
    this.writableEnded = false
    this.destroyed = false
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = String(value)
  }

  writeHead(statusCode) {
    this.statusCode = statusCode
    this.headersSent = true
    this.calls.push(['writeHead', statusCode, { ...this.headers }])
  }

  write(chunk) {
    this.calls.push(['write', Buffer.from(chunk).toString('utf8')])
    return true
  }

  end(chunk) {
    if (chunk) this.write(chunk)
    this.writableEnded = true
    this.calls.push(['end'])
  }

  destroy() {
    this.destroyed = true
    this.calls.push(['destroy'])
  }
}

function makeRangeRequest({ range = 'bytes=2-5', type = 'video/mp4', blob: overrideBlob = null } = {}) {
  const key = Buffer.from('d'.repeat(64), 'hex')
  const blob = overrideBlob || {
    blockOffset: 0,
    blockLength: 2,
    byteOffset: 0,
    byteLength: 8,
  }
  const encodedBlob = z32.encode(c.encode(blobIdEncoding, blob))
  return {
    key,
    blob,
    req: {
      method: 'GET',
      url: `/?key=${HypercoreID.encode(key)}&blob=${encodedBlob}&type=${encodeURIComponent(type)}&token=test-token`,
      headers: { range },
    },
  }
}

test('serveVideoRangeHttpRequest writes 206 headers before waiting for Hypercore data', async (t) => {
  t.teardown(() => releaseAllPrioritizedBlobRanges())
  const calls = []
  const { key, req } = makeRangeRequest()
  let resolveFirstBlock = null

  const core = {
    opened: true,
    async ready() {
      calls.push(['ready'])
    },
    async seek(byteOffset) {
      calls.push(['seek', byteOffset])
      return [0, byteOffset]
    },
    async get(index) {
      calls.push(['get', index])
      if (index === 0) {
        await new Promise((resolve) => {
          resolveFirstBlock = resolve
        })
      }
      return Buffer.from(index === 0 ? 'abcd' : 'efgh')
    },
    download(options) {
      calls.push(['download', options])
      return {
        done: () => Promise.resolve(),
        destroy: () => calls.push(['destroyDownload']),
      }
    },
    close() {
      calls.push(['close'])
    },
  }
  const blobServer = {
    token: 'test-token',
    async _getCore(requestKey, _info, active) {
      calls.push(['_getCore', requestKey.toString('hex'), active])
      return core
    },
  }
  const res = new MockResponse(calls)

  const pending = serveVideoRangeHttpRequest({ blobServer }, req, res)
  await new Promise((resolve) => setImmediate(resolve))

  t.is(res.headersSent, true, 'headers are sent before the first block resolves')
  t.alike(calls.find((call) => call[0] === 'writeHead'), ['writeHead', 206, {
    'accept-ranges': 'bytes',
    'content-type': 'video/mp4',
    'content-range': 'bytes 2-5/8',
    'content-length': '4',
    'cache-control': 'no-store',
  }])
  t.ok(
    calls.findIndex((call) => call[0] === 'writeHead') < calls.findIndex((call) => call[0] === 'get'),
    'response headers are written before core.get() can block',
  )

  resolveFirstBlock()
  const handled = await pending

  t.is(handled, true)
  t.alike(calls.filter((call) => call[0] === 'write'), [['write', 'cd'], ['write', 'ef']])
  t.ok(res.writableEnded, 'response ends after the requested range is written')
  t.ok(calls.some((call) => call[0] === '_getCore' && call[1] === key.toString('hex') && call[2] === true))
})

test('serveVideoRangeHttpRequest syncs remote length near the requested seek range', async (t) => {
  t.teardown(() => releaseAllPrioritizedBlobRanges())
  const calls = []
  const byteStart = 90 * 65536
  const blob = {
    blockOffset: 10,
    blockLength: 100,
    byteOffset: 4096,
    byteLength: 100 * 65536,
  }
  const { req } = makeRangeRequest({
    blob,
    range: `bytes=${byteStart}-${byteStart + 3}`,
  })
  const core = {
    peers: [],
    opened: true,
    async ready() {
      calls.push(['ready'])
    },
    async has(index) {
      calls.push(['has', index])
      return false
    },
    update() {
      calls.push(['update'])
      return Promise.resolve()
    },
    async seek(byteOffset) {
      calls.push(['seek', byteOffset])
      return [100, 0]
    },
    async get(index) {
      calls.push(['get', index])
      return Buffer.from('wxyz')
    },
    download(options) {
      calls.push(['download', options])
      return {
        done: () => Promise.resolve(),
        destroy: () => calls.push(['destroyDownload']),
      }
    },
    close() {
      calls.push(['close'])
    },
  }
  const blobServer = {
    token: 'test-token',
    async _getCore() {
      calls.push(['_getCore'])
      return core
    },
  }

  const handled = await serveVideoRangeHttpRequest({ blobServer }, req, new MockResponse(calls))

  t.is(handled, true)
  t.alike(
    calls.find((call) => call[0] === 'has'),
    ['has', 100],
    'remote sync should check the seek target block, not the first block in the blob',
  )
})

test('serveVideoRangeHttpRequest advances the playhead while streaming one open-ended response', async (t) => {
  t.teardown(() => releaseAllPrioritizedBlobRanges())
  const MB = 1024 * 1024
  // 8 blocks of 2MB each = 16MB. One open-ended `bytes=0-` request streams the
  // whole blob through a single response, so the only re-anchor signal the
  // forward-fill/window-cache get after the opening request is the progress
  // emit (every 4MB) from inside writeBlobRange.
  const blob = {
    blockOffset: 0,
    blockLength: 8,
    byteOffset: 0,
    byteLength: 8 * 2 * MB,
  }
  const { key, req } = makeRangeRequest({ blob, range: 'bytes=0-' })

  const events = []
  const unsubscribe = subscribeBlobPlayhead((event) => {
    if (event.coreKeyHex === key.toString('hex')) events.push(event)
  })
  t.teardown(unsubscribe)

  const core = {
    peers: [],
    opened: true,
    async ready() {},
    async has() { return true },
    async seek() { return [0, 0] },
    async get() { return Buffer.alloc(2 * MB, 1) },
    download() {
      return { done: () => Promise.resolve(), destroy: () => {} }
    },
    close() {},
  }
  const blobServer = {
    token: 'test-token',
    async _getCore() { return core },
  }
  // Discard streamed bytes so the test does not retain 16MB of chunk strings.
  const res = new MockResponse([])

  const handled = await serveVideoRangeHttpRequest({ blobServer }, req, res)
  t.is(handled, true)

  // Initial emit from prioritizeBlobServerRangeRequest anchors at block 0; the
  // streaming progress emits then advance through the blob (blocks 2, 4, 6).
  const windowStarts = events.map((event) => event.windowStart)
  t.ok(windowStarts.includes(0), 'opening request anchors the playhead at the start')
  t.alike(
    windowStarts.filter((start) => start > 0),
    [2, 4, 6],
    'streaming the single response advances the playhead every 4MB',
  )
})

test('serveVideoRangeHttpRequest ignores non-video range requests', async (t) => {
  const calls = []
  const { req } = makeRangeRequest({ type: 'image/jpeg' })
  const handled = await serveVideoRangeHttpRequest({
    blobServer: {
      token: 'test-token',
      async _getCore() {
        calls.push(['_getCore'])
      },
    },
  }, req, new MockResponse(calls))

  t.is(handled, false)
  t.alike(calls, [])
})
