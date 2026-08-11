import test from 'brittle'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  INDEX_QUERY_ERROR_CODES,
  MAX_INDEX_QUERY_CURSOR_BYTES,
  MAX_INDEX_QUERY_ERROR_DETAIL_BYTES,
  MAX_INDEX_QUERY_FRAME_BYTES,
  MAX_INDEX_QUERY_RESULTS,
  MAX_INDEX_QUERY_SELECTORS,
  MAX_INDEX_QUERY_TEXT_BYTES,
  attachIndexServiceProtocol,
  createIndexQueryClient,
  createIndexServiceAnnouncement,
  decodeIndexQueryCancel,
  decodeIndexQueryError,
  decodeIndexQueryPage,
  decodeIndexQueryRequest,
  deriveIndexerId,
  encodeIndexQueryCancel,
  encodeIndexQueryError,
  encodeIndexQueryPage,
  encodeIndexQueryRequest,
} from '../src/indexer/index.js'
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  decodePeerFrame,
  peerFrameTypeCode,
} from '../src/network/frame.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { createIndexQueryRequester } from '../src/indexer/query-requester.js'
import { INDEX_QUERY_PAGE_FRAME } from '../src/indexer/query-frames.js'

const NOW = 1_700_000_000_000
const QUERY_A = '01'.repeat(32)
const QUERY_B = '02'.repeat(32)
const PUBLISHER_A = '11'.repeat(32)
const PUBLISHER_B = '22'.repeat(32)
const SERVICE_KEY = b4a.alloc(32, 31)
const CLIENT_KEY = b4a.alloc(32, 32)
const exact = (identifier = '348') => ({ type: 'exact-external-ref', namespace: 'tmdb', identifier })
const prefix = (value = 'pil') => ({ type: 'title-token-prefix', prefix: value })
const request = (overrides = {}) => ({
  queryId: QUERY_A,
  selectors: [exact()],
  limit: 2,
  cursor: null,
  deadlineMs: 3_000,
  ...overrides,
})
const exactResult = (publisherId = PUBLISHER_A, sourceRecordRef = 'source-1') => ({
  type: 'external-ref',
  publisherId,
  sourceRecordRef,
  namespace: 'tmdb',
  identifier: '348',
  entityKind: 'work',
  entityId: `work-${publisherId.slice(0, 4)}`,
  evidenceWeight: 1,
})
const tokenResult = (publisherId = PUBLISHER_A, token = 'pilot') => ({
  type: 'title-token',
  publisherId,
  sourceRecordRef: `source-${publisherId.slice(0, 4)}`,
  token,
  targetId: `work-${publisherId.slice(0, 4)}`,
})
const exactRow = (publisherId = PUBLISHER_A, sourceRecordRef = 'source-1') => ({
  publisherId,
  sourceRecordRef,
  namespace: 'tmdb',
  normalizedIdentifier: '348',
  entityKind: 'work',
  entityId: `work-${publisherId.slice(0, 4)}`,
  evidenceWeight: 1,
})
const tokenRow = (publisherId = PUBLISHER_A, token = 'pilot') => ({
  publisherId,
  sourceRecordRef: `source-${publisherId.slice(0, 4)}`,
  relationType: 'title-token',
  fromId: token,
  toId: `work-${publisherId.slice(0, 4)}`,
})

function serviceAnnouncement({
  signer = crypto.keyPair(b4a.alloc(32, 7)),
  transportPublicKey = SERVICE_KEY,
  queryCapabilities = ['exact-external-ref', 'text-prefix'],
  sequence = 1,
  issuedAt = NOW,
  expiresAt = NOW + 60_000,
} = {}) {
  return createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey,
    dimensions: ['external-ref', 'text'],
    shardRanges: [
      { dimension: 'external-ref', start: null, end: null },
      { dimension: 'text', start: null, end: null },
    ],
    queryCapabilities,
    policyDigest: b4a.alloc(32, 33),
    sequence,
    issuedAt,
    expiresAt,
  }, signer)
}

class MemoryDuplex extends Duplex {
  constructor() {
    super()
    this.other = null
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.other?.push(chunk)
    callback()
  }

  _final(callback) {
    this.other?.push(null)
    callback()
  }
}

function connectionPair() {
  const client = new MemoryDuplex()
  const server = new MemoryDuplex()
  client.other = server
  server.other = client
  client.remotePublicKey = SERVICE_KEY
  server.remotePublicKey = CLIENT_KEY
  client.destroyCount = 0
  server.destroyCount = 0
  const clientDestroy = client.destroy.bind(client)
  const serverDestroy = server.destroy.bind(server)
  client.destroy = (...args) => { client.destroyCount++; return clientDestroy(...args) }
  server.destroy = (...args) => { server.destroyCount++; return serverDestroy(...args) }
  return { client, server }
}

function runtimeSwarm() {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.join = () => ({ flushed: async () => {}, destroy() {}, suspend() {}, resume() {} })
  swarm.joinPeer = () => {}
  swarm.leavePeer = () => {}
  return swarm
}

function gate() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function refedTimerAdapter() {
  return {
    setTimeout(fn, ms) {
      const wrapper = {
        handle: setTimeout(fn, ms),
      }
      return wrapper
    },
    clearTimeout(wrapper) {
      clearTimeout(wrapper?.handle)
    },
  }
}

function manualTimers(initialNow = NOW) {
  let now = initialNow
  let failNext = false
  const handles = new Set()
  return {
    now: () => now,
    setTimeout(fn, delay) {
      if (failNext) {
        failNext = false
        throw new Error('timer setup failed')
      }
      const handle = { at: now + delay, fn, cleared: false, unref() {} }
      handles.add(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true
    },
    failNext() {
      failNext = true
    },
    async advance(value) {
      now = value
      for (const handle of [...handles]) {
        if (handle.cleared || handle.at > now) continue
        handle.cleared = true
        handles.delete(handle)
        handle.fn()
      }
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}



function paired(t, indexStore, overrides = {}) {
  const announcement = overrides.announcement || serviceAnnouncement()
  const pair = connectionPair()
  const server = attachIndexServiceProtocol({
    connection: pair.server,
    announcement,
    indexStore,
    limits: {
      localTransportPublicKey: SERVICE_KEY,
      sequenceState: new Map(),
      now: () => NOW + 1,
      maxFrameBytes: MAX_INDEX_QUERY_FRAME_BYTES,
      ...overrides.serverLimits,
    },
  })
  const client = createIndexQueryClient({
    announcement,
    limits: {
      sequenceState: new Map(),
      now: () => NOW + 1,
      maxFrameBytes: MAX_INDEX_QUERY_FRAME_BYTES,
      ...overrides.clientLimits,
    },
  })
  t.teardown(() => {
    client.close()
    server.close()
    pair.client.destroy()
    pair.server.destroy()
  })
  return { announcement, pair, server, client }
}

test('shared frame registry decodes raw query frame codes without local encode side effects', t => {
  const frameTypes = [
    'index-query-request',
    'index-query-page',
    'index-query-error',
    'index-query-cancel',
  ]
  for (let index = 0; index < frameTypes.length; index++) {
    const encoded = b4a.alloc(32)
    encoded.writeUInt32BE(28, 0)
    encoded.writeUInt8(PROTOCOL_MAJOR, 4)
    encoded.writeUInt8(PROTOCOL_MINOR, 5)
    encoded.writeUInt8(7, 6)
    encoded.writeUInt8(0, 7)
    encoded.writeUInt32BE(peerFrameTypeCode(frameTypes[index]), 8)
    encoded.writeUInt32BE(index + 1, 12)
    encoded.writeUInt32BE(0, 16)
    encoded.writeUInt32BE(0, 20)
    encoded.writeUInt32BE(0, 24)
    encoded.writeUInt32BE(0, 28)
    t.is(decodePeerFrame(encoded).type, frameTypes[index])
  }
})

test('configured client authenticates the live remote service transport key before opening', async t => {
  const client = createIndexQueryClient({
    announcement: serviceAnnouncement(),
    limits: { sequenceState: new Map(), now: () => NOW + 1 },
  })
  t.teardown(() => client.close())
  await t.exception(client.queryIndex({
    connection: { remotePublicKey: b4a.alloc(32, 99) },
    query: request(),
  }), /remote transport public key/)
  t.is(client.pendingCount, 0)
})

test('canonical query request page error and cancel codecs round trip exact fields', t => {
  const values = [
    [encodeIndexQueryRequest, decodeIndexQueryRequest, request({ selectors: [exact(), prefix()] })],
    [encodeIndexQueryPage, decodeIndexQueryPage, {
      queryId: QUERY_A,
      results: [exactResult(), tokenResult(PUBLISHER_B)],
      nextCursor: 'AQID',
      sourceRevision: '0:42',
    }],
    [encodeIndexQueryError, decodeIndexQueryError, {
      queryId: QUERY_A,
      code: INDEX_QUERY_ERROR_CODES.INVALID_CURSOR,
      detail: 'cursor does not match this query',
    }],
    [encodeIndexQueryCancel, decodeIndexQueryCancel, { queryId: QUERY_A }],
  ]
  for (const [encode, decode, value] of values) {
    const decoded = decode(encode(value))
    t.alike(decoded, value)
    t.alike(Object.keys(decoded), Object.keys(value))
  }
})

test('query request rejects duplicate noncanonical and malformed selectors', t => {
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [exact(), exact()] })), /distinct|duplicate/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [prefix(), exact()] })), /canonical|order/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [{ namespace: 'tmdb', identifier: '348' }] })), /type|fields/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [{ ...exact(), extra: true }] })), /fields/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [{ ...exact(), namespace: 'TMDB' }] })), /namespace|canonical/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [{ ...prefix(), prefix: 'Pilot' }] })), /prefix|canonical/)
})

test('query codecs reject invalid UTF-8 domain and protocol identifiers', t => {
  t.exception(() => encodeIndexQueryRequest(request({ queryId: 'zz'.repeat(32) })), /queryId/)
  t.exception(() => encodeIndexQueryPage({ queryId: QUERY_A, results: [{ ...exactResult(), publisherId: 'AA'.repeat(32) }], nextCursor: null, sourceRevision: '0:1' }), /publisherId/)
  const encoded = encodeIndexQueryRequest(request())
  const invalidUtf8 = b4a.from(encoded)
  invalidUtf8[1] = 0xff
  t.exception(() => decodeIndexQueryRequest(invalidUtf8), /domain|UTF-8|canonical/)
  const wrongDomain = b4a.from(encoded)
  wrongDomain[1] ^= 1
  t.exception(() => decodeIndexQueryRequest(wrongDomain), /domain|canonical/)
})

test('query codecs enforce selector text cursor result detail and frame maxima', t => {
  t.is(decodeIndexQueryRequest(encodeIndexQueryRequest(request({ selectors: Array.from({ length: MAX_INDEX_QUERY_SELECTORS }, (_, index) => exact(String(index).padStart(3, '0'))) }))).selectors.length, MAX_INDEX_QUERY_SELECTORS)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: Array.from({ length: MAX_INDEX_QUERY_SELECTORS + 1 }, (_, index) => exact(String(index).padStart(3, '0'))) })), /selectors.*limit|bounded/)
  t.exception(() => encodeIndexQueryRequest(request({ selectors: [exact('x'.repeat(MAX_INDEX_QUERY_TEXT_BYTES + 1))] })), /identifier|text.*bound/)
  t.exception(() => encodeIndexQueryRequest(request({ cursor: 'A'.repeat(MAX_INDEX_QUERY_CURSOR_BYTES + 1) })), /cursor/)
  t.is(decodeIndexQueryPage(encodeIndexQueryPage({ queryId: QUERY_A, results: Array.from({ length: MAX_INDEX_QUERY_RESULTS }, (_, index) => exactResult(PUBLISHER_A, `source-${index}`)), nextCursor: null, sourceRevision: '0:1' })).results.length, MAX_INDEX_QUERY_RESULTS)
  t.exception(() => encodeIndexQueryPage({ queryId: QUERY_A, results: Array.from({ length: MAX_INDEX_QUERY_RESULTS + 1 }, () => exactResult()), nextCursor: null, sourceRevision: '0:1' }), /results.*limit|bounded/)
  t.exception(() => encodeIndexQueryError({ queryId: QUERY_A, code: INDEX_QUERY_ERROR_CODES.INTERNAL_ERROR, detail: 'x'.repeat(MAX_INDEX_QUERY_ERROR_DETAIL_BYTES + 1) }), /detail/)
  t.exception(() => encodeIndexQueryPage({
    queryId: QUERY_A,
    results: Array.from({ length: MAX_INDEX_QUERY_RESULTS }, (_, index) => ({
      ...tokenResult(PUBLISHER_A, 'x'.repeat(MAX_INDEX_QUERY_TEXT_BYTES)),
      sourceRecordRef: `source-${index}-${'x'.repeat(240)}`,
      targetId: 'x'.repeat(MAX_INDEX_QUERY_TEXT_BYTES),
    })),
    nextCursor: null,
    sourceRevision: '0:1',
  }), /frame|maximum/)
})

test('query codecs reject trailing truncated malformed and noncanonical bytes', t => {
  for (const [encode, decode, value] of [
    [encodeIndexQueryRequest, decodeIndexQueryRequest, request()],
    [encodeIndexQueryPage, decodeIndexQueryPage, { queryId: QUERY_A, results: [exactResult()], nextCursor: null, sourceRevision: '0:1' }],
    [encodeIndexQueryError, decodeIndexQueryError, { queryId: QUERY_A, code: INDEX_QUERY_ERROR_CODES.INVALID_REQUEST, detail: 'bad' }],
    [encodeIndexQueryCancel, decodeIndexQueryCancel, { queryId: QUERY_A }],
  ]) {
    const encoded = encode(value)
    t.exception(() => decode(b4a.concat([encoded, b4a.from([0])])), /trailing|canonical/)
    t.exception(() => decode(encoded.subarray(0, encoded.byteLength - 1)), /truncated|bounds|canonical/)
    const noncanonical = b4a.concat([b4a.from([0xfd, encoded[0], 0]), encoded.subarray(1)])
    t.exception(() => decode(noncanonical), /canonical|domain|bounds/)
  }
  t.exception(() => decodeIndexQueryRequest(b4a.alloc(MAX_INDEX_QUERY_FRAME_BYTES + 1)), /frame|maximum/)
})

test('paired Protomux returns source-attributed exact-ref and token-prefix pages', async t => {
  const calls = []
  const indexStore = {
    closeCount: 0,
    close() { this.closeCount++ },
    async queryIndexPage(input) {
      calls.push(input)
      return {
        results: input.selectors[0].type === 'exact-external-ref' ? [exactRow()] : [tokenRow()],
        continuation: null,
        sourceRevision: '0:7',
      }
    },
  }
  const { client, pair } = paired(t, indexStore)
  const exactPage = await client.queryIndex({ connection: pair.client, query: request() })
  const tokenPage = await client.queryIndex({ connection: pair.client, query: request({ queryId: QUERY_B, selectors: [prefix()] }) })
  t.alike(exactPage.results, [exactResult()])
  t.alike(tokenPage.results, [tokenResult()])
  t.ok([...exactPage.results, ...tokenPage.results].every(row => row.publisherId && row.sourceRecordRef))
  t.is(calls.length, 2)
  t.is(indexStore.closeCount, 0)
})

test('retained consumer runtime queries an explicit service responder over the production index path', async t => {
  const announcement = serviceAnnouncement()
  const swarm = runtimeSwarm()
  const pair = connectionPair()
  const indexStore = {
    closeCount: 0,
    close() { this.closeCount++ },
    async queryIndexPage() {
      return { results: [exactRow()], continuation: null, sourceRevision: '0:12' }
    },
  }
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    bootstrapEnabled: false,
    now: () => NOW + 1,
  })
  const server = attachIndexServiceProtocol({
    connection: pair.server,
    announcement,
    indexStore,
    limits: {
      localTransportPublicKey: SERVICE_KEY,
      sequenceState: new Map(),
      now: () => NOW + 1,
    },
  })
  t.teardown(async () => {
    server.close()
    await runtime.close()
    pair.client.destroy()
    pair.server.destroy()
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement })
  swarm.connections.add(pair.client)
  swarm.emit('connection', pair.client, { publicKey: SERVICE_KEY, client: true })
  const page = await runtime.queryIndexService({ indexerId: announcement.indexerId, query: request() })
  t.alike(page.results, [exactResult()])
  t.is(server.state, 'active')
  t.absent(runtime.getDiagnostics().sessions.find(session => session.purpose === 'index'))
  t.is(indexStore.closeCount, 0)
})

test('capability-changing same-channel announcement supersession preserves the live query channel', async t => {
  const signer = crypto.keyPair(b4a.alloc(32, 18))
  const first = serviceAnnouncement({ signer, queryCapabilities: ['exact-external-ref'], sequence: 1, expiresAt: NOW + 30_000 })
  const second = serviceAnnouncement({ signer, queryCapabilities: ['exact-external-ref', 'text-prefix'], sequence: 2, issuedAt: NOW + 1, expiresAt: NOW + 60_000 })
  const swarm = runtimeSwarm()
  const pair = connectionPair()
  const server = attachIndexServiceProtocol({
    connection: pair.server,
    announcement: first,
    indexStore: {
      async queryIndexPage(input) {
        return {
          results: input.selectors[0].type === 'title-token-prefix' ? [tokenRow()] : [exactRow()],
          continuation: null,
          sourceRevision: '0:12',
        }
      },
    },
    limits: {
      localTransportPublicKey: SERVICE_KEY,
      sequenceState: new Map(),
      now: () => NOW + 1,
    },
  })
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 3 })
  t.teardown(async () => {
    server.close()
    await runtime.close()
    pair.client.destroy()
    pair.server.destroy()
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement: first })
  swarm.connections.add(pair.client)
  swarm.emit('connection', pair.client, { publicKey: SERVICE_KEY, client: true })
  await runtime.queryIndexService({ indexerId: first.indexerId, query: request() })
  const channel = server.channel
  const result = await runtime.retainIndexService({ announcement: second })
  t.is(result.status, 'superseded')
  server.refreshAnnouncement(second)
  const page = await runtime.queryIndexService({
    indexerId: second.indexerId,
    query: request({ queryId: QUERY_B, selectors: [prefix()] }),
  })
  t.alike(page.results, [tokenResult()])
  t.is(server.channel, channel)
  t.is(server.state, 'active')
  t.is(pair.client.destroyCount, 0)
})

test('failed retained-runtime refresh preserves the old client channel sequence and expiry', async t => {
  const signer = crypto.keyPair(b4a.alloc(32, 20))
  const timers = manualTimers(NOW + 1)
  const first = serviceAnnouncement({
    signer,
    queryCapabilities: ['exact-external-ref'],
    sequence: 1,
    expiresAt: NOW + 30_000,
  })
  const second = serviceAnnouncement({
    signer,
    queryCapabilities: ['exact-external-ref', 'text-prefix'],
    sequence: 2,
    issuedAt: NOW + 1,
    expiresAt: NOW + 60_000,
  })
  const failingLimits = {
    ...timers,
    setTimeout() {
      throw new Error('timer setup failed')
    },
  }
  const swarm = runtimeSwarm()
  const pair = connectionPair()
  const server = attachIndexServiceProtocol({
    connection: pair.server,
    announcement: first,
    indexStore: {
      async queryIndexPage() {
        return { results: [exactRow()], continuation: null, sourceRevision: '0:18' }
      },
    },
    limits: {
      ...timers,
      localTransportPublicKey: SERVICE_KEY,
      sequenceState: new Map(),
    },
  })
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    bootstrapEnabled: false,
    now: timers.now,
  })
  t.teardown(async () => {
    server.close()
    await runtime.close()
    pair.client.destroy()
    pair.server.destroy()
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement: first, limits: timers })
  swarm.connections.add(pair.client)
  swarm.emit('connection', pair.client, { publicKey: SERVICE_KEY, client: true })
  await runtime.queryIndexService({ indexerId: first.indexerId, query: request() })
  const channel = server.channel

  for (let attempt = 0; attempt < 2; attempt++) {
    await t.exception(
      runtime.retainIndexService({ announcement: second, limits: failingLimits }),
      { message: 'timer setup failed' },
    )
  }
  const page = await runtime.queryIndexService({
    indexerId: first.indexerId,
    query: request({ queryId: QUERY_B }),
  })
  t.alike(page.results, [exactResult()])
  t.is(server.channel, channel)
  t.is(server.state, 'active')
  t.is(pair.client.destroyCount, 0)

  await timers.advance(NOW + 30_001)
  t.is(server.state, 'closed')
  await t.exception(
    runtime.queryIndexService({
      indexerId: first.indexerId,
      query: request({ queryId: '03'.repeat(32) }),
    }),
    { code: 'SCOPED_NETWORK_REJECTED' },
  )
})

test('signed same-channel refresh is monotonic capability-aware and replaces expiry transactionally', async t => {
  const signer = crypto.keyPair(b4a.alloc(32, 19))
  const timers = manualTimers(NOW + 1)
  const first = serviceAnnouncement({
    signer,
    queryCapabilities: ['exact-external-ref'],
    sequence: 1,
    expiresAt: NOW + 30_000,
  })
  const older = serviceAnnouncement({
    signer,
    queryCapabilities: ['exact-external-ref'],
    sequence: 0,
    expiresAt: NOW + 45_000,
  })
  const second = serviceAnnouncement({
    signer,
    queryCapabilities: ['exact-external-ref', 'text-prefix'],
    sequence: 2,
    issuedAt: NOW + 1,
    expiresAt: NOW + 60_000,
  })
  const { client, pair, server } = paired(t, {
    async queryIndexPage(input) {
      return {
        results: input.selectors[0].type === 'title-token-prefix' ? [tokenRow()] : [exactRow()],
        continuation: null,
        sourceRevision: '0:21',
      }
    },
  }, {
    announcement: first,
    serverLimits: timers,
    clientLimits: timers,
  })

  await client.queryIndex({ connection: pair.client, query: request() })
  const channel = server.channel
  await t.exception(
    client.queryIndex({ connection: pair.client, query: request({ queryId: QUERY_B, selectors: [prefix()] }) }),
    { code: INDEX_QUERY_ERROR_CODES.INVALID_REQUEST },
  )
  t.exception(() => client.refreshAnnouncement(first), { code: 'INDEX_SERVICE_PROTOCOL_REJECTED' })
  t.exception(() => client.refreshAnnouncement(older), { code: 'INDEX_SERVICE_PROTOCOL_REJECTED' })
  t.exception(
    () => client.refreshAnnouncement(first, { ...timers, sequenceState: new Map() }),
    { code: 'INDEX_SERVICE_PROTOCOL_REJECTED' },
  )

  t.exception(() => server.refreshAnnouncement(first), { code: 'INDEX_SERVICE_PROTOCOL_REJECTED' })
  t.exception(() => server.refreshAnnouncement(older), { code: 'INDEX_SERVICE_PROTOCOL_REJECTED' })

  timers.failNext()
  t.exception(() => server.refreshAnnouncement(second), { message: 'timer setup failed' })
  server.refreshAnnouncement(second)
  timers.failNext()
  t.exception(() => client.refreshAnnouncement(second), { message: 'timer setup failed' })
  client.refreshAnnouncement(second)

  await timers.advance(NOW + 30_001)
  t.is(server.channel, channel)
  t.is(server.state, 'active')
  const page = await client.queryIndex({
    connection: pair.client,
    query: request({ queryId: '03'.repeat(32), selectors: [prefix()] }),
  })
  t.alike(page.results, [tokenResult()])
  t.is(server.channel, channel)
  t.is(pair.client.destroyCount, 0)

  await timers.advance(NOW + 60_001)
  t.is(server.state, 'closed')
  await t.exception(
    client.queryIndex({ connection: pair.client, query: request({ queryId: '04'.repeat(32) }) }),
    { code: INDEX_QUERY_ERROR_CODES.CLOSED },
  )
})

test('network policy suspends pending queries and resumes the same client channel', async t => {
  const announcement = serviceAnnouncement()
  const swarm = runtimeSwarm()
  const pair = connectionPair()
  let firstWorkStarted = false
  let calls = 0
  const server = attachIndexServiceProtocol({
    connection: pair.server,
    announcement,
    indexStore: {
      async queryIndexPage({ signal }) {
        calls++
        if (calls === 1) {
          firstWorkStarted = true
          return new Promise((_, reject) => {
            if (signal.aborted) return reject(signal.reason)
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        return { results: [exactRow()], continuation: null, sourceRevision: '0:4' }
      },
    },
    limits: {
      localTransportPublicKey: SERVICE_KEY,
      sequenceState: new Map(),
      now: () => NOW + 1,
    },
  })
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  t.teardown(async () => {
    server.close()
    await runtime.close()
    pair.client.destroy()
    pair.server.destroy()
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement })
  swarm.connections.add(pair.client)
  swarm.emit('connection', pair.client, { publicKey: SERVICE_KEY, client: true })
  const pending = runtime.queryIndexService({ indexerId: announcement.indexerId, query: request() })
  await new Promise(resolve => setImmediate(resolve))
  const serverChannel = server.channel
  t.is(firstWorkStarted, true)
  await runtime.applyNetworkPolicy({
    networkEnabled: false,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 0,
  })
  await t.exception(pending, { code: INDEX_QUERY_ERROR_CODES.CLOSED })
  await t.exception(runtime.queryIndexService({ indexerId: announcement.indexerId, query: request({ queryId: QUERY_B }) }), /network policy/)
  t.is(pair.client.destroyCount, 0)
  await new Promise(resolve => setImmediate(resolve))
  t.is(server.state, 'active')
  t.is(server.pendingCount, 0)
  t.is(server.channel, serverChannel)
  await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1,
    diskCeilingBytes: 1,
  })
  const page = await runtime.queryIndexService({
    indexerId: announcement.indexerId,
    query: request({ queryId: '07'.repeat(32) }),
  })
  t.alike(page.results, [exactResult()])
  t.is(server.state, 'active')
  t.is(pair.client.destroyCount, 0)
})

test('paired queries correlate concurrent out-of-order pages by exact queryId', async t => {
  const first = gate()
  const calls = []
  const indexStore = {
    async queryIndexPage(input) {
      const identifier = input.selectors[0].identifier
      calls.push(identifier)
      if (identifier === 'slow') await first.promise
      else calls.push('fast-returned')
      return { results: [exactRow(identifier === 'slow' ? PUBLISHER_A : PUBLISHER_B)], continuation: null, sourceRevision: '0:9' }
    },
  }
  const { client, pair } = paired(t, indexStore)
  const slow = client.queryIndex({ connection: pair.client, query: request({ queryId: QUERY_A, selectors: [exact('slow')] }) })
  const fast = client.queryIndex({ connection: pair.client, query: request({ queryId: QUERY_B, selectors: [exact('fast')] }) })
  const fastPage = await fast
  t.is(fastPage.queryId, QUERY_B)
  t.alike(calls, ['slow', 'fast', 'fast-returned'])
  first.resolve()
  t.is((await slow).queryId, QUERY_A)
})

test('opaque cursors traverse pages and are selector and durable-revision bound', async t => {
  let revision = '0:10'
  const rows = [exactRow(PUBLISHER_A, 'source-1'), exactRow(PUBLISHER_B, 'source-2')]
  const indexStore = {
    async queryIndexPage(input) {
      if (input.sourceRevision && input.sourceRevision !== revision) {
        const error = new Error('source revision changed')
        error.code = 'INDEX_QUERY_STALE_REVISION'
        throw error
      }
      const start = input.continuation ? 1 : 0
      return { results: [rows[start]], continuation: start === 0 ? { selectorIndex: 0, after: { namespace: 'tmdb', normalizedIdentifier: '348', publisherId: PUBLISHER_A, sourceRecordRef: 'source-1', entityKind: 'work', entityId: 'work-1111' } } : null, sourceRevision: revision }
    },
  }
  const { client, pair } = paired(t, indexStore)
  const page1 = await client.queryIndex({ connection: pair.client, query: request({ limit: 1 }) })
  t.ok(page1.nextCursor)
  const page2 = await client.queryIndex({ connection: pair.client, query: request({ queryId: QUERY_B, limit: 1, cursor: page1.nextCursor }) })
  t.alike(page2.results, [exactResult(PUBLISHER_B, 'source-2')])
  t.is(page2.nextCursor, null)
  await t.exception(client.queryIndex({ connection: pair.client, query: request({ queryId: '03'.repeat(32), selectors: [exact('different')], cursor: page1.nextCursor }) }), { code: INDEX_QUERY_ERROR_CODES.INVALID_CURSOR })
  revision = '0:11'
  await t.exception(client.queryIndex({ connection: pair.client, query: request({ queryId: '04'.repeat(32), limit: 1, cursor: page1.nextCursor }) }), { code: INDEX_QUERY_ERROR_CODES.INVALID_CURSOR })
})

test('opaque cursor tokens reject forged and cross-index same-revision reuse', async t => {
  const continuation = { selectorIndex: 0, after: { namespace: 'tmdb', normalizedIdentifier: '348', publisherId: PUBLISHER_A, sourceRecordRef: 'source-1', entityKind: 'work', entityId: 'work-1111' } }
  const firstStore = {
    async queryIndexPage() {
      return { results: [exactRow()], continuation, sourceRevision: '0:77' }
    },
  }
  const first = paired(t, firstStore)
  const page = await first.client.queryIndex({ connection: first.pair.client, query: request({ limit: 1 }) })
  t.ok(page.nextCursor)
  await t.exception(first.client.queryIndex({
    connection: first.pair.client,
    query: request({ queryId: '05'.repeat(32), limit: 1, cursor: 'A'.repeat(43) }),
  }), { code: INDEX_QUERY_ERROR_CODES.INVALID_CURSOR })

  let secondCalls = 0
  const second = paired(t, {
    async queryIndexPage() {
      secondCalls++
      return { results: [], continuation: null, sourceRevision: '0:77' }
    },
  }, { announcement: serviceAnnouncement({ signer: crypto.keyPair(b4a.alloc(32, 8)) }) })
  await t.exception(second.client.queryIndex({
    connection: second.pair.client,
    query: request({ queryId: '06'.repeat(32), limit: 1, cursor: page.nextCursor }),
  }), { code: INDEX_QUERY_ERROR_CODES.INVALID_CURSOR })
  t.is(secondCalls, 0)
})

test('settled queryId cannot be reused inside the late-frame window', async t => {
  const { client, pair } = paired(t, {
    async queryIndexPage() {
      return { results: [exactRow()], continuation: null, sourceRevision: '0:1' }
    },
  })
  await client.queryIndex({ connection: pair.client, query: request() })
  await t.exception(client.queryIndex({ connection: pair.client, query: request() }), { code: INDEX_QUERY_ERROR_CODES.INVALID_REQUEST })
  t.is(client.pendingCount, 0)
})

test('negotiated page ceiling returns bounded error and keeps the channel usable', async t => {
  const indexStore = {
    async queryIndexPage(input) {
      return {
        results: input.selectors[0].type === 'title-token-prefix' ? [tokenRow(PUBLISHER_A, 'x'.repeat(512))] : [exactRow()],
        continuation: null,
        sourceRevision: '0:2',
      }
    },
  }
  const { client, pair, server } = paired(t, indexStore, {
    serverLimits: { maxFrameBytes: 512 },
    clientLimits: { maxFrameBytes: 512 },
  })
  await t.exception(client.queryIndex({
    connection: pair.client,
    query: request({ selectors: [prefix()], limit: 1 }),
  }), { code: INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED })
  const page = await client.queryIndex({
    connection: pair.client,
    query: request({ queryId: QUERY_B }),
  })
  t.alike(page.results, [exactResult()])
  t.is(server.state, 'active')
})

test('negotiated request ceiling rejects locally and keeps the channel usable', async t => {
  let calls = 0
  const { client, pair, server } = paired(t, {
    async queryIndexPage() {
      calls++
      return { results: [exactRow()], continuation: null, sourceRevision: '0:2' }
    },
  }, {
    serverLimits: { maxFrameBytes: 512 },
    clientLimits: { maxFrameBytes: 512 },
  })
  await t.exception(client.queryIndex({
    connection: pair.client,
    query: request({ selectors: [exact('x'.repeat(MAX_INDEX_QUERY_TEXT_BYTES))] }),
  }), { code: INDEX_QUERY_ERROR_CODES.INVALID_REQUEST })
  t.is(client.pendingCount, 0)
  t.is(server.pendingCount, 0)
  t.is(calls, 0)
  const page = await client.queryIndex({
    connection: pair.client,
    query: request(),
  })
  t.alike(page.results, [exactResult()])
  t.is(calls, 1)
  t.is(server.state, 'active')
})

test('requester rejects a canonical page above the requested limit and remains usable', async t => {
  const sent = []
  const requester = createIndexQueryRequester({
    send(type, payload) {
      sent.push({ type, payload })
      return 'sent'
    },
  })
  t.teardown(() => requester.close())
  const first = requester.query(request({ limit: 1 }))
  await new Promise(resolve => setImmediate(resolve))
  requester.onFrame({
    type: INDEX_QUERY_PAGE_FRAME,
    payload: encodeIndexQueryPage({
      queryId: QUERY_A,
      results: [exactResult(), exactResult(PUBLISHER_B, 'source-2')],
      nextCursor: null,
      sourceRevision: '0:2',
    }),
  })
  await t.exception(first, { code: INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED })
  t.is(requester.pendingCount, 0)

  const second = requester.query(request({ queryId: QUERY_B, limit: 1 }))
  await new Promise(resolve => setImmediate(resolve))
  requester.onFrame({
    type: INDEX_QUERY_PAGE_FRAME,
    payload: encodeIndexQueryPage({
      queryId: QUERY_B,
      results: [exactResult()],
      nextCursor: null,
      sourceRevision: '0:2',
    }),
  })
  const page = await second
  t.alike(page.results, [exactResult()])
  t.is(sent.length, 2)
})

test('client pending cap rejects before allocating another timer', async t => {
  const work = gate()
  const timers = refedTimerAdapter()
  let timerAllocations = 0
  const clientTimers = {
    setTimeout(fn, ms) {
      timerAllocations++
      return timers.setTimeout(fn, ms)
    },
    clearTimeout: timers.clearTimeout,
  }
  const { client, pair } = paired(t, {
    async queryIndexPage() { return work.promise },
  }, { clientLimits: { ...clientTimers, maxPendingQueries: 1 } })
  const first = client.queryIndex({ connection: pair.client, query: request() })
  const afterFirst = timerAllocations
  await t.exception(client.queryIndex({
    connection: pair.client,
    query: request({ queryId: QUERY_B }),
  }), { code: INDEX_QUERY_ERROR_CODES.OVERLOADED })
  t.is(client.pendingCount, 1)
  t.is(timerAllocations, afterFirst)
  work.resolve({ results: [], continuation: null, sourceRevision: '0:3' })
  await first
})

test('physical store execution cap survives cancellation across a fresh attachment', async t => {
  const work = gate()
  let calls = 0
  const indexStore = {
    async queryIndexPage() {
      calls++
      if (calls === 1) return work.promise
      return { results: [exactRow()], continuation: null, sourceRevision: '0:8' }
    },
  }
  const first = paired(t, indexStore, { serverLimits: { maxExecutingQueries: 1 } })
  const controller = new AbortController()
  const pending = first.client.queryIndex({
    connection: first.pair.client,
    query: request(),
    signal: controller.signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await t.exception(pending, { name: 'AbortError', code: 'ABORT_ERR' })
  await new Promise(resolve => setImmediate(resolve))
  t.is(first.server.pendingCount, 0)
  t.is(calls, 1)

  const second = paired(t, indexStore, { serverLimits: { maxExecutingQueries: 1 } })
  await t.exception(second.client.queryIndex({
    connection: second.pair.client,
    query: request({ queryId: QUERY_B }),
  }), { code: INDEX_QUERY_ERROR_CODES.OVERLOADED })
  t.is(calls, 1)

  work.resolve({ results: [], continuation: null, sourceRevision: '0:8' })
  await new Promise(resolve => setImmediate(resolve))
  const page = await second.client.queryIndex({
    connection: second.pair.client,
    query: request({ queryId: '07'.repeat(32) }),
  })
  t.alike(page.results, [exactResult()])
  t.is(calls, 2)
})

test('server returns bounded structured request result and remote errors', async t => {
  const detail = 'private '.repeat(1_000)
  const indexStore = {
    async queryIndexPage(input) {
      if (input.selectors[0].identifier === 'huge') return { results: Array.from({ length: MAX_INDEX_QUERY_RESULTS + 1 }, () => exactRow()), continuation: null, sourceRevision: '0:2' }
      const error = new Error(detail)
      error.code = 'UNEXPECTED_PRIVATE_STORE_ERROR'
      throw error
    },
  }
  const { client, pair } = paired(t, indexStore)
  await t.exception(client.queryIndex({
    connection: pair.client,
    query: request({
      selectors: Array.from({ length: MAX_INDEX_QUERY_SELECTORS + 1 }, (_, index) => exact(String(index).padStart(3, '0'))),
    }),
  }), /selectors.*limit|bounded/)
  await t.exception(client.queryIndex({ connection: pair.client, query: request({ selectors: [exact('huge')] }) }), { code: INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED })
  const remoteError = await client.queryIndex({
    connection: pair.client,
    query: request({ queryId: QUERY_B }),
  }).then(() => null, error => error)
  t.ok(remoteError, 'private store failure rejects')
  if (remoteError) {
    t.is(remoteError.code, INDEX_QUERY_ERROR_CODES.INTERNAL_ERROR)
    t.ok(b4a.byteLength(remoteError.detail) <= MAX_INDEX_QUERY_ERROR_DETAIL_BYTES)
    t.is(remoteError.detail.includes('private'), false)
  }
})

test('deadline before and while work runs cancels exactly one request and suppresses late pages', async t => {
  let clock = NOW + 1
  let beforeCalls = 0
  const beforeTimers = refedTimerAdapter()
  const before = paired(t, {
    async queryIndexPage() {
      beforeCalls++
      return { results: [], continuation: null, sourceRevision: '0:1' }
    },
  }, {
    serverLimits: { ...beforeTimers, now: () => clock++ },
    clientLimits: beforeTimers,
  })
  await t.exception(before.client.queryIndex({
    connection: before.pair.client,
    query: request({ deadlineMs: 1 }),
  }), { code: INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED })
  t.is(beforeCalls, 0)
  t.is(before.server.pendingCount, 0)

  const work = gate()
  const activeTimers = refedTimerAdapter()
  const indexStore = { async queryIndexPage() { return work.promise } }
  const { client, pair, server } = paired(t, indexStore, {
    serverLimits: activeTimers,
    clientLimits: activeTimers,
  })
  await t.exception(client.queryIndex({ connection: pair.client, query: request({ deadlineMs: 1 }) }), { code: INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED })
  t.is(client.pendingCount, 0)
  t.is(server.pendingCount, 0)
  work.resolve({ results: [exactRow()], continuation: null, sourceRevision: '0:1' })
  await new Promise(resolve => setImmediate(resolve))
  t.is(client.pendingCount, 0)
})

test('AbortSignal sends cancel rejects AbortError and suppresses a late page', async t => {
  const work = gate()
  const indexStore = { async queryIndexPage() { return work.promise } }
  const { client, pair, server } = paired(t, indexStore)
  const controller = new AbortController()
  const pending = client.queryIndex({ connection: pair.client, query: request(), signal: controller.signal })
  controller.abort()
  await t.exception(pending, { name: 'AbortError', code: 'ABORT_ERR' })
  await new Promise(resolve => setImmediate(resolve))
  t.is(client.pendingCount, 0)
  t.is(server.pendingCount, 0)
  work.resolve({ results: [exactRow()], continuation: null, sourceRevision: '0:1' })
  await new Promise(resolve => setImmediate(resolve))
  t.is(client.pendingCount, 0)
})

test('disconnect and close drain pending maps timers and preserve caller resources', async t => {
  const work = gate()
  const indexStore = { closeCount: 0, close() { this.closeCount++ }, async queryIndexPage() { return work.promise } }
  const { client, pair, server } = paired(t, indexStore)
  const pending = client.queryIndex({ connection: pair.client, query: request() })
  await new Promise(resolve => setImmediate(resolve))
  server.close('test-close')
  await t.exception(pending, { code: INDEX_QUERY_ERROR_CODES.CLOSED })
  t.is(client.pendingCount, 0)
  t.is(server.pendingCount, 0)
  t.is(indexStore.closeCount, 0)
  t.is(pair.client.destroyCount, 0)
  t.is(pair.server.destroyCount, 0)
  work.resolve({ results: [], continuation: null, sourceRevision: '0:1' })
})
