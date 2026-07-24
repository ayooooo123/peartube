import test from 'brittle'

import { createArchivePolicy } from '../src/archive/policy.js'

test('archive policy reserves bytes before pledge acceptance and reconciles expiry atomically', (t) => {
  const policy = createArchivePolicy({ capacityBytes: 10, now: () => 1 })
  const one = policy.reserve({ pledgeId: 'p1', bytes: 6, expiresAt: 5 })
  t.is(one.accepted, true)
  t.is(policy.availableBytes(), 4)
  t.is(policy.reserve({ pledgeId: 'p2', bytes: 5, expiresAt: 5 }).accepted, false)
  policy.reconcile({ pledgeId: 'p1', actualBytes: 4 })
  t.is(policy.availableBytes(), 6)
  policy.expire(6)
  t.is(policy.availableBytes(), 10)
})
