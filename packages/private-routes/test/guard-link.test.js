import test from 'brittle'
import b4a from 'b4a'

import {
  BRANCH_CLASS,
  CAPACITY_CLASS,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  cryptoSuite,
  decodeM3Object,
  deriveM3DhtNodeId,
  digestPayloadParameters,
  digestRelayCapabilityAdvertisement,
  encodeCanonicalEndpoint,
  encodeM3Object,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  signRelayCapabilityAdvertisement
} from '../index.js'
import {
  LINK_ACCEPT_SIZE,
  LINK_OFFER_SIZE,
  abortIndexZeroGuardLink,
  completeIndexZeroGuardLink,
  createIndexZeroGuardLinkOffer,
  createIndexZeroGuardLinkResponder,
  destroyM3EstablishedLink,
  readM3EstablishedLink
} from '../lib/guard-link.js'
import { seed } from './helpers.js'

const NOW = 1_000n
const OFFER_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-offer/v1')
const ACCEPT_DOMAIN = b4a.from('hyperdht-private-routes/m3/link-accept/v1')
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

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafe(2 + domain.byteLength + 8 + body.byteLength)
  output.writeUInt16BE(domain.byteLength, 0)
  domain.copy(output, 2)
  output.writeUInt32BE(1, 2 + domain.byteLength)
  output.writeUInt16BE(messageId, 6 + domain.byteLength)
  output.writeUInt16BE(body.byteLength, 8 + domain.byteLength)
  body.copy(output, 10 + domain.byteLength)
  return output
}

function resign(encoded, messageId, domain, secretKey, mutate) {
  const object = decodeM3Object(encoded)
  mutate(object.body)
  return encodeM3Object({
    messageId,
    body: object.body,
    authSuffix: cryptoSuite.sign(signatureInput(domain, messageId, object.body), secretKey)
  })
}

function fixture() {
  const guard = cryptoSuite.keyPair(seed(2))
  const route = cryptoSuite.encryptionKeyPair(seed(5))
  const endpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, 41]),
    port: 49737
  })
  const capabilityMask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const advertisement = encodeRelayCapabilityAdvertisement(
    signRelayCapabilityAdvertisement(
      {
        relayIdentity: guard.publicKey,
        currentDhtNodeId: deriveM3DhtNodeId(endpoint),
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
        capacityClass: CAPACITY_CLASS.SMALL,
        maxCellsPerCircuit: 100,
        maxBytesPerCircuit: 100_000,
        maxCommandsPerCircuit: 10,
        idleTimeoutMs: 30_000,
        maxQueuedBytes: 65_536,
        epoch: 1n,
        issuedAtMs: NOW,
        expiresAtMs: 20_000n,
        providerServicePolicyEntries: providerServicePolicyForCapabilities(capabilityMask)
      },
      guard.secretKey
    )
  )
  return { advertisement, endpoint, guard, route }
}

function setup(value = {}) {
  return {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: b4a.alloc(16, 0x11),
    circuitId: b4a.alloc(16, 0x22),
    generation: 1n,
    clientCircuitIdentity: cryptoSuite.keyPair(seed(3)),
    clientTailEphemeral: cryptoSuite.encryptionKeyPair(seed(4)),
    payloadParametersDigest: digestPayloadParameters(PAYLOAD_PARAMETERS),
    requestedLimits: {
      cellSize: 1200,
      maxCells: 100,
      maxBytes: 100_000,
      maxCommands: 10,
      idleTimeoutMs: 30_000,
      expiresAtMs: 5_000n
    },
    ...value
  }
}

function exchange(overrides = {}) {
  const f = fixture()
  const linkSetup = setup(overrides)
  const initiated = createIndexZeroGuardLinkOffer({
    advertisement: f.advertisement,
    now: NOW,
    randomBytes: (size) => b4a.alloc(size, 0x44),
    ...linkSetup
  })
  const observedPredecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 9]),
    port: 44000
  })
  const responderPhysical = Object.freeze({ destroy() {} })
  const responder = responderFor(f, () => ({
    offer: initiated.offer,
    observedPredecessorEndpoint,
    physicalChannel: responderPhysical
  }))
  const accepted = responder.accept()
  return { accepted, f, initiated, linkSetup, observedPredecessorEndpoint, responder }
}

function responderFor(f, receiveOffer, random = 0x55) {
  return createIndexZeroGuardLinkResponder({
    advertisement: f.advertisement,
    responderIdentitySecretKey: f.guard.secretKey,
    responderRouteEncryptionSecretKey: f.route.secretKey,
    now: () => NOW,
    receiveOffer,
    randomBytes: (size) => b4a.alloc(size, random)
  })
}

test('index-zero offer and accept are exact fixed signed messages with mutual link keys', (t) => {
  const x = exchange()
  t.is(x.initiated.offer.byteLength, LINK_OFFER_SIZE)
  t.is(x.accepted.accept.byteLength, LINK_ACCEPT_SIZE)
  t.alike(
    decodeM3Object(x.accepted.accept).body.subarray(0, 32),
    b4a.from('526fb31362c0c45224fd3d6b03c1f8c50e09684a2c5ac4fa556868e0568d7ee3', 'hex'),
    'LINK_OFFER transcript digest has the independent registry vector'
  )

  const physical = Object.freeze({ id: 'guard-physical-channel', destroy() {} })
  const established = completeIndexZeroGuardLink(x.initiated.pending, x.accepted.accept, {
    advertisement: x.f.advertisement,
    physicalChannel: physical,
    now: NOW
  })
  const left = readM3EstablishedLink(established)
  const right = readM3EstablishedLink(x.accepted.established)

  t.is(left.physicalChannel, physical)
  t.is(left.extensionIndex, 0)
  t.is(left.branchClass, BRANCH_CLASS.LOOKUP)
  t.alike(left.branchId, x.linkSetup.branchId)
  t.alike(left.circuitId, x.linkSetup.circuitId)
  t.is(left.generation, 1n)
  t.alike(
    left.responderAdvertisementDigest,
    digestRelayCapabilityAdvertisement(x.f.advertisement, { now: NOW })
  )
  t.alike(left.contexts[0].tx.key, right.contexts[0].rx.key)
  t.alike(left.contexts[0].rx.key, right.contexts[0].tx.key)
  t.alike(
    left.contexts[0].tx.key,
    b4a.from('79d446bc8e1dc435118fea8ebb98f51144ed99a98f78019868dfe858536522c9', 'hex'),
    'KDF context has the fixed length-prefixed OFFER and ACCEPT digest vector'
  )

  destroyM3EstablishedLink(established)
  destroyM3EstablishedLink(x.accepted.established)
  t.exception(() => readM3EstablishedLink(established))
})

test('index-zero accept rejects replay, late completion, and M2 handles', (t) => {
  const x = exchange()
  const complete = (pending = x.initiated.pending, accept = x.accepted.accept) =>
    completeIndexZeroGuardLink(pending, accept, {
      advertisement: x.f.advertisement,
      physicalChannel: Object.freeze({ destroy() {} }),
      now: NOW
    })

  const established = complete()
  t.exception(() => complete(), 'pending is one-time')
  t.exception(
    () =>
      completeIndexZeroGuardLink(Object.freeze({}), x.accepted.accept, {
        advertisement: x.f.advertisement,
        physicalChannel: Object.freeze({ destroy() {} }),
        now: NOW
      }),
    'foreign or M2 topology-grant handles are not pending M3 offers'
  )
  destroyM3EstablishedLink(established)

  const y = exchange({ branchClass: BRANCH_CLASS.ANNOUNCE })
  t.exception(() =>
    completeIndexZeroGuardLink(y.initiated.pending, y.accepted.accept, {
      advertisement: y.f.advertisement,
      physicalChannel: Object.freeze({ destroy() {} }),
      now: 5_000n
    })
  )
  destroyM3EstablishedLink(y.accepted.established)
})

test('responder rejects every invalid index-zero offer binding before installing a link', (t) => {
  const mutations = [
    ['advertisement digest', (body) => (body[0] ^= 1)],
    ['initiator identity/signature', (body) => (body[32] ^= 1)],
    ['responder identity', (body) => (body[64] ^= 1)],
    ['initiator role', (body) => (body[96] = 1)],
    ['responder role', (body) => (body[97] = 2)],
    ['branch class', (body) => (body[98] = 2)],
    ['zero branch id', (body) => body.fill(0, 99, 115)],
    ['zero circuit id', (body) => body.fill(0, 115, 131)],
    ['zero generation', (body) => body.fill(0, 131, 139)],
    ['wrong index', (body) => (body[139] = 1)],
    ['zero link key', (body) => body.fill(0, 140, 172)],
    ['zero tail key', (body) => body.fill(0, 172, 204)],
    ['zero client nonce', (body) => body.fill(0, 204, 236)],
    ['zero parameter digest', (body) => body.fill(0, 236, 268)],
    ['nonzero parameter mismatch', (body) => (body[236] ^= 1)],
    ['bad cell size', (body) => body.fill(0, 268, 270)],
    ['zero max cells', (body) => body.fill(0, 270, 274)],
    ['over-advertised max bytes', (body) => body.fill(0xff, 274, 278)],
    ['expired deadline', (body) => body.fill(0, 294, 302)],
    ['deadline over five seconds', (body) => body.fill(0xff, 294, 302)]
  ]
  for (const [name, mutate] of mutations) {
    const x = exchange()
    const offer = resign(
      x.initiated.offer,
      M3_MESSAGE_ID.LINK_OFFER_V1,
      OFFER_DOMAIN,
      x.linkSetup.clientCircuitIdentity.secretKey,
      mutate
    )
    const responder = responderFor(
      x.f,
      () => ({
        offer,
        observedPredecessorEndpoint: x.observedPredecessorEndpoint,
        physicalChannel: Object.freeze({ destroy() {} })
      }),
      0x56
    )
    t.exception(() => responder.accept(), name)
    responder.destroy()
    destroyM3EstablishedLink(x.accepted.established)
    x.responder.destroy()
  }
})

test('responder receive authority is construction-bound and destroys invalid receives', (t) => {
  const x = exchange()
  t.is(x.responder.accept.length, 0, 'accept has no caller-supplied receive parameters')

  let substitutedCloses = 0
  const substituted = responderFor(x.f, () => ({
    offer: x.initiated.offer,
    observedPredecessorEndpoint: x.observedPredecessorEndpoint,
    observedPredecessorEndpointOverride: encodeCanonicalEndpoint({
      addressFamily: 4,
      addressBytes: b4a.from([203, 0, 113, 9]),
      port: 44000
    }),
    physicalChannel: Object.freeze({
      destroy() {
        substitutedCloses++
      }
    })
  }))
  t.exception(() => substituted.accept(), 'receive tuple rejects endpoint substitution fields')
  t.is(substitutedCloses, 1)
  substituted.destroy()

  let closes = 0
  const lowOrder = resign(
    x.initiated.offer,
    M3_MESSAGE_ID.LINK_OFFER_V1,
    OFFER_DOMAIN,
    x.linkSetup.clientCircuitIdentity.secretKey,
    (body) => {
      body.fill(0, 140, 172)
      body[140] = 1
    }
  )
  const lowOrderResponder = responderFor(x.f, () => ({
    offer: lowOrder,
    observedPredecessorEndpoint: x.observedPredecessorEndpoint,
    physicalChannel: Object.freeze({
      destroy() {
        closes++
      }
    })
  }))
  t.exception(() => lowOrderResponder.accept())
  t.is(closes, 1)
  lowOrderResponder.destroy()

  let tailCloses = 0
  const lowOrderTail = resign(
    x.initiated.offer,
    M3_MESSAGE_ID.LINK_OFFER_V1,
    OFFER_DOMAIN,
    x.linkSetup.clientCircuitIdentity.secretKey,
    (body) => {
      body.fill(0, 172, 204)
      body[172] = 1
    }
  )
  const lowOrderTailResponder = responderFor(x.f, () => ({
    offer: lowOrderTail,
    observedPredecessorEndpoint: x.observedPredecessorEndpoint,
    physicalChannel: Object.freeze({
      destroy() {
        tailCloses++
      }
    })
  }))
  t.exception(() => lowOrderTailResponder.accept())
  t.is(tailCloses, 1)
  lowOrderTailResponder.destroy()
  destroyM3EstablishedLink(x.accepted.established)
  x.responder.destroy()
})

test('responder reserves OFFER replay authority before recursive random providers', (t) => {
  const f = fixture()
  const initiated = createIndexZeroGuardLinkOffer({
    advertisement: f.advertisement,
    now: NOW,
    randomBytes: (size) => b4a.alloc(size, 0x44),
    ...setup()
  })
  const observedPredecessorEndpoint = encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([198, 51, 100, 10]),
    port: 44000
  })
  let responder = null
  let reentered = false
  let recursiveCode = null
  let recursiveAccepted = null
  let receiveCount = 0
  const closes = []
  responder = createIndexZeroGuardLinkResponder({
    advertisement: f.advertisement,
    responderIdentitySecretKey: f.guard.secretKey,
    responderRouteEncryptionSecretKey: f.route.secretKey,
    now: () => NOW,
    receiveOffer() {
      const index = receiveCount++
      closes[index] = 0
      return {
        offer: initiated.offer,
        observedPredecessorEndpoint,
        physicalChannel: Object.freeze({
          destroy() {
            closes[index]++
          }
        })
      }
    },
    randomBytes(size) {
      if (!reentered) {
        reentered = true
        try {
          recursiveAccepted = responder.accept()
        } catch (err) {
          recursiveCode = err && err.code
        }
      }
      return b4a.alloc(size, 0x57)
    }
  })

  const accepted = responder.accept()
  t.is(recursiveCode, 'ERR_REPLAY')
  t.is(receiveCount, 2)
  t.alike(closes, [0, 1], 'only the losing recursive physical channel is destroyed')
  destroyM3EstablishedLink(accepted.established)
  t.alike(closes, [1, 1], 'the winning channel transfers into exactly one established link')
  if (recursiveAccepted) destroyM3EstablishedLink(recursiveAccepted.established)
  responder.destroy()
  abortIndexZeroGuardLink(initiated.pending)
})

test('responder destroy invalidates an in-flight OFFER reservation', (t) => {
  const f = fixture()
  const initiated = createIndexZeroGuardLinkOffer({
    advertisement: f.advertisement,
    now: NOW,
    randomBytes: (size) => b4a.alloc(size, 0x44),
    ...setup()
  })
  let responder = null
  let closes = 0
  const generated = []
  responder = createIndexZeroGuardLinkResponder({
    advertisement: f.advertisement,
    responderIdentitySecretKey: f.guard.secretKey,
    responderRouteEncryptionSecretKey: f.route.secretKey,
    now: () => NOW,
    receiveOffer: () => ({
      offer: initiated.offer,
      observedPredecessorEndpoint: f.endpoint,
      physicalChannel: Object.freeze({
        destroy() {
          closes++
        }
      })
    }),
    randomBytes(size) {
      const bytes = b4a.alloc(size, 0x58 + generated.length)
      generated.push(bytes)
      if (generated.length === 1) responder.destroy()
      return bytes
    }
  })

  let code = null
  try {
    responder.accept()
  } catch (err) {
    code = err && err.code
  }
  t.is(code, 'ERR_DESTROYED')
  t.is(closes, 1, 'destroyed in-flight accepts close physical ownership exactly once')
  for (const bytes of generated) t.alike(bytes, b4a.alloc(bytes.byteLength))
  abortIndexZeroGuardLink(initiated.pending)
})

test('responder rejects a secret key for another advertised identity and destroy is terminal', (t) => {
  const f = fixture()
  const other = cryptoSuite.keyPair(seed(91))
  t.exception(() =>
    createIndexZeroGuardLinkResponder({
      advertisement: f.advertisement,
      responderIdentitySecretKey: other.secretKey,
      responderRouteEncryptionSecretKey: f.route.secretKey,
      now: () => NOW,
      receiveOffer: () => null
    })
  )
  const otherRoute = cryptoSuite.encryptionKeyPair(seed(92))
  t.exception(() =>
    createIndexZeroGuardLinkResponder({
      advertisement: f.advertisement,
      responderIdentitySecretKey: f.guard.secretKey,
      responderRouteEncryptionSecretKey: otherRoute.secretKey,
      now: () => NOW,
      receiveOffer: () => null
    })
  )

  const initiated = createIndexZeroGuardLinkOffer({
    advertisement: f.advertisement,
    now: NOW,
    randomBytes: (size) => b4a.alloc(size, 0x44),
    ...setup()
  })
  const responder = responderFor(f, () => ({
    offer: initiated.offer,
    observedPredecessorEndpoint: f.endpoint,
    physicalChannel: Object.freeze({ destroy() {} })
  }))
  responder.destroy()
  responder.destroy()
  let first = null
  let second = null
  try {
    responder.accept()
  } catch (err) {
    first = err
  }
  try {
    responder.accept()
  } catch (err) {
    second = err
  }
  t.is(first.code, 'ERR_DESTROYED')
  t.is(second.code, 'ERR_DESTROYED')
  abortIndexZeroGuardLink(initiated.pending)
})

test('initiator rejects every invalid accept binding and cross-offer substitution', (t) => {
  const mutations = [
    ['offer digest', (body) => (body[0] ^= 1)],
    ['advertisement digest', (body) => (body[32] ^= 1)],
    ['responder identity', (body) => (body[64] ^= 1)],
    ['zero observed endpoint', (body) => body.fill(0, 96, 115)],
    ['zero responder key', (body) => body.fill(0, 115, 147)],
    [
      'nonzero low-order responder key',
      (body) => {
        body.fill(0, 115, 147)
        body[115] = 1
      }
    ],
    ['over-limit cells', (body) => body.fill(0xff, 149, 153)],
    ['late accepted time', (body) => body.fill(0xff, 173, 181)],
    ['zero accept nonce', (body) => body.fill(0, 181, 213)]
  ]
  for (const [name, mutate] of mutations) {
    const x = exchange()
    let closes = 0
    const accept = resign(
      x.accepted.accept,
      M3_MESSAGE_ID.LINK_ACCEPT_V1,
      ACCEPT_DOMAIN,
      x.f.guard.secretKey,
      mutate
    )
    t.exception(
      () =>
        completeIndexZeroGuardLink(x.initiated.pending, accept, {
          advertisement: x.f.advertisement,
          physicalChannel: Object.freeze({
            destroy() {
              closes++
            }
          }),
          now: NOW
        }),
      name
    )
    t.is(closes, 1, `${name} closes physical ownership`)
    destroyM3EstablishedLink(x.accepted.established)
    x.responder.destroy()
  }

  const left = exchange({ branchClass: BRANCH_CLASS.LOOKUP })
  const right = exchange({ branchClass: BRANCH_CLASS.ANNOUNCE })
  t.exception(() =>
    completeIndexZeroGuardLink(left.initiated.pending, right.accepted.accept, {
      advertisement: left.f.advertisement,
      physicalChannel: Object.freeze({ destroy() {} }),
      now: NOW
    })
  )
  destroyM3EstablishedLink(left.accepted.established)
  destroyM3EstablishedLink(right.accepted.established)
  left.responder.destroy()
  right.responder.destroy()
})

test('destroy erases M3 link contexts and tail secret and closes physical ownership', (t) => {
  const x = exchange()
  let closes = 0
  const established = completeIndexZeroGuardLink(x.initiated.pending, x.accepted.accept, {
    advertisement: x.f.advertisement,
    physicalChannel: Object.freeze({
      destroy() {
        closes++
      }
    }),
    now: NOW
  })
  const state = readM3EstablishedLink(established)
  const forwardKey = state.contexts[0].tx.key
  const tailSecret = state.clientTailEphemeralSecretKey
  t.ok(destroyM3EstablishedLink(established))
  t.alike(forwardKey, b4a.alloc(32))
  t.alike(tailSecret, b4a.alloc(32))
  t.is(closes, 1)
  t.absent(destroyM3EstablishedLink(established))
  destroyM3EstablishedLink(x.accepted.established)
  x.responder.destroy()
})
