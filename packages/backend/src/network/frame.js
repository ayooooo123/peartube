import b4a from 'b4a'
import {
  PROTOCOL_ERROR_CODES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  ProtocolCompatibilityError
} from './version.js'

export { PROTOCOL_MAJOR, PROTOCOL_MINOR }
export const MAX_PEER_FRAME_BYTES = 64 * 1024
export const FRAME_FLAG_OPTIONAL_TAG = 0x8000
export const MAX_ASSET_RANGE_PAGE_RANGES = 16
export const MAX_ASSET_RANGE_BITS_PER_RANGE = 4096
export const MAX_ASSET_RANGE_PAGE_BYTES = 16 * 1024
export const MAX_ASSET_BLOCKS_PER_REQUEST = 16
export const MAX_ASSET_BLOCK_BYTES = 256 * 1024
export const MAX_ASSET_PROOF_BYTES = 32 * 1024
export const MAX_ASSET_TRANSFER_ID = 0xffffffffffffffffn

const PEER_FRAME_HEADER_BYTES = 4 + 28
const ASSET_ID_BYTES = 32
const ASSET_RANGE_REQUEST_BYTES = ASSET_ID_BYTES + 8 + 1
const ASSET_RANGE_PAGE_HEADER_BYTES = ASSET_ID_BYTES + 1 + 8
const ASSET_TRANSFER_PREFIX_BYTES = ASSET_ID_BYTES + 8
const ASSET_BLOCK_RANGE_BYTES = ASSET_TRANSFER_PREFIX_BYTES + 8 + 8
const ASSET_BLOCK_RESPONSE_HEADER_BYTES = ASSET_BLOCK_RANGE_BYTES + 8 + 1 + 4 + 4
const MAX_ASSET_BLOCK_RESPONSE_CHUNK_BYTES = MAX_PEER_FRAME_BYTES - PEER_FRAME_HEADER_BYTES - ASSET_BLOCK_RESPONSE_HEADER_BYTES
const NULL_CURSOR = 0xffffffffffffffffn
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

const ASSET_BLOCK_RESPONSE_KIND_CODES = Object.freeze({ proof: 1, block: 2 })
const ASSET_BLOCK_RESPONSE_KIND_NAMES = new Map(Object.entries(ASSET_BLOCK_RESPONSE_KIND_CODES).map(([name, code]) => [code, name]))

export const ASSET_BLOCK_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'ASSET_BLOCK_UNAVAILABLE',
  INVALID_REQUEST: 'ASSET_BLOCK_INVALID_REQUEST',
  CANCELLED: 'ASSET_BLOCK_CANCELLED',
  INTERNAL: 'ASSET_BLOCK_INTERNAL',
})
const ASSET_BLOCK_ERROR_CODE_NUMBERS = new Map([
  [ASSET_BLOCK_ERROR_CODES.UNAVAILABLE, 1],
  [ASSET_BLOCK_ERROR_CODES.INVALID_REQUEST, 2],
  [ASSET_BLOCK_ERROR_CODES.CANCELLED, 3],
  [ASSET_BLOCK_ERROR_CODES.INTERNAL, 4],
])
const ASSET_BLOCK_ERROR_CODE_NAMES = new Map(Array.from(ASSET_BLOCK_ERROR_CODE_NUMBERS, ([name, code]) => [code, name]))

const PURPOSE_CODES = new Map([
  ['bootstrap', 1],
  ['publisher', 2],
  ['asset', 3],
  ['live', 4],
  ['archive', 5],
  ['archive-discovery', 6],
  ['index', 7],
  ['moderation', 8],
])
const PURPOSE_NAMES = new Map(Array.from(PURPOSE_CODES, ([name, code]) => [code, name]))

export function peerFrameTypeCode(type = '') {
  const text = String(type)
  let code = 0
  for (let i = 0; i < text.length; i++) code = ((code * 33) ^ text.charCodeAt(i)) >>> 0
  return code || 1
}

export const PEER_FRAME_TYPE_NAMES = Object.freeze(Object.fromEntries([
  'locator',
  'probe',
  'asset-range-summary-request',
  'asset-range-summary-page',
  'asset-block-request',
  'asset-block-response',
  'asset-block-error',
  'archive-request',
  'archive-pledge',
  'archive-challenge',
  'archive-challenge-proof',
  'archive-block-request',
  'archive-block-proof',
  'archive-block-chunk',
  'archive-block-unavailable',
  'namespace-proof-request',
  'namespace-proof-response',
  'catalog-page-request',
  'catalog-page-response',
  'feed-page-request',
  'feed-page-response',
  'feed-page-error',
  'index-query-request',
  'index-query-page',
  'index-query-error',
  'index-query-cancel',
].map(type => [peerFrameTypeCode(type), type])))
const TYPE_NAMES = new Map()

function assertBuffer(value, name) {
  if (!value) return b4a.alloc(0)
  if (!b4a.isBuffer(value)) throw new Error(`${name} must be a buffer`)
  return value
}

export function normalizeAssetId(value, name = 'assetId') {
  if (b4a.isBuffer(value)) {
    if (value.byteLength !== ASSET_ID_BYTES) throw new Error(`${name} must be exactly 32 bytes`)
    return value
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be exactly 32 bytes`)
  }
  return b4a.from(value, 'hex')
}

export function decodeAssetIdPrefix(payload) {
  if (!b4a.isBuffer(payload) || payload.byteLength < ASSET_ID_BYTES) throw new Error('asset payload is missing assetId')
  return payload.subarray(0, ASSET_ID_BYTES)
}

function normalizeBlockIndex(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function normalizeAssetCursor(value, name = 'cursor') {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical base-10 block index or null`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe block index limit`)
  return parsed
}

function normalizeLimit(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ASSET_RANGE_PAGE_RANGES) {
    throw new Error(`limit must be an integer between 1 and ${MAX_ASSET_RANGE_PAGE_RANGES}`)
  }
  return value
}

function encodeSafeUInt64(buffer, offset, value) {
  buffer.writeBigUInt64BE(BigInt(value), offset)
}

function decodeSafeUInt64(buffer, offset, name) {
  const value = buffer.readBigUInt64BE(offset)
  if (value > MAX_SAFE_BIGINT) throw new Error(`${name} exceeds the safe block index limit`)
  return Number(value)
}

function encodeCursor(buffer, offset, cursor) {
  buffer.writeBigUInt64BE(cursor === null ? NULL_CURSOR : BigInt(cursor), offset)
}

function decodeCursor(buffer, offset, name = 'cursor') {
  const value = buffer.readBigUInt64BE(offset)
  if (value === NULL_CURSOR) return null
  if (value > MAX_SAFE_BIGINT) throw new Error(`${name} exceeds the safe block index limit`)
  return Number(value)
}

function validateCoreLength(value) {
  if (value === undefined) return null
  return normalizeBlockIndex(value, 'core length')
}

function assertWithinCore(value, coreLength, name) {
  if (coreLength !== null && value > coreLength) throw new Error(`${name} exceeds the verified core length`)
}

function normalizeAssetTransferId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('transferId must be a positive uint64')
    value = BigInt(value)
  }
  if (typeof value !== 'bigint' || value < 1n || value > MAX_ASSET_TRANSFER_ID) {
    throw new Error('transferId must be a positive uint64')
  }
  return value
}

function decodeAssetTransferId(payload) {
  return normalizeAssetTransferId(payload.readBigUInt64BE(ASSET_ID_BYTES))
}

function normalizeAssetBlockRange(input, coreLength = null) {
  const startBlock = normalizeBlockIndex(input.startBlock, 'startBlock')
  const endBlock = normalizeBlockIndex(input.endBlock, 'endBlock')
  if (endBlock <= startBlock || endBlock - startBlock > MAX_ASSET_BLOCKS_PER_REQUEST) {
    throw new Error(`asset block range must contain between 1 and ${MAX_ASSET_BLOCKS_PER_REQUEST} blocks`)
  }
  assertWithinCore(endBlock, coreLength, 'asset block range')
  return { startBlock, endBlock }
}

function normalizePresentBitfield(value, bitCount) {
  if (!b4a.isBuffer(value)) throw new Error('present bitfield must be a buffer')
  const byteLength = Math.ceil(bitCount / 8)
  if (value.byteLength !== byteLength) throw new Error('present bitfield byte length does not match bitCount')
  const used = bitCount % 8
  if (used !== 0 && (value[value.byteLength - 1] & ~((1 << used) - 1)) !== 0) {
    throw new Error('unused high bitfield bits must be zero')
  }
  return value
}

function normalizeSummaryRanges(ranges, options = {}) {
  if (!Array.isArray(ranges) || ranges.length > MAX_ASSET_RANGE_PAGE_RANGES) {
    throw new Error(`asset summary ranges exceed the maximum of ${MAX_ASSET_RANGE_PAGE_RANGES}`)
  }
  if (options.limit !== undefined && ranges.length > normalizeLimit(options.limit)) {
    throw new Error('asset summary ranges exceed the requested limit')
  }
  const coreLength = validateCoreLength(options.coreLength)
  const cursor = options.cursor === undefined ? null : normalizeAssetCursor(options.cursor)
  let previousEnd = null
  return ranges.map(range => {
    const startBlock = normalizeBlockIndex(range?.startBlock, 'range startBlock')
    const bitCount = Number(range?.bitCount)
    if (!Number.isSafeInteger(bitCount) || bitCount < 1 || bitCount > MAX_ASSET_RANGE_BITS_PER_RANGE) {
      throw new Error(`range bitCount must be between 1 and ${MAX_ASSET_RANGE_BITS_PER_RANGE}`)
    }
    const endBlock = startBlock + bitCount
    if (!Number.isSafeInteger(endBlock)) throw new Error('asset summary range exceeds the safe block index limit')
    if (previousEnd !== null && startBlock <= previousEnd) {
      throw new Error('asset summary ranges must be strictly increasing, non-overlapping, and non-adjacent')
    }
    if (cursor !== null && startBlock < cursor) throw new Error('asset summary range starts before the request cursor')
    assertWithinCore(endBlock, coreLength, 'asset summary range')
    previousEnd = endBlock
    return {
      startBlock,
      bitCount,
      presentBitfield: normalizePresentBitfield(range.presentBitfield, bitCount),
    }
  })
}

function assertSummaryNextCursor(nextCursor, ranges, options = {}) {
  const value = normalizeAssetCursor(nextCursor, 'nextCursor')
  if (value === null) return null
  const coreLength = validateCoreLength(options.coreLength)
  const representedEnd = ranges.length === 0
    ? null
    : ranges[ranges.length - 1].startBlock + ranges[ranges.length - 1].bitCount
  if (representedEnd !== null && value < representedEnd) {
    throw new Error('nextCursor must be strictly beyond every represented block')
  }
  const requestCursor = options.cursor === undefined ? null : normalizeAssetCursor(options.cursor)
  if (representedEnd === null && requestCursor !== null && value <= requestCursor) {
    throw new Error('empty asset summary page cursor must advance')
  }
  assertWithinCore(value, coreLength, 'nextCursor')
  return value
}

export function encodeAssetRangeSummaryRequest(input = {}) {
  const assetId = normalizeAssetId(input.assetId)
  const cursor = normalizeAssetCursor(input.cursor)
  const limit = normalizeLimit(input.limit)
  const output = b4a.allocUnsafe(ASSET_RANGE_REQUEST_BYTES)
  b4a.copy(assetId, output, 0)
  encodeCursor(output, ASSET_ID_BYTES, cursor)
  output.writeUInt8(limit, ASSET_ID_BYTES + 8)
  return output
}

export function decodeAssetRangeSummaryRequest(payload, options = {}) {
  if (!b4a.isBuffer(payload) || payload.byteLength !== ASSET_RANGE_REQUEST_BYTES) {
    throw new Error('asset range summary request has a noncanonical length')
  }
  const assetId = payload.subarray(0, ASSET_ID_BYTES)
  const cursorValue = decodeCursor(payload, ASSET_ID_BYTES)
  const limit = normalizeLimit(payload.readUInt8(ASSET_ID_BYTES + 8))
  const coreLength = validateCoreLength(options.coreLength)
  if (cursorValue !== null) assertWithinCore(cursorValue, coreLength, 'cursor')
  return { assetId, cursor: cursorValue === null ? null : String(cursorValue), limit }
}

export function encodeAssetRangeSummaryPage(input = {}) {
  const assetId = normalizeAssetId(input.assetId)
  const ranges = normalizeSummaryRanges(input.ranges || [], input)
  const nextCursor = assertSummaryNextCursor(input.nextCursor, ranges, input)
  let length = ASSET_RANGE_PAGE_HEADER_BYTES
  for (const range of ranges) length += 8 + 2 + range.presentBitfield.byteLength
  if (length > MAX_ASSET_RANGE_PAGE_BYTES) throw new Error('asset range summary page bytes exceed the bounded limit')
  const output = b4a.allocUnsafe(length)
  b4a.copy(assetId, output, 0)
  output.writeUInt8(ranges.length, ASSET_ID_BYTES)
  encodeCursor(output, ASSET_ID_BYTES + 1, nextCursor)
  let offset = ASSET_RANGE_PAGE_HEADER_BYTES
  for (const range of ranges) {
    encodeSafeUInt64(output, offset, range.startBlock); offset += 8
    output.writeUInt16BE(range.bitCount, offset); offset += 2
    b4a.copy(range.presentBitfield, output, offset); offset += range.presentBitfield.byteLength
  }
  return output
}

export function decodeAssetRangeSummaryPage(payload, options = {}) {
  if (!b4a.isBuffer(payload) || payload.byteLength < ASSET_RANGE_PAGE_HEADER_BYTES || payload.byteLength > MAX_ASSET_RANGE_PAGE_BYTES) {
    throw new Error('asset range summary page bytes exceed the bounded limit')
  }
  const assetId = payload.subarray(0, ASSET_ID_BYTES)
  const count = payload.readUInt8(ASSET_ID_BYTES)
  if (count > MAX_ASSET_RANGE_PAGE_RANGES) throw new Error('asset summary ranges exceed the maximum')
  const nextCursorValue = decodeCursor(payload, ASSET_ID_BYTES + 1, 'nextCursor')
  let offset = ASSET_RANGE_PAGE_HEADER_BYTES
  const ranges = []
  for (let index = 0; index < count; index++) {
    if (offset + 10 > payload.byteLength) throw new Error('truncated asset summary range')
    const startBlock = decodeSafeUInt64(payload, offset, 'range startBlock'); offset += 8
    const bitCount = payload.readUInt16BE(offset); offset += 2
    if (bitCount < 1 || bitCount > MAX_ASSET_RANGE_BITS_PER_RANGE) throw new Error('range bitCount is out of bounds')
    const byteLength = Math.ceil(bitCount / 8)
    if (offset + byteLength > payload.byteLength) throw new Error('truncated asset summary bitfield')
    ranges.push({ startBlock, bitCount, presentBitfield: payload.subarray(offset, offset + byteLength) })
    offset += byteLength
  }
  if (offset !== payload.byteLength) throw new Error('asset range summary page has trailing bytes')
  const normalized = normalizeSummaryRanges(ranges, options)
  const nextCursor = assertSummaryNextCursor(nextCursorValue === null ? null : String(nextCursorValue), normalized, options)
  return {
    assetId,
    ranges: normalized,
    nextCursor: nextCursor === null ? null : String(nextCursor),
  }
}

export function encodeAssetBlockRequest(input = {}) {
  const assetId = normalizeAssetId(input.assetId)
  const transferId = normalizeAssetTransferId(input.transferId)
  const range = normalizeAssetBlockRange(input)
  const output = b4a.allocUnsafe(ASSET_BLOCK_RANGE_BYTES)
  b4a.copy(assetId, output, 0)
  output.writeBigUInt64BE(transferId, ASSET_ID_BYTES)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES, range.startBlock)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES + 8, range.endBlock)
  return output
}

export function decodeAssetBlockRequest(payload, options = {}) {
  if (!b4a.isBuffer(payload) || payload.byteLength !== ASSET_BLOCK_RANGE_BYTES) {
    throw new Error('asset block request has a noncanonical length')
  }
  const assetId = payload.subarray(0, ASSET_ID_BYTES)
  const transferId = decodeAssetTransferId(payload)
  const coreLength = validateCoreLength(options.coreLength)
  const range = normalizeAssetBlockRange({
    startBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES, 'startBlock'),
    endBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES + 8, 'endBlock'),
  }, coreLength)
  return { assetId, transferId, ...range }
}

function normalizeAssetBlockResponse(input, coreLength = null) {
  const range = normalizeAssetBlockRange(input, coreLength)
  const blockIndex = normalizeBlockIndex(input.blockIndex, 'block index')
  if (blockIndex < range.startBlock || blockIndex >= range.endBlock) throw new Error('block index is outside the request range')
  const kindCode = ASSET_BLOCK_RESPONSE_KIND_CODES[input.kind]
  if (!kindCode) throw new Error('asset block response kind is invalid')
  const offset = Number(input.offset)
  const totalBytes = Number(input.totalBytes)
  const chunk = input.chunk
  const maximum = input.kind === 'proof' ? MAX_ASSET_PROOF_BYTES : MAX_ASSET_BLOCK_BYTES
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maximum) {
    throw new Error('asset block response chunk bounds are invalid')
  }
  if (!b4a.isBuffer(chunk) || chunk.byteLength < 1 || chunk.byteLength > MAX_ASSET_BLOCK_RESPONSE_CHUNK_BYTES || offset + chunk.byteLength > totalBytes) {
    throw new Error('asset block response chunk bounds are invalid')
  }
  return { transferId: normalizeAssetTransferId(input.transferId), ...range, blockIndex, kind: input.kind, kindCode, offset, totalBytes, chunk }
}

export function encodeAssetBlockResponse(input = {}) {
  const assetId = normalizeAssetId(input.assetId)
  const response = normalizeAssetBlockResponse(input)
  const output = b4a.allocUnsafe(ASSET_BLOCK_RESPONSE_HEADER_BYTES + response.chunk.byteLength)
  b4a.copy(assetId, output, 0)
  output.writeBigUInt64BE(response.transferId, ASSET_ID_BYTES)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES, response.startBlock)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES + 8, response.endBlock)
  encodeSafeUInt64(output, ASSET_BLOCK_RANGE_BYTES, response.blockIndex)
  output.writeUInt8(response.kindCode, ASSET_BLOCK_RANGE_BYTES + 8)
  output.writeUInt32BE(response.offset, ASSET_BLOCK_RANGE_BYTES + 9)
  output.writeUInt32BE(response.totalBytes, ASSET_BLOCK_RANGE_BYTES + 13)
  b4a.copy(response.chunk, output, ASSET_BLOCK_RESPONSE_HEADER_BYTES)
  return output
}

export function decodeAssetBlockResponse(payload, options = {}) {
  if (!b4a.isBuffer(payload) || payload.byteLength <= ASSET_BLOCK_RESPONSE_HEADER_BYTES || payload.byteLength > MAX_PEER_FRAME_BYTES - PEER_FRAME_HEADER_BYTES) {
    throw new Error('asset block response has invalid bounded bytes')
  }
  const assetId = payload.subarray(0, ASSET_ID_BYTES)
  const kind = ASSET_BLOCK_RESPONSE_KIND_NAMES.get(payload.readUInt8(ASSET_BLOCK_RANGE_BYTES + 8))
  const response = normalizeAssetBlockResponse({
    transferId: decodeAssetTransferId(payload),
    startBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES, 'startBlock'),
    endBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES + 8, 'endBlock'),
    blockIndex: decodeSafeUInt64(payload, ASSET_BLOCK_RANGE_BYTES, 'block index'),
    kind,
    offset: payload.readUInt32BE(ASSET_BLOCK_RANGE_BYTES + 9),
    totalBytes: payload.readUInt32BE(ASSET_BLOCK_RANGE_BYTES + 13),
    chunk: payload.subarray(ASSET_BLOCK_RESPONSE_HEADER_BYTES),
  }, validateCoreLength(options.coreLength))
  const { kindCode, ...decoded } = response
  return { assetId, ...decoded }
}

export function encodeAssetBlockError(input = {}) {
  const assetId = normalizeAssetId(input.assetId)
  const transferId = normalizeAssetTransferId(input.transferId)
  const range = normalizeAssetBlockRange(input)
  const code = ASSET_BLOCK_ERROR_CODE_NUMBERS.get(input.code)
  if (!code) throw new Error('asset block error code is invalid')
  const output = b4a.allocUnsafe(ASSET_BLOCK_RANGE_BYTES + 1)
  b4a.copy(assetId, output, 0)
  output.writeBigUInt64BE(transferId, ASSET_ID_BYTES)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES, range.startBlock)
  encodeSafeUInt64(output, ASSET_TRANSFER_PREFIX_BYTES + 8, range.endBlock)
  output.writeUInt8(code, ASSET_BLOCK_RANGE_BYTES)
  return output
}

export function decodeAssetBlockError(payload, options = {}) {
  if (!b4a.isBuffer(payload) || payload.byteLength !== ASSET_BLOCK_RANGE_BYTES + 1) {
    throw new Error('asset block error has a noncanonical length')
  }
  const assetId = payload.subarray(0, ASSET_ID_BYTES)
  const transferId = decodeAssetTransferId(payload)
  const range = normalizeAssetBlockRange({
    startBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES, 'startBlock'),
    endBlock: decodeSafeUInt64(payload, ASSET_TRANSFER_PREFIX_BYTES + 8, 'endBlock'),
  }, validateCoreLength(options.coreLength))
  const code = ASSET_BLOCK_ERROR_CODE_NAMES.get(payload.readUInt8(ASSET_BLOCK_RANGE_BYTES))
  if (!code) throw new Error('asset block error code is invalid')
  return { assetId, transferId, ...range, code }
}

function typeToCode(type = '') {
  const text = String(type)
  const code = peerFrameTypeCode(text)
  TYPE_NAMES.set(code, text)
  return code
}

function codeToType(code, known = {}) {
  return known[code] || PEER_FRAME_TYPE_NAMES[code] || TYPE_NAMES.get(code) || String(code)
}

export function encodePeerFrame(input = {}) {
  const purpose = input.purpose || 'asset'
  const purposeCode = PURPOSE_CODES.get(purpose)
  if (!purposeCode) throw new Error('unknown purpose')
  const payload = assertBuffer(input.payload, 'payload')
  const tags = input.tags || []
  const type = String(input.type || 'message')
  let tagBytes = 0
  for (const tag of tags) {
    const value = assertBuffer(tag.value, 'tag value')
    tagBytes += 4 + value.byteLength
  }
  const headerBytes = 28
  const bodyBytes = headerBytes + tagBytes + payload.byteLength
  const total = 4 + bodyBytes
  if (total > MAX_PEER_FRAME_BYTES) throw new Error('frame exceeds maximum size')
  const buffer = b4a.alloc(total)
  let offset = 0
  buffer.writeUInt32BE(bodyBytes, offset); offset += 4
  buffer.writeUInt8(input.protocolMajor ?? PROTOCOL_MAJOR, offset++)
  buffer.writeUInt8(input.protocolMinor ?? PROTOCOL_MINOR, offset++)
  buffer.writeUInt8(purposeCode, offset++)
  buffer.writeUInt8(tags.length, offset++)
  buffer.writeUInt32BE(typeToCode(type), offset); offset += 4
  buffer.writeUInt32BE(Number(input.requestId || 0), offset); offset += 4
  buffer.writeUInt32BE(payload.byteLength, offset); offset += 4
  buffer.writeUInt32BE(tagBytes, offset); offset += 4
  buffer.writeUInt32BE(0, offset); offset += 4
  buffer.writeUInt32BE(0, offset); offset += 4
  for (const tag of tags) {
    const value = assertBuffer(tag.value, 'tag value')
    buffer.writeUInt16BE(tag.code, offset); offset += 2
    buffer.writeUInt16BE(value.byteLength, offset); offset += 2
    b4a.copy(value, buffer, offset); offset += value.byteLength
  }
  b4a.copy(payload, buffer, offset)
  return buffer
}

export function decodePeerFrame(buffer, options = {}) {
  if (!b4a.isBuffer(buffer)) throw new Error('frame must be a buffer')
  if (buffer.byteLength > MAX_PEER_FRAME_BYTES) throw new Error('frame exceeds maximum size')
  if (buffer.byteLength < 4 + 28) throw new Error('truncated frame')
  let offset = 0
  const declared = buffer.readUInt32BE(offset); offset += 4
  if (declared > MAX_PEER_FRAME_BYTES) throw new Error('declared frame length exceeds maximum size')
  if (declared !== buffer.byteLength - 4) throw new Error('truncated frame')
  const protocolMajor = buffer.readUInt8(offset++)
  const protocolMinor = buffer.readUInt8(offset++)
  if (protocolMajor !== PROTOCOL_MAJOR) {
    throw new ProtocolCompatibilityError(
      PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED,
      'unsupported protocol major',
      { minimumProtocolMajor: protocolMajor, supportedProtocolMajor: PROTOCOL_MAJOR }
    )
  }
  const purposeCode = buffer.readUInt8(offset++)
  const purpose = PURPOSE_NAMES.get(purposeCode)
  if (!purpose) throw new Error('unknown purpose')
  const tagCount = buffer.readUInt8(offset++)
  const typeCode = buffer.readUInt32BE(offset); offset += 4
  const requestId = buffer.readUInt32BE(offset); offset += 4
  const payloadLength = buffer.readUInt32BE(offset); offset += 4
  const tagBytes = buffer.readUInt32BE(offset); offset += 4
  offset += 8
  if (payloadLength > MAX_PEER_FRAME_BYTES || tagBytes > MAX_PEER_FRAME_BYTES) throw new Error('declared frame length exceeds maximum size')
  if (offset + tagBytes + payloadLength !== buffer.byteLength) throw new Error('truncated frame')
  const optionalTags = []
  for (let i = 0; i < tagCount; i++) {
    if (offset + 4 > buffer.byteLength) throw new Error('truncated frame')
    const rawCode = buffer.readUInt16BE(offset); offset += 2
    const length = buffer.readUInt16BE(offset); offset += 2
    if (offset + length > buffer.byteLength) throw new Error('truncated frame')
    const optional = (rawCode & FRAME_FLAG_OPTIONAL_TAG) !== 0
    const code = rawCode & ~FRAME_FLAG_OPTIONAL_TAG
    const value = buffer.subarray(offset, offset + length)
    offset += length
    if (!optional && !(options.supportedTags || new Set()).has(code)) throw new Error('unsupported mandatory tag')
    if (optional) optionalTags.push({ code, value })
  }
  const payload = buffer.subarray(offset, offset + payloadLength)
  return { protocolMajor, protocolMinor, purpose, type: codeToType(typeCode, options.typeCodes), typeCode, requestId, payload, optionalTags }
}
