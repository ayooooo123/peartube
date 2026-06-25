import test from 'brittle'
import { EventEmitter } from 'node:events'
import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'

import { serveVideoRangeHttpRequest } from '../src/video-range-http.js'
import { releaseAllPrioritizedBlobRanges } from '../src/blob-range-priority.js'

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

function makeRangeRequest({ range = 'bytes=2-5', type = 'video/mp4' } = {}) {
  const key = Buffer.from('d'.repeat(64), 'hex')
  const blob = {
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
