import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  CELL_SIZE,
  CellCodec,
  DIRECTION,
  DEFAULT_MAX_ACTOR_CIRCUITS,
  PROTOCOL_VERSION,
  ROLE,
  RelayService,
  RouteManager,
  VirtualNetwork,
  buildPrivateTemplates,
  createCircuitAuthority,
  createDestinationReplayCache,
  createLinkSetupAuthority,
  createPrivateDestinationActor,
  createPrivateRelayActor,
  createPrivateRouteCompiler,
  createPrivateSafetyEntryAttachment,
  createRouteCandidateAuthority,
  createRouteCompilerAuthority,
  createSafetyInstallerAuthority,
  cryptoSuite,
  destroyPrivateDestinationActor,
  destroyPrivateRelayActor,
  encodeDescriptor,
  encodeRelayAdvertisement,
  registerPrivateRoute,
  sendPrivateDestinationDatagram,
  sendPrivateDestinationStream,
  signDescriptor,
  signRelayAdvertisement,
  verifyDescriptor
} from '../index.js'
import {
  TEST_ONLY_ROUTE_FRAME_OBSERVER,
  TEST_ONLY_ROUTE_PAYLOAD_COUNTERS
} from '../lib/activation.js'
import { TEST_ONLY_RELAY_OBSERVER } from '../lib/relay-service.js'
import { LINK_CREATED_SIZE, LINK_CREATE_SIZE } from '../lib/link-setup.js'
import { createCompiledRouteSimulator } from '../lib/route-manager.js'
import {
  descriptorChecker,
  expectCode,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'

const ROUTE_ROTATE_AT = (1n << 63n) - 1n - 1024n
const MAX_ROUTE_LOGICAL_COUNTER = (1n << 63n) - 1n

function sequenceBytes(start) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function monotonicBytes(start) {
  let value = BigInt(start)
  return (size) => {
    const output = b4a.alloc(size, Number(value & 0xffn) || 1)
    let remaining = value++
    for (let index = size - 1; index >= 0 && remaining > 0n; index--) {
      output[index] = Number(remaining & 0xffn)
      remaining >>= 8n
    }
    return output
  }
}

function privateRelay(start, dial, epoch = 7n) {
  const identity = privateRoleIdentity(start)
  const encryption = cryptoSuite.encryptionKeyPair(seed(start + 80))
  const advertisement = signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: identity.publicKey,
      routeEncryptionKey: encryption.publicKey,
      dial: b4a.from(dial),
      role: ROLE.PRIVATE,
      capabilities: CAPABILITY.KNOWN,
      epoch,
      expiresAt: 10_000n
    },
    identity.secretKey
  )
  return { identity, encryption, advertisement, dial }
}

function publicActorRouteFixture({
  sourceSenderInitial,
  rotationAlreadyRequested = false,
  maxSafetyCircuitQueuedBytes,
  routeCandidateProvider,
  higherEpochReplacement = false,
  longRunRandom = false
} = {}) {
  let now = 1_000
  let autoFlush = true
  let networkPending = 0
  let safetyNetworkPending = 0
  let flushingNetwork = false
  let activeSafetyRoutes = 0
  let safetyEntryAttachments = 0
  let rejectActorTransmission = false
  let queuedActorSetupSize = 0
  let queuedActorSetup = 0
  let cancelledActorSetup = 0
  let latePayloadTarget = 0
  let latePayloadSeen = 0
  let queuedLatePayloads = 0
  let cancelledLatePayloads = 0
  let stallSafetyForward = false
  const retainedActorSetupCallbacks = []
  const retainedLatePayloads = []
  const safetyEvents = []
  const actorEvents = []
  const destinationEvents = []
  const atDestinationStream = []
  const atDestinationDatagram = []
  const atSourceStream = []
  const atSourceDatagram = []
  const circuitIds = []
  const routeFrames = []
  const relayFrames = []
  const candidateProviderCalls = []
  const installedSafetyEpochs = []
  const drainTimers = new Set()
  const safetyZeroizations = []
  const network = new VirtualNetwork({ now })
  const sourceDestinationReplayCache = createDestinationReplayCache({
    now: () => now,
    maxEntries: DEFAULT_MAX_ACTOR_CIRCUITS
  })
  const sourceNode = 'compiled-source'
  const safetyGuardNode = 'compiled-safety-guard'
  const safetyNode = 'compiled-safety-final'
  const privateNodes = [
    'compiled-private-entry',
    'compiled-private-middle',
    'compiled-private-final'
  ]
  const destinationNode = 'compiled-destination'
  const unrelatedSourceNode = 'compiled-unrelated-source'
  const unrelatedDestinationNode = 'compiled-unrelated-destination'
  const unrelatedDeliveries = []
  const actorNodes = new Map()
  const actorTransmissions = []
  const sourceIdentity = cryptoSuite.keyPair(seed(180))
  const safetyRelays = [
    {
      identity: safetyRoleIdentity(1),
      encryption: cryptoSuite.encryptionKeyPair(seed(232)),
      node: safetyGuardNode
    },
    {
      identity: safetyRoleIdentity(20),
      encryption: cryptoSuite.encryptionKeyPair(seed(233)),
      node: safetyNode
    }
  ]
  const safetyAttachmentRandom = sequenceBytes(520)
  const networkDeliveries = new Map(
    [safetyNode, ...privateNodes, destinationNode].map((node) => [node, []])
  )
  const safetyNetworkDeliveries = new Map(
    [sourceNode, safetyGuardNode, safetyNode].map((node) => [node, []])
  )

  function deliverActorCell(node, packet) {
    const queue = networkDeliveries.get(node)
    const receive = queue && queue.shift()
    if (!receive) return false
    networkPending--
    receive(packet)
    return true
  }

  function flushNetwork() {
    if (!autoFlush || flushingNetwork) return
    flushingNetwork = true
    try {
      network.flush()
    } finally {
      flushingNetwork = false
    }
  }

  function scheduleDrain(callback, delay) {
    const timer = { at: now + delay, callback }
    drainTimers.add(timer)
    return timer
  }

  function cancelDrain(timer) {
    drainTimers.delete(timer)
  }

  function runDrainTimers() {
    for (const timer of Array.from(drainTimers)) {
      if (timer.at > now) continue
      drainTimers.delete(timer)
      timer.callback()
    }
  }

  function queueNetwork(from, to, packet) {
    networkPending++
    const cancellation = network.sendOwned(from, to, packet)
    flushNetwork()
    return cancellation
  }

  function queueSafetyNetwork(from, to, packet, receive, cancellations) {
    const token = { completed: false, receive }
    safetyNetworkDeliveries.get(to).push(token)
    safetyNetworkPending++
    try {
      const networkCancellation = queueNetwork(from, to, packet)
      let cancellation = null
      cancellation = Object.freeze({
        cancel() {
          if (token.completed) return 0
          const cancelled = networkCancellation.cancel()
          if (cancelled === 0) return 0
          token.completed = true
          const queue = safetyNetworkDeliveries.get(to)
          const index = queue.indexOf(token)
          if (index !== -1) queue.splice(index, 1)
          safetyNetworkPending--
          networkPending--
          return cancelled
        }
      })
      if (cancellations) cancellations.add(cancellation)
      return cancellation
    } catch (err) {
      if (!token.completed) {
        token.completed = true
        const queue = safetyNetworkDeliveries.get(to)
        const index = queue.indexOf(token)
        if (index !== -1) queue.splice(index, 1)
        safetyNetworkPending--
        networkPending--
      }
      throw err
    }
  }

  function takeSafetyNetwork(node) {
    const token = safetyNetworkDeliveries.get(node).shift()
    if (!token) throw new Error(`missing Safety delivery token at ${node}`)
    return token
  }

  function completeSafetyNetwork(token) {
    if (token.completed) throw new Error('Safety delivery completed twice')
    token.completed = true
    safetyNetworkPending--
    networkPending--
  }

  function transmitActorCell(from, to, packet, receive, synchronous = false) {
    const fromNode = typeof from === 'string' ? from : actorNodes.get(from)
    const toNode = typeof to === 'string' ? to : actorNodes.get(to)
    if (fromNode && toNode)
      actorTransmissions.push({ from: fromNode, to: toNode, bytes: packet.byteLength })
    if (rejectActorTransmission && typeof from !== 'string' && typeof to !== 'string') return false
    if (
      queuedActorSetupSize === packet.byteLength &&
      typeof from !== 'string' &&
      typeof to !== 'string'
    ) {
      retainedActorSetupCallbacks.push(receive)
      queuedActorSetup++
      return Object.freeze({
        cancel() {
          if (queuedActorSetup === 0) return 0
          queuedActorSetup--
          cancelledActorSetup++
          return 1
        }
      })
    }
    const queue = networkDeliveries.get(toNode)
    if (!fromNode || !toNode || !queue || typeof receive !== 'function') return false
    if (!synchronous && latePayloadTarget > 0 && packet.byteLength === CELL_SIZE) {
      latePayloadSeen++
      if (latePayloadSeen === latePayloadTarget) {
        const retained = {
          live: true,
          packet: b4a.from(packet),
          receive
        }
        retainedLatePayloads.push(retained)
        queuedLatePayloads++
        return Object.freeze({
          cancel() {
            if (!retained.live) return 0
            retained.live = false
            queuedLatePayloads--
            cancelledLatePayloads++
            return 1
          }
        })
      }
    }
    if (!synchronous) {
      queue.push(receive)
      const networkCancellation = queueNetwork(fromNode, toNode, packet)
      let cancellation = null
      cancellation = Object.freeze({
        cancel() {
          const cancelled = networkCancellation.cancel()
          if (cancelled === 0) return 0
          const index = queue.indexOf(receive)
          if (index !== -1) queue.splice(index, 1)
          networkPending--
          return cancelled
        }
      })
      return cancellation
    }
    // The public activation API is synchronous today. Record the real VNet edge
    // and packet, while the adapter completes authenticated CONTROL delivery
    // before returning to the compiler.
    queue.push(() => true)
    queueNetwork(fromNode, toNode, packet)
    receive(packet)
    return true
  }

  function safetyEndpoint(checker, ticket) {
    const state = checker.take(ticket)
    const codec = new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    })
    let live = true
    const fingerprint = cryptoSuite.hash([
      state.circuitId,
      state.localId,
      state.peerLocalId,
      ...Object.values(state.contexts).flatMap((pair) => [
        pair.tx.key,
        pair.tx.noncePrefix,
        pair.rx.key,
        pair.rx.noncePrefix
      ])
    ])
    const bindingFingerprint = b4a.toString(fingerprint, 'hex')
    fingerprint.fill(0)
    return {
      snapshot() {
        return bindingFingerprint
      },
      nextCounter(cellClass) {
        return state.contexts[cellClass].tx.counter.value
      },
      seal(cellClass, direction, payload) {
        const context = state.contexts[cellClass].tx
        return codec.seal({
          key: context.key,
          noncePrefix: context.noncePrefix,
          senderCounter: context.counter,
          class: cellClass,
          direction,
          epoch: state.epoch,
          circuitId: state.peerLocalId,
          payload
        })
      },
      open(cellClass, direction, packet) {
        const context = state.contexts[cellClass].rx
        return codec.open(
          {
            key: context.key,
            noncePrefix: context.noncePrefix,
            receiver: context.counter,
            expectedClass: cellClass,
            expectedDirection: direction,
            expectedEpoch: state.epoch,
            expectedCircuitId: state.localId
          },
          packet
        )
      },
      destroy() {
        if (!live) return
        live = false
        for (const pair of Object.values(state.contexts)) {
          for (const context of [pair.tx, pair.rx]) {
            context.key.fill(0)
            context.noncePrefix.fill(0)
            context.counter.destroy()
          }
        }
        state.circuitId.fill(0)
        state.localId.fill(0)
        state.peerLocalId.fill(0)
      }
    }
  }

  const linkAuthority = createLinkSetupAuthority({
    now: () => now,
    randomBytes: sequenceBytes(600)
  })
  const safetyLinks = []
  const safetyRelayRecords = new Set()
  let safetyRelay = null

  network.register(sourceNode, (packet) => {
    const token = takeSafetyNetwork(sourceNode)
    try {
      if (token.receive) token.receive(packet)
    } finally {
      completeSafetyNetwork(token)
    }
  })
  network.register(safetyGuardNode, (packet) => {
    const token = takeSafetyNetwork(safetyGuardNode)
    try {
      if (token.receive) token.receive(packet)
    } finally {
      completeSafetyNetwork(token)
    }
  })
  network.register(safetyNode, (packet) => {
    if (deliverActorCell(safetyNode, packet)) return
    const token = takeSafetyNetwork(safetyNode)
    try {
      if (token.receive) token.receive(packet)
    } finally {
      completeSafetyNetwork(token)
    }
  })
  for (const node of [...privateNodes, destinationNode])
    network.register(node, (packet) => {
      if (!deliverActorCell(node, packet)) throw new Error(`unexpected actor cell at ${node}`)
    })
  network.register(unrelatedSourceNode, () => {})
  network.register(unrelatedDestinationNode, (packet) => {
    networkPending--
    unrelatedDeliveries.push(b4a.from(packet))
  })

  function buildSafetyLink(index, binding) {
    const initiator = index === 0 ? { identity: sourceIdentity } : safetyRelays[index - 1]
    const responder = safetyRelays[index]
    const common = {
      circuitId: binding.circuitId,
      epoch: binding.epoch,
      initiatorIdentity: initiator.identity.publicKey,
      responderIdentity: responder.identity.publicKey,
      initiatorLocalId: b4a.alloc(16, 0x40 + index * 2),
      responderLocalId: b4a.alloc(16, 0x41 + index * 2),
      expiresAt: binding.expiresAt
    }
    const started = linkAuthority.initiate({
      ...common,
      responderStaticKey: responder.encryption.publicKey,
      initiatorIdentitySecretKey: initiator.identity.secretKey
    })
    const accepted = linkAuthority.respond(started.message, {
      ...common,
      responderStaticSecretKey: responder.encryption.secretKey,
      responderIdentitySecretKey: responder.identity.secretKey
    })
    return {
      common,
      createMessage: b4a.from(started.message),
      createdMessage: b4a.from(accepted.message),
      initiatorTicket: linkAuthority.complete(started.pending, accepted.message),
      responderTicket: accepted.ticket
    }
  }

  function attachEntry(request) {
    safetyEntryAttachments++
    const attachment = createPrivateSafetyEntryAttachment({
      ...request,
      finalSafetyIdentity: safetyRelays[1].identity.publicKey,
      finalSafetyIdentitySecretKey: safetyRelays[1].identity.secretKey,
      now: () => now,
      randomBytes: safetyAttachmentRandom,
      transmit(direction, packet, receive) {
        return transmitActorCell(
          direction === DIRECTION.FORWARD ? safetyNode : request.entryActor,
          direction === DIRECTION.FORWARD ? request.entryActor : safetyNode,
          packet,
          receive
        )
      }
    })
    return {
      attachment,
      release() {
        safetyEntryAttachments--
      }
    }
  }

  function registrationSafetyRoute() {
    let entry = null
    return {
      attachEntry(request) {
        const value = attachEntry(request)
        entry = value
        return Object.freeze({
          destroy() {
            if (!entry) return
            entry.attachment.destroy()
            entry.release()
            entry = null
          }
        })
      },
      sendControl(fragments, deliver) {
        return entry.attachment.sendControl(fragments, deliver)
      },
      sendReverseFrame(cellClass, frame, deliver) {
        return entry.attachment.sendReverseFrame(cellClass, frame, deliver)
      },
      destroy() {
        if (!entry) return
        entry.attachment.destroy()
        entry.release()
        entry = null
      }
    }
  }

  function finalizedSafetyRoute() {
    let live = true
    let entry = null
    const routeRelay = safetyRelay
    const routeLinks = safetyLinks.slice()
    const forwardDeliveries = []
    const reverseDeliveries = []
    const cancellations = new Set()
    let sourceEndpoint = safetyEndpoint(linkAuthority.checker, routeLinks[0].initiatorTicket)
    let finalEndpoint = safetyEndpoint(linkAuthority.checker, routeLinks[1].responderTicket)
    routeRelay.cancellations = cancellations
    routeRelay.sourceReceive = (packet) => {
      const pending = reverseDeliveries.shift()
      if (!pending) throw new Error('missing reverse Safety delivery')
      const delivery = sourceEndpoint.open(pending.cellClass, DIRECTION.REVERSE, packet)
      let opened = pending.cellClass === CELL_CLASS.DATAGRAM ? delivery : delivery[0]
      try {
        pending.deliver(opened)
      } finally {
        opened.fill(0)
        opened = null
      }
    }
    routeRelay.finalReceive = (packet) => {
      const pending = forwardDeliveries.shift()
      if (!pending) throw new Error('missing forward Safety delivery')
      const delivery = finalEndpoint.open(pending.cellClass, DIRECTION.FORWARD, packet)
      let opened = pending.cellClass === CELL_CLASS.DATAGRAM ? delivery : delivery[0]
      try {
        if (pending.cellClass !== CELL_CLASS.CONTROL && opened.byteLength === 1100)
          relayFrames.push({
            relay: 'safety-final',
            direction: DIRECTION.FORWARD,
            cellClass: pending.cellClass,
            frame: b4a.from(opened),
            keys: ['afterHash', 'beforeHash', 'byteLength', 'class', 'direction', 'frame', 'type']
          })
        pending.deliver(opened)
      } finally {
        opened.fill(0)
        opened = null
      }
    }
    activeSafetyRoutes++
    safetyRelayRecords.add(routeRelay)
    routeRelay.service.created(sourceIdentity.publicKey, routeLinks[0].common.responderLocalId)
    routeRelay.service.open(sourceIdentity.publicKey, routeLinks[0].common.responderLocalId)
    const transcriptHash32 = cryptoSuite.hash(
      routeLinks.flatMap((link) => [link.createMessage, link.createdMessage])
    )
    function sendForward(cellClass, payload, deliver) {
      const counter = sourceEndpoint.nextCounter(cellClass)
      const packet = sourceEndpoint.seal(cellClass, DIRECTION.FORWARD, payload)
      safetyEvents.push({
        type: 'safety-frame',
        cellClass,
        direction: DIRECTION.FORWARD,
        packetBytes: packet.byteLength,
        counter,
        bindingFingerprint: sourceEndpoint.snapshot()
      })
      forwardDeliveries.push({ cellClass, deliver })
      queueSafetyNetwork(
        sourceNode,
        safetyGuardNode,
        packet,
        (received) => routeRelay.service.receive(sourceIdentity.publicKey, received),
        cancellations
      )
      packet.fill(0)
      return true
    }
    return {
      transcriptHash32,
      attachEntry(request) {
        if (entry) throw new Error('entry is already attached')
        entry = attachEntry(request)
        return Object.freeze({
          destroy() {
            if (!entry) return
            entry.attachment.destroy()
            entry.release()
            entry = null
          }
        })
      },
      sendControl(fragments, deliver) {
        let result
        for (const fragment of fragments)
          sendForward(CELL_CLASS.CONTROL, fragment, (value) => {
            const accepted = entry.attachment.sendControl([value], deliver)
            if (accepted !== undefined) result = accepted
          })
        return result === undefined ? true : result
      },
      sendFrame(cellClass, frame, deliver) {
        return sendForward(cellClass, frame, (value) =>
          entry.attachment.sendFrame(cellClass, value, deliver)
        )
      },
      sendReverseFrame(cellClass, frame, deliver) {
        return entry.attachment.sendReverseFrame(cellClass, frame, (value) => {
          if (cellClass !== CELL_CLASS.CONTROL && value.byteLength === 1100)
            relayFrames.push({
              relay: 'safety-final',
              direction: DIRECTION.REVERSE,
              cellClass,
              frame: b4a.from(value),
              keys: ['afterHash', 'beforeHash', 'byteLength', 'class', 'direction', 'frame', 'type']
            })
          const counter = finalEndpoint.nextCounter(cellClass)
          const packet = finalEndpoint.seal(cellClass, DIRECTION.REVERSE, value)
          safetyEvents.push({
            type: 'safety-frame',
            cellClass,
            direction: DIRECTION.REVERSE,
            packetBytes: packet.byteLength,
            counter,
            bindingFingerprint: finalEndpoint.snapshot()
          })
          reverseDeliveries.push({ cellClass, deliver })
          queueSafetyNetwork(
            safetyNode,
            safetyGuardNode,
            packet,
            (received) => routeRelay.service.receive(safetyRelays[1].identity.publicKey, received),
            cancellations
          )
          packet.fill(0)
          return true
        })
      },
      destroy() {
        if (!live) return
        live = false
        if (entry) {
          entry.attachment.destroy()
          entry.release()
          entry = null
        }
        sourceEndpoint.destroy()
        finalEndpoint.destroy()
        sourceEndpoint = null
        finalEndpoint = null
        forwardDeliveries.length = 0
        reverseDeliveries.length = 0
        routeRelay.service.destroy(sourceIdentity.publicKey, routeLinks[0].common.responderLocalId)
        for (const cancellation of cancellations) cancellation.cancel()
        cancellations.clear()
        routeRelay.cancellations = null
        routeRelay.sourceReceive = null
        routeRelay.finalReceive = null
        safetyRelayRecords.delete(routeRelay)
        activeSafetyRoutes--
        flushNetwork()
      }
    }
  }

  const owner = cryptoSuite.keyPair(seed(210))
  const descriptorId = seed(211)
  const destinationEncryption = cryptoSuite.encryptionKeyPair(seed(229))
  const relays = [
    privateRelay(1, 'compiled-entry'),
    privateRelay(20, 'compiled-middle'),
    privateRelay(40, 'compiled-final')
  ]
  const replacementRelays = [
    privateRelay(1, 'compiled-entry', 8n),
    privateRelay(20, 'compiled-middle', 8n),
    privateRelay(40, 'compiled-final', 8n)
  ]
  const finalToken = b4a.alloc(64, 0xfe)
  const built = buildPrivateTemplates({
    descriptorId,
    epoch: 7n,
    expiresAt: 9_000n,
    endpointKey: owner.publicKey,
    routeSigningKey: owner.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.secretKey,
    relays: relays.map((relay) => encodeRelayAdvertisement(relay.advertisement)),
    randomBytes: sequenceBytes(1),
    finalToken,
    now: 1_000n
  })
  const replacementBuilt = higherEpochReplacement
    ? buildPrivateTemplates({
        descriptorId,
        epoch: 8n,
        expiresAt: 9_000n,
        endpointKey: owner.publicKey,
        routeSigningKey: owner.publicKey,
        authorizationMode: AUTHORIZATION_MODE.DIRECT,
        destinationSecretKey: owner.secretKey,
        relays: replacementRelays.map((relay) => encodeRelayAdvertisement(relay.advertisement)),
        randomBytes: sequenceBytes(40),
        finalToken,
        now: 1_000n
      })
    : null
  const destinationActor = createPrivateDestinationActor({
    identity: owner.publicKey,
    identitySecretKey: owner.secretKey,
    routeSigningKey: owner.publicKey,
    routeSigningSecretKey: owner.secretKey,
    routeEncryptionSecretKey: destinationEncryption.secretKey,
    finalToken,
    now: () => now,
    randomBytes: longRunRandom ? monotonicBytes(220) : sequenceBytes(220),
    observe(event) {
      destinationEvents.push(event)
    }
  })
  const actors = new Array(relays.length)
  let next
  for (let index = relays.length - 1; index >= 0; index--) {
    const relay = relays[index]
    actors[index] = createPrivateRelayActor({
      identity: relay.identity.publicKey,
      identitySecretKey: relay.identity.secretKey,
      routeEncryptionSecretKey: relay.encryption.secretKey,
      next,
      destination: index === relays.length - 1 ? destinationActor : undefined,
      now: () => now,
      randomBytes: longRunRandom
        ? monotonicBytes(260 + index * 20)
        : sequenceBytes(260 + index * 20),
      transmit: transmitActorCell,
      observe(event) {
        actorEvents.push(event)
      },
      [TEST_ONLY_RELAY_OBSERVER](event) {
        if (event.type !== 'forward' || event.byteLength !== 1100) return
        relayFrames.push({
          relay: `private-${index}`,
          direction: event.direction,
          cellClass: event.class,
          frame: b4a.from(event.frame),
          keys: Object.keys(event).sort()
        })
      }
    })
    actorNodes.set(actors[index], privateNodes[index])
    next = actors[index]
  }
  actorNodes.set(destinationActor, destinationNode)
  const registrationRoute = registrationSafetyRoute()
  const registered = registerPrivateRoute({
    built,
    entryActor: actors[0],
    safetyRoute: registrationRoute,
    now: () => now,
    randomBytes: sequenceBytes(340)
  })
  registrationRoute.destroy()
  if (!registered.registered)
    throw new Error(`public actor registration failed: ${registered.failureCode}`)
  if (replacementBuilt) {
    const replacementRegistrationRoute = registrationSafetyRoute()
    const replacementRegistered = registerPrivateRoute({
      built: replacementBuilt,
      entryActor: actors[0],
      safetyRoute: replacementRegistrationRoute,
      now: () => now,
      randomBytes: sequenceBytes(360)
    })
    replacementRegistrationRoute.destroy()
    if (!replacementRegistered.registered)
      throw new Error(`replacement actor registration failed: ${replacementRegistered.failureCode}`)
  }
  actorEvents.length = 0
  safetyEvents.length = 0

  const descriptor = verifyDescriptor(
    encodeDescriptor(
      signDescriptor(
        {
          version: PROTOCOL_VERSION,
          authorizationMode: AUTHORIZATION_MODE.DIRECT,
          descriptorId,
          endpointKey: owner.publicKey,
          routeSigningKey: owner.publicKey,
          routeEncryptionKey: destinationEncryption.publicKey,
          entryAdvertisement: encodeRelayAdvertisement(relays[0].advertisement),
          epoch: 7n,
          expiresAt: 9_000n,
          capabilities: CAPABILITY.KNOWN,
          cellSize: CELL_SIZE,
          encryptedHops: built.encryptedHops
        },
        owner.secretKey
      )
    ),
    { requestedEndpointKey: owner.publicKey, now: 1_000n }
  )
  const replacementDescriptor = replacementBuilt
    ? verifyDescriptor(
        encodeDescriptor(
          signDescriptor(
            {
              version: PROTOCOL_VERSION,
              authorizationMode: AUTHORIZATION_MODE.DIRECT,
              descriptorId,
              endpointKey: owner.publicKey,
              routeSigningKey: owner.publicKey,
              routeEncryptionKey: destinationEncryption.publicKey,
              entryAdvertisement: encodeRelayAdvertisement(replacementRelays[0].advertisement),
              epoch: 8n,
              expiresAt: 9_000n,
              capabilities: CAPABILITY.KNOWN,
              cellSize: CELL_SIZE,
              encryptedHops: replacementBuilt.encryptedHops
            },
            owner.secretKey
          )
        ),
        { requestedEndpointKey: owner.publicKey, now: 1_000n }
      )
    : null
  function buildSafetyAdvertisements(epoch) {
    return safetyRelays.map((relay, index) =>
      encodeRelayAdvertisement(
        signRelayAdvertisement(
          {
            version: PROTOCOL_VERSION,
            identityKey: relay.identity.publicKey,
            routeEncryptionKey: relay.encryption.publicKey,
            dial: b4a.from(`compiled-safety-${index}`),
            role: ROLE.SAFETY,
            capabilities: CAPABILITY.KNOWN,
            epoch,
            expiresAt: 10_000n
          },
          relay.identity.secretKey
        )
      )
    )
  }
  const safetyAdvertisements = buildSafetyAdvertisements(7n)
  const replacementSafetyAdvertisements = higherEpochReplacement
    ? buildSafetyAdvertisements(8n)
    : null
  const safetyAuthority = createSafetyInstallerAuthority()
  const safetyInstaller = safetyAuthority.issuer.issue({
    authenticate(advertisement, binding) {
      if (!b4a.equals(advertisement.identityKey, safetyRelays[binding.index].identity.publicKey))
        throw new Error('unexpected Safety relay')
    },
    install(advertisement, binding) {
      installedSafetyEpochs.push(binding.epoch)
      const link = buildSafetyLink(binding.index, binding)
      if (binding.index === 0) safetyLinks.length = 0
      safetyLinks.push(link)
      if (binding.index === 0) return
      const record = {
        cancellations: null,
        finalReceive: null,
        service: null,
        sourceReceive: null
      }
      record.service = new RelayService({
        identity: safetyRelays[0].identity.publicKey,
        ticketChecker: linkAuthority.checker,
        crypto: cryptoSuite,
        now: () => now,
        padding: (size) => b4a.alloc(size),
        maxCircuitQueuedBytes: maxSafetyCircuitQueuedBytes,
        send(peer, packet) {
          if (b4a.equals(peer, sourceIdentity.publicKey)) {
            queueSafetyNetwork(
              safetyGuardNode,
              sourceNode,
              packet,
              (received) => record.sourceReceive(received),
              record.cancellations
            )
            return true
          }
          if (b4a.equals(peer, safetyRelays[1].identity.publicKey) && stallSafetyForward)
            return false
          if (b4a.equals(peer, safetyRelays[1].identity.publicKey)) {
            queueSafetyNetwork(
              safetyGuardNode,
              safetyNode,
              packet,
              (received) => record.finalReceive(received),
              record.cancellations
            )
            return true
          }
          return false
        },
        [TEST_ONLY_RELAY_OBSERVER](event) {
          if (event.type === 'forward' && event.byteLength === 1100)
            relayFrames.push({
              relay: 'safety-guard',
              direction: event.direction,
              cellClass: event.class,
              frame: b4a.from(event.frame),
              keys: Object.keys(event).sort()
            })
          if (event.type === 'zeroized') safetyZeroizations.push(event)
        }
      })
      record.service.install(safetyLinks[0].responderTicket, link.initiatorTicket)
      safetyRelay = record
    },
    rollback() {
      if (safetyRelay)
        safetyRelay.service.destroy(
          sourceIdentity.publicKey,
          safetyLinks[0].common.responderLocalId
        )
    },
    finalize() {
      return finalizedSafetyRoute()
    }
  })
  const compilerAuthority = createRouteCompilerAuthority()
  const compilerOptions = {
    entryActor: actors[0],
    destinationActor,
    safetyRouteChecker: safetyAuthority.routeChecker,
    now: () => now,
    randomBytes: longRunRandom ? monotonicBytes(400) : sequenceBytes(400),
    scheduleDrain,
    cancelDrain,
    sourceDestinationReplayCache,
    onDestinationStream(payload) {
      atDestinationStream.push(b4a.from(payload))
    },
    onDestinationDatagram(payload) {
      atDestinationDatagram.push(b4a.from(payload))
    },
    onSourceStream(payload) {
      atSourceStream.push(b4a.from(payload))
    },
    onSourceDatagram(payload) {
      atSourceDatagram.push(b4a.from(payload))
    },
    [TEST_ONLY_ROUTE_FRAME_OBSERVER](event) {
      routeFrames.push({
        direction: event.direction,
        cellClass: event.cellClass,
        frame: b4a.from(event.frame)
      })
      event.frame.fill(0)
    }
  }
  if (sourceSenderInitial !== undefined) {
    compilerOptions[TEST_ONLY_ROUTE_PAYLOAD_COUNTERS] = Object.freeze({
      sourceSenderInitial,
      destinationReceiverInitial: sourceSenderInitial,
      rotationAlreadyRequested
    })
  }
  const initialCompiler = createPrivateRouteCompiler(compilerOptions)
  let compile = initialCompiler
  if (higherEpochReplacement && sourceSenderInitial !== undefined) {
    const replacementCompilerOptions = { ...compilerOptions }
    delete replacementCompilerOptions[TEST_ONLY_ROUTE_PAYLOAD_COUNTERS]
    const replacementCompiler = createPrivateRouteCompiler(replacementCompilerOptions)
    let compilation = 0
    compile = (request) => {
      compilation++
      return compilation === 1 ? initialCompiler(request) : replacementCompiler(request)
    }
  }
  const compiler = compilerAuthority.issuer.issue(compile)
  const circuitAuthority = createCircuitAuthority()
  const managerCrypto = Object.freeze({
    verify: cryptoSuite.verify,
    randomBytes(size) {
      const value = cryptoSuite.randomBytes(size)
      if (size === 16) circuitIds.push(b4a.from(value))
      return value
    }
  })
  let candidateProvider = routeCandidateProvider
  if (!candidateProvider && higherEpochReplacement)
    candidateProvider = (currentEpoch, reason) => {
      candidateProviderCalls.push([currentEpoch, reason])
      return Object.freeze({
        descriptor: replacementDescriptor,
        safety: replacementSafetyAdvertisements
      })
    }
  const candidateAuthority = candidateProvider ? createRouteCandidateAuthority() : null
  const routeCandidate = candidateAuthority
    ? candidateAuthority.issuer.issue({ next: candidateProvider })
    : undefined
  const manager = new RouteManager({
    network,
    registry: { allows: () => true },
    crypto: managerCrypto,
    clock: () => now,
    descriptorChecker: descriptorChecker(),
    circuitIssuer: circuitAuthority.issuer,
    safetyInstaller,
    safetyInstallerChecker: safetyAuthority.checker,
    safetyRouteChecker: safetyAuthority.routeChecker,
    routeCompiler: compiler,
    routeCompilerChecker: compilerAuthority.checker,
    routeCandidate,
    routeCandidateChecker: candidateAuthority ? candidateAuthority.checker : undefined,
    limits: { maxSafetyHops: 3 }
  })

  function resources() {
    const relayDestroyed = actorEvents.filter((event) => event.type === 'private-circuit-destroyed')
    const destinationDestroyed = destinationEvents.filter(
      (event) => event.type === 'private-destination-circuit-destroyed'
    )
    return {
      relayCircuits: relayDestroyed.length
        ? relayDestroyed.slice(-3).map((event) => event.activeCircuits)
        : [],
      destination: destinationDestroyed.length
        ? {
            activeCircuits: destinationDestroyed.at(-1).activeCircuits,
            reverseBindings: destinationDestroyed.at(-1).reverseBindings,
            routeActors: destinationDestroyed.at(-1).routeActors
          }
        : null,
      safetyRoutes: activeSafetyRoutes,
      safetyEntryAttachments,
      safetyCallbacks: Array.from(networkDeliveries.values()).reduce(
        (total, queue) => total + queue.length,
        0
      ),
      networkPending,
      scheduledDrains: drainTimers.size,
      relayQueuedBytes: actorEvents
        .filter((event) => event.type === 'private-binding-zeroized')
        .map((event) => event.queuedBytes),
      safetyQueuedBytes: Array.from(safetyRelayRecords).reduce(
        (total, record) => total + record.service.queuedBytes,
        0
      ),
      safetyZeroizations,
      safetyNetworkPending,
      queuedActorSetup,
      cancelledActorSetup,
      queuedLatePayloads,
      cancelledLatePayloads
    }
  }

  return {
    actors,
    actorEvents,
    actorTransmissions,
    atDestinationDatagram,
    atDestinationStream,
    atSourceDatagram,
    atSourceStream,
    candidateProviderCalls,
    circuitIds,
    destinationActor,
    destinationEvents,
    entryIdentity: b4a.toString(relays[0].identity.publicKey, 'hex'),
    forbiddenFrameBytes: [
      owner.secretKey,
      destinationEncryption.secretKey,
      finalToken,
      ...relays.flatMap((relay) => [relay.identity.secretKey, relay.encryption.secretKey])
    ].map((value) => b4a.from(value)),
    network,
    nodes: { sourceNode, safetyGuardNode, safetyNode, privateNodes, destinationNode },
    resources,
    routeFrames,
    relayFrames,
    safetyEvents,
    installedSafetyEpochs,
    open() {
      return manager.open({ safety: safetyAdvertisements, descriptor })
    },
    queueUnrelated(payload) {
      return queueNetwork(unrelatedSourceNode, unrelatedDestinationNode, payload)
    },
    sendDestinationDatagram(payload, index = 0) {
      sendPrivateDestinationDatagram(destinationActor, payload, circuitIds[index])
    },
    sendDestinationStream(payload, index = 0) {
      sendPrivateDestinationStream(destinationActor, payload, circuitIds[index])
    },
    setAutoFlush(value) {
      autoFlush = value
    },
    setRejectActorTransmission(value) {
      rejectActorTransmission = value
    },
    setQueuedActorSetupSize(value) {
      queuedActorSetupSize = value
    },
    queueLatePayloadAt(value) {
      latePayloadTarget = value
      latePayloadSeen = 0
    },
    fireRetainedActorSetupCallbacks() {
      for (const receive of retainedActorSetupCallbacks.splice(0)) receive(null)
    },
    fireRetainedLatePayloads(corrupt = false) {
      for (const retained of retainedLatePayloads.splice(0)) {
        try {
          if (corrupt) retained.packet[0] ^= 1
          retained.receive(retained.packet)
        } finally {
          retained.packet.fill(0)
        }
      }
    },
    setStallSafetyForward(value) {
      stallSafetyForward = value
    },
    advance(ms) {
      now += ms
      network.advance(ms)
      runDrainTimers()
    },
    sourceDestinationReplayCacheSize() {
      return sourceDestinationReplayCache.size
    },
    unrelatedDeliveries,
    destroyDestinationActor() {
      destroyPrivateDestinationActor(destinationActor)
    },
    destroyRelayActor(index) {
      destroyPrivateRelayActor(actors[index])
    },
    destroyActors() {
      for (const actor of actors) {
        destroyPrivateRelayActor(actor)
        destroyPrivateRelayActor(actor)
      }
      destroyPrivateDestinationActor(destinationActor)
      destroyPrivateDestinationActor(destinationActor)
    }
  }
}

function assertZeroResources(t, fixture) {
  const resources = fixture.resources()
  t.alike(resources.relayCircuits, [0, 0, 0])
  t.alike(resources.destination, {
    activeCircuits: 0,
    reverseBindings: 0,
    routeActors: 0
  })
  t.is(resources.safetyRoutes, 0)
  t.is(resources.safetyCallbacks, 0)
  t.is(resources.networkPending, 0)
  t.is(resources.scheduledDrains, 0)
  t.is(resources.safetyQueuedBytes, 0)
  t.ok(resources.relayQueuedBytes.length > 0)
  t.ok(resources.relayQueuedBytes.every((value) => value === 0))
  const zeroizations = [
    ...fixture.actorEvents
      .filter((event) => event.type === 'private-binding-zeroized')
      .map((event) => event.contexts),
    ...resources.safetyZeroizations.map((event) => event.contexts)
  ]
  t.ok(zeroizations.length > 0)
  t.ok(
    zeroizations.every(
      (contexts) =>
        Array.isArray(contexts) &&
        contexts.length === 12 &&
        contexts.every(
          (context) =>
            b4a.equals(context.key, b4a.alloc(32)) &&
            b4a.equals(context.noncePrefix, b4a.alloc(16)) &&
            context.counter.closed === true
        )
    )
  )
  t.is(fixture.network.flush(), 0)
}

test('adjacent actor failure before retention rolls back every staged circuit', (t) => {
  const fixture = publicActorRouteFixture()
  const destinationDestroyedBefore = fixture.destinationEvents.filter(
    (event) => event.type === 'private-destination-circuit-destroyed'
  ).length
  fixture.setRejectActorTransmission(true)

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')

  const relayDestroyed = fixture.actorEvents.filter(
    (event) => event.type === 'private-circuit-destroyed'
  )
  t.alike(
    relayDestroyed.map((event) => event.activeCircuits),
    [0]
  )
  t.is(fixture.resources().safetyRoutes, 0)
  t.is(fixture.resources().safetyCallbacks, 0)
  t.is(fixture.resources().networkPending, 0)
  const destinationDestroyed = fixture.destinationEvents.filter(
    (event) => event.type === 'private-destination-circuit-destroyed'
  )
  t.is(destinationDestroyed.length, destinationDestroyedBefore)
  fixture.destroyActors()
})

test('queued actor LinkCreate and LinkCreated setup is cancelled fail closed', (t) => {
  for (const size of [LINK_CREATE_SIZE, LINK_CREATED_SIZE]) {
    const fixture = publicActorRouteFixture()
    fixture.setQueuedActorSetupSize(size)

    expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')

    const resources = fixture.resources()
    t.is(resources.queuedActorSetup, 0, `${size} leaves no queued setup bytes`)
    t.is(resources.cancelledActorSetup, 1, `${size} cancellation invoked exactly once`)
    t.is(resources.networkPending, 0, `${size} leaves no VNet delivery`)
    t.is(resources.safetyRoutes, 0, `${size} tears down the Safety route`)
    t.is(resources.safetyEntryAttachments, 0, `${size} tears down the entry attachment`)
    const actorEventsBeforeLateDelivery = fixture.actorEvents.length
    const destinationEventsBeforeLateDelivery = fixture.destinationEvents.length
    let lateError = null
    try {
      fixture.fireRetainedActorSetupCallbacks()
    } catch (err) {
      lateError = err
    }
    t.is(lateError, null, `${size} ignores callbacks retained after setup cancellation`)
    t.is(
      fixture.actorEvents.length,
      actorEventsBeforeLateDelivery,
      `${size} late callback cannot mutate relay state`
    )
    t.is(
      fixture.destinationEvents.length,
      destinationEventsBeforeLateDelivery,
      `${size} late callback cannot mutate destination state`
    )
    fixture.destroyActors()
  }
})

test('deep compiled simulator remains a non-normative smoke harness', (t) => {
  const route = createCompiledRouteSimulator({ safetyHops: 2, privateHops: 2 })
  t.alike(Object.keys(route.circuit).sort(), [
    'destroy',
    'drain',
    'sendDatagram',
    'sendStreamFrame'
  ])
  route.circuit.destroy()
})

test('public actor route exposes bounded API and carries both payload classes bidirectionally', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  t.is(fixture.sourceDestinationReplayCacheSize(), 1)
  t.is(fixture.resources().safetyEntryAttachments, 1)
  t.alike(Object.keys(circuit).sort(), ['destroy', 'drain', 'sendDatagram', 'sendStreamFrame'])
  t.is(circuit.directFallback, undefined)
  t.ok(fixture.actorTransmissions.some(({ bytes }) => bytes === LINK_CREATE_SIZE))
  t.ok(fixture.actorTransmissions.some(({ bytes }) => bytes === LINK_CREATED_SIZE))
  const permittedActorEdges = new Set([
    `${fixture.nodes.safetyNode}->${fixture.nodes.privateNodes[0]}`,
    `${fixture.nodes.privateNodes[0]}->${fixture.nodes.safetyNode}`,
    ...fixture.nodes.privateNodes.slice(0, -1).flatMap((from, index) => {
      const to = fixture.nodes.privateNodes[index + 1]
      return [`${from}->${to}`, `${to}->${from}`]
    }),
    `${fixture.nodes.privateNodes.at(-1)}->${fixture.nodes.destinationNode}`,
    `${fixture.nodes.destinationNode}->${fixture.nodes.privateNodes.at(-1)}`
  ])
  t.ok(
    fixture.actorTransmissions.every(({ from, to }) => permittedActorEdges.has(`${from}->${to}`))
  )
  t.ok(
    fixture.actorTransmissions.every(
      ({ from, to }) =>
        !(
          (from === fixture.nodes.sourceNode && to === fixture.nodes.destinationNode) ||
          (from === fixture.nodes.destinationNode && to === fixture.nodes.sourceNode)
        )
    )
  )

  circuit.sendStreamFrame(b4a.from('forward stream'))
  circuit.sendDatagram(b4a.from('forward datagram'))
  fixture.sendDestinationStream(b4a.from('reverse stream'))
  fixture.sendDestinationDatagram(b4a.from('reverse datagram'))

  t.alike(fixture.atDestinationStream, [b4a.from('forward stream')])
  t.alike(fixture.atDestinationDatagram, [b4a.from('forward datagram')])
  t.alike(fixture.atSourceStream, [b4a.from('reverse stream')])
  t.alike(fixture.atSourceDatagram, [b4a.from('reverse datagram')])
  t.alike(fixture.network.directPeers(fixture.nodes.sourceNode), [fixture.nodes.safetyGuardNode])
  t.alike(fixture.network.directPeers(fixture.nodes.destinationNode), [
    fixture.nodes.privateNodes.at(-1)
  ])
  t.is(fixture.routeFrames.length, 4)
  t.ok(fixture.routeFrames.every(({ frame }) => frame.byteLength === 1100))
  const plaintexts = [
    b4a.from('forward stream'),
    b4a.from('forward datagram'),
    b4a.from('reverse stream'),
    b4a.from('reverse datagram')
  ]
  t.ok(
    fixture.routeFrames.every(({ frame }) =>
      plaintexts.every((plaintext) => frame.indexOf(plaintext) === -1)
    )
  )
  t.ok(
    fixture.routeFrames.every(({ frame }) =>
      fixture.forbiddenFrameBytes.every((secret) => frame.indexOf(secret) === -1)
    )
  )
  t.is(
    new Set(fixture.routeFrames.map(({ frame }) => b4a.toString(cryptoSuite.hash([frame]), 'hex')))
      .size,
    4
  )
  t.is(fixture.relayFrames.length, 20)
  t.ok(
    fixture.relayFrames.every(
      ({ frame, keys }) =>
        frame.byteLength === 1100 &&
        keys.join(',') === 'afterHash,beforeHash,byteLength,class,direction,frame,type' &&
        keys.every((key) => !/key|secret|nonce|ticket/i.test(key)) &&
        plaintexts.every((plaintext) => frame.indexOf(plaintext) === -1) &&
        fixture.forbiddenFrameBytes.every((secret) => frame.indexOf(secret) === -1)
    )
  )
  const relayFramesByDirection = new Map()
  for (const observed of fixture.relayFrames) {
    const key = `${observed.direction}:${observed.cellClass}`
    const values = relayFramesByDirection.get(key) || []
    values.push(observed)
    relayFramesByDirection.set(key, values)
  }
  t.is(relayFramesByDirection.size, 4)
  t.ok(
    Array.from(relayFramesByDirection.values()).every(
      (observed) =>
        observed.length === 5 &&
        new Set(observed.map(({ relay }) => relay)).size === 5 &&
        new Set(observed.map(({ frame }) => b4a.toString(cryptoSuite.hash([frame]), 'hex')))
          .size === 1
    )
  )
  const payloadSafety = fixture.safetyEvents.filter(
    (event) => event.cellClass !== CELL_CLASS.CONTROL
  )
  t.alike(
    payloadSafety.map((event) => [event.cellClass, event.direction, event.packetBytes]),
    [
      [CELL_CLASS.STREAM, DIRECTION.FORWARD, CELL_SIZE],
      [CELL_CLASS.DATAGRAM, DIRECTION.FORWARD, CELL_SIZE],
      [CELL_CLASS.STREAM, DIRECTION.REVERSE, CELL_SIZE],
      [CELL_CLASS.DATAGRAM, DIRECTION.REVERSE, CELL_SIZE]
    ]
  )
  t.ok(
    fixture.actorEvents.some(
      (event) =>
        event.type === 'private-frame' &&
        event.cellClass === CELL_CLASS.STREAM &&
        event.direction === DIRECTION.FORWARD &&
        typeof event.bindingFingerprint === 'string'
    )
  )
  const edges = fixture.network.edges()
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.sourceNode && to === fixture.nodes.safetyGuardNode
    )
  )
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.safetyGuardNode && to === fixture.nodes.safetyNode
    )
  )
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.safetyNode && to === fixture.nodes.privateNodes[0]
    )
  )
  t.ok(
    fixture.nodes.privateNodes
      .slice(0, -1)
      .every((from, index) =>
        edges.some(
          ([edgeFrom, to]) => edgeFrom === from && to === fixture.nodes.privateNodes[index + 1]
        )
      )
  )
  t.ok(
    edges.some(
      ([from, to]) =>
        from === fixture.nodes.privateNodes.at(-1) && to === fixture.nodes.destinationNode
    )
  )
  const entryBindings = fixture.actorEvents.filter(
    (event) =>
      event.type === 'private-binding-opened' && event.localIdentity === fixture.entryIdentity
  )
  t.is(entryBindings.length, 2)
  t.ok(
    fixture.actorEvents.some(
      (event) =>
        event.type === 'private-frame' &&
        event.cellClass === CELL_CLASS.DATAGRAM &&
        event.direction === DIRECTION.REVERSE &&
        typeof event.bindingFingerprint === 'string'
    )
  )
  t.ok(
    fixture.safetyEvents.every(
      (event) => typeof event.bindingFingerprint === 'string' && typeof event.counter === 'bigint'
    )
  )
  t.ok(
    fixture.actorEvents
      .filter((event) => event.type === 'private-frame')
      .every((event) => event.packetBytes === CELL_SIZE)
  )
  t.is(
    fixture.network
      .edges()
      .some(
        ([from, to]) =>
          (from === fixture.nodes.sourceNode && to === fixture.nodes.destinationNode) ||
          (from === fixture.nodes.destinationNode && to === fixture.nodes.sourceNode)
      ),
    false
  )

  circuit.destroy()
  assertZeroResources(t, fixture)
  t.is(fixture.sourceDestinationReplayCacheSize(), 1)
  fixture.destroyActors()
})

test('deep payload counter requests rotation before exhaustion and fails closed without a candidate', (t) => {
  const fixture = publicActorRouteFixture({ sourceSenderInitial: ROUTE_ROTATE_AT - 1n })
  const circuit = fixture.open()

  expectCode(
    t,
    () => circuit.sendStreamFrame(b4a.from('last frame before rotation threshold')),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(fixture.atDestinationStream, [b4a.from('last frame before rotation threshold')])
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('real actor facade rotates epoch 7 to 8 while the old reverse path drains', (t) => {
  const fixture = publicActorRouteFixture({
    sourceSenderInitial: ROUTE_ROTATE_AT - 1n,
    higherEpochReplacement: true
  })
  const circuit = fixture.open()
  const facade = circuit

  circuit.sendStreamFrame(b4a.from('epoch 7 rotation trigger'))
  t.is(circuit, facade)
  t.alike(fixture.candidateProviderCalls, [[7n, 'rotation']])
  t.alike(fixture.installedSafetyEpochs, [7n, 7n, 8n, 8n])
  t.is(fixture.resources().safetyRoutes, 2)
  t.is(fixture.resources().scheduledDrains, 1)
  t.is(fixture.sourceDestinationReplayCacheSize(), 2)

  circuit.sendDatagram(b4a.from('epoch 8 forward'))
  fixture.sendDestinationStream(b4a.from('epoch 7 reverse at drain start'), 0)
  fixture.advance(4_999)
  fixture.sendDestinationDatagram(b4a.from('epoch 7 reverse at 4999'), 0)
  t.alike(fixture.atDestinationStream, [b4a.from('epoch 7 rotation trigger')])
  t.alike(fixture.atDestinationDatagram, [b4a.from('epoch 8 forward')])
  t.alike(fixture.atSourceStream, [b4a.from('epoch 7 reverse at drain start')])
  t.alike(fixture.atSourceDatagram, [b4a.from('epoch 7 reverse at 4999')])

  fixture.advance(1)
  t.is(fixture.resources().safetyRoutes, 1)
  t.is(fixture.resources().scheduledDrains, 0)
  expectCode(
    t,
    () => fixture.sendDestinationStream(b4a.from('epoch 7 reverse at 5000'), 0),
    'CIRCUIT_STATE'
  )
  circuit.sendStreamFrame(b4a.from('epoch 8 forward after old drain'))
  t.alike(fixture.atDestinationStream, [
    b4a.from('epoch 7 rotation trigger'),
    b4a.from('epoch 8 forward after old drain')
  ])

  circuit.destroy()
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('actor activation tombstones and entry replay cache stop exactly at 128', (t) => {
  const fixture = publicActorRouteFixture({ longRunRandom: true })

  for (let index = 0; index < 128; index++) fixture.open().destroy()

  const destroyed = fixture.actorEvents.filter(
    (event) => event.type === 'private-circuit-destroyed'
  )
  t.is(destroyed.length, 128 * 3)
  t.alike(
    destroyed
      .slice(-3)
      .map((event) => [
        event.activeCircuits,
        event.activationReplayTombstones,
        event.entryReplayTombstones
      ]),
    [
      [0, 128, 0],
      [0, 128, 0],
      [0, 128, 128]
    ]
  )

  expectCode(t, () => fixture.open(), 'CIRCUIT_LIMIT')
  t.is(
    fixture.actorEvents.filter((event) => event.type === 'private-circuit-destroyed').length,
    128 * 3 + 1
  )
  const afterLimit = fixture.actorEvents
    .filter((event) => event.type === 'private-circuit-destroyed')
    .at(-1)
  t.alike(
    [
      afterLimit.activeCircuits,
      afterLimit.activationReplayTombstones,
      afterLimit.entryReplayTombstones
    ],
    [0, 128, 128]
  )
  fixture.advance(8_000)
  fixture.destroyActors()
  t.alike(
    fixture.actorEvents
      .filter((event) => event.type === 'private-relay-destroying')
      .map((event) => [
        event.records,
        event.activationReplayTombstones,
        event.entryReplayTombstones
      ]),
    [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
  )
})

test('public counter exhaustion destroys the installed route and never asks for fallback', (t) => {
  let providerCalls = 0
  const fixture = publicActorRouteFixture({
    sourceSenderInitial: MAX_ROUTE_LOGICAL_COUNTER,
    rotationAlreadyRequested: true,
    routeCandidateProvider() {
      providerCalls++
      throw new Error('counter exhaustion must not request a route candidate')
    }
  })
  const circuit = fixture.open()

  circuit.sendStreamFrame(b4a.from('uint63 max is emitted once'))
  t.alike(fixture.atDestinationStream, [b4a.from('uint63 max is emitted once')])
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('must not wrap')), 'COUNTER_EXHAUSTED')
  t.is(providerCalls, 0)
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public Safety queue overflow destroys all installed state without fallback', (t) => {
  let providerCalls = 0
  const fixture = publicActorRouteFixture({
    maxSafetyCircuitQueuedBytes: CELL_SIZE,
    routeCandidateProvider() {
      providerCalls++
      throw new Error('queue overflow must not request a route candidate')
    }
  })
  const circuit = fixture.open()
  fixture.setStallSafetyForward(true)

  circuit.sendDatagram(b4a.from('one queued cell'))
  t.is(fixture.resources().safetyQueuedBytes, CELL_SIZE)
  t.alike(fixture.atDestinationDatagram, [])
  expectCode(t, () => circuit.sendDatagram(b4a.from('overflow')), 'CIRCUIT_LIMIT')
  t.is(providerCalls, 0)
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public actor drain is reverse-only and expires at exactly 5000ms', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  circuit.drain()
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('late forward')), 'CIRCUIT_STATE')
  fixture.sendDestinationStream(b4a.from('reverse at drain start'))
  fixture.advance(4_999)
  fixture.sendDestinationDatagram(b4a.from('reverse at 4999'))
  t.alike(fixture.atSourceStream, [b4a.from('reverse at drain start')])
  t.alike(fixture.atSourceDatagram, [b4a.from('reverse at 4999')])
  fixture.advance(1)
  assertZeroResources(t, fixture)
  expectCode(t, () => fixture.sendDestinationStream(b4a.from('reverse at 5000')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public actor destroy cancels queued Safety delivery and zeroes all resources', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  fixture.setAutoFlush(false)
  circuit.sendDatagram(b4a.from('queued datagram'))
  t.is(fixture.resources().networkPending, 1)
  circuit.destroy()
  t.is(fixture.atDestinationDatagram.length, 0)
  t.is(fixture.resources().networkPending, 0)
  t.is(fixture.network.flush(), 0)
  t.is(fixture.atDestinationDatagram.length, 0)
  expectCode(t, () => circuit.sendDatagram(b4a.from('after destroy')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  circuit.destroy()
  fixture.destroyActors()
})

test('destroying a live destination actor tears down the compiled route', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()

  fixture.destroyDestinationActor()

  expectCode(t, () => circuit.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('destroying a live middle relay tears down both route directions', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()

  fixture.destroyRelayActor(1)

  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('late cancelled Safety and actor payload callbacks are inert after destroy', (t) => {
  for (const [path, target] of [
    ['Safety entry attachment', 1],
    ['actor adjacency', 2]
  ]) {
    const fixture = publicActorRouteFixture()
    const circuit = fixture.open()
    fixture.queueLatePayloadAt(target)

    circuit.sendDatagram(b4a.from(`${path} queued payload`))
    t.is(fixture.resources().queuedLatePayloads, 1, `${path} adapter retains one callback`)
    t.alike(fixture.atDestinationDatagram, [], `${path} payload is not delivered before destroy`)

    circuit.destroy()
    t.is(fixture.resources().queuedLatePayloads, 0, `${path} pending delivery is cancelled`)
    t.is(
      fixture.resources().cancelledLatePayloads,
      1,
      `${path} adapter cancellation runs exactly once`
    )
    const actorEventsBeforeLateDelivery = fixture.actorEvents.length
    const destinationEventsBeforeLateDelivery = fixture.destinationEvents.length
    let lateError = null
    try {
      fixture.fireRetainedLatePayloads()
    } catch (err) {
      lateError = err
    }
    t.is(lateError, null, `${path} callback retained past destroy is ignored`)
    t.is(
      fixture.actorEvents.length,
      actorEventsBeforeLateDelivery,
      `${path} late callback cannot mutate relay state`
    )
    t.is(
      fixture.destinationEvents.length,
      destinationEventsBeforeLateDelivery,
      `${path} late callback cannot mutate destination state`
    )
    t.alike(fixture.atDestinationDatagram, [], `${path} late callback cannot deliver payload`)
    assertZeroResources(t, fixture)
    fixture.destroyActors()
  }
})

test('queued authenticated transport failures destroy the entire compiled route', (t) => {
  for (const [path, send] of [
    ['Safety forward', (fixture, circuit) => circuit.sendDatagram(b4a.from('forward'))],
    ['destination reverse', (fixture) => fixture.sendDestinationStream(b4a.from('reverse'))]
  ]) {
    const fixture = publicActorRouteFixture()
    const circuit = fixture.open()
    fixture.queueLatePayloadAt(1)

    send(fixture, circuit)
    t.is(fixture.resources().queuedLatePayloads, 1, `${path} delivery is queued`)
    t.exception(() => fixture.fireRetainedLatePayloads(true), `${path} rejects a corrupt cell`)
    assertZeroResources(t, fixture)
    fixture.destroyActors()
  }
})

test('route destroy leaves unrelated virtual-network delivery intact', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  fixture.setAutoFlush(false)
  fixture.queueUnrelated(b4a.from('unrelated'))
  circuit.sendDatagram(b4a.from('route-owned'))
  t.is(fixture.resources().networkPending, 2)

  circuit.destroy()
  t.is(fixture.resources().networkPending, 1)
  t.is(fixture.network.flush(), 1)
  t.alike(fixture.unrelatedDeliveries, [b4a.from('unrelated')])
  t.is(fixture.resources().networkPending, 0)
  t.is(fixture.network.flush(), 0)
  fixture.destroyActors()
})
