import b4a from 'b4a'

import { PUBLISHER_RECORD_TYPES } from './canonical.js'
import { createPublisherAuthorizationState, reducePublisherOperation } from './authorization.js'
import { createPublisherKeyProvider } from './key-provider.js'
import {
  decodePublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from './namespace.js'

function hex32(value, name) {
  const text = String(value || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${name} must be 32-byte hex`)
  return text
}

function equal(left, right) {
  return b4a.equals(b4a.from(left), b4a.from(right))
}

/**
 * Verifies the proof received on an untrusted candidate publisher topic. The
 * locator is only a tuple to match after cryptographic proof succeeds; it never
 * authorizes a catalog or acts as a publisher trust root.
 */
export function verifyPublisherNamespaceProof(input = {}) {
  const locator = input.locator || {}
  const genesis = input.genesis
  const transitions = Array.isArray(input.transitions) ? input.transitions : null
  if (!genesis || !transitions) throw new Error('namespace proof is incomplete')
  const keyProvider = input.keyProvider || createPublisherKeyProvider()
  if (genesis.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE || genesis.transitionId) {
    throw new Error('namespace proof genesis is not a single-signed namespace record')
  }
  if (genesis.schemaMajor !== 1 || genesis.schemaMinor !== 0 || genesis.policyEpoch !== 0 || genesis.issuerSequence !== 0) {
    throw new Error('namespace proof genesis has an invalid fixed schema or sequence')
  }
  const genesisDescriptor = decodePublisherNamespaceDescriptor(genesis.canonicalBody)
  if (genesisDescriptor.catalogEpoch !== 0 || genesisDescriptor.policySequence !== 0 ||
      !equal(genesis.issuerIdentityKey, genesisDescriptor.publisherId) ||
      !equal(genesis.signerKey, genesisDescriptor.publisherRootKey)) {
    throw new Error('namespace proof genesis does not bind its descriptor authority')
  }
  keyProvider.verifySignedEnvelope(genesis, {
    issuerIdentityKey: genesisDescriptor.publisherId,
    policyEpoch: 0,
    authorizeSigner: candidate => equal(candidate.signerKey, genesisDescriptor.publisherRootKey),
    authorizeSequence: candidate => candidate.issuerSequence === 0,
    claimReplay: () => true,
    now: genesis.signedAt,
    maxClockSkew: 0,
  })

  const state = createPublisherAuthorizationState(genesisDescriptor)
  for (const transition of transitions) {
    if (transition?.recordType !== PUBLISHER_RECORD_TYPES.ROOT_TRANSITION || !transition?.transitionId) {
      throw new Error('namespace proof contains a non-transition operation')
    }
    const result = reducePublisherOperation(state, transition, { keyProvider })
    if (!result.accepted && result.code !== 'DUPLICATE') {
      throw new Error(`namespace proof transition rejected: ${result.code}`)
    }
  }

  const descriptor = input.descriptor
    ? verifyPublisherNamespaceDescriptor(input.descriptor, { genesisRootKey: genesisDescriptor.publisherRootKey }).descriptor
    : state.descriptor
  if (!equal(encodePublisherNamespaceDescriptor(descriptor), encodePublisherNamespaceDescriptor(state.descriptor))) {
    throw new Error('namespace proof current descriptor does not match authenticated transitions')
  }
  if (hex32(locator.publisherId, 'locator publisherId') !== b4a.toString(descriptor.publisherId, 'hex') ||
      hex32(locator.catalogBootstrapKey, 'locator catalogBootstrapKey') !== b4a.toString(descriptor.catalogBootstrapKey, 'hex') ||
      Number(locator.catalogEpoch) !== descriptor.catalogEpoch) {
    throw new Error('namespace proof does not match locator publisher/bootstrap/epoch tuple')
  }
  // The verified operations are returned with the descriptor so a mirroring
  // relay can re-serve the same proof to downstream peers without the origin
  // publisher being reachable.
  return { valid: true, descriptor, state, genesis, transitions }
}
