import test from 'brittle'

import {
  assessAvailability,
  createAvailabilitySummary,
  verifyAvailabilityDelivery,
} from '../src/assets/availability.js'

test('availability summaries normalize bounded ranges and reject malicious claims', (t) => {
  const summary = createAvailabilitySummary({ renditionId: 'rendition-1', coreLength: 100, ranges: [{ start: 10, end: 20 }, { start: 0, end: 5 }] })
  t.alike(summary.ranges, [{ start: 0, end: 5 }, { start: 10, end: 20 }])
  t.exception(() => createAvailabilitySummary({ renditionId: 'r', coreLength: 100, ranges: [{ start: -1, end: 2 }] }), /range/)
  t.exception(() => createAvailabilitySummary({ renditionId: 'r', coreLength: 100, ranges: [{ start: 5, end: 5 }] }), /range/)
  t.exception(() => createAvailabilitySummary({ renditionId: 'r', coreLength: 100, ranges: [{ start: 0, end: 101 }] }), /range/)
  t.exception(() => createAvailabilitySummary({ renditionId: 'r', coreLength: 100, ranges: Array.from({ length: 129 }, () => ({ start: 0, end: 1 })) }), /too many/)
})

test('availability delivery verifies actual delivered ranges rather than trusting summaries', (t) => {
  const summary = createAvailabilitySummary({ renditionId: 'rendition-1', coreLength: 100, ranges: [{ start: 0, end: 10 }] })
  t.is(verifyAvailabilityDelivery(summary, { renditionId: 'rendition-1', delivered: [{ start: 0, end: 10 }] }), true)
  t.is(verifyAvailabilityDelivery(summary, { renditionId: 'rendition-1', delivered: [{ start: 0, end: 9 }] }), false)
  t.is(verifyAvailabilityDelivery(summary, { renditionId: 'other', delivered: [{ start: 0, end: 10 }] }), false)
})

test('publication availability is healthy only with fresh complete independent peer ranges', (t) => {
  const snapshot = assessAvailability({
    renditionId: 'rendition-1',
    requiredRanges: [{ start: 0, end: 100 }],
    peers: [
      { transportKey: 'noise-a', connected: true, advertisedAt: 800, verifiedAt: 900, challengeStatus: 'passed', advertisedRanges: [{ start: 0, end: 100 }] },
      { transportKey: 'noise-b', connected: true, advertisedAt: 810, verifiedAt: 910, challengeStatus: 'passed', advertisedRanges: [{ start: 0, end: 100 }] },
    ],
  }, { now: 1_000 })

  t.is(snapshot.state, 'healthy')
  t.is(snapshot.observedAt, 1_000)
  t.is(snapshot.expiresAt, 60_900)
  t.is(snapshot.requiredRangeCount, 1)
  t.is(snapshot.reachableRangeCount, 1)
  t.is(snapshot.independentPeerCount, 2)
  t.alike(snapshot.reasonCodes, ['COMPLETE_PEER_EVIDENCE'])
})

test('publication availability reports limited, awaiting replication, and unavailable states', (t) => {
  const limited = assessAvailability({
    renditionId: 'rendition-1',
    requiredRanges: [{ start: 0, end: 100 }],
    peers: [
      { transportKey: 'noise-a', connected: true, advertisedAt: 800, verifiedAt: 900, challengeStatus: 'passed', advertisedRanges: [{ start: 0, end: 50 }] },
      { transportKey: 'noise-b', connected: true, advertisedAt: 810, verifiedAt: 910, challengeStatus: 'passed', advertisedRanges: [{ start: 50, end: 100 }] },
    ],
  }, { now: 1_000 })
  t.is(limited.state, 'limited')
  t.is(limited.requiredRangeCount, 1)
  t.is(limited.reachableRangeCount, 1)
  t.is(limited.independentPeerCount, 2)
  t.ok(limited.reasonCodes.includes('INSUFFICIENT_COMPLETE_PEERS'))

  const archiveOnly = assessAvailability({
    renditionId: 'rendition-1',
    requiredRanges: [{ start: 0, end: 100 }],
    archivePledgeCount: 1,
  }, { now: 1_000 })
  t.is(archiveOnly.state, 'awaiting-replication')
  t.is(archiveOnly.requiredRangeCount, 1)
  t.is(archiveOnly.reachableRangeCount, 0)
  t.is(archiveOnly.independentPeerCount, 0)
  t.ok(archiveOnly.reasonCodes.includes('ARCHIVE_PLEDGE_ONLY'))

  const expired = assessAvailability({
    renditionId: 'rendition-1',
    requiredRanges: [{ start: 0, end: 100 }],
    peers: [
      { transportKey: 'noise-a', connected: true, advertisedAt: 800, verifiedAt: 900, challengeStatus: 'passed', advertisedRanges: [{ start: 0, end: 100 }] },
      { transportKey: 'noise-b', connected: true, advertisedAt: 810, verifiedAt: 910, challengeStatus: 'passed', advertisedRanges: [{ start: 0, end: 100 }] },
    ],
  }, { now: 61_000 })
  t.is(expired.state, 'unavailable')
  t.is(expired.reachableRangeCount, 0)
  t.is(expired.independentPeerCount, 0)
  t.ok(expired.reasonCodes.includes('EVIDENCE_EXPIRED'))
})
