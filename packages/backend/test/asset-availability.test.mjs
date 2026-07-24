import test from 'brittle'

import { createAvailabilitySummary, verifyAvailabilityDelivery } from '../src/assets/availability.js'

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
