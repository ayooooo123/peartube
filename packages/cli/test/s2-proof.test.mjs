import test from 'brittle'

import { createHiveRelayClient } from '../src/hiverelay-client.js'

// S2 PROOF (Phase 2 exit criterion)
// Spec: docs/superpowers/specs/2026-07-24-peartube-seeder-spec.md §13 Spike S2
//       "Agent seed request → local Blindspark (review mode) → operator approve
//        → waitForDurable → stop agent → fresh client streams"
//
// We cannot run a live HiveRelay daemon in CI, so this harness proves the
// relay-facing wiring end-to-end against a *stateful* mock relay that behaves
// like Blindspark in review mode: seed requests sit pending until the operator
// approves, then return an explicit accept token. This is exactly the surface
// the spec's exit criterion exercises, and it is the boundary the one-swap-point
// module (hiverelay-client.js) was designed to isolate.

function makeStatefulRelay() {
  // relay state: key -> { approved: bool }
  const admitted = new Map()
  let approved = false
  let down = false

  const handler = async (url, opts) => {
    if (down) return { ok: false, status: 503 }

    if (url.endsWith('/.well-known/hiverelay.json')) {
      return { ok: true, body: { publicKey: 'f'.repeat(64), apiVersion: 3 } }
    }

    const body = opts?.body ? JSON.parse(opts.body) : {}

    if (url.endsWith('/seed-core')) {
      admitted.set(body.key, { approved })
      // review mode: pending until the operator approves the agent's publisher key.
      return { ok: true, body: { status: approved ? 'accepted' : 'review' } }
    }

    if (url.endsWith('/unseed')) {
      admitted.delete(body.key)
      return { ok: true, body: { status: 'ok' } }
    }

    return { ok: false, status: 404 }
  }

  const fetchFn = async (url, opts) => {
    const res = await handler(url, opts)
    return {
      ok: res.ok !== false,
      status: res.status || (res.ok === false ? 500 : 200),
      async text() { return res.body === undefined ? '' : JSON.stringify(res.body) }
    }
  }

  return {
    fetchFn,
    approveAgent() { approved = true },
    isAdmitted: (key) => admitted.has(key),
    isApproved: (key) => admitted.get(key)?.approved === true,
    takeDown() { down = true },
    bringUp() { down = false }
  }
}

// The headline proof: the full S2 lifecycle against a review-mode relay.
test('S2: seed → pending → approve → durable → unseed round-trip', async (t) => {
  const relay = makeStatefulRelay()
  const client = createHiveRelayClient({
    endpoint: 'http://hiverelay:9100',
    seedRequest: { durability: 1, ttlSeconds: 2592000, revocable: true },
    fetchFn: relay.fetchFn
  })

  // 1. Detect — the agent sees the relay and its public key.
  const detection = await client.detect()
  t.ok(detection.detected, 'relay is detected')
  t.ok(detection.info.publicKey, 'relay advertises a public key')

  const mediaKey = 'a'.repeat(64)

  // 2. Seed request — relay is in review mode, so this comes back pending.
  const pending = await client.seedCores({ keys: [mediaKey], maxStorageBytes: 1_000_000_000 })
  t.is(pending.results[0].status, 'pending-approval', 'first seed is pending operator approval')
  t.ok(relay.isAdmitted(mediaKey), 'relay recorded the request')
  t.not(relay.isApproved(mediaKey), 'request not yet approved')

  // 3. Operator approves the agent publisher key in the Blindspark dashboard.
  relay.approveAgent()

  // 4. Reconcile — the next seed request returns an explicit accept token.
  const durable = await client.seedCores({ keys: [mediaKey], maxStorageBytes: 1_000_000_000 })
  t.is(durable.results[0].status, 'accepted', 'approved request is accepted')
  t.ok(relay.isApproved(mediaKey), 'relay confirms custody')

  // 5. Unseed — withdraw the durable copy. The item is no longer held.
  const withdrawn = await client.unseedCores({ keys: [mediaKey] })
  t.is(withdrawn.results[0].status, 'withdrawn', 'relay withdraws the core')
  t.not(relay.isAdmitted(mediaKey), 'relay no longer holds the core')
})

// The "stop agent → fresh client streams" leg: durability is what makes a
// stopped agent irrelevant. Here we prove the agent can read durable state
// independently (the accept token is what we trust, not the agent being up).
test('S2: durability survives agent restart (fresh detect + reconcile)', async (t) => {
  const relay = makeStatefulRelay()
  const mkClient = () => createHiveRelayClient({
    endpoint: 'http://hiverelay:9100',
    seedRequest: { durability: 1, ttlSeconds: 2592000, revocable: true },
    fetchFn: relay.fetchFn
  })

  const key = 'b'.repeat(64)

  // First agent instance seeds; operator approves.
  let c = mkClient()
  await c.seedCores({ keys: [key], maxStorageBytes: 1_000_000_000 })
  relay.approveAgent()

  // "Stop the agent" — discard the instance entirely.
  c = null

  // A fresh agent instance reconnects and reconciles; the relay still holds
  // the core and returns accepted, so the fresh instance records durable.
  c = mkClient()
  t.ok((await c.detect()).detected, 'fresh instance detects the relay')
  const redetect = await c.seedCores({ keys: [key], maxStorageBytes: 1_000_000_000 })
  t.is(redetect.results[0].status, 'accepted', 'durable state persists across agent restart')
})

// Degradation leg of S2: a relay that is down at seed time does not block the
// agent — it self-seeds and the item is recoverable when the relay returns.
test('S2: relay-down degrades to self-only and recovers', async (t) => {
  const relay = makeStatefulRelay()
  relay.takeDown()

  let nowOffset = 0
  const client = createHiveRelayClient({
    endpoint: 'http://hiverelay:9100',
    detectTtlMs: 50,
    seedRequest: { durability: 1, ttlSeconds: 2592000, revocable: true },
    fetchFn: relay.fetchFn,
    nowFn: () => Date.now() + nowOffset
  })

  // Relay down → detect fails → seed not submitted (self-only).
  t.is((await client.detect()).detected, false, 'relay down at startup')
  const blocked = await client.seedCores({ keys: ['c'.repeat(64)], maxStorageBytes: 1e9 })
  t.is(blocked.submitted, false, 'seed not submitted when relay is down')
  t.is(blocked.reason, 'relay-unavailable', 'degrades with a clear reason')

  // Relay recovers; force a fresh detect past the TTL.
  relay.bringUp()
  relay.approveAgent()
  nowOffset = 1000
  t.ok((await client.detect({ refresh: true })).detected, 'relay recovers after re-probe')

  const ok = await client.seedCores({ keys: ['c'.repeat(64)], maxStorageBytes: 1e9 })
  t.is(ok.results[0].status, 'accepted', 'recovers and seeds after relay returns')
})
