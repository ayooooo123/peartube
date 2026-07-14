import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  ACTOR_ERROR_CODE,
  ACTOR_CONTROL_KIND,
  CAPABILITY,
  CIRCUIT_DESTROY_REASON,
  CREATED_SIZE,
  ENTRY_PROOF_SIZE,
  PROTOCOL_VERSION,
  ROLE,
  ActorControlCodec,
  RemoteActorHost as PublicRemoteActorHost,
  activationChallengeCipher,
  buildPrivateTemplates,
  createPrivateDestinationActor,
  createPrivateRelayActor,
  cryptoSuite,
  destroyPrivateDestinationActor,
  destroyPrivateRelayActor,
  encodeActivationRequest,
  encodeCreate,
  encodeRelayAdvertisement,
  hashCreateBase,
  signRelayAdvertisement
} from '../index.js'
import * as publicApi from '../index.js'
import {
  RemoteControlFragmentCodec,
  RemoteControlMux,
  createRemoteActorControlBoundary
} from '../lib/remote-control.js'
import {
  createDestinationReplayCache,
  createRemoteActivationVerifier,
  createRemoteRegistrationVerifier
} from '../lib/activation.js'
import { DIRECTION } from '../lib/protocol.js'
import { expectCode, privateRoleIdentity, seed } from './helpers.js'

const REQUEST_ACTOR_KINDS = new Set([
  ACTOR_CONTROL_KIND.REGISTER_STAGE,
  ACTOR_CONTROL_KIND.REGISTER_PREPARE,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
  ACTOR_CONTROL_KIND.REGISTER_ABORT,
  ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
  ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
])
const TEST_ACTIVATION_CONTEXTS = new WeakMap()

// Same-process Task 6 harness: messages still traverse the real Task 5 mux and
// fragment reassembler, but the UDX cell/link handoff itself remains Task 7.
class RemoteActorHost extends PublicRemoteActorHost {
  #boundary
  #link
  #outerCircuitId
  #messageId = 1
  #mux = new RemoteControlMux()
  #sender

  constructor(options) {
    const link = Object.freeze({})
    const outerCircuitId = b4a.alloc(16, 0x7e)
    const boundary = createRemoteActorControlBoundary({
      link,
      epoch: 1n,
      circuitId: outerCircuitId,
      now: options.now
    })
    super({ ...options, control: boundary.consumer })
    this.#boundary = boundary
    this.#link = link
    this.#outerCircuitId = outerCircuitId
    this.#sender = new RemoteControlFragmentCodec({ now: options.now })
  }

  authenticate(message, overrides = {}) {
    const kind = message.byteLength > 1 ? message[1] : 0xff
    const context = {
      link: overrides.link || this.link,
      epoch: overrides.epoch === undefined ? 1n : overrides.epoch,
      direction:
        overrides.direction === undefined
          ? REQUEST_ACTOR_KINDS.has(kind)
            ? DIRECTION.FORWARD
            : DIRECTION.REVERSE
          : overrides.direction,
      circuitId: overrides.circuitId || this.#outerCircuitId
    }
    const messageId = b4a.alloc(16)
    let id = this.#messageId++
    for (let index = 15; index >= 12; index--) {
      messageId[index] = id & 0xff
      id = Math.floor(id / 256)
    }
    const frames = this.#sender.fragment(message, { messageId })
    let event = null
    try {
      for (const frame of frames) {
        const payload = this.#mux.encodeActorFragment(frame)
        try {
          event = this.#boundary.pushAuthenticated(payload, context)
        } finally {
          payload.fill(0)
        }
      }
      return event
    } finally {
      messageId.fill(0)
      for (const frame of frames) frame.fill(0)
    }
  }

  get link() {
    return this.#link
  }

  receiveAuthenticated(message, overrides) {
    try {
      return super.receiveAuthenticated(this.authenticate(message, overrides))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  receiveEvent(event) {
    return super.receiveAuthenticated(event)
  }

  failBoundary() {
    return this.#boundary.pushAuthenticated(b4a.from([0xff]), {
      link: this.#link,
      epoch: 1n,
      direction: DIRECTION.FORWARD,
      circuitId: this.#outerCircuitId
    })
  }

  destroyBoundary() {
    this.#boundary.destroy()
  }

  destroy() {
    super.destroy()
    this.#sender.destroy()
    this.#boundary.destroy()
  }
}

function activationOptions(body, circuitId, generation) {
  const context = TEST_ACTIVATION_CONTEXTS.get(body)
  if (!context) throw new Error('missing test activation context')
  try {
    return {
      activationVerifier: createRemoteActivationVerifier({
        ...context,
        request: body,
        circuitId,
        generation
      })
    }
  } finally {
    TEST_ACTIVATION_CONTEXTS.delete(body)
    context.sourceEphemeralSecretKey.fill(0)
    context.entryChallenge.fill(0)
    context.destinationChallenge.fill(0)
  }
}

function registrationOptions(fixture) {
  return {
    registrationVerifier: createRemoteRegistrationVerifier({
      request: fixture.built.registrationCapsule,
      registrations: fixture.built.registrations
    })
  }
}

function bytes(size, value) {
  return b4a.alloc(size, value)
}

function sequenceBytes(start = 1) {
  let value = start
  return (size) => {
    const output = b4a.alloc(size)
    for (let index = 0; index < size; index++) output[index] = value++ & 0xff
    return output
  }
}

function destinationActor(now = () => 0) {
  const identity = cryptoSuite.keyPair(bytes(32, 0x11))
  const route = cryptoSuite.encryptionKeyPair(bytes(32, 0x12))
  const actor = createPrivateDestinationActor({
    identity: identity.publicKey,
    identitySecretKey: identity.secretKey,
    routeSigningKey: identity.publicKey,
    routeSigningSecretKey: identity.secretKey,
    routeEncryptionSecretKey: route.secretKey,
    finalToken: bytes(64, 0x13),
    now,
    randomBytes: sequenceBytes(0x20)
  })
  identity.secretKey.fill(0)
  route.secretKey.fill(0)
  return actor
}

function registrationFixture(start = 1, actorNow = () => 1_000, observe = undefined) {
  const owner = cryptoSuite.keyPair(seed(start + 200))
  const descriptorId = seed(start + 201)
  const relayIdentity = privateRoleIdentity(start)
  const relayEncryption = cryptoSuite.encryptionKeyPair(seed(start + 80))
  const destinationEncryption = cryptoSuite.encryptionKeyPair(seed(start + 202))
  const finalToken = bytes(64, 0xfe)
  const advertisement = signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: relayIdentity.publicKey,
      routeEncryptionKey: relayEncryption.publicKey,
      dial: b4a.from(`remote-actor-${start}`),
      role: ROLE.PRIVATE,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n
    },
    relayIdentity.secretKey
  )
  const built = buildPrivateTemplates({
    descriptorId,
    epoch: 7n,
    expiresAt: 9_000n,
    endpointKey: owner.publicKey,
    routeSigningKey: owner.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.secretKey,
    relays: [encodeRelayAdvertisement(advertisement)],
    randomBytes: sequenceBytes(start + 10),
    finalToken,
    now: 1_000n
  })
  const destination = createPrivateDestinationActor({
    identity: owner.publicKey,
    identitySecretKey: owner.secretKey,
    routeSigningKey: owner.publicKey,
    routeSigningSecretKey: owner.secretKey,
    routeEncryptionSecretKey: destinationEncryption.secretKey,
    finalToken,
    now: () => 1_000,
    randomBytes: sequenceBytes(start + 40)
  })
  const relay = createPrivateRelayActor({
    identity: relayIdentity.publicKey,
    identitySecretKey: relayIdentity.secretKey,
    routeEncryptionSecretKey: relayEncryption.secretKey,
    destination,
    now: actorNow,
    randomBytes: sequenceBytes(start + 70),
    observe
  })
  return {
    built,
    relay,
    destination,
    activationRequest(circuitId) {
      const source = cryptoSuite.encryptionKeyPair(seed(start + 203))
      const entryChallenge = seed(start + 205)
      const destinationChallenge = seed(start + 206)
      const createValue = {
        version: PROTOCOL_VERSION,
        circuitId,
        epoch: 7n,
        descriptorId,
        sourceEphemeralKey: source.publicKey,
        safetyTranscriptHash: seed(start + 204),
        entryChallengeCipher: b4a.alloc(48),
        destinationChallengeCipher: b4a.alloc(48),
        encryptedHops: built.encryptedHops
      }
      const base = hashCreateBase(createValue)
      const entryShared = cryptoSuite.keyAgreement(source.secretKey, relayEncryption.publicKey)
      const destinationShared = cryptoSuite.keyAgreement(
        source.secretKey,
        destinationEncryption.publicKey
      )
      let create = null
      try {
        createValue.entryChallengeCipher = activationChallengeCipher(
          entryShared,
          base,
          entryChallenge,
          0
        )
        createValue.destinationChallengeCipher = activationChallengeCipher(
          destinationShared,
          base,
          destinationChallenge,
          1
        )
        create = encodeCreate(createValue)
        const request = encodeActivationRequest({
          entry: true,
          create,
          layer: b4a.alloc(0),
          expiresAt: 9_000n,
          startedAt: 1_000,
          parameters: {
            version: PROTOCOL_VERSION,
            cellSize: 1200,
            routeFrameSize: 1100,
            maxCellPayload: 1146,
            maxRoutePayload: 1073,
            capabilities: 7,
            safetyMin: 1,
            safetyMax: 3,
            privateMin: 1,
            privateMax: 3,
            counterWindow: 64
          },
          entryProof: b4a.alloc(0)
        })
        TEST_ACTIVATION_CONTEXTS.set(request, {
          entryIdentity: relayIdentity.publicKey,
          entryRouteEncryptionKey: relayEncryption.publicKey,
          endpointIdentity: owner.publicKey,
          routeSigningKey: owner.publicKey,
          destinationRouteEncryptionKey: destinationEncryption.publicKey,
          sourceEphemeralSecretKey: b4a.from(source.secretKey),
          entryChallenge: b4a.from(entryChallenge),
          destinationChallenge: b4a.from(destinationChallenge),
          replayCache: createDestinationReplayCache({ now: () => 1_000 }),
          now: () => 1_000
        })
        return request
      } finally {
        source.secretKey.fill(0)
        base.fill(0)
        entryShared.fill(0)
        destinationShared.fill(0)
        entryChallenge.fill(0)
        destinationChallenge.fill(0)
        createValue.entryChallengeCipher.fill(0)
        createValue.destinationChallengeCipher.fill(0)
        if (create) create.fill(0)
      }
    },
    destroy() {
      destroyPrivateRelayActor(relay)
      destroyPrivateDestinationActor(destination)
      owner.secretKey.fill(0)
      relayIdentity.secretKey.fill(0)
      relayEncryption.secretKey.fill(0)
      destinationEncryption.secretKey.fill(0)
      finalToken.fill(0)
    }
  }
}

function scheduler() {
  const records = new Set()
  return {
    records,
    schedule(delay, callback) {
      const record = { delay, callback }
      records.add(record)
      return record
    },
    cancel(record) {
      records.delete(record)
    }
  }
}

test('remote actor host registers an opaque capability and dispatches destroy bytes', async (t) => {
  const sent = []
  const timers = scheduler()
  const host = new RemoteActorHost({
    sendControl(message) {
      sent.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const actor = destinationActor()
  const actorId = bytes(16, 0x31)
  const handle = host.register(actorId, actor)

  t.alike(Object.keys(handle), [])
  t.is(Object.isFrozen(handle), true)
  t.is(handle.actor, undefined)
  t.is(handle.callback, undefined)
  t.is(handle.secret, undefined)
  t.is(handle.route, undefined)
  t.is(handle.address, undefined)

  const codec = new ActorControlCodec()
  const request = codec.encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 7n,
    actorId,
    circuitId: bytes(16, 0x32),
    generation: 1n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  })
  t.is(await host.receiveAuthenticated(request), true)
  t.is(sent.length, 1)
  const reply = codec.decode(sent[0])
  t.is(reply.kind, ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED)
  t.is(reply.requestId, 7n)
  t.alike(reply.body, b4a.alloc(0))

  host.destroy()
  destroyPrivateDestinationActor(actor)
  t.alike(host.stats, {
    actors: 0,
    pending: 0,
    inbound: 0,
    replay: 0,
    tombstones: 0,
    ownedBytes: 0,
    timers: 0,
    destroyed: true
  })
})

function hostPair({ now = () => 0, clientOptions = {}, serverOptions = {} } = {}) {
  const toClient = []
  const toServer = []
  const clientTimers = scheduler()
  const serverTimers = scheduler()
  const client = new RemoteActorHost({
    sendControl(message) {
      toServer.push(b4a.from(message))
      return true
    },
    now,
    randomBytes: sequenceBytes(1),
    schedule: clientTimers.schedule,
    cancel: clientTimers.cancel,
    ...clientOptions
  })
  const server = new RemoteActorHost({
    sendControl(message) {
      toClient.push(b4a.from(message))
      return true
    },
    now,
    randomBytes: sequenceBytes(40),
    schedule: serverTimers.schedule,
    cancel: serverTimers.cancel,
    ...serverOptions
  })
  return { client, server, clientTimers, serverTimers, toClient, toServer }
}

async function transfer(queue, target) {
  while (queue.length > 0) await target.receiveAuthenticated(queue.shift())
}

async function rejectionCode(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err && err.code
  }
}

test('request owns private copies and completes one exactly correlated reply', async (t) => {
  const pair = hostPair()
  const actor = destinationActor()
  const actorId = bytes(16, 0x41)
  const circuitId = bytes(16, 0x42)
  const body = b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  pair.server.register(actorId, actor)

  const resultPromise = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    actorId,
    circuitId,
    9n,
    body
  )
  actorId.fill(0)
  circuitId.fill(0)
  body.fill(0)
  t.is(pair.toServer.length, 1)
  t.not(pair.toServer[0][12], 0, 'queued bytes do not alias caller actor ID')
  t.is(pair.client.stats.pending, 1)
  t.is(pair.client.stats.timers, 1)

  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.alike(await resultPromise, b4a.alloc(0))
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.tombstones, 1)
  t.is(pair.client.stats.timers, 0)
  t.is(pair.server.stats.replay, 1)

  pair.client.destroy()
  pair.server.destroy()
  destroyPrivateDestinationActor(actor)
})

test('remote errors preserve only the allowlist and unknown actors are unavailable', async (t) => {
  const pair = hostPair()
  const actor = destinationActor()
  const actorId = bytes(16, 0x51)
  pair.server.register(actorId, actor)
  destroyPrivateDestinationActor(actor)

  const stateFailure = pair.client.request(
    ACTOR_CONTROL_KIND.REGISTER_STAGE,
    actorId,
    b4a.alloc(16),
    0n,
    b4a.from('invalid but privately owned')
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.is(await rejectionCode(stateFailure), 'INVALID_ROUTE')

  const missing = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x53),
    bytes(16, 0x54),
    2n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.is(await rejectionCode(missing), 'ROUTE_UNAVAILABLE')

  pair.client.destroy()
  pair.server.destroy()
})

test('malformed reply fails pending work closed as ROUTE_UNAVAILABLE', async (t) => {
  const pair = hostPair()
  const request = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x61),
    bytes(16, 0x62),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  const encodedRequest = new ActorControlCodec().decode(pair.toServer[0])
  const malformed = new ActorControlCodec().encode({
    ...encodedRequest,
    kind: ACTOR_CONTROL_KIND.ERROR,
    body: b4a.concat([bytes(1, ACTOR_ERROR_CODE.ROUTE_UNAVAILABLE), bytes(32, 0x63)])
  })
  malformed[54] = 0xff
  t.is(await rejectionCode(pair.client.receiveAuthenticated(malformed)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(request), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.destroyed, true)
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.ownedBytes, 0)
  pair.server.destroy()
})

test('duplicate inbound request IDs require the identical digest', async (t) => {
  const pair = hostPair()
  const codec = new ActorControlCodec()
  const base = {
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 88n,
    actorId: bytes(16, 0x71),
    circuitId: bytes(16, 0x72),
    generation: 1n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  }
  const first = codec.encode(base)
  t.is(await pair.server.receiveAuthenticated(first), true)
  t.is(await pair.server.receiveAuthenticated(first), true, 'same digest replays cached reply')
  const changed = codec.encode({
    ...base,
    body: b4a.from([CIRCUIT_DESTROY_REASON.EXPIRED])
  })
  t.is(await rejectionCode(pair.server.receiveAuthenticated(changed)), 'REPLAY')
  pair.client.destroy()
  pair.server.destroy()
})

test('queue refusal and deadline expiry leave no pending body or timer', async (t) => {
  const refusedTimers = scheduler()
  const refused = new RemoteActorHost({
    sendControl() {
      return false
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule: refusedTimers.schedule,
    cancel: refusedTimers.cancel
  })
  const input = b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  const refusal = refused.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x82),
    bytes(16, 0x83),
    1n,
    input
  )
  input.fill(0)
  t.is(await rejectionCode(refusal), 'ROUTE_UNAVAILABLE')
  t.is(refused.stats.pending, 0)
  t.is(refused.stats.ownedBytes, 0)
  t.is(refusedTimers.records.size, 0)
  refused.destroy()

  let now = 10
  const pair = hostPair({ now: () => now })
  const late = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x84),
    bytes(16, 0x85),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  const timer = Array.from(pair.clientTimers.records)[0]
  t.is(timer.delay, 5_000)
  now = 5_010
  timer.callback()
  t.is(await rejectionCode(late), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.tombstones, 1)
  t.is(pair.client.stats.ownedBytes > 0, true, 'only bounded tombstone correlation remains')

  await transfer(pair.toServer, pair.server)
  t.is(await pair.client.receiveAuthenticated(pair.toClient.shift()), true, 'late reply is inert')
  t.is(pair.client.stats.pending, 0)
  pair.client.destroy()
  pair.server.destroy()
})

test('actor, pending, replay, and tombstone bounds fail without eviction', async (t) => {
  const pair = hostPair({
    clientOptions: { maxPending: 1, maxTombstones: 1 },
    serverOptions: { maxActors: 1, maxReplay: 1 }
  })
  const actor = destinationActor()
  pair.server.register(bytes(16, 0x91), actor)
  expectCode(t, () => pair.server.register(bytes(16, 0x92), actor), 'CIRCUIT_LIMIT')

  const first = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x91),
    bytes(16, 0x93),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(
    await rejectionCode(
      pair.client.request(
        ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
        bytes(16, 0x91),
        bytes(16, 0x94),
        1n,
        b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
      )
    ),
    'CIRCUIT_LIMIT'
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.alike(await first, b4a.alloc(0))

  const second = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0x91),
    bytes(16, 0x95),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(await rejectionCode(second), 'CIRCUIT_LIMIT')
  t.is(pair.client.stats.tombstones, 1)
  t.is(pair.server.stats.replay, 1)

  pair.client.destroy()
  pair.server.destroy()
  destroyPrivateDestinationActor(actor)
})

test('every canonical actor command is byte-only and unknown actors map unavailable', async (t) => {
  const pair = hostPair()
  const fixture = registrationFixture(101)
  const secret = bytes(64, 0xa1)
  const route = [bytes(32, 0xa2), bytes(32, 0xa3)]
  const destinationAddress = b4a.from('203.0.113.7:49737')
  const operations = [
    ACTOR_CONTROL_KIND.REGISTER_STAGE,
    ACTOR_CONTROL_KIND.REGISTER_PREPARE,
    ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
    ACTOR_CONTROL_KIND.REGISTER_ABORT,
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
  ]
  for (const kind of operations) {
    const registration = kind <= ACTOR_CONTROL_KIND.REGISTER_ABORT
    const request = pair.client.request(
      kind,
      bytes(16, 0xa4),
      registration ? b4a.alloc(16) : bytes(16, 0xa5),
      registration ? 0n : 1n,
      kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
        ? b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
        : kind === ACTOR_CONTROL_KIND.REGISTER_STAGE
          ? fixture.built.registrationCapsule
          : b4a.from([kind]),
      kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? registrationOptions(fixture) : undefined
    )
    const wire = pair.toServer[0]
    t.is(wire.includes(secret), false)
    t.is(wire.includes(route[0]), false)
    t.is(wire.includes(route[1]), false)
    t.is(wire.includes(destinationAddress), false)
    await transfer(pair.toServer, pair.server)
    await transfer(pair.toClient, pair.client)
    t.is(await rejectionCode(request), 'ROUTE_UNAVAILABLE')
  }
  secret.fill(0)
  route[0].fill(0)
  route[1].fill(0)
  destinationAddress.fill(0)
  pair.client.destroy()
  pair.server.destroy()
  fixture.destroy()
})

test('relay adapter executes canonical stage, prepare, finalize, and abort bytes', async (t) => {
  const codec = new ActorControlCodec()
  for (const finalize of [true, false]) {
    const fixture = registrationFixture(finalize ? 2 : 20)
    const sent = []
    const timers = scheduler()
    const host = new RemoteActorHost({
      sendControl(message) {
        sent.push(b4a.from(message))
        return true
      },
      now: () => 1_000,
      randomBytes: sequenceBytes(1),
      schedule: timers.schedule,
      cancel: timers.cancel
    })
    const actorId = bytes(16, finalize ? 0xa6 : 0xa7)
    host.register(actorId, fixture.relay)
    const commands = finalize
      ? [
          [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
          [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
          [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
        ]
      : [
          [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
          [ACTOR_CONTROL_KIND.REGISTER_ABORT, fixture.built.abortCapsule]
        ]
    let requestId = 1n
    for (const [kind, body] of commands) {
      const request = codec.encode({
        version: 0,
        kind,
        flags: 0,
        requestId,
        actorId,
        circuitId: b4a.alloc(16),
        generation: 0n,
        body
      })
      t.is(await host.receiveAuthenticated(request), true)
      const reply = codec.decode(sent.pop())
      t.is(reply.kind, kind + 1)
      t.is(reply.requestId, requestId)
      t.is(reply.body.byteLength > 0, true)
      requestId++
    }
    host.destroy()
    fixture.destroy()
  }
})

test('wrong success correlation fails closed and clears the pending request', async (t) => {
  for (const change of [
    { requestId: 99n },
    { actorId: bytes(16, 0xb1) },
    { circuitId: bytes(16, 0xb2) },
    { generation: 2n },
    { kind: ACTOR_CONTROL_KIND.ACTIVATE_CREATED }
  ]) {
    const pair = hostPair()
    const pending = pair.client.request(
      ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
      bytes(16, 0xb3),
      bytes(16, 0xb4),
      1n,
      b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
    )
    const request = new ActorControlCodec().decode(pair.toServer[0])
    const malformed = new ActorControlCodec().encode({
      ...request,
      kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED,
      body: b4a.alloc(0),
      ...change
    })
    t.is(await rejectionCode(pair.client.receiveAuthenticated(malformed)), 'ROUTE_UNAVAILABLE')
    t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
    t.is(pair.client.stats.destroyed, true)
    t.is(pair.client.stats.ownedBytes, 0)
    pair.server.destroy()
  }
})

test('clock, scheduler, cancellation, and reentrancy faults fail exact-zero', async (t) => {
  const scheduleThrow = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      throw new Error('schedule')
    },
    cancel() {}
  })
  const scheduleFailure = scheduleThrow.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xc1),
    bytes(16, 0xc2),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(await rejectionCode(scheduleFailure), 'ROUTE_UNAVAILABLE')
  t.is(scheduleThrow.stats.destroyed, true)
  t.is(scheduleThrow.stats.ownedBytes, 0)

  let syncHost = null
  const liveSyncHandles = new Set()
  syncHost = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule(_delay, callback) {
      const handle = {}
      callback()
      liveSyncHandles.add(handle)
      return handle
    },
    cancel(handle) {
      liveSyncHandles.delete(handle)
    }
  })
  const syncFailure = syncHost.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xc3),
    bytes(16, 0xc4),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(await rejectionCode(syncFailure), 'ROUTE_UNAVAILABLE')
  t.is(syncHost.stats.destroyed, true)
  t.is(syncHost.stats.ownedBytes, 0)
  t.is(liveSyncHandles.size, 0)

  let cancelHost = null
  const outbound = []
  cancelHost = new RemoteActorHost({
    sendControl(message) {
      outbound.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {
      throw new Error('cancel')
    }
  })
  const cancelFailure = cancelHost.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xc5),
    bytes(16, 0xc6),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  const sent = new ActorControlCodec().decode(outbound[0])
  const reply = new ActorControlCodec().encode({
    ...sent,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED,
    body: b4a.alloc(0)
  })
  t.is(await rejectionCode(cancelHost.receiveAuthenticated(reply)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(cancelFailure), 'ROUTE_UNAVAILABLE')
  t.is(cancelHost.stats.destroyed, true)
  t.is(cancelHost.stats.ownedBytes, 0)

  let reentrant = null
  let reentry = null
  reentrant = new RemoteActorHost({
    sendControl(message) {
      reentry = reentrant.receiveAuthenticated(message)
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const reentrantFailure = reentrant.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xc7),
    bytes(16, 0xc8),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(await rejectionCode(reentry), 'CIRCUIT_STATE')
  t.is(await rejectionCode(reentrantFailure), 'ROUTE_UNAVAILABLE')
  t.is(reentrant.stats.destroyed, true)
  t.is(reentrant.stats.ownedBytes, 0)
})

test('clock, randomness, and cancellation callbacks cannot publish after reentry', async (t) => {
  for (const hook of ['clock', 'random']) {
    let host = null
    let reentry = null
    let armed = false
    const outbound = []
    host = new RemoteActorHost({
      sendControl(message) {
        outbound.push(b4a.from(message))
        return true
      },
      now() {
        if (hook === 'clock' && armed) {
          armed = false
          reentry = host.request(
            ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
            bytes(16, 0xca),
            bytes(16, 0xcb),
            1n,
            b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
          )
        }
        return 0
      },
      randomBytes(size) {
        if (hook === 'random' && armed) {
          armed = false
          reentry = host.request(
            ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
            bytes(16, 0xcc),
            bytes(16, 0xcd),
            1n,
            b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
          )
        }
        return bytes(size, 1)
      },
      schedule() {
        return 1
      },
      cancel() {}
    })
    armed = true
    const outer = host.request(
      ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
      bytes(16, 0xce),
      bytes(16, 0xcf),
      1n,
      b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
    )
    t.is(await rejectionCode(reentry), 'CIRCUIT_STATE', hook)
    t.is(await rejectionCode(outer), 'CIRCUIT_STATE', hook)
    t.is(host.stats.destroyed, true, hook)
    t.is(host.stats.ownedBytes, 0, hook)
    t.is(outbound.length, 0, hook)
  }

  let cancelHost = null
  const outbound = []
  cancelHost = new RemoteActorHost({
    sendControl(message) {
      outbound.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {
      cancelHost.destroy()
    }
  })
  const pending = cancelHost.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xda),
    bytes(16, 0xdb),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  const request = new ActorControlCodec().decode(outbound[0])
  const reply = new ActorControlCodec().encode({
    ...request,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED,
    body: b4a.alloc(0)
  })
  t.is(await rejectionCode(cancelHost.receiveAuthenticated(reply)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.alike(cancelHost.stats, {
    actors: 0,
    pending: 0,
    inbound: 0,
    replay: 0,
    tombstones: 0,
    ownedBytes: 0,
    timers: 0,
    destroyed: true
  })
})

test('abort cancellation removes the wait and zero request IDs stay unallowlisted', async (t) => {
  const pair = hostPair()
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(_name, listener) {
      listeners.add(listener)
    },
    removeEventListener(_name, listener) {
      listeners.delete(listener)
    }
  }
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xd1),
    bytes(16, 0xd2),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED]),
    { signal }
  )
  signal.aborted = true
  for (const listener of Array.from(listeners)) listener()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.tombstones, 1)
  t.is(listeners.size, 0)
  expectCode(
    t,
    () =>
      pair.client.notify(
        ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
        bytes(16, 0xd1),
        bytes(16, 0xd2),
        1n,
        b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
      ),
    'INVALID_ROUTE'
  )
  pair.client.destroy()
  pair.server.destroy()
})

test('buffer intrinsics ignore shadowed byteLength, set, and fill properties', async (t) => {
  const outbound = []
  const timers = scheduler()
  const host = new RemoteActorHost({
    sendControl(message) {
      outbound.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const actorId = bytes(16, 0xe1)
  const circuitId = bytes(16, 0xe2)
  const body = b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  for (const value of [actorId, circuitId, body]) {
    Object.defineProperties(value, {
      byteLength: {
        get() {
          throw new Error('shadowed byteLength')
        }
      },
      fill: {
        value() {
          throw new Error('shadowed fill')
        }
      },
      set: {
        value() {
          throw new Error('shadowed set')
        }
      }
    })
  }
  const pending = host.request(ACTOR_CONTROL_KIND.CIRCUIT_DESTROY, actorId, circuitId, 1n, body)
  t.is(outbound.length, 1)
  host.destroy()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(host.stats.ownedBytes, 0)
})

test('reply receipt enforces the monotonic deadline without relying on its timer', async (t) => {
  let now = 0
  const pair = hostPair({ now: () => now })
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xe3),
    bytes(16, 0xe4),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  const request = new ActorControlCodec().decode(pair.toServer[0])
  const reply = new ActorControlCodec().encode({
    ...request,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED,
    body: b4a.alloc(0)
  })
  now = 5_000
  t.is(await pair.client.receiveAuthenticated(reply), true, 'late reply only matches a tombstone')
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.tombstones, 1)
  pair.client.destroy()
  pair.server.destroy()
})

test('success replies require the canonical body for their exact operation', async (t) => {
  const pair = hostPair()
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.REGISTER_PREPARE,
    bytes(16, 0xe5),
    b4a.alloc(16),
    0n,
    bytes(64, 0xe6)
  )
  const request = new ActorControlCodec().decode(pair.toServer[0])
  const malformed = new ActorControlCodec().encode({
    ...request,
    kind: ACTOR_CONTROL_KIND.REGISTER_PREPARED,
    body: b4a.alloc(0)
  })
  t.is(await rejectionCode(pair.client.receiveAuthenticated(malformed)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.destroyed, true)
  pair.server.destroy()
})

test('outer actor commands bind the encrypted operation and activation circuit', async (t) => {
  const fixture = registrationFixture(31)
  const sent = []
  const timers = scheduler()
  const host = new RemoteActorHost({
    sendControl(message) {
      sent.push(b4a.from(message))
      return true
    },
    now: () => 1_000,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const codec = new ActorControlCodec()
  const actorId = bytes(16, 0xe7)
  host.register(actorId, fixture.relay)
  const command = async (kind, circuitId, generation, body, requestId) => {
    const request = codec.encode({
      version: 0,
      kind,
      flags: 0,
      requestId,
      actorId,
      circuitId,
      generation,
      body
    })
    t.is(await host.receiveAuthenticated(request), true)
    return codec.decode(sent.pop())
  }
  t.is(
    (
      await command(
        ACTOR_CONTROL_KIND.REGISTER_STAGE,
        b4a.alloc(16),
        0n,
        fixture.built.registrationCapsule,
        1n
      )
    ).kind,
    ACTOR_CONTROL_KIND.REGISTER_STAGED
  )
  t.is(
    (
      await command(
        ACTOR_CONTROL_KIND.REGISTER_PREPARE,
        b4a.alloc(16),
        0n,
        fixture.built.prepareCapsule,
        2n
      )
    ).kind,
    ACTOR_CONTROL_KIND.REGISTER_PREPARED
  )
  const wrongOperation = await command(
    ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
    b4a.alloc(16),
    0n,
    fixture.built.abortCapsule,
    3n
  )
  t.is(wrongOperation.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(wrongOperation.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)

  host.destroy()
  fixture.destroy()

  const activationFixture = registrationFixture(41)
  const activationSent = []
  const activationHost = new RemoteActorHost({
    sendControl(message) {
      activationSent.push(b4a.from(message))
      return true
    },
    now: () => 1_000,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const activationActorId = bytes(16, 0xe8)
  activationHost.register(activationActorId, activationFixture.relay)
  const activateCommand = async (kind, circuitId, generation, body, requestId) => {
    const request = codec.encode({
      version: 0,
      kind,
      flags: 0,
      requestId,
      actorId: activationActorId,
      circuitId,
      generation,
      body
    })
    t.is(await activationHost.receiveAuthenticated(request), true)
    return codec.decode(activationSent.pop())
  }
  await activateCommand(
    ACTOR_CONTROL_KIND.REGISTER_STAGE,
    b4a.alloc(16),
    0n,
    activationFixture.built.registrationCapsule,
    10n
  )
  await activateCommand(
    ACTOR_CONTROL_KIND.REGISTER_PREPARE,
    b4a.alloc(16),
    0n,
    activationFixture.built.prepareCapsule,
    11n
  )
  await activateCommand(
    ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
    b4a.alloc(16),
    0n,
    activationFixture.built.finalizeCapsule,
    12n
  )
  const innerCircuitId = bytes(16, 0xe9)
  const activation = activationFixture.activationRequest(innerCircuitId)
  const wrongCircuit = await activateCommand(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    bytes(16, 0xea),
    7n,
    activation,
    13n
  )
  t.is(wrongCircuit.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(wrongCircuit.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)
  activation.fill(0)
  activationHost.destroy()
  activationFixture.destroy()
})

test('relay activation returns the canonical authenticated CREATED proof', async (t) => {
  const events = []
  const fixture = registrationFixture(
    51,
    () => 1_000,
    (event) => events.push(event)
  )
  const pair = hostPair({ now: () => 1_000 })
  const actorId = bytes(16, 0xeb)
  pair.server.register(actorId, fixture.relay)
  for (const [kind, body] of [
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
  ]) {
    const pending = pair.client.request(
      kind,
      actorId,
      b4a.alloc(16),
      0n,
      body,
      kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? registrationOptions(fixture) : undefined
    )
    await transfer(pair.toServer, pair.server)
    await transfer(pair.toClient, pair.client)
    t.is((await pending).byteLength > 0, true)
  }
  const circuitId = bytes(16, 0xec)
  const body = fixture.activationRequest(circuitId)
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    actorId,
    circuitId,
    99n,
    body,
    activationOptions(body, circuitId, 99n)
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  const proof = await pending
  t.is(proof.byteLength, ENTRY_PROOF_SIZE + CREATED_SIZE)
  const mismatchedBody = fixture.activationRequest(bytes(16, 0xed))
  let mismatchCode = null
  try {
    activationOptions(mismatchedBody, circuitId, 99n)
  } catch (err) {
    mismatchCode = err && err.code
  }
  t.is(mismatchCode, 'UNAUTHORIZED')
  t.is(
    events.filter((event) => event.type === 'private-circuit-destroyed').length,
    0,
    'prevalidation cannot destroy the unrelated outer circuit'
  )
  const staleDestroy = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    actorId,
    circuitId,
    98n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.is(await rejectionCode(staleDestroy), 'UNAUTHORIZED')
  const destroy = pair.client.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    actorId,
    circuitId,
    99n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.alike(await destroy, b4a.alloc(0))
  proof.fill(0)
  body.fill(0)
  mismatchedBody.fill(0)
  pair.client.destroy()
  pair.server.destroy()
  fixture.destroy()
})

test('one host cannot alias an actor across independent generation maps', (t) => {
  const host = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const actor = destinationActor()
  host.register(bytes(16, 0xf6), actor)
  expectCode(t, () => host.register(bytes(16, 0xf7), actor), 'CIRCUIT_STATE')
  host.destroy()
  destroyPrivateDestinationActor(actor)
})

test('actor circuit ownership is global across hosts and foreign commands are inert', async (t) => {
  const events = []
  const fixture = registrationFixture(
    91,
    () => 1_000,
    (event) => events.push(event)
  )
  const timers = scheduler()
  const sentA = []
  const sentB = []
  const makeHost = (sent) =>
    new RemoteActorHost({
      sendControl(message) {
        sent.push(b4a.from(message))
        return true
      },
      now: () => 1_000,
      randomBytes: sequenceBytes(sent === sentA ? 1 : 40),
      schedule: timers.schedule,
      cancel: timers.cancel
    })
  const hostA = makeHost(sentA)
  const hostB = makeHost(sentB)
  const actorIdA = bytes(16, 0x91)
  const actorIdB = bytes(16, 0x92)
  const circuitId = bytes(16, 0x93)
  const codec = new ActorControlCodec()
  let requestId = 1n
  hostA.register(actorIdA, fixture.relay)
  hostB.register(actorIdB, fixture.relay)
  const command = async (host, sent, actorId, kind, body, generation = 0n) => {
    const request = codec.encode({
      version: 0,
      kind,
      flags: 0,
      requestId: requestId++,
      actorId,
      circuitId: kind < ACTOR_CONTROL_KIND.ACTIVATE_CREATE ? b4a.alloc(16) : circuitId,
      generation,
      body
    })
    t.is(await host.receiveAuthenticated(request), true)
    return codec.decode(sent.pop())
  }
  for (const [kind, body] of [
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
  ]) {
    const reply = await command(hostA, sentA, actorIdA, kind, body)
    t.is(reply.kind, kind + 1)
  }
  const activation = fixture.activationRequest(circuitId)
  const created = await command(
    hostA,
    sentA,
    actorIdA,
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    activation,
    7n
  )
  t.is(created.kind, ACTOR_CONTROL_KIND.ACTIVATE_CREATED)

  const foreignDestroy = await command(
    hostB,
    sentB,
    actorIdB,
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED]),
    7n
  )
  t.is(foreignDestroy.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(foreignDestroy.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)
  const foreignActivate = await command(
    hostB,
    sentB,
    actorIdB,
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    activation,
    7n
  )
  t.is(foreignActivate.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(foreignActivate.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)
  t.is(
    events.filter((event) => event.type === 'private-circuit-destroyed').length,
    0,
    'foreign host cannot tear down the owning host circuit'
  )

  const ownedDestroy = await command(
    hostA,
    sentA,
    actorIdA,
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED]),
    7n
  )
  t.is(ownedDestroy.kind, ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED)
  t.is(
    events.filter((event) => event.type === 'private-circuit-destroyed').length,
    1,
    'owner tears down exactly once'
  )
  const failedAdvance = await command(
    hostA,
    sentA,
    actorIdA,
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    activation,
    8n
  )
  t.is(failedAdvance.kind, ACTOR_CONTROL_KIND.ERROR)
  const staleOwner = await command(
    hostA,
    sentA,
    actorIdA,
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    activation,
    7n
  )
  t.is(staleOwner.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(staleOwner.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)
  const staleForeign = await command(
    hostB,
    sentB,
    actorIdB,
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    activation,
    7n
  )
  t.is(staleForeign.kind, ACTOR_CONTROL_KIND.ERROR)
  t.is(staleForeign.body[0], ACTOR_ERROR_CODE.UNAUTHORIZED)
  t.is(
    events.filter((event) => event.type === 'private-circuit-destroyed').length,
    1,
    'failed generation advance restores the prior tombstone without actor mutation'
  )
  activation.fill(0)
  hostA.destroy()
  hostB.destroy()
  fixture.destroy()
})

test('activation without an exact verifier fails locally before transmission', async (t) => {
  const pair = hostPair({ now: () => 1_000 })
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    bytes(16, 0xc1),
    bytes(16, 0xc2),
    1n,
    b4a.from('unverified activation')
  )
  t.is(await rejectionCode(pending), 'INVALID_ROUTE')
  t.is(pair.toServer.length, 0)
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.ownedBytes, 0)
  pair.client.destroy()
  pair.server.destroy()
})

test('failed verifier reuse cannot consume the owning activation verifier', async (t) => {
  const fixture = registrationFixture(98)
  const pair = hostPair({ now: () => 1_000 })
  const actorId = bytes(16, 0xc3)
  const circuitId = bytes(16, 0xc4)
  pair.server.register(actorId, fixture.relay)
  for (const [kind, body] of [
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
  ]) {
    const registration = pair.client.request(
      kind,
      actorId,
      b4a.alloc(16),
      0n,
      body,
      kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? registrationOptions(fixture) : undefined
    )
    await transfer(pair.toServer, pair.server)
    await transfer(pair.toClient, pair.client)
    await registration
  }
  const body = fixture.activationRequest(circuitId)
  const options = activationOptions(body, circuitId, 31n)
  const owning = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    actorId,
    circuitId,
    31n,
    body,
    options
  )
  const queued = pair.toServer.length
  const reuse = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    actorId,
    circuitId,
    32n,
    body,
    options
  )
  t.is(await rejectionCode(reuse), 'UNAUTHORIZED')
  t.is(pair.toServer.length, queued, 'failed reuse transmits nothing')
  await transfer(pair.toServer, pair.server)
  await transfer(pair.toClient, pair.client)
  t.is((await owning).byteLength, ENTRY_PROOF_SIZE + CREATED_SIZE)
  body.fill(0)
  pair.client.destroy()
  pair.server.destroy()
  fixture.destroy()
})

test('raw ActorControl bytes are not an authenticated host capability', async (t) => {
  t.is(publicApi.createRemoteActorControlBoundary, undefined)
  t.is(publicApi.readAuthenticatedRemoteActorEvent, undefined)
  t.is(publicApi.createRemoteActivationVerifier, undefined)
  const sent = []
  const timers = scheduler()
  const host = new RemoteActorHost({
    sendControl(message) {
      sent.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const actor = destinationActor()
  const actorId = bytes(16, 0x94)
  host.register(actorId, actor)
  const raw = new ActorControlCodec().encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId: bytes(16, 0x95),
    generation: 1n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  })
  t.is(await rejectionCode(host.receiveEvent(raw)), 'INVALID_ROUTE')
  t.is(await rejectionCode(host.receiveEvent(b4a.from(raw))), 'INVALID_ROUTE')
  t.is(sent.length, 0)
  host.destroy()
  destroyPrivateDestinationActor(actor)
})

test('authenticated actor context pins established link epoch direction and circuit', async (t) => {
  const actorId = bytes(16, 0x98)
  const circuitId = bytes(16, 0x99)
  const raw = new ActorControlCodec().encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId,
    generation: 4n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  })
  for (const [name, overrides] of [
    ['link', { link: Object.freeze({}) }],
    ['epoch', { epoch: 2n }],
    ['direction', { direction: DIRECTION.REVERSE }],
    ['circuit', { circuitId: bytes(16, 0x9a) }]
  ]) {
    const sent = []
    const host = new RemoteActorHost({
      sendControl(message) {
        sent.push(b4a.from(message))
        return true
      },
      now: () => 0,
      randomBytes: sequenceBytes(1),
      schedule() {
        return 1
      },
      cancel() {}
    })
    const actor = destinationActor()
    host.register(actorId, actor)
    t.is(await rejectionCode(host.receiveAuthenticated(raw, overrides)), 'INVALID_ROUTE', name)
    t.is(sent.length, 0, name)
    host.destroy()
    destroyPrivateDestinationActor(actor)
  }

  const host = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const event = host.authenticate(raw)
  t.is(await rejectionCode(host.receiveEvent({ ...event })), 'INVALID_ROUTE', 'plain event clone')
  host.destroy()
})

test('terminal control-boundary failure revokes retained events and clears exactly', async (t) => {
  const sent = []
  const host = new RemoteActorHost({
    sendControl(message) {
      sent.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const actor = destinationActor()
  const actorId = bytes(16, 0x9b)
  host.register(actorId, actor)
  const raw = new ActorControlCodec().encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId: bytes(16, 0x9c),
    generation: 1n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  })
  const retained = host.authenticate(raw)
  expectCode(t, () => host.failBoundary(), 'INVALID_ROUTE')
  t.is(await rejectionCode(host.receiveEvent(retained)), 'INVALID_ROUTE')
  t.is(sent.length, 0)
  host.destroyBoundary()
  host.destroyBoundary()
  host.destroy()
  t.alike(host.stats, {
    actors: 0,
    pending: 0,
    inbound: 0,
    replay: 0,
    tombstones: 0,
    ownedBytes: 0,
    timers: 0,
    destroyed: true
  })
  destroyPrivateDestinationActor(actor)

  const normal = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const normalEvent = normal.authenticate(raw)
  normal.destroyBoundary()
  normal.destroyBoundary()
  t.is(await rejectionCode(normal.receiveEvent(normalEvent)), 'INVALID_ROUTE')
  normal.destroy()
  t.is(normal.stats.ownedBytes, 0)
})

test('activation proof circuit signature descriptor and expiry tampering fail closed', async (t) => {
  const createdStart = ENTRY_PROOF_SIZE
  const cases = [
    ['circuit', createdStart + 1],
    ['descriptor', createdStart + 1 + 16 + 8],
    ['expiry', createdStart + 1 + 16 + 8 + 6 * 32],
    ['signature', ENTRY_PROOF_SIZE + CREATED_SIZE - 1]
  ]
  for (let index = 0; index < cases.length; index++) {
    const [name, offset] = cases[index]
    const fixture = registrationFixture(92 + index)
    const pair = hostPair({ now: () => 1_000 })
    const actorId = bytes(16, 0x96 + index)
    const circuitId = bytes(16, 0xa0 + index)
    pair.server.register(actorId, fixture.relay)
    for (const [kind, body] of [
      [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
      [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
      [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
    ]) {
      const registration = pair.client.request(
        kind,
        actorId,
        b4a.alloc(16),
        0n,
        body,
        kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? registrationOptions(fixture) : undefined
      )
      await transfer(pair.toServer, pair.server)
      await transfer(pair.toClient, pair.client)
      await registration
    }
    const body = fixture.activationRequest(circuitId)
    const pending = pair.client.request(
      ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
      actorId,
      circuitId,
      11n,
      body,
      activationOptions(body, circuitId, 11n)
    )
    await transfer(pair.toServer, pair.server)
    const codec = new ActorControlCodec()
    const reply = codec.decode(pair.toClient.shift())
    reply.body[offset] ^= 1
    const tampered = codec.encode(reply)
    t.is(await rejectionCode(pair.client.receiveAuthenticated(tampered)), 'ROUTE_UNAVAILABLE', name)
    t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE', name)
    t.is(pair.client.stats.ownedBytes, 0, name)
    body.fill(0)
    reply.actorId.fill(0)
    reply.circuitId.fill(0)
    reply.body.fill(0)
    tampered.fill(0)
    pair.client.destroy()
    pair.server.destroy()
    fixture.destroy()
  }
})

test('activation proof substitution across correlated requests fails closed', async (t) => {
  const fixture = registrationFixture(97)
  const pair = hostPair({ now: () => 1_000 })
  const actorId = bytes(16, 0xb0)
  pair.server.register(actorId, fixture.relay)
  for (const [kind, body] of [
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, fixture.built.registrationCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, fixture.built.prepareCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, fixture.built.finalizeCapsule]
  ]) {
    const registration = pair.client.request(
      kind,
      actorId,
      b4a.alloc(16),
      0n,
      body,
      kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? registrationOptions(fixture) : undefined
    )
    await transfer(pair.toServer, pair.server)
    await transfer(pair.toClient, pair.client)
    await registration
  }
  const circuitA = bytes(16, 0xb1)
  const circuitB = bytes(16, 0xb2)
  const bodyA = fixture.activationRequest(circuitA)
  const bodyB = fixture.activationRequest(circuitB)
  const pendingA = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    actorId,
    circuitA,
    21n,
    bodyA,
    activationOptions(bodyA, circuitA, 21n)
  )
  const pendingB = pair.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    actorId,
    circuitB,
    22n,
    bodyB,
    activationOptions(bodyB, circuitB, 22n)
  )
  await transfer(pair.toServer, pair.server)
  const codec = new ActorControlCodec()
  const replyA = codec.decode(pair.toClient.shift())
  const replyB = codec.decode(pair.toClient.shift())
  const substituted = codec.encode({ ...replyB, body: replyA.body })
  t.is(await rejectionCode(pair.client.receiveAuthenticated(substituted)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(pendingA), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(pendingB), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.ownedBytes, 0)
  for (const value of [bodyA, bodyB, replyA.actorId, replyA.circuitId, replyA.body]) value.fill(0)
  for (const value of [replyB.actorId, replyB.circuitId, replyB.body, substituted]) value.fill(0)
  pair.client.destroy()
  pair.server.destroy()
  fixture.destroy()
})

test('send refusal cancellation failure and signal reentry fail exact-zero', async (t) => {
  const refusal = new RemoteActorHost({
    sendControl() {
      return false
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {
      throw new Error('cancel')
    }
  })
  const rejected = refusal.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xed),
    bytes(16, 0xee),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(await rejectionCode(rejected), 'ROUTE_UNAVAILABLE')
  t.is(refusal.stats.destroyed, true)
  t.is(refusal.stats.ownedBytes, 0)

  let host = null
  const listeners = new Set()
  const signal = {
    get addEventListener() {
      host.destroy()
      return (_name, listener) => listeners.add(listener)
    },
    removeEventListener(_name, listener) {
      listeners.delete(listener)
    },
    aborted: false
  }
  host = new RemoteActorHost({
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 1
    },
    cancel() {}
  })
  const reentered = host.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xef),
    bytes(16, 0xf0),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED]),
    { signal }
  )
  t.is(await rejectionCode(reentered), 'ROUTE_UNAVAILABLE')
  t.is(listeners.size, 0)
  t.is(host.stats.ownedBytes, 0)
  t.is(host.stats.destroyed, true)
})

test('zero inbound request IDs are rejected before actor dispatch', async (t) => {
  const pair = hostPair()
  const actor = destinationActor()
  const actorId = bytes(16, 0xf1)
  pair.server.register(actorId, actor)
  const codec = new ActorControlCodec()
  const zero = codec.encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId: bytes(16, 0xf2),
    generation: 1n,
    body: b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  })
  zero.fill(0, 4, 12)
  t.is(await rejectionCode(pair.server.receiveAuthenticated(zero)), 'INVALID_ROUTE')
  t.is(pair.server.stats.replay, 0)
  pair.client.destroy()
  pair.server.destroy()
  destroyPrivateDestinationActor(actor)
})

test('late tombstoned success still requires its canonical body', async (t) => {
  let now = 0
  const pair = hostPair({ now: () => now })
  const pending = pair.client.request(
    ACTOR_CONTROL_KIND.REGISTER_PREPARE,
    bytes(16, 0xf3),
    b4a.alloc(16),
    0n,
    bytes(64, 0xf4)
  )
  const request = new ActorControlCodec().decode(pair.toServer[0])
  const malformed = new ActorControlCodec().encode({
    ...request,
    kind: ACTOR_CONTROL_KIND.REGISTER_PREPARED,
    body: b4a.alloc(0)
  })
  now = 5_000
  t.is(await rejectionCode(pair.client.receiveAuthenticated(malformed)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(pair.client.stats.destroyed, true)
  t.is(pair.client.stats.ownedBytes, 0)
  pair.server.destroy()
})

test('actor handler reentry cannot repopulate a destroyed host', async (t) => {
  let host = null
  let request = null
  let reentry = null
  let armed = false
  const fixture = registrationFixture(61, () => {
    if (armed) {
      armed = false
      reentry = host.receiveAuthenticated(request)
    }
    return 1_000
  })
  const sent = []
  const timers = scheduler()
  host = new RemoteActorHost({
    sendControl(message) {
      sent.push(b4a.from(message))
      return true
    },
    now: () => 1_000,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const actorId = bytes(16, 0xf5)
  host.register(actorId, fixture.relay)
  request = new ActorControlCodec().encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.REGISTER_STAGE,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId: b4a.alloc(16),
    generation: 0n,
    body: fixture.built.registrationCapsule
  })
  armed = true
  t.is(await rejectionCode(host.receiveAuthenticated(request)), 'ROUTE_UNAVAILABLE')
  t.is(await rejectionCode(reentry), 'CIRCUIT_STATE')
  t.alike(host.stats, {
    actors: 0,
    pending: 0,
    inbound: 0,
    replay: 0,
    tombstones: 0,
    ownedBytes: 0,
    timers: 0,
    destroyed: true
  })
  t.is(sent.length, 0)
  fixture.destroy()
})

test('register reentry through send and actor hooks fails the whole mutation exact-zero', async (t) => {
  for (const hook of ['send', 'actor']) {
    let host = null
    let nestedError = null
    let request = null
    let armed = false
    const timers = scheduler()
    const firstActor = destinationActor()
    const nestedActor = destinationActor()
    const fixture =
      hook === 'actor'
        ? registrationFixture(71, () => {
            if (armed) {
              armed = false
              try {
                host.register(bytes(16, 0xa9), nestedActor)
              } catch (err) {
                nestedError = err
              }
            }
            return 1_000
          })
        : null
    host = new RemoteActorHost({
      sendControl() {
        if (hook === 'send') {
          try {
            host.register(bytes(16, 0xaa), nestedActor)
          } catch (err) {
            nestedError = err
          }
        }
        return true
      },
      now: () => (hook === 'actor' ? 1_000 : 0),
      randomBytes: sequenceBytes(1),
      schedule: timers.schedule,
      cancel: timers.cancel
    })
    host.register(bytes(16, 0xab), hook === 'actor' ? fixture.relay : firstActor)
    let outer
    if (hook === 'send') {
      outer = host.request(
        ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
        bytes(16, 0xac),
        bytes(16, 0xad),
        1n,
        b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
      )
    } else {
      request = new ActorControlCodec().encode({
        version: 0,
        kind: ACTOR_CONTROL_KIND.REGISTER_STAGE,
        flags: 0,
        requestId: 1n,
        actorId: bytes(16, 0xab),
        circuitId: b4a.alloc(16),
        generation: 0n,
        body: fixture.built.registrationCapsule
      })
      armed = true
      outer = host.receiveAuthenticated(request)
    }
    if (!host.stats.destroyed) host.destroy()
    t.is(await rejectionCode(outer), 'ROUTE_UNAVAILABLE', hook)
    t.is(nestedError && nestedError.code, 'CIRCUIT_STATE', hook)
    t.alike(
      host.stats,
      {
        actors: 0,
        pending: 0,
        inbound: 0,
        replay: 0,
        tombstones: 0,
        ownedBytes: 0,
        timers: 0,
        destroyed: true
      },
      hook
    )
    t.is(timers.records.size, 0, hook)
    if (fixture) fixture.destroy()
    destroyPrivateDestinationActor(firstActor)
    destroyPrivateDestinationActor(nestedActor)
  }
})

test('nullish scheduler handles fail closed while zero remains a valid opaque handle', async (t) => {
  for (const handle of [undefined, null]) {
    const cancelled = []
    const actor = destinationActor()
    const host = new RemoteActorHost({
      sendControl() {
        return true
      },
      now: () => 0,
      randomBytes: sequenceBytes(1),
      schedule() {
        return handle
      },
      cancel(value) {
        cancelled.push(value)
      }
    })
    host.register(bytes(16, handle === null ? 0xae : 0xaf), actor)
    const pending = host.request(
      ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
      bytes(16, 0xb0),
      bytes(16, 0xb1),
      1n,
      b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
    )
    const failedClosed = host.stats.destroyed
    if (!failedClosed) host.destroy()
    t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
    t.is(failedClosed, true)
    t.is(cancelled.length, 1, 'best-effort cancellation runs for the rejected token')
    t.alike(host.stats, {
      actors: 0,
      pending: 0,
      inbound: 0,
      replay: 0,
      tombstones: 0,
      ownedBytes: 0,
      timers: 0,
      destroyed: true
    })
    destroyPrivateDestinationActor(actor)
  }

  const outbound = []
  const zero = new RemoteActorHost({
    sendControl(message) {
      outbound.push(b4a.from(message))
      return true
    },
    now: () => 0,
    randomBytes: sequenceBytes(1),
    schedule() {
      return 0
    },
    cancel() {}
  })
  const pending = zero.request(
    ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
    bytes(16, 0xb2),
    bytes(16, 0xb3),
    1n,
    b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
  )
  t.is(outbound.length, 1)
  zero.destroy()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
})
