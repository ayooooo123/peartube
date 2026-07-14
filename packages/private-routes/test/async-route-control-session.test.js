import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  ACTOR_CONTROL_KIND,
  ASYNC_CIRCUIT_STATE,
  ASYNC_REGISTRATION_STATE,
  CAPABILITY,
  PROTOCOL_VERSION,
  ROLE,
  AsyncRouteControlSession,
  CIRCUIT_DESTROY_REASON,
  PrivateRouteError,
  RemoteActorHost,
  activationChallengeCipher,
  buildPrivateTemplates,
  createDestinationReplayCache,
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
import {
  createRemoteActivationVerifier,
  destroyRemoteActivationVerifier,
  isRemoteActivationVerifier
} from '../lib/activation.js'
import {
  RemoteControlFragmentCodec,
  RemoteControlMux,
  createRemoteActorControlBoundary
} from '../lib/remote-control.js'
import { createRemoteActorHostTestDouble } from '../lib/remote-actor-host.js'
import { DIRECTION } from '../lib/protocol.js'
import { privateRoleIdentity, seed } from './helpers.js'

function bytes(size, value) {
  return b4a.alloc(size, value)
}

function sequenceBytes(start) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function controlledRemote(request) {
  return createRemoteActorHostTestDouble(request)
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
    },
    fireAll() {
      for (const record of Array.from(records)) {
        records.delete(record)
        record.callback()
      }
    }
  }
}

const REQUEST_KINDS = new Set([
  ACTOR_CONTROL_KIND.REGISTER_STAGE,
  ACTOR_CONTROL_KIND.REGISTER_PREPARE,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
  ACTOR_CONTROL_KIND.REGISTER_ABORT,
  ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
  ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
])

class AuthenticatedRemoteActorHost extends RemoteActorHost {
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

  receiveAuthenticated(message) {
    const kind = message.byteLength > 1 ? message[1] : 0xff
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
          event = this.#boundary.pushAuthenticated(payload, {
            link: this.#link,
            epoch: 1n,
            direction: REQUEST_KINDS.has(kind) ? DIRECTION.FORWARD : DIRECTION.REVERSE,
            circuitId: this.#outerCircuitId
          })
        } finally {
          payload.fill(0)
        }
      }
      return super.receiveAuthenticated(event)
    } catch (err) {
      return Promise.reject(err)
    } finally {
      messageId.fill(0)
      for (const frame of frames) frame.fill(0)
    }
  }

  destroy() {
    super.destroy()
    this.#sender.destroy()
    this.#boundary.destroy()
  }
}

function authenticatedPair(clock = { now: 1_000 }) {
  const toClient = []
  const toServer = []
  const clientTimers = scheduler()
  const serverTimers = scheduler()
  const common = {
    now: () => clock.now,
    randomBytes: sequenceBytes(1)
  }
  const client = new AuthenticatedRemoteActorHost({
    ...common,
    sendControl(message) {
      toServer.push(b4a.from(message))
      return true
    },
    schedule: clientTimers.schedule,
    cancel: clientTimers.cancel
  })
  const server = new AuthenticatedRemoteActorHost({
    ...common,
    sendControl(message) {
      toClient.push(b4a.from(message))
      return true
    },
    schedule: serverTimers.schedule,
    cancel: serverTimers.cancel
  })
  return { client, server, toClient, toServer, clientTimers, serverTimers, clock }
}

async function transferAuthenticated(queue, receiver) {
  while (queue.length) {
    const message = queue.shift()
    try {
      await receiver.receiveAuthenticated(message)
    } finally {
      message.fill(0)
    }
  }
}

async function settleAuthenticated(promise, pair) {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let attempt = 0; attempt < 64 && !settled; attempt++) {
    await transferAuthenticated(pair.toServer, pair.server)
    await transferAuthenticated(pair.toClient, pair.client)
    await Promise.resolve()
  }
  if (!settled) throw new Error('authenticated control operation did not settle')
  return promise
}

function remote() {
  const calls = []
  const host = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, actorId, circuitId, generation, body, options })
      return Promise.resolve(kind === 0 ? bytes(195, 1) : kind === 8 ? bytes(305, 2) : b4a.alloc(0))
    }
  )
  host.calls = calls
  return host
}

function activationFixture(
  start = 1,
  circuitId = bytes(16, start + 1),
  generation = 1n,
  runtime = {}
) {
  const now = runtime.now || (() => 1_000)
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
      dial: b4a.from(`async-route-${start}`),
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
    now,
    randomBytes: sequenceBytes(start + 40)
  })
  const relay = createPrivateRelayActor({
    identity: relayIdentity.publicKey,
    identitySecretKey: relayIdentity.secretKey,
    routeEncryptionSecretKey: relayEncryption.secretKey,
    destination,
    now,
    randomBytes: sequenceBytes(start + 70),
    ...(runtime.observe ? { observe: runtime.observe } : {})
  })
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
  createValue.entryChallengeCipher = activationChallengeCipher(entryShared, base, entryChallenge, 0)
  createValue.destinationChallengeCipher = activationChallengeCipher(
    destinationShared,
    base,
    destinationChallenge,
    1
  )
  const create = encodeCreate(createValue)
  const body = encodeActivationRequest({
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
  const verifier = createRemoteActivationVerifier({
    request: body,
    circuitId,
    generation,
    entryIdentity: relayIdentity.publicKey,
    entryRouteEncryptionKey: relayEncryption.publicKey,
    endpointIdentity: owner.publicKey,
    routeSigningKey: owner.publicKey,
    destinationRouteEncryptionKey: destinationEncryption.publicKey,
    sourceEphemeralSecretKey: source.secretKey,
    entryChallenge,
    destinationChallenge,
    replayCache: createDestinationReplayCache({ now }),
    now
  })
  for (const value of [
    owner.secretKey,
    relayIdentity.secretKey,
    relayEncryption.secretKey,
    destinationEncryption.secretKey,
    source.secretKey,
    entryChallenge,
    destinationChallenge,
    base,
    entryShared,
    destinationShared,
    create,
    createValue.entryChallengeCipher,
    createValue.destinationChallengeCipher,
    finalToken
  ])
    value.fill(0)
  return {
    body,
    circuitId,
    generation,
    verifier,
    built,
    relay,
    destroy() {
      destroyRemoteActivationVerifier(verifier)
      destroyPrivateRelayActor(relay)
      destroyPrivateDestinationActor(destination)
      body.fill(0)
    }
  }
}

async function rejectionCode(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err && err.code
  }
}

function session(peer, now = () => 1_000) {
  return new AsyncRouteControlSession({ remote: peer, actorId: bytes(16, 1), now })
}

function registration(seed = 2) {
  return {
    stage: bytes(64, seed),
    prepare: bytes(64, seed + 1),
    finalize: bytes(64, seed + 2),
    abort: bytes(64, seed + 3)
  }
}

function abortedSignal() {
  return {
    aborted: true,
    addEventListener() {},
    removeEventListener() {}
  }
}

function cancellableSignal() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort') listeners.add(listener)
    },
    removeEventListener(name, listener) {
      if (name === 'abort') listeners.delete(listener)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of Array.from(listeners)) listener()
      listeners.clear()
    }
  }
}

test('async registration follows the exact linear state table', async (t) => {
  const peer = remote()
  const session = new AsyncRouteControlSession({
    remote: peer,
    actorId: bytes(16, 1),
    now: () => 1_000
  })

  t.is(session.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  await session.register({
    stage: bytes(64, 2),
    prepare: bytes(64, 3),
    finalize: bytes(64, 4),
    abort: bytes(64, 5)
  })
  t.is(session.registrationState, ASYNC_REGISTRATION_STATE.FINALIZED)
  t.alike(
    peer.calls.map((call) => call.options.deadline),
    [6_000, 6_000, 6_000],
    'one absolute deadline is propagated through every request'
  )
  t.alike(session.stats, {
    waits: 0,
    timers: 0,
    ownedBytes: 0,
    registrationState: ASYNC_REGISTRATION_STATE.FINALIZED,
    circuitState: ASYNC_CIRCUIT_STATE.NEW,
    stopped: false
  })
})

test('plain request-shaped objects are not an authenticated remote boundary', (t) => {
  let failure = null
  try {
    new AsyncRouteControlSession({
      remote: { request() {} },
      actorId: bytes(16, 1),
      now: () => 1_000
    })
  } catch (err) {
    failure = err
  }
  t.is(failure && failure.code, 'INVALID_ROUTE')
})

test('monkey-patching a branded host cannot bypass genuine activation dispatch', async (t) => {
  const timers = scheduler()
  const host = new RemoteActorHost({
    control: {},
    sendControl() {
      return false
    },
    now: () => 1_000,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  host.request = () => Promise.resolve(bytes(305, 1))
  const control = session(host)
  const fixture = activationFixture(69)
  t.is(
    await rejectionCode(
      control.activate({
        body: fixture.body,
        circuitId: fixture.circuitId,
        generation: fixture.generation,
        activationVerifier: fixture.verifier
      })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
  t.is(host.stats.pending, 0)
  t.is(timers.records.size, 0)
  await control.stop()
  host.destroy()
  fixture.destroy()
})

test('session uses the branded host boundary and authenticated activation proof end to end', async (t) => {
  const pair = authenticatedPair()
  const fixture = activationFixture(71, bytes(16, 0x72), 9n)
  const actorId = bytes(16, 0x73)
  pair.server.register(actorId, fixture.relay)
  const control = new AsyncRouteControlSession({
    remote: pair.client,
    actorId,
    now: () => 1_000
  })

  const registered = await settleAuthenticated(
    control.register({
      stage: fixture.built.registrationCapsule,
      prepare: fixture.built.prepareCapsule,
      finalize: fixture.built.finalizeCapsule,
      abort: fixture.built.abortCapsule
    }),
    pair
  )
  t.is(registered.registered, true)
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.FINALIZED)
  registered.acknowledgements.fill(0)

  const proof = await settleAuthenticated(
    control.activate({
      body: fixture.body,
      circuitId: fixture.circuitId,
      generation: fixture.generation,
      activationVerifier: fixture.verifier
    }),
    pair
  )
  t.ok(proof.byteLength > 305, 'real host returned and verified entry plus destination proof')
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.OPEN)
  proof.fill(0)

  t.is(await settleAuthenticated(control.destroy(), pair), true)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  t.is(pair.client.stats.pending, 0)
  t.is(pair.client.stats.timers, 0)

  await control.stop()
  pair.client.destroy()
  pair.server.destroy()
  fixture.destroy()
  t.is(pair.clientTimers.records.size, 0)
  t.is(pair.serverTimers.records.size, 0)
})

test('real host registration replies dropped at or after the deadline stay tombstoned', async (t) => {
  const cases = [
    { name: 'stage', after: 0 },
    { name: 'prepare', after: 1 },
    { name: 'finalize', after: 0 }
  ]
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]
    const clock = { now: 1_000 }
    const pair = authenticatedPair(clock)
    const fixture = activationFixture(90 + index * 10)
    const actorId = bytes(16, 0x90 + index)
    pair.server.register(actorId, fixture.relay)
    const control = new AsyncRouteControlSession({
      remote: pair.client,
      actorId,
      now: () => clock.now
    })

    if (item.name !== 'stage') {
      const staged = await settleAuthenticated(
        control.stage(fixture.built.registrationCapsule, {
          abort: fixture.built.abortCapsule
        }),
        pair
      )
      staged.fill(0)
    }
    if (item.name === 'finalize') {
      await settleAuthenticated(control.prepare(fixture.built.prepareCapsule), pair)
    }

    const pending =
      item.name === 'stage'
        ? control.stage(fixture.built.registrationCapsule, {
            abort: fixture.built.abortCapsule
          })
        : item.name === 'prepare'
          ? control.prepare(fixture.built.prepareCapsule)
          : control.finalize(fixture.built.finalizeCapsule)
    await transferAuthenticated(pair.toServer, pair.server)
    t.is(pair.toClient.length, 1, `${item.name} has one authentic reply to drop`)
    const late = pair.toClient.shift()
    const duplicate = b4a.from(late)

    clock.now = 6_000 + item.after
    pair.clientTimers.fireAll()
    t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE', `${item.name} times out stably`)
    t.is(pair.client.stats.pending, 0, `${item.name} leaves no pending request`)
    t.is(pair.client.stats.timers, 0, `${item.name} leaves no timer`)
    t.is(
      control.registrationState,
      item.name === 'stage' ? ASYNC_REGISTRATION_STATE.NEW : ASYNC_REGISTRATION_STATE.ABORTING,
      `${item.name} never advances from a dropped reply`
    )

    await pair.client.receiveAuthenticated(late)
    await pair.client.receiveAuthenticated(duplicate)
    t.is(
      control.registrationState,
      item.name === 'stage' ? ASYNC_REGISTRATION_STATE.NEW : ASYNC_REGISTRATION_STATE.ABORTING,
      `${item.name} duplicate late replies are inert`
    )
    late.fill(0)
    duplicate.fill(0)

    await control.stop()
    pair.client.destroy()
    pair.server.destroy()
    fixture.destroy()
    t.is(control.stats.ownedBytes, 0, `${item.name} clears session bytes`)
    t.is(pair.client.stats.ownedBytes, 0, `${item.name} clears client host bytes`)
    t.is(pair.clientTimers.records.size, 0, `${item.name} clears client timers`)
    t.is(pair.serverTimers.records.size, 0, `${item.name} clears server timers`)
  }
})

test('real host activation and destroy replies cannot revive timed-out circuit state', async (t) => {
  for (const [index, name] of ['activate', 'destroy'].entries()) {
    const clock = { now: 1_000 }
    const pair = authenticatedPair(clock)
    const fixture = activationFixture(130 + index * 10)
    const actorId = bytes(16, 0xb0 + index)
    pair.server.register(actorId, fixture.relay)
    const control = new AsyncRouteControlSession({
      remote: pair.client,
      actorId,
      now: () => clock.now
    })
    const registered = await settleAuthenticated(
      control.register({
        stage: fixture.built.registrationCapsule,
        prepare: fixture.built.prepareCapsule,
        finalize: fixture.built.finalizeCapsule,
        abort: fixture.built.abortCapsule
      }),
      pair
    )
    registered.acknowledgements.fill(0)

    let pending
    if (name === 'activate') {
      pending = control.activate({
        body: fixture.body,
        circuitId: fixture.circuitId,
        generation: fixture.generation,
        activationVerifier: fixture.verifier
      })
    } else {
      const proof = await settleAuthenticated(
        control.activate({
          body: fixture.body,
          circuitId: fixture.circuitId,
          generation: fixture.generation,
          activationVerifier: fixture.verifier
        }),
        pair
      )
      proof.fill(0)
      pending = control.destroy()
    }
    await transferAuthenticated(pair.toServer, pair.server)
    t.is(pair.toClient.length, 1, `${name} has one authentic reply to drop`)
    const late = pair.toClient.shift()
    const duplicate = b4a.from(late)

    clock.now = 6_000 + index
    pair.clientTimers.fireAll()
    t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE', `${name} times out stably`)
    t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
    t.is(pair.client.stats.pending, 0, `${name} leaves no pending request`)
    t.is(pair.client.stats.timers, 0, `${name} leaves no timer`)

    await pair.client.receiveAuthenticated(late)
    await pair.client.receiveAuthenticated(duplicate)
    t.is(
      control.circuitState,
      ASYNC_CIRCUIT_STATE.DESTROYING,
      `${name} duplicate late replies cannot reopen or destroy local state`
    )
    late.fill(0)
    duplicate.fill(0)

    await control.stop()
    pair.client.destroy()
    pair.server.destroy()
    fixture.destroy()
    t.is(control.stats.ownedBytes, 0, `${name} clears session bytes`)
    t.is(pair.client.stats.ownedBytes, 0, `${name} clears client host bytes`)
    t.is(pair.clientTimers.records.size, 0, `${name} clears client timers`)
    t.is(pair.serverTimers.records.size, 0, `${name} clears server timers`)
  }
})

test('real host queue refusal fails before ownership escapes and leaves zero resources', async (t) => {
  const timers = scheduler()
  const host = new AuthenticatedRemoteActorHost({
    sendControl() {
      return false
    },
    now: () => 1_000,
    randomBytes: sequenceBytes(1),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const fixture = activationFixture(160)
  const control = new AsyncRouteControlSession({
    remote: host,
    actorId: bytes(16, 0xc1),
    now: () => 1_000
  })
  t.is(
    await rejectionCode(
      control.stage(fixture.built.registrationCapsule, {
        abort: fixture.built.abortCapsule
      })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(host.stats.pending, 0)
  t.is(host.stats.timers, 0)
  t.is(timers.records.size, 0)
  await control.stop()
  host.destroy()
  fixture.destroy()
  t.is(control.stats.ownedBytes, 0)
  t.is(host.stats.ownedBytes, 0)
})

test('real actor expiry is the final backstop for a staged request whose reply was lost', async (t) => {
  const clock = { now: 1_000 }
  const observed = []
  const pair = authenticatedPair(clock)
  const fixture = activationFixture(170, undefined, 1n, {
    now: () => clock.now,
    observe(event) {
      observed.push(event)
    }
  })
  const actorId = bytes(16, 0xd1)
  pair.server.register(actorId, fixture.relay)
  const control = new AsyncRouteControlSession({
    remote: pair.client,
    actorId,
    now: () => clock.now
  })
  const pending = control.stage(fixture.built.registrationCapsule, {
    abort: fixture.built.abortCapsule
  })
  await transferAuthenticated(pair.toServer, pair.server)
  t.is(pair.toClient.length, 1)
  clock.now = 6_000
  pair.clientTimers.fireAll()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')

  clock.now = 9_000
  pair.server.destroy()
  fixture.destroy()
  const destroying = observed.find((event) => event.type === 'private-relay-destroying')
  t.is(destroying && destroying.records, 0, 'expiry prunes the orphaned staged registration')

  for (const message of pair.toClient) message.fill(0)
  pair.toClient.length = 0
  await control.stop()
  pair.client.destroy()
  t.is(pair.clientTimers.records.size, 0)
  t.is(pair.serverTimers.records.size, 0)
  t.is(control.stats.ownedBytes, 0)
})

test('registration abort is allowed only from staged or prepared and repeats idempotently', async (t) => {
  const first = session(remote())
  t.is(await rejectionCode(first.abort(bytes(64, 1))), 'CIRCUIT_STATE')

  const staged = session(remote())
  await staged.stage(bytes(64, 2), { abort: bytes(64, 3) })
  t.is(staged.registrationState, ASYNC_REGISTRATION_STATE.STAGED)
  t.is(await staged.abort(), true)
  t.is(staged.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(await staged.abort(), true)

  const prepared = session(remote())
  await prepared.stage(bytes(64, 4), { abort: bytes(64, 5) })
  await prepared.prepare(bytes(64, 6))
  t.is(prepared.registrationState, ASYNC_REGISTRATION_STATE.PREPARED)
  t.is(await prepared.abort(), true)
  t.is(prepared.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)

  t.is(await rejectionCode(prepared.prepare(bytes(64, 7))), 'CIRCUIT_STATE')
})

test('concurrent repeated abort joins the one in-flight cleanup', async (t) => {
  let resolveAbort = null
  let abortCalls = 0
  const peer = controlledRemote(function request(kind) {
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
    if (kind === ACTOR_CONTROL_KIND.REGISTER_ABORT) {
      abortCalls++
      return new Promise((resolve) => {
        resolveAbort = resolve
      })
    }
    return Promise.resolve(b4a.alloc(0))
  })
  const control = session(peer)
  await control.stage(bytes(64, 1), { abort: bytes(64, 2) })
  const first = control.abort()
  const second = control.abort()
  t.is(abortCalls, 1)
  resolveAbort(b4a.alloc(0))
  t.is(await first, true)
  t.is(await second, true)
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
})

test('finalized registration expires or revokes once without skipped transitions', async (t) => {
  const expired = session(remote())
  await expired.register(registration())
  t.is(await expired.expire(), true)
  t.is(expired.registrationState, ASYNC_REGISTRATION_STATE.EXPIRED)
  t.is(await rejectionCode(expired.expire()), 'CIRCUIT_STATE')

  const revoked = session(remote())
  await revoked.register(registration(10))
  t.is(await revoked.revoke(), true)
  t.is(revoked.registrationState, ASYNC_REGISTRATION_STATE.REVOKED)
  t.is(await rejectionCode(revoked.revoke()), 'CIRCUIT_STATE')
})

test('activation opens only after reply and destroy is the sole idempotent repeat', async (t) => {
  const peer = remote()
  const control = session(peer)
  const activation = activationFixture(21, bytes(16, 10), 3n)
  const proof = await control.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.OPEN)
  t.is(proof.byteLength, 305)
  t.is(
    await control.destroy(CIRCUIT_DESTROY_REASON.REQUESTED),
    true,
    'authenticated destroy reply closes the local circuit'
  )
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  t.is(await control.destroy(), true)
  t.is(await rejectionCode(control.activate({})), 'CIRCUIT_STATE')
  t.alike(
    peer.calls.map((call) => call.kind),
    [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.CIRCUIT_DESTROY]
  )
  proof.fill(0)
  activation.destroy()
})

test('concurrent destroy and expiry join the one in-flight circuit cleanup', async (t) => {
  let resolveDestroy = null
  let destroyCalls = 0
  const peer = controlledRemote(function request(kind) {
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
    if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) return Promise.resolve(bytes(305, 2))
    if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY) {
      destroyCalls++
      return new Promise((resolve) => {
        resolveDestroy = resolve
      })
    }
    return Promise.resolve(b4a.alloc(0))
  })
  const control = session(peer)
  await control.register(registration())
  const activation = activationFixture(43)
  const proof = await control.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  proof.fill(0)
  const first = control.destroy()
  const repeated = control.destroy()
  const expiring = control.expire()
  t.is(destroyCalls, 1)
  resolveDestroy(b4a.alloc(0))
  t.is(await first, true)
  t.is(await repeated, true)
  t.is(await expiring, true)
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.EXPIRED)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  activation.destroy()
})

test('one deadline covers registration and a failed partial transaction attempts remote abort', async (t) => {
  const calls = []
  const peer = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, options })
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
      if (kind === ACTOR_CONTROL_KIND.REGISTER_PREPARE)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      if (kind === ACTOR_CONTROL_KIND.REGISTER_ABORT) return Promise.resolve(b4a.alloc(0))
      return Promise.reject(new Error('unexpected'))
    }
  )
  const control = session(peer)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.alike(
    calls.map(({ kind }) => kind),
    [
      ACTOR_CONTROL_KIND.REGISTER_STAGE,
      ACTOR_CONTROL_KIND.REGISTER_PREPARE,
      ACTOR_CONTROL_KIND.REGISTER_ABORT
    ]
  )
  t.alike(
    calls.map(({ options }) => options.deadline),
    [6_000, 6_000, 6_000]
  )
  t.is(control.stats.waits, 0)
  t.is(control.stats.ownedBytes, 0)
})

test('a lost stage reply still attempts abort without claiming staged ownership', async (t) => {
  const calls = []
  const peer = controlledRemote(function request(kind) {
    calls.push(kind)
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE)
      return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
    return Promise.resolve(b4a.alloc(0))
  })
  const control = session(peer)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
  t.is(control.stats.ownedBytes, 0)
})

test('an exact-deadline response is late, tombstoned remotely, and rolled back', async (t) => {
  let now = 1_000
  const calls = []
  const peer = controlledRemote(function request(kind) {
    calls.push(kind)
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) {
      now = 6_000
      return Promise.resolve(bytes(195, 1))
    }
    return Promise.reject(PrivateRouteError.INVALID_ROUTE())
  })
  const control = session(peer, () => now)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.stats.waits, 0)
})

test('transport exceptions map stably and activation failure attempts destroy', async (t) => {
  const calls = []
  const peer = controlledRemote(function request(kind) {
    calls.push(kind)
    if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) throw new Error('socket died')
    return Promise.reject(new Error('socket remains dead'))
  })
  const control = session(peer)
  const activation = activationFixture(31, bytes(16, 2), 1n)
  t.is(
    await rejectionCode(
      control.activate({
        body: activation.body,
        circuitId: activation.circuitId,
        generation: activation.generation,
        activationVerifier: activation.verifier
      })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(calls, [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.CIRCUIT_DESTROY])
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
  t.is(control.stats.ownedBytes, 16)
  await control.stop()
  t.is(control.stats.ownedBytes, 0)
  activation.destroy()
})

test('stop during setup cancels the installed wait before remote completion', async (t) => {
  let observedSignal = null
  const peer = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      if (options.signal) observedSignal = options.signal
      if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      return new Promise((resolve, reject) => {
        if (!options.signal) return reject(PrivateRouteError.ROUTE_UNAVAILABLE())
        const cancelled = () => reject(PrivateRouteError.ROUTE_UNAVAILABLE())
        options.signal.addEventListener('abort', cancelled, { once: true })
      })
    }
  )
  const control = session(peer)
  const activation = activationFixture(41, bytes(16, 2), 1n)
  const pending = control.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  const stopped = control.stop()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(await stopped, true)
  t.is(observedSignal.aborted, true)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
  t.alike(control.stats, {
    waits: 0,
    timers: 0,
    ownedBytes: 0,
    registrationState: ASYNC_REGISTRATION_STATE.NEW,
    circuitState: ASYNC_CIRCUIT_STATE.DESTROYING,
    stopped: true
  })
  activation.destroy()
})

test('pre-dispatch cancellation does not emit stage or abort traffic', async (t) => {
  const calls = []
  const control = session(
    controlledRemote(function request(kind) {
      calls.push(kind)
      return Promise.resolve(b4a.alloc(0))
    })
  )
  t.is(
    await rejectionCode(control.register({ ...registration(), signal: abortedSignal() })),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(calls, [])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.stats.ownedBytes, 0)
})

test('cancellation after authenticated stage attempts abort with the original deadline', async (t) => {
  const controller = cancellableSignal()
  const calls = []
  const peer = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, deadline: options.deadline })
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
      if (kind === ACTOR_CONTROL_KIND.REGISTER_PREPARE) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(PrivateRouteError.ROUTE_UNAVAILABLE()),
            { once: true }
          )
        })
      }
      return Promise.resolve(b4a.alloc(0))
    }
  )
  const control = session(peer)
  const pending = control.register({ ...registration(), signal: controller.signal })
  for (let attempt = 0; attempt < 16 && calls.length < 2; attempt++) await Promise.resolve()
  t.is(calls.length, 2, 'prepare wait is installed before cancellation')
  controller.abort()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.alike(calls, [
    { kind: ACTOR_CONTROL_KIND.REGISTER_STAGE, deadline: 6_000 },
    { kind: ACTOR_CONTROL_KIND.REGISTER_PREPARE, deadline: 6_000 },
    { kind: ACTOR_CONTROL_KIND.REGISTER_ABORT, deadline: 6_000 }
  ])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(control.stats.waits, 0)
  t.is(control.stats.ownedBytes, 0)
})

test('stop from staged state sends the retained abort before clearing resources', async (t) => {
  const peer = remote()
  const control = session(peer)
  await control.stage(bytes(64, 1), { abort: bytes(64, 2) })
  t.is(await control.stop(), true)
  t.alike(
    peer.calls.map((call) => call.kind),
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT]
  )
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(control.stats.ownedBytes, 0)
})

test('remote stable errors survive cleanup while unknown failures become unavailable', async (t) => {
  for (const expected of ['UNAUTHORIZED', 'CIRCUIT_LIMIT', 'CIRCUIT_STATE']) {
    const peer = controlledRemote(function request(kind) {
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE)
        return Promise.reject(new PrivateRouteError(expected))
      return Promise.resolve(b4a.alloc(0))
    })
    t.is(await rejectionCode(session(peer).register(registration())), expected)
  }
})

test('session owns request copies and clears them after completion', async (t) => {
  const retained = []
  const peer = controlledRemote(function request(kind, actorId, circuitId, generation, body) {
    retained.push(body)
    return Promise.resolve(
      kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? bytes(195, 1) : b4a.alloc(0)
    )
  })
  const values = registration()
  const control = session(peer)
  await control.register(values)
  for (const value of Object.values(values))
    t.ok(
      value.some((byte) => byte !== 0),
      'caller input remains caller-owned'
    )
  for (const value of retained)
    t.ok(
      value.every((byte) => byte === 0),
      'transport-facing private copy is zeroized'
    )
})

test('late local validation failures transmit nothing and leave both tables at NEW', async (t) => {
  const peer = remote()
  const control = session(peer)
  t.is(
    await rejectionCode(
      control.register({
        stage: bytes(64, 1),
        prepare: bytes(64, 2),
        finalize: null,
        abort: bytes(64, 3)
      })
    ),
    'INVALID_ROUTE'
  )
  t.is(
    await rejectionCode(
      control.activate({
        body: bytes(64, 4),
        circuitId: bytes(16, 5),
        generation: -1n,
        activationVerifier: Object.freeze({})
      })
    ),
    'INVALID_ROUTE'
  )
  t.alike(peer.calls, [])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.NEW)
  t.is(control.stats.ownedBytes, 0)
})

test('separate registration steps retain the first absolute deadline', async (t) => {
  let now = 1_000
  const peer = remote()
  const control = session(peer, () => now)
  await control.stage(bytes(64, 1), { abort: bytes(64, 2) })
  now = 2_000
  await control.prepare(bytes(64, 3))
  now = 3_000
  await control.finalize(bytes(64, 4))
  t.alike(
    peer.calls.map((call) => call.options.deadline),
    [6_000, 6_000, 6_000]
  )
})

test('separate registration steps started at or after their deadline fail before send', async (t) => {
  for (const now of [6_000, 6_001]) {
    const clock = { now: 1_000 }
    const pair = authenticatedPair(clock)
    const fixture = activationFixture(180 + now - 6_000)
    const actorId = bytes(16, 0xe1 + now - 6_000)
    pair.server.register(actorId, fixture.relay)
    const control = new AsyncRouteControlSession({
      remote: pair.client,
      actorId,
      now: () => clock.now
    })
    const staged = await settleAuthenticated(
      control.stage(fixture.built.registrationCapsule, {
        abort: fixture.built.abortCapsule
      }),
      pair
    )
    staged.fill(0)
    clock.now = now
    t.is(await rejectionCode(control.prepare(fixture.built.prepareCapsule)), 'ROUTE_UNAVAILABLE')
    t.is(pair.toServer.length, 0, `no prepare or abort is sent at ${now}`)
    t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTING)
    await control.stop()
    pair.client.destroy()
    pair.server.destroy()
    fixture.destroy()
  }
})

test('failed cleanup stays retryable until an authenticated abort or destroy reply', async (t) => {
  let abortAttempts = 0
  const registrationPeer = controlledRemote(function request(kind) {
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
    if (kind === ACTOR_CONTROL_KIND.REGISTER_ABORT && abortAttempts++ === 0)
      return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
    return Promise.resolve(b4a.alloc(0))
  })
  const registration = session(registrationPeer)
  await registration.stage(bytes(64, 1), { abort: bytes(64, 2) })
  t.is(await rejectionCode(registration.abort()), 'ROUTE_UNAVAILABLE')
  t.is(registration.registrationState, ASYNC_REGISTRATION_STATE.ABORTING)
  t.is(await registration.abort(), true)
  t.is(registration.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)

  let destroyAttempts = 0
  const circuitPeer = controlledRemote(function request(kind) {
    if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) return Promise.resolve(bytes(305, 1))
    if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY && destroyAttempts++ === 0)
      return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
    return Promise.resolve(b4a.alloc(0))
  })
  const circuit = session(circuitPeer)
  const activation = activationFixture(51, bytes(16, 4), 1n)
  const proof = await circuit.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  proof.fill(0)
  t.is(await rejectionCode(circuit.destroy()), 'ROUTE_UNAVAILABLE')
  t.is(circuit.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
  t.is(await circuit.destroy(), true)
  t.is(circuit.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  activation.destroy()
})

test('destroy retries retain the destroy transaction deadline, not the activation deadline', async (t) => {
  let now = 1_000
  let destroys = 0
  const deadlines = []
  const peer = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      deadlines.push(options.deadline)
      if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) return Promise.resolve(bytes(305, 1))
      if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY && destroys++ === 0)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      return Promise.resolve(b4a.alloc(0))
    }
  )
  const control = session(peer, () => now)
  const activation = activationFixture(55, bytes(16, 0x56), 1n)
  const proof = await control.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  proof.fill(0)
  now = 2_000
  t.is(await rejectionCode(control.destroy()), 'ROUTE_UNAVAILABLE')
  now = 2_500
  t.is(await control.destroy(), true)
  t.alike(deadlines, [6_000, 7_000, 7_000])
  activation.destroy()
})

test('destroy retries at or after their retained deadline fail unavailable before send', async (t) => {
  for (const now of [7_000, 7_001]) {
    let current = 1_000
    let destroys = 0
    const calls = []
    const peer = controlledRemote(function request(kind) {
      calls.push(kind)
      if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) return Promise.resolve(bytes(305, 1))
      if (kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY && destroys++ === 0)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      return Promise.resolve(b4a.alloc(0))
    })
    const control = session(peer, () => current)
    const activation = activationFixture(190 + now - 7_000)
    const proof = await control.activate({
      body: activation.body,
      circuitId: activation.circuitId,
      generation: activation.generation,
      activationVerifier: activation.verifier
    })
    proof.fill(0)
    current = 2_000
    t.is(await rejectionCode(control.destroy()), 'ROUTE_UNAVAILABLE')
    current = now
    t.is(await rejectionCode(control.destroy()), 'ROUTE_UNAVAILABLE')
    t.alike(calls, [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.CIRCUIT_DESTROY])
    t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYING)
    await control.stop()
    activation.destroy()
  }
})

test('expiry during activation cancels the wait and a late reply cannot open the circuit', async (t) => {
  let resolveActivation = null
  const peer = controlledRemote(function request(kind) {
    if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
    if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE)
      return new Promise((resolve) => {
        resolveActivation = resolve
      })
    return Promise.resolve(b4a.alloc(0))
  })
  const control = session(peer)
  await control.register(registration())
  const activation = activationFixture(61, bytes(16, 2), 1n)
  const pending = control.activate({
    body: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    activationVerifier: activation.verifier
  })
  const expiring = control.expire()
  resolveActivation(bytes(305, 3))
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(await expiring, true)
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.EXPIRED)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  activation.destroy()
})

test('destroy cannot cancel an unrelated registration wait', async (t) => {
  const controller = cancellableSignal()
  let stageSignal = null
  const calls = []
  const peer = controlledRemote(
    function request(kind, actorId, circuitId, generation, body, options) {
      calls.push(kind)
      if (kind === ACTOR_CONTROL_KIND.REGISTER_ABORT) return Promise.resolve(b4a.alloc(0))
      stageSignal = options.signal
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(PrivateRouteError.ROUTE_UNAVAILABLE()),
          { once: true }
        )
      })
    }
  )
  const control = session(peer)
  const pending = control.register({ ...registration(), signal: controller.signal })
  t.is(await rejectionCode(control.destroy()), 'CIRCUIT_STATE')
  t.is(stageSignal.aborted, false)
  controller.abort()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
})

test('pre-bind activation failure destroys the source-only verifier capability', async (t) => {
  const fixture = activationFixture(81, bytes(16, 0x82), 2n)
  const control = session(remote())
  await control.stop()
  t.is(
    await rejectionCode(
      control.activate({
        body: fixture.body,
        circuitId: fixture.circuitId,
        generation: fixture.generation,
        activationVerifier: fixture.verifier
      })
    ),
    'CIRCUIT_STATE'
  )
  t.is(isRemoteActivationVerifier(fixture.verifier), false)
  fixture.destroy()
})
