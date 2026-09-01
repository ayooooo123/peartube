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
  let firstBlockReadPending = true

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
      if (index === 0 && firstBlockReadPending) {
        firstBlockReadPending = false
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
  t.absent(calls.some((call) => call[0] === 'download'), 'restorable local data does not enter peer download')
})

test('serveVideoRangeHttpRequest maps canonical offloaded assets without Hypercore seek', async (t) => {
  t.teardown(() => releaseAllPrioritizedBlobRanges())
  const calls = []
  const blockSize = 256 * 1024
  const blob = {
    blockOffset: 0,
    blockLength: 2,
    byteOffset: 0,
    byteLength: 2 * blockSize,
  }
  const { req } = makeRangeRequest({
    blob,
    range: `bytes=${blockSize + 2}-${blockSize + 5}`,
  })
  const core = {
    peers: [],
    opened: true,
    async ready() {},
    async seek() {
      calls.push(['seek'])
      throw new Error('offloaded tree cannot seek without a peer')
    },
    async get(index, options = {}) {
      calls.push(['get', index, options])
      return Buffer.alloc(blockSize, index === 0 ? 65 : 66)
    },
    download(options) {
      calls.push(['download', options])
      return { done: () => Promise.resolve(), destroy: () => {} }
    },
    close() {},
  }
  const blobServer = {
    token: 'test-token',
    async _getCore() { return core },
  }
  const res = new MockResponse(calls)

  const handled = await serveVideoRangeHttpRequest({ blobServer }, req, res)

  t.is(handled, true)
  t.alike(calls.filter((call) => call[0] === 'write'), [['write', 'BBBB']])
  t.absent(calls.some((call) => call[0] === 'seek'), 'canonical byte range does not need missing inner tree nodes')
  t.absent(calls.some((call) => call[0] === 'download'), 'restorable canonical block does not wait for a peer')
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
    async get(index, options = {}) {
      calls.push(['get', index, options])
      if (options.wait === false) return null
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

function staticRangeHarness({ range = 'bytes=2-5', method = 'GET', result = null } = {}) {
  const { key, blob, req } = makeRangeRequest({ range })
  const assetId = key.toString('hex')
  req.method = method
  req.url += `&pt_static_asset=${assetId}`
  const calls = []
  const scheduler = {
    seek(request) { calls.push(['seek', request]) },
    async requestRange(request) {
      calls.push(['requestRange', request])
      return result || {
        status: 'ok',
        bytes: Buffer.from('cdef'),
        verified: true,
        peerIds: ['peer-a'],
        originAttempted: false,
      }
    },
  }
  const blobServer = {
    token: 'test-token',
    _getCore() { calls.push(['fallback']); return null },
  }
  const staticAssetEntries = new Map([[
    assetId,
    {
      scheduler,
      mimeType: 'video/mp4',
      coreRef: {
        assetId,
        key: assetId,
        blockSize: 4,
        length: 2,
        byteLength: blob.byteLength,
      },
    },
  ]])
  return { calls, req, scheduler, blobServer, staticAssetEntries }
}

test('marked static range returns exact verified 206 bytes and never opens generic blob replication', async (t) => {
  const harness = staticRangeHarness()
  const res = new MockResponse(harness.calls)

  const handled = await serveVideoRangeHttpRequest({
    blobServer: harness.blobServer,
    staticAssetEntries: harness.staticAssetEntries,
  }, harness.req, res)

  t.is(handled, true)
  t.is(res.statusCode, 206)
  t.is(res.headers['accept-ranges'], 'bytes')
  t.is(res.headers['content-range'], 'bytes 2-5/8')
  t.is(res.headers['content-length'], '4')
  t.alike(harness.calls.filter(call => call[0] === 'write'), [['write', 'cdef']])
  const request = harness.calls.find(call => call[0] === 'requestRange')[1]
  t.is(request.byteStart, 2)
  t.is(request.byteEnd, 6, 'inclusive HTTP end is mapped to an exclusive scheduler end')
  t.absent(harness.calls.find(call => call[0] === 'fallback'))
})

test('marked static HEAD writes range headers without scheduling data', async (t) => {
  const harness = staticRangeHarness({ method: 'HEAD' })
  const res = new MockResponse(harness.calls)

  const handled = await serveVideoRangeHttpRequest({
    blobServer: harness.blobServer,
    staticAssetEntries: harness.staticAssetEntries,
  }, harness.req, res)

  t.is(handled, true)
  t.is(res.statusCode, 206)
  t.is(res.headers['content-range'], 'bytes 2-5/8')
  t.absent(harness.calls.find(call => call[0] === 'requestRange'))
  t.absent(harness.calls.find(call => call[0] === 'fallback'))
})

test('marked static invalid, multiple, and out-of-bounds ranges are terminal 416 responses', async (t) => {
  for (const range of [undefined, 'bytes=0-1,4-5', 'bytes=8-9', 'bytes=0-8']) {
    const harness = staticRangeHarness({ range: range ?? '' })
    if (range === undefined) delete harness.req.headers.range
    const res = new MockResponse(harness.calls)
    const handled = await serveVideoRangeHttpRequest({
      blobServer: harness.blobServer,
      staticAssetEntries: harness.staticAssetEntries,
    }, harness.req, res)
    t.is(handled, true, String(range))
    t.is(res.statusCode, 416, String(range))
    t.is(res.headers['content-range'], 'bytes */8', String(range))
    t.absent(harness.calls.find(call => call[0] === 'requestRange'), String(range))
    t.absent(harness.calls.find(call => call[0] === 'fallback'), String(range))
  }
})

test('marked static source exhaustion is bounded 503 and client close aborts without late bytes', async (t) => {
  const exhausted = staticRangeHarness({
    result: { status: 'unavailable', errorCode: 'NO_VERIFIED_SOURCE', originAttempted: false },
  })
  const exhaustedRes = new MockResponse(exhausted.calls)
  t.is(await serveVideoRangeHttpRequest({
    blobServer: exhausted.blobServer,
    staticAssetEntries: exhausted.staticAssetEntries,
  }, exhausted.req, exhaustedRes), true)
  t.is(exhaustedRes.statusCode, 503)
  t.ok(exhaustedRes.headers['content-length'] < 128)
  t.absent(exhausted.calls.find(call => call[0] === 'fallback'))

  const disconnected = staticRangeHarness()
  let aborted = 0
  disconnected.scheduler.requestRange = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted++
      const error = new Error('client closed')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const disconnectedRes = new MockResponse(disconnected.calls)
  const pending = serveVideoRangeHttpRequest({
    blobServer: disconnected.blobServer,
    staticAssetEntries: disconnected.staticAssetEntries,
  }, disconnected.req, disconnectedRes)
  await new Promise(resolve => setTimeout(resolve, 0))
  disconnectedRes.emit('close')
  t.is(await pending, true)
  t.is(aborted, 1)
  t.absent(disconnected.calls.find(call => call[0] === 'write'))
  t.absent(disconnected.calls.find(call => call[0] === 'fallback'))
})

test('marked static backpressure waits for drain and client close wakes without late end', async (t) => {
  const harness = staticRangeHarness()
  let schedulerSignal = null
  harness.scheduler.requestRange = async ({ signal }) => {
    schedulerSignal = signal
    return {
      status: 'ok',
      bytes: Buffer.alloc(64 * 1024 * 1024, 1),
      verified: true,
      peerIds: ['peer-a'],
      originAttempted: false,
    }
  }
  harness.req.headers.range = `bytes=0-${64 * 1024 * 1024 - 1}`
  const assetId = [...harness.staticAssetEntries.keys()][0]
  harness.staticAssetEntries.get(assetId).coreRef.byteLength = 64 * 1024 * 1024
  harness.staticAssetEntries.get(assetId).coreRef.blockSize = 32 * 1024 * 1024
  const requestUrl = new URL(harness.req.url, 'http://127.0.0.1')
  requestUrl.searchParams.set('blob', z32.encode(c.encode(blobIdEncoding, {
    blockOffset: 0,
    blockLength: 2,
    byteOffset: 0,
    byteLength: 64 * 1024 * 1024,
  })))
  harness.req.url = `${requestUrl.pathname}${requestUrl.search}`
  const res = new MockResponse(harness.calls)
  res.write = chunk => {
    harness.calls.push(['write', chunk.byteLength])
    return false
  }

  let settled = false
  const pending = serveVideoRangeHttpRequest({
    blobServer: harness.blobServer,
    staticAssetEntries: harness.staticAssetEntries,
  }, harness.req, res).then(value => {
    settled = true
    return value
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(settled, false, 'false res.write must hold the materialized response until drain or close')
  res.emit('close')
  const outcome = await Promise.race([
    pending,
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
  ])

  t.is(outcome, true)
  t.is(schedulerSignal.aborted, true)
  t.alike(harness.calls.filter(call => call[0] === 'write'), [['write', 64 * 1024 * 1024]])
  t.absent(harness.calls.find(call => call[0] === 'end'))
  t.absent(harness.calls.find(call => call[0] === 'fallback'))
})

test('marked static backpressure resumes exactly once on drain', async (t) => {
  const harness = staticRangeHarness()
  const res = new MockResponse(harness.calls)
  res.write = chunk => {
    harness.calls.push(['write', Buffer.from(chunk).toString('utf8')])
    return false
  }
  const pending = serveVideoRangeHttpRequest({
    blobServer: harness.blobServer,
    staticAssetEntries: harness.staticAssetEntries,
  }, harness.req, res)
  await new Promise(resolve => setTimeout(resolve, 0))
  t.absent(harness.calls.find(call => call[0] === 'end'))
  res.emit('drain')

  t.is(await pending, true)
  t.is(harness.calls.filter(call => call[0] === 'end').length, 1)
  t.absent(harness.calls.find(call => call[0] === 'fallback'))
})
