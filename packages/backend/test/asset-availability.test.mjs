import test from 'brittle'
import b4a from 'b4a'

import {
  assertAssetRangeSummaryPage,
  assessAvailability,
  createAvailabilitySummary,
  listAssetRanges,
  verifyAvailabilityDelivery,
} from '../src/assets/availability.js'
import {
  MAX_ASSET_RANGE_BITS_PER_RANGE,
  MAX_ASSET_RANGE_PAGE_RANGES,
} from '../src/network/frame.js'

const assetId = b4a.alloc(32, 19)

function sparseCore(length, present) {
  let probes = 0
  return {
    length,
    byteLength: length * 256 * 1024,
    get probes() { return probes },
    async has(index) {
      probes++
      return present.has(index)
    },
  }
}

test('local asset inventory pages sparse possession with canonical cursors and bitfields', async (t) => {
  const core = sparseCore(4100, new Set([0, 1, 4, 5, 4096, 4099]))
  const first = await listAssetRanges({
    assetId,
    core,
    coreLength: 4100,
    byteLength: 4100 * 256 * 1024,
    cursor: null,
    limit: MAX_ASSET_RANGE_PAGE_RANGES,
  })
  t.alike(first, {
    ranges: [{ startBlock: 0, bitCount: 6, presentBitfield: b4a.from([0x33]) }],
    nextCursor: '4096',
  })

  const second = await listAssetRanges({
    assetId,
    core,
    coreLength: 4100,
    byteLength: 4100 * 256 * 1024,
    cursor: first.nextCursor,
    limit: 1,
  })
  t.alike(second, {
    ranges: [{ startBlock: 4096, bitCount: 4, presentBitfield: b4a.from([0x09]) }],
    nextCursor: null,
  })
})

test('local inventory does bounded work across empty sparse regions', async (t) => {
  const core = sparseCore(MAX_ASSET_RANGE_BITS_PER_RANGE * 2, new Set())
  const page = await listAssetRanges({
    assetId,
    core,
    coreLength: core.length,
    byteLength: core.byteLength,
    cursor: null,
    limit: 1,
  })
  t.alike(page, { ranges: [], nextCursor: String(MAX_ASSET_RANGE_BITS_PER_RANGE) })
  t.is(core.probes, MAX_ASSET_RANGE_BITS_PER_RANGE)
})

test('local inventory checks liveness around every awaited possession probe', async (t) => {
  let live = true
  let probes = 0
  let releaseProbe
  const core = {
    length: 2,
    byteLength: 2 * 256 * 1024,
    async has() {
      probes++
      return new Promise(resolve => { releaseProbe = resolve })
    },
  }
  const pending = listAssetRanges({
    assetId,
    core,
    coreLength: core.length,
    byteLength: core.byteLength,
    cursor: null,
    limit: 1,
    isActive: () => live,
  })
  while (!releaseProbe) await Promise.resolve()
  live = false
  releaseProbe(true)
  await t.exception(pending, /cancelled/)
  t.is(probes, 1, 'a cancelled scan never probes the next block')

  await t.exception(listAssetRanges({
    assetId,
    core,
    coreLength: core.length,
    byteLength: core.byteLength,
    cursor: null,
    limit: 1,
    isActive: () => false,
  }), /cancelled/)
  t.is(probes, 1, 'pre-cancelled scans do not enter core.has')
})

test('inventory rejects wrong identities, invalid core state, and noncanonical pages', async (t) => {
  const core = sparseCore(10, new Set([1]))
  await t.exception(listAssetRanges({
    assetId: b4a.alloc(31),
    core,
    coreLength: 10,
    byteLength: core.byteLength,
    cursor: null,
    limit: 1,
  }), /assetId/)
  await t.exception(listAssetRanges({
    assetId,
    core: { ...core, length: 9 },
    coreLength: 10,
    byteLength: core.byteLength,
    cursor: null,
    limit: 1,
  }), /core length/)
  await t.exception(listAssetRanges({
    assetId,
    core,
    coreLength: 10,
    byteLength: core.byteLength,
    cursor: '01',
    limit: 1,
  }), /cursor/)

  t.exception(() => assertAssetRangeSummaryPage({
    assetId,
    ranges: [
      { startBlock: 0, bitCount: 1, presentBitfield: b4a.from([1]) },
      { startBlock: 1, bitCount: 1, presentBitfield: b4a.from([1]) },
    ],
    nextCursor: null,
  }, { assetId, coreLength: 10, cursor: null, limit: 2 }), /non-adjacent/)
  t.exception(() => assertAssetRangeSummaryPage({
    assetId: b4a.alloc(32, 20),
    ranges: [],
    nextCursor: null,
  }, { assetId, coreLength: 10, cursor: null, limit: 1 }), /assetId/)
})

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
