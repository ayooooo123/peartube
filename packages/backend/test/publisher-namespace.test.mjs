import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  encodeCanonical,
  derivePublisherId,
  createPublisherNamespaceDescriptor,
  encodePublisherNamespaceDescriptor,
  decodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor
} from '../src/publisher/index.js'
import { PUBLISHER_CATALOG_CAPABILITY } from '../src/publisher/namespace.js'
import { PROTOCOL_ERROR_CODES, PROTOCOL_MAJOR } from '../src/network/index.js'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const key = seed => bytes(32, seed)
const equal = (left, right) => b4a.equals(left, right)

function throws (t, fn, pattern) {
  try {
    fn()
  } catch (error) {
    t.ok(pattern.test(error?.message || ''), `expected ${pattern}, received ${error?.message || error}`)
    return
  }
  t.fail(`expected ${pattern} to be thrown`)
}

test('publisher ID is the exact genesis-root domain hash and survives root rotation', (t) => {
  const genesisRootKey = key(0)
  const publisherId = derivePublisherId(genesisRootKey)
  const expected = crypto.hash(b4a.concat([b4a.from('peartube/publisher-id/v1'), genesisRootKey]))

  t.ok(equal(publisherId, expected), 'publisher ID uses the exact v1 domain and genesis root bytes')
  t.is(b4a.toString(publisherId, 'hex'), '0ab82148fe613786e5356c8c97e66b62b9bb9cb1e4c8fd2e9609fc75575ba580', 'fixed Node/Bare publisher ID vector')

  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey,
    publisherRootKey: key(64),
    catalogBootstrapKey: key(96),
    catalogEpoch: 2,
    profileRef: b4a.from('profile:publisher-one'),
    policySequence: 7,
    recoveryKeys: [key(128), key(160)],
    recoveryThreshold: 2,
    previousRootKey: key(32),
    rootTransitionProof: key(192)
  })
  t.ok(equal(descriptor.publisherId, publisherId), 'active root rotation does not change publisher ID')
})

test('namespace descriptor is bounded, canonical, exact, and round trips', (t) => {
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: key(0),
    publisherRootKey: key(32),
    catalogBootstrapKey: key(64),
    catalogEpoch: 1,
    profileRef: b4a.from('profile:alice'),
    policySequence: 4,
    recoveryKeys: [key(96), key(128), key(160)],
    recoveryThreshold: 2,
    previousRootKey: key(0),
    rootTransitionProof: key(192)
  })
  const encoded = encodePublisherNamespaceDescriptor(descriptor)
  const decoded = decodePublisherNamespaceDescriptor(encoded)

  t.alike(decoded, descriptor)
  t.ok(equal(encoded, encodePublisherNamespaceDescriptor(decoded)), 'descriptor has one canonical encoding')
  t.is(verifyPublisherNamespaceDescriptor(decoded).valid, true)

  throws(t, () => encodePublisherNamespaceDescriptor({ ...descriptor, recoveryKeys: [key(128), key(96)] }), /ordered/)
  throws(t, () => encodePublisherNamespaceDescriptor({ ...descriptor, recoveryThreshold: 4 }), /threshold/)
  throws(t, () => verifyPublisherNamespaceDescriptor({ ...descriptor, publisherId: key(1) }, { genesisRootKey: key(0) }), /publisherId/)
  throws(t, () => encodePublisherNamespaceDescriptor({ ...descriptor, previousRootKey: undefined }), /transition/)
  throws(t, () => decodePublisherNamespaceDescriptor(b4a.concat([encoded, b4a.from([0])])), /trailing/)
})

test('publisher namespace advertises canonical compatibility before catalog projection', (t) => {
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: key(5),
    catalogBootstrapKey: key(37),
    protocolMinor: 8,
    requiredCapabilities: ['z-catalog:v1', 'a-catalog:v1', 'z-catalog:v1'],
  })
  t.is(descriptor.minimumProtocolMajor, PROTOCOL_MAJOR)
  t.is(descriptor.protocolMinor, 8)
  t.alike(descriptor.requiredCapabilities, [
    'a-catalog:v1',
    PUBLISHER_CATALOG_CAPABILITY,
    'z-catalog:v1',
  ])
  const encoded = encodePublisherNamespaceDescriptor(descriptor)
  t.alike(decodePublisherNamespaceDescriptor(encoded, {
    supportedCapabilities: [
      PUBLISHER_CATALOG_CAPABILITY,
      'a-catalog:v1',
      'z-catalog:v1',
    ],
  }), descriptor, 'compatible minor changes decode when every required capability is supported')
  try {
    decodePublisherNamespaceDescriptor(encoded)
    t.fail('unknown catalog requirement must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.CAPABILITY_UNSUPPORTED)
  }
  const incompatible = createPublisherNamespaceDescriptor({
    genesisRootKey: key(6),
    catalogBootstrapKey: key(38),
    minimumProtocolMajor: PROTOCOL_MAJOR + 1,
  })
  try {
    decodePublisherNamespaceDescriptor(encodePublisherNamespaceDescriptor(incompatible))
    t.fail('catalog from another protocol major must be rejected')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.MAJOR_UNSUPPORTED)
  }
})
test('legacy namespace omissions require an explicit compatible protocol declaration', (t) => {
  const legacy = b4a.from(
    '011d6e7d3abf5d809cd3e0f0840c6eaec27a842afac22bac7dd4c5b64473efcc9e' +
    '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' +
    '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40' +
    '000000024142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60' +
    '6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f800100',
    'hex'
  )
  try {
    decodePublisherNamespaceDescriptor(legacy)
    t.fail('legacy descriptor omission must fail closed by default')
  } catch (error) {
    t.is(error.code, PROTOCOL_ERROR_CODES.ADVERTISEMENT_REQUIRED)
  }
  const decoded = decodePublisherNamespaceDescriptor(legacy, {
    protocolMajor: 1,
    legacyCompatibility: {
      minimumProtocolMajor: 1,
      protocolMinor: 0,
      requiredCapabilities: [PUBLISHER_CATALOG_CAPABILITY],
    },
  })
  t.is(decoded.minimumProtocolMajor, 1)
  t.alike(decoded.requiredCapabilities, [PUBLISHER_CATALOG_CAPABILITY])
})

test('genesis descriptors prohibit transition fields and require deterministic recovery policy', (t) => {
  const base = {
    genesisRootKey: key(1),
    catalogBootstrapKey: key(33),
    profileRef: b4a.alloc(0),
    recoveryKeys: [key(65), key(97)],
    recoveryThreshold: 1
  }
  const descriptor = createPublisherNamespaceDescriptor(base)
  t.is(descriptor.catalogEpoch, 0)
  t.is(descriptor.policySequence, 0)
  t.ok(equal(descriptor.publisherRootKey, base.genesisRootKey))

  throws(t, () => createPublisherNamespaceDescriptor({ ...base, recoveryKeys: [], recoveryThreshold: 1 }), /threshold/)
  throws(t, () => createPublisherNamespaceDescriptor({ ...base, recoveryKeys: [key(65), key(65)], recoveryThreshold: 1 }), /distinct/)
  throws(t, () => createPublisherNamespaceDescriptor({ ...base, catalogEpoch: 0, previousRootKey: key(2), rootTransitionProof: key(3) }), /genesis/)
})

test('generic canonical encoding rejects sparse arrays at every recursion level', (t) => {
  const oversizedSparse = []
  oversizedSparse.length = 100_001
  throws(t, () => encodeCanonical({ oversizedSparse }), /node|array|limit/)

  const nestedSparse = []
  nestedSparse.length = 2
  nestedSparse[1] = 'present'
  throws(t, () => encodeCanonical({ outer: [nestedSparse] }), /sparse/)

  const balancedSparse = []
  balancedSparse.length = 2
  balancedSparse[1] = 'present'
  balancedSparse.extra = 'balances the missing index'
  throws(t, () => encodeCanonical({ outer: [balancedSparse] }), /sparse|named/)
})
