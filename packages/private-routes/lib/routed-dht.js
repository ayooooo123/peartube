import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { EXIT_ORIGIN_SERVICE_POLICY } from './final-exit.js'
import { BRANCH_CLASS, M3_MESSAGE_ID, decodeM3Object, encodeM3Object } from './protocol.js'

export const DESTINATION_REF_SIZE = 172
export const ROUTED_REQUEST_FIXED_BODY_SIZE = 221

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray

const COMMANDS = new Map([
  [M3_MESSAGE_ID.IMMUTABLE_GET_V1, { min: 32, max: 32, lookup: true, announce: true }],
  [M3_MESSAGE_ID.IMMUTABLE_PUT_V1, { min: 67, max: 1090, lookup: false, announce: true }],
  [M3_MESSAGE_ID.MUTABLE_GET_V1, { min: 40, max: 40, lookup: true, announce: true }],
  [M3_MESSAGE_ID.MUTABLE_PUT_V1, { min: 171, max: 1066, lookup: false, announce: true }],
  [M3_MESSAGE_ID.PRIVATE_FIND_NODE_V1, { min: 69, max: 69, lookup: true, announce: true }],
  [M3_MESSAGE_ID.PRIVATE_LOOKUP_V1, { min: 134, max: 134, lookup: true, announce: false }],
  [M3_MESSAGE_ID.PRIVATE_PREPARE_V1, { min: 189, max: 189, lookup: false, announce: true }],
  [M3_MESSAGE_ID.PRIVATE_ANNOUNCE_V1, { min: 394, max: 1161, lookup: false, announce: true }],
  [M3_MESSAGE_ID.PRIVATE_UNANNOUNCE_V1, { min: 393, max: 393, lookup: false, announce: true }]
])

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function policyMismatch() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function object(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    return value
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function set(target, source, offset = 0) {
  try {
    setIntrinsic.call(target, source, offset)
  } catch {
    invalid()
  }
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    invalid()
  }
}

function copy(value) {
  let output = null
  try {
    if (length(value) < 0) invalid()
    output = b4a.allocUnsafeSlow(length(value))
    set(output, value)
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function writeUint16(target, value, offset) {
  target[offset] = value >>> 8
  target[offset + 1] = value
}

function readUint16(target, offset) {
  return (target[offset] << 8) | target[offset + 1]
}

function writeUint32(target, value, offset) {
  target[offset] = value >>> 24
  target[offset + 1] = value >>> 16
  target[offset + 2] = value >>> 8
  target[offset + 3] = value
}

function readUint32(target, offset) {
  return (
    target[offset] * 0x1000000 +
    (target[offset + 1] << 16) +
    (target[offset + 2] << 8) +
    target[offset + 3]
  )
}

function writeUint64(target, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    target[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint64(target, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(target[index])
  }
  return value
}

function branchClass(value) {
  if (value !== BRANCH_CLASS.LOOKUP && value !== BRANCH_CLASS.ANNOUNCE) invalid()
  return value
}

function command(commandId, operationClass, bodyBytes) {
  const definition = COMMANDS.get(commandId)
  const policy = EXIT_ORIGIN_SERVICE_POLICY.find((entry) => entry.commandId === commandId)
  if (!definition || !policy || bodyBytes < definition.min || bodyBytes > definition.max) invalid()
  if (
    (operationClass === BRANCH_CLASS.LOOKUP && !definition.lookup) ||
    (operationClass === BRANCH_CLASS.ANNOUNCE && !definition.announce)
  ) {
    policyMismatch()
  }
  return { definition, policy }
}

export function encodeDestinationRef(value) {
  let body = null
  try {
    value = object(value)
    const id = option(value, 'id')
    const handle = option(value, 'handle')
    if (!fixed(id, 32) || !fixed(handle, 130)) invalid()
    body = b4a.allocUnsafeSlow(164)
    set(body, id, 0)
    writeUint16(body, 130, 32)
    set(body, handle, 34)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.DESTINATION_REF_V1, body })
  } finally {
    clear(body)
  }
}

export function decodeDestinationRef(encoded) {
  let decoded = null
  let result = null
  let complete = false
  try {
    decoded = decodeM3Object(encoded)
    if (
      decoded.messageId !== M3_MESSAGE_ID.DESTINATION_REF_V1 ||
      decoded.body.byteLength !== 164 ||
      decoded.authSuffix.byteLength !== 0 ||
      readUint16(decoded.body, 32) !== 130
    ) {
      invalid()
    }
    result = {
      id: copy(subarray(decoded.body, 0, 32)),
      handle: copy(subarray(decoded.body, 34, 164))
    }
    complete = true
    return Object.freeze(result)
  } finally {
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
    if (!complete && result) {
      clear(result.id)
      clear(result.handle)
    }
  }
}

function encodedDestination(value) {
  if (length(value) === DESTINATION_REF_SIZE) {
    const decoded = decodeDestinationRef(value)
    clear(decoded.id)
    clear(decoded.handle)
    return copy(value)
  }
  return encodeDestinationRef(value)
}

export function encodeRoutedRequest(value) {
  let destination = null
  let body = null
  try {
    value = object(value)
    const requestId = option(value, 'requestId')
    const operationClass = branchClass(option(value, 'operationClass'))
    const commandId = option(value, 'commandId')
    const absoluteDeadlineMs = option(value, 'absoluteDeadlineMs')
    const encodedBody = option(value, 'encodedBody')
    if (!fixed(requestId, 16) || !uint64(absoluteDeadlineMs) || length(encodedBody) < 0) invalid()
    const selected = command(commandId, operationClass, encodedBody.byteLength)
    destination = encodedDestination(option(value, 'destination'))
    body = b4a.allocUnsafeSlow(ROUTED_REQUEST_FIXED_BODY_SIZE + encodedBody.byteLength)
    set(body, requestId, 0)
    body[16] = operationClass
    writeUint16(body, commandId, 17)
    writeUint16(body, 1, 19)
    body[21] = selected.policy.mutationFlag
    body[22] = selected.policy.destinationValidationClass
    writeUint32(body, selected.policy.maxResponseBytes, 23)
    writeUint32(body, selected.policy.maxAmplificationBytes, 27)
    writeUint32(body, selected.policy.requestCost, 31)
    writeUint32(body, selected.policy.responseCost, 35)
    writeUint64(body, absoluteDeadlineMs, 39)
    set(body, destination, 47)
    writeUint16(body, encodedBody.byteLength, 219)
    set(body, encodedBody, 221)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.ROUTED_REQUEST_V1, body })
  } finally {
    clear(destination)
    clear(body)
  }
}

export function decodeRoutedRequest(encoded) {
  let decoded = null
  let destinationEncoded = null
  let destination = null
  let result = null
  let complete = false
  try {
    decoded = decodeM3Object(encoded)
    if (
      decoded.messageId !== M3_MESSAGE_ID.ROUTED_REQUEST_V1 ||
      decoded.authSuffix.byteLength !== 0 ||
      decoded.body.byteLength < ROUTED_REQUEST_FIXED_BODY_SIZE
    ) {
      invalid()
    }
    const body = decoded.body
    const operationClass = branchClass(body[16])
    const commandId = readUint16(body, 17)
    const encodedBodyBytes = readUint16(body, 219)
    if (body.byteLength !== ROUTED_REQUEST_FIXED_BODY_SIZE + encodedBodyBytes) invalid()
    const selected = command(commandId, operationClass, encodedBodyBytes)
    if (
      readUint16(body, 19) !== 1 ||
      body[21] !== selected.policy.mutationFlag ||
      body[22] !== selected.policy.destinationValidationClass ||
      readUint32(body, 23) !== selected.policy.maxResponseBytes ||
      readUint32(body, 27) !== selected.policy.maxAmplificationBytes ||
      readUint32(body, 31) !== selected.policy.requestCost ||
      readUint32(body, 35) !== selected.policy.responseCost
    ) {
      policyMismatch()
    }
    destinationEncoded = copy(subarray(body, 47, 219))
    destination = decodeDestinationRef(destinationEncoded)
    result = {
      requestId: copy(subarray(body, 0, 16)),
      operationClass,
      commandId,
      commandVersion: 1,
      mutationFlag: body[21],
      destinationValidationClass: body[22],
      maxResponseBytes: readUint32(body, 23),
      maxAmplificationBytes: readUint32(body, 27),
      requestCost: readUint32(body, 31),
      responseCost: readUint32(body, 35),
      absoluteDeadlineMs: readUint64(body, 39),
      destination,
      destinationEncoded,
      encodedBody: copy(subarray(body, 221))
    }
    destination = null
    destinationEncoded = null
    complete = true
    return Object.freeze(result)
  } finally {
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
    if (!complete && result) clearRoutedRequest(result)
    if (destination) {
      clear(destination.id)
      clear(destination.handle)
    }
    clear(destinationEncoded)
  }
}

export function validateRoutedRequestForExit(encoded, options) {
  const request = decodeRoutedRequest(encoded)
  let complete = false
  try {
    options = object(options)
    const now = option(options, 'now')
    const expectedBranchClass = branchClass(option(options, 'branchClass'))
    const verifyDestination = option(options, 'verifyDestination')
    if (typeof now !== 'function' || typeof verifyDestination !== 'function') invalid()
    let current
    try {
      current = now()
    } catch {
      invalid()
    }
    if (Number.isSafeInteger(current) && current >= 0) current = BigInt(current)
    if (!uint64(current)) invalid()
    const policy = EXIT_ORIGIN_SERVICE_POLICY.find((entry) => entry.commandId === request.commandId)
    if (
      request.operationClass !== expectedBranchClass ||
      request.absoluteDeadlineMs < current ||
      request.absoluteDeadlineMs > current + BigInt(policy.timeoutMs)
    ) {
      policyMismatch()
    }
    const valid = verifyDestination({
      destination: request.destination,
      destinationEncoded: request.destinationEncoded,
      destinationValidationClass: request.destinationValidationClass,
      absoluteDeadlineMs: request.absoluteDeadlineMs,
      commandId: request.commandId
    })
    if (valid !== true) policyMismatch()
    complete = true
    return request
  } finally {
    if (!complete) clearRoutedRequest(request)
  }
}

export function clearRoutedRequest(request) {
  if (!request) return
  clear(request.requestId)
  if (request.destination) {
    clear(request.destination.id)
    clear(request.destination.handle)
  }
  clear(request.destinationEncoded)
  clear(request.encodedBody)
}
