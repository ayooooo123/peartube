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
