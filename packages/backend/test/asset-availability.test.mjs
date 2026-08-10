import test from 'brittle'
import b4a from 'b4a'

import {
  assertAssetRangeSummaryPage,
  listAssetRanges,
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
