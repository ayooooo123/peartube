import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  PUBLISHER_RECORD_TYPES,
  createPublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceProof,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'

const bytes = (length, seed) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))

function genesis(descriptor, root) {
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: root.publicKey,
    policyEpoch: 0,
    issuerSequence: 0,
    signedAt: 100,
    canonicalBody: encodePublisherNamespaceDescriptor(descriptor),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey))
}

test('namespace proof verifies a canonical signed genesis against the untrusted locator tuple', (t) => {
  const root = crypto.keyPair(bytes(32, 1))
  const descriptor = createPublisherNamespaceDescriptor({ genesisRootKey: root.publicKey, catalogBootstrapKey: bytes(32, 40) })
  const proof = verifyPublisherNamespaceProof({
    genesis: genesis(descriptor, root),
    transitions: [],
    descriptor,
    locator: {
      publisherId: b4a.toString(descriptor.publisherId, 'hex'),
      catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
      catalogEpoch: 0,
    },
  })

  t.is(proof.valid, true)
  t.alike(proof.descriptor.catalogBootstrapKey, descriptor.catalogBootstrapKey)
})

test('namespace proof rejects a locator or descriptor substitution before catalog binding', (t) => {
  const root = crypto.keyPair(bytes(32, 2))
  const descriptor = createPublisherNamespaceDescriptor({ genesisRootKey: root.publicKey, catalogBootstrapKey: bytes(32, 41) })
  const record = genesis(descriptor, root)
  t.exception(() => verifyPublisherNamespaceProof({
    genesis: record,
    transitions: [],
    descriptor,
    locator: {
      publisherId: b4a.toString(descriptor.publisherId, 'hex'),
      catalogBootstrapKey: 'f'.repeat(64),
      catalogEpoch: 0,
    },
  }), /bootstrap/i)
})
