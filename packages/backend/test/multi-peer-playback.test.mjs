import test from 'brittle'

import { createMultiPeerScheduler } from '../src/playback/multi-peer-scheduler.js'

test('multi-peer scheduler prefers complete local data and never opens peers for local hits', async (t) => {
  const scheduler = createMultiPeerScheduler({
    local: { hasRange: range => range.start === 0 && range.end === 4 },
    peers: [{ id: 'fast', ranges: [{ start: 0, end: 4 }], latencyMs: 1, throughput: 10 }],
  })
  const result = await scheduler.requestRange({ start: 0, end: 4, purpose: 'startup' })
  t.is(result.source, 'local')
  t.is(scheduler.metrics().peerRequests, 0)
})

test('multi-peer scheduler picks verified fast partial peers and rejects lying availability', async (t) => {
  const scheduler = createMultiPeerScheduler({
    local: { hasRange: () => false },
    peers: [
      { id: 'slow-complete', ranges: [{ start: 0, end: 20 }], latencyMs: 50, throughput: 1 },
      { id: 'fast-partial', ranges: [{ start: 4, end: 8 }], latencyMs: 5, throughput: 10 },
      { id: 'lying', ranges: [{ start: 4, end: 8 }], latencyMs: 1, throughput: 100, verify: () => false },
    ],
  })
  const result = await scheduler.requestRange({ start: 4, end: 8, purpose: 'seek' })
  t.is(result.source, 'peer')
  t.is(result.peerId, 'fast-partial')
  t.is(result.verified, true)
})

test('multi-peer scheduler returns structured unavailability before ad hoc origin fallback', async (t) => {
  const scheduler = createMultiPeerScheduler({ local: { hasRange: () => false }, peers: [] })
  const result = await scheduler.requestRange({ start: 10, end: 12, purpose: 'startup', deadlineMs: 1 })
  t.is(result.status, 'unavailable')
  t.is(result.errorCode, 'AVAILABILITY_BOUNDARY', 'unavailability uses the bounded playback vocabulary')
  t.is(result.originAttempted, false)
})

test('multi-peer scheduler cancels stale work and releases reservations on seek', async (t) => {
  const scheduler = createMultiPeerScheduler({ local: { hasRange: () => false }, maxInFlightBytes: 8, peers: [{ id: 'a', ranges: [{ start: 0, end: 100 }], latencyMs: 1, throughput: 1 }] })
  scheduler.reserveBackground({ start: 0, end: 8 })
  t.is(scheduler.metrics().inFlightBytes, 8)
  scheduler.seek({ start: 50, end: 52 })
  t.is(scheduler.metrics().inFlightBytes, 0)
})
