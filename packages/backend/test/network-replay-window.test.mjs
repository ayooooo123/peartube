import test from 'brittle'

import { createReplayWindow } from '../src/network/index.js'

test('replay window accepts monotonic nonces and rejects repeats/regression', (t) => {
  const window = createReplayWindow({ maxEntries: 3, maxSkewMs: 1000, now: () => 10_000 })

  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 1, timestamp: 10_000 }).accepted, true)
  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 1, timestamp: 10_000 }).accepted, false)
  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 0, timestamp: 10_000 }).reason, 'replay')
  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 2, timestamp: 10_000 }).accepted, true)
  t.is(window.accept({ peerId: 'peer-a', purpose: 'publisher', nonce: 1, timestamp: 10_000 }).accepted, true, 'purpose isolates replay state')
})

test('replay window bounds wall clock skew and stored peer windows', (t) => {
  const window = createReplayWindow({ maxEntries: 2, maxSkewMs: 1000, now: () => 10_000 })

  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 1, timestamp: 8500 }).reason, 'clock-skew')
  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 1, timestamp: 11_500 }).reason, 'clock-skew')
  t.is(window.accept({ peerId: 'peer-a', purpose: 'asset', nonce: 1, timestamp: 10_000 }).accepted, true)
  t.is(window.accept({ peerId: 'peer-b', purpose: 'asset', nonce: 1, timestamp: 10_000 }).accepted, true)
  t.is(window.accept({ peerId: 'peer-c', purpose: 'asset', nonce: 1, timestamp: 10_000 }).accepted, true)
  t.is(window.hasPeer('peer-a'), false, 'oldest peer state is evicted')
})
