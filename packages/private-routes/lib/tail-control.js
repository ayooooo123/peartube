import b4a from 'b4a'
import sodium from 'sodium-universal'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { BRANCH_CLASS, M3_PROTOCOL_VERSION } from './protocol.js'

export const ADMITTED_LIMITS_SIZE = 26
export const TAIL_CONTROL_TRANSCRIPT_SIZE = 290

const MAX_UINT32 = 0xffff_ffff
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const TAIL_DOMAIN = b4a.from('hyperdht-private-routes/tail-control/transcript/v1')
const LIMITS_DOMAIN = b4a.from('hyperdht-private-routes/tail-control/limits/v1')
const TAIL_DIGEST_DOMAIN = b4a.from('hyperdht-private-routes/final-exit/tail-digest/v1')
const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

const TAIL_LABELS = Object.freeze({
  forwardKey: 'hyperdht-private-routes/kdf/v1/tail-control/forward-key',
  reverseKey: 'hyperdht-private-routes/kdf/v1/tail-control/reverse-key',
  forwardNonce: 'hyperdht-private-routes/kdf/v1/tail-control/forward-nonce',
  reverseNonce: 'hyperdht-private-routes/kdf/v1/tail-control/reverse-nonce'
})

const FINALIZE_LABELS = Object.freeze({
  finalizeForwardKey: 'hyperdht-private-routes/kdf/v1/tail-finalize/forward-key',
  finalizeReverseKey: 'hyperdht-private-routes/kdf/v1/tail-finalize/reverse-key',
  finalizeForwardNonce: 'hyperdht-private-routes/kdf/v1/tail-finalize/forward-nonce',
  finalizeReverseNonce: 'hyperdht-private-routes/kdf/v1/tail-finalize/reverse-nonce'
})

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

function extensionIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2) invalid()
  return value
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

export function encodeAdmittedLimits(value) {
  try {
    object(value)
    const cellSize = option(value, 'cellSize')
    const maxCells = option(value, 'maxCells')
    const maxBytes = option(value, 'maxBytes')
    const maxCommands = option(value, 'maxCommands')
    const idleTimeoutMs = option(value, 'idleTimeoutMs')
    const expiresAtMs = option(value, 'expiresAtMs')

    if (
      cellSize !== 1200 ||
      !uint16(cellSize) ||
      !uint32(maxCells) ||
      maxCells === 0 ||
      !uint32(maxBytes) ||
      maxBytes === 0 ||
      !uint32(maxCommands) ||
      maxCommands === 0 ||
      !uint32(idleTimeoutMs) ||
      idleTimeoutMs === 0 ||
      !uint64(expiresAtMs) ||
      expiresAtMs === 0n
    ) {
      invalid()
    }

    const output = b4a.allocUnsafe(ADMITTED_LIMITS_SIZE)
    writeUint16(output, cellSize, 0)
    writeUint32(output, maxCells, 2)
    writeUint32(output, maxBytes, 6)
    writeUint32(output, maxCommands, 10)
    writeUint32(output, idleTimeoutMs, 14)
    writeUint64(output, expiresAtMs, 18)
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function decodeAdmittedLimits(encoded) {
  if (!fixed(encoded, ADMITTED_LIMITS_SIZE)) invalid()
  const value = {
    cellSize: readUint16(encoded, 0),
    maxCells: readUint32(encoded, 2),
    maxBytes: readUint32(encoded, 6),
    maxCommands: readUint32(encoded, 10),
    idleTimeoutMs: readUint32(encoded, 14),
    expiresAtMs: readUint64(encoded, 18)
  }
  const canonical = encodeAdmittedLimits(value)
  clear(canonical)
  return value
}

export function digestAdmittedLimits(value) {
  const encoded = encodeAdmittedLimits(value)
  try {
    return copy(cryptoSuite.hash([LIMITS_DOMAIN, encoded]))
  } finally {
    clear(encoded)
  }
}

export function encodeTailControlTranscript(value) {
  try {
    object(value)
    const selectedBranchClass = branchClass(option(value, 'branchClass'))
    const branchId = option(value, 'branchId')
    const circuitId = option(value, 'circuitId')
    const generation = option(value, 'generation')
    const selectedExtensionIndex = extensionIndex(option(value, 'extensionIndex'))
    const clientTailEphemeralPublicKey = option(value, 'clientTailEphemeralPublicKey')
    const advertisedTailRouteEncryptionPublicKey = option(
      value,
      'advertisedTailRouteEncryptionPublicKey'
    )
    const candidateAdvertisementDigest = option(value, 'candidateAdvertisementDigest')
    const clientNonce = option(value, 'clientNonce')
    const tailIdentity = option(value, 'tailIdentity')
    const admittedLimitsDigest = option(value, 'admittedLimitsDigest')

    if (
      !fixed(branchId, 16) ||
      !fixed(circuitId, 16) ||
      !uint64(generation) ||
      !fixed(clientTailEphemeralPublicKey, 32) ||
      !fixed(advertisedTailRouteEncryptionPublicKey, 32) ||
      !fixed(candidateAdvertisementDigest, 32) ||
      !fixed(clientNonce, 32) ||
      !fixed(tailIdentity, 32) ||
      !fixed(admittedLimitsDigest, 32)
    ) {
      invalid()
    }

    const output = b4a.allocUnsafe(TAIL_CONTROL_TRANSCRIPT_SIZE)
    let offset = 0
    const tailDomainBytes = bufferLength(TAIL_DOMAIN)
    writeUint16(output, tailDomainBytes, offset)
    offset += 2
    set(output, TAIL_DOMAIN, offset)
    offset += tailDomainBytes
    writeUint32(output, M3_PROTOCOL_VERSION, offset)
    offset += 4
    output[offset++] = selectedBranchClass
    set(output, branchId, offset)
    offset += 16
    set(output, circuitId, offset)
    offset += 16
    writeUint64(output, generation, offset)
    offset += 8
    output[offset++] = selectedExtensionIndex
    for (const field of [
      clientTailEphemeralPublicKey,
      advertisedTailRouteEncryptionPublicKey,
      candidateAdvertisementDigest,
      clientNonce,
      tailIdentity,
      admittedLimitsDigest
    ]) {
      set(output, field, offset)
      offset += 32
    }
    return output
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

function validateTailControlTranscript(encoded) {
  if (!fixed(encoded, TAIL_CONTROL_TRANSCRIPT_SIZE)) invalid()
  const tailDomainBytes = bufferLength(TAIL_DOMAIN)
  if (readUint16(encoded, 0) !== tailDomainBytes) invalid()
  if (!b4a.equals(subarray(encoded, 2, 2 + tailDomainBytes), TAIL_DOMAIN)) invalid()

  let offset = 2 + tailDomainBytes
  if (readUint32(encoded, offset) !== M3_PROTOCOL_VERSION) invalid()
  offset += 4
  branchClass(encoded[offset++])
  offset += 16 + 16 + 8
  return extensionIndex(encoded[offset])
}

export function decodeTailControlTranscript(encoded) {
  try {
    validateTailControlTranscript(encoded)
    const tailDomainBytes = bufferLength(TAIL_DOMAIN)
    let offset = 2 + tailDomainBytes
    offset += 4
    const selectedBranchClass = encoded[offset++]
    const branchId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const circuitId = copy(subarray(encoded, offset, offset + 16))
    offset += 16
    const generation = readUint64(encoded, offset)
    offset += 8
    const selectedExtensionIndex = encoded[offset++]
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
      extensionIndex: selectedExtensionIndex,
      clientTailEphemeralPublicKey: fields[0],
      advertisedTailRouteEncryptionPublicKey: fields[1],
      candidateAdvertisementDigest: fields[2],
      clientNonce: fields[3],
      tailIdentity: fields[4],
      admittedLimitsDigest: fields[5]
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalid()
  }
}

export function digestTailControlTranscript(transcript) {
  validateTailControlTranscript(transcript)
  return copy(cryptoSuite.hash([TAIL_DIGEST_DOMAIN, transcript]))
}

function derive(secret, label, transcript) {
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
    sodium.crypto_generichash(output, input, secret)
    return output
  } catch {
    clear(output)
    invalid()
  } finally {
    clear(input)
  }
}

export function deriveTailControlTestVector(sharedSecret, transcript, selectedExtensionIndex) {
  if (!fixed(sharedSecret, 32)) invalid()
  const transcriptExtensionIndex = validateTailControlTranscript(transcript)
  if (extensionIndex(selectedExtensionIndex) !== transcriptExtensionIndex) invalid()

  const labels = selectedExtensionIndex === 2 ? { ...TAIL_LABELS, ...FINALIZE_LABELS } : TAIL_LABELS
  const result = {}
  const owned = []
  let complete = false

  try {
    for (const [name, label] of Object.entries(labels)) {
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
