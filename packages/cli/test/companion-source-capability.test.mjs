import test from 'brittle'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createNonceStore, hashControlBody, verifyControlRequest } from '../src/companion/auth.js'
import { createIngestJobStore } from '../src/companion/ingest-job-store.js'
import {
  canonicalIngestRequest,
  createIngestManager,
  fingerprintIngestRequest,
  ingestJobIdForRequest
} from '../src/companion/ingest-manager.js'
import { createSourceCallbackClient } from '../src/companion/source-client.js'

const NOW = 1_786_406_400_000
const SECRET = '4d'.repeat(32)
const CLIENT = 'peartube-companion'
const ETAG = '"source-immutable-v1"'

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function movieRequest (bytes, patch = {}) {
  return {
    retentionClass: 'archive-pin',
    mediaContext: { kind: 'movie', namespace: 'tmdb', identifier: '603' },
    measuredFacts: { title: 'The Matrix', byteLength: bytes.byteLength, container: 'mkv' },
    expected: { byteLength: bytes.byteLength, sha256: sha256(bytes), etag: ETAG },
    ...patch
  }
}

function fakeBee () {
  const map = new Map()
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    map,
    async get (key) { return map.has(key) ? { value: clone(map.get(key)) } : null },
    batch () {
      const operations = []
      return {
        async put (key, value) { operations.push(['put', key, clone(value)]) },
        async del (key) { operations.push(['del', key]) },
        async flush () {
          for (const [operation, key, value] of operations) {
            if (operation === 'put') map.set(key, value)
            else map.delete(key)
          }
        }
      }
    },
    async * createReadStream ({ gte, lt }) {
      for (const key of [...map.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: clone(map.get(key)) }
      }
    }
  }
}

function fakePublisher () {
  const calls = { imports: 0 }
  const videos = new Map()
  const publication = videoId => ({
    id: videoId,
    immutablePublication: {
      publicationId: sha256(Buffer.from(`publication:${videoId}`)),
      manifestId: sha256(Buffer.from(`manifest:${videoId}`)),
      renditionId: sha256(Buffer.from(`rendition:${videoId}`)),
      assetId: sha256(Buffer.from(`asset:${videoId}`)),
      coreKey: sha256(Buffer.from(`core:${videoId}`))
    }
  })
  return {
    calls,
    async ensureAnonymousChannel () {
      return {
        channel: { async getVideo (videoId) { return videos.get(videoId) || null } },
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    async importVideo ({ videoId }) {
      calls.imports++
      const metadata = publication(videoId)
      videos.set(videoId, metadata)
      return { metadata }
    },
    async publishCatalog () {},
    async retainAssets () {}
  }
}

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

function callbackServer (t, bytes, behavior = {}) {
  const nonces = createNonceStore({ maxEntries: 256 })
  const calls = { heads: [], ranges: [], deletes: [] }
  let shortOnce = behavior.shortOnce === true
  let holdResponse = null
  let releaseHold = null
  const held = new Promise(resolve => { holdResponse = resolve })
  const gate = new Promise(resolve => { releaseHold = resolve })
  const server = createServer(async (request, response) => {
    const path = request.url
    const capability = decodeURIComponent(path.split('/').pop())
    try {
      verifyControlRequest({
        method: request.method,
        path,
        bodyHash: hashControlBody(Buffer.alloc(0)),
        headers: request.headers,
        secret: SECRET,
        client: CLIENT,
        clock: () => NOW,
        nonceStore: nonces,
        maxClockSkewMs: 30_000
      })
    } catch {
      response.writeHead(401).end()
      return
    }
    if (behavior.authFailure) {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'DELETE') {
      calls.deletes.push(capability)
      response.writeHead(204).end()
      return
    }
    const expectedJobId = behavior.jobId?.()
    if (expectedJobId && request.headers['x-peartube-job-id'] !== expectedJobId) {
      response.writeHead(403).end()
      return
    }
    if (request.method === 'HEAD') {
      calls.heads.push(capability)
      if (behavior.redirectHead) {
        response.writeHead(302, { location: '/not-followed' }).end()
        return
      }
      response.writeHead(200, {
        etag: behavior.headETag || ETAG,
        'content-length': String(behavior.headLength ?? bytes.byteLength),
        'content-type': 'video/x-matroska'
      }).end()
      return
    }
    const range = request.headers.range
    calls.ranges.push({ capability, range })
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '')
    if (!match || request.headers['if-match'] !== ETAG) {
      response.writeHead(412).end()
      return
    }
    const start = Number(match[1])
    const end = Number(match[2])
    const selected = bytes.subarray(start, end + 1)
    if (behavior.holdRange && range === behavior.holdRange) {
      holdResponse()
      await gate
    }
    if (shortOnce && start > 0) {
      shortOnce = false
      response.writeHead(206, {
        etag: ETAG,
        'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
        'content-length': String(selected.byteLength)
      })
      response.write(selected.subarray(0, Math.max(1, selected.byteLength - 2)))
      response.socket.destroy()
      return
    }
    const contentRange = behavior.badContentRange || `bytes ${start}-${end}/${bytes.byteLength}`
    const contentLength = behavior.overlongRange ? selected.byteLength + 1 : selected.byteLength
    response.writeHead(206, {
      etag: behavior.getETag || ETAG,
      'content-range': contentRange,
      'content-length': String(contentLength)
    })
    response.end(behavior.overlongRange ? Buffer.concat([selected, Buffer.from('x')]) : selected)
  })
  t.teardown(() => new Promise(resolve => server.close(resolve)))
  return {
    server,
    calls,
    held,
    release: () => releaseHold(),
    async origin () { return listen(server) }
  }
}

function sourceClient (origin, overrides = {}) {
  return createSourceCallbackClient({
    origin,
    client: CLIENT,
    sharedSecret: SECRET,
    chunkBytes: 4,
    clock: () => NOW,
    ...overrides
  })
}

function harness (t, { bee = fakeBee(), publisher = fakePublisher(), client, root = null } = {}) {
  const storage = root || mkdtempSync(join(tmpdir(), 'peartube-source-capability-'))
  if (!root) t.teardown(() => rmSync(storage, { recursive: true, force: true }))
  const store = createIngestJobStore({ bee, now: () => NOW })
  const manager = createIngestManager({
    store,
    publisher,
    spoolRoot: join(storage, 'spool'),
    sourceClient: client,
    verifyChunkBytes: 4,
    now: () => NOW
  })
  return { bee, manager, publisher, root: storage, store }
}

async function waitForState (manager, jobId, state) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const job = await manager.getJob(jobId)
    if (job?.state === state) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${jobId} did not reach ${state}`)
}

test('production MediaStorm handler key shares canonical nested Unicode ingest identity bytes', (t) => {
  const request = {
    retentionClass: 'archive-pin',
    mediaContext: { namespace: 'tmdb', identifier: '603', kind: 'movie' },
    measuredFacts: {
      durationMs: 7_200_000,
      title: 'Café <>& \u2028 \u2029 / \\ \"',
      container: 'mkv',
      byteLength: 12
    },
    expected: {
      sha256: 'ab'.repeat(32),
      etag: '\"source-immutable-v1\"',
      byteLength: 12
    },
    bundleProvenance: {
      releaseName: 'Nested object',
      sourceKind: 'archive'
    }
  }
  const canonical = canonicalIngestRequest(request)
  t.not(canonical.charCodeAt(canonical.length - 1), 10)
  const canonicalHex = '7b2262756e646c6550726f76656e616e6365223a7b2272656c656173654e616d65223a224e6573746564206f626a656374222c22736f757263654b696e64223a2261726368697665227d2c226578706563746564223a7b22627974654c656e677468223a31322c2265746167223a225c22736f757263652d696d6d757461626c652d76315c22222c22736861323536223a2261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162227d2c226d656173757265644661637473223a7b22627974654c656e677468223a31322c22636f6e7461696e6572223a226d6b76222c226475726174696f6e4d73223a373230303030302c227469746c65223a22436166c3a9203c3e2620e280a820e280a9202f205c5c205c22227d2c226d65646961436f6e74657874223a7b226964656e746966696572223a22363033222c226b696e64223a226d6f766965222c226e616d657370616365223a22746d6462227d2c22726574656e74696f6e436c617373223a22617263686976652d70696e227d'
  t.is(Buffer.from(canonical, 'utf8').toString('hex'), canonicalHex)
  t.is(fingerprintIngestRequest(request), '93794f73d757f477f8c02d7e26fba7a12e90c9570f5336f25ae2ee9c8ce03a4b')
  const idempotencyKey = `mediastorm-v1_${'12'.repeat(32)}`
  t.is(ingestJobIdForRequest(idempotencyKey, request), 'ing_f8fe3828098633aca86ba6cf16eba692')
  const productionHandlerKey = 'mediastorm-v1_41e3f4eca5fe977d4cf54af8b70e45ddb536fa6c463777947d0598c72157b025'
  t.is(ingestJobIdForRequest(productionHandlerKey, request), 'ing_5395d7396d3d186ed35148b3f123d6ec')
})

test('source capability acquisition resumes the same recoverable job and publishes exactly once', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  let jobId = null
  const callback = callbackServer(t, bytes, { shortOnce: true, jobId: () => jobId })
  const origin = await callback.origin()
  const { bee, manager, publisher, store } = harness(t, { client: sourceClient(origin) })
  t.teardown(() => manager.close())
  await manager.start()

  const request = movieRequest(bytes)
  const firstCapability = 'source-capability-first-00000000000000000001'
  const first = await manager.submitJob({ idempotencyKey: 'same-source-job', request, sourceCapability: firstCapability })
  jobId = first.jobId
  const failed = await waitForState(manager, first.jobId, 'failed')
  t.is(failed.recoverable, true)
  t.is(failed.bytesReceived, 4, 'only a complete exact range is durable progress')
  t.is((await store.getJob(first.jobId)).bytesReceived, 4)

  const freshCapability = 'source-capability-fresh-0000000000000000001'
  const replay = await manager.submitJob({ idempotencyKey: 'same-source-job', request, sourceCapability: freshCapability })
  t.is(replay.jobId, first.jobId)
  const completed = await waitForState(manager, first.jobId, 'completed')
  t.is(completed.bytesReceived, bytes.byteLength)
  t.is(publisher.calls.imports, 1)
  t.ok(callback.calls.ranges.some(call => call.capability === freshCapability && call.range === 'bytes=4-7'))
  t.ok(callback.calls.deletes.includes(firstCapability))
  t.ok(callback.calls.deletes.includes(freshCapability))

  const terminalCapability = 'source-capability-terminal-00000000000000001'
  const terminalReplay = await manager.submitJob({ idempotencyKey: 'same-source-job', request, sourceCapability: terminalCapability })
  t.is(terminalReplay.state, 'completed')
  t.is(publisher.calls.imports, 1)
  t.ok(callback.calls.deletes.includes(terminalCapability), 'terminal replay explicitly revokes the unused grant')

  const durable = JSON.stringify([...bee.map.entries()])
  for (const sensitive of [origin, SECRET, firstCapability, freshCapability, terminalCapability]) {
    t.is(durable.includes(sensitive), false)
  }
})

test('source callback HEAD requires a bounded durable expected length', async (t) => {
  const client = sourceClient('http://127.0.0.1:1')
  for (const length of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
    const error = await client.head({
      capability: 'source-capability-invalid-length-000000000001',
      jobId: 'ing_invalid_length',
      etag: ETAG,
      length
    }).then(() => null, value => value)
    t.is(error?.code, 'SOURCE_LENGTH_MISMATCH')
  }
})

test('source callback metadata, redirects, authentication, and exact range framing fail closed', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const cases = [
    { name: 'redirect', behavior: { redirectHead: true }, operation: 'head', code: 'SOURCE_REDIRECT' },
    { name: 'authentication', behavior: { authFailure: true }, operation: 'head', code: 'SOURCE_AUTH_FAILED' },
    { name: 'length drift', behavior: { headLength: bytes.byteLength + 1 }, operation: 'head', code: 'SOURCE_LENGTH_MISMATCH' },
    { name: 'etag drift', behavior: { headETag: '"drift"' }, operation: 'head', code: 'SOURCE_ETAG_MISMATCH' },
    { name: 'bad content range', behavior: { badContentRange: `bytes 1-4/${bytes.byteLength}` }, operation: 'range', code: 'SOURCE_RANGE_INVALID' },
    { name: 'overlong range', behavior: { overlongRange: true }, operation: 'range', code: 'SOURCE_RANGE_INVALID' },
    { name: 'get etag drift', behavior: { getETag: '"drift"' }, operation: 'range', code: 'SOURCE_ETAG_MISMATCH' }
  ]

  for (const [index, entry] of cases.entries()) {
    let jobId = `ing_failure_${index}`
    const callback = callbackServer(t, bytes, { ...entry.behavior, jobId: () => jobId })
    const origin = await callback.origin()
    const client = sourceClient(origin)
    const capability = `failure-capability-${String(index).padStart(32, '0')}`
    const error = await (entry.operation === 'head'
      ? client.head({ capability, jobId, etag: ETAG, length: bytes.byteLength })
      : client.getRange({ capability, jobId, etag: ETAG, length: bytes.byteLength, start: 0, end: 3, onChunk () {} })
    ).then(() => null, value => value)
    t.is(error?.code, entry.code, entry.name)
    await new Promise(resolve => callback.server.close(resolve))
  }
})

test('source callback rejects a body overrun even when range headers claim the exact length', async (t) => {
  const response = new EventEmitter()
  response.statusCode = 206
  response.rawHeaders = [
    'ETag', ETAG,
    'Content-Range', 'bytes 0-3/12',
    'Content-Length', '4'
  ]
  response.destroy = () => {}
  const httpRequest = (_url, _options, onResponse) => {
    const request = new EventEmitter()
    request.destroy = error => request.emit('error', error)
    request.end = () => {
      queueMicrotask(() => {
        onResponse(response)
        setTimeout(() => {
          response.emit('data', Buffer.from('abcde'))
          response.emit('end')
        }, 0)
      })
    }
    return request
  }
  const client = sourceClient('http://127.0.0.1:1', { httpRequest })
  await t.exception(
    client.getRange({
      capability: 'source-capability-body-overrun-0000000000001',
      jobId: 'ing_body_overrun',
      etag: ETAG,
      length: 12,
      start: 0,
      end: 3,
      onChunk: () => {}
    }),
    /SOURCE_RANGE_OVERRUN/
  )
})

test('cancellation aborts acquisition, revokes the grant, and removes partial staging', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  let jobId = null
  const capability = 'source-capability-cancel-00000000000000000001'
  const callback = callbackServer(t, bytes, { holdRange: 'bytes=0-3', jobId: () => jobId })
  const origin = await callback.origin()
  const { manager, root } = harness(t, { client: sourceClient(origin) })
  t.teardown(() => manager.close())
  await manager.start()
  const created = await manager.submitJob({ idempotencyKey: 'cancel-source', request: movieRequest(bytes), sourceCapability: capability })
  jobId = created.jobId
  await callback.held
  const cancellation = manager.cancelJob(created.jobId)
  callback.release()
  const cancelled = await cancellation
  t.is(cancelled.state, 'cancelled')
  t.ok(callback.calls.deletes.includes(capability))
  let entries = []
  try { entries = readdirSync(join(root, 'spool', 'sources')) } catch {}
  t.alike(entries, [])
})

test('restart preserves verified partial bytes and fresh capability reattachment resumes the same job', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const bee = fakeBee()
  const publisher = fakePublisher()
  const root = mkdtempSync(join(tmpdir(), 'peartube-source-restart-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  let jobId = null
  const callback = callbackServer(t, bytes, { holdRange: 'bytes=4-7', jobId: () => jobId })
  const origin = await callback.origin()

  const first = harness(t, { bee, publisher, root, client: sourceClient(origin) })
  await first.manager.start()
  const created = await first.manager.submitJob({
    idempotencyKey: 'restart-source',
    request: movieRequest(bytes),
    sourceCapability: 'source-capability-before-restart-000000000001'
  })
  jobId = created.jobId
  await callback.held
  const closing = first.manager.close()
  callback.release()
  await closing
  t.is((await first.store.getJob(created.jobId)).bytesReceived, 4)

  const second = harness(t, { bee, publisher, root, client: sourceClient(origin) })
  t.teardown(() => second.manager.close())
  await second.manager.start()
  const detached = await second.manager.getJob(created.jobId)
  t.is(detached.state, 'failed')
  t.is(detached.errorCode, 'SOURCE_REATTACH_REQUIRED')
  const replay = await second.manager.submitJob({
    idempotencyKey: 'restart-source',
    request: movieRequest(bytes),
    sourceCapability: 'source-capability-after-restart-0000000000001'
  })
  t.is(replay.jobId, created.jobId)
  await waitForState(second.manager, created.jobId, 'completed')
  t.ok(callback.calls.ranges.some(call => call.capability.includes('after-restart') && call.range === 'bytes=4-7'))
  t.is(publisher.calls.imports, 1)
})
