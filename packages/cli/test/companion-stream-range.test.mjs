import test from 'brittle'
import b4a from 'b4a'
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'

import { signControlRequest } from '../src/companion/auth.js'
import { resolveCompanionConfig } from '../src/companion/config.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createCompanionStreamRoute } from '../src/companion/stream-route.js'
import { createStreamCapabilityStore } from '../src/companion/stream-capabilities.js'

const CLIENT = 'mediastorm-stream-test'
const SECRET = 'ab'.repeat(32)
const NOW = 1_786_406_400_000
const REF = 'R'.repeat(43)
const BODY = b4a.from('verified-media-bytes')
const ETAG = `"${'12'.repeat(32)}"`

let nonceSequence = 0
function config () {
  return resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: CLIENT,
    sharedSecret: SECRET
  }, { storagePath: '/tmp/peartube-stream-test' })
}

function signedHeaders (path, body, nonce) {
  return signControlRequest({
    method: 'POST',
    path,
    body,
    timestamp: NOW,
    nonce,
    client: CLIENT,
    secret: SECRET
  })
}

function request ({ host, port, method = 'GET', path, headers = {}, body = '', allowAbort = false }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, method, path, headers }, (res) => {
      const chunks = []
      let settled = false
      const finish = (aborted) => {
        if (settled) return
        settled = true
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: b4a.concat(chunks),
          aborted
        })
      }
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => finish(false))
      res.on('aborted', () => finish(true))
      res.on('error', error => allowAbort ? finish(true) : reject(error))
    })
    req.once('error', error => allowAbort ? resolve({ statusCode: null, headers: {}, body: b4a.alloc(0), aborted: true }) : reject(error))
    if (body) req.write(body)
    req.end()
  })
}

function streamAsset (bytes = BODY, overrides = {}) {
  const calls = []
  const asset = {
    assetId: 'asset-1',
    byteLength: bytes.byteLength,
    blockSize: 4,
    mimeType: 'video/mp4',
    etag: ETAG,
    seek ({ byteStart }) {
      calls.push({ type: 'seek', byteStart })
    },
    async requestRange (input) {
      calls.push({ type: 'range', ...input })
      return {
        status: 'ok',
        verified: true,
        bytes: bytes.subarray(input.byteStart, input.byteEnd)
      }
    },
    ...overrides
  }
  return { asset, calls }
}

async function startHarness (t, asset, { capabilities = null, streamChunkBytes = 4 } = {}) {
  const service = {
    async verifyIndexCandidate () {
      return {
        candidateRef: REF,
        publication: { publicationId: 'pub-1' },
        rendition: { renditionId: 'rend-1', container: 'mp4' },
        asset: { assetId: 'asset-1' }
      }
    },
    async openStreamAsset () {
      return asset
    }
  }
  const server = createCompanionServer({
    service,
    config: config(),
    clock: () => NOW,
    capabilities,
    requestDeadlineMs: 5_000,
    streamChunkBytes
  })
  t.teardown(() => server.close().catch(() => {}))
  const state = await server.start()
  const openPath = '/api/v2/streams/open'
  const openBody = JSON.stringify({ candidateRef: REF })
  const opened = await request({
    host: state.host,
    port: state.port,
    method: 'POST',
    path: openPath,
    body: openBody,
    headers: signedHeaders(openPath, openBody, `stream-open-${++nonceSequence}`)
  })
  const payload = JSON.parse(b4a.toString(opened.body))
  return { state, server, opened: payload }
}
function rangeCalls (calls) {
  return calls.filter(call => call.type === 'range').map(({ byteStart, byteEnd }) => ({ byteStart, byteEnd }))
}

test('capability-only full GET and HEAD stream verified bounded chunks while control routes remain MAC-gated', async (t) => {
  const { asset, calls } = streamAsset()
  const { state, opened } = await startHarness(t, asset)

  const head = await request({ host: state.host, port: state.port, method: 'HEAD', path: opened.url })
  t.is(head.statusCode, 200)
  t.is(head.headers['accept-ranges'], 'bytes')
  t.is(head.headers['content-length'], String(BODY.byteLength))
  t.is(head.headers.etag, ETAG)
  t.is(head.headers['content-type'], 'video/mp4')
  t.is(head.body.byteLength, 0)
  t.alike(rangeCalls(calls), [])

  const full = await request({ host: state.host, port: state.port, path: opened.url })
  t.is(full.statusCode, 200)
  t.alike(full.body, BODY)
  t.is(full.headers['content-length'], String(BODY.byteLength))
  t.alike(rangeCalls(calls), [
    { byteStart: 0, byteEnd: 4 },
    { byteStart: 4, byteEnd: 8 },
    { byteStart: 8, byteEnd: 12 },
    { byteStart: 12, byteEnd: 16 },
    { byteStart: 16, byteEnd: BODY.byteLength }
  ])

  const unsignedControl = await request({ host: state.host, port: state.port, path: '/api/v2/status' })
  t.is(unsignedControl.statusCode, 401)
})

test('single ranges, If-Range, suffix, and open-ended requests map to exact scheduler bytes', async (t) => {
  const { asset, calls } = streamAsset()
  const { state, opened } = await startHarness(t, asset)
  const cases = [
    { range: 'bytes=2-5', status: 206, contentRange: `bytes 2-5/${BODY.byteLength}`, body: BODY.subarray(2, 6) },
    { range: 'bytes=7-', status: 206, contentRange: `bytes 7-${BODY.byteLength - 1}/${BODY.byteLength}`, body: BODY.subarray(7) },
    { range: 'bytes=-3', status: 206, contentRange: `bytes ${BODY.byteLength - 3}-${BODY.byteLength - 1}/${BODY.byteLength}`, body: BODY.subarray(-3) },
    { range: 'bytes=2-5', ifRange: ETAG, status: 206, contentRange: `bytes 2-5/${BODY.byteLength}`, body: BODY.subarray(2, 6) },
    { range: 'bytes=2-5', ifRange: '"different"', status: 200, contentRange: undefined, body: BODY }
  ]

  for (const [index, entry] of cases.entries()) {
    calls.length = 0
    const response = await request({
      host: state.host,
      port: state.port,
      path: opened.url,
      headers: {
        range: entry.range,
        ...(entry.ifRange ? { 'if-range': entry.ifRange } : {})
      }
    })
    t.is(response.statusCode, entry.status, String(index))
    t.is(response.headers['content-range'], entry.contentRange, String(index))
    t.is(response.headers['content-length'], String(entry.body.byteLength), String(index))
    t.alike(response.body, entry.body, String(index))
    for (const call of rangeCalls(calls)) t.ok(call.byteEnd - call.byteStart <= 4, String(index))
  }

  calls.length = 0
  const rangedHead = await request({
    host: state.host,
    port: state.port,
    method: 'HEAD',
    path: opened.url,
    headers: { range: 'bytes=2-5' }
  })
  t.is(rangedHead.statusCode, 206)
  t.is(rangedHead.headers['content-range'], `bytes 2-5/${BODY.byteLength}`)
  t.is(rangedHead.headers['content-length'], '4')
  t.is(rangedHead.body.byteLength, 0)
  t.alike(rangeCalls(calls), [])
})

test('malformed, multi, and unsatisfiable ranges return bounded 416 responses without acquisition', async (t) => {
  const { asset, calls } = streamAsset()
  const { state, opened } = await startHarness(t, asset)
  for (const value of ['bytes=nope', 'bytes=0-1,3-4', `bytes=${BODY.byteLength}-`]) {
    const response = await request({ host: state.host, port: state.port, path: opened.url, headers: { range: value } })
    t.is(response.statusCode, 416, value)
    t.is(response.headers['content-range'], `bytes */${BODY.byteLength}`, value)
    t.is(response.headers['accept-ranges'], 'bytes', value)
    t.ok(response.body.byteLength > 0 && response.body.byteLength <= 512, value)
  }
  t.alike(rangeCalls(calls), [])

  const rejected = await request({ host: state.host, port: state.port, method: 'POST', path: opened.url })
  t.is(rejected.statusCode, 405)
  t.is(rejected.headers.allow, 'GET, HEAD')
})

test('verified-source exhaustion is structured before headers and terminates after headers', async (t) => {
  let calls = 0
  const before = streamAsset(BODY, {
    async requestRange () {
      calls++
      if (calls === 1) return { status: 'unavailable', errorCode: 'NO_VERIFIED_SOURCE' }
      return { status: 'ok', verified: true, bytes: BODY.subarray(0, 4) }
    }
  }).asset
  const capabilities = createStreamCapabilityStore({ now: () => NOW, maxConcurrentUses: 1 })
  const first = await startHarness(t, before, { capabilities })
  const unavailable = await request({ host: first.state.host, port: first.state.port, path: `${first.opened.url}&unused=1` })
  t.is(unavailable.statusCode, 400)
  const sourceUnavailable = await request({ host: first.state.host, port: first.state.port, path: first.opened.url, headers: { range: 'bytes=0-3' } })
  t.is(sourceUnavailable.statusCode, 503)
  t.is(JSON.parse(b4a.toString(sourceUnavailable.body)).error.code, 'VERIFIED_SOURCE_UNAVAILABLE')
  const retry = await request({ host: first.state.host, port: first.state.port, path: first.opened.url, headers: { range: 'bytes=0-3' } })
  t.is(retry.statusCode, 206, 'failed acquisition releases capability concurrency')

  let chunk = 0
  const after = streamAsset(BODY, {
    async requestRange ({ byteStart, byteEnd }) {
      chunk++
      if (chunk === 1) return { status: 'ok', verified: true, bytes: BODY.subarray(byteStart, byteEnd) }
      return { status: 'unavailable', errorCode: 'NO_VERIFIED_SOURCE' }
    }
  }).asset
  const second = await startHarness(t, after)
  const terminated = await request({ host: second.state.host, port: second.state.port, path: second.opened.url, allowAbort: true })
  t.is(terminated.statusCode, 200)
  t.is(terminated.aborted, true)
  t.alike(terminated.body, BODY.subarray(0, 4))
})

test('disconnect aborts the in-flight scheduler request and releases capability concurrency', async (t) => {
  let schedulerSignal = null
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const { asset } = streamAsset(BODY, {
    requestRange ({ signal }) {
      schedulerSignal = signal
      startedResolve()
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
  })
  const capabilities = createStreamCapabilityStore({ now: () => NOW, maxConcurrentUses: 1 })
  const { state, opened } = await startHarness(t, asset, { capabilities })
  const req = httpRequest({ host: state.host, port: state.port, path: opened.url })
  req.on('error', () => {})
  req.end()
  await started
  const aborted = schedulerSignal.aborted
    ? Promise.resolve()
    : new Promise(resolve => schedulerSignal.addEventListener('abort', resolve, { once: true }))
  req.destroy()
  await aborted
  t.is(schedulerSignal.aborted, true)
  asset.requestRange = async ({ byteStart, byteEnd }) => ({
    status: 'ok',
    verified: true,
    bytes: BODY.subarray(byteStart, byteEnd)
  })
  const retry = await request({
    host: state.host,
    port: state.port,
    path: opened.url,
    headers: { range: 'bytes=0-3' }
  })
  t.is(retry.statusCode, 206, 'disconnect released capability concurrency')
})

test('stream backpressure pauses range acquisition until response drain', async (t) => {
  const calls = []
  const capabilities = createStreamCapabilityStore({ now: () => NOW, randomBytes: () => b4a.alloc(32, 21) })
  const asset = {
    assetId: 'asset-1',
    byteLength: 8,
    blockSize: 4,
    mimeType: 'text/html',
    etag: ETAG,
    seek () {},
    async requestRange ({ byteStart, byteEnd }) {
      calls.push([byteStart, byteEnd])
      return { status: 'ok', verified: true, bytes: b4a.alloc(byteEnd - byteStart, byteStart) }
    }
  }
  const grant = capabilities.issue({
    clientIdentity: CLIENT,
    publicationId: 'pub-1',
    renditionId: 'rend-1',
    assetId: 'asset-1',
    asset
  })
  const response = new EventEmitter()
  response.headers = {}
  response.statusCode = 0
  response.headersSent = false
  response.writableEnded = false
  response.destroyed = false
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = String(value) }
  response.writeHead = statusCode => { response.statusCode = statusCode; response.headersSent = true }
  let writes = 0
  response.write = () => ++writes !== 1
  response.end = () => { response.writableEnded = true; response.emit('finish') }
  response.destroy = () => { response.destroyed = true; response.emit('close') }

  const route = createCompanionStreamRoute({ capabilities, streamChunkBytes: 4 })
  const pending = route.handle({ method: 'GET', url: `/api/v2/stream/pub-1/rend-1?cap=${grant.token}`, headers: {} }, response)
  await Promise.resolve()
  await Promise.resolve()
  t.alike(calls, [[0, 4]])
  response.emit('drain')
  await pending
  t.alike(calls, [[0, 4], [4, 8]])
  t.is(response.headers['content-type'], 'application/octet-stream')
})
