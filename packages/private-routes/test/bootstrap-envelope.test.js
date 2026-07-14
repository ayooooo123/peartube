import test from 'brittle'
import b4a from 'b4a'

import {
  BOOTSTRAP_CLASS,
  BOOTSTRAP_DEADLINE,
  BOOTSTRAP_HEADER_SIZE,
  BOOTSTRAP_MAX_BODY,
  BOOTSTRAP_REJECT_CODE,
  BOOTSTRAP_SIGNATURE_SIZE,
  BOOTSTRAP_SIZE,
  BOOTSTRAP_TYPE,
  BootstrapEnvelopeCodec,
  BootstrapRequestTable,
  DOMAIN,
  LinkDirectory,
  LINK_OPERATION,
  PrivateRouteError,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE,
  createLinkSetupAuthority,
  cryptoSuite,
  signTopologyGrant
} from '../index.js'
import { CellCodec } from '../lib/cell-codec.js'
import { TEST_ONLY_BOOTSTRAP_REQUEST_TABLE_OBSERVER } from '../lib/bootstrap-envelope.js'
import { expectCode, safetyRoleIdentity, seed } from './helpers.js'

const ZERO_DIGEST = b4a.alloc(32)

function fakeClock(start = 1_000) {
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

  return {
    now: () => now,
    schedule(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, at: now + delay })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    advance(delta) {
      now += delta
      runDue()
    },
    pending: () => timers.size
  }
}

function deterministicRandom(values) {
  let index = 0
  return (size) => {
    if (index >= values.length) throw new Error('unexpected random call')
    const value = values[index++]
    if (typeof value === 'number') return b4a.alloc(size, value)
    if (!b4a.isBuffer(value) || value.byteLength !== size) throw new Error('bad random fixture')
    return b4a.from(value)
  }
}

function fixture(overrides = {}) {
  const authority = cryptoSuite.keyPair(seed(201))
  const initiator = cryptoSuite.keyPair(seed(202))
  const responder = safetyRoleIdentity(overrides.responderSeed ?? 203)
  const responderStatic = cryptoSuite.encryptionKeyPair(seed(204))
  const runId32 = seed(205)
  const epoch = overrides.epoch ?? 7n
  const grant = {
    version: PROTOCOL_VERSION,
    format: 0,
    grantId32: overrides.grantId32 || seed(206),
    endpointA: {
      identity32: initiator.publicKey,
      role: TOPOLOGY_ROLE.SOURCE,
      host: '127.0.0.1',
      port: 43001,
      operations: LINK_OPERATION.INITIATE
    },
    endpointB: {
      identity32: responder.publicKey,
      role: TOPOLOGY_ROLE.SAFETY_GUARD,
      host: '127.0.0.2',
      port: 43002,
      operations: LINK_OPERATION.ACCEPT
    },
    epoch,
    notBefore: 900n,
    expiresAt: 10_000n,
    runId32
  }
  const signedGrant = signTopologyGrant(grant, authority.secretKey)
  const clock = fakeClock()

  function directory(identity, role, operation, peerIdentity, peerRole) {
    const value = new LinkDirectory({
      localIdentity32: identity.publicKey,
      localRole: role,
      authorityPublicKey: authority.publicKey,
      epoch,
      runId32,
      now: () => BigInt(clock.now()),
      schedule: clock.schedule,
      cancel: clock.cancel,
      onClose() {}
    })
    const digest32 = value.add(signedGrant)
    const handle = value.authorize({
      digest32,
      operation,
      localIdentity32: identity.publicKey,
      localRole: role,
      peerIdentity32: peerIdentity.publicKey,
      peerRole,
      epoch,
      runId32
    })
    return { value, digest32, handle }
  }

  const left = directory(
    initiator,
    TOPOLOGY_ROLE.SOURCE,
    LINK_OPERATION.INITIATE,
    responder,
    TOPOLOGY_ROLE.SAFETY_GUARD
  )
  const right = directory(
    responder,
    TOPOLOGY_ROLE.SAFETY_GUARD,
    LINK_OPERATION.ACCEPT,
    initiator,
    TOPOLOGY_ROLE.SOURCE
  )
  const setup = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => clock.now(),
    randomBytes: deterministicRandom([seed(207), seed(208), seed(209), seed(210)])
  })
  const common = {
    circuitId: b4a.alloc(16, 0x21),
    epoch,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    initiatorLocalId: b4a.alloc(16, 0x22),
    responderLocalId: b4a.alloc(16, 0x23),
    expiresAt: 2_000n
  }
  const started = setup.initiate({
    ...common,
    responderStaticKey: responderStatic.publicKey,
    initiatorIdentitySecretKey: initiator.secretKey
  })
  const accepted = setup.respond(started.message, {
    ...common,
    responderStaticSecretKey: responderStatic.secretKey,
    responderIdentitySecretKey: responder.secretKey
  })
  const leftCodec = new BootstrapEnvelopeCodec({
    crypto: cryptoSuite,
    linkHandle: left.handle,
    localIdentitySecretKey: initiator.secretKey,
    padding: deterministicRandom([0xa5, 0xa6, 0xa7, 0xa8])
  })
  const rightCodec = new BootstrapEnvelopeCodec({
    crypto: cryptoSuite,
    linkHandle: right.handle,
    localIdentitySecretKey: responder.secretKey,
    padding: deterministicRandom([0xb5, 0xb6, 0xb7, 0xb8])
  })
  return {
    authority,
    initiator,
    responder,
    responderStatic,
    clock,
    left,
    right,
    setup,
    started,
    accepted,
    common,
    leftCodec,
    rightCodec,
    leftSource: { host: '127.0.0.1', port: 43001 },
    rightSource: { host: '127.0.0.2', port: 43002 }
  }
}

function writeU64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function resignEnvelope(packet, secretKey, mutate) {
  const signed = b4a.from(packet)
  mutate(signed)
  const digest = cryptoSuite.hash([DOMAIN.UDX_BOOTSTRAP, signed.subarray(0, 1136)])
  signed.set(cryptoSuite.sign(digest, secretKey), 1136)
  return signed
}

function alternateCreated(f, overrides) {
  const setup = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => f.clock.now(),
    randomBytes: deterministicRandom([seed(220), seed(221), seed(222), seed(223)])
  })
  const common = { ...f.common, ...overrides }
  const started = setup.initiate({
    ...common,
    responderStaticKey: f.responderStatic.publicKey,
    initiatorIdentitySecretKey: f.initiator.secretKey
  })
  return setup.respond(started.message, {
    ...common,
    responderStaticSecretKey: f.responderStatic.secretKey,
    responderIdentitySecretKey: f.responder.secretKey
  }).message
}

function encodeCreate(f, overrides = {}) {
  return f.leftCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATE,
    requestId: 0x0102_0304_0506_0708n,
    epoch: f.common.epoch,
    body: f.started.message,
    requestDigest32: ZERO_DIGEST,
    ...overrides
  })
}

function encodeCreated(f, request, overrides = {}) {
  return f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: 0x0102_0304_0506_0708n,
    epoch: f.common.epoch,
    body: f.accepted.message,
    requestPacket: request,
    ...overrides
  })
}

test('bootstrap protocol constants lock the fixed-size v0 wire class', (t) => {
  t.is(BOOTSTRAP_SIZE, 1200)
  t.is(BOOTSTRAP_MAX_BODY, 986)
  t.is(BOOTSTRAP_CLASS, 0x80)
  t.alike(BOOTSTRAP_TYPE, {
    LINK_CREATE: 0,
    LINK_CREATED: 1,
    LINK_REJECT: 2,
    LINK_CANCEL: 3
  })
  t.alike(BOOTSTRAP_REJECT_CODE, {
    UNAUTHORIZED: 0,
    CIRCUIT_LIMIT: 1,
    ROUTE_UNAVAILABLE: 2
  })
  t.ok(Object.isFrozen(BOOTSTRAP_TYPE))
  t.ok(Object.isFrozen(BOOTSTRAP_REJECT_CODE))
  t.is(b4a.toString(DOMAIN.UDX_BOOTSTRAP), 'hyperdht-private-routes/udx-bootstrap/v0')
})

test('LINK_CREATE locks every v0 offset and authenticates deterministic random padding', (t) => {
  const f = fixture()
  const packet = encodeCreate(f)

  t.is(packet.byteLength, BOOTSTRAP_SIZE)
  t.is(BOOTSTRAP_HEADER_SIZE, 150)
  t.is(BOOTSTRAP_SIGNATURE_SIZE, 64)
  t.is(packet[0], PROTOCOL_VERSION)
  t.is(packet[1], BOOTSTRAP_CLASS)
  t.is(packet[2], BOOTSTRAP_TYPE.LINK_CREATE)
  t.is(packet[3], 0)
  t.is(b4a.toString(packet.subarray(4, 12), 'hex'), '0102030405060708')
  t.is(b4a.toString(packet.subarray(12, 20), 'hex'), '0000000000000007')
  t.is(packet[20] * 256 + packet[21], 273)
  t.alike(packet.subarray(22, 54), f.initiator.publicKey)
  t.alike(packet.subarray(54, 86), f.responder.publicKey)
  t.alike(packet.subarray(86, 118), f.left.digest32)
  t.alike(packet.subarray(118, 150), ZERO_DIGEST)
  t.alike(packet.subarray(150, 423), f.started.message)
  t.alike(packet.subarray(423, 1136), b4a.alloc(713, 0xa5))

  const digest = cryptoSuite.hash([DOMAIN.UDX_BOOTSTRAP, packet.subarray(0, 1136)])
  t.ok(cryptoSuite.verify(digest, packet.subarray(1136), f.initiator.publicKey))
  t.is(
    b4a.toString(digest, 'hex'),
    '2f29d106a05dba9f525484cff23a4169fcc0bbfbe39c7484b08bb92c964728af'
  )
  t.is(
    b4a.toString(packet.subarray(1136), 'hex'),
    'cc97ef939d25ac57715f0ff67f8ea5a2bf5d9a55efe43ba69d61b7c3ffa9d55b82f3839889f82eb865991cb01883bec682988b567f045995d7b2d7ed3bda6d04'
  )

  const decoded = f.rightCodec.decode(packet, f.leftSource)
  t.is(decoded.type, BOOTSTRAP_TYPE.LINK_CREATE)
  t.is(decoded.requestId, 0x0102_0304_0506_0708n)
  t.is(decoded.epoch, 7n)
  t.alike(decoded.body, f.started.message)
  t.alike(decoded.requestDigest32, ZERO_DIGEST)
  t.alike(decoded.packetDigest32, cryptoSuite.hash(packet))
  t.alike(Object.keys(decoded), [
    'type',
    'requestId',
    'epoch',
    'senderIdentity32',
    'recipientIdentity32',
    'grantDigest32',
    'requestDigest32',
    'body',
    'packetDigest32'
  ])
})

test('all bootstrap response bodies are exact, correlated, reversed, and fixed-size', (t) => {
  const f = fixture()
  const request = encodeCreate(f)
  const requestDigest32 = cryptoSuite.hash(request)
  const created = encodeCreated(f, request)
  const decodedCreated = f.leftCodec.decode(created, f.rightSource)

  t.is(created.byteLength, request.byteLength)
  t.is(decodedCreated.type, BOOTSTRAP_TYPE.LINK_CREATED)
  t.alike(decodedCreated.senderIdentity32, f.responder.publicKey)
  t.alike(decodedCreated.recipientIdentity32, f.initiator.publicKey)
  t.alike(decodedCreated.grantDigest32, f.left.digest32)
  t.alike(decodedCreated.requestDigest32, requestDigest32)
  t.alike(decodedCreated.body, f.accepted.message)

  const reject = f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_REJECT,
    requestId: decodedCreated.requestId,
    epoch: decodedCreated.epoch,
    rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
    rejectCode: BOOTSTRAP_REJECT_CODE.CIRCUIT_LIMIT,
    requestPacket: request
  })
  const decodedReject = f.leftCodec.decode(reject, f.rightSource)
  t.is(reject.byteLength, BOOTSTRAP_SIZE)
  t.alike(decodedReject.body, b4a.from([BOOTSTRAP_TYPE.LINK_CREATE, 1]))
  t.is(decodedReject.rejectedType, undefined)

  const cancel = f.leftCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CANCEL,
    requestId: decodedCreated.requestId,
    epoch: decodedCreated.epoch,
    rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
    requestPacket: request
  })
  const decodedCancel = f.rightCodec.decode(cancel, f.leftSource)
  t.is(cancel.byteLength, BOOTSTRAP_SIZE)
  t.alike(decodedCancel.body, b4a.from([BOOTSTRAP_TYPE.LINK_CREATE]))

  for (const invalidCode of [-1, 3, 255, 'UNAUTHORIZED', { code: 0 }]) {
    expectCode(
      t,
      () =>
        f.rightCodec.encode({
          type: BOOTSTRAP_TYPE.LINK_REJECT,
          requestId: 1n,
          epoch: 7n,
          rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
          rejectCode: invalidCode,
          requestPacket: request
        }),
      'INVALID_ROUTE'
    )
  }
})

test('every authenticated byte, truncation, extension, source, grant, and class is fail-closed', (t) => {
  const f = fixture()
  const packet = encodeCreate(f)

  for (let offset = 0; offset < BOOTSTRAP_SIZE; offset++) {
    const mutated = b4a.from(packet)
    mutated[offset] ^= 1
    t.is(f.rightCodec.receive(mutated, f.leftSource), null, `mutation ${offset}`)
  }
  t.is(f.rightCodec.receive(packet.subarray(0, 1199), f.leftSource), null)
  t.is(f.rightCodec.receive(b4a.concat([packet, b4a.from([0])]), f.leftSource), null)
  t.is(f.rightCodec.receive(packet, { host: '127.0.0.9', port: 43001 }), null)
  t.is(f.rightCodec.receive(packet, { host: '127.0.0.1', port: 43009 }), null)

  const established = b4a.from(packet)
  established[1] = 0
  t.is(f.rightCodec.receive(established, f.leftSource), null)
  expectCode(t, () => f.rightCodec.decode(established, f.leftSource), 'INVALID_ROUTE')

  const fakeCell = b4a.alloc(1200)
  fakeCell[0] = 0
  fakeCell[1] = 0
  fakeCell[2] = 0
  t.is(f.rightCodec.receive(fakeCell, f.leftSource), null)
  const cellCodec = new CellCodec({ crypto: cryptoSuite, cellSize: 1200 })
  expectCode(t, () => cellCodec.open({}, packet), 'CELL_INVALID')
})

test('inner identities, epoch, request digest, type, flags, and canonical source are authoritative', (t) => {
  const f = fixture()
  const packet = encodeCreate(f)
  const digest = cryptoSuite.hash(packet)

  const invalidCreateBodies = [
    f.started.message.subarray(0, 272),
    b4a.concat([f.started.message, b4a.from([0])]),
    (() => {
      const body = b4a.from(f.started.message)
      body[17] ^= 1
      return body
    })(),
    (() => {
      const body = b4a.from(f.started.message)
      body[25] ^= 1
      return body
    })()
  ]
  for (const body of invalidCreateBodies) {
    expectCode(
      t,
      () =>
        f.leftCodec.encode({
          type: BOOTSTRAP_TYPE.LINK_CREATE,
          requestId: 9n,
          epoch: 7n,
          body,
          requestDigest32: ZERO_DIGEST
        }),
      'INVALID_ROUTE'
    )
  }

  for (const overrides of [
    { requestId: 0n },
    { requestDigest32: seed(1) },
    { type: 4 },
    { type: BOOTSTRAP_CLASS },
    { epoch: -1n },
    { epoch: 8n }
  ]) {
    expectCode(t, () => encodeCreate(f, overrides), 'INVALID_ROUTE')
  }

  const wrongRequest = b4a.from(packet)
  wrongRequest[400] ^= 1
  expectCode(t, () => encodeCreated(f, wrongRequest), 'UNAUTHORIZED')

  const changedFlags = b4a.from(packet)
  changedFlags[3] = 1
  t.is(f.rightCodec.receive(changedFlags, f.leftSource), null)
  t.is(f.rightCodec.receive(packet, { host: '127.000.0.1', port: 43001 }), null)
})

test('codec copies hostile and aliased inputs and sanitizes adapter/getter failures', (t) => {
  const f = fixture()
  const packet = encodeCreate(f)
  const decoded = f.rightCodec.decode(packet, f.leftSource)
  packet.fill(0)
  t.alike(decoded.body, f.started.message)

  const hostile = {}
  Object.defineProperty(hostile, 'type', {
    get() {
      throw new Error('secret callback details')
    }
  })
  expectCode(t, () => f.leftCodec.encode(hostile), 'INVALID_ROUTE')

  const throwingCrypto = new Proxy(cryptoSuite, {
    get(target, name) {
      if (name === 'sign')
        return () => {
          throw new Error('secret key dump')
        }
      return target[name]
    }
  })
  expectCode(
    t,
    () =>
      new BootstrapEnvelopeCodec({
        crypto: throwingCrypto,
        linkHandle: f.left.handle,
        localIdentitySecretKey: f.initiator.secretKey,
        padding: (size) => b4a.alloc(size)
      }),
    'INVALID_ROUTE'
  )

  const aliasBody = f.started.message.subarray(0)
  const aliasSnapshot = b4a.from(aliasBody)
  const encoded = encodeCreate(f, { body: aliasBody })
  aliasBody.fill(0)
  t.alike(f.rightCodec.decode(encoded, f.leftSource).body, aliasSnapshot)
})

function tableFixture(overrides = {}) {
  const clock = fakeClock()
  const observations = []
  const random = []
  for (let value = 1; value <= 64; value++) {
    const id = b4a.alloc(8)
    id[7] = value
    random.push(id)
  }
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    randomBytes: deterministicRandom(random),
    [TEST_ONLY_BOOTSTRAP_REQUEST_TABLE_OBSERVER](snapshot) {
      observations.push(snapshot)
    },
    ...overrides
  })
  return { clock, table, observations }
}

test('request table owns nonzero per-peer IDs, exact response correlation, and deadlines', (t) => {
  const f = fixture()
  const { table, clock, observations } = tableFixture()
  const responses = []
  const first = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode(requestId) {
      return encodeCreate(f, { requestId })
    },
    onResponse(packet, decoded) {
      responses.push({ packet, decoded })
    }
  })
  const second = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode(requestId) {
      return encodeCreate(f, { requestId })
    },
    onResponse() {}
  })
  t.is(first.requestId, 1n)
  t.is(second.requestId, 2n)
  t.not(first.token, second.token)
  t.is(first.packet.byteLength, BOOTSTRAP_SIZE)
  t.is(clock.pending(), 2)

  const created = f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: first.requestId,
    epoch: 7n,
    body: f.accepted.message,
    requestPacket: first.packet
  })
  const decoded = f.leftCodec.decode(created, f.rightSource)
  t.is(table.acceptResponse(f.responder.publicKey, decoded, created), true)
  t.is(responses.length, 1)
  t.alike(responses[0].packet, created)
  t.is(table.acceptResponse(f.responder.publicKey, decoded, created), false)

  const transferred = f.initiator.publicKey
  t.is(table.acceptResponse(transferred, decoded, created), false)
  clock.advance(5_000)
  t.is(clock.pending(), 1)
  t.is(observations.at(-1).pending, 0)
  t.is(observations.at(-1).tombstones, 1)
  clock.advance(5_000)
  t.is(clock.pending(), 0)
  table.destroy()
})

test('request table caches byte-identical responder replies and rejects ID/body substitution', (t) => {
  const f = fixture()
  const request = encodeCreate(f, { requestId: 11n })
  const decodedRequest = f.rightCodec.decode(request, f.leftSource)
  const { table } = tableFixture()
  let calls = 0
  const respond = () => {
    calls++
    const packet = f.rightCodec.encode({
      type: BOOTSTRAP_TYPE.LINK_REJECT,
      requestId: decodedRequest.requestId,
      epoch: decodedRequest.epoch,
      rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
      rejectCode: BOOTSTRAP_REJECT_CODE.ROUTE_UNAVAILABLE,
      requestPacket: request
    })
    return { packet, decoded: f.leftCodec.decode(packet, f.rightSource) }
  }
  const first = table.respond(f.initiator.publicKey, decodedRequest, request, respond)
  const duplicate = table.respond(f.initiator.publicKey, decodedRequest, request, respond)
  t.alike(duplicate, first)
  t.is(calls, 1)

  const changed = b4a.from(request)
  changed[500] ^= 1
  expectCode(
    t,
    () => table.respond(f.initiator.publicKey, decodedRequest, changed, respond),
    'REPLAY'
  )

  const cancel = f.leftCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CANCEL,
    requestId: decodedRequest.requestId,
    epoch: decodedRequest.epoch,
    rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
    requestPacket: request
  })
  const decodedCancel = f.rightCodec.decode(cancel, f.leftSource)
  t.is(table.acceptCancel(f.initiator.publicKey, decodedCancel), true)
  t.is(table.acceptCancel(f.initiator.publicKey, decodedCancel), false)
  table.destroy()
})

test('responder validates its own encoded reply without remote endpoint authority', (t) => {
  const f = fixture()
  const request = encodeCreate(f, { requestId: 12n })
  const decodedRequest = f.rightCodec.decode(request, f.leftSource)
  f.leftCodec.destroy()
  f.left.value.destroy()
  const { table } = tableFixture()

  const response = table.respond(f.initiator.publicKey, decodedRequest, request, () => ({
    packet: f.rightCodec.encode({
      type: BOOTSTRAP_TYPE.LINK_REJECT,
      requestId: 12n,
      epoch: 7n,
      rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
      rejectCode: BOOTSTRAP_REJECT_CODE.ROUTE_UNAVAILABLE,
      requestPacket: request
    })
  }))

  t.is(response.byteLength, BOOTSTRAP_SIZE)
  table.destroy()
})

test('request table is bounded, exception safe, cancel-safe, and releases all timers', (t) => {
  const f = fixture()
  const otherFixture = fixture({ responderSeed: 240, grantId32: seed(242) })
  const { table, clock, observations } = tableFixture({
    maxPending: 2,
    maxPendingPerPeer: 1,
    maxCache: 1,
    maxTombstones: 4
  })
  const begin = (peerFixture = f, overrides = {}) =>
    table.begin({
      peerIdentity32: peerFixture.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(peerFixture, { requestId }),
      onResponse() {},
      ...overrides
    })
  const first = begin()
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  const other = begin(otherFixture)
  expectCode(t, () => begin(fixture({ responderSeed: 250, grantId32: seed(252) })), 'CIRCUIT_LIMIT')
  t.is(table.cancel(first.token), true)
  t.is(table.cancel(first.token), false)
  t.is(table.cancel(other.token), true)

  expectCode(
    t,
    () =>
      begin(f, {
        encode() {
          throw new Error('secret')
        }
      }),
    'ROUTE_UNAVAILABLE'
  )
  expectCode(t, () => begin(f, { onResponse: null }), 'INVALID_ROUTE')
  t.is(observations.at(-1).pending, 0)
  table.destroy()
  t.is(clock.pending(), 0)
  t.alike(observations.at(-1), {
    pending: 0,
    cache: 0,
    tombstones: 0,
    timers: 0,
    destroyed: true,
    ownedBytes: 0,
    callbacks: 0
  })
  expectCode(t, () => begin(), 'CIRCUIT_STATE')
})

test('invalid unauthenticated input is a silent drop and cannot trigger amplification', (t) => {
  const f = fixture()
  let responses = 0
  const receive = (packet, source) => {
    const decoded = f.rightCodec.receive(packet, source)
    if (decoded === null) return null
    responses++
    return b4a.alloc(BOOTSTRAP_SIZE)
  }
  for (const packet of [b4a.alloc(0), b4a.alloc(1199), b4a.alloc(1200), b4a.alloc(1201)]) {
    t.is(receive(packet, f.leftSource), null)
  }
  t.is(responses, 0)
  const valid = encodeCreate(f)
  t.is(receive(valid, f.leftSource).byteLength, valid.byteLength)
  t.is(responses, 1)
})

test('codec destroy is idempotent, clears its owned signing key, and closes every operation', (t) => {
  const f = fixture()
  const allocations = []
  const originalAlloc = b4a.allocUnsafeSlow
  let codec
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    if (size === 64) allocations.push(value)
    return value
  }
  try {
    codec = new BootstrapEnvelopeCodec({
      crypto: cryptoSuite,
      linkHandle: f.left.handle,
      localIdentitySecretKey: f.initiator.secretKey,
      padding: (size) => b4a.alloc(size)
    })
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
  t.ok(allocations.length > 0)
  const ownedSecret = allocations.find((value) => b4a.equals(value, f.initiator.secretKey))
  t.ok(ownedSecret)
  codec.destroy()
  codec.destroy()
  t.alike(ownedSecret, b4a.alloc(ownedSecret.byteLength))
  expectCode(t, () => codec.decode(b4a.alloc(1200), f.leftSource), 'CIRCUIT_STATE')
  expectCode(t, () => encodeCreate({ ...f, leftCodec: codec }), 'CIRCUIT_STATE')
})

test('request IDs retry zero/collisions and clock/scheduler exceptions leave no authority', (t) => {
  const f = fixture()
  const clock = fakeClock()
  const randomBytes = deterministicRandom([
    b4a.alloc(8),
    b4a.from([0, 0, 0, 0, 0, 0, 0, 1]),
    b4a.from([0, 0, 0, 0, 0, 0, 0, 1]),
    b4a.from([0, 0, 0, 0, 0, 0, 0, 2])
  ])
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    randomBytes
  })
  const begin = () =>
    table.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {}
    })
  const first = begin()
  const second = begin()
  t.is(first.requestId, 1n)
  t.is(second.requestId, 2n)
  table.destroy()
  t.is(clock.pending(), 0)

  for (const overrides of [
    {
      now() {
        throw new Error('secret clock')
      }
    },
    {
      schedule() {
        throw new Error('secret scheduler')
      }
    }
  ]) {
    const broken = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 9]),
      ...overrides
    })
    expectCode(
      t,
      () =>
        broken.begin({
          peerIdentity32: f.responder.publicKey,
          epoch: 7n,
          encode: (requestId) => encodeCreate(f, { requestId }),
          onResponse() {}
        }),
      'ROUTE_UNAVAILABLE'
    )
    broken.destroy()
  }
})

test('monotonic deadlines reject late responses even when a scheduler never fires', (t) => {
  const f = fixture()
  const clock = fakeClock()
  let callbacks = 0
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: clock.now,
    schedule: () => Object.freeze({}),
    cancel() {},
    randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 3])
  })
  const pending = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {
      callbacks++
    }
  })
  const response = f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: pending.requestId,
    epoch: 7n,
    body: f.accepted.message,
    requestPacket: pending.packet
  })
  const decoded = f.leftCodec.decode(response, f.rightSource)
  clock.advance(5_001)
  t.is(table.acceptResponse(f.responder.publicKey, decoded, response), false)
  t.is(callbacks, 0)
  table.destroy()
})

test('bootstrap direction is constrained by the opaque bilateral grant operation', (t) => {
  const f = fixture()
  expectCode(
    t,
    () =>
      f.rightCodec.encode({
        type: BOOTSTRAP_TYPE.LINK_CREATE,
        requestId: 1n,
        epoch: 7n,
        body: f.started.message,
        requestDigest32: ZERO_DIGEST
      }),
    'UNAUTHORIZED'
  )

  const request = encodeCreate(f)
  const response = encodeCreated(f, request)
  t.ok(f.rightCodec.decode(request, f.leftSource))
  t.ok(f.leftCodec.decode(response, f.rightSource))
})

test('live tombstones reserve capacity and are never evicted before 5,000ms', (t) => {
  const f = fixture()
  const { table, clock } = tableFixture({
    maxPending: 2,
    maxPendingPerPeer: 2,
    maxCache: 1,
    maxTombstones: 1
  })
  const begin = () =>
    table.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {}
    })

  const first = begin()
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  t.is(table.cancel(first.token), true)
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  clock.advance(4_999)
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  clock.advance(1)
  const afterExpiry = begin()
  t.ok(afterExpiry)
  table.destroy()
})

test('request table accepts only opaque codec-verified provenance, never caller-shaped clones', (t) => {
  const f = fixture()
  const { table } = tableFixture()
  let callbacks = 0
  for (const forge of [
    (packet) => b4a.from(packet),
    (packet) => {
      packet[BOOTSTRAP_HEADER_SIZE] ^= 1
      return packet
    }
  ]) {
    expectCode(
      t,
      () =>
        table.begin({
          peerIdentity32: f.responder.publicKey,
          epoch: 7n,
          encode(requestId) {
            return forge(encodeCreate(f, { requestId }))
          },
          onResponse() {}
        }),
      'UNAUTHORIZED'
    )
  }
  const pending = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {
      callbacks++
    }
  })
  const response = f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: pending.requestId,
    epoch: 7n,
    body: f.accepted.message,
    requestPacket: pending.packet
  })
  const verified = f.leftCodec.decode(response, f.rightSource)
  const forged = { ...verified }

  expectCode(t, () => table.acceptResponse(f.responder.publicKey, forged, response), 'UNAUTHORIZED')
  t.is(callbacks, 0)
  t.is(table.acceptResponse(f.responder.publicKey, verified, response), true)
  t.is(callbacks, 1)
  table.destroy()
})

test('cancel exceptions remove token authority and clear late timer callbacks', (t) => {
  const f = fixture()
  const callbacks = []
  const scheduled = []
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: () => 1_000,
    schedule(callback) {
      scheduled.push(callback)
      return callback
    },
    cancel() {
      throw new Error('injected cancel failure')
    },
    randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 4])
  })
  const pending = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {
      callbacks.push('response')
    }
  })
  expectCode(t, () => table.cancel(pending.token), 'ROUTE_UNAVAILABLE')
  expectCode(t, () => table.cancel(pending.token), 'CIRCUIT_STATE')
  for (const callback of scheduled) callback()
  t.alike(callbacks, [])
  table.destroy()
})

test('codec cannot outlive revocation of its opaque LinkDirectory capability', (t) => {
  const f = fixture()
  const packet = encodeCreate(f)
  f.left.value.revoke({ digest32: f.left.digest32, epoch: 7n, runId32: seed(205) })

  expectCode(t, () => encodeCreate(f), 'UNAUTHORIZED')
  t.is(f.leftCodec.receive(packet, f.rightSource), null)
  f.leftCodec.destroy()
})

test('request table rejects signed LINK_CREATED with mismatched inner circuit, local IDs, or expiry', (t) => {
  const variants = [
    { circuitId: b4a.alloc(16, 0x31) },
    { initiatorLocalId: b4a.alloc(16, 0x32), responderLocalId: b4a.alloc(16, 0x33) },
    { expiresAt: 2_100n }
  ]

  for (const overrides of variants) {
    const f = fixture()
    const { table } = tableFixture()
    let callbacks = 0
    const pending = table.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {
        callbacks++
      }
    })
    const valid = f.rightCodec.encode({
      type: BOOTSTRAP_TYPE.LINK_CREATED,
      requestId: pending.requestId,
      epoch: 7n,
      body: f.accepted.message,
      requestPacket: pending.packet
    })
    const otherBody = alternateCreated(f, overrides)
    const substituted = resignEnvelope(valid, f.responder.secretKey, (packet) => {
      packet.set(otherBody, BOOTSTRAP_HEADER_SIZE)
    })
    const verified = f.leftCodec.decode(substituted, f.rightSource)

    expectCode(
      t,
      () => table.acceptResponse(f.responder.publicKey, verified, substituted),
      'INVALID_ROUTE'
    )
    t.is(callbacks, 0)
    table.destroy()
  }
})

test('request table rejects a valid branded response from a different bilateral grant', (t) => {
  const first = fixture({ grantId32: seed(230) })
  const second = fixture({ grantId32: seed(231) })
  const { table } = tableFixture()
  let callbacks = 0
  const pending = table.begin({
    peerIdentity32: first.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(first, { requestId }),
    onResponse() {
      callbacks++
    }
  })
  const otherRequest = encodeCreate(second, { requestId: pending.requestId })
  const otherResponse = second.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: pending.requestId,
    epoch: 7n,
    body: second.accepted.message,
    requestPacket: otherRequest
  })
  const substituted = resignEnvelope(otherResponse, second.responder.secretKey, (packet) => {
    packet.set(pending.digest32, 118)
  })
  const verified = second.leftCodec.decode(substituted, second.rightSource)

  expectCode(
    t,
    () => table.acceptResponse(first.responder.publicKey, verified, substituted),
    'UNAUTHORIZED'
  )
  t.is(callbacks, 0)
  table.destroy()
})

test('scheduler, monotonic clock, and completion callback faults permanently close the table', (t) => {
  const f = fixture()
  const begin = (table) =>
    table.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {}
    })

  {
    const table = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: () => 1_000,
      schedule(callback) {
        callback()
        return callback
      },
      cancel() {},
      randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 5])
    })
    expectCode(t, () => begin(table), 'ROUTE_UNAVAILABLE')
    expectCode(t, () => begin(table), 'CIRCUIT_STATE')
  }

  for (const values of [[1_000, 999], [Number.MAX_SAFE_INTEGER]]) {
    let index = 0
    const table = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: () => values[Math.min(index++, values.length - 1)],
      schedule: () => Object.freeze({}),
      cancel() {},
      randomBytes: deterministicRandom([
        b4a.from([0, 0, 0, 0, 0, 0, 0, 6]),
        b4a.from([0, 0, 0, 0, 0, 0, 0, 7])
      ])
    })
    if (values.length > 1) begin(table)
    expectCode(t, () => begin(table), 'ROUTE_UNAVAILABLE')
    expectCode(t, () => begin(table), 'CIRCUIT_STATE')
  }

  {
    const { table } = tableFixture()
    const pending = table.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {
        throw new Error('injected callback failure')
      }
    })
    const response = f.rightCodec.encode({
      type: BOOTSTRAP_TYPE.LINK_CREATED,
      requestId: pending.requestId,
      epoch: 7n,
      body: f.accepted.message,
      requestPacket: pending.packet
    })
    const verified = f.leftCodec.decode(response, f.rightSource)
    expectCode(
      t,
      () => table.acceptResponse(f.responder.publicKey, verified, response),
      'ROUTE_UNAVAILABLE'
    )
    expectCode(t, () => begin(table), 'CIRCUIT_STATE')
  }
})

test('an early timer callback rechecks the monotonic deadline instead of expiring authority', (t) => {
  const f = fixture()
  const callbacks = []
  const clock = fakeClock()
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: clock.now,
    schedule(callback) {
      callbacks.push(callback)
      return callback
    },
    cancel() {},
    randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 8])
  })
  const pending = table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {}
  })
  callbacks.shift()()
  const response = f.rightCodec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATED,
    requestId: pending.requestId,
    epoch: 7n,
    body: f.accepted.message,
    requestPacket: pending.packet
  })
  const verified = f.leftCodec.decode(response, f.rightSource)
  t.is(table.acceptResponse(f.responder.publicKey, verified, response), true)
  table.destroy()
})

test('expiry tombstone scheduling failure closes all request authority', (t) => {
  const f = fixture()
  const callbacks = []
  const owned = []
  let captured = null
  let responses = 0
  let current = 1_000
  let schedules = 0
  const table = new BootstrapRequestTable({
    crypto: cryptoSuite,
    now: () => current,
    schedule(callback) {
      if (++schedules === 2) throw new Error('injected tombstone scheduler failure')
      callbacks.push(callback)
      return callback
    },
    cancel() {},
    randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 9]),
    [TEST_ONLY_BOOTSTRAP_REQUEST_TABLE_OBSERVER](snapshot, record) {
      if (!record) return
      captured = record
      for (const value of [
        record.peerIdentity32,
        record.senderIdentity32,
        record.recipientIdentity32,
        record.grantDigest32,
        record.body,
        record.packet,
        record.digest32
      ]) {
        owned.push(value)
      }
    }
  })
  table.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {
      responses++
    }
  })
  current += BOOTSTRAP_DEADLINE
  callbacks.shift()()
  t.ok(captured)
  t.is(captured.callback, null)
  t.is(captured.packet, null)
  for (const value of owned) t.alike(value, b4a.alloc(value.byteLength))
  t.is(responses, 0)
  expectCode(
    t,
    () =>
      table.begin({
        peerIdentity32: f.responder.publicKey,
        epoch: 7n,
        encode: (requestId) => encodeCreate(f, { requestId }),
        onResponse() {}
      }),
    'CIRCUIT_STATE'
  )
})

test('responder cache and tombstone reservations enforce per-peer as well as global bounds', (t) => {
  const f = fixture()
  const { table } = tableFixture({
    maxPending: 2,
    maxPendingPerPeer: 2,
    maxCache: 2,
    maxCachePerPeer: 1,
    maxTombstones: 4,
    maxTombstonesPerPeer: 1
  })
  const respond = (requestId) => {
    const request = encodeCreate(f, { requestId })
    const decoded = f.rightCodec.decode(request, f.leftSource)
    return table.respond(f.initiator.publicKey, decoded, request, () => {
      const packet = f.rightCodec.encode({
        type: BOOTSTRAP_TYPE.LINK_REJECT,
        requestId,
        epoch: 7n,
        rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
        rejectCode: BOOTSTRAP_REJECT_CODE.ROUTE_UNAVAILABLE,
        requestPacket: request
      })
      return { packet, decoded: f.leftCodec.decode(packet, f.rightSource) }
    })
  }
  t.is(respond(31n).byteLength, BOOTSTRAP_SIZE)
  expectCode(t, () => respond(32n), 'CIRCUIT_LIMIT')
  table.destroy()

  const bounded = tableFixture({
    maxPending: 2,
    maxPendingPerPeer: 2,
    maxCache: 1,
    maxTombstones: 4,
    maxTombstonesPerPeer: 1
  }).table
  const begin = () =>
    bounded.begin({
      peerIdentity32: f.responder.publicKey,
      epoch: 7n,
      encode: (requestId) => encodeCreate(f, { requestId }),
      onResponse() {}
    })
  const pending = begin()
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  bounded.cancel(pending.token)
  expectCode(t, () => begin(), 'CIRCUIT_LIMIT')
  bounded.destroy()

  const nextEpoch = fixture({ epoch: 8n, grantId32: seed(253) })
  const crossEpoch = tableFixture({
    maxPending: 2,
    maxPendingPerPeer: 1,
    maxTombstones: 2
  }).table
  crossEpoch.begin({
    peerIdentity32: f.responder.publicKey,
    epoch: 7n,
    encode: (requestId) => encodeCreate(f, { requestId }),
    onResponse() {}
  })
  expectCode(
    t,
    () =>
      crossEpoch.begin({
        peerIdentity32: nextEpoch.responder.publicKey,
        epoch: 8n,
        encode: (requestId) => encodeCreate(nextEpoch, { requestId, epoch: 8n }),
        onResponse() {}
      }),
    'CIRCUIT_LIMIT'
  )
  crossEpoch.destroy()
})

test('controller callback reentrancy cannot bypass pending or responder cache bounds', (t) => {
  const f = fixture()

  {
    const { table } = tableFixture({ maxPending: 1, maxTombstones: 2 })
    let reentered = false
    const begin = () =>
      table.begin({
        peerIdentity32: f.responder.publicKey,
        epoch: 7n,
        encode(requestId) {
          if (!reentered) {
            reentered = true
            begin()
          }
          return encodeCreate(f, { requestId })
        },
        onResponse() {}
      })
    expectCode(t, begin, 'ROUTE_UNAVAILABLE')
    expectCode(t, begin, 'CIRCUIT_STATE')
  }

  {
    const { table } = tableFixture({ maxCache: 1, maxTombstones: 2 })
    const outerPacket = encodeCreate(f, { requestId: 61n })
    const innerPacket = encodeCreate(f, { requestId: 62n })
    const outer = f.rightCodec.decode(outerPacket, f.leftSource)
    const inner = f.rightCodec.decode(innerPacket, f.leftSource)
    const response = (requestId, requestPacket) => {
      const packet = f.rightCodec.encode({
        type: BOOTSTRAP_TYPE.LINK_REJECT,
        requestId,
        epoch: 7n,
        rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
        rejectCode: BOOTSTRAP_REJECT_CODE.ROUTE_UNAVAILABLE,
        requestPacket
      })
      return { packet, decoded: f.leftCodec.decode(packet, f.rightSource) }
    }
    expectCode(
      t,
      () =>
        table.respond(f.initiator.publicKey, outer, outerPacket, () => {
          table.respond(f.initiator.publicKey, inner, innerPacket, () => response(62n, innerPacket))
          return response(61n, outerPacket)
        }),
      'ROUTE_UNAVAILABLE'
    )
    expectCode(
      t,
      () => table.respond(f.initiator.publicKey, outer, outerPacket, () => null),
      'CIRCUIT_STATE'
    )
  }
})

test('random and timer adapters cannot reenter table mutation windows', (t) => {
  const f = fixture()

  {
    let table
    let reentered = false
    let nextId = 1
    const begin = () =>
      table.begin({
        peerIdentity32: f.responder.publicKey,
        epoch: 7n,
        encode: (requestId) => encodeCreate(f, { requestId }),
        onResponse() {}
      })
    table = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: () => 1_000,
      schedule: () => Object.freeze({}),
      cancel() {},
      randomBytes() {
        if (!reentered) {
          reentered = true
          begin()
        }
        const id = b4a.alloc(8)
        id[7] = nextId++
        return id
      },
      maxPending: 1,
      maxTombstones: 2
    })
    expectCode(t, begin, 'CIRCUIT_STATE')
    expectCode(t, begin, 'CIRCUIT_STATE')
  }

  {
    let table
    let reentered = false
    let nextId = 10
    const begin = () =>
      table.begin({
        peerIdentity32: f.responder.publicKey,
        epoch: 7n,
        encode: (requestId) => encodeCreate(f, { requestId }),
        onResponse() {}
      })
    table = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: () => 1_000,
      schedule: (callback) => callback,
      cancel() {
        if (reentered) return
        reentered = true
        begin()
      },
      randomBytes() {
        const id = b4a.alloc(8)
        id[7] = nextId++
        return id
      },
      maxPending: 1,
      maxTombstones: 1
    })
    const pending = begin()
    expectCode(t, () => table.cancel(pending.token), 'ROUTE_UNAVAILABLE')
    expectCode(t, begin, 'CIRCUIT_STATE')
  }

  {
    let table
    let attempted = false
    const begin = () =>
      table.begin({
        peerIdentity32: f.responder.publicKey,
        epoch: 7n,
        encode: (requestId) => encodeCreate(f, { requestId }),
        onResponse() {}
      })
    table = new BootstrapRequestTable({
      crypto: cryptoSuite,
      now: () => 1_000,
      schedule(callback) {
        if (!attempted) {
          attempted = true
          try {
            begin()
          } catch (err) {
            if (!(err instanceof PrivateRouteError) || err.code !== 'CIRCUIT_STATE') throw err
          }
        }
        return callback
      },
      cancel() {},
      randomBytes: () => b4a.from([0, 0, 0, 0, 0, 0, 0, 20])
    })
    expectCode(t, begin, 'ROUTE_UNAVAILABLE')
    expectCode(t, begin, 'CIRCUIT_STATE')
  }
})
