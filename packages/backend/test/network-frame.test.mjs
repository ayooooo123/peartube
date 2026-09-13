import test from 'brittle'
import b4a from 'b4a'
import { execFileSync } from 'node:child_process'

import {
  FRAME_FLAG_OPTIONAL_TAG,
  MAX_ASSET_RANGE_BITS_PER_RANGE,
  MAX_ASSET_RANGE_PAGE_BYTES,
  MAX_ASSET_RANGE_PAGE_RANGES,
  MAX_PEER_FRAME_BYTES,
  PEER_FRAME_TYPE_NAMES,
  decodeAssetRangeSummaryPage,
  decodeAssetRangeSummaryRequest,
  decodePeerFrame,
  encodeAssetRangeSummaryPage,
  encodeAssetRangeSummaryRequest,
  encodePeerFrame,
  peerFrameTypeCode,
} from '../src/network/index.js'

const assetId = b4a.alloc(32, 7)

function presentBits(bitCount, fill = 0xff) {
  const bitfield = b4a.alloc(Math.ceil(bitCount / 8), fill)
  const used = bitCount % 8
  if (used !== 0) bitfield[bitfield.byteLength - 1] &= (1 << used) - 1
  return bitfield
}

test('peer frame codec enforces exact max size and rejects one-byte-over before allocation', (t) => {
  const payload = b4a.alloc(MAX_PEER_FRAME_BYTES - 128, 1)
  const frame = encodePeerFrame({ purpose: 'publisher', type: 'offer', requestId: 1, payload })
  t.ok(frame.byteLength <= MAX_PEER_FRAME_BYTES)
  t.alike(decodePeerFrame(frame).payload, payload)

  t.exception(() => decodePeerFrame(b4a.alloc(MAX_PEER_FRAME_BYTES + 1)), /frame exceeds maximum size/)
  const declared = b4a.from(frame)
  declared.writeUInt32BE(MAX_PEER_FRAME_BYTES + 1, 0)
  t.exception(() => decodePeerFrame(declared), /declared frame length exceeds maximum size/)
})

test('peer frame codec rejects truncated headers, unknown major, and unsupported mandatory tags', (t) => {
  t.exception(() => decodePeerFrame(b4a.alloc(2)), /truncated frame/)
  const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'hello', protocolMajor: 99, requestId: 1 })
  t.exception(() => decodePeerFrame(frame), /unsupported protocol major/)

  const mandatory = encodePeerFrame({ purpose: 'bootstrap', type: 'hello', requestId: 1, tags: [{ code: 5000, value: b4a.from('x') }] })
  t.exception(() => decodePeerFrame(mandatory), /unsupported mandatory tag/)
})

test('peer frame codec skips optional length-delimited minor extensions and preserves vectors', (t) => {
  const frame = encodePeerFrame({
    purpose: 'publisher',
    type: 'catalog-page',
    requestId: 7,
    payload: b4a.from('payload'),
    tags: [{ code: 5000 | FRAME_FLAG_OPTIONAL_TAG, value: b4a.from('future') }],
  })
  // Frame header embeds protocolMajor: 04 after the native Hypercore media cutover.
  t.alike(b4a.toString(frame.subarray(0, 8), 'hex'), '0000002d04000201')
  const decoded = decodePeerFrame(frame)
  t.is(decoded.purpose, 'publisher')
  t.is(decoded.type, 'catalog-page')
  t.is(decoded.requestId, 7)
  t.alike(decoded.payload, b4a.from('payload'))
  t.alike(decoded.optionalTags[0].code, 5000)
})

test('asset range request and page codecs round-trip canonical bounded inventory', (t) => {
  const request = decodeAssetRangeSummaryRequest(encodeAssetRangeSummaryRequest({
    assetId,
    cursor: '8',
    limit: MAX_ASSET_RANGE_PAGE_RANGES,
  }), { coreLength: 64 })
  t.alike(request.assetId, assetId)
  t.is(request.cursor, '8')
  t.is(request.limit, MAX_ASSET_RANGE_PAGE_RANGES)

  const page = decodeAssetRangeSummaryPage(encodeAssetRangeSummaryPage({
    assetId,
    ranges: [{ startBlock: 8, bitCount: 9, presentBitfield: presentBits(9) }],
    nextCursor: '17',
  }), { coreLength: 64, cursor: '8', limit: 1 })
  t.is(page.ranges.length, 1)
  t.is(page.ranges[0].startBlock, 8)
  t.is(page.ranges[0].bitCount, 9)
  t.alike(page.ranges[0].presentBitfield, b4a.from([0xff, 0x01]))
  t.is(page.nextCursor, '17')
})

test('asset range codecs reject noncanonical cursors, pages, bitfields, and allocation bounds', (t) => {
  for (const cursor of ['00', '01', '+1', '-1', ' 1', '1 ', '1.0', String(Number.MAX_SAFE_INTEGER + 1)]) {
    t.exception(() => encodeAssetRangeSummaryRequest({ assetId, cursor, limit: 1 }), /cursor/)
  }
  for (const limit of [0, MAX_ASSET_RANGE_PAGE_RANGES + 1, 1.5]) {
    t.exception(() => encodeAssetRangeSummaryRequest({ assetId, cursor: null, limit }), /limit/)
  }

  const oversizedRanges = Array.from({ length: MAX_ASSET_RANGE_PAGE_RANGES + 1 }, (_, index) => ({
    startBlock: index * 2,
    bitCount: 1,
    presentBitfield: b4a.from([1]),
  }))
  t.exception(() => encodeAssetRangeSummaryPage({ assetId, ranges: oversizedRanges, nextCursor: null }), /ranges/)
  t.exception(() => encodeAssetRangeSummaryPage({
    assetId,
    ranges: [{ startBlock: 0, bitCount: MAX_ASSET_RANGE_BITS_PER_RANGE + 1, presentBitfield: b4a.alloc(513) }],
    nextCursor: null,
  }), /bitCount/)
  t.exception(() => encodeAssetRangeSummaryPage({
    assetId,
    ranges: [{ startBlock: 0, bitCount: 9, presentBitfield: b4a.from([0xff]) }],
    nextCursor: null,
  }), /bitfield/)
  t.exception(() => encodeAssetRangeSummaryPage({
    assetId,
    ranges: [
      { startBlock: 0, bitCount: 8, presentBitfield: b4a.from([0xff]) },
      { startBlock: 8, bitCount: 8, presentBitfield: b4a.from([0xff]) },
    ],
    nextCursor: null,
  }), /non-adjacent/)

  const noncanonicalBits = encodeAssetRangeSummaryPage({
    assetId,
    ranges: [{ startBlock: 0, bitCount: 9, presentBitfield: b4a.from([0xff, 0x01]) }],
    nextCursor: null,
  })
  noncanonicalBits[noncanonicalBits.byteLength - 1] |= 0x80
  t.exception(() => decodeAssetRangeSummaryPage(noncanonicalBits), /unused|bitfield/)
  t.exception(() => decodeAssetRangeSummaryPage(b4a.alloc(MAX_ASSET_RANGE_PAGE_BYTES + 1)), /page bytes/)
})



test('archive controls remain registered while custom asset transfer frames stay removed', (t) => {
  const frameUrl = new URL('../src/network/frame.js', import.meta.url).href
  for (const type of ['archive-challenge', 'archive-challenge-proof']) {
    const encoded = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import b4a from 'b4a'
      import { encodePeerFrame } from ${JSON.stringify(frameUrl)}
      process.stdout.write(b4a.toString(encodePeerFrame({
        purpose: 'archive-discovery',
        type: ${JSON.stringify(type)},
        requestId: 1,
        payload: b4a.from('payload'),
      }), 'hex'))
    `], { encoding: 'utf8' })
    const decodedType = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import b4a from 'b4a'
      import { decodePeerFrame, PEER_FRAME_TYPE_NAMES } from ${JSON.stringify(frameUrl)}
      process.stdout.write(decodePeerFrame(
        b4a.from(${JSON.stringify(encoded)}, 'hex'),
        { typeCodes: PEER_FRAME_TYPE_NAMES },
      ).type)
    `], { encoding: 'utf8' })
    t.is(decodedType, type)
  }
  for (const removed of [
    'asset-range-summary-request',
    'asset-range-summary-page',
    'asset-block-request',
    'asset-block-response',
    'asset-block-error',
    'asset-block-proof',
    'asset-block-chunk',
    'asset-block-unavailable',
    'acquisition-block-request',
    'acquisition-block-proof',
    'acquisition-block-chunk',
    'acquisition-block-unavailable',
  ]) {
    t.absent(PEER_FRAME_TYPE_NAMES[peerFrameTypeCode(removed)])
  }
})
