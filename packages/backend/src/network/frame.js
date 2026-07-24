import b4a from 'b4a'

export const PROTOCOL_MAJOR = 1
export const PROTOCOL_MINOR = 0
export const MAX_PEER_FRAME_BYTES = 64 * 1024
export const FRAME_FLAG_OPTIONAL_TAG = 0x8000

const PURPOSE_CODES = new Map([
  ['bootstrap', 1],
  ['publisher', 2],
  ['asset', 3],
  ['live', 4],
  ['archive', 5],
])
const PURPOSE_NAMES = new Map(Array.from(PURPOSE_CODES, ([name, code]) => [code, name]))
const TYPE_NAMES = new Map()

function assertBuffer(value, name) {
  if (!value) return b4a.alloc(0)
  if (!b4a.isBuffer(value)) throw new Error(`${name} must be a buffer`)
  return value
}

function typeToCode(type = '') {
  const text = String(type)
  let code = 0
  for (let i = 0; i < text.length; i++) code = ((code * 33) ^ text.charCodeAt(i)) >>> 0
  code = code || 1
  TYPE_NAMES.set(code, text)
  return code
}

function codeToType(code, known = {}) {
  return known[code] || TYPE_NAMES.get(code) || String(code)
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
  if (protocolMajor !== PROTOCOL_MAJOR) throw new Error('unsupported protocol major')
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
