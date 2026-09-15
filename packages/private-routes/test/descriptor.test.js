import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import { expectCode, privateRoleIdentity, seed } from './helpers.js'

const {
  AUTHORIZATION_MODE,
  CAPABILITY,
  DOMAIN,
  PROTOCOL_VERSION,
  ROLE,
  decodeDelegation,
  decodeDescriptor,
  decodeRelayAdvertisement,
  encodeDelegation,
  encodeDescriptor,
  encodeRelayAdvertisement
} = routes

function advertisement(overrides = {}) {
  return {
    version: PROTOCOL_VERSION,
    identityKey: seed(1),
    routeEncryptionKey: seed(2),
    dial: b4a.from('127.0.0.1:49737'),
    role: ROLE.PRIVATE,
    capabilities: CAPABILITY.KNOWN,
    epoch: 7n,
    expiresAt: 100n,
    relaySignature: b4a.alloc(64, 3),
    ...overrides
  }
}

function delegation(overrides = {}) {
  return {
    version: PROTOCOL_VERSION,
    endpointKey: seed(4),
    routeSigningKey: seed(5),
    notBefore: 1n,
    expiresAt: 100n,
    minEpoch: 2n,
    maxEpoch: 20n,
    capabilities: CAPABILITY.KNOWN,
    endpointSignature: b4a.alloc(64, 6),
    ...overrides
  }
}

function descriptor(overrides = {}) {
  const entryAdvertisement = encodeRelayAdvertisement(advertisement())
  return {
    version: PROTOCOL_VERSION,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    descriptorId: seed(7),
    endpointKey: seed(8),
    routeSigningKey: seed(8),
    routeEncryptionKey: seed(9),
    entryAdvertisement,
    epoch: 7n,
    expiresAt: 90n,
    capabilities: CAPABILITY.FORWARD,
    cellSize: 1200,
    encryptedHops: b4a.from('opaque-hop-chain'),
    signature: b4a.alloc(64, 10),
    ...overrides
  }
}

test('descriptor codecs round trip exact v0 schemas without aliases', (t) => {
  const values = [
    [advertisement(), encodeRelayAdvertisement, decodeRelayAdvertisement],
    [delegation(), encodeDelegation, decodeDelegation],
    [descriptor(), encodeDescriptor, decodeDescriptor]
  ]

  for (const [value, encode, decode] of values) {
    const encoded = encode(value)
    const decoded = decode(encoded)
    t.alike(decoded, value)
    encoded.fill(0)
    for (const field of Object.keys(decoded)) {
      if (b4a.isBuffer(decoded[field])) t.alike(decoded[field], value[field])
    }
  }
})

test('unsigned descriptor codecs round trip without signature fields', (t) => {
  const unsignedAdvertisement = { ...advertisement() }
  delete unsignedAdvertisement.relaySignature
  const unsignedDelegation = { ...delegation() }
  delete unsignedDelegation.endpointSignature
  const unsignedDescriptor = { ...descriptor() }
  delete unsignedDescriptor.signature

  t.alike(
    routes.decodeUnsignedRelayAdvertisement(
      routes.encodeUnsignedRelayAdvertisement(unsignedAdvertisement)
    ),
    unsignedAdvertisement
  )
  t.alike(
    routes.decodeUnsignedDelegation(routes.encodeUnsignedDelegation(unsignedDelegation)),
    unsignedDelegation
  )
  t.alike(
    routes.decodeUnsignedDescriptor(routes.encodeUnsignedDescriptor(unsignedDescriptor)),
    unsignedDescriptor
  )
})

test('codec field order is canonical and uint64 values stay bigint', (t) => {
  const encoded = encodeRelayAdvertisement(advertisement({ epoch: 0x0102_0304_0506_0708n }))

  t.is(encoded.readUInt32BE(0), 0)
  t.alike(encoded.subarray(4, 36), seed(1))
  t.alike(encoded.subarray(36, 68), seed(2))
  t.is(encoded.readUInt16BE(68), 15)
  t.is(encoded[85], ROLE.PRIVATE)
  t.is(encoded.readUInt32BE(86), CAPABILITY.KNOWN)
  t.is(b4a.toString(encoded.subarray(90, 98), 'hex'), '0102030405060708')
  t.is(typeof decodeRelayAdvertisement(encoded).epoch, 'bigint')
})

test('codecs enforce exact lengths, total limits, and no trailing bytes', (t) => {
  expectCode(
    t,
    () => encodeRelayAdvertisement(advertisement({ dial: b4a.alloc(257) })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => encodeDescriptor(descriptor({ entryAdvertisement: b4a.alloc(1025) })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => encodeDescriptor(descriptor({ encryptedHops: b4a.alloc(4097) })),
    'INVALID_DESCRIPTOR'
  )

  for (const [value, encode, decode] of [
    [advertisement(), encodeRelayAdvertisement, decodeRelayAdvertisement],
    [delegation(), encodeDelegation, decodeDelegation],
    [descriptor(), encodeDescriptor, decodeDescriptor]
  ]) {
    const encoded = encode(value)
    expectCode(t, () => decode(b4a.concat([encoded, b4a.from([0])])), 'INVALID_DESCRIPTOR')
    expectCode(t, () => decode(encoded.subarray(0, encoded.byteLength - 1)), 'INVALID_DESCRIPTOR')
  }

  expectCode(t, () => decodeDescriptor(b4a.alloc(8193)), 'INVALID_DESCRIPTOR')
})

test('codecs reject unsafe numeric uint64s and noncanonical v0 values', (t) => {
  for (const value of [-1n, 0x1_0000_0000_0000_0000n, 7, Number.MAX_SAFE_INTEGER]) {
    expectCode(
      t,
      () => encodeRelayAdvertisement(advertisement({ epoch: value })),
      'INVALID_DESCRIPTOR'
    )
  }

  expectCode(t, () => encodeRelayAdvertisement(advertisement({ version: 1 })), 'INVALID_DESCRIPTOR')
  expectCode(
    t,
    () => encodeRelayAdvertisement(advertisement({ capabilities: 8 })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => encodeRelayAdvertisement(advertisement({ dial: b4a.alloc(0) })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(t, () => encodeDescriptor(descriptor({ cellSize: 1199 })), 'INVALID_DESCRIPTOR')
  expectCode(
    t,
    () => encodeDescriptor(descriptor({ encryptedHops: b4a.alloc(0) })),
    'INVALID_DESCRIPTOR'
  )
})

test('descriptor authorization mode canonically controls delegation presence', (t) => {
  expectCode(
    t,
    () => encodeDescriptor(descriptor({ delegation: delegation() })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => encodeDescriptor(descriptor({ authorizationMode: AUTHORIZATION_MODE.DELEGATED })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(t, () => encodeDescriptor(descriptor({ authorizationMode: 2 })), 'INVALID_DESCRIPTOR')

  const delegated = descriptor({
    authorizationMode: AUTHORIZATION_MODE.DELEGATED,
    routeSigningKey: seed(5),
    delegation: delegation()
  })
  t.alike(decodeDescriptor(encodeDescriptor(delegated)), delegated)
})

function signedAdvertisement(identity, overrides = {}) {
  const value = advertisement({
    identityKey: identity.publicKey,
    relaySignature: undefined,
    ...overrides
  })
  value.relaySignature = routes.cryptoSuite.sign(
    b4a.concat([DOMAIN.RELAY_ADVERTISEMENT, routes.encodeUnsignedRelayAdvertisement(value)]),
    identity.secretKey
  )
  return value
}

function signedDirectDescriptor(endpoint, entry, overrides = {}) {
  const value = descriptor({
    endpointKey: endpoint.publicKey,
    routeSigningKey: endpoint.publicKey,
    entryAdvertisement: encodeRelayAdvertisement(entry),
    signature: undefined,
    ...overrides
  })
  value.signature = routes.cryptoSuite.sign(
    b4a.concat([DOMAIN.DESCRIPTOR_DIRECT, routes.encodeUnsignedDescriptor(value)]),
    endpoint.secretKey
  )
  return value
}

test('direct descriptor authenticates endpoint and private entry advertisement', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const identity = privateRoleIdentity(21)
  const entry = signedAdvertisement(identity)
  const encoded = encodeDescriptor(signedDirectDescriptor(endpoint, entry))
  const verified = routes.verifyDescriptor(encoded, {
    requestedEndpointKey: endpoint.publicKey,
    now: 10n
  })

  t.ok(routes.isVerifiedDescriptor(verified))
  t.alike(routes.readVerifiedDescriptor(verified).endpointKey, endpoint.publicKey)
  t.is(routes.readVerifiedDescriptor(verified).authorizationMode, AUTHORIZATION_MODE.DIRECT)
})

test('verified descriptors are opaque and all security buffers are defensive copies', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const identity = privateRoleIdentity(21)
  const encoded = encodeDescriptor(signedDirectDescriptor(endpoint, signedAdvertisement(identity)))
  const expectedEncoding = b4a.from(encoded)
  const verified = routes.verifyDescriptor(encoded, {
    requestedEndpointKey: endpoint.publicKey,
    now: 10n
  })
  encoded.fill(0)

  const first = routes.readVerifiedDescriptor(verified)
  const mutateBuffers = (value) => {
    if (b4a.isBuffer(value)) value.fill(0)
    else if (value && typeof value === 'object') {
      for (const field of Object.values(value)) mutateBuffers(field)
    }
  }
  mutateBuffers(first)
  const second = routes.readVerifiedDescriptor(verified)

  t.alike(second.encoding, expectedEncoding)
  t.ok(second.endpointKey.some((byte) => byte !== 0))
  t.ok(second.routeSigningKey.some((byte) => byte !== 0))
  t.ok(second.routeEncryptionKey.some((byte) => byte !== 0))
  t.ok(second.descriptorId.some((byte) => byte !== 0))
  t.ok(second.entryAdvertisement.some((byte) => byte !== 0))
  t.ok(second.encryptedHops.some((byte) => byte !== 0))
  t.ok(second.signature.some((byte) => byte !== 0))
  t.ok(second.entry.identityKey.some((byte) => byte !== 0))
  t.ok(second.entry.relaySignature.some((byte) => byte !== 0))
  t.absent(routes.isVerifiedDescriptor({ ...verified }))
  t.absent(routes.isVerifiedDescriptor(second))
  expectCode(t, () => routes.readVerifiedDescriptor({}), 'INVALID_DESCRIPTOR')
})

test('direct authorization rejects distinct route signers and request mismatches', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const other = routes.cryptoSuite.keyPair(seed(30))
  const identity = privateRoleIdentity(21)
  const entry = signedAdvertisement(identity)
  const valid = signedDirectDescriptor(endpoint, entry)

  expectCode(
    t,
    () =>
      routes.verifyDescriptor(encodeDescriptor({ ...valid, routeSigningKey: other.publicKey }), {
        requestedEndpointKey: endpoint.publicKey,
        now: 10n
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      routes.verifyDescriptor(encodeDescriptor(valid), {
        requestedEndpointKey: other.publicKey,
        now: 10n
      }),
    'UNAUTHORIZED'
  )
})

test('verification rejects a requested endpoint mismatch before parsing nested relay bytes', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const other = routes.cryptoSuite.keyPair(seed(30))
  const identity = privateRoleIdentity(21)
  const encoded = encodeDescriptor(signedDirectDescriptor(endpoint, signedAdvertisement(identity)))
  const malformedEntry = b4a.from(encoded)
  const entryOffset = 4 + 1 + 32 * 4 + 2

  malformedEntry[entryOffset] = 1

  expectCode(
    t,
    () =>
      routes.verifyDescriptor(malformedEntry, {
        requestedEndpointKey: other.publicKey,
        now: 10n
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      routes.verifyDescriptor(malformedEntry, {
        requestedEndpointKey: endpoint.publicKey,
        now: 10n
      }),
    'INVALID_DESCRIPTOR'
  )
})

test('verification checks outer version, capabilities, cell size, and time before endpoint', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const other = routes.cryptoSuite.keyPair(seed(30))
  const identity = privateRoleIdentity(21)
  const encoded = encodeDescriptor(signedDirectDescriptor(endpoint, signedAdvertisement(identity)))
  const entryLength = encoded[133] * 0x100 + encoded[134]
  const epochOffset = 135 + entryLength
  const expiresOffset = epochOffset + 8
  const capabilitiesOffset = expiresOffset + 8
  const cellSizeOffset = capabilitiesOffset + 4
  const mutations = [
    (value) => {
      value[3] = 1
    },
    (value) => {
      value.fill(0, capabilitiesOffset, capabilitiesOffset + 4)
      value[capabilitiesOffset + 3] = 8
    },
    (value) => {
      value.fill(0, cellSizeOffset, cellSizeOffset + 2)
    },
    (value) => {
      value.fill(0, expiresOffset, expiresOffset + 8)
    }
  ]

  for (const mutate of mutations) {
    const changed = b4a.from(encoded)
    mutate(changed)
    expectCode(
      t,
      () =>
        routes.verifyDescriptor(changed, {
          requestedEndpointKey: other.publicKey,
          now: 10n
        }),
      'INVALID_DESCRIPTOR'
    )
  }
})

test('direct verification rejects relay signature, safety role, scope, and expiry failures', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const identity = privateRoleIdentity(21)
  const entry = signedAdvertisement(identity)
  const verify = (value) =>
    routes.verifyDescriptor(encodeDescriptor(value), {
      requestedEndpointKey: endpoint.publicKey,
      now: 10n
    })

  const badSignature = { ...entry, relaySignature: b4a.alloc(64) }
  expectCode(t, () => verify(signedDirectDescriptor(endpoint, badSignature)), 'UNAUTHORIZED')
  const safetyIdentity = (() => {
    for (let i = 40; i < 256; i++) {
      const pair = routes.cryptoSuite.keyPair(seed(i))
      if (routes.roleForIdentity(pair.publicKey) === ROLE.SAFETY) return pair
    }
  })()
  expectCode(
    t,
    () =>
      verify(
        signedDirectDescriptor(endpoint, signedAdvertisement(safetyIdentity, { role: ROLE.SAFETY }))
      ),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => verify(signedDirectDescriptor(endpoint, entry, { epoch: 8n })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () =>
      verify(
        signedDirectDescriptor(
          endpoint,
          signedAdvertisement(identity, { capabilities: CAPABILITY.FORWARD }),
          { capabilities: CAPABILITY.DATAGRAM }
        )
      ),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () => verify(signedDirectDescriptor(endpoint, entry, { expiresAt: 101n })),
    'INVALID_DESCRIPTOR'
  )
  expectCode(
    t,
    () =>
      routes.verifyDescriptor(encodeDescriptor(signedDirectDescriptor(endpoint, entry)), {
        requestedEndpointKey: endpoint.publicKey,
        now: 101n
      }),
    'INVALID_DESCRIPTOR'
  )
})

test('direct signatures cover every advertisement and descriptor field', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(20))
  const identity = privateRoleIdentity(21)
  const entry = signedAdvertisement(identity)
  const valid = signedDirectDescriptor(endpoint, entry)
  const verify = (value) =>
    routes.verifyDescriptor(encodeDescriptor(value), {
      requestedEndpointKey: endpoint.publicKey,
      now: 10n
    })

  for (const [changed, code] of [
    [{ ...entry, identityKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...entry, routeEncryptionKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...entry, dial: b4a.from('changed') }, 'UNAUTHORIZED'],
    [{ ...entry, role: ROLE.SAFETY }, 'INVALID_DESCRIPTOR'],
    [{ ...entry, capabilities: CAPABILITY.FORWARD }, 'UNAUTHORIZED'],
    [{ ...entry, epoch: 8n }, 'INVALID_DESCRIPTOR'],
    [{ ...entry, expiresAt: 99n }, 'UNAUTHORIZED']
  ]) {
    expectCode(t, () => verify(signedDirectDescriptor(endpoint, changed)), code)
  }

  for (const [changed, code] of [
    [{ ...valid, version: 1 }, 'INVALID_DESCRIPTOR'],
    [{ ...valid, descriptorId: seed(99) }, 'UNAUTHORIZED'],
    [{ ...valid, endpointKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...valid, routeSigningKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...valid, routeEncryptionKey: seed(99) }, 'UNAUTHORIZED'],
    [
      {
        ...valid,
        entryAdvertisement: encodeRelayAdvertisement(
          signedAdvertisement(identity, { dial: b4a.from('other') })
        )
      },
      'UNAUTHORIZED'
    ],
    [{ ...valid, epoch: 8n }, 'INVALID_DESCRIPTOR'],
    [{ ...valid, expiresAt: 89n }, 'UNAUTHORIZED'],
    [{ ...valid, capabilities: CAPABILITY.DATAGRAM }, 'UNAUTHORIZED'],
    [{ ...valid, encryptedHops: b4a.from('changed-hop-chain') }, 'UNAUTHORIZED']
  ]) {
    expectCode(t, () => verify(changed), code)
  }
})

function signedDelegation(endpoint, routeSigner, overrides = {}) {
  const value = delegation({
    endpointKey: endpoint.publicKey,
    routeSigningKey: routeSigner.publicKey,
    endpointSignature: undefined,
    ...overrides
  })
  value.endpointSignature = routes.cryptoSuite.sign(
    b4a.concat([DOMAIN.DELEGATION, routes.encodeUnsignedDelegation(value)]),
    endpoint.secretKey
  )
  return value
}

function signedDelegatedDescriptor(endpoint, routeSigner, entry, delegationValue, overrides = {}) {
  const value = descriptor({
    authorizationMode: AUTHORIZATION_MODE.DELEGATED,
    endpointKey: endpoint.publicKey,
    routeSigningKey: routeSigner.publicKey,
    entryAdvertisement: encodeRelayAdvertisement(entry),
    delegation: delegationValue,
    signature: undefined,
    ...overrides
  })
  value.signature = routes.cryptoSuite.sign(
    b4a.concat([DOMAIN.DESCRIPTOR_DELEGATED, routes.encodeUnsignedDescriptor(value)]),
    routeSigner.secretKey
  )
  return value
}

test('delegated descriptor requires endpoint authorization then route authorization', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const identity = privateRoleIdentity(52)
  const entry = signedAdvertisement(identity)
  const authorization = signedDelegation(endpoint, routeSigner)
  const encoded = encodeDescriptor(
    signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization)
  )
  const verified = routes.verifyDescriptor(encoded, {
    requestedEndpointKey: endpoint.publicKey,
    now: 10n
  })

  t.ok(routes.isVerifiedDescriptor(verified))
  t.is(routes.readVerifiedDescriptor(verified).authorizationMode, AUTHORIZATION_MODE.DELEGATED)
  t.alike(routes.readVerifiedDescriptor(verified).delegation.routeSigningKey, routeSigner.publicKey)
})

test('delegated verification rejects wrong endpoint and route signatures separately', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const wrong = routes.cryptoSuite.keyPair(seed(60))
  const identity = privateRoleIdentity(52)
  const entry = signedAdvertisement(identity)
  const authorization = signedDelegation(endpoint, routeSigner)
  const verify = (value) =>
    routes.verifyDescriptor(encodeDescriptor(value), {
      requestedEndpointKey: endpoint.publicKey,
      now: 10n
    })

  expectCode(
    t,
    () =>
      verify(
        signedDelegatedDescriptor(endpoint, routeSigner, entry, {
          ...authorization,
          endpointSignature: routes.cryptoSuite.sign(
            b4a.concat([DOMAIN.DELEGATION, routes.encodeUnsignedDelegation(authorization)]),
            wrong.secretKey
          )
        })
      ),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      verify({
        ...signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization),
        signature: b4a.alloc(64)
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      routes.verifyDescriptor(
        encodeDescriptor(signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization)),
        { requestedEndpointKey: wrong.publicKey, now: 10n }
      ),
    'UNAUTHORIZED'
  )
})

test('delegation scope binds endpoint, route key, time, epoch, expiry, and capabilities', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const wrong = routes.cryptoSuite.keyPair(seed(60))
  const identity = privateRoleIdentity(52)
  const entry = signedAdvertisement(identity)
  const verify = (authorization, overrides = {}, now = 10n) =>
    routes.verifyDescriptor(
      encodeDescriptor(
        signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization, overrides)
      ),
      { requestedEndpointKey: endpoint.publicKey, now }
    )

  expectCode(t, () => verify(signedDelegation(wrong, routeSigner)), 'UNAUTHORIZED')
  expectCode(t, () => verify(signedDelegation(endpoint, wrong)), 'UNAUTHORIZED')
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { notBefore: 11n })),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { expiresAt: 10n })),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { minEpoch: 8n })),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { maxEpoch: 6n })),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { expiresAt: 89n })),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => verify(signedDelegation(endpoint, routeSigner, { capabilities: CAPABILITY.DATAGRAM })),
    'UNAUTHORIZED'
  )
})

test('delegated signature binds the canonical delegation and destination route encryption key', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const identity = privateRoleIdentity(52)
  const entry = signedAdvertisement(identity, { routeEncryptionKey: seed(70) })
  const authorization = signedDelegation(endpoint, routeSigner)
  const valid = signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization, {
    routeEncryptionKey: seed(71)
  })
  const verify = (value) =>
    routes.verifyDescriptor(encodeDescriptor(value), {
      requestedEndpointKey: endpoint.publicKey,
      now: 10n
    })

  t.absent(b4a.equals(valid.routeEncryptionKey, entry.routeEncryptionKey))
  expectCode(t, () => verify({ ...valid, routeEncryptionKey: seed(72) }), 'UNAUTHORIZED')
  expectCode(
    t,
    () => verify({ ...valid, delegation: { ...authorization, maxEpoch: 21n } }),
    'UNAUTHORIZED'
  )
})

test('relay and destination route encryption keys may be equal in either authorization mode', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const identity = privateRoleIdentity(52)
  const sharedRouteKey = seed(70)
  const entry = signedAdvertisement(identity, { routeEncryptionKey: sharedRouteKey })
  const direct = signedDirectDescriptor(endpoint, entry, {
    routeEncryptionKey: sharedRouteKey
  })
  const authorization = signedDelegation(endpoint, routeSigner)
  const delegated = signedDelegatedDescriptor(endpoint, routeSigner, entry, authorization, {
    routeEncryptionKey: sharedRouteKey
  })

  t.ok(
    routes.isVerifiedDescriptor(
      routes.verifyDescriptor(encodeDescriptor(direct), {
        requestedEndpointKey: endpoint.publicKey,
        now: 10n
      })
    )
  )
  t.ok(
    routes.isVerifiedDescriptor(
      routes.verifyDescriptor(encodeDescriptor(delegated), {
        requestedEndpointKey: endpoint.publicKey,
        now: 10n
      })
    )
  )
})

test('relay advertisement signer ignores cyclic metadata and returns only canonical fields', (t) => {
  const identity = privateRoleIdentity(80)
  const input = advertisement({ identityKey: identity.publicKey })
  delete input.relaySignature
  input.unknown = 'ignored'
  input.extra = input
  let signed = null
  let error = null

  try {
    signed = routes.signRelayAdvertisement(input, identity.secretKey)
  } catch (err) {
    error = err
  }

  t.absent(error)
  if (!signed) return
  t.alike(Object.keys(signed), [
    'version',
    'identityKey',
    'routeEncryptionKey',
    'dial',
    'role',
    'capabilities',
    'epoch',
    'expiresAt',
    'relaySignature'
  ])
  t.absent('relaySignature' in input)
  t.is(input.extra, input)
  t.ok(
    routes.cryptoSuite.verify(
      b4a.concat([DOMAIN.RELAY_ADVERTISEMENT, routes.encodeUnsignedRelayAdvertisement(input)]),
      signed.relaySignature,
      identity.publicKey
    )
  )
})

test('delegation signer ignores cyclic metadata and returns only canonical fields', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(81))
  const routeSigner = routes.cryptoSuite.keyPair(seed(82))
  const input = delegation({
    endpointKey: endpoint.publicKey,
    routeSigningKey: routeSigner.publicKey
  })
  delete input.endpointSignature
  input.unknown = 'ignored'
  input.extra = input
  let signed = null
  let error = null

  try {
    signed = routes.signDelegation(input, endpoint.secretKey)
  } catch (err) {
    error = err
  }

  t.absent(error)
  if (!signed) return
  t.alike(Object.keys(signed), [
    'version',
    'endpointKey',
    'routeSigningKey',
    'notBefore',
    'expiresAt',
    'minEpoch',
    'maxEpoch',
    'capabilities',
    'endpointSignature'
  ])
  t.absent('endpointSignature' in input)
  t.is(input.extra, input)
  t.ok(
    routes.cryptoSuite.verify(
      b4a.concat([DOMAIN.DELEGATION, routes.encodeUnsignedDelegation(input)]),
      signed.endpointSignature,
      endpoint.publicKey
    )
  )
})

test('descriptor signer ignores cyclic metadata and returns only canonical fields', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(83))
  const identity = privateRoleIdentity(84)
  const input = descriptor({
    endpointKey: endpoint.publicKey,
    routeSigningKey: endpoint.publicKey,
    entryAdvertisement: encodeRelayAdvertisement(signedAdvertisement(identity))
  })
  delete input.signature
  input.unknown = 'ignored'
  input.extra = input
  let signed = null
  let error = null

  try {
    signed = routes.signDescriptor(input, endpoint.secretKey)
  } catch (err) {
    error = err
  }

  t.absent(error)
  if (!signed) return
  t.alike(Object.keys(signed), [
    'version',
    'authorizationMode',
    'descriptorId',
    'endpointKey',
    'routeSigningKey',
    'routeEncryptionKey',
    'entryAdvertisement',
    'epoch',
    'expiresAt',
    'capabilities',
    'cellSize',
    'encryptedHops',
    'signature'
  ])
  t.absent('signature' in input)
  t.is(input.extra, input)
  t.ok(
    routes.cryptoSuite.verify(
      b4a.concat([DOMAIN.DESCRIPTOR_DIRECT, routes.encodeUnsignedDescriptor(input)]),
      signed.signature,
      endpoint.publicKey
    )
  )
})

test('accepted direct and delegated descriptors canonically decode and re-encode', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(85))
  const routeSigner = routes.cryptoSuite.keyPair(seed(86))
  const identity = privateRoleIdentity(87)
  const entry = routes.signRelayAdvertisement(
    {
      ...advertisement(),
      identityKey: identity.publicKey,
      relaySignature: undefined
    },
    identity.secretKey
  )
  const authorization = routes.signDelegation(
    {
      ...delegation(),
      endpointKey: endpoint.publicKey,
      routeSigningKey: routeSigner.publicKey,
      endpointSignature: undefined
    },
    endpoint.secretKey
  )
  const direct = routes.signDescriptor(
    {
      ...descriptor(),
      endpointKey: endpoint.publicKey,
      routeSigningKey: endpoint.publicKey,
      entryAdvertisement: encodeRelayAdvertisement(entry),
      signature: undefined
    },
    endpoint.secretKey
  )
  const delegated = routes.signDescriptor(
    {
      ...descriptor(),
      authorizationMode: AUTHORIZATION_MODE.DELEGATED,
      endpointKey: endpoint.publicKey,
      routeSigningKey: routeSigner.publicKey,
      entryAdvertisement: encodeRelayAdvertisement(entry),
      delegation: authorization,
      signature: undefined
    },
    routeSigner.secretKey
  )

  for (const value of [direct, delegated]) {
    const encoded = encodeDescriptor(value)
    t.ok(
      routes.isVerifiedDescriptor(
        routes.verifyDescriptor(encoded, {
          requestedEndpointKey: endpoint.publicKey,
          now: 10n
        })
      )
    )
    t.alike(encodeDescriptor(decodeDescriptor(encoded)), encoded)
  }
})

test('endpoint signature covers every delegation field', (t) => {
  const endpoint = routes.cryptoSuite.keyPair(seed(50))
  const routeSigner = routes.cryptoSuite.keyPair(seed(51))
  const identity = privateRoleIdentity(52)
  const entry = signedAdvertisement(identity)
  const authorization = signedDelegation(endpoint, routeSigner)
  const verify = (changed) =>
    routes.verifyDescriptor(
      encodeDescriptor(signedDelegatedDescriptor(endpoint, routeSigner, entry, changed)),
      { requestedEndpointKey: endpoint.publicKey, now: 10n }
    )

  for (const [changed, code] of [
    [{ ...authorization, version: 1 }, 'INVALID_DESCRIPTOR'],
    [{ ...authorization, endpointKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...authorization, routeSigningKey: seed(99) }, 'UNAUTHORIZED'],
    [{ ...authorization, notBefore: 2n }, 'UNAUTHORIZED'],
    [{ ...authorization, expiresAt: 99n }, 'UNAUTHORIZED'],
    [{ ...authorization, minEpoch: 1n }, 'UNAUTHORIZED'],
    [{ ...authorization, maxEpoch: 21n }, 'UNAUTHORIZED'],
    [{ ...authorization, capabilities: CAPABILITY.FORWARD }, 'UNAUTHORIZED']
  ]) {
    expectCode(t, () => verify(changed), code)
  }
})
