import b4a from 'b4a'
import IdentityKey from 'keet-identity-key'

export const CHANNEL_ROOT_DESCRIPTOR_SCHEMA = 'peartube.channel.root.v1'
export const SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA = 'peartube.channel.root.signed.v1'

const HEX_32_RE = /^[0-9a-f]{64}$/i

function canonicalHex (value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw new Error(`${name} must be a 32-byte key`)
    return b4a.toString(value, 'hex')
  }
  if (typeof value !== 'string' || !HEX_32_RE.test(value)) {
    throw new Error(`${name} must be a 32-byte hex key`)
  }
  return value.toLowerCase()
}

function assertNonNegativeInteger (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

function sortPlain (value) {
  if (Array.isArray(value)) return value.map(sortPlain)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const v = value[key]
    if (v !== undefined) out[key] = sortPlain(v)
  }
  return out
}

export function encodeCanonicalJson (value) {
  return Buffer.from(JSON.stringify(sortPlain(value)))
}

export function createChannelRootDescriptor ({
  identityPublicKey,
  channelId,
  metadataKey,
  mediaKey,
  seq = 0,
  createdAt = Date.now(),
  updatedAt = createdAt,
  profile = null,
  capabilities = null
}) {
  const identityHex = canonicalHex(identityPublicKey, 'identityPublicKey')
  const metadataHex = canonicalHex(metadataKey, 'metadataKey')
  const mediaHex = canonicalHex(mediaKey, 'mediaKey')
  const normalizedChannelId = channelId ? canonicalHex(channelId, 'channelId') : identityHex

  return {
    schema: CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
    channelId: normalizedChannelId,
    identityPublicKey: identityHex,
    metadataKey: metadataHex,
    mediaKey: mediaHex,
    seq: assertNonNegativeInteger(seq, 'seq'),
    createdAt: assertNonNegativeInteger(createdAt, 'createdAt'),
    updatedAt: assertNonNegativeInteger(updatedAt, 'updatedAt'),
    profile: profile && typeof profile === 'object' ? sortPlain(profile) : null,
    capabilities: capabilities && typeof capabilities === 'object'
      ? sortPlain(capabilities)
      : {
          metadata: 'hyperbee',
          media: 'hyperdrive',
          thumbnails: 'inline-or-media-path'
        }
  }
}

export async function signChannelRootDescriptor ({ descriptor, deviceKeyPair, deviceProof }) {
  if (!descriptor || descriptor.schema !== CHANNEL_ROOT_DESCRIPTOR_SCHEMA) {
    throw new Error('descriptor must be a channel root descriptor')
  }
  if (!deviceKeyPair?.publicKey || !deviceKeyPair?.secretKey) {
    throw new Error('deviceKeyPair with publicKey and secretKey is required')
  }
  const proofBuffer = normalizeProof(deviceProof)
  const attestation = IdentityKey.attestData(encodeCanonicalJson(descriptor), deviceKeyPair, proofBuffer)
  return {
    schema: SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA,
    descriptor,
    proof: b4a.toString(proofBuffer, 'hex'),
    attestation: b4a.toString(attestation, 'hex')
  }
}

export async function verifySignedChannelRootDescriptor (signed) {
  try {
    if (!signed || signed.schema !== SIGNED_CHANNEL_ROOT_DESCRIPTOR_SCHEMA) {
      return { valid: false, error: 'invalid signed descriptor schema' }
    }
    const descriptor = createChannelRootDescriptor(signed.descriptor || {})
    const attestation = b4a.from(signed.attestation, 'hex')
    const verified = IdentityKey.verify(attestation, encodeCanonicalJson(descriptor), {
      expectedIndentity: b4a.from(descriptor.identityPublicKey, 'hex')
    })
    if (!verified) return { valid: false, error: 'attestation verification failed' }

    return {
      valid: true,
      descriptor,
      identityPublicKey: b4a.toString(verified.identityPublicKey, 'hex'),
      devicePublicKey: b4a.toString(verified.devicePublicKey, 'hex'),
      receipt: verified.receipt ? b4a.toString(verified.receipt, 'hex') : null
    }
  } catch (err) {
    return { valid: false, error: err?.message || String(err) }
  }
}

function normalizeProof (proof) {
  if (!proof) throw new Error('deviceProof is required')
  if (b4a.isBuffer(proof) || proof instanceof Uint8Array) return b4a.from(proof)
  if (typeof proof === 'string') return b4a.from(proof, 'hex')
  throw new Error('deviceProof must be a buffer or hex string')
}
