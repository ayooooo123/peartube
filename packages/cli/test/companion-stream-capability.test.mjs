import test from 'brittle'
import b4a from 'b4a'

import { createCompanionRouter } from '../src/companion/routes.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createStreamCapabilityStore } from '../src/companion/stream-capabilities.js'

const CLIENT = 'client-a'
const NOW = 1_786_406_400_000
const REF = 'A'.repeat(43)

function scope (overrides = {}) {
  return {
    clientIdentity: CLIENT,
    publicationId: 'pub-1',
    renditionId: 'rend-1',
    assetId: 'asset-1',
    methods: ['GET', 'HEAD'],
    ...overrides
  }
}

function request (method, url, overrides = {}) {
  return {
    method,
    url,
    headers: {},
    body: b4a.alloc(0),
    principal: { id: CLIENT, publisherId: 'publisher-1', scopes: new Set(['*']), isLocal: true },
    ...overrides
  }
}

function errorCode (operation) {
  try {
    operation()
  } catch (error) {
    return error.code
  }
  return null
}

function tokenFrom (url) {
  return new URL(url, 'http://companion.invalid').searchParams.get('cap')
}

function fakeTimers (start = NOW) {
  let now = start
  const scheduled = []
  const cleared = []
  return {
    now: () => now,
    advance (milliseconds) { now += milliseconds },
    scheduled,
    cleared,
    setTimeoutFn (callback, delay) {
      const handle = {
        callback,
        delay,
        unrefed: false,
        unref () { this.unrefed = true }
      }
      scheduled.push(handle)
      return handle
    },
    clearTimeoutFn (handle) {
      handle.cleared = true
      cleared.push(handle)
    }
  }
}

test('capabilities bind exact scope, methods, expiry, and reusable active leases', (t) => {
  let now = NOW
  const capabilities = createStreamCapabilityStore({
    now: () => now,
    randomBytes: () => b4a.alloc(32, 7),
    ttlMs: 100,
    maxEntries: 2,
    maxConcurrentUses: 2
  })
  const grant = capabilities.issue(scope())

  t.is(grant.token.length, 43)
  t.is(grant.expiresAt, NOW + 100)
  t.is(capabilities.size, 1)

  const first = capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))
  first.release()
  const repeated = capabilities.consume(grant.token, scope({ method: 'HEAD', methods: undefined }))
  repeated.release()

  t.is(errorCode(() => capabilities.consume(grant.token, scope({ clientIdentity: 'client-b', method: 'GET', methods: undefined }))), 'CAPABILITY_SCOPE_MISMATCH')
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ publicationId: 'pub-2', method: 'GET', methods: undefined }))), 'CAPABILITY_SCOPE_MISMATCH')
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ renditionId: 'rend-2', method: 'GET', methods: undefined }))), 'CAPABILITY_SCOPE_MISMATCH')
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'POST', methods: undefined }))), 'CAPABILITY_SCOPE_MISMATCH')
  t.is(errorCode(() => capabilities.consume('B'.repeat(43), scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')

  now += 100
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_EXPIRED')
  t.is(capabilities.size, 0)
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')
})

test('capability concurrency is acquired, released, and closed without consuming the lease', (t) => {
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 8),
    maxConcurrentUses: 2
  })
  const grant = capabilities.issue(scope())
  const requestScope = scope({ method: 'GET', methods: undefined })
  const first = capabilities.consume(grant.token, requestScope)
  const second = capabilities.consume(grant.token, requestScope)

  t.is(errorCode(() => capabilities.consume(grant.token, requestScope)), 'CAPABILITY_CONCURRENCY_EXHAUSTED')
  first.release()
  first.release()
  const third = capabilities.consume(grant.token, requestScope)
  second.release()
  third.release()

  t.is(capabilities.close(grant.token), true)
  t.is(capabilities.close(grant.token), false)
  t.is(capabilities.size, 0)
  t.is(errorCode(() => capabilities.consume(grant.token, requestScope)), 'CAPABILITY_INVALID')
})

test('expiry pruning reclaims bounded capacity without evicting live capabilities', (t) => {
  let now = NOW
  let byte = 1
  const capabilities = createStreamCapabilityStore({
    now: () => now,
    randomBytes: () => b4a.alloc(32, byte++),
    ttlMs: 10,
    maxEntries: 1
  })
  const live = capabilities.issue(scope())
  t.is(errorCode(() => capabilities.issue(scope({ publicationId: 'pub-2' }))), 'CAPABILITY_CAPACITY_EXHAUSTED')
  const active = capabilities.consume(live.token, scope({ method: 'GET', methods: undefined }))
  active.release()

  now += 10
  const replacement = capabilities.issue(scope({ publicationId: 'pub-2' }))
  t.is(capabilities.size, 1)
  t.is(replacement.publicationId, 'pub-2')
})

test('idle expiry timer retires assets and defers active release until acquisition cleanup', async (t) => {
  const timers = fakeTimers()
  let byte = 30
  let releases = 0
  const capabilities = createStreamCapabilityStore({
    now: timers.now,
    randomBytes: () => b4a.alloc(32, byte++),
    ttlMs: 100,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  })
  const idle = capabilities.issue({
    ...scope(),
    asset: { assetId: 'asset-1', async release () { releases++ } }
  })
  const idleTimer = timers.scheduled.at(-1)
  t.is(idleTimer.delay, 100)
  t.is(idleTimer.unrefed, true)

  timers.advance(100)
  idleTimer.callback()
  await capabilities.drain()
  t.is(releases, 1)
  t.is(capabilities.size, 0)
  t.is(errorCode(() => capabilities.consume(idle.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')

  const activeGrant = capabilities.issue({
    ...scope({ publicationId: 'pub-active' }),
    asset: { assetId: 'asset-1', async release () { releases++ } }
  })
  const acquisition = capabilities.consume(activeGrant.token, {
    publicationId: 'pub-active',
    renditionId: 'rend-1',
    method: 'GET'
  })
  const activeTimer = timers.scheduled.at(-1)
  timers.advance(100)
  activeTimer.callback()
  await capabilities.drain()
  t.is(releases, 1)
  t.is(capabilities.size, 0)

  acquisition.release()
  await capabilities.drain()
  t.is(releases, 2)
})

test('capability expiry timer reschedules on issue and close then cancels on clear', async (t) => {
  const timers = fakeTimers()
  let byte = 40
  let releases = 0
  const capabilities = createStreamCapabilityStore({
    now: timers.now,
    randomBytes: () => b4a.alloc(32, byte++),
    ttlMs: 100,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  })
  const first = capabilities.issue({
    ...scope(),
    asset: { assetId: 'asset-1', async release () { releases++ } }
  })
  const firstTimer = timers.scheduled.at(-1)
  timers.advance(20)
  capabilities.issue({
    ...scope({ publicationId: 'pub-2', assetId: 'asset-2' }),
    asset: { assetId: 'asset-2', async release () { releases++ } }
  })
  const secondTimer = timers.scheduled.at(-1)
  t.is(firstTimer.cleared, true)
  t.is(secondTimer.delay, 80)

  t.is(capabilities.close(first.token), true)
  const finalTimer = timers.scheduled.at(-1)
  t.is(secondTimer.cleared, true)
  t.is(finalTimer.delay, 100)

  capabilities.clear()
  await capabilities.drain()
  t.is(finalTimer.cleared, true)
  t.is(capabilities.size, 0)
  t.is(releases, 2)
})

test('open preserves its response shape and embeds the resolved asset only in the capability', async (t) => {
  let calls = 0
  const asset = {
    assetId: 'asset-1',
    byteLength: 8,
    async requestRange () {},
    async release () {}
  }
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 9),
    maxConcurrentUses: 1
  })
  const router = createCompanionRouter({
    service: {
      async openStream () {
        calls++
        return {
          publicationId: 'pub-1',
          renditionId: 'rend-1',
          assetId: 'asset-1',
          asset
        }
      }
    },
    config: { client: { id: CLIENT } },
    clock: () => NOW,
    capabilities
  })
  const opened = await router.dispatch(request('POST', '/api/v2/streams/open', {
    body: b4a.from(`{"candidateRef":"${REF}"}`)
  }))
  const token = tokenFrom(opened.body.url)

  t.is(opened.statusCode, 200)
  t.alike(Object.keys(opened.body).sort(), ['expiresAt', 'publicationId', 'renditionId', 'url'])
  t.is(opened.body.url, `/api/v2/stream/pub-1/rend-1?cap=${token}`)
  t.not(opened.body.url.includes(CLIENT), true)
  t.not(opened.body.url.includes('asset-1'), true)
  t.is(calls, 1)

  const exact = { publicationId: 'pub-1', renditionId: 'rend-1', method: 'GET' }
  const held = capabilities.consume(token, exact)
  t.is(held.asset, asset)
  t.is(errorCode(() => capabilities.consume(token, exact)), 'CAPABILITY_CONCURRENCY_EXHAUSTED')
  t.is(errorCode(() => capabilities.consume(token, { ...exact, publicationId: 'pub-2' })), 'CAPABILITY_SCOPE_MISMATCH')
  t.is(errorCode(() => capabilities.consume('C'.repeat(43), exact)), 'CAPABILITY_INVALID')
  t.is(errorCode(() => capabilities.consume(token, { ...exact, clientIdentity: 'client-b' })), 'CAPABILITY_SCOPE_MISMATCH')
  held.release()
  const replay = capabilities.consume(token, { ...exact, method: 'HEAD' })
  replay.release()
})

test('local stream open returns the loopback Hypercore blob URL without a media capability hop', async t => {
  const blobUrl = `http://127.0.0.1:49731/?key=${'a'.repeat(64)}&blob=0%3A1%3A0%3A8&type=video%2Fmp4&token=${'b'.repeat(64)}`
  let openedInput = null
  const capabilities = createStreamCapabilityStore({ now: () => NOW })
  const router = createCompanionRouter({
    service: {
      async openPublication (input) {
        openedInput = input
        return {
          schemaVersion: 1,
          streamId: 'stream-1',
          publicationId: 'pub-1',
          renditionId: 'rend-1',
          assetId: 'asset-1',
          byteLength: 8,
          mimeType: 'video/mp4',
          capability: null,
          expiresAt: NOW + 60_000,
          etag: '"asset-asset-1"',
          url: blobUrl
        }
      }
    },
    config: { client: { id: CLIENT }, transport: 'tcp' },
    clock: () => NOW,
    capabilities
  })

  const opened = await router.dispatch(request('POST', '/api/v2/streams/open', {
    body: b4a.from('{"publicationId":"pub-1","renditionId":"rend-1","startOffsetSeconds":968.4,"durationSeconds":1320}'),
    serverState: { transport: 'tcp', host: '127.0.0.1', port: 8175 }
  }))

  t.is(opened.statusCode, 200)
  t.is(opened.body.url, blobUrl)
  t.alike(
    [openedInput.publicationId, openedInput.renditionId, openedInput.startOffsetSeconds, openedInput.durationSeconds, openedInput.localTransport],
    ['pub-1', 'rend-1', 968.4, 1320, true]
  )
  t.is(capabilities.size, 0, 'blob playback does not retain a companion media capability')
})

test('retiring an active capability releases its asset exactly once after acquisition cleanup', async (t) => {
  let releases = 0
  const asset = {
    assetId: 'asset-1',
    async release () { releases++ }
  }
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 10),
    maxConcurrentUses: 1
  })
  const grant = capabilities.issue({ ...scope(), asset })
  const acquisition = capabilities.consume(grant.token, {
    publicationId: 'pub-1',
    renditionId: 'rend-1',
    method: 'GET'
  })

  t.is(capabilities.close(grant.token), true)
  t.is(releases, 0)
  acquisition.release()
  acquisition.release()
  await capabilities.drain()
  t.is(releases, 1)
  t.is(capabilities.close(grant.token), false)
})

test('server shutdown clears capabilities and duplicate close is safe', async (t) => {
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 11)
  })
  const grant = capabilities.issue(scope())
  const server = createCompanionServer({
    service: {},
    config: { enabled: false, transport: 'tcp' },
    clock: () => NOW,
    capabilities
  })

  await server.close()
  await server.close()
  t.is(capabilities.size, 0)
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')
})

test('failed server creation clears live capabilities before retry', async (t) => {
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 12)
  })
  const grant = capabilities.issue(scope())
  let attempts = 0
  const server = createCompanionServer({
    service: {},
    config: {
      enabled: true,
      transport: 'tcp',
      host: '127.0.0.1',
      port: 0,
      sharedSecret: 'a'.repeat(64)
    },
    clock: () => NOW,
    capabilities,
    createServer () {
      attempts++
      throw new Error('server factory failed')
    }
  })

  await t.exception(server.start(), /server factory failed/)
  t.is(capabilities.size, 0)
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')

  await t.exception(server.start(), /server factory failed/)
  t.is(attempts, 2)
  t.is(errorCode(() => capabilities.consume(grant.token, scope({ method: 'GET', methods: undefined }))), 'CAPABILITY_INVALID')
})
