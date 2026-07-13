import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { CAPABILITY, DOMAIN, PROTOCOL_VERSION, ROLE, roleForIdentity } from './protocol.js'

export const AUTHORIZATION_MODE = Object.freeze({ DIRECT: 0, DELEGATED: 1 })

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const MAX_DIAL = 256
const MAX_ENTRY_ADVERTISEMENT = 1024
const MAX_ENCRYPTED_HOPS = 4096
const MAX_DESCRIPTOR = 8192
const DELEGATION_BYTES = 168
const VERIFIED = new WeakMap()

function invalid() {
  return PrivateRouteError.INVALID_DESCRIPTOR()
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function checkBuffer(value, size) {
  if (!b4a.isBuffer(value) || (size !== undefined && value.byteLength !== size)) throw invalid()
}

function checkU32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw invalid()
}

function checkU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw invalid()
}

function checkU8(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw invalid()
}

function checkU64(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) throw invalid()
}

function checkVersion(value) {
  checkU32(value)
  if (value !== PROTOCOL_VERSION) throw invalid()
}

function checkCapabilities(value) {
  checkU32(value)
  if ((value & ~CAPABILITY.KNOWN) !== 0) throw invalid()
}

function writer(size) {
  const buffer = b4a.allocUnsafe(size)
  let offset = 0

  return {
    buffer,
    u8(value) {
      checkU8(value)
      buffer[offset++] = value
    },
    u16(value) {
      checkU16(value)
      buffer[offset++] = value >>> 8
      buffer[offset++] = value
    },
    u32(value) {
      checkU32(value)
      buffer[offset++] = value >>> 24
      buffer[offset++] = value >>> 16
      buffer[offset++] = value >>> 8
      buffer[offset++] = value
    },
    u64(value) {
      checkU64(value)
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        buffer[offset++] = Number((value >> shift) & 0xffn)
      }
    },
    fixed(value, size) {
      checkBuffer(value, size)
      buffer.set(value, offset)
      offset += size
    },
    bounded(value, maximum) {
      checkBuffer(value)
      if (value.byteLength > maximum) throw invalid()
      this.u16(value.byteLength)
      this.fixed(value, value.byteLength)
    }
  }
}

function reader(buffer, maximum = Infinity) {
  checkBuffer(buffer)
  if (buffer.byteLength > maximum) throw invalid()
  let offset = 0

  function requireBytes(size) {
    if (size < 0 || offset + size > buffer.byteLength) throw invalid()
  }

  return {
    u8() {
      requireBytes(1)
      return buffer[offset++]
    },
    u16() {
      requireBytes(2)
      const value = buffer[offset] * 0x100 + buffer[offset + 1]
      offset += 2
      return value
    },
    u32() {
      requireBytes(4)
      const value =
        buffer[offset] * 0x1000000 +
        buffer[offset + 1] * 0x10000 +
        buffer[offset + 2] * 0x100 +
        buffer[offset + 3]
      offset += 4
      return value
    },
    u64() {
      requireBytes(8)
      let value = 0n
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(buffer[offset++])
      return value
    },
    fixed(size) {
      requireBytes(size)
      const value = b4a.from(buffer.subarray(offset, offset + size))
      offset += size
      return value
    },
    bounded(maximumSize, nonempty = false) {
      const size = this.u16()
      if (size > maximumSize || (nonempty && size === 0)) throw invalid()
      return this.fixed(size)
    },
    done() {
      if (offset !== buffer.byteLength) throw invalid()
    }
  }
}

function validateAdvertisement(value, signed) {
  if (!isObject(value)) throw invalid()
  checkVersion(value.version)
  checkBuffer(value.identityKey, 32)
  checkBuffer(value.routeEncryptionKey, 32)
  checkBuffer(value.dial)
  if (value.dial.byteLength === 0 || value.dial.byteLength > MAX_DIAL) throw invalid()
  checkU8(value.role)
  if (value.role !== ROLE.SAFETY && value.role !== ROLE.PRIVATE) throw invalid()
  checkCapabilities(value.capabilities)
  checkU64(value.epoch)
  checkU64(value.expiresAt)
  if (signed) checkBuffer(value.relaySignature, 64)
}

export function encodeUnsignedRelayAdvertisement(value) {
  validateAdvertisement(value, false)
  const output = writer(91 + value.dial.byteLength)
  output.u32(value.version)
  output.fixed(value.identityKey, 32)
  output.fixed(value.routeEncryptionKey, 32)
  output.bounded(value.dial, MAX_DIAL)
  output.u8(value.role)
  output.u32(value.capabilities)
  output.u64(value.epoch)
  output.u64(value.expiresAt)
  return output.buffer
}

export function encodeRelayAdvertisement(value) {
  validateAdvertisement(value, true)
  return b4a.concat([encodeUnsignedRelayAdvertisement(value), b4a.from(value.relaySignature)])
}

export function decodeRelayAdvertisement(buffer) {
  return decodeAdvertisement(buffer, true)
}

export function decodeUnsignedRelayAdvertisement(buffer) {
  return decodeAdvertisement(buffer, false)
}

function decodeAdvertisement(buffer, signed) {
  const input = reader(buffer, 91 + MAX_DIAL + 64)
  const value = {
    version: input.u32(),
    identityKey: input.fixed(32),
    routeEncryptionKey: input.fixed(32),
    dial: input.bounded(MAX_DIAL, true),
    role: input.u8(),
    capabilities: input.u32(),
    epoch: input.u64(),
    expiresAt: input.u64()
  }
  if (signed) value.relaySignature = input.fixed(64)
  input.done()
  validateAdvertisement(value, signed)
  return value
}

function validateDelegation(value, signed) {
  if (!isObject(value)) throw invalid()
  checkVersion(value.version)
  checkBuffer(value.endpointKey, 32)
  checkBuffer(value.routeSigningKey, 32)
  checkU64(value.notBefore)
  checkU64(value.expiresAt)
  checkU64(value.minEpoch)
  checkU64(value.maxEpoch)
  checkCapabilities(value.capabilities)
  if (signed) checkBuffer(value.endpointSignature, 64)
}

export function encodeUnsignedDelegation(value) {
  validateDelegation(value, false)
  const output = writer(DELEGATION_BYTES - 64)
  output.u32(value.version)
  output.fixed(value.endpointKey, 32)
  output.fixed(value.routeSigningKey, 32)
  output.u64(value.notBefore)
  output.u64(value.expiresAt)
  output.u64(value.minEpoch)
  output.u64(value.maxEpoch)
  output.u32(value.capabilities)
  return output.buffer
}

export function encodeDelegation(value) {
  validateDelegation(value, true)
  return b4a.concat([encodeUnsignedDelegation(value), b4a.from(value.endpointSignature)])
}

export function decodeDelegation(buffer) {
  return decodeDelegationValue(buffer, true)
}

export function decodeUnsignedDelegation(buffer) {
  return decodeDelegationValue(buffer, false)
}

function decodeDelegationValue(buffer, signed) {
  const expectedSize = DELEGATION_BYTES - (signed ? 0 : 64)
  if (!b4a.isBuffer(buffer) || buffer.byteLength !== expectedSize) throw invalid()
  const input = reader(buffer, DELEGATION_BYTES)
  const value = {
    version: input.u32(),
    endpointKey: input.fixed(32),
    routeSigningKey: input.fixed(32),
    notBefore: input.u64(),
    expiresAt: input.u64(),
    minEpoch: input.u64(),
    maxEpoch: input.u64(),
    capabilities: input.u32()
  }
  if (signed) value.endpointSignature = input.fixed(64)
  input.done()
  validateDelegation(value, signed)
  return value
}

function validateDescriptor(value, signed) {
  if (!isObject(value)) throw invalid()
  checkVersion(value.version)
  checkU8(value.authorizationMode)
  if (
    value.authorizationMode !== AUTHORIZATION_MODE.DIRECT &&
    value.authorizationMode !== AUTHORIZATION_MODE.DELEGATED
  )
    throw invalid()
  checkBuffer(value.descriptorId, 32)
  checkBuffer(value.endpointKey, 32)
  checkBuffer(value.routeSigningKey, 32)
  checkBuffer(value.routeEncryptionKey, 32)
  checkBuffer(value.entryAdvertisement)
  if (value.entryAdvertisement.byteLength > MAX_ENTRY_ADVERTISEMENT) throw invalid()
  decodeRelayAdvertisement(value.entryAdvertisement)
  checkU64(value.epoch)
  checkU64(value.expiresAt)
  checkCapabilities(value.capabilities)
  checkU16(value.cellSize)
  if (value.cellSize !== 1200) throw invalid()
  checkBuffer(value.encryptedHops)
  if (value.encryptedHops.byteLength === 0 || value.encryptedHops.byteLength > MAX_ENCRYPTED_HOPS)
    throw invalid()
  if (value.authorizationMode === AUTHORIZATION_MODE.DIRECT) {
    if (value.delegation !== undefined) throw invalid()
  } else {
    validateDelegation(value.delegation, true)
  }
  if (signed) checkBuffer(value.signature, 64)
}

export function encodeUnsignedDescriptor(value) {
  validateDescriptor(value, false)
  const delegationSize =
    value.authorizationMode === AUTHORIZATION_MODE.DELEGATED ? DELEGATION_BYTES : 0
  const size =
    4 +
    1 +
    32 * 4 +
    2 +
    value.entryAdvertisement.byteLength +
    8 +
    8 +
    4 +
    2 +
    2 +
    value.encryptedHops.byteLength +
    delegationSize
  if (size + 64 > MAX_DESCRIPTOR) throw invalid()
  const output = writer(size)
  output.u32(value.version)
  output.u8(value.authorizationMode)
  output.fixed(value.descriptorId, 32)
  output.fixed(value.endpointKey, 32)
  output.fixed(value.routeSigningKey, 32)
  output.fixed(value.routeEncryptionKey, 32)
  output.bounded(value.entryAdvertisement, MAX_ENTRY_ADVERTISEMENT)
  output.u64(value.epoch)
  output.u64(value.expiresAt)
  output.u32(value.capabilities)
  output.u16(value.cellSize)
  output.bounded(value.encryptedHops, MAX_ENCRYPTED_HOPS)
  if (delegationSize) output.fixed(encodeDelegation(value.delegation), DELEGATION_BYTES)
  return output.buffer
}

export function encodeDescriptor(value) {
  validateDescriptor(value, true)
  return b4a.concat([encodeUnsignedDescriptor(value), b4a.from(value.signature)])
}

export function decodeDescriptor(buffer) {
  return decodeDescriptorValue(buffer, true)
}

export function decodeUnsignedDescriptor(buffer) {
  return decodeDescriptorValue(buffer, false)
}

function decodeDescriptorValue(buffer, signed) {
  const input = reader(buffer, MAX_DESCRIPTOR)
  const value = {
    version: input.u32(),
    authorizationMode: input.u8(),
    descriptorId: input.fixed(32),
    endpointKey: input.fixed(32),
    routeSigningKey: input.fixed(32),
    routeEncryptionKey: input.fixed(32),
    entryAdvertisement: input.bounded(MAX_ENTRY_ADVERTISEMENT),
    epoch: input.u64(),
    expiresAt: input.u64(),
    capabilities: input.u32(),
    cellSize: input.u16(),
    encryptedHops: input.bounded(MAX_ENCRYPTED_HOPS, true)
  }
  if (value.authorizationMode === AUTHORIZATION_MODE.DELEGATED)
    value.delegation = decodeDelegation(input.fixed(DELEGATION_BYTES))
  else if (value.authorizationMode !== AUTHORIZATION_MODE.DIRECT) throw invalid()
  if (signed) value.signature = input.fixed(64)
  input.done()
  validateDescriptor(value, signed)
  return value
}

function signedMessage(domain, encoding) {
  return b4a.concat([domain, encoding])
}

export function signRelayAdvertisement(value, secretKey) {
  const unsigned = encodeUnsignedRelayAdvertisement(value)
  return copyValue({
    ...value,
    relaySignature: cryptoSuite.sign(signedMessage(DOMAIN.RELAY_ADVERTISEMENT, unsigned), secretKey)
  })
}

export function signDelegation(value, secretKey) {
  const unsigned = encodeUnsignedDelegation(value)
  return copyValue({
    ...value,
    endpointSignature: cryptoSuite.sign(signedMessage(DOMAIN.DELEGATION, unsigned), secretKey)
  })
}

export function signDescriptor(value, secretKey) {
  const unsigned = encodeUnsignedDescriptor(value)
  const domain =
    value.authorizationMode === AUTHORIZATION_MODE.DIRECT
      ? DOMAIN.DESCRIPTOR_DIRECT
      : DOMAIN.DESCRIPTOR_DELEGATED
  return copyValue({
    ...value,
    signature: cryptoSuite.sign(signedMessage(domain, unsigned), secretKey)
  })
}

function copyValue(value) {
  if (b4a.isBuffer(value)) return b4a.from(value)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [name, field] of Object.entries(value)) output[name] = copyValue(field)
    return output
  }
  return value
}

function rejectUnauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function rejectInvalid() {
  throw PrivateRouteError.INVALID_DESCRIPTOR()
}

// Returned data describes authorization and routing metadata only. Possession and activation are separate.
export function verifyDescriptor(encoding, options) {
  const descriptor = decodeDescriptor(encoding)
  if (!isObject(options)) rejectInvalid()
  checkBuffer(options.requestedEndpointKey, 32)
  checkU64(options.now)

  const entry = decodeRelayAdvertisement(descriptor.entryAdvertisement)

  if (descriptor.expiresAt <= options.now || entry.expiresAt <= options.now) rejectInvalid()
  if (descriptor.expiresAt > entry.expiresAt) rejectInvalid()
  if (descriptor.epoch !== entry.epoch) rejectInvalid()
  if ((descriptor.capabilities & entry.capabilities) !== descriptor.capabilities) rejectInvalid()

  if (!b4a.equals(descriptor.endpointKey, options.requestedEndpointKey)) rejectUnauthorized()
  if (entry.role !== ROLE.PRIVATE || roleForIdentity(entry.identityKey) !== ROLE.PRIVATE)
    rejectInvalid()
  if (b4a.equals(descriptor.routeEncryptionKey, entry.routeEncryptionKey)) rejectInvalid()

  if (descriptor.authorizationMode === AUTHORIZATION_MODE.DIRECT) {
    if (!b4a.equals(descriptor.routeSigningKey, descriptor.endpointKey)) rejectUnauthorized()
  } else {
    verifyDelegatedScope(descriptor, options.now)
  }

  const relayMessage = signedMessage(
    DOMAIN.RELAY_ADVERTISEMENT,
    encodeUnsignedRelayAdvertisement(entry)
  )
  if (!cryptoSuite.verify(relayMessage, entry.relaySignature, entry.identityKey))
    rejectUnauthorized()

  let descriptorDomain = DOMAIN.DESCRIPTOR_DIRECT
  if (descriptor.authorizationMode === AUTHORIZATION_MODE.DELEGATED) {
    const delegation = descriptor.delegation
    const delegationMessage = signedMessage(DOMAIN.DELEGATION, encodeUnsignedDelegation(delegation))
    if (
      !cryptoSuite.verify(delegationMessage, delegation.endpointSignature, delegation.endpointKey)
    )
      rejectUnauthorized()
    descriptorDomain = DOMAIN.DESCRIPTOR_DELEGATED
  }

  const descriptorMessage = signedMessage(descriptorDomain, encodeUnsignedDescriptor(descriptor))
  if (!cryptoSuite.verify(descriptorMessage, descriptor.signature, descriptor.routeSigningKey))
    rejectUnauthorized()

  const state = copyValue({ ...descriptor, entry, encoding })
  const verified = Object.freeze({})
  VERIFIED.set(verified, state)
  return verified
}

function verifyDelegatedScope(descriptor, now) {
  const delegation = descriptor.delegation
  if (!delegation) rejectUnauthorized()
  if (!b4a.equals(delegation.endpointKey, descriptor.endpointKey)) rejectUnauthorized()
  if (!b4a.equals(delegation.routeSigningKey, descriptor.routeSigningKey)) rejectUnauthorized()
  if (now < delegation.notBefore || now >= delegation.expiresAt) rejectUnauthorized()
  if (descriptor.epoch < delegation.minEpoch || descriptor.epoch > delegation.maxEpoch)
    rejectUnauthorized()
  if (descriptor.expiresAt > delegation.expiresAt) rejectUnauthorized()
  if ((descriptor.capabilities & delegation.capabilities) !== descriptor.capabilities)
    rejectUnauthorized()
}

export function isVerifiedDescriptor(value) {
  return isObject(value) && VERIFIED.has(value)
}

export function readVerifiedDescriptor(value) {
  const state = isObject(value) ? VERIFIED.get(value) : null
  if (!state) throw invalid()
  return copyValue(state)
}
