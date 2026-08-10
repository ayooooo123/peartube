import b4a from 'b4a'

import {
  MAX_ASSET_RANGE_BITS_PER_RANGE,
  MAX_ASSET_RANGE_PAGE_RANGES,
  decodeAssetRangeSummaryPage,
  encodeAssetRangeSummaryPage,
  normalizeAssetCursor,
  normalizeAssetId,
} from '../network/frame.js'

function nonNegativeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

function boundedLimit(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ASSET_RANGE_PAGE_RANGES) {
    throw new Error(`limit must be an integer between 1 and ${MAX_ASSET_RANGE_PAGE_RANGES}`)
  }
  return value
}

function assertCoreState(core, coreLength, byteLength) {
  if (!core || typeof core.has !== 'function') throw new Error('asset core is unavailable')
  if (core.length !== coreLength) throw new Error('asset core length does not match the verified descriptor')
  if (core.byteLength !== byteLength) throw new Error('asset core byte length does not match the verified descriptor')
}

function trimPresentBitfield(bitfield, windowStart, firstPresent, lastPresent) {
  const bitCount = lastPresent - firstPresent + 1
  const output = b4a.alloc(Math.ceil(bitCount / 8))
  for (let index = firstPresent; index <= lastPresent; index++) {
    const sourceBit = index - windowStart
    if ((bitfield[sourceBit >> 3] & (1 << (sourceBit & 7))) === 0) continue
    const targetBit = index - firstPresent
    output[targetBit >> 3] |= 1 << (targetBit & 7)
  }
  return { bitCount, presentBitfield: output }
}

export function assertAssetRangeSummaryPage(page = {}, options = {}) {
  const expectedAssetId = normalizeAssetId(options.assetId)
  const actualAssetId = normalizeAssetId(page.assetId)
  if (!b4a.equals(actualAssetId, expectedAssetId)) throw new Error('asset range summary assetId mismatch')
  const payload = encodeAssetRangeSummaryPage({
    assetId: actualAssetId,
    ranges: page.ranges,
    nextCursor: page.nextCursor,
    coreLength: options.coreLength,
    cursor: options.cursor,
    limit: options.limit,
  })
  return decodeAssetRangeSummaryPage(payload, {
    coreLength: options.coreLength,
    cursor: options.cursor,
    limit: options.limit,
  })
}

export async function listAssetRanges({
  assetId,
  core,
  coreLength,
  byteLength,
  cursor = null,
  limit = MAX_ASSET_RANGE_PAGE_RANGES,
  startBlock = 0,
  endBlock = coreLength,
} = {}) {
  normalizeAssetId(assetId)
  const length = nonNegativeInteger(coreLength, 'coreLength')
  const bytes = nonNegativeInteger(byteLength, 'byteLength')
  const start = nonNegativeInteger(startBlock, 'startBlock')
  const end = nonNegativeInteger(endBlock, 'endBlock')
  if (start > end || end > length) throw new Error('asset inventory range exceeds the verified core length')
  boundedLimit(limit)
  assertCoreState(core, length, bytes)

  const requestedCursor = normalizeAssetCursor(cursor)
  const cursorBlock = requestedCursor === null ? start : requestedCursor
  if (cursorBlock > length || cursorBlock > end) throw new Error('cursor exceeds the verified core length')
  const windowStart = Math.max(start, cursorBlock)
  if (windowStart === end) return { ranges: [], nextCursor: null }
  const windowEnd = Math.min(end, windowStart + MAX_ASSET_RANGE_BITS_PER_RANGE)
  const bitfield = b4a.alloc(Math.ceil((windowEnd - windowStart) / 8))
  let firstPresent = -1
  let lastPresent = -1

  for (let index = windowStart; index < windowEnd; index++) {
    if (!await core.has(index)) continue
    const bit = index - windowStart
    bitfield[bit >> 3] |= 1 << (bit & 7)
    if (firstPresent === -1) firstPresent = index
    lastPresent = index
  }

  const ranges = []
  if (firstPresent !== -1) {
    const trimmed = trimPresentBitfield(bitfield, windowStart, firstPresent, lastPresent)
    ranges.push({ startBlock: firstPresent, ...trimmed })
  }
  const nextCursor = windowEnd < end ? String(windowEnd) : null
  const page = assertAssetRangeSummaryPage({ assetId, ranges, nextCursor }, {
    assetId,
    coreLength: length,
    cursor: cursor === null ? null : String(cursorBlock),
    limit,
  })
  return { ranges: page.ranges, nextCursor: page.nextCursor }
}
