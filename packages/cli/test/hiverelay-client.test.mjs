import test from 'brittle'

import { createHiveRelayClient } from '../src/hiverelay-client.js'

function makeFetch(handler) {
  return async (url, opts) => {
    const res = await handler(url, opts)
    return {
      ok: res.ok !== false,
      status: res.status || (res.ok === false ? 500 : 200),
      async text() { return res.body === undefined ? '' : JSON.stringify(res.body) }
    }
  }
}

// Regression (audit F1): detect() must re-probe after its TTL so a relay that
// was down at startup can recover mid-session instead of being pinned
// unavailable forever.
test('detect re-probes after the TTL (relay recovery)', async (t) => {
  let up = false
  let now = 1000
  const client = createHiveRelayClient({
    endpoint: 'http://relay.local',
    detectTtlMs: 100,
    nowFn: () => now,
    fetchFn: makeFetch(async () => up ? { ok: true, body: {} } : { ok: false, status: 503 })
  })

  t.is((await client.detect()).detected, false)

  // Relay comes up; within TTL the cached "down" is returned...
  up = true
  now = 1050
  t.is((await client.detect()).detected, false, 'cached within TTL')

  // ...past the TTL it re-probes and recovers.
  now = 1200
  t.is((await client.detect()).detected, true, 're-probes after TTL')
})

// Regression (audit F2): a 2xx with an empty/unknown body must NOT be recorded
// as durable — over-claiming durability is the dangerous direction.
test('seedCores does not claim durability on empty or unknown responses', async (t) => {
  const emptyBody = createHiveRelayClient({
    endpoint: 'http://relay.local',
    fetchFn: makeFetch(async () => ({ ok: true, body: undefined }))
  })
  const r1 = await emptyBody.seedCores({ keys: ['aa'] })
  t.is(r1.results[0].status, 'error', 'empty 200 body is not accepted')

  const denied = createHiveRelayClient({
    endpoint: 'http://relay.local',
    fetchFn: makeFetch(async () => ({ ok: true, body: { status: 'denied' } }))
  })
  const r2 = await denied.seedCores({ keys: ['aa'] })
  t.is(r2.results[0].status, 'error', 'explicit denial is not accepted')

  const accepted = createHiveRelayClient({
    endpoint: 'http://relay.local',
    fetchFn: makeFetch(async () => ({ ok: true, body: { status: 'accepted' } }))
  })
  t.is((await accepted.seedCores({ keys: ['aa'] })).results[0].status, 'accepted')

  const review = createHiveRelayClient({
    endpoint: 'http://relay.local',
    fetchFn: makeFetch(async () => ({ ok: true, body: { status: 'review' } }))
  })
  t.is((await review.seedCores({ keys: ['aa'] })).results[0].status, 'pending-approval')
})

// Regression (audit F3): the never-throws contract must hold even when the
// method is destructured off the object and given a non-iterable keys value.
test('seedCores/unseedCores never throw under misuse', async (t) => {
  const client = createHiveRelayClient({
    endpoint: 'http://relay.local',
    fetchFn: makeFetch(async () => ({ ok: true, body: { status: 'accepted' } }))
  })

  // Destructured (no `this`) + non-iterable keys.
  const { seedCores, unseedCores } = client
  await t.execution(seedCores({ keys: null }), 'seedCores resolves with null keys')
  await t.execution(unseedCores({ keys: 42 }), 'unseedCores resolves with non-iterable keys')
  await t.execution(seedCores({}), 'seedCores resolves with no keys')

  const r = await seedCores({ keys: null })
  t.alike(r.results, [], 'null keys yields empty results')
})

// Regression: no endpoint / no fetch degrades to detected:false, never throws.
test('missing endpoint or fetch degrades safely', async (t) => {
  const noEndpoint = createHiveRelayClient({ endpoint: null })
  t.is((await noEndpoint.detect()).detected, false)
  t.is((await noEndpoint.seedCores({ keys: ['aa'] })).submitted, false)

  const noFetch = createHiveRelayClient({ endpoint: 'http://relay.local', fetchFn: null })
  t.is((await noFetch.detect()).detected, false)
})
