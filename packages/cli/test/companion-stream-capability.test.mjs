import test from 'brittle'
import b4a from 'b4a'

import { createCompanionRouter } from '../src/companion/routes.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createStreamCapabilityStore } from '../src/companion/stream-capabilities.js'

const CLIENT = 'mediastorm-a'
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
    clientIdentity: CLIENT,
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

  t.is(errorCode(() => capabilities.consume(grant.token, scope({ clientIdentity: 'mediastorm-b', method: 'GET', methods: undefined }))), 'CAPABILITY_SCOPE_MISMATCH')
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

test('open preserves its response shape and stream failures precede backend delegation', async (t) => {
  let calls = 0
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 9),
    maxConcurrentUses: 1
  })
  const router = createCompanionRouter({
    service: {
      async verifyIndexCandidate () {
        return {
          candidateRef: REF,
          publication: { publicationId: 'pub-1' },
          rendition: { renditionId: 'rend-1' },
          asset: { assetId: 'asset-1' }
        }
      },
      async streamAsset () {
        calls++
        return { ok: true }
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

  const held = capabilities.consume(token, scope({ method: 'GET', methods: undefined }))
  const overConcurrency = await router.dispatch(request('GET', opened.body.url))
  t.is(overConcurrency.statusCode, 429)
  t.is(overConcurrency.body.error.code, 'CAPABILITY_CONCURRENCY_EXHAUSTED')
  held.release()

  t.is((await router.dispatch(request('GET', `/api/v2/stream/pub-2/rend-1?cap=${token}`))).statusCode, 403)
  t.is((await router.dispatch(request('GET', `/api/v2/stream/pub-1/rend-1?cap=${'C'.repeat(43)}`))).statusCode, 403)
  const otherClient = request('GET', opened.body.url, { clientIdentity: 'mediastorm-b' })
  t.is((await router.dispatch(otherClient)).statusCode, 403)
  t.is((await router.dispatch(request('POST', opened.body.url))).statusCode, 405)
  t.is(calls, 0)

  t.is((await router.dispatch(request('GET', opened.body.url))).statusCode, 200)
  t.is(calls, 1)
})

test('stream delegation releases acquisition after backend error', async (t) => {
  let calls = 0
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 10),
    maxConcurrentUses: 1
  })
  const grant = capabilities.issue(scope())
  const router = createCompanionRouter({
    service: {
      async streamAsset () {
        calls++
        if (calls === 1) throw new Error('backend failed')
        return { ok: true }
      }
    },
    capabilities
  })
  const url = `/api/v2/stream/pub-1/rend-1?cap=${grant.token}`

  t.is((await router.dispatch(request('GET', url))).statusCode, 502)
  t.is((await router.dispatch(request('GET', url))).statusCode, 200)
  t.is(calls, 2)
})

test('server shutdown clears capabilities and duplicate close is safe', async (t) => {
  const capabilities = createStreamCapabilityStore({
    now: () => NOW,
    randomBytes: () => b4a.alloc(32, 11)
  })
  const grant = capabilities.issue(scope())
  const server = createCompanionServer({
    service: {},
    config: { enabled: false, transport: 'unix' },
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
