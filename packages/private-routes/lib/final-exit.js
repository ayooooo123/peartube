import b4a from 'b4a'
import sodium from 'sodium-universal'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  BRANCH_CLASS,
  DESTINATION_VALIDATION_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  MUTATION_FLAG,
  decodeM3Object,
  encodeM3Object
} from './protocol.js'

export const SERVICE_POLICY_ENTRY_SIZE = 32
export const PAYLOAD_PARAMETERS_SIZE = 20
export const FINAL_EXIT_TRANSCRIPT_SIZE = 287
export const DHT_EXIT_ACTIVATE_SIZE = 104

const MAX_UINT32 = 0xffff_ffff
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const POLICY_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/service-policy/v1')
const PARAMETERS_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/payload-parameters/v1')
const FINAL_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/transcript/v1')
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

const FINAL_LABELS = Object.freeze({
  payloadForwardKey: 'hyperdht-private-routes/kdf/v1/final-exit/payload/forward-key',
  payloadReverseKey: 'hyperdht-private-routes/kdf/v1/final-exit/payload/reverse-key',
  payloadForwardNonce: 'hyperdht-private-routes/kdf/v1/final-exit/payload/forward-nonce',
  payloadReverseNonce: 'hyperdht-private-routes/kdf/v1/final-exit/payload/reverse-nonce',
  controlForwardKey: 'hyperdht-private-routes/kdf/v1/final-exit/control/forward-key',
  controlReverseKey: 'hyperdht-private-routes/kdf/v1/final-exit/control/reverse-key',
  controlForwardNonce: 'hyperdht-private-routes/kdf/v1/final-exit/control/forward-nonce',
  controlReverseNonce: 'hyperdht-private-routes/kdf/v1/final-exit/control/reverse-nonce',
  finalizeForwardKey: 'hyperdht-private-routes/kdf/v1/final-exit/finalize/forward-key',
  finalizeReverseKey: 'hyperdht-private-routes/kdf/v1/final-exit/finalize/reverse-key',
  finalizeForwardNonce: 'hyperdht-private-routes/kdf/v1/final-exit/finalize/forward-nonce',
  finalizeReverseNonce: 'hyperdht-private-routes/kdf/v1/final-exit/finalize/reverse-nonce'
})

function policyEntry(
  commandId,
  maxRequestBytes,
  maxResponseBytes,
  timeoutMs,
  maxOutstanding,
  requestCost,
  responseCost,
  maxAmplificationBytes,
  mutationFlag,
  destinationValidationClass
) {
  return Object.freeze({
    commandId,
    commandVersion: 1,
    maxRequestBytes,
    maxResponseBytes,
    timeoutMs,
    maxOutstanding,
    requestCost,
    responseCost,
    maxAmplificationBytes,
    mutationFlag,
    destinationValidationClass
  })
}

export const EXIT_ORIGIN_SERVICE_POLICY = Object.freeze([
  policyEntry(
    M3_MESSAGE_ID.IMMUTABLE_GET_V1,
    32,
    4706,
    3000,
    10,
    1,
    2,
    4445,
    MUTATION_FLAG.READ_ONLY,
    DESTINATION_VALIDATION_CLASS.DHT_NODE_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.IMMUTABLE_PUT_V1,
    1090,
    209,
    3000,
    5,
    3,
    1,
    0,
    MUTATION_FLAG.MUTATING,
    DESTINATION_VALIDATION_CLASS.DHT_NODE_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.MUTABLE_GET_V1,
    40,
    4650,
    3000,
    10,
    1,
    2,
    4381,
    MUTATION_FLAG.READ_ONLY,
    DESTINATION_VALIDATION_CLASS.DHT_NODE_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.MUTABLE_PUT_V1,
    1066,
    209,
    3000,
    5,
    3,
    1,
    0,
    MUTATION_FLAG.MUTATING,
    DESTINATION_VALIDATION_CLASS.DHT_NODE_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.PRIVATE_FIND_NODE_V1,
    69,
    4031,
    5000,
    3,
    2,
    8,
    3733,
    MUTATION_FLAG.READ_ONLY,
    DESTINATION_VALIDATION_CLASS.SIGNED_CAPABILITY_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.PRIVATE_LOOKUP_V1,
    134,
    8270,
    5000,
    3,
    2,
    12,
    7907,
    MUTATION_FLAG.READ_ONLY,
    DESTINATION_VALIDATION_CLASS.SIGNED_CAPABILITY_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.PRIVATE_PREPARE_V1,
    189,
    288,
    3000,
    5,
    3,
    2,
    0,
    MUTATION_FLAG.MUTATING,
    DESTINATION_VALIDATION_CLASS.SIGNED_CAPABILITY_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.PRIVATE_ANNOUNCE_V1,
    1161,
    581,
    5000,
    5,
    5,
    3,
    0,
    MUTATION_FLAG.MUTATING,
    DESTINATION_VALIDATION_CLASS.SIGNED_CAPABILITY_HANDLE
  ),
  policyEntry(
    M3_MESSAGE_ID.PRIVATE_UNANNOUNCE_V1,
    393,
    581,
    5000,
    5,
    5,
    3,
    0,
    MUTATION_FLAG.MUTATING,
    DESTINATION_VALIDATION_CLASS.SIGNED_CAPABILITY_HANDLE
  )
])

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
  return bufferLength(value) === size
}

function bufferLength(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
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
  try {
    const length = bufferLength(value)
    if (length < 0) invalid()
    const output = b4a.allocUnsafeSlow(length)
    set(output, value)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function uint8(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xff
}

function uint16(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff
}

function uint32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64
}

function branchClass(value) {
  if (value !== BRANCH_CLASS.LOOKUP && value !== BRANCH_CLASS.ANNOUNCE) invalid()
  return value
}

export function encodeDhtExitActivate(value) {
  let body = null
  try {
    object(value)
    const fields = [
      option(value, 'clientActivationNonce'),
      option(value, 'exitOriginCommandPolicyDigest'),
      option(value, 'payloadParametersDigest')
    ]
    if (fields.some((field) => !fixed(field, 32))) invalid()
    body = b4a.allocUnsafeSlow(96)
    for (let index = 0; index < fields.length; index++) set(body, fields[index], index * 32)
    return encodeM3Object({ messageId: M3_MESSAGE_ID.DHT_EXIT_ACTIVATE_V1, body })
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    clear(body)
  }
}

export function decodeDhtExitActivate(encoded) {
  let decoded = null
  let result = null
  let complete = false
  try {
    decoded = decodeM3Object(encoded)
    if (
      decoded.messageId !== M3_MESSAGE_ID.DHT_EXIT_ACTIVATE_V1 ||
      !fixed(decoded.body, 96) ||
      !fixed(decoded.authSuffix, 0)
    ) {
      invalid()
    }
    result = {
      clientActivationNonce: copy(subarray(decoded.body, 0, 32)),
      exitOriginCommandPolicyDigest: copy(subarray(decoded.body, 32, 64)),
      payloadParametersDigest: copy(subarray(decoded.body, 64, 96))
    }
    complete = true
    return result
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
    if (!complete && result) {
      clear(result.clientActivationNonce)
      clear(result.exitOriginCommandPolicyDigest)
      clear(result.payloadParametersDigest)
    }
  }
}

function writeUint16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeUint32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function writeUint64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1]
}

function readUint32(buffer, offset) {
  return (
    buffer[offset] * 0x1000000 +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
  )
}

function readUint64(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

function clear(buffer) {
  try {
    if (b4a.isBuffer(buffer)) bufferFill.call(buffer, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function readPolicyEntry(encoded, offset) {
  return {
    commandId: readUint16(encoded, offset),
    commandVersion: readUint16(encoded, offset + 2),
    maxRequestBytes: readUint32(encoded, offset + 4),
    maxResponseBytes: readUint32(encoded, offset + 8),
    timeoutMs: readUint32(encoded, offset + 12),
    maxOutstanding: readUint16(encoded, offset + 16),
    requestCost: readUint32(encoded, offset + 18),
    responseCost: readUint32(encoded, offset + 22),
    maxAmplificationBytes: readUint32(encoded, offset + 26),
    mutationFlag: encoded[offset + 30],
    destinationValidationClass: encoded[offset + 31]
  }
}

function exactPolicyEntry(actual, expected) {
  for (const name of Object.keys(expected)) {
    if (option(actual, name) !== expected[name]) invalid()
  }
}

export function encodeExitOriginServicePolicy(entries = EXIT_ORIGIN_SERVICE_POLICY) {
  try {
    if (!Array.isArray(entries) || entries.length !== EXIT_ORIGIN_SERVICE_POLICY.length) invalid()
    const output = b4a.allocUnsafe(2 + entries.length * SERVICE_POLICY_ENTRY_SIZE)
    writeUint16(output, entries.length, 0)
    let offset = 2

    for (let index = 0; index < entries.length; index++) {
      const entry = object(entries[index])
      exactPolicyEntry(entry, EXIT_ORIGIN_SERVICE_POLICY[index])
      const values = Object.values(EXIT_ORIGIN_SERVICE_POLICY[index])
      if (
        !uint16(values[0]) ||
        !uint16(values[1]) ||
        !uint32(values[2]) ||
        !uint32(values[3]) ||
        !uint32(values[4]) ||
        !uint16(values[5]) ||
        !uint32(values[6]) ||
        !uint32(values[7]) ||
        !uint32(values[8]) ||
        !uint8(values[9]) ||
        !uint8(values[10])
      ) {
        invalid()
      }
      writeUint16(output, values[0], offset)
      writeUint16(output, values[1], offset + 2)
      writeUint32(output, values[2], offset + 4)
      writeUint32(output, values[3], offset + 8)
      writeUint32(output, values[4], offset + 12)
      writeUint16(output, values[5], offset + 16)
      writeUint32(output, values[6], offset + 18)
      writeUint32(output, values[7], offset + 22)
      writeUint32(output, values[8], offset + 26)
      output[offset + 30] = values[9]
      output[offset + 31] = values[10]
      offset += SERVICE_POLICY_ENTRY_SIZE
    }
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodeExitOriginServicePolicy(encoded) {
  try {
    if (!fixed(encoded, 2 + 9 * SERVICE_POLICY_ENTRY_SIZE) || readUint16(encoded, 0) !== 9) {
      invalid()
    }
    const entries = []
    let offset = 2
    for (let index = 0; index < EXIT_ORIGIN_SERVICE_POLICY.length; index++) {
      const entry = readPolicyEntry(encoded, offset)
      exactPolicyEntry(entry, EXIT_ORIGIN_SERVICE_POLICY[index])
      entries.push(entry)
      offset += SERVICE_POLICY_ENTRY_SIZE
    }
    return entries
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function digestExitOriginServicePolicy(value = EXIT_ORIGIN_SERVICE_POLICY) {
  let encoded = null
  try {
    if (bufferLength(value) >= 0) {
      decodeExitOriginServicePolicy(value)
      encoded = copy(value)
    } else {
      encoded = encodeExitOriginServicePolicy(value)
    }
    return copy(cryptoSuite.hash([POLICY_DOMAIN, encoded]))
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    clear(encoded)
  }
}

export function encodePayloadParameters(value) {
  try {
    object(value)
    const fields = [
      option(value, 'cellSize'),
      option(value, 'maxCellPayload'),
      option(value, 'contextEnvelopeSize'),
      option(value, 'routeFrameSize'),
      option(value, 'maxRoutePayload'),
      option(value, 'datagramReplayWindow'),
      option(value, 'maxQueuedBytes'),
      option(value, 'idleTimeoutMs')
    ]
    const fixedFields = [1200, 1146, 1101, 1100, 1073, 64]
    for (let index = 0; index < fixedFields.length; index++) {
      if (fields[index] !== fixedFields[index] || !uint16(fields[index])) invalid()
    }
    if (!uint32(fields[6]) || !uint32(fields[7]) || fields[6] === 0 || fields[7] === 0) invalid()

    const output = b4a.allocUnsafe(PAYLOAD_PARAMETERS_SIZE)
    for (let index = 0; index < 6; index++) writeUint16(output, fields[index], index * 2)
    writeUint32(output, fields[6], 12)
    writeUint32(output, fields[7], 16)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodePayloadParameters(encoded) {
  if (!fixed(encoded, PAYLOAD_PARAMETERS_SIZE)) invalid()
  const value = {
    cellSize: readUint16(encoded, 0),
    maxCellPayload: readUint16(encoded, 2),
    contextEnvelopeSize: readUint16(encoded, 4),
    routeFrameSize: readUint16(encoded, 6),
    maxRoutePayload: readUint16(encoded, 8),
    datagramReplayWindow: readUint16(encoded, 10),
    maxQueuedBytes: readUint32(encoded, 12),
    idleTimeoutMs: readUint32(encoded, 16)
  }
  const canonical = encodePayloadParameters(value)
  clear(canonical)
  return value
}

export function digestPayloadParameters(value) {
  let encoded = null
  try {
    encoded = bufferLength(value) >= 0 ? copy(value) : encodePayloadParameters(value)
    decodePayloadParameters(encoded)
    return copy(cryptoSuite.hash([PARAMETERS_DOMAIN, encoded]))
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  } finally {
    clear(encoded)
  }
}

export function encodeFinalExitTranscript(value) {
  try {
    object(value)
    const selectedBranchClass = branchClass(option(value, 'branchClass'))
    const branchId = option(value, 'branchId')
    const circuitId = option(value, 'circuitId')
    const generation = option(value, 'generation')
    const fields = [
      option(value, 'tailControlTranscriptDigest'),
      option(value, 'exitAdvertisementDigest'),
      option(value, 'exitIdentity'),
      option(value, 'clientActivationNonce'),
      option(value, 'exitOriginCommandPolicyDigest'),
      option(value, 'payloadParametersDigest')
    ]
    if (!fixed(branchId, 16) || !fixed(circuitId, 16) || !uint64(generation)) invalid()
    if (fields.some((field) => !fixed(field, 32))) invalid()

    const output = b4a.allocUnsafe(FINAL_EXIT_TRANSCRIPT_SIZE)
    let offset = 0
    const finalDomainBytes = bufferLength(FINAL_DOMAIN)
    writeUint16(output, finalDomainBytes, offset)
    offset += 2
    set(output, FINAL_DOMAIN, offset)
    offset += finalDomainBytes
    writeUint32(output, M3_PROTOCOL_VERSION, offset)
    offset += 4
    output[offset++] = selectedBranchClass
    set(output, branchId, offset)
    offset += 16
    set(output, circuitId, offset)
    offset += 16
    writeUint64(output, generation, offset)
    offset += 8
    for (const field of fields) {
      set(output, field, offset)
      offset += 32
    }
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function validateFinalExitTranscript(encoded) {
  if (!fixed(encoded, FINAL_EXIT_TRANSCRIPT_SIZE)) invalid()
  const finalDomainBytes = bufferLength(FINAL_DOMAIN)
  if (readUint16(encoded, 0) !== finalDomainBytes) invalid()
  if (!b4a.equals(subarray(encoded, 2, 2 + finalDomainBytes), FINAL_DOMAIN)) invalid()

  let offset = 2 + finalDomainBytes
  if (readUint32(encoded, offset) !== M3_PROTOCOL_VERSION) invalid()
  offset += 4
  branchClass(encoded[offset])
}

export function decodeFinalExitTranscript(encoded) {
  try {
    validateFinalExitTranscript(encoded)
    const finalDomainBytes = bufferLength(FINAL_DOMAIN)
    let offset = 2 + finalDomainBytes
    offset += 4
    const selectedBranchClass = encoded[offset++]
    const branchId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const circuitId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const generation = readUint64(encoded, offset)
    offset += 8
    const fields = []
    for (let index = 0; index < 6; index++) {
      fields.push(copy(subarray(encoded, offset, offset + 32)))
      offset += 32
    }
    return {
      branchClass: selectedBranchClass,
      branchId,
      circuitId,
      generation,
      tailControlTranscriptDigest: fields[0],
      exitAdvertisementDigest: fields[1],
      exitIdentity: fields[2],
      clientActivationNonce: fields[3],
      exitOriginCommandPolicyDigest: fields[4],
      payloadParametersDigest: fields[5]
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function derive(sharedSecret, label, transcript) {
  let input = null
  let output = null
  try {
    const labelBytes = b4a.from(label)
    const labelLength = bufferLength(labelBytes)
    const transcriptLength = bufferLength(transcript)
    input = b4a.allocUnsafe(2 + labelLength + 4 + 4 + transcriptLength)
    writeUint16(input, labelLength, 0)
    set(input, labelBytes, 2)
    writeUint32(input, M3_PROTOCOL_VERSION, 2 + labelLength)
    writeUint32(input, transcriptLength, 6 + labelLength)
    set(input, transcript, 10 + labelLength)
    output = b4a.allocUnsafeSlow(32)
    sodium.crypto_generichash(output, input, sharedSecret)
    return output
  } catch {
    clear(output)
    invalid()
  } finally {
    clear(input)
  }
}

export function deriveFinalExitTestVector(sharedSecret, transcript) {
  if (!fixed(sharedSecret, 32)) invalid()
  validateFinalExitTranscript(transcript)
  const result = {}
  const owned = []
  let complete = false
  try {
    for (const [name, label] of Object.entries(FINAL_LABELS)) {
      const output = derive(sharedSecret, label, transcript)
      owned.push(output)
      if (name.endsWith('Nonce')) result[`${name}Prefix`] = copy(subarray(output, 0, 16))
      else result[name] = output
    }
    complete = true
    return Object.freeze(result)
  } finally {
    for (const output of owned) {
      if (!Object.values(result).includes(output) || !complete) clear(output)
    }
    if (!complete) {
      for (const output of Object.values(result)) clear(output)
    }
  }
}
