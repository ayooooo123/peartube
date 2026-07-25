import b4a from 'b4a'

export const RECORD_LIMITS = Object.freeze({
  maxEnvelopeBytes: 1_048_576,
  maxRecordTypeBytes: 128,
  maxBodyBytes: 1_000_000,
  maxSignatures: 16,
  keyBytes: 32,
  idBytes: 32,
  signatureBytes: 64
})

export function fail (message) { throw new Error(`Invalid record: ${message}`) }
export function isBytes (value) { return b4a.isBuffer(value) || value instanceof Uint8Array }
export function assertBytes (value, length, name) {
  if (!isBytes(value) || value.byteLength !== length) fail(`${name} must be ${length} bytes`)
  return value
}
export function assertUint (value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`${name} is out of bounds`)
  return value
}
export function utf8 (value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`)
  const encoded = b4a.from(value)
  if (encoded.byteLength > maxBytes || b4a.toString(encoded) !== value) fail(`${name} exceeds its byte limit`)
  return encoded
}
export function varintLength (value) {
  assertUint(value, 'integer')
  let length = 1
  while (value >= 128) { value = Math.floor(value / 128); length++ }
  return length
}
export function writeVarint (buffer, offset, value) {
  while (value >= 128) { buffer[offset++] = (value % 128) | 128; value = Math.floor(value / 128) }
  buffer[offset++] = value
  return offset
}
export function readVarint (state, name, max = Number.MAX_SAFE_INTEGER) {
  let value = 0; let factor = 1; let count = 0
  while (true) {
    if (state.offset >= state.buffer.byteLength) fail(`truncated ${name}`)
    const byte = state.buffer[state.offset++]
    value += (byte & 127) * factor
    count++
    if (!Number.isSafeInteger(value) || value > max || count > 8) fail(`${name} is out of bounds`)
    if ((byte & 128) === 0) {
      if (count !== varintLength(value)) fail(`non-canonical ${name}`)
      return value
    }
    factor *= 128
  }
}
export function fieldSize (bytes) { return varintLength(bytes.byteLength) + bytes.byteLength }
export function writeField (buffer, offset, bytes) {
  offset = writeVarint(buffer, offset, bytes.byteLength)
  buffer.set(bytes, offset)
  return offset + bytes.byteLength
}
export function readField (state, name, maxBytes, exactBytes = null) {
  const length = readVarint(state, `${name} length`, exactBytes ?? maxBytes)
  if (exactBytes !== null && length !== exactBytes) fail(`${name} must be ${exactBytes} bytes`)
  if (length > maxBytes) fail(`${name} exceeds its byte limit`)
  if (state.offset + length > state.buffer.byteLength) fail(`truncated ${name}`)
  const value = state.buffer.subarray(state.offset, state.offset + length)
  state.offset += length
  return value
}
export function compareBytes (left, right) { return b4a.compare(left, right) }
export function equalBytes (left, right) { return isBytes(left) && isBytes(right) && b4a.equals(left, right) }

export function encodePreimage (domain, recordType, id) {
  const domainBytes = b4a.from(domain)
  const typeBytes = utf8(recordType, 'recordType', RECORD_LIMITS.maxRecordTypeBytes)
  assertBytes(id, RECORD_LIMITS.idBytes, 'recordId')
  const out = b4a.allocUnsafe(fieldSize(domainBytes) + fieldSize(typeBytes) + id.byteLength)
  let offset = writeField(out, 0, domainBytes)
  offset = writeField(out, offset, typeBytes)
  out.set(id, offset)
  return out
}

export function assertInput (input) {
  if (!isBytes(input)) fail('encoded envelope must be bytes')
  if (input.byteLength > RECORD_LIMITS.maxEnvelopeBytes) fail('envelope exceeds its byte limit')
}
