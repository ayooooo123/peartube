import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import * as guardLinks from '../lib/guard-link.js'
import { TEST_ONLY_RELAY_OBSERVER } from '../lib/relay-service.js'
import { seed } from './helpers.js'

const NOW = 1_000
const NOW_BIG = 1_000n
const OFFER_DIGEST = b4a.from(Array.from({ length: 32 }, (_, index) => index))
const INITIATOR_CELL_ID = b4a.from('c78d0f017fe9b907995002a35ff0d9ef', 'hex')
const RESPONDER_CELL_ID = b4a.from('1b59923d31c99d089e85e64671f7ce71', 'hex')
const PAYLOAD_PARAMETERS = Object.freeze({
  cellSize: 1200,
  maxCellPayload: 1146,
  contextEnvelopeSize: 1101,
  routeFrameSize: 1100,
  maxRoutePayload: 1073,
  datagramReplayWindow: 64,
  maxQueuedBytes: 65_536,
  idleTimeoutMs: 30_000
})

async function loadApi(t) {
  try {
    return await import('../lib/m3-adjacency-runtime.js')
  } catch (err) {
    t.fail(`M3 adjacency runtime module is missing: ${err.message}`)
    return null
  }
}

function readU64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function channel(onDestroy = null) {
  let destroys = 0
  return {
    value: Object.freeze({
      destroy() {
        destroys++
        if (onDestroy) onDestroy()
      }
    }),
    get destroys() {
      return destroys
    }
  }
}

function contexts(initiator) {
  const values = {}
  const senders = []
  for (const cellClass of [
    routes.CELL_CLASS.CONTROL,
    routes.CELL_CLASS.STREAM,
    routes.CELL_CLASS.DATAGRAM
  ]) {
    const forwardKey = b4a.alloc(32, 0x10 + cellClass)
    const reverseKey = b4a.alloc(32, 0x20 + cellClass)
    const forwardNonce = b4a.alloc(16, 0x30 + cellClass)
    const reverseNonce = b4a.alloc(16, 0x40 + cellClass)
    const sender = new routes.SenderCounter()
    senders.push(sender)
    values[cellClass] = {
      tx: {
        key: initiator ? forwardKey : reverseKey,
        noncePrefix: initiator ? forwardNonce : reverseNonce,
        counter: sender
      },
      rx: {
        key: initiator ? reverseKey : forwardKey,
        noncePrefix: initiator ? reverseNonce : forwardNonce,
        counter:
          cellClass === routes.CELL_CLASS.DATAGRAM
            ? new routes.DatagramReplayWindow({ window: 256 })
            : new routes.OrderedReceiver({ window: 256, gapTimeout: 5_000, now: () => NOW })
      }
    }
  }
  return { senders, values }
}

function syntheticLink(api, overrides = {}) {
  const initiator = overrides.initiator === undefined ? true : overrides.initiator
  const completeOfferDigest = b4a.from(overrides.completeOfferDigest || OFFER_DIGEST)
  const ids = api.deriveM3CellIds(completeOfferDigest, {
    crypto: overrides.crypto || routes.cryptoSuite
  })
  const ownedContexts = overrides.contexts || contexts(initiator)
  const ownedChannel = overrides.channel || channel()
  const state = Object.freeze({
    initiator,
    completeOfferDigest,
    localId: overrides.localId || (initiator ? ids.initiatorCellId : ids.responderCellId),
    peerLocalId: overrides.peerLocalId || (initiator ? ids.responderCellId : ids.initiatorCellId),
    branchClass:
      overrides.branchClass === undefined ? routes.BRANCH_CLASS.LOOKUP : overrides.branchClass,
    branchId: overrides.branchId || b4a.alloc(16, 0x41),
    circuitId: overrides.circuitId || b4a.alloc(16, 0x42),
    generation: overrides.generation === undefined ? 7n : overrides.generation,
    extensionIndex:
      overrides.extensionIndex === undefined ? (initiator ? 2 : 1) : overrides.extensionIndex,
    localIdentity: overrides.localIdentity || routes.cryptoSuite.keyPair(seed(61)).publicKey,
    peerIdentity: overrides.peerIdentity || routes.cryptoSuite.keyPair(seed(62)).publicKey,
    expiresAt: overrides.expiresAt === undefined ? 10_000n : overrides.expiresAt,
    contexts: ownedContexts.values,
    physicalChannel: ownedChannel.value,
    clientTailEphemeralSecretKey: initiator ? seed(63) : null
  })
  return {
    handle: guardLinks.TEST_ONLY_M3_ESTABLISHED_ISSUER.issue(state),
    channel: ownedChannel,
    contexts: ownedContexts,
    state
  }
}

function adopt(owner, value) {
  return owner.adopt(value.handle || value)
}

function authority(api, overrides = {}) {
  return new api.M3AdjacencyAuthority({
    now: () => NOW,
    crypto: routes.cryptoSuite,
    ...overrides
  })
}

function relay(identity, overrides = {}, now = () => NOW) {
  const links = routes.createLinkSetupAuthority({
    now,
    randomBytes: (size) => b4a.alloc(size, 0x73)
  })
  return new routes.RelayService({
    identity,
    ticketChecker: links.checker,
    crypto: routes.cryptoSuite,
    now,
    padding: (size) => b4a.alloc(size),
    send() {},
    ...overrides
  })
}

function realIndexZeroLink() {
  const guard = routes.cryptoSuite.keyPair(seed(2))
  const route = routes.cryptoSuite.encryptionKeyPair(seed(5))
  const endpoint = routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 41]),
    port: 49737
  })
  const capabilityMask = routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const advertisement = routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: guard.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(endpoint),
        reachableEndpoint: endpoint,
        routeEncryptionPublicKey: route.publicKey,
        capabilityMask,
        minimumProtocolVersion: 1,
        maximumProtocolVersion: 1,
        cellSize: 1200,
        maxCellPayload: 1146,
        contextEnvelopeSize: 1101,
        routeFrameSize: 1100,
        maxRoutePayload: 1073,
        datagramReplayWindow: 64,
        maxConcurrentCircuits: 8,
        capacityClass: routes.CAPACITY_CLASS.SMALL,
        maxCellsPerCircuit: 100,
        maxBytesPerCircuit: 100_000,
        maxCommandsPerCircuit: 10,
        idleTimeoutMs: 30_000,
        maxQueuedBytes: 65_536,
        epoch: 1n,
        issuedAtMs: NOW_BIG,
        expiresAtMs: 20_000n,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilityMask)
      },
      guard.secretKey
    )
  )
  const initiated = guardLinks.createIndexZeroGuardLinkOffer({
    advertisement,
    now: NOW_BIG,
    randomBytes: (size) => b4a.alloc(size, 0x44),
    branchClass: routes.BRANCH_CLASS.LOOKUP,
    branchId: b4a.alloc(16, 0x11),
    circuitId: b4a.alloc(16, 0x22),
    generation: 1n,
    clientCircuitIdentity: routes.cryptoSuite.keyPair(seed(3)),
    clientTailEphemeral: routes.cryptoSuite.encryptionKeyPair(seed(4)),
    payloadParametersDigest: routes.digestPayloadParameters(PAYLOAD_PARAMETERS),
    requestedLimits: {
      cellSize: 1200,
      maxCells: 100,
      maxBytes: 100_000,
      maxCommands: 10,
      idleTimeoutMs: 30_000,
      expiresAtMs: 5_000n
    }
  })
  const responder = guardLinks.createIndexZeroGuardLinkResponder({
    advertisement,
    responderIdentitySecretKey: guard.secretKey,
    responderRouteEncryptionSecretKey: route.secretKey,
    now: () => NOW_BIG,
    randomBytes: (size) => b4a.alloc(size, 0x55),
    receiveOffer: () => ({
      offer: initiated.offer,
      observedPredecessorEndpoint: routes.encodeCanonicalEndpoint({
        addressFamily: 4,
        addressBytes: b4a.from([198, 51, 100, 9]),
        port: 44000
      }),
      physicalChannel: Object.freeze({ destroy() {} })
    })
  })
  const accepted = responder.accept()
  return {
    handle: guardLinks.completeIndexZeroGuardLink(initiated.pending, accepted.accept, {
      advertisement,
      physicalChannel: Object.freeze({ destroy() {} }),
      now: NOW_BIG
    }),
    responderHandle: accepted.established
  }
}

function m2Ticket() {
  const initiator = routes.cryptoSuite.keyPair(seed(71))
  const responder = routes.cryptoSuite.keyPair(seed(72))
  const responderStatic = routes.cryptoSuite.encryptionKeyPair(seed(73))
  const links = routes.createLinkSetupAuthority({
    now: () => NOW,
    randomBytes: (size) => b4a.alloc(size, 0x74)
  })
  const common = {
    circuitId: b4a.alloc(16, 0x75),
    epoch: 1n,
    expiresAt: 2_000n,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    initiatorLocalId: b4a.alloc(16, 0x76),
    responderLocalId: b4a.alloc(16, 0x77)
  }
  const started = links.initiate({
    ...common,
    responderStaticKey: responderStatic.publicKey,
    initiatorIdentitySecretKey: initiator.secretKey
  })
  return links.respond(started.message, {
    ...common,
    responderStaticSecretKey: responderStatic.secretKey,
    responderIdentitySecretKey: responder.secretKey
  }).ticket
}

test('M3 cell IDs have exact canonical vectors and separate complete offers', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  t.is(typeof routes.M3AdjacencyAuthority, 'function', 'authority is a public production surface')
  t.is(routes.M3AdjacencyAuthority, api.M3AdjacencyAuthority)
  t.is('deriveM3CellIds' in routes, false, 'derivation helper remains a deep surface')
  t.is('TEST_ONLY_M3_ESTABLISHED_ISSUER' in routes, false)
  t.is('TEST_ONLY_M3_ADJACENCY_OBSERVER' in routes, false)
  t.is('TEST_ONLY_M3_ADJACENCY_ISSUER' in api, false, 'runtime has no raw-state issuer')
  t.is(typeof guardLinks.TEST_ONLY_M3_ESTABLISHED_ISSUER.issue, 'function')
  t.is(typeof api.TEST_ONLY_M3_ADJACENCY_OBSERVER, 'symbol')

  const ids = api.deriveM3CellIds(OFFER_DIGEST, { crypto: routes.cryptoSuite })
  t.alike(ids.initiatorCellId, INITIATOR_CELL_ID)
  t.alike(ids.responderCellId, RESPONDER_CELL_ID)
  t.is(ids.initiatorCellId.byteLength, 16, 'digest truncation is byte range [0, 16)')

  const otherOffer = b4a.from(OFFER_DIGEST)
  otherOffer[31] ^= 1
  const other = api.deriveM3CellIds(otherOffer, { crypto: routes.cryptoSuite })
  t.not(b4a.toString(other.initiatorCellId, 'hex'), b4a.toString(ids.initiatorCellId, 'hex'))
  t.not(b4a.toString(other.responderCellId, 'hex'), b4a.toString(ids.responderCellId, 'hex'))
})

test('M3 cell derivation rejects zero and equal actor-local identifiers', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  t.exception(() =>
    api.deriveM3CellIds(OFFER_DIGEST, {
      crypto: { hash: () => b4a.alloc(32) }
    })
  )

  t.exception(() =>
    api.deriveM3CellIds(OFFER_DIGEST, {
      crypto: { hash: () => b4a.alloc(32, 0x5a) }
    })
  )
  t.exception(() => api.deriveM3CellIds(b4a.alloc(31), { crypto: routes.cryptoSuite }))
})

test('authority adopts only one live established M3 link and returns an opaque tail', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const owner = authority(api)
  const real = realIndexZeroLink()
  const adopted = owner.adopt(real.handle)
  t.alike(Object.keys(adopted).sort(), ['runtime', 'tail'])
  t.alike(Object.keys(adopted.tail), [], 'tail is a distinct zero-key capability')
  t.not(adopted.tail, adopted.runtime)
  t.is('tail' in adopted.runtime.diagnostics(), false)
  t.exception(() => owner.adopt(real.handle), 'an adopted handle is spent')
  t.exception(() => owner.adopt(Object.freeze({})), 'raw objects are not established links')
  t.exception(() => owner.adopt(m2Ticket()), 'M2 tickets are a distinct brand')

  const destroyed = syntheticLink(api)
  guardLinks.destroyM3EstablishedLink(destroyed.handle)
  t.exception(() => owner.adopt(destroyed.handle), 'destroyed M3 handles are not adoptable')

  adopted.runtime.destroy()
  t.is(api.revokeM3TailCapability(adopted.tail), true)
  t.is(api.revokeM3TailCapability(adopted.tail), false)
  guardLinks.destroyM3EstablishedLink(real.responderHandle)
})

test('authority binds reciprocal actors to generation epoch and advances live counters', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const leftContexts = contexts(true)
  const rightContexts = contexts(false)
  const leftIdentity = routes.cryptoSuite.keyPair(seed(81)).publicKey
  const rightIdentity = routes.cryptoSuite.keyPair(seed(82)).publicKey
  const leftTransfer = syntheticLink(api, {
    initiator: true,
    contexts: leftContexts,
    localIdentity: leftIdentity,
    peerIdentity: rightIdentity
  })
  const rightTransfer = syntheticLink(api, {
    initiator: false,
    contexts: rightContexts,
    localIdentity: rightIdentity,
    peerIdentity: leftIdentity
  })
  const leftAdopted = adopt(authority(api), leftTransfer)
  const rightAdopted = adopt(authority(api), rightTransfer)
  const left = leftAdopted.runtime
  const right = rightAdopted.runtime

  const payload = b4a.from('tail-control')
  const packet = left.sealTail({ class: routes.CELL_CLASS.CONTROL, payload })
  t.is(readU64(packet, 4), 7n, 'cell epoch equals the branch generation')
  t.alike(packet.subarray(12, 28), RESPONDER_CELL_ID, 'initiator seals to peer-local ID')
  t.is(leftContexts.senders[0].value, 1n, 'runtime owns and advances the real sender')
  const [opened] = right.openTail(packet)
  t.alike(opened, payload, 'responder reverses the actor-local IDs and contexts')
  const reply = right.sealTail({ class: routes.CELL_CLASS.CONTROL, payload })
  t.alike(reply.subarray(12, 28), INITIATOR_CELL_ID, 'responder seals to reciprocal peer ID')
  t.alike(left.openTail(reply)[0], payload)

  t.alike(left.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 10_000n })
  t.is('localId' in left.diagnostics(), false)
  t.is('peerIdentity' in left.diagnostics(), false)
  t.is('counter' in left.diagnostics(), false)
  t.alike(Object.keys(leftAdopted.tail), [])
  t.alike(Object.keys(rightAdopted.tail), [])
  t.is(left.destroy(), true)
  t.is(left.destroy(), false, 'destroy is idempotent')
  t.is(right.revoke(), true)
  t.is(right.revoke(), false, 'revoke is idempotent')
  api.revokeM3TailCapability(leftAdopted.tail)
  api.revokeM3TailCapability(rightAdopted.tail)
})

test('authority reserves before callbacks and enforces defaults, hard cap, and collisions', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  t.exception(() => authority(api, { maxRuntimes: 0 }))
  t.exception(() => authority(api, { maxRuntimes: 1.5 }))
  t.exception(() => authority(api, { maxRuntimes: 4_097 }), 'hard cap is 4,096')
  t.alike(authority(api, { maxRuntimes: 4_096 }).diagnostics(), {
    activeRuntimes: 0,
    maxRuntimes: 4_096
  })
  const bounded = authority(api, { maxRuntimes: 1 })
  t.alike(bounded.diagnostics(), { activeRuntimes: 0, maxRuntimes: 1 })
  const firstTransfer = syntheticLink(api)
  const first = adopt(bounded, firstTransfer).runtime
  t.alike(bounded.diagnostics(), { activeRuntimes: 1, maxRuntimes: 1 })
  t.exception(() => adopt(bounded, syntheticLink(api)), 'capacity is reserved synchronously')
  first.destroy()

  const defaults = authority(api)
  t.alike(defaults.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })

  let callbackCollision = null
  let reentrant = null
  const value = syntheticLink(api)
  const duplicate = syntheticLink(api)
  const guarded = authority(api, {
    [api.TEST_ONLY_M3_ADJACENCY_OBSERVER](event) {
      if (event.type !== 'reserved' || reentrant !== null) return
      try {
        adopt(guarded, duplicate)
      } catch (err) {
        callbackCollision = err
      }
      reentrant = true
    }
  })
  const runtime = adopt(guarded, value).runtime
  t.ok(callbackCollision, 'the binding is already reserved before the observer runs')
  t.exception(
    () => adopt(guarded, syntheticLink(api)),
    'the live (peer identity, local ID) collides'
  )

  const mismatched = syntheticLink(api, { localId: b4a.alloc(16, 0x7f) })
  t.exception(() => adopt(authority(api), mismatched), 'IDs are independently rederived')
  runtime.destroy()
})

test('authority reserves before injected crypto/time reentry and rolls failures back', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  for (const callback of ['crypto', 'now']) {
    const outer = syntheticLink(api)
    const duplicate = syntheticLink(api)
    let reentryError = null
    let attempted = false
    let owner = null
    const crypto = {
      ...routes.cryptoSuite,
      hash(input) {
        if (callback === 'crypto' && !attempted) {
          attempted = true
          try {
            adopt(owner, duplicate)
          } catch (err) {
            reentryError = err
          }
        }
        return routes.cryptoSuite.hash(input)
      }
    }
    owner = new api.M3AdjacencyAuthority({
      crypto,
      now() {
        if (callback === 'now' && !attempted) {
          attempted = true
          try {
            adopt(owner, duplicate)
          } catch (err) {
            reentryError = err
          }
        }
        return NOW
      }
    })
    const adopted = adopt(owner, outer)
    t.ok(reentryError, `${callback} reentry sees the provisional binding`)
    t.is(duplicate.channel.destroys, 1, `${callback} reentry destroys rejected ownership once`)
    t.alike(owner.diagnostics(), { activeRuntimes: 1, maxRuntimes: 128 })
    adopted.runtime.destroy()
    api.revokeM3TailCapability(adopted.tail)
  }

  const failed = syntheticLink(api)
  const failing = authority(api, {
    crypto: {
      ...routes.cryptoSuite,
      hash() {
        throw new Error('injected failure')
      }
    }
  })
  t.exception(() => adopt(failing, failed))
  t.is(failed.channel.destroys, 1, 'callback failure destroys transferred channel once')
  t.alike(failing.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })
})

test('authority synchronously sweeps exact-boundary expiry', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  let current = NOW
  const owner = authority(api, { now: () => current, maxRuntimes: 1 })
  const expiring = syntheticLink(api, { expiresAt: BigInt(NOW + 1) })
  const adopted = adopt(owner, expiring)
  current = NOW + 1
  t.alike(owner.diagnostics(), { activeRuntimes: 0, maxRuntimes: 1 })
  t.is(expiring.channel.destroys, 1, 'expiresAt === now releases the physical channel')
  t.exception(() => adopted.runtime.diagnostics(), 'expired runtime stays destroyed')

  const replacement = syntheticLink(api)
  const live = adopt(owner, replacement)
  t.alike(owner.diagnostics(), { activeRuntimes: 1, maxRuntimes: 1 })
  live.runtime.destroy()
  api.revokeM3TailCapability(adopted.tail)
  api.revokeM3TailCapability(live.tail)
})

test('revoke and destroy erase runtime ownership and release channels exactly once', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const owner = authority(api, { maxRuntimes: 1 })
  const revokedTransfer = syntheticLink(api)
  const revoked = adopt(owner, revokedTransfer).runtime
  t.is(revoked.revoke(), true)
  t.is(revokedTransfer.channel.destroys, 1)
  t.is(revoked.destroy(), false)
  t.alike(owner.diagnostics(), { activeRuntimes: 0, maxRuntimes: 1 })

  const destroyedTransfer = syntheticLink(api)
  const destroyed = adopt(owner, destroyedTransfer).runtime
  t.is(destroyed.destroy(), true)
  t.is(destroyedTransfer.channel.destroys, 1)
  t.is(destroyed.destroy(), false)
  t.alike(owner.diagnostics(), { activeRuntimes: 0, maxRuntimes: 1 })
})

test('installM3 atomically moves adjacent runtimes and clamps independent expiries', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const relayIdentity = routes.cryptoSuite.keyPair(seed(91)).publicKey
  const previousPeer = routes.cryptoSuite.keyPair(seed(92)).publicKey
  const nextPeer = routes.cryptoSuite.keyPair(seed(93)).publicKey
  const sent = []
  const service = relay(relayIdentity, {
    send(peer, packet) {
      sent.push({ peer: b4a.from(peer), packet: b4a.from(packet) })
    }
  })
  const owner = authority(api)
  const peerOwner = authority(api)
  const previousContexts = contexts(false)
  const previousPeerContexts = contexts(true)
  const nextContexts = contexts(true)
  const nextPeerContexts = contexts(false)
  const previousTransfer = syntheticLink(api, {
    initiator: false,
    completeOfferDigest: b4a.alloc(32, 0xa1),
    contexts: previousContexts,
    localIdentity: relayIdentity,
    peerIdentity: previousPeer,
    extensionIndex: 1,
    expiresAt: 9_000n
  })
  const previousPeerTransfer = syntheticLink(api, {
    initiator: true,
    completeOfferDigest: b4a.alloc(32, 0xa1),
    contexts: previousPeerContexts,
    localIdentity: previousPeer,
    peerIdentity: relayIdentity,
    extensionIndex: 1,
    expiresAt: 9_000n
  })
  const nextTransfer = syntheticLink(api, {
    initiator: true,
    completeOfferDigest: b4a.alloc(32, 0xa2),
    contexts: nextContexts,
    localIdentity: relayIdentity,
    peerIdentity: nextPeer,
    extensionIndex: 2,
    expiresAt: 7_000n
  })
  const nextPeerTransfer = syntheticLink(api, {
    initiator: false,
    completeOfferDigest: b4a.alloc(32, 0xa2),
    contexts: nextPeerContexts,
    localIdentity: nextPeer,
    peerIdentity: relayIdentity,
    extensionIndex: 2,
    expiresAt: 7_000n
  })
  const previousAdopted = adopt(owner, previousTransfer)
  const nextAdopted = adopt(owner, nextTransfer)
  const previous = previousAdopted.runtime
  const next = nextAdopted.runtime
  const previousPeerRuntime = adopt(peerOwner, previousPeerTransfer).runtime
  const nextPeerRuntime = adopt(peerOwner, nextPeerTransfer).runtime

  const priming = next.sealTail({
    class: routes.CELL_CLASS.CONTROL,
    payload: b4a.from('priming')
  })
  t.alike(nextPeerRuntime.openTail(priming)[0], b4a.from('priming'))
  const forwarding = service.installM3(previous, next)

  t.is(service.activeCircuits, 1)
  t.alike(owner.diagnostics(), { activeRuntimes: 2, maxRuntimes: 128 })
  t.alike(forwarding.diagnostics(), { state: 'CREATE', expiresAt: 7_000n })
  t.is('localId' in forwarding.diagnostics(), false)
  t.is('peerIdentity' in forwarding.diagnostics(), false)
  t.is('tail' in forwarding.diagnostics(), false)
  t.alike(Object.keys(previousAdopted.tail), [])
  t.alike(Object.keys(nextAdopted.tail), [])

  const inbound = previousPeerRuntime.sealTail({
    class: routes.CELL_CLASS.CONTROL,
    payload: b4a.from('forwarded')
  })
  service.receive(previousPeer, inbound)
  t.is(sent.length, 1)
  t.alike(sent[0].peer, nextPeer)
  t.alike(nextPeerRuntime.openTail(sent[0].packet)[0], b4a.from('forwarded'))
  t.is(nextContexts.senders[0].value, 2n, 'moved sender continues after its priming cell')
  for (const runtime of [previous, next]) {
    t.exception(() => runtime.diagnostics(), 'moved runtime is permanently unusable')
    t.exception(() => runtime.sealTail({ class: routes.CELL_CLASS.CONTROL, payload: b4a.alloc(0) }))
    t.exception(() => runtime.destroy())
    t.exception(() => runtime.revoke())
  }
  t.is(previousTransfer.channel.destroys, 0, 'move does not destroy transferred ownership')
  t.is(nextTransfer.channel.destroys, 0)
  t.is(forwarding.destroy(), true)
  t.is(service.activeCircuits, 0)
  t.alike(owner.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })
  t.is(previousTransfer.channel.destroys, 1)
  t.is(nextTransfer.channel.destroys, 1)
  t.is(forwarding.destroy(), false)
  previousPeerRuntime.destroy()
  nextPeerRuntime.destroy()
})

test('installM3 validation failure leaves advanced runtimes intact and reserved capacity reusable', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const relayIdentity = routes.cryptoSuite.keyPair(seed(101)).publicKey
  const serviceEvents = []
  const service = relay(relayIdentity, {
    [TEST_ONLY_RELAY_OBSERVER](event) {
      serviceEvents.push(event)
    }
  })
  const owner = authority(api)
  const previousTransfer = syntheticLink(api, {
    initiator: false,
    completeOfferDigest: b4a.alloc(32, 0xb1),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(102)).publicKey,
    extensionIndex: 1
  })
  const nextTransfer = syntheticLink(api, {
    initiator: true,
    completeOfferDigest: b4a.alloc(32, 0xb2),
    branchId: b4a.alloc(16, 0xff),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(103)).publicKey,
    extensionIndex: 2
  })
  const previous = adopt(owner, previousTransfer).runtime
  const next = adopt(owner, nextTransfer).runtime
  previous.sealTail({ class: routes.CELL_CLASS.CONTROL, payload: b4a.from('previous') })
  next.sealTail({ class: routes.CELL_CLASS.CONTROL, payload: b4a.from('next') })

  t.exception(
    () => service.installM3(previous, next),
    'branch mismatch fails before ownership moves'
  )
  t.alike(previous.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 10_000n })
  t.alike(next.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 10_000n })
  previous.sealTail({ class: routes.CELL_CLASS.CONTROL, payload: b4a.from('still-live') })
  next.sealTail({ class: routes.CELL_CLASS.CONTROL, payload: b4a.from('still-live') })
  t.is(previousTransfer.contexts.senders[0].value, 2n, 'previous counter does not roll back')
  t.is(nextTransfer.contexts.senders[0].value, 2n, 'next counter does not roll back')
  t.is(service.activeCircuits, 0)
  t.is(serviceEvents.length, 0, 'failed validation publishes no forwarding record')

  previous.destroy()
  next.destroy()
})

test('installed expiry tears down relay bindings through moved reservation ownership', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  let current = NOW
  const relayIdentity = routes.cryptoSuite.keyPair(seed(111)).publicKey
  const owner = authority(api, { now: () => current })
  let service = null
  let closeObservation = null
  let nextOwnedChannel = null
  const previousOwnedChannel = channel(() => {
    closeObservation = {
      activeCircuits: service.activeCircuits,
      activeRuntimes: owner.diagnostics().activeRuntimes,
      nextChannelDestroys: nextOwnedChannel.destroys
    }
  })
  nextOwnedChannel = channel()
  const previousTransfer = syntheticLink(api, {
    initiator: false,
    completeOfferDigest: b4a.alloc(32, 0xc1),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(112)).publicKey,
    extensionIndex: 1,
    expiresAt: 1_100n,
    channel: previousOwnedChannel
  })
  const nextTransfer = syntheticLink(api, {
    initiator: true,
    completeOfferDigest: b4a.alloc(32, 0xc2),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(113)).publicKey,
    extensionIndex: 2,
    expiresAt: 1_200n,
    channel: nextOwnedChannel
  })
  const previous = adopt(owner, previousTransfer)
  const next = adopt(owner, nextTransfer)
  service = relay(relayIdentity, {}, () => current)
  const forwarding = service.installM3(previous.runtime, next.runtime)
  t.is(service.activeCircuits, 1)

  current = 1_100
  t.alike(owner.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })
  t.is(service.activeCircuits, 0, 'authority expiry removes the complete forwarding record')
  t.alike(closeObservation, {
    activeCircuits: 0,
    activeRuntimes: 0,
    nextChannelDestroys: 0
  })
  t.exception(() => forwarding.diagnostics(), 'expired forwarding capability stays destroyed')
  t.is(previousTransfer.channel.destroys, 1)
  t.is(nextTransfer.channel.destroys, 1)
  api.revokeM3TailCapability(previous.tail)
  api.revokeM3TailCapability(next.tail)
})

test('reentrant relay clock cannot publish an M3 forwarding record', async (t) => {
  const api = await loadApi(t)
  if (!api) return

  const relayIdentity = routes.cryptoSuite.keyPair(seed(121)).publicKey
  const owner = authority(api)
  const previousTransfer = syntheticLink(api, {
    initiator: false,
    completeOfferDigest: b4a.alloc(32, 0xd1),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(122)).publicKey,
    extensionIndex: 1
  })
  const nextTransfer = syntheticLink(api, {
    initiator: true,
    completeOfferDigest: b4a.alloc(32, 0xd2),
    localIdentity: relayIdentity,
    peerIdentity: routes.cryptoSuite.keyPair(seed(123)).publicKey,
    extensionIndex: 2
  })
  const previous = adopt(owner, previousTransfer)
  const next = adopt(owner, nextTransfer)
  let service = null
  let reentryError = null
  let attempted = false
  service = relay(relayIdentity, {}, () => {
    if (!attempted) {
      attempted = true
      try {
        service.installM3(previous.runtime, next.runtime)
      } catch (err) {
        reentryError = err
      }
    }
    return NOW
  })

  t.exception(() => service.installM3(previous.runtime, next.runtime))
  t.ok(reentryError, 'nested install stable-fails while the pair is locked')
  t.is(service.activeCircuits, 0, 'caught reentry still fails the outer install closed')
  t.alike(previous.runtime.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 10_000n })
  t.alike(next.runtime.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 10_000n })
  previous.runtime.destroy()
  next.runtime.destroy()
  api.revokeM3TailCapability(previous.tail)
  api.revokeM3TailCapability(next.tail)
})
