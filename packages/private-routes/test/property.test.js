import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  CELL_SIZE,
  DIRECTION,
  MAX_CELL_PAYLOAD,
  MAX_FRAGMENT_DATA,
  PRIVACY_OPERATION,
  PRIVACY_PROVENANCE,
  PROTOCOL_VERSION,
  ROLE,
  CellCodec,
  DatagramReplayWindow,
  PrivateRouteError,
  Reassembler,
  RelayService,
  SenderCounter,
  PrivacyDomainRegistry,
  buildPrivateTemplates,
  createCircuitAuthority,
  createDiscoveryEvidenceAuthority,
  createLinkSetupAuthority,
  cryptoSuite,
  encodeRelayAdvertisement,
  fragment,
  signRelayAdvertisement
} from '../index.js'
import { TEST_ONLY_TICKET_OBSERVER } from '../lib/link-setup.js'
import {
  createXorshift32,
  descriptorChecker,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'

const BASE_SEED = 1
const GENERATED_CASES = 500
const CELL_KEY = seed(240)
const CELL_NONCE_PREFIX = b4a.alloc(16, 0xf1)
const CELL_CIRCUIT_ID = b4a.alloc(16, 0xf2)

function fail(message) {
  throw new Error(message)
}

function equal(actual, expected, message) {
  if (!b4a.equals(actual, expected)) fail(message)
}

function code(operation, expected) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  if (!(error instanceof PrivateRouteError) || error.code !== expected) {
    fail(`expected ${expected}, received ${error && error.code}`)
  }
}

function cellCodec() {
  return new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: (size) => b4a.alloc(size)
  })
}

function cellOptions(senderCounter, payload) {
  return {
    key: CELL_KEY,
    noncePrefix: CELL_NONCE_PREFIX,
    senderCounter,
    class: CELL_CLASS.DATAGRAM,
    direction: DIRECTION.FORWARD,
    epoch: 7n,
    circuitId: CELL_CIRCUIT_ID,
    payload
  }
}

function openCell(codec, receiver, packet) {
  return codec.open(
    {
      key: CELL_KEY,
      noncePrefix: CELL_NONCE_PREFIX,
      receiver,
      expectedClass: CELL_CLASS.DATAGRAM,
      expectedDirection: DIRECTION.FORWARD,
      expectedEpoch: 7n,
      expectedCircuitId: CELL_CIRCUIT_ID
    },
    packet
  )
}

function propertyCell(rng, index, operations) {
  const length = index % 17 === 0 ? MAX_CELL_PAYLOAD : rng.integer(MAX_CELL_PAYLOAD + 1)
  const payload = rng.bytes(length)
  const codec = cellCodec()
  const sender = new SenderCounter()
  const packet = codec.seal(cellOptions(sender, payload))
  operations.push({ type: 'cell', length })

  const receiver = new DatagramReplayWindow({ window: 64 })
  equal(openCell(codec, receiver, packet), payload, 'cell roundtrip changed payload')
  code(() => openCell(codec, receiver, packet), 'REPLAY')

  const mutated = b4a.from(packet)
  const byte = rng.integer(mutated.byteLength)
  const bit = 1 << rng.integer(8)
  mutated[byte] ^= bit
  operations.push({ type: 'mutate-cell', byte, bit })
  code(() => openCell(codec, new DatagramReplayWindow({ window: 64 }), mutated), 'CELL_INVALID')
}

function pushPermutation(receiver, frames, order) {
  let completed = null
  let completions = 0
  for (const index of order) {
    const value = receiver.pushAuthenticated(frames[index])
    if (value === null) continue
    completed = value
    completions++
  }
  return { completed, completions }
}

function propertyFragments(rng, index, operations) {
  const malformed = index % 6
  const messageId = rng.bytes(16)
  if (malformed === 0) {
    const length = rng.integer(MAX_FRAGMENT_DATA * 4 + 1)
    const message = rng.bytes(length)
    const frames = fragment(message, { messageId })
    const order = rng.shuffle(Array.from({ length: frames.length }, (_, frame) => frame))
    operations.push({ type: 'fragments-valid', length, order })
    const receiver = new Reassembler({ now: () => 0, epochExpiresAt: 100_000 })
    const result = pushPermutation(receiver, frames, order)
    if (result.completions !== 1) fail('valid fragments did not complete exactly once')
    equal(result.completed, message, 'fragment reassembly changed bytes')
    if (receiver.stats.messages !== 0 || receiver.stats.bufferedBytes !== 0) {
      fail('completed message retained buffered state')
    }
    code(() => receiver.pushAuthenticated(frames[0]), 'REPLAY')
    receiver.destroy()
    if (receiver.stats.messages !== 0 || receiver.stats.bufferedBytes !== 0) {
      fail('fragment teardown retained state')
    }
    return
  }

  const message = rng.bytes(MAX_FRAGMENT_DATA + 1)
  const frames = fragment(message, { messageId })
  const receiver = new Reassembler({
    now: () => 0,
    epochExpiresAt: 100_000,
    ...(malformed === 5 ? { maxMessageBytes: MAX_FRAGMENT_DATA } : {})
  })

  if (malformed === 1) {
    operations.push({ type: 'fragments-duplicate' })
    receiver.pushAuthenticated(frames[0])
    code(() => receiver.pushAuthenticated(b4a.from(frames[0])), 'REPLAY')
    equal(receiver.pushAuthenticated(frames[1]), message, 'duplicate damaged valid state')
  } else if (malformed === 2) {
    operations.push({ type: 'fragments-conflict' })
    receiver.pushAuthenticated(frames[0])
    const conflicting = b4a.from(frames[0])
    conflicting[20] ^= 1
    code(() => receiver.pushAuthenticated(conflicting), 'INVALID_ROUTE')
    if (receiver.stats.messages !== 0) fail('conflict retained affected message')
  } else if (malformed === 3) {
    operations.push({ type: 'fragments-out-of-range' })
    const outOfRange = b4a.from(frames[0])
    outOfRange[16] = outOfRange[18]
    outOfRange[17] = outOfRange[19]
    code(() => receiver.pushAuthenticated(outOfRange), 'INVALID_ROUTE')
    if (receiver.stats.messages !== 0) fail('out-of-range fragment retained state')
  } else if (malformed === 4) {
    operations.push({ type: 'fragments-inconsistent-total' })
    receiver.pushAuthenticated(frames[0])
    const inconsistent = b4a.from(frames[1])
    inconsistent[19]++
    code(() => receiver.pushAuthenticated(inconsistent), 'INVALID_ROUTE')
    if (receiver.stats.messages !== 0) fail('inconsistent total retained affected message')
  } else {
    operations.push({ type: 'fragments-over-limit' })
    code(() => receiver.pushAuthenticated(frames[0]), 'CIRCUIT_LIMIT')
    if (receiver.stats.messages !== 0) fail('over-limit fragment retained state')
  }

  if (receiver.stats.bufferedBytes > MAX_FRAGMENT_DATA * 2) {
    fail('fragment memory exceeded generated bound')
  }
  receiver.destroy()
  if (receiver.stats.messages !== 0 || receiver.stats.bufferedBytes !== 0) {
    fail('malformed fragment teardown retained state')
  }
}

function advertisedRelay(start, dial, role = ROLE.PRIVATE) {
  const identity = role === ROLE.PRIVATE ? privateRoleIdentity(start) : safetyRoleIdentity(start)
  const encryption = cryptoSuite.encryptionKeyPair(seed(start + 80))
  return encodeRelayAdvertisement(
    signRelayAdvertisement(
      {
        version: PROTOCOL_VERSION,
        identityKey: identity.publicKey,
        routeEncryptionKey: encryption.publicKey,
        dial: b4a.from(dial),
        role,
        capabilities: CAPABILITY.KNOWN,
        epoch: 7n,
        expiresAt: 10_000n
      },
      identity.secretKey
    )
  )
}

function pathFixture() {
  const owner = cryptoSuite.keyPair(seed(230))
  const good = [
    advertisedRelay(1, 'property-entry'),
    advertisedRelay(20, 'property-middle'),
    advertisedRelay(40, 'property-final'),
    advertisedRelay(60, 'property-fourth')
  ]
  const wrongRole = advertisedRelay(80, 'property-safety', ROLE.SAFETY)
  const unauthorized = b4a.from(good[0])
  unauthorized[unauthorized.byteLength - 1] ^= 1
  return {
    base: {
      descriptorId: seed(231),
      epoch: 7n,
      expiresAt: 9_000n,
      endpointKey: owner.publicKey,
      routeSigningKey: owner.publicKey,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      destinationSecretKey: owner.secretKey,
      randomBytes: (size) => b4a.alloc(size, 0xa5),
      finalToken: b4a.alloc(64, 0xa6),
      now: 1_000n
    },
    paths: [
      { name: 'valid', relays: good.slice(0, 3), code: null },
      { name: 'loop', relays: [good[0], good[0]], code: 'INVALID_ROUTE' },
      { name: 'wrong-role', relays: [wrongRole], code: 'INVALID_ROUTE' },
      { name: 'excessive-hops', relays: good, code: 'INVALID_ROUTE' },
      { name: 'forged-advertisement', relays: [unauthorized], code: 'UNAUTHORIZED' }
    ]
  }
}

function propertyPath(paths, index, operations) {
  const selected = paths.paths[index % paths.paths.length]
  operations.push({ type: 'path', fault: selected.name })
  let error = null
  let built = null
  try {
    built = buildPrivateTemplates({ ...paths.base, relays: selected.relays })
  } catch (err) {
    error = err
  }
  if (selected.code === null) {
    if (error !== null) fail(`valid generated path failed with ${error.code}`)
    if (!built || !b4a.isBuffer(built.encryptedHops) || built.registrations.length !== 3) {
      fail('valid generated path did not build exact relay state')
    }
    return
  }
  if (!(error instanceof PrivateRouteError) || error.code !== selected.code || built !== null) {
    fail(`path ${selected.name} expected ${selected.code}, received ${error && error.code}`)
  }
}

function propertyProvenance(index, operations) {
  const identity = index % 2 === 0 ? safetyRoleIdentity(100) : privateRoleIdentity(120)
  const evidenceAuthority = createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = createCircuitAuthority()
  const registry = new PrivacyDomainRegistry({
    evidenceChecker: evidenceAuthority.checker,
    descriptorChecker: descriptorChecker(),
    circuitChecker: circuitAuthority.checker,
    now: () => 100_000n
  })
  registry.learnRoute(identity.publicKey, {
    provenance: PRIVACY_PROVENANCE.PRIVATE_ONLY,
    epoch: 7n,
    expiresAt: 200_000n
  })
  operations.push({ type: 'private-only-provenance', role: index % 2 })
  if (
    !registry.allows(identity.publicKey, PRIVACY_OPERATION.ROUTE_FORWARD, {
      epoch: 7n
    })
  ) {
    fail('private-only provenance was not installed')
  }
  if (
    registry.allows(identity.publicKey, PRIVACY_OPERATION.GUARD_DIAL, {
      selectedGuard: true
    }) ||
    registry.allows(identity.publicKey, PRIVACY_OPERATION.PUBLIC_RETURN, {
      consumer: 'relay-discovery'
    }) ||
    registry.allows(identity.publicKey, PRIVACY_OPERATION.DIRECT_DIAL, {})
  ) {
    fail('private-only provenance authorized a public or direct open')
  }
}

function sequence(start) {
  let value = start
  return (size) => b4a.alloc(size, value++ & 0xff)
}

function link(authority, common, initiator, responder, responderStatic) {
  const started = authority.initiate({
    ...common,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    responderStaticKey: responderStatic.publicKey,
    initiatorIdentitySecretKey: initiator.secretKey
  })
  const accepted = authority.respond(started.message, {
    ...common,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    responderStaticSecretKey: responderStatic.secretKey,
    responderIdentitySecretKey: responder.secretKey
  })
  return {
    initiatorTicket: authority.complete(started.pending, accepted.message),
    responderTicket: accepted.ticket
  }
}

function relayFixture(index) {
  let now = 1_000
  const previous = cryptoSuite.keyPair(seed(201))
  const relayIdentity = cryptoSuite.keyPair(seed(202))
  const next = cryptoSuite.keyPair(seed(203))
  const relayStatic = cryptoSuite.encryptionKeyPair(seed(204))
  const nextStatic = cryptoSuite.encryptionKeyPair(seed(205))
  const ticketStates = new Map()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: sequence(index + 1),
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      ticketStates.set(ticket, state)
    }
  })
  const common = { circuitId: b4a.alloc(16, 0xc1), epoch: 7n, expiresAt: 10_000n }
  const previousIds = {
    initiatorLocalId: b4a.alloc(16, 0xc2),
    responderLocalId: b4a.alloc(16, 0xc3)
  }
  const nextIds = {
    initiatorLocalId: b4a.alloc(16, 0xc4),
    responderLocalId: b4a.alloc(16, 0xc5)
  }
  const previousLink = link(
    authority,
    { ...common, ...previousIds },
    previous,
    relayIdentity,
    relayStatic
  )
  const nextLink = link(authority, { ...common, ...nextIds }, relayIdentity, next, nextStatic)
  const relay = new RelayService({
    identity: relayIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: (size) => b4a.alloc(size),
    send: () => false
  })
  relay.install(previousLink.responderTicket, nextLink.initiatorTicket)
  const previousState = ticketStates.get(previousLink.initiatorTicket)
  const senderCodec = cellCodec()
  return {
    relay,
    previous,
    next,
    previousIds,
    nextIds,
    setNow(value) {
      now = value
    },
    seal(payload) {
      const context = previousState.contexts[CELL_CLASS.STREAM].tx
      return senderCodec.seal({
        key: context.key,
        noncePrefix: context.noncePrefix,
        senderCounter: context.counter,
        class: CELL_CLASS.STREAM,
        direction: DIRECTION.FORWARD,
        epoch: common.epoch,
        circuitId: previousState.peerLocalId,
        payload
      })
    }
  }
}

function propertyTeardown(rng, index, operations) {
  const fixture = relayFixture(index)
  const fault = rng.integer(4)
  operations.push({ type: 'relay-teardown', fault })
  fixture.relay.created(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
  fixture.relay.open(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
  fixture.relay.receive(fixture.previous.publicKey, fixture.seal(rng.bytes(1100)))
  if (fixture.relay.queuedBytes !== CELL_SIZE) fail('relay did not queue generated frame')

  if (fault === 0) {
    fixture.relay.destroy(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
  } else if (fault === 1) {
    fixture.relay.transportClosed(fixture.previous.publicKey)
  } else if (fault === 2) {
    fixture.setNow(10_000)
    fixture.relay.expire()
  } else {
    const corrupted = fixture.seal(rng.bytes(1100))
    corrupted[corrupted.byteLength - 1] ^= 1
    code(() => fixture.relay.receive(fixture.previous.publicKey, corrupted), 'CELL_INVALID')
  }

  if (fixture.relay.activeCircuits !== 0 || fixture.relay.queuedBytes !== 0) {
    fail('relay teardown retained circuits or queued bytes')
  }
  code(
    () => fixture.relay.state(fixture.previous.publicKey, fixture.previousIds.responderLocalId),
    'CIRCUIT_STATE'
  )
  code(
    () => fixture.relay.state(fixture.next.publicKey, fixture.nextIds.initiatorLocalId),
    'CIRCUIT_STATE'
  )
}

test('500 seeded protocol cases preserve exact bytes and fail closed with bounded cleanup', (t) => {
  const rng = createXorshift32(BASE_SEED)
  const paths = pathFixture()
  t.comment(`base seed=${BASE_SEED} generated cases=${GENERATED_CASES}`)

  for (let index = 0; index < GENERATED_CASES; index++) {
    const operations = []
    try {
      propertyCell(rng, index, operations)
      propertyFragments(rng, index, operations)
      propertyPath(paths, index, operations)
      propertyProvenance(index, operations)
      propertyTeardown(rng, index, operations)
      t.pass(`seed=${BASE_SEED} case=${index}`)
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err)
      throw new Error(
        `seed=${BASE_SEED} case=${index} operations=${JSON.stringify(operations)} failure=${details}`
      )
    }
  }
})
