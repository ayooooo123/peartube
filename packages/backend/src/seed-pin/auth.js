import b4a from 'b4a'
import IdentityKey from 'keet-identity-key'
import c from 'compact-encoding'
import IdentityEncoding from 'keet-identity-key/lib/encoding.js'

import {
  CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
  createChannelRootDescriptor,
  encodeCanonicalJson,
  verifySignedChannelRootDescriptor,
} from '../channel-descriptor.js'
import {
  DURABLE_MANIFEST_VERSION,
  createDurableManifest,
  encodeDurableManifest,
} from './manifest.js'

export const SEED_PIN_REQUEST_VERSION = 1

const AUTH_DOMAIN = b4a.from('peartube.seed-pin.request/v1\0')
const LOWERCASE_HEX_32_PATTERN = /^[0-9a-f]{64}$/
const LOWERCASE_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/
const MAX_ATTESTATION_BYTES = 16 * 1024
const { ProofEncoding } = IdentityEncoding
const REQUEST_FIELDS = new Set([
  'version',
  'manifest',
  'requestId',
  'expiresAt',
  'signedDescriptor',
  'attestation',
])
const MANIFEST_FIELDS = new Set(['version', 'channelKey', 'rowId', 'refs', 'assets', 'requestId'])
const REF_FIELDS = new Set(['coreKey', 'start', 'end', 'kind'])
const SIGNED_DESCRIPTOR_FIELDS = new Set(['schema', 'descriptor', 'proof', 'attestation'])
const DESCRIPTOR_FIELDS = new Set([
  'schema',
  'channelId',
  'identityPublicKey',
  'metadataKey',
  'mediaKey',
  'seq',
  'createdAt',
  'updatedAt',
  'profile',
  'capabilities',
])
const VERIFY_OPTION_FIELDS = new Set(['remotePublicKey', 'now'])

function isByteArray (value) {
  return value instanceof Uint8Array || b4a.isBuffer(value)
}

function assertRecord (value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`)
  }
  return value
}

function assertExactFields (value, allowed, name) {
  assertRecord(value, name)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${name} contains unsupported field ${String(key)}`)
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name}.${key} is required`)
    }
  }
}

function normalizeHex32 (value, name) {
  if (typeof value !== 'string' || !LOWERCASE_HEX_32_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase 32-byte hex value`)
  }
  return value
}

function normalizeHexBytes (value, name) {
  if (typeof value !== 'string' || !LOWERCASE_HEX_PATTERN.test(value)) {
    throw new TypeError(`${name} must be nonempty lowercase hex bytes`)
  }
  const byteLength = value.length / 2
  if (byteLength > MAX_ATTESTATION_BYTES) {
    throw new RangeError(`${name} exceeds ${MAX_ATTESTATION_BYTES} bytes`)
  }
  return value
}

function canonicalIdentityProofBytes (value, name) {
  if (!isByteArray(value)) throw new TypeError(`${name} must be bytes`)
  if (value.byteLength === 0 || value.byteLength > MAX_ATTESTATION_BYTES) {
    throw new RangeError(`${name} has an invalid size`)
  }
  const bytes = b4a.from(value)
  let canonical
  try {
    const decoded = c.decode(ProofEncoding, bytes)
    canonical = c.encode(ProofEncoding, decoded)
  } catch (error) {
    throw new TypeError(`${name} has invalid compact encoding: ${error?.message || String(error)}`)
  }
  if (!b4a.equals(bytes, canonical)) {
    throw new TypeError(`${name} must use canonical compact encoding without trailing bytes`)
  }
  return bytes
}

function canonicalIdentityProofHex (value, name) {
  const hex = normalizeHexBytes(value, name)
  canonicalIdentityProofBytes(b4a.from(hex, 'hex'), name)
  return hex
}

function normalizeBytes32 (value, name) {
  if (!isByteArray(value) || value.byteLength !== 32) {
    throw new TypeError(`${name} must be exactly 32 bytes`)
  }
  return b4a.from(value)
}

function normalizeProofInput (value) {
  return canonicalIdentityProofBytes(value, 'deviceProof')
}

function normalizeSafeInteger (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`)
  }
  return value
}

function encodeUint64 (value) {
  normalizeSafeInteger(value, 'canonical integer')
  const encoded = b4a.alloc(8)
  const high = Math.floor(value / 0x100000000)
  const low = value - high * 0x100000000
  encoded[0] = high >>> 24
  encoded[1] = high >>> 16
  encoded[2] = high >>> 8
  encoded[3] = high
  encoded[4] = low >>> 24
  encoded[5] = low >>> 16
  encoded[6] = low >>> 8
  encoded[7] = low
  return encoded
}

function frame (value) {
  if (value.byteLength > 0xffffffff) throw new RangeError('canonical field is too large')
  const length = b4a.alloc(4)
  length[0] = value.byteLength >>> 24
  length[1] = value.byteLength >>> 16
  length[2] = value.byteLength >>> 8
  length[3] = value.byteLength
  return [length, value]
}

function bytesEqual (left, right) {
  return isByteArray(left) && isByteArray(right) && b4a.equals(left, right)
}

function cloneJsonValue (value, name) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain finite JSON values`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => cloneJsonValue(entry, `${name}[${index}]`))
  assertRecord(value, name)
  const cloned = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`${name}.${key} cannot be undefined`)
    cloned[key] = cloneJsonValue(value[key], `${name}.${key}`)
  }
  return cloned
}

function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function normalizeManifest (value) {
  assertExactFields(value, MANIFEST_FIELDS, 'manifest')
  if (value.version !== DURABLE_MANIFEST_VERSION) {
    throw new TypeError(`unsupported manifest version ${String(value.version)}`)
  }
  if (!Array.isArray(value.refs)) throw new TypeError('manifest.refs must be an array')
  for (let index = 0; index < value.refs.length; index++) {
    assertExactFields(value.refs[index], REF_FIELDS, `manifest.refs[${index}]`)
  }
  const suppliedRequestId = normalizeHex32(value.requestId, 'manifest.requestId')
  const normalized = createDurableManifest({
    channelKey: value.channelKey,
    rowId: value.rowId,
    refs: value.refs,
    assets: value.assets,
  })
  if (normalized.requestId !== suppliedRequestId) {
    throw new Error('manifest.requestId does not match canonical manifest bytes')
  }
  return normalized
}

function normalizeSignedDescriptor (value) {
  assertExactFields(value, SIGNED_DESCRIPTOR_FIELDS, 'signedDescriptor')
  if (value.schema !== SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA) {
    throw new TypeError('unsupported signedDescriptor schema')
  }
  assertExactFields(value.descriptor, DESCRIPTOR_FIELDS, 'signedDescriptor.descriptor')
  if (value.descriptor.schema !== CHANNEL_ROOT_DESCRIPTOR_SCHEMA) {
    throw new TypeError('unsupported channel descriptor schema')
  }
  const descriptor = createChannelRootDescriptor({
    ...value.descriptor,
    profile: cloneJsonValue(value.descriptor.profile, 'signedDescriptor.descriptor.profile'),
    capabilities: cloneJsonValue(value.descriptor.capabilities, 'signedDescriptor.descriptor.capabilities'),
  })
  if (!b4a.equals(encodeCanonicalJson(value.descriptor), encodeCanonicalJson(descriptor))) {
    throw new TypeError('signedDescriptor.descriptor is not canonical')
  }
  return {
    schema: SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
    descriptor,
    proof: canonicalIdentityProofHex(value.proof, 'signedDescriptor.proof'),
    attestation: canonicalIdentityProofHex(value.attestation, 'signedDescriptor.attestation'),
  }
}

function assertDescriptorBindings (verification, descriptor, manifest, devicePublicKey) {
  if (!verification?.valid) {
    throw new Error(verification?.error || 'signed channel descriptor verification failed')
  }
  if (descriptor.channelId !== manifest.channelKey) {
    throw new Error('channel descriptor does not match manifest channelKey')
  }
  if (verification.identityPublicKey !== descriptor.identityPublicKey) {
    throw new Error('channel descriptor identity verification mismatch')
  }
  const deviceHex = b4a.toString(devicePublicKey, 'hex')
  if (verification.devicePublicKey !== deviceHex) {
    throw new Error('channel descriptor device does not match live requester device')
  }
}

function verifyStandaloneProof (proofHex, identityHex, devicePublicKey) {
  const verified = IdentityKey.verify(b4a.from(proofHex, 'hex'), null, {
    expectedIdentity: b4a.from(identityHex, 'hex'),
    expectedDevice: devicePublicKey,
  })
  if (!verified) throw new Error('channel descriptor device proof verification failed')
  if (!bytesEqual(verified.identityPublicKey, b4a.from(identityHex, 'hex'))) {
    throw new Error('channel descriptor proof identity mismatch')
  }
  if (!bytesEqual(verified.devicePublicKey, devicePublicKey)) {
    throw new Error('channel descriptor proof device mismatch')
  }
  return verified
}

function assertMatchingReceipt (verified, expectedReceiptHex, name) {
  if (!verified.receipt || b4a.toString(verified.receipt, 'hex') !== expectedReceiptHex) {
    throw new Error(`${name} proof epoch does not match channel descriptor`)
  }
}

/** Encode canonical { requestId, manifest, expiresAt } bytes for attestation. */
export function encodeSeedPinRequestPayload (value) {
  assertRecord(value, 'request payload')
  const manifest = normalizeManifest(value.manifest)
  const requestId = normalizeHex32(value.requestId, 'requestId')
  if (requestId !== manifest.requestId) throw new Error('requestId does not match manifest')
  const expiresAt = normalizeSafeInteger(value.expiresAt, 'expiresAt')
  return b4a.concat([
    AUTH_DOMAIN,
    ...frame(b4a.from(requestId, 'hex')),
    ...frame(encodeDurableManifest(manifest)),
    ...frame(encodeUint64(expiresAt)),
  ])
}

export async function createSeedPinRequest ({
  manifest,
  expiresAt,
  deviceKeyPair,
  deviceProof,
  signedDescriptor,
}) {
  const normalizedManifest = normalizeManifest(manifest)
  const normalizedExpiresAt = normalizeSafeInteger(expiresAt, 'expiresAt')
  if (normalizedExpiresAt === 0) throw new RangeError('expiresAt must be greater than zero')
  const publicKey = normalizeBytes32(deviceKeyPair?.publicKey, 'deviceKeyPair.publicKey')
  if (!isByteArray(deviceKeyPair?.secretKey) || deviceKeyPair.secretKey.byteLength !== 64) {
    throw new TypeError('deviceKeyPair.secretKey must be exactly 64 bytes')
  }
  const proof = normalizeProofInput(deviceProof)
  const normalizedDescriptor = normalizeSignedDescriptor(signedDescriptor)
  if (!b4a.equals(proof, b4a.from(normalizedDescriptor.proof, 'hex'))) {
    throw new Error('deviceProof must match signedDescriptor.proof')
  }

  const descriptorVerification = await verifySignedChannelRootDescriptor(normalizedDescriptor)
  assertDescriptorBindings(
    descriptorVerification,
    normalizedDescriptor.descriptor,
    normalizedManifest,
    publicKey,
  )
  const proofVerification = verifyStandaloneProof(
    normalizedDescriptor.proof,
    normalizedDescriptor.descriptor.identityPublicKey,
    publicKey,
  )
  assertMatchingReceipt(proofVerification, descriptorVerification.receipt, 'device')

  const payload = encodeSeedPinRequestPayload({
    requestId: normalizedManifest.requestId,
    manifest: normalizedManifest,
    expiresAt: normalizedExpiresAt,
  })
  const attestation = IdentityKey.attestData(payload, {
    publicKey,
    secretKey: deviceKeyPair.secretKey,
  }, proof)
  const selfVerification = IdentityKey.verify(attestation, payload, {
    expectedIdentity: b4a.from(normalizedDescriptor.descriptor.identityPublicKey, 'hex'),
    expectedDevice: publicKey,
  })
  if (!selfVerification) throw new Error('device key pair produced an invalid request attestation')
  assertMatchingReceipt(selfVerification, descriptorVerification.receipt, 'request')

  return deepFreeze({
    version: SEED_PIN_REQUEST_VERSION,
    manifest: normalizedManifest,
    requestId: normalizedManifest.requestId,
    expiresAt: normalizedExpiresAt,
    signedDescriptor: normalizedDescriptor,
    attestation: b4a.toString(attestation, 'hex'),
  })
}

export async function verifySeedPinRequest (request, options) {
  try {
    assertExactFields(options, VERIFY_OPTION_FIELDS, 'verification options')
    const remotePublicKey = normalizeBytes32(options.remotePublicKey, 'remotePublicKey')
    const now = normalizeSafeInteger(options.now, 'now')
    assertExactFields(request, REQUEST_FIELDS, 'seed pin request')
    if (request.version !== SEED_PIN_REQUEST_VERSION) {
      throw new TypeError(`unsupported seed pin request version ${String(request.version)}`)
    }

    const manifest = normalizeManifest(request.manifest)
    const requestId = normalizeHex32(request.requestId, 'requestId')
    if (requestId !== manifest.requestId) throw new Error('requestId does not match canonical manifest')
    const expiresAt = normalizeSafeInteger(request.expiresAt, 'expiresAt')
    if (expiresAt <= now) throw new Error('seed pin request has expired')

    const signedDescriptor = normalizeSignedDescriptor(request.signedDescriptor)
    const descriptorVerification = await verifySignedChannelRootDescriptor(signedDescriptor)
    assertDescriptorBindings(
      descriptorVerification,
      signedDescriptor.descriptor,
      manifest,
      remotePublicKey,
    )
    const proofVerification = verifyStandaloneProof(
      signedDescriptor.proof,
      signedDescriptor.descriptor.identityPublicKey,
      remotePublicKey,
    )
    assertMatchingReceipt(proofVerification, descriptorVerification.receipt, 'device')

    const attestation = b4a.from(canonicalIdentityProofHex(request.attestation, 'attestation'), 'hex')
    const payload = encodeSeedPinRequestPayload({ requestId, manifest, expiresAt })
    const requestVerification = IdentityKey.verify(attestation, payload, {
      expectedIdentity: b4a.from(signedDescriptor.descriptor.identityPublicKey, 'hex'),
      expectedDevice: remotePublicKey,
    })
    if (!requestVerification) throw new Error('request attestation verification failed')
    if (!bytesEqual(requestVerification.identityPublicKey, b4a.from(descriptorVerification.identityPublicKey, 'hex'))) {
      throw new Error('request identity does not match channel descriptor identity')
    }
    if (!bytesEqual(requestVerification.devicePublicKey, remotePublicKey)) {
      throw new Error('requester device does not match live remote Noise key')
    }
    assertMatchingReceipt(requestVerification, descriptorVerification.receipt, 'request')

    return deepFreeze({
      valid: true,
      version: SEED_PIN_REQUEST_VERSION,
      requestId,
      expiresAt,
      channelKey: manifest.channelKey,
      identityPublicKey: descriptorVerification.identityPublicKey,
      requesterDevicePublicKey: b4a.toString(remotePublicKey, 'hex'),
      manifest,
      descriptor: signedDescriptor.descriptor,
    })
  } catch (error) {
    return Object.freeze({
      valid: false,
      error: error?.message || String(error),
    })
  }
}
