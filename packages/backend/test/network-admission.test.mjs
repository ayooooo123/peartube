import test from 'brittle'

import { createNetworkAdmission } from '../src/network/index.js'

test('network admission enforces tokens, bytes, verification, and in-flight reservations', (t) => {
  const admission = createNetworkAdmission({ maxMessages: 2, maxBytes: 20, maxVerifications: 1, maxInFlightBytes: 12, refillPerTick: 0 })

  const first = admission.reserve({ peerId: 'peer-a', bytes: 6, verify: true })
  t.is(first.accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 6, verify: true }).reason, 'verification-budget')
  first.release()

  const second = admission.reserve({ peerId: 'peer-a', bytes: 8 })
  t.is(second.accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 5 }).reason, 'message-budget')
  second.release()
})

test('network admission releases reservations on success, timeout, cancellation, and disconnect', (t) => {
  const admission = createNetworkAdmission({ maxMessages: 10, maxBytes: 100, maxInFlightBytes: 10 })
  const a = admission.reserve({ peerId: 'peer-a', bytes: 10 })
  t.is(a.accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).reason, 'in-flight-bytes')
  a.release('timeout')
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 10 }).accepted, true)
  admission.disconnect('peer-a')
  t.is(admission.snapshot('peer-a').inFlightBytes, 0)
})

test('network admission evicts peer state on disconnect instead of holding a lifetime quota', (t) => {
  const admission = createNetworkAdmission({ maxMessages: 1, maxBytes: 100 })

  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).reason, 'message-budget')
  t.is(admission.peerCount(), 1)

  admission.disconnect('peer-a')
  t.is(admission.peerCount(), 0, 'disconnect must drop the peer entry, not just reset counters')
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).accepted, true, 'a reconnecting peer starts from a clean budget')

  admission.disconnect('peer-b')
  t.is(admission.peerCount(), 1, 'disconnecting an unknown peer must not allocate state')
})

test('network admission refills message and byte budgets on the configured tick', (t) => {
  let clock = 0
  const admission = createNetworkAdmission({
    maxMessages: 2,
    maxBytes: 20,
    refillPerTick: 1,
    refillIntervalMs: 100,
    now: () => clock,
  })

  t.is(admission.reserve({ peerId: 'peer-a', bytes: 10 }).accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 10 }).accepted, true)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).reason, 'message-budget')

  clock = 99
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 1 }).reason, 'message-budget', 'a partial tick refills nothing')

  clock = 100
  t.is(admission.snapshot('peer-a').messages, 1)
  t.is(admission.snapshot('peer-a').bytes, 10)
  t.is(admission.reserve({ peerId: 'peer-a', bytes: 10 }).accepted, true)

  clock = 100000
  t.is(admission.snapshot('peer-a').messages, 0, 'refill never goes negative')
  t.is(admission.snapshot('peer-a').bytes, 0)
})
