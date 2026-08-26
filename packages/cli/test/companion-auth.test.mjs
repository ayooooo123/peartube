import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'

import {
  canonicalizePathAndQuery,
  createNonceStore,
  hashControlBody,
  signControlRequest,
  verifyControlRequest
} from '../src/companion/auth.js'

const NOW = 1_786_406_400_000
const SECRET = 'ab'.repeat(32)
const CLIENT = 'client-test'

const SEARCH_REQUEST_TARGET = '/api/v2/search?title=M*A*S*H%20~&kind=movie'
const CANONICAL_SEARCH_TARGET = '/api/v2/search?kind=movie&title=M*A*S*H+%7E'
const CANONICAL_SEARCH_MAC = 'af59194bdbdaf97c20fa751e81f34e6533bc57cdcad8ab6a4cabb75c5feaf3a1'

function macKey (secret) {
  return b4a.from(secret, 'hex')
}

function signedHeaders ({
  method = 'GET',
  path = '/api/v2/status',
  body = b4a.alloc(0),
  timestamp = NOW,
  nonce = 'nonce-00000001',
  client = CLIENT,
  secret = SECRET
} = {}) {
  const bodyHash = hashControlBody(body)
  const canonicalPath = path === '/api/v2/status?b=2&a=1'
    ? '/api/v2/status?a=1&b=2'
    : path
  const canonical = b4a.from([
    method.toUpperCase(),
    canonicalPath,
    String(timestamp),
    nonce,
    bodyHash
  ].join('\n'))
  const mac = b4a.alloc(sodium.crypto_auth_BYTES)
  sodium.crypto_auth(mac, canonical, macKey(secret))
  return {
    'X-PearTube-Client': client,
    'X-PearTube-Timestamp': String(timestamp),
    'X-PearTube-Nonce': nonce,
    'X-PearTube-MAC': b4a.toString(mac, 'hex')
  }
}

function verifier (overrides = {}) {
  return {
    method: 'GET',
    path: '/api/v2/status',
    bodyHash: hashControlBody(b4a.alloc(0)),
    headers: signedHeaders(),
    secret: SECRET,
    client: CLIENT,
    clock: () => NOW,
    nonceStore: createNonceStore({ maxEntries: 4 }),
    maxClockSkewMs: 30_000,
    ...overrides
  }
}

test('search targets use canonical form encoding for authentication', (t) => {
  t.is(canonicalizePathAndQuery(SEARCH_REQUEST_TARGET), CANONICAL_SEARCH_TARGET)
  const headers = signControlRequest({
    method: 'GET',
    path: SEARCH_REQUEST_TARGET,
    timestamp: NOW,
    nonce: 'canonical-nonce-01',
    client: CLIENT,
    secret: SECRET
  })
  t.is(headers['X-PearTube-MAC'], CANONICAL_SEARCH_MAC)
})

test('control MAC binds method, canonical path/query, timestamp, nonce, and body digest', (t) => {
  const body = b4a.from('{"probe":true}')
  const headers = signedHeaders({
    method: 'POST',
    path: '/api/v2/status?b=2&a=1',
    body,
    nonce: 'nonce-00000002'
  })
  const result = verifyControlRequest(verifier({
    method: 'POST',
    path: '/api/v2/status?a=1&b=2',
    bodyHash: hashControlBody(body),
    headers
  }))

  t.alike(result, { client: CLIENT, timestamp: NOW, nonce: 'nonce-00000002' })
})

test('control MAC rejects any changed canonical request component', (t) => {
  const mutations = [
    { method: 'DELETE' },
    { path: '/api/v2/other' },
    { bodyHash: hashControlBody(b4a.from('changed')) },
    { headers: signedHeaders({ timestamp: NOW + 1 }) },
    { headers: signedHeaders({ nonce: 'nonce-00000003' }) }
  ]

  // The timestamp and nonce fixtures above are valid signatures, so mutate the
  // verified value independently for those two cases.
  mutations[3].headers['X-PearTube-Timestamp'] = String(NOW)
  mutations[4].headers['X-PearTube-Nonce'] = 'nonce-00000004'

  for (const mutation of mutations) {
    t.exception(() => verifyControlRequest(verifier(mutation)), /Invalid companion authentication/)
  }
})

test('control MAC rejects stale requests without consuming their nonce', (t) => {
  const nonceStore = createNonceStore({ maxEntries: 4 })
  const headers = signedHeaders({ timestamp: NOW - 30_001, nonce: 'nonce-stale-0001' })

  t.exception(() => verifyControlRequest(verifier({ headers, nonceStore })), /Stale companion request/)
  t.is(nonceStore.has(CLIENT, 'nonce-stale-0001'), false)
})

test('invalid nonces are rejected before replay-store lookup', (t) => {
  const headers = signedHeaders()
  headers['X-PearTube-Nonce'] = 'x'
  let replayStoreTouched = false
  const nonceStore = {
    prune () {},
    has () {
      replayStoreTouched = true
      return false
    },
    add () {
      replayStoreTouched = true
      return true
    }
  }

  t.exception(() => verifyControlRequest(verifier({ headers, nonceStore })), /Invalid companion authentication/)
  t.is(replayStoreTouched, false)
})

test('control MAC accepts a nonce once and rejects its replay', (t) => {
  const nonceStore = createNonceStore({ maxEntries: 4 })
  const request = verifier({ nonceStore })

  verifyControlRequest(request)
  let error = null
  try {
    verifyControlRequest(request)
  } catch (caught) {
    error = caught
  }
  t.ok(error, 'replay is rejected')
  t.is(error?.statusCode, 409)
  t.is(error?.code, 'NONCE_REPLAY')
})

test('nonce tracking fails closed at capacity without evicting live entries', (t) => {
  const nonceStore = createNonceStore({ maxEntries: 2 })
  t.is(nonceStore.add(CLIENT, 'nonce-1', NOW), true)
  t.is(nonceStore.add(CLIENT, 'nonce-2', NOW + 1), true)
  t.is(nonceStore.add(CLIENT, 'nonce-3', NOW + 2), false)

  t.is(nonceStore.size, 2)
  t.is(nonceStore.has(CLIENT, 'nonce-1'), true)
  t.is(nonceStore.has(CLIENT, 'nonce-2'), true)
  t.is(nonceStore.has(CLIENT, 'nonce-3'), false)

  nonceStore.prune(NOW + 1)
  t.is(nonceStore.add(CLIENT, 'nonce-3', NOW + 2), true)
})

test('control MAC reports bounded authentication capacity exhaustion', (t) => {
  const nonceStore = createNonceStore({ maxEntries: 1 })
  verifyControlRequest(verifier({ nonceStore }))
  const headers = signedHeaders({ nonce: 'nonce-00000002' })

  let error = null
  try {
    verifyControlRequest(verifier({ headers, nonceStore }))
  } catch (caught) {
    error = caught
  }
  t.is(error?.statusCode, 503)
  t.is(error?.code, 'NONCE_STORE_FULL')
})
