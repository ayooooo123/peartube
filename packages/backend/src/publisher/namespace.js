import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  assertBytes,
  assertInput,
  assertUint,
  equalBytes,
  readField,
  readVarint,
  utf8,
  varintLength,
  writeField,
  writeVarint
} from '../records/canonical.js'
import {
  MAX_PROTOCOL_CAPABILITIES,
  MAX_PROTOCOL_CAPABILITIES_BYTES,
  MAX_PROTOCOL_CAPABILITY_BYTES,
  assertProtocolCompatibility,
  createProtocolAdvertisement
} from '../network/version.js'
import { PUBLISHER_LIMITS, publisherCanonicalInternals } from './canonical.js'

const PUBLISHER_ID_DOMAIN = b4a.from('peartube/publisher-id/v1')
const NAMESPACE_VERSION = 1
export const PUBLISHER_CATALOG_CAPABILITY = 'publisher-catalog:v1'
export const PUBLISHER_CATALOG_LEGACY_COMPATIBILITY = Object.freeze({
  minimumProtocolMajor: 1,
  protocolMinor: 0,
  requiredCapabilities: Object.freeze([PUBLISHER_CATALOG_CAPABILITY]),
})

const {
  assertOptionalExactFields,
  assertOrderedDistinctKeys,
  assertRecoveryPolicy,
  boundedBytes,
  invalid,
  readFixed
} = publisherCanonicalInternals

function hashWith (hash, input, name) {
  if (typeof hash !== 'function') invalid(`${name} hash provider is required`)
  const result = hash(input)
  assertBytes(result, 32, `${name} hash output`)
  return result
}

export function derivePublisherId (genesisRootKey, { hash = crypto.hash } = {}) {
  assertBytes(genesisRootKey, 32, 'genesisRootKey')
  return hashWith(hash, b4a.concat([PUBLISHER_ID_DOMAIN, genesisRootKey]), 'publisherId')
}

function validateDescriptor (descriptor, { genesisRootKey, hash = crypto.hash } = {}) {
  assertOptionalExactFields(
    descriptor,
    [
      'publisherId', 'publisherRootKey', 'catalogBootstrapKey', 'catalogEpoch', 'profileRef',
      'policySequence', 'recoveryKeys', 'recoveryThreshold', 'minimumProtocolMajor',
      'protocolMinor', 'requiredCapabilities'
    ],
    ['previousRootKey', 'rootTransitionProof'],
    'namespace descriptor'
  )
  assertBytes(descriptor.publisherId, 32, 'publisherId')
  assertBytes(descriptor.publisherRootKey, 32, 'publisherRootKey')
  assertBytes(descriptor.catalogBootstrapKey, 32, 'catalogBootstrapKey')
  assertUint(descriptor.catalogEpoch, 'catalogEpoch')
  boundedBytes(descriptor.profileRef, 'profileRef', PUBLISHER_LIMITS.maxProfileRefBytes)
  assertUint(descriptor.policySequence, 'policySequence')
  assertRecoveryPolicy(descriptor.recoveryKeys, descriptor.recoveryThreshold)
  const compatibility = createProtocolAdvertisement(descriptor)
  if (compatibility.requiredCapabilities.length !== descriptor.requiredCapabilities.length) {
    invalid('requiredCapabilities must be distinct and lexicographically ordered')
  }
  for (let index = 0; index < compatibility.requiredCapabilities.length; index++) {
    if (compatibility.requiredCapabilities[index] !== descriptor.requiredCapabilities[index]) {
      invalid('requiredCapabilities must be distinct and lexicographically ordered')
    }
  }
  if (!compatibility.requiredCapabilities.includes(PUBLISHER_CATALOG_CAPABILITY)) {
    invalid(`requiredCapabilities must include ${PUBLISHER_CATALOG_CAPABILITY}`)
  }

  const hasPrevious = descriptor.previousRootKey !== undefined
  const hasProof = descriptor.rootTransitionProof !== undefined
  if (hasPrevious !== hasProof) invalid('root transition requires both previousRootKey and rootTransitionProof')
  if (hasPrevious) {
    assertBytes(descriptor.previousRootKey, 32, 'previousRootKey')
    assertBytes(descriptor.rootTransitionProof, 32, 'rootTransitionProof')
  }
  if (descriptor.catalogEpoch === 0 && hasPrevious) invalid('genesis descriptor cannot contain root transition fields')
  if (descriptor.catalogEpoch > 0 && !hasPrevious) invalid('rotated descriptor requires root transition fields')

  const knownGenesis = genesisRootKey || (descriptor.catalogEpoch === 0 ? descriptor.publisherRootKey : null)
  if (knownGenesis) {
    assertBytes(knownGenesis, 32, 'genesisRootKey')
    if (!equalBytes(derivePublisherId(knownGenesis, { hash }), descriptor.publisherId)) invalid('publisherId does not match genesis root')
  }
  if (descriptor.catalogEpoch === 0 && !equalBytes(descriptor.publisherRootKey, knownGenesis)) invalid('genesis publisher root must equal genesisRootKey')
  return descriptor
}

export function createPublisherNamespaceDescriptor (value, { hash = crypto.hash } = {}) {
  if (!value || typeof value !== 'object') invalid('namespace descriptor input must be an object')
  const allowed = [
    'genesisRootKey', 'publisherId', 'publisherRootKey', 'catalogBootstrapKey', 'catalogEpoch',
    'profileRef', 'policySequence', 'recoveryKeys', 'recoveryThreshold', 'previousRootKey',
    'rootTransitionProof', 'minimumProtocolMajor', 'protocolMinor', 'requiredCapabilities'
  ]
  for (const field of Object.keys(value)) if (!allowed.includes(field)) invalid(`namespace descriptor input has unknown field ${field}`)
  assertBytes(value.genesisRootKey, 32, 'genesisRootKey')
  assertBytes(value.catalogBootstrapKey, 32, 'catalogBootstrapKey')
  const catalogEpoch = value.catalogEpoch ?? 0
  const publisherId = value.publisherId || derivePublisherId(value.genesisRootKey, { hash })
  if (!equalBytes(publisherId, derivePublisherId(value.genesisRootKey, { hash }))) invalid('publisherId does not match genesis root')
  const compatibility = createProtocolAdvertisement(value, {
    requiredCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
  })
  const descriptor = {
    publisherId,
    publisherRootKey: value.publisherRootKey || value.genesisRootKey,
    catalogBootstrapKey: value.catalogBootstrapKey,
    catalogEpoch,
    profileRef: value.profileRef || b4a.alloc(0),
    policySequence: value.policySequence ?? 0,
    recoveryKeys: value.recoveryKeys || [],
    recoveryThreshold: value.recoveryThreshold ?? 0,
    ...compatibility
  }
  if (value.previousRootKey !== undefined) descriptor.previousRootKey = value.previousRootKey
  if (value.rootTransitionProof !== undefined) descriptor.rootTransitionProof = value.rootTransitionProof
  validateDescriptor(descriptor, { genesisRootKey: value.genesisRootKey, hash })
  return descriptor
}

function uintLength (value) {
  assertUint(value, 'integer')
  return varintLength(value)
}

function encodeNamespaceDescriptor (descriptor, includeCompatibility) {
  validateDescriptor(descriptor)
  const profileLength = varintLength(descriptor.profileRef.byteLength) + descriptor.profileRef.byteLength
  const transitionLength = descriptor.previousRootKey ? 65 : 1
  const capabilities = includeCompatibility
    ? descriptor.requiredCapabilities.map(capability => utf8(capability, 'required capability', MAX_PROTOCOL_CAPABILITY_BYTES))
    : []
  const compatibilityLength = includeCompatibility
    ? uintLength(descriptor.minimumProtocolMajor) + uintLength(descriptor.protocolMinor) +
      uintLength(capabilities.length) +
      capabilities.reduce((total, capability) => total + varintLength(capability.byteLength) + capability.byteLength, 0)
    : 0
  const length = 1 + 32 + 32 + 32 + uintLength(descriptor.catalogEpoch) + profileLength +
    uintLength(descriptor.policySequence) + uintLength(descriptor.recoveryKeys.length) +
    descriptor.recoveryKeys.length * 32 + uintLength(descriptor.recoveryThreshold) +
    transitionLength + compatibilityLength
  const output = b4a.allocUnsafe(length)
  let offset = 0
  output[offset++] = NAMESPACE_VERSION
  output.set(descriptor.publisherId, offset); offset += 32
  output.set(descriptor.publisherRootKey, offset); offset += 32
  output.set(descriptor.catalogBootstrapKey, offset); offset += 32
  offset = writeVarint(output, offset, descriptor.catalogEpoch)
  offset = writeField(output, offset, descriptor.profileRef)
  offset = writeVarint(output, offset, descriptor.policySequence)
  offset = writeVarint(output, offset, descriptor.recoveryKeys.length)
  for (const key of descriptor.recoveryKeys) { output.set(key, offset); offset += 32 }
  offset = writeVarint(output, offset, descriptor.recoveryThreshold)
  output[offset++] = descriptor.previousRootKey ? 1 : 0
  if (descriptor.previousRootKey) {
    output.set(descriptor.previousRootKey, offset); offset += 32
    output.set(descriptor.rootTransitionProof, offset); offset += 32
  }
  if (includeCompatibility) {
    offset = writeVarint(output, offset, descriptor.minimumProtocolMajor)
    offset = writeVarint(output, offset, descriptor.protocolMinor)
    offset = writeVarint(output, offset, capabilities.length)
    for (const capability of capabilities) offset = writeField(output, offset, capability)
  }
  return output
}

export function encodePublisherNamespaceDescriptor (descriptor) {
  return encodeNamespaceDescriptor(descriptor, true)
}

export function decodePublisherNamespaceDescriptor (input, options = {}) {
  assertInput(input)
  const maximum = 1 + 32 * (5 + PUBLISHER_LIMITS.maxRecoveryKeys) +
    PUBLISHER_LIMITS.maxProfileRefBytes + MAX_PROTOCOL_CAPABILITIES_BYTES +
    MAX_PROTOCOL_CAPABILITIES * 2 + 128
  if (input.byteLength > maximum) invalid('namespace descriptor exceeds its byte limit')
  const state = { buffer: input, offset: 0 }
  if (readVarint(state, 'namespace version', 255) !== NAMESPACE_VERSION) invalid('unknown namespace version')
  const descriptor = {
    publisherId: readFixed(state, 'publisherId', 32),
    publisherRootKey: readFixed(state, 'publisherRootKey', 32),
    catalogBootstrapKey: readFixed(state, 'catalogBootstrapKey', 32),
    catalogEpoch: readVarint(state, 'catalogEpoch'),
    profileRef: readField(state, 'profileRef', PUBLISHER_LIMITS.maxProfileRefBytes),
    policySequence: readVarint(state, 'policySequence'),
    recoveryKeys: [],
    recoveryThreshold: 0
  }
  const recoveryCount = readVarint(state, 'recovery keys count', PUBLISHER_LIMITS.maxRecoveryKeys)
  descriptor.recoveryKeys = new Array(recoveryCount)
  for (let index = 0; index < recoveryCount; index++) descriptor.recoveryKeys[index] = readFixed(state, 'recoveryKey', 32)
  descriptor.recoveryThreshold = readVarint(state, 'recoveryThreshold', recoveryCount)
  const transition = readVarint(state, 'root transition variant', 1)
  if (transition) {
    descriptor.previousRootKey = readFixed(state, 'previousRootKey', 32)
    descriptor.rootTransitionProof = readFixed(state, 'rootTransitionProof', 32)
  }

  const legacy = state.offset === input.byteLength
  if (legacy) {
    Object.assign(descriptor, assertProtocolCompatibility({}, {
      protocolMajor: options.protocolMajor,
      supportedCapabilities: options.supportedCapabilities || [PUBLISHER_CATALOG_CAPABILITY],
      legacyCompatibility: options.legacyCompatibility,
    }))
  } else {
    descriptor.minimumProtocolMajor = readVarint(state, 'minimumProtocolMajor', 255)
    descriptor.protocolMinor = readVarint(state, 'protocolMinor', 255)
    const count = readVarint(state, 'requiredCapabilities count', MAX_PROTOCOL_CAPABILITIES)
    descriptor.requiredCapabilities = new Array(count)
    for (let index = 0; index < count; index++) {
      const encoded = readField(state, 'required capability', MAX_PROTOCOL_CAPABILITY_BYTES)
      const capability = b4a.toString(encoded)
      if (!equalBytes(utf8(capability, 'required capability', MAX_PROTOCOL_CAPABILITY_BYTES), encoded)) {
        invalid('required capability encoding is noncanonical')
      }
      descriptor.requiredCapabilities[index] = capability
    }
    if (state.offset !== input.byteLength) invalid('trailing bytes')
    assertProtocolCompatibility(descriptor, {
      protocolMajor: options.protocolMajor,
      supportedCapabilities: options.supportedCapabilities || [PUBLISHER_CATALOG_CAPABILITY],
    })
  }
  validateDescriptor(descriptor)
  const canonical = encodeNamespaceDescriptor(descriptor, !legacy)
  if (!equalBytes(canonical, input)) invalid('noncanonical namespace descriptor encoding')
  return descriptor
}

export function verifyPublisherNamespaceDescriptor (descriptor, options = {}) {
  validateDescriptor(descriptor, options)
  const encoded = encodePublisherNamespaceDescriptor(descriptor)
  decodePublisherNamespaceDescriptor(encoded, options)
  return { valid: true, descriptor }
}
