import test from 'brittle'
import b4a from 'b4a'

import {
  ACTOR_CONTROL_KIND,
  ActorControlCodec,
  CREATED_SIZE,
  ENTRY_PROOF_SIZE,
  RemoteActorHost,
  createDestinationReplayCache,
  createPrivateDestinationActor,
  createRemoteActivationVerifier,
  createRemoteRegistrationVerifier,
  destroyPrivateDestinationActor
} from '../index.js'
import {
  createDistributedPrivateRelayActor,
  destroyDistributedPrivateRelayActor
} from '../lib/activation.js'
import { forwardRemoteActorHost } from '../lib/remote-actor-host.js'
import {
  RemoteControlFragmentCodec,
  RemoteControlMux,
  createRemoteActorControlBoundary
} from '../lib/remote-control.js'
import { DIRECTION } from '../lib/protocol.js'
import { createLiveRouteFixture } from './live-route-fixture.js'

function sequenceBytes(start = 1) {
  let value = start
  return (size) => {
    const output = b4a.alloc(size)
    for (let index = 0; index < size; index++) output[index] = value++ & 0xff
    return output
  }
}

function scheduler() {
  const timers = new Set()
  return {
    schedule(delay, callback) {
      const timer = { delay, callback }
      timers.add(timer)
      return timer
    },
    cancel(timer) {
      timers.delete(timer)
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

class AuthenticatedHost extends RemoteActorHost {
  #boundary
  #link
  #mux = new RemoteControlMux()
  #sender
  #outerCircuitId = b4a.alloc(16, 0x7e)
  #messageId = 1

  constructor(options) {
    const link = Object.freeze({})
    const boundary = createRemoteActorControlBoundary({
      link,
      epoch: 1n,
      circuitId: b4a.alloc(16, 0x7e),
      now: options.now
    })
    super({ ...options, control: boundary.consumer })
    this.#boundary = boundary
    this.#link = link
    this.#sender = new RemoteControlFragmentCodec({ now: options.now })
  }

  receiveRaw(message) {
    const kind = new ActorControlCodec().decode(message).kind
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
      return this.receiveAuthenticated(event)
    } finally {
      messageId.fill(0)
      for (const frame of frames) frame.fill(0)
    }
  }

  destroy() {
    super.destroy()
    this.#sender.destroy()
    this.#boundary.destroy()
    this.#outerCircuitId.fill(0)
  }
}

function linkedHosts(now, start) {
  const timers = scheduler()
  let client = null
  let server = null
  let failure = null
  const deliver = (target, message) => {
    const owned = b4a.from(message)
    queueMicrotask(() => {
      void target.receiveRaw(owned).catch((err) => {
        failure = err
      })
    })
    return true
  }
  client = new AuthenticatedHost({
    sendControl(message) {
      return deliver(server, message)
    },
    now,
    randomBytes: sequenceBytes(start),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  server = new AuthenticatedHost({
    sendControl(message) {
      return deliver(client, message)
    },
    now,
    randomBytes: sequenceBytes(start + 40),
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  return {
    client,
    server,
    destroy() {
      client.destroy()
      server.destroy()
      if (failure) throw failure
    }
  }
}

function nextContact(projection, role) {
  const contact = projection.contacts.find((value) => value.role === role)
  if (!contact) throw new Error(`missing ${role} contact`)
  return contact
}

test('three distributed relay actors register and authenticate CREATED', async (t) => {
  const now = () => 1_000
  const fixture = createLiveRouteFixture({ distinctHosts: false })
  const source = fixture.projections.get('source')
  const entry = fixture.projections.get('private-entry')
  const middle = fixture.projections.get('private-middle')
  const final = fixture.projections.get('private-final')
  const destination = fixture.projections.get('destination')
  const sourceLink = linkedHosts(now, 1)
  const entryLink = linkedHosts(now, 81)
  const middleLink = linkedHosts(now, 161)
  const finalLink = linkedHosts(now, 201)
  const links = [sourceLink, entryLink, middleLink, finalLink]
  const events = []
  const destinationActor = createPrivateDestinationActor({
    identity: destination.local.identity32,
    identitySecretKey: destination.local.identitySecretKey,
    routeSigningKey: destination.route.routeSigningKey,
    routeSigningSecretKey: destination.route.routeSigningSecretKey,
    routeEncryptionSecretKey: destination.route.routeEncryptionSecretKey,
    finalToken: destination.route.finalToken,
    now,
    randomBytes: sequenceBytes(241)
  })
  const destinationActorId = destination.route.actorId
  finalLink.server.register(destinationActorId, destinationActor)

  const relaySpecs = [
    [entry, 'private-middle', entryLink.client],
    [middle, 'private-final', middleLink.client],
    [final, 'destination', finalLink.client]
  ]
  const relays = relaySpecs.map(([projection, nextRole, client], index) => {
    const contact = nextContact(projection, nextRole)
    const actor = createDistributedPrivateRelayActor({
      identity: projection.local.identity32,
      identitySecretKey: projection.local.identitySecretKey,
      routeEncryptionSecretKey: projection.local.routeEncryptionSecretKey,
      nextIdentity: contact.identity32,
      nextRouteEncryptionKey: contact.routeEncryptionKey,
      entry: index === 0,
      destination: nextRole === 'destination',
      now,
      randomBytes: sequenceBytes(20 + index * 20),
      observe(event) {
        events.push({ role: projection.role, ...event })
      },
      forward(kind, circuitId, generation, body) {
        return forwardRemoteActorHost(client, kind, contact.actorId, circuitId, generation, body)
      }
    })
    return { actor, actorId: projection.route.actorId }
  })
  sourceLink.server.register(relays[0].actorId, relays[0].actor)
  entryLink.server.register(relays[1].actorId, relays[1].actor)
  middleLink.server.register(relays[2].actorId, relays[2].actor)

  const registration = source.route
  const registrationCircuitId = b4a.alloc(16)
  const registrationVerifier = createRemoteRegistrationVerifier({
    request: registration.registrationCapsule,
    registrations: registration.registrations
  })
  const staged = await sourceLink.client.request(
    ACTOR_CONTROL_KIND.REGISTER_STAGE,
    registration.entryActorId,
    registrationCircuitId,
    0n,
    registration.registrationCapsule,
    { registrationVerifier }
  )
  t.is(staged[0], 0)
  t.is(staged[1], 3)
  for (const [kind, body] of [
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, registration.prepareCapsule],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, registration.finalizeCapsule]
  ]) {
    const acknowledgement = await sourceLink.client.request(
      kind,
      registration.entryActorId,
      registrationCircuitId,
      0n,
      body
    )
    t.alike(acknowledgement, b4a.from([0, 0xff]))
  }
  t.alike(
    events
      .filter((event) => event.type === 'private-registration-commit')
      .map((event) => event.role),
    ['private-final', 'private-middle', 'private-entry']
  )

  const activation = registration.activation
  const verifier = createRemoteActivationVerifier({
    ...activation,
    request: activation.body,
    circuitId: activation.circuitId,
    generation: activation.generation,
    replayCache: createDestinationReplayCache({ now }),
    now
  })
  const proof = await sourceLink.client.request(
    ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
    registration.entryActorId,
    activation.circuitId,
    activation.generation,
    activation.body,
    { activationVerifier: verifier }
  )
  t.is(proof.byteLength, ENTRY_PROOF_SIZE + CREATED_SIZE)
  t.is(events.filter((event) => event.type === 'private-activation-open').length, 3)

  proof.fill(0)
  staged.fill(0)
  registrationCircuitId.fill(0)
  for (const link of links) link.destroy()
  for (const { actor } of relays) destroyDistributedPrivateRelayActor(actor)
  destroyPrivateDestinationActor(destinationActor)
})
