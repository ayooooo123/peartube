import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import {
  TEST_ONLY_LINK_DIRECTORY_OBSERVER,
  readLinkHandle,
  readVerifiedTopologyGrant
} from '../lib/topology-grant.js'
import { expectCode, privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

const {
  DOMAIN,
  LINK_OPERATION,
  LinkDirectory,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE,
  cryptoSuite,
  decodeTopologyGrant,
  encodeTopologyGrant,
  encodeUnsignedTopologyGrant,
  signTopologyGrant,
  verifyTopologyGrant
} = routes

const KNOWN_UNSIGNED_HEX =
  '0000000000111111111111111111111111111111111111111111111111111111111111111143046bfe4092b3e94994eada15dcc20d8aaa07b658fd3954eb8e0efb8bdca5de00047f000001a029014ed32f63bf35f0eeefcb25f28a2e1fbdc873ae2835671b0c9460f5f12e4556a80604c0000209a02a020102030405060708000000000000100000000000000020002222222222222222222222222222222222222222222222222222222222222222'
const KNOWN_SIGNED_HASH_HEX = 'ec3aa1bf7443d5a39c5a176b16de6a75f9f95dbb8b804ff2b30d45ff28ef58c7'
const KNOWN_SIGNATURE_HEX =
  '379dfdef88eaa663db808df8e9a8a09ab0d958a297b9d4047e053c5de7ae4aaa2b19081773f3e8e509c3fdc9d1dd2b26e813c263ecd0a05d899d71796fa40e03'
const KNOWN_DIGEST_HEX = 'fde042bf733d003aac6d9f9e8d9d8830a0a6036a7758e65a881f6dca4d9cb5c3'

function endpoint(identity32, role, host, port, operations) {
  return { identity32, role, host, port, operations }
}

function knownFixture(overrides = {}) {
  const authority = cryptoSuite.keyPair(seed(90))
  const a = cryptoSuite.keyPair(seed(31))
  const b = cryptoSuite.keyPair(seed(32))
  const grant = {
    version: PROTOCOL_VERSION,
    format: 0,
    grantId32: seed(17),
    endpointA: endpoint(
      a.publicKey,
      TOPOLOGY_ROLE.SOURCE,
      '127.0.0.1',
      41001,
      LINK_OPERATION.INITIATE
    ),
    endpointB: endpoint(
      b.publicKey,
      TOPOLOGY_ROLE.DESTINATION,
      '192.0.2.9',
      41002,
      LINK_OPERATION.ACCEPT
    ),
    epoch: 0x0102_0304_0506_0708n,
    notBefore: 0x1000n,
    expiresAt: 0x2000n,
    runId32: seed(34),
    ...overrides
  }
  return { authority, a, b, grant }
}

function classifiedFixture(overrides = {}) {
  const authority = cryptoSuite.keyPair(seed(91))
  const safety = safetyRoleIdentity(100)
  const privateRelay = privateRoleIdentity(120)
  const grant = {
    version: PROTOCOL_VERSION,
    format: 0,
    grantId32: seed(18),
    endpointA: endpoint(
      safety.publicKey,
      TOPOLOGY_ROLE.SAFETY_FINAL,
      '2001:db8::1',
      42001,
      LINK_OPERATION.KNOWN
    ),
    endpointB: endpoint(
      privateRelay.publicKey,
      TOPOLOGY_ROLE.PRIVATE_ENTRY,
      '2001:db8::2',
      42002,
      LINK_OPERATION.KNOWN
    ),
    epoch: 7n,
    notBefore: 100n,
    expiresAt: 200n,
    runId32: seed(35),
    ...overrides
  }
  return { authority, safety, privateRelay, grant }
}

function signedFixture(fixture = classifiedFixture()) {
  return { ...fixture, signed: signTopologyGrant(fixture.grant, fixture.authority.secretKey) }
}

function twoSignedFixtures() {
  const first = signedFixture()
  const base = classifiedFixture()
  const second = signedFixture(
    classifiedFixture({
      grantId32: seed(19),
      endpointB: {
        ...base.grant.endpointB,
        host: '2001:db8::3',
        port: 42003
      }
    })
  )
  return { first, second }
}

function fakeClock(start = 100n) {
  let now = start
  let nextId = 1
  const timers = new Map()

  function runDue() {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
        progressed = true
        break
      }
    }
  }

  return Object.freeze({
    now: () => now,
    schedule(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, at: now + BigInt(delay) })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    advance(delta) {
      now += BigInt(delta)
      runDue()
    },
    pending: () => timers.size
  })
}

function directoryOptions(fixture, clock, overrides = {}) {
  return {
    localIdentity32: fixture.safety.publicKey,
    localRole: TOPOLOGY_ROLE.SAFETY_FINAL,
    authorityPublicKey: fixture.authority.publicKey,
    epoch: fixture.grant.epoch,
    runId32: fixture.grant.runId32,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onClose() {},
    ...overrides
  }
}

function authorization(fixture, digest32, overrides = {}) {
  return {
    digest32,
    operation: LINK_OPERATION.INITIATE,
    localIdentity32: fixture.safety.publicKey,
    localRole: TOPOLOGY_ROLE.SAFETY_FINAL,
    peerIdentity32: fixture.privateRelay.publicKey,
    peerRole: TOPOLOGY_ROLE.PRIVATE_ENTRY,
    epoch: fixture.grant.epoch,
    runId32: fixture.grant.runId32,
    ...overrides
  }
}

test('topology grant constants are frozen, distinct, and topology roles do not overload relay roles', (t) => {
  t.alike(TOPOLOGY_ROLE, {
    SOURCE: 0,
    SAFETY_GUARD: 1,
    SAFETY_FINAL: 2,
    PRIVATE_ENTRY: 3,
    PRIVATE_MIDDLE: 4,
    PRIVATE_FINAL: 5,
    DESTINATION: 6
  })
  t.alike(LINK_OPERATION, { INITIATE: 1, ACCEPT: 2, KNOWN: 3 })
  t.ok(Object.isFrozen(TOPOLOGY_ROLE))
  t.ok(Object.isFrozen(LINK_OPERATION))
  t.is(b4a.toString(DOMAIN.TOPOLOGY_GRANT), 'hyperdht-private-routes/topology-grant/v0')
  t.is('TEST_ONLY_LINK_DIRECTORY_OBSERVER' in routes, false)
  t.is('readLinkHandle' in routes, false)
  t.is('readVerifiedTopologyGrant' in routes, false)
})

test('canonical grant has exact known-answer bytes, domain hash, signature, and digest', (t) => {
  const fixture = knownFixture()
  const unsigned = encodeUnsignedTopologyGrant(fixture.grant)
  const expectedUnsigned = b4a.from(KNOWN_UNSIGNED_HEX, 'hex')

  t.is(unsigned.byteLength, 175)
  t.alike(unsigned, expectedUnsigned)

  const signedHash = cryptoSuite.hash([DOMAIN.TOPOLOGY_GRANT, unsigned])
  t.is(b4a.toString(signedHash, 'hex'), KNOWN_SIGNED_HASH_HEX)

  const signed = signTopologyGrant(fixture.grant, fixture.authority.secretKey)
  t.is(signed.byteLength, 239)
  t.alike(signed.subarray(0, unsigned.byteLength), expectedUnsigned)
  t.is(b4a.toString(signed.subarray(unsigned.byteLength), 'hex'), KNOWN_SIGNATURE_HEX)
  t.ok(
    cryptoSuite.verify(
      signedHash,
      signed.subarray(unsigned.byteLength),
      fixture.authority.publicKey
    )
  )
  t.is(b4a.toString(cryptoSuite.hash(signed), 'hex'), KNOWN_DIGEST_HEX)
  t.alike(encodeTopologyGrant(decodeTopologyGrant(signed)), signed)
})

test('one signed grant is identical at both peers and preserves all bilateral bindings', (t) => {
  const fixture = knownFixture()
  const reversed = {
    ...fixture.grant,
    endpointA: fixture.grant.endpointB,
    endpointB: fixture.grant.endpointA
  }
  const canonical = signTopologyGrant(fixture.grant, fixture.authority.secretKey)
  const canonicalFromReverse = signTopologyGrant(reversed, fixture.authority.secretKey)

  t.alike(canonicalFromReverse, canonical)

  const verifiedA = verifyTopologyGrant(canonical, fixture.authority.publicKey, {
    localIdentity32: fixture.a.publicKey,
    now: 0x1000n
  })
  const verifiedB = verifyTopologyGrant(canonical, fixture.authority.publicKey, {
    localIdentity32: fixture.b.publicKey,
    now: 0x1000n
  })
  t.alike(Object.keys(verifiedA), [])
  t.alike(Object.keys(verifiedB), [])

  const atA = readVerifiedTopologyGrant(verifiedA)
  const atB = readVerifiedTopologyGrant(verifiedB)
  t.alike(atA.digest32, atB.digest32)
  t.alike(atA.encoding, atB.encoding)
  t.alike(atA.local.identity32, fixture.a.publicKey)
  t.alike(atA.peer.identity32, fixture.b.publicKey)
  t.is(atA.local.operations, LINK_OPERATION.INITIATE)
  t.is(atA.peer.operations, LINK_OPERATION.ACCEPT)
  t.alike(atB.local.identity32, fixture.b.publicKey)
  t.alike(atB.peer.identity32, fixture.a.publicKey)
  t.is(atB.local.operations, LINK_OPERATION.ACCEPT)
  t.is(atB.peer.operations, LINK_OPERATION.INITIATE)
  t.alike(atA.peer.address, { family: 4, host: '192.0.2.9', port: 41002 })
  t.alike(atB.peer.address, { family: 4, host: '127.0.0.1', port: 41001 })
  t.is(atA.epoch, 0x0102_0304_0506_0708n)
  t.is(atA.notBefore, 0x1000n)
  t.is(atA.expiresAt, 0x2000n)
  t.alike(atA.runId32, seed(34))

  atA.digest32.fill(0)
  atA.encoding.fill(0)
  atA.local.identity32.fill(0)
  t.is(b4a.toString(readVerifiedTopologyGrant(verifiedA).digest32, 'hex'), KNOWN_DIGEST_HEX)
  t.alike(readVerifiedTopologyGrant(verifiedA).local.identity32, fixture.a.publicKey)
})

test('numeric IPv4 and canonical IPv6 round trip while aliases and names fail closed', (t) => {
  const fixture = classifiedFixture()
  const signed = signTopologyGrant(fixture.grant, fixture.authority.secretKey)
  const decoded = decodeTopologyGrant(signed)

  const hosts = [decoded.endpointA.host, decoded.endpointB.host].sort()
  t.alike(hosts, ['2001:db8::1', '2001:db8::2'])

  for (const host of [
    'localhost',
    '127.000.0.1',
    '127.0.0.1.',
    '2001:0db8::1',
    '2001:DB8::1',
    '2001:db8:0:0:0:0:0:1',
    '2001:db8::1%lo0',
    '::ffff:192.0.2.1'
  ]) {
    expectCode(
      t,
      () =>
        signTopologyGrant(
          {
            ...fixture.grant,
            endpointA: { ...fixture.grant.endpointA, host }
          },
          fixture.authority.secretKey
        ),
      'INVALID_ROUTE'
    )
  }
})

test('topology participant roles bind safety/private relay classification without classifying endpoints', (t) => {
  const fixture = classifiedFixture()
  t.ok(signTopologyGrant(fixture.grant, fixture.authority.secretKey))

  for (const role of [TOPOLOGY_ROLE.SAFETY_GUARD, TOPOLOGY_ROLE.SAFETY_FINAL]) {
    expectCode(
      t,
      () =>
        signTopologyGrant(
          {
            ...fixture.grant,
            endpointA: {
              ...fixture.grant.endpointA,
              identity32: fixture.privateRelay.publicKey,
              role
            }
          },
          fixture.authority.secretKey
        ),
      'UNAUTHORIZED'
    )
  }

  for (const role of [
    TOPOLOGY_ROLE.PRIVATE_ENTRY,
    TOPOLOGY_ROLE.PRIVATE_MIDDLE,
    TOPOLOGY_ROLE.PRIVATE_FINAL
  ]) {
    expectCode(
      t,
      () =>
        signTopologyGrant(
          {
            ...fixture.grant,
            endpointB: {
              ...fixture.grant.endpointB,
              identity32: fixture.safety.publicKey,
              role
            }
          },
          fixture.authority.secretKey
        ),
      'UNAUTHORIZED'
    )
  }

  const endpoints = knownFixture()
  t.ok(signTopologyGrant(endpoints.grant, endpoints.authority.secretKey))
})

test('every one-byte mutation of a signed topology grant is rejected', (t) => {
  const fixture = knownFixture()
  const signed = signTopologyGrant(fixture.grant, fixture.authority.secretKey)

  for (let offset = 0; offset < signed.byteLength; offset++) {
    const mutated = b4a.from(signed)
    mutated[offset] ^= 1
    let error = null
    try {
      verifyTopologyGrant(mutated, fixture.authority.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x1000n
      })
    } catch (err) {
      error = err
    }
    t.ok(error, `mutation at byte ${offset}`)
  }

  expectCode(
    t,
    () =>
      verifyTopologyGrant(signed.subarray(0, signed.byteLength - 1), fixture.authority.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x1000n
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      verifyTopologyGrant(b4a.concat([signed, b4a.from([0])]), fixture.authority.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x1000n
      }),
    'INVALID_ROUTE'
  )
})

test('grant verification requires authority, local membership, and active validity window', (t) => {
  const fixture = knownFixture()
  const signed = signTopologyGrant(fixture.grant, fixture.authority.secretKey)
  const stranger = cryptoSuite.keyPair(seed(99))

  expectCode(
    t,
    () =>
      verifyTopologyGrant(signed, stranger.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x1000n
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      verifyTopologyGrant(signed, fixture.authority.publicKey, {
        localIdentity32: stranger.publicKey,
        now: 0x1000n
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      verifyTopologyGrant(signed, fixture.authority.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x0fffn
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      verifyTopologyGrant(signed, fixture.authority.publicKey, {
        localIdentity32: fixture.a.publicKey,
        now: 0x2000n
      }),
    'UNAUTHORIZED'
  )
})

test('LinkDirectory authorizes one opaque adjacent handle with exact route-local bindings', (t) => {
  const fixture = signedFixture()
  const clock = fakeClock()
  const directory = new LinkDirectory(directoryOptions(fixture, clock))
  const digest32 = directory.add(fixture.signed)
  const handle = directory.authorize(authorization(fixture, digest32))
  const again = directory.authorize(authorization(fixture, b4a.from(digest32)))

  t.is(handle, again)
  t.alike(Object.keys(handle), [])
  t.alike(Object.keys(directory), [])
  for (const name of ['entries', 'values', 'addresses', 'lookupAddress', 'dial', 'send']) {
    t.is(name in directory, false)
  }

  const link = readLinkHandle(handle)
  t.alike(link.digest32, digest32)
  t.alike(link.localIdentity32, fixture.safety.publicKey)
  t.is(link.localRole, TOPOLOGY_ROLE.SAFETY_FINAL)
  t.alike(link.peerIdentity32, fixture.privateRelay.publicKey)
  t.is(link.peerRole, TOPOLOGY_ROLE.PRIVATE_ENTRY)
  t.alike(link.peerAddress, { family: 6, host: '2001:db8::2', port: 42002 })
  t.is(link.epoch, 7n)
  t.alike(link.runId32, seed(35))
  t.is(link.operations, LINK_OPERATION.KNOWN)

  link.peerIdentity32.fill(0)
  link.digest32.fill(0)
  t.alike(readLinkHandle(handle).peerIdentity32, fixture.privateRelay.publicKey)
  t.alike(readLinkHandle(handle).digest32, digest32)

  const invalidBindings = [
    { operation: LINK_OPERATION.ACCEPT << 1 },
    { localIdentity32: fixture.privateRelay.publicKey },
    { localRole: TOPOLOGY_ROLE.SAFETY_GUARD },
    { peerIdentity32: fixture.safety.publicKey },
    { peerRole: TOPOLOGY_ROLE.PRIVATE_MIDDLE },
    { epoch: 8n },
    { runId32: seed(36) },
    { digest32: seed(37) }
  ]
  for (const override of invalidBindings) {
    expectCode(
      t,
      () => directory.authorize(authorization(fixture, digest32, override)),
      'UNAUTHORIZED'
    )
  }
})

test('LinkDirectory accepts only local verified grants and copies all retained bytes', (t) => {
  const fixture = signedFixture()
  const clock = fakeClock()
  const directory = new LinkDirectory(directoryOptions(fixture, clock))
  const input = b4a.from(fixture.signed)
  const digest32 = directory.add(input)
  input.fill(0)
  fixture.grant.runId32.fill(0)
  fixture.safety.publicKey.fill(0)

  const handle = directory.authorize({
    ...authorization(classifiedFixture(), digest32),
    localIdentity32: readVerifiedTopologyGrant(
      verifyTopologyGrant(fixture.signed, fixture.authority.publicKey, {
        localIdentity32: safetyRoleIdentity(100).publicKey,
        now: 100n
      })
    ).local.identity32
  })
  t.ok(handle)

  const stranger = cryptoSuite.keyPair(seed(199))
  const unrelated = knownFixture({
    grantId32: seed(44),
    epoch: 7n,
    notBefore: 100n,
    expiresAt: 200n,
    runId32: seed(35)
  })
  unrelated.grant.endpointA = {
    ...unrelated.grant.endpointA,
    identity32: stranger.publicKey
  }
  const unrelatedSigned = signTopologyGrant(unrelated.grant, unrelated.authority.secretKey)
  const otherDirectory = new LinkDirectory({
    ...directoryOptions(classifiedFixture(), clock),
    authorityPublicKey: unrelated.authority.publicKey
  })
  expectCode(t, () => otherDirectory.add(unrelatedSigned), 'UNAUTHORIZED')
})

test('LinkDirectory expiry closes the active handle, tombstones it, and prevents reopening', (t) => {
  const fixture = signedFixture()
  const clock = fakeClock()
  const closes = []
  const snapshots = []
  const directory = new LinkDirectory(
    directoryOptions(fixture, clock, {
      onClose: (handle, reason) => closes.push({ handle, reason }),
      [TEST_ONLY_LINK_DIRECTORY_OBSERVER]: (snapshot) => snapshots.push(snapshot)
    })
  )
  const digest32 = directory.add(fixture.signed)
  const handle = directory.authorize(authorization(fixture, digest32))

  t.is(clock.pending(), 1)
  clock.advance(99)
  t.is(closes.length, 0)
  clock.advance(1)
  t.alike(closes, [{ handle, reason: 'expired' }])
  t.is(clock.pending(), 0)
  expectCode(t, () => directory.authorize(authorization(fixture, digest32)), 'UNAUTHORIZED')
  expectCode(t, () => directory.add(fixture.signed), 'UNAUTHORIZED')
  t.alike(snapshots.at(-1), {
    grants: 0,
    handles: 0,
    tombstones: 1,
    timers: 0,
    destroyed: false
  })
})

test('same-epoch revocation is bound to the configured run and permanently tombstones the grant', (t) => {
  const fixture = signedFixture()
  const clock = fakeClock()
  const closes = []
  const directory = new LinkDirectory(
    directoryOptions(fixture, clock, {
      onClose: (handle, reason) => closes.push({ handle, reason })
    })
  )
  const digest32 = directory.add(fixture.signed)
  const handle = directory.authorize(authorization(fixture, digest32))

  expectCode(
    t,
    () => directory.revoke({ digest32, epoch: 8n, runId32: fixture.grant.runId32 }),
    'UNAUTHORIZED'
  )
  expectCode(t, () => directory.revoke({ digest32, epoch: 7n, runId32: seed(90) }), 'UNAUTHORIZED')
  t.is(directory.authorize(authorization(fixture, digest32)), handle)

  directory.revoke({ digest32, epoch: 7n, runId32: fixture.grant.runId32 })
  t.alike(closes, [{ handle, reason: 'revoked' }])
  expectCode(t, () => directory.authorize(authorization(fixture, digest32)), 'UNAUTHORIZED')
  expectCode(t, () => directory.add(fixture.signed), 'UNAUTHORIZED')
  expectCode(
    t,
    () => directory.revoke({ digest32, epoch: 7n, runId32: fixture.grant.runId32 }),
    'UNAUTHORIZED'
  )
})

test('LinkDirectory bounds grants and handles without exposing partial authority', (t) => {
  const first = signedFixture()
  const second = signedFixture(
    classifiedFixture({
      grantId32: seed(19),
      endpointB: {
        ...classifiedFixture().grant.endpointB,
        host: '2001:db8::3',
        port: 42003
      }
    })
  )
  const clock = fakeClock()
  const grantBound = new LinkDirectory(
    directoryOptions(first, clock, { maxGrants: 1, maxHandles: 1 })
  )
  grantBound.add(first.signed)
  expectCode(t, () => grantBound.add(second.signed), 'CIRCUIT_LIMIT')

  const handleBound = new LinkDirectory(
    directoryOptions(first, clock, { maxGrants: 2, maxHandles: 1 })
  )
  const firstDigest = handleBound.add(first.signed)
  const secondDigest = handleBound.add(second.signed)
  t.ok(handleBound.authorize(authorization(first, firstDigest)))
  expectCode(
    t,
    () =>
      handleBound.authorize(
        authorization(second, secondDigest, {
          peerIdentity32: second.privateRelay.publicKey
        })
      ),
    'CIRCUIT_LIMIT'
  )
})

test('destroy closes active links, cancels expiry, and leaves zero retained directory state', (t) => {
  const fixture = signedFixture()
  const clock = fakeClock()
  const closes = []
  const snapshots = []
  const directory = new LinkDirectory(
    directoryOptions(fixture, clock, {
      onClose: (handle, reason) => closes.push({ handle, reason }),
      [TEST_ONLY_LINK_DIRECTORY_OBSERVER]: (snapshot) => snapshots.push(snapshot)
    })
  )
  const digest32 = directory.add(fixture.signed)
  const handle = directory.authorize(authorization(fixture, digest32))

  directory.destroy()
  directory.destroy()

  t.alike(closes, [{ handle, reason: 'destroyed' }])
  t.is(clock.pending(), 0)
  t.alike(snapshots.at(-1), {
    grants: 0,
    handles: 0,
    tombstones: 0,
    timers: 0,
    destroyed: true,
    ownedBytes: 0,
    callbacks: 0
  })
  expectCode(t, () => directory.add(fixture.signed), 'CIRCUIT_STATE')
  expectCode(t, () => directory.authorize(authorization(fixture, digest32)), 'CIRCUIT_STATE')
  expectCode(
    t,
    () => directory.revoke({ digest32, epoch: 7n, runId32: fixture.grant.runId32 }),
    'CIRCUIT_STATE'
  )
  expectCode(t, () => readLinkHandle(handle), 'UNAUTHORIZED')
})

test('destroy cleans every handle and callback before mapping the first onClose failure', (t) => {
  const { first, second } = twoSignedFixtures()
  const clock = fakeClock()
  const closes = []
  const snapshots = []
  let firstHandle = null
  const directory = new LinkDirectory(
    directoryOptions(first, clock, {
      maxGrants: 2,
      maxHandles: 2,
      onClose(handle) {
        closes.push(handle)
        if (handle === firstHandle) throw new Error('sensitive onClose failure')
      },
      [TEST_ONLY_LINK_DIRECTORY_OBSERVER]: (snapshot) => snapshots.push(snapshot)
    })
  )
  const firstDigest = directory.add(first.signed)
  const secondDigest = directory.add(second.signed)
  firstHandle = directory.authorize(authorization(first, firstDigest))
  const secondHandle = directory.authorize(authorization(second, secondDigest))

  let error = null
  try {
    directory.destroy()
  } catch (err) {
    error = err
  }

  t.ok(error instanceof routes.PrivateRouteError)
  if (error) {
    t.is(error.code, 'ROUTE_UNAVAILABLE')
    t.is(error.message.includes('sensitive'), false)
  }
  t.alike(closes, [firstHandle, secondHandle])
  expectCode(t, () => readLinkHandle(firstHandle), 'UNAUTHORIZED')
  expectCode(t, () => readLinkHandle(secondHandle), 'UNAUTHORIZED')
  t.is(clock.pending(), 0)
  t.alike(snapshots.at(-1), {
    grants: 0,
    handles: 0,
    tombstones: 0,
    timers: 0,
    destroyed: true,
    ownedBytes: 0,
    callbacks: 0
  })

  directory.destroy()
  t.alike(closes, [firstHandle, secondHandle])
})

test('destroy attempts every timer cancellation and closes every handle after a cancel failure', (t) => {
  const { first, second } = twoSignedFixtures()
  const clock = fakeClock()
  const closes = []
  const snapshots = []
  let cancelCalls = 0
  const directory = new LinkDirectory(
    directoryOptions(first, clock, {
      maxGrants: 2,
      maxHandles: 2,
      cancel(id) {
        clock.cancel(id)
        cancelCalls++
        if (cancelCalls === 1) throw new Error('sensitive cancel failure')
      },
      onClose: (handle) => closes.push(handle),
      [TEST_ONLY_LINK_DIRECTORY_OBSERVER]: (snapshot) => snapshots.push(snapshot)
    })
  )
  const firstDigest = directory.add(first.signed)
  const secondDigest = directory.add(second.signed)
  const firstHandle = directory.authorize(authorization(first, firstDigest))
  const secondHandle = directory.authorize(authorization(second, secondDigest))

  let error = null
  try {
    directory.destroy()
  } catch (err) {
    error = err
  }

  t.ok(error instanceof routes.PrivateRouteError)
  if (error) {
    t.is(error.code, 'ROUTE_UNAVAILABLE')
    t.is(error.message.includes('sensitive'), false)
  }
  t.is(cancelCalls, 2)
  t.alike(closes, [firstHandle, secondHandle])
  expectCode(t, () => readLinkHandle(firstHandle), 'UNAUTHORIZED')
  expectCode(t, () => readLinkHandle(secondHandle), 'UNAUTHORIZED')
  t.is(clock.pending(), 0)
  t.alike(snapshots.at(-1), {
    grants: 0,
    handles: 0,
    tombstones: 0,
    timers: 0,
    destroyed: true,
    ownedBytes: 0,
    callbacks: 0
  })
})
