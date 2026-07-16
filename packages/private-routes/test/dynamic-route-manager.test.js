import test from 'brittle'
import b4a from 'b4a'

import {
  BootstrapIO,
  CAPACITY_CLASS,
  M3AdjacencyAuthority,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  RouteManager,
  cryptoSuite,
  decodeM3Object,
  decodeRelayCapabilityAdvertisement,
  deriveM3DhtNodeId,
  digestRelayCapabilityAdvertisement,
  encodeCanonicalEndpoint,
  encodeM3Object,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  signRelayCapabilityAdvertisement
} from '../index.js'
import {
  completeExtensionLink,
  createExtensionLinkOffer,
  createExtensionLinkResponder,
  createIndexZeroGuardLinkResponder,
  takeExtensionResponderAdjacency
} from '../lib/guard-link.js'
import { GuardRevalidationIO } from '../lib/guard-revalidation-io.js'
import {
  createExtensionOfferReceiver,
  createExtensionResponseReceiver
} from '../lib/extension-setup-channel.js'
import { createRedactedResponderProofAuthority } from '../lib/redacted-responder-proof.js'
import {
  createCurrentTailCandidateAdmissionAuthority,
  encodeRelayDiscoverResponse
} from '../lib/routed-candidate.js'
import { TEST_ONLY_DYNAMIC_OBSERVER } from '../lib/route-manager.js'
import { createTailControlSession } from '../lib/tail-control.js'
import { createTailExtensionCommitter } from '../lib/tail-extension-committer.js'
import { privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

const NOW = 1_000n
const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')

function writeUint64(target, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    target[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafe(10 + domain.byteLength + body.byteLength)
  output.writeUInt16BE(domain.byteLength, 0)
  domain.copy(output, 2)
  output.writeUInt32BE(1, 2 + domain.byteLength)
  output.writeUInt16BE(messageId, 6 + domain.byteLength)
  output.writeUInt16BE(body.byteLength, 8 + domain.byteLength)
  body.copy(output, 10 + domain.byteLength)
  return output
}

function endpoint(last, port = 44_000 + last) {
  return encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port
  })
}

function relayFixture({ identity, routeByte, endpointByte, capabilityMask }) {
  const route = cryptoSuite.encryptionKeyPair(seed(routeByte))
  const reachableEndpoint = endpoint(endpointByte)
  const advertisement = encodeRelayCapabilityAdvertisement(
    signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: deriveM3DhtNodeId(reachableEndpoint),
        reachableEndpoint,
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
      identity.secretKey
    )
  )
  return Object.freeze({ advertisement, identity, reachableEndpoint, route })
}

function sequence(first) {
  let value = first
  return (size) => b4a.alloc(size, value++)
}

function canonicalCapsResponse(fixture, queryNonce) {
  const body = b4a.allocUnsafe(75 + fixture.advertisement.byteLength)
  fixture.identity.publicKey.copy(body, 0)
  queryNonce.copy(body, 32)
  writeUint64(body, NOW, 64)
  body[72] = 1
  body.writeUInt16BE(fixture.advertisement.byteLength, 73)
  fixture.advertisement.copy(body, 75)
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.CAPS_RESPONSE_V1,
    body,
    authSuffix: cryptoSuite.sign(
      signatureInput(CAPS_RESPONSE_DOMAIN, M3_MESSAGE_ID.CAPS_RESPONSE_V1, body),
      fixture.identity.secretKey
    )
  })
}

function activeChallenge() {
  const body = b4a.alloc(176)
  writeUint64(body, 6_000n, 96)
  writeUint64(body, 5_000n, 136)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1, body })
}

function activeResponse() {
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1,
    body: b4a.alloc(272),
    authSuffix: b4a.alloc(64)
  })
}

function revalidationWire(fixture) {
  const packets = []
  let phaseZero = null
  return Object.freeze({
    async bind() {},
    async send(target, datagram) {
      const object = decodeM3Object(datagram)
      if (object.messageId === M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) {
        packets.push({ sourceEndpoint: b4a.from(target), datagram: activeResponse() })
        return
      }
      if (object.messageId !== M3_MESSAGE_ID.CAPS_QUERY_V1) throw new Error('unexpected request')
      if (object.body[69] === 0) {
        phaseZero = b4a.from(object.body)
        const body = b4a.alloc(72)
        object.body.subarray(36, 68).copy(body, 0)
        writeUint64(body, 5_000n, 32)
        seed(71).copy(body, 40)
        packets.push({
          sourceEndpoint: b4a.from(target),
          datagram: encodeM3Object({
            messageId: M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1,
            body
          })
        })
        return
      }
      if (!phaseZero || !b4a.equals(object.body.subarray(0, 69), phaseZero.subarray(0, 69))) {
        throw new Error('caps phase mismatch')
      }
      packets.push({
        sourceEndpoint: b4a.from(target),
        datagram: canonicalCapsResponse(fixture, object.body.subarray(36, 68))
      })
    },
    async receive() {
      return packets.length ? packets.shift() : new Promise(() => {})
    },
    abort() {},
    destroy() {}
  })
}

function guardCandidateChecker(validated, stateFactory) {
  const admissions = new WeakMap()
  let live = true
  return {
    isValidated: (value) => value === validated && live,
    reserveGuardAdmission(value, binding) {
      if (value !== validated || !live) throw new Error('spent validation')
      live = false
      const source = stateFactory()
      const admission = Object.freeze({})
      admissions.set(admission, {
        ...source,
        advertisementDigest: digestRelayCapabilityAdvertisement(source.advertisement, {
          now: NOW
        }),
        clientIdentity: b4a.from(binding.clientIdentity),
        branchClass: binding.branchClass,
        branchId: b4a.from(binding.branchId),
        circuitId: b4a.from(binding.circuitId),
        generation: binding.generation
      })
      return admission
    },
    readGuardAdmission(value) {
      if (!admissions.has(value)) throw new Error('spent admission')
      return admissions.get(value)
    },
    consumeGuardAdmission(value) {
      const state = this.readGuardAdmission(value)
      admissions.delete(value)
      return state
    },
    revokeGuardAdmission(value) {
      return admissions.delete(value)
    }
  }
}

function validatedState(fixture) {
  const decoded = decodeRelayCapabilityAdvertisement(fixture.advertisement, { now: NOW })
  return {
    ...decoded,
    relayIdentity: b4a.from(decoded.relayIdentity),
    reachableEndpoint: b4a.from(decoded.reachableEndpoint),
    routeEncryptionPublicKey: b4a.from(decoded.routeEncryptionPublicKey),
    advertisement: b4a.from(fixture.advertisement),
    challengeExpiresAtMs: 5_000n,
    cookieExpiresAtMs: 5_000n,
    queryNonce: b4a.alloc(32, 0xa1),
    returnRoutabilityCookie: b4a.alloc(32, 0xa2)
  }
}

function revalidationDirectory(fixture) {
  const validated = Object.freeze({})
  const admissions = new WeakMap()
  const directory = guardCandidateChecker(validated, () => validatedState(fixture))
  directory.admit = (advertisement, { observedEndpoint, capsBinding }) => {
    const admitted = Object.freeze({})
    admissions.set(admitted, {
      advertisement: b4a.from(advertisement),
      reachableEndpoint: b4a.from(observedEndpoint),
      capsBinding: Object.freeze({
        queryNonce: b4a.from(capsBinding.queryNonce),
        cookieExpiresAtMs: capsBinding.cookieExpiresAtMs,
        returnRoutabilityCookie: b4a.from(capsBinding.returnRoutabilityCookie)
      })
    })
    return admitted
  }
  directory.isAdmitted = (value) => admissions.has(value)
  directory.readAdmitted = (value) => admissions.get(value)
  directory.validate = async (admitted, challenge) => {
    await challenge(activeChallenge())
    return admissions.has(admitted) ? validated : null
  }
  directory.read = (value) => {
    if (value !== validated) throw new Error('not validated')
    return validatedState(fixture)
  }
  return directory
}

function forwardingRecord() {
  let live = true
  return Object.freeze({
    diagnostics() {
      if (!live) throw new Error('destroyed')
      return Object.freeze({ state: 'CREATE', expiresAt: 5_000n })
    },
    destroy() {
      if (!live) return false
      live = false
      return true
    }
  })
}

function remoteTail(capability, runtime, fixture, resources) {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const adjacencyAuthority = new M3AdjacencyAuthority({
    now: () => Number(NOW),
    crypto: cryptoSuite
  })
  const forwarding = forwardingRecord()
  const state = {
    admissions,
    adjacencyAuthority,
    fixture,
    forwarding,
    installedRuntime: null,
    runtime,
    tailControl: null
  }
  const extensionCommitter = createTailExtensionCommitter({
    enqueue(envelope) {
      state.extensionQueue.push(envelope)
    },
    install(nextRuntime) {
      state.installedRuntime = nextRuntime
      return forwarding
    },
    destroy() {}
  })
  state.extensionQueue = []
  state.tailControl = createTailControlSession(capability, {
    now: () => NOW,
    crypto: cryptoSuite,
    candidateAdmissionProducer: admissions.producer,
    candidateAdmissionConsumer: admissions.consumer,
    adjacencyAuthority,
    extensionCommitter
  })
  resources.push(state)
  return state
}

function guardHandshake(fixture, responderAuthority, resources, randomByte) {
  let receivedOffer = null
  let accepted = null
  const responder = createIndexZeroGuardLinkResponder({
    advertisement: fixture.advertisement,
    responderIdentitySecretKey: fixture.identity.secretKey,
    responderRouteEncryptionSecretKey: fixture.route.secretKey,
    now: () => NOW,
    randomBytes: sequence(randomByte),
    receiveOffer: () => ({
      offer: receivedOffer,
      observedPredecessorEndpoint: fixture.reachableEndpoint,
      physicalChannel: Object.freeze({ destroy() {} })
    })
  })
  return Object.freeze({
    async openGuard() {
      return Object.freeze({
        async sendOffer(value) {
          receivedOffer = b4a.from(value)
        },
        async receiveAccept() {
          accepted = responder.accept()
          return accepted.accept
        },
        async receiveReady() {
          const adopted = responderAuthority.adopt(accepted.established)
          const remote = remoteTail(adopted.tail, adopted.runtime, fixture, resources)
          return remote.tailControl.sealReady({
            identitySecretKey: fixture.identity.secretKey,
            randomBytes: sequence(randomByte + 20)
          })
        },
        takePhysicalChannel() {
          return Object.freeze({ destroy() {} })
        },
        destroy() {}
      })
    }
  })
}

function extensionTransport(initial, successors, resources) {
  let current = initial
  let phase = 'DISCOVER'
  let successorIndex = 0
  const receiveQueue = []
  let destroyed = false
  return Object.freeze({
    async send(envelope) {
      if (destroyed) throw new Error('destroyed')
      if (phase === 'DISCOVER') {
        const request = current.tailControl.openDiscoverRequest(envelope)
        const successor = successors[successorIndex]
        const responses = current.tailControl.sealDiscoverResponse({
          encodedResponse: encodeRelayDiscoverResponse({
            queryNonce: request.queryNonce,
            responseTimeMs: NOW,
            advertisements: [successor.advertisement]
          }),
          randomBytes: sequence(0x71 + successorIndex * 8)
        })
        receiveQueue.push(...responses)
        phase = 'EXTEND'
        return
      }

      const successorFixture = successors[successorIndex++]
      const admitted = current.tailControl.openExtendRequest(envelope)
      const extension = createExtensionLinkOffer(admitted, {
        initiatorIdentitySecretKey: current.fixture.identity.secretKey,
        now: NOW,
        randomBytes: sequence(0x81 + successorIndex * 8)
      })
      const setupObjects = []
      const successorAuthority = new M3AdjacencyAuthority({
        now: () => Number(NOW),
        crypto: cryptoSuite
      })
      const responder = createExtensionLinkResponder({
        advertisement: successorFixture.advertisement,
        adjacencyAdopter: successorAuthority.responderAdopter(),
        responderIdentitySecretKey: successorFixture.identity.secretKey,
        responderRouteEncryptionSecretKey: successorFixture.route.secretKey,
        now: () => NOW,
        offerReceiver: createExtensionOfferReceiver({
          observedPredecessorEndpoint: current.fixture.reachableEndpoint,
          receiveObject: (() => {
            const objects = [extension.offer, null]
            return () => objects.shift()
          })(),
          takePhysicalChannel: () => Object.freeze({ destroy() {} }),
          sendObject: (object) => setupObjects.push(object),
          finish: () => setupObjects.push(null),
          destroy() {}
        }),
        randomBytes: sequence(0x91 + successorIndex * 8)
      })
      const accepted = responder.accept()
      const successor = takeExtensionResponderAdjacency(responder, accepted.accepted)
      const proofAuthority = createRedactedResponderProofAuthority({ now: () => NOW })
      const completed = completeExtensionLink(extension.pending, {
        now: () => NOW,
        proofVerifier: proofAuthority.verifier,
        proofConsumer: proofAuthority.consumer,
        setupReceiver: createExtensionResponseReceiver({
          receiveObject: () => setupObjects.shift(),
          takePhysicalChannel: () => Object.freeze({ destroy() {} }),
          destroy() {}
        })
      })
      current.tailControl.sealExtended(completed, {
        randomBytes: sequence(0xa1 + successorIndex * 8)
      })
      receiveQueue.push(...current.extensionQueue.splice(0))
      const next = remoteTail(successor.tail, successor.runtime, successorFixture, resources)
      receiveQueue.push(
        next.tailControl.sealReady({
          identitySecretKey: successorFixture.identity.secretKey,
          randomBytes: sequence(0xb1 + successorIndex * 8)
        })
      )
      responder.destroy()
      proofAuthority.destroy()
      current = next
      phase = 'DISCOVER'
    },
    async receive() {
      if (destroyed || receiveQueue.length === 0) throw new Error('no routed response')
      return receiveQueue.shift()
    },
    destroy() {
      if (destroyed) return false
      destroyed = true
      return true
    }
  })
}

function destroyRemoteResources(resources) {
  for (const state of resources) {
    try {
      state.tailControl.destroy()
    } catch {}
    try {
      state.runtime.destroy()
    } catch {}
    try {
      if (state.installedRuntime) state.installedRuntime.destroy()
    } catch {}
    try {
      state.forwarding.destroy()
    } catch {}
    try {
      state.admissions.destroy()
    } catch {}
  }
}

test('dynamic manager constructs two authenticated three-hop branches', async (t) => {
  const relay = RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const exit = relay | RELAY_CAPABILITY.DHT_EXIT_V1
  const guard = relayFixture({
    identity: safetyRoleIdentity(10),
    routeByte: 11,
    endpointByte: 10,
    capabilityMask: relay
  })
  const successors = [
    [
      relayFixture({
        identity: safetyRoleIdentity(30),
        routeByte: 31,
        endpointByte: 30,
        capabilityMask: relay
      }),
      relayFixture({
        identity: privateRoleIdentity(50),
        routeByte: 51,
        endpointByte: 50,
        capabilityMask: exit
      })
    ],
    [
      relayFixture({
        identity: safetyRoleIdentity(70),
        routeByte: 71,
        endpointByte: 70,
        capabilityMask: relay
      }),
      relayFixture({
        identity: privateRoleIdentity(90),
        routeByte: 91,
        endpointByte: 90,
        capabilityMask: exit
      })
    ]
  ]
  const resources = []
  const initialRemotes = []
  const observer = []
  const clientAuthority = new M3AdjacencyAuthority({
    now: () => Number(NOW),
    crypto: cryptoSuite
  })
  const guardResponderAuthority = new M3AdjacencyAuthority({
    now: () => Number(NOW),
    crypto: cryptoSuite
  })
  const validated = Object.freeze({})
  let actorFailure = null
  const manager = RouteManager.createDynamic({
    adjacencyAuthority: clientAuthority,
    bootstrapIOFactory(request) {
      const io = new BootstrapIO({
        socketFactory: () => ({
          async bind() {},
          async send() {},
          async receive() {},
          abort() {},
          destroy() {}
        }),
        candidateChecker: guardCandidateChecker(validated, () => validatedState(guard)),
        configuredBootstraps: [guard.reachableEndpoint],
        guardHandshakeFactory: guardHandshake(guard, guardResponderAuthority, resources, 0xc1),
        constructionRequest: request,
        now: () => NOW,
        randomBytes: sequence(0xd1)
      })
      return Object.freeze({
        async open() {
          try {
            await io.ready()
            const transfer = await io.pinGuard(validated)
            initialRemotes.push(resources.at(-1))
            return transfer
          } catch (err) {
            actorFailure = err
            throw err
          }
        },
        destroy() {
          return io.destroy()
        }
      })
    },
    guardRevalidationIOFactory(request) {
      const directory = revalidationDirectory(guard)
      const io = new GuardRevalidationIO({
        constructionRequest: request,
        socketFactory: () => revalidationWire(guard),
        directory,
        guardHandshakeFactory: guardHandshake(guard, guardResponderAuthority, resources, 0xe1),
        now: () => NOW,
        randomBytes: sequence(0xf1)
      })
      return Object.freeze({
        async open() {
          try {
            const transfer = await io.open()
            initialRemotes.push(resources.at(-1))
            return transfer
          } catch (err) {
            actorFailure = err
            throw err
          }
        },
        destroy() {
          return io.destroy()
        }
      })
    },
    tailControlTransportFactory() {
      const index = initialRemotes.length === 2 ? transports.length : -1
      if (index < 0 || index > 1) {
        actorFailure = new Error(
          `unexpected transport initial=${initialRemotes.length} transports=${transports.length}`
        )
        throw actorFailure
      }
      const actor = extensionTransport(initialRemotes[index], successors[index], resources)
      const transport = Object.freeze({
        async send(value) {
          try {
            return await actor.send(value)
          } catch (err) {
            actorFailure = err
            throw err
          }
        },
        async receive() {
          try {
            return await actor.receive()
          } catch (err) {
            actorFailure = err
            throw err
          }
        },
        destroy() {
          return actor.destroy()
        }
      })
      transports.push(transport)
      return transport
    },
    routedDiscoveryService: Object.freeze({
      async request() {
        discoveryCalls++
      }
    }),
    now: () => NOW,
    schedule: setTimeout,
    cancel: clearTimeout,
    randomBytes: sequence(0x21),
    crypto: cryptoSuite,
    limits: Object.freeze({}),
    [TEST_ONLY_DYNAMIC_OBSERVER](event) {
      observer.push(event)
    }
  })
  const transports = []
  let discoveryCalls = 0
  let branches = null
  try {
    try {
      branches = await manager.openDynamic()
    } catch (err) {
      throw actorFailure || err
    }
    t.ok(Object.isFrozen(branches))
    t.alike(Object.keys(branches), ['destroy'])
    t.is(transports.length, 2, 'one logical tail transport is reused per branch')
    t.is(discoveryCalls, 4, 'each branch performs one routed discovery per extension')
    t.alike(
      observer
        .filter((event) => event.type === 'extension-ready')
        .map((event) => `${event.resource}:${event.extensionIndex}`)
        .sort(),
      ['announce:1', 'announce:2', 'lookup:1', 'lookup:2']
    )
    t.is(
      observer.at(-1).type,
      'guard-ready',
      'the manager publishes only after both exits authenticate readiness'
    )
    t.ok(branches.destroy())
    t.is(branches.destroy(), false)
    branches = null
  } finally {
    if (branches) branches.destroy()
    manager.destroy()
    destroyRemoteResources(resources)
  }
})
