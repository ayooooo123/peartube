import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { DIRECTION, M3_PROTOCOL_VERSION } from './protocol.js'

export const M3_CONTEXT_AD_SIZE = 54
export const M3_CONTEXT_ENVELOPE_SIZE = 1101

const M3_CONTEXT_FRAME_SIZE = 1100
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function fixed(value, size) {
  try {
    return b4a.isBuffer(value) && bufferByteLength.call(value) === size
  } catch {
    return false
  }
}

function set(target, source, offset = 0) {
  try {
    bufferSet.call(target, source, offset)
  } catch {
    invalid()
  }
}

function subarray(value, start, end) {
  try {
    return bufferSubarray.call(value, start, end)
  } catch {
    invalid()
  }
}

function copy(value) {
  let output = null
  try {
    const length = bufferByteLength.call(value)
    output = b4a.allocUnsafeSlow(length)
    set(output, value)
    return output
  } catch {
    invalid()
  }
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function contextClass(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4) invalid()
  return value
}

function direction(value) {
  if (value !== DIRECTION.FORWARD && value !== DIRECTION.REVERSE) invalid()
  return value
}

function writeUint32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function readUint32(buffer, offset) {
  return (
    buffer[offset] * 0x1000000 +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
  )
}

function writeUint64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint64(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

export function encodeM3ContextAD(value) {
  try {
    object(value)
    const selectedClass = contextClass(option(value, 'contextClass'))
    const branchId = option(value, 'branchId')
    const circuitId = option(value, 'circuitId')
    const generation = option(value, 'generation')
    const selectedDirection = direction(option(value, 'direction'))
    const innerCounter = option(value, 'innerCounter')

    if (!fixed(branchId, 16) || !fixed(circuitId, 16)) invalid()
    if (!uint64(generation) || !uint64(innerCounter)) invalid()

    const output = b4a.allocUnsafe(M3_CONTEXT_AD_SIZE)
    output[0] = selectedClass
    writeUint32(output, M3_PROTOCOL_VERSION, 1)
    set(output, branchId, 5)
    set(output, circuitId, 21)
    writeUint64(output, generation, 37)
    output[45] = selectedDirection
    writeUint64(output, innerCounter, 46)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodeM3ContextAD(encoded) {
  try {
    if (!fixed(encoded, M3_CONTEXT_AD_SIZE)) invalid()
    const selectedClass = contextClass(encoded[0])
    if (readUint32(encoded, 1) !== M3_PROTOCOL_VERSION) invalid()
    const selectedDirection = direction(encoded[45])

    return {
      contextClass: selectedClass,
      branchId: copy(subarray(encoded, 5, 21)),
      circuitId: copy(subarray(encoded, 21, 37)),
      generation: readUint64(encoded, 37),
      direction: selectedDirection,
      innerCounter: readUint64(encoded, 46)
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function encodeM3ContextEnvelope(value) {
  try {
    object(value)
    const selectedClass = contextClass(option(value, 'contextClass'))
    const frame = option(value, 'frame')
    if (!fixed(frame, M3_CONTEXT_FRAME_SIZE)) invalid()

    const output = b4a.allocUnsafe(M3_CONTEXT_ENVELOPE_SIZE)
    output[0] = selectedClass
    set(output, frame, 1)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodeM3ContextEnvelope(encoded) {
  try {
    if (!fixed(encoded, M3_CONTEXT_ENVELOPE_SIZE)) invalid()
    return {
      contextClass: contextClass(encoded[0]),
      frame: copy(subarray(encoded, 1, M3_CONTEXT_ENVELOPE_SIZE))
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}
