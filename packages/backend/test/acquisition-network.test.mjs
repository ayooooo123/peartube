import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createRenditionDescriptor } from '../src/assets/rendition.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'
import {
  ACQUISITION_DISCOVERY_CAPABILITY,
  ACQUISITION_WORK_CAPABILITY,
  createAcquisitionNetwork,
  createScopedProtocolSession,
  decodeAcquisitionRequest,
  deriveAcquisitionDiscoveryTopic,
  deriveAcquisitionTopic,
  encodeAcquisitionRequest,
  encodePeerFrame,
  encodeScopedHello,
  peerFrameTypeCode,
  topicHex,
} from '../src/network/index.js'

function id(keyPair) {
  return b4a.toString(keyPair.publicKey, 'hex')
}

function policy(enabled) {
  return {
    networkTerms: () => ({
      generation: 1,
      policyVersion: 1,
      consentVersion: 1,
      migrationRequired: false,
      enabled,
      acceptPublicRequests: enabled,
      requesterMode: 'public',
      allowedPublisherIds: [],
      maxConcurrentJobs: 4,
      maxConcurrentPerRequester: 2,
      maxRequestBytes: 16 * 1024 * 1024,
      remainingAcquireBytes24h: 64 * 1024 * 1024,
      maxJobRuntimeMs: 60_000,
      sourceGrantTtlMs: 30_000,
      publicRequestsPerMinute: 8,
    }),
  }
}

function manager(events) {
  return Object.fromEntries([
    'Request', 'Offer', 'Assignment', 'Progress', 'Result', 'Cancellation',
  ].map(name => [`on${name}`, async value => { events.push([name.toLowerCase(), value]) }]))
}

function linkedScopedPair(leftKeyPair, rightKeyPair) {
  const pending = []
  const wire = []

  function endpoint(keyPair) {
    return {
      peer: null,
      discovery: null,
      assignments: new Map(),
      releasedDiscovery: 0,
      releasedAssignments: [],
      getLocalTransportPeerId() { return id(keyPair) },
      async retainAcquisitionDiscovery(input) { this.discovery = input },
      async releaseAcquisitionDiscovery() { this.discovery = null; this.releasedDiscovery++; return true },
      async retainAcquisitionAssignment(input) { this.assignments.set(input.assignmentId, input) },
      async releaseAcquisitionAssignment({ assignmentId }) {
        this.assignments.delete(assignmentId)
        this.releasedAssignments.push(assignmentId)
        return true
      },
      publishAcquisitionFrame(input) {
        const frame = { ...input, payload: b4a.from(input.payload), peerId: id(keyPair) }
        wire.push(frame)
        const target = this.peer
        if (input.peerId && input.peerId !== target.getLocalTransportPeerId()) return { sent: 0, peerIds: [] }
        const retained = input.purpose === 'acquisition-discovery'
          ? target.discovery
          : target.assignments.get(input.assignmentId)
        if (!retained) return { sent: 0, peerIds: [] }
        const work = Promise.resolve().then(() => retained.onFrame(
          { type: input.type, payload: frame.payload },
          { peerId: id(keyPair), purpose: input.purpose, scopeId: input.assignmentId || 'peartube-main' },
        ))
        pending.push(work)
        return { sent: 1, peerIds: [target.getLocalTransportPeerId()] }
      },
      inject(frame) {
        const retained = frame.purpose === 'acquisition-discovery'
          ? this.discovery
          : this.assignments.get(frame.assignmentId)
        if (!retained) return Promise.reject(new Error('acquisition scope topic is not retained'))
        return retained.onFrame(
          { type: frame.type, payload: frame.payload },
          { peerId: frame.peerId, purpose: frame.purpose, scopeId: frame.assignmentId || 'peartube-main' },
        )
      },
    }
  }

  const left = endpoint(leftKeyPair)
  const right = endpoint(rightKeyPair)
  left.peer = right
  right.peer = left
  return {
    left,
    right,
    wire,
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0))
    },
  }
}

function requestInput(now) {
  return {
    publisherId: '33'.repeat(32),
    sourceRef: 'S'.repeat(43),
    publicationIntentDigest: '55'.repeat(32),
    output: { purpose: 'original', formats: ['video/mp4'] },
    budget: {
      maxSourceBytes: 2 * 1024 * 1024,
      maxOutputBytes: 2 * 1024 * 1024,
      maxNetworkBytes: 4 * 1024 * 1024,
      maxWallClockMs: 20_000,
    },
    expiresAt: now + 30_000,
    resultHoldUntil: now + 120_000,
  }
}

test('acquisition purpose and frame additions are append-only and topic separated', (t) => {
  const discovery = deriveAcquisitionDiscoveryTopic({ networkId: 'peartube-main', protocolMajor: 2 })
  const assignment = deriveAcquisitionTopic({ assignmentId: 'ab'.repeat(32), protocolMajor: 2 })
  t.is(discovery.byteLength, 32)
  t.is(assignment.byteLength, 32)
  t.not(topicHex(discovery), topicHex(assignment))
  t.ok(peerFrameTypeCode('acquisition-request'))
})

test('signed acquisition request codec binds the Noise signer, exact fields, bounds, replay lifetime, and malformed bytes', async (t) => {
  const signer = crypto.keyPair(b4a.alloc(32, 7))
  const issuedAt = 100_000
  const input = requestInput(issuedAt)
  const body = {
    version: 1,
    requesterId: id(signer),
    requesterTransportKey: id(signer),
    publisherId: input.publisherId,
    sourceRef: input.sourceRef,
    publicationIntentDigest: input.publicationIntentDigest,
    output: input.output,
    budget: input.budget,
    resultHoldUntil: input.resultHoldUntil,
  }
  const encoded = encodeAcquisitionRequest({
    body,
    keyPair: signer,
    nonce: b4a.alloc(32, 9),
    issuedAt,
    expiresAt: input.expiresAt,
  })
  const decoded = await decodeAcquisitionRequest(encoded, { now: issuedAt, transportPeerId: signer.publicKey })
  t.is(decoded.body.requesterId, id(signer))
  await t.exception(decodeAcquisitionRequest(encoded, {
    now: issuedAt,
    transportPeerId: crypto.keyPair(b4a.alloc(32, 8)).publicKey,
  }), /Noise peer/)
  await t.exception(decodeAcquisitionRequest(encoded, { now: input.expiresAt + 30_001, transportPeerId: signer.publicKey }), /lifetime/)
  await t.exception(decodeAcquisitionRequest(encoded.subarray(0, encoded.byteLength - 1), { now: issuedAt, transportPeerId: signer.publicKey }), /buffer|envelope|signature|length/)
  t.exception(() => encodeAcquisitionRequest({
    body: { ...body, sourceRef: 'magnet:?xt=urn:btih:private' },
    keyPair: signer,
    nonce: b4a.alloc(32, 9),
    issuedAt,
    expiresAt: input.expiresAt,
  }), /opaque public reference/)
  t.exception(() => encodeAcquisitionRequest({
    body: { ...body, sourceUrl: 'https://private.invalid/file' },
    keyPair: signer,
    nonce: b4a.alloc(32, 9),
    issuedAt,
    expiresAt: input.expiresAt,
  }), /fields/)
})

test('two peers complete request offer assignment progress result, reject widening/replay/purpose/topic/audience, cancel, timeout, and tear down', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 11))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 12))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  const requesterEvents = []
  const workerEvents = []
  let current = 200_000
  const requesterTimers = []
  const workerTimers = []
  const makeTimer = list => (fn, delay) => {
    const timer = { fn, delay, cleared: false, unref() {} }
    list.push(timer)
    return timer
  }
  const clearTimer = timer => { timer.cleared = true }
  const requester = createAcquisitionNetwork({
    scopedNetwork: transport.left,
    keyPair: requesterKeyPair,
    policy: policy(false),
    manager: manager(requesterEvents),
    now: () => current,
    setTimeout: makeTimer(requesterTimers),
    clearTimeout: clearTimer,
  })
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: policy(true),
    manager: manager(workerEvents),
    now: () => current,
    setTimeout: makeTimer(workerTimers),
    clearTimeout: clearTimer,
  })

  await requester.start()
  await worker.start()
  t.is(transport.left.discovery, null, 'requester does not discover until it queues work')
  t.is(transport.right.discovery.server, true, 'consenting worker retains a server-only discovery handle')
  t.is(transport.right.discovery.client, false)

  const requested = await requester.publishRequest(requestInput(current))
  await transport.flush()
  t.is(workerEvents[0][0], 'request')
  t.is(workerEvents[0][1].peerId, id(requesterKeyPair))

  await t.exception(worker.publishOffer({
    requestId: requested.request.requestId,
    peerId: id(requesterKeyPair),
    acceptedBudget: { ...requested.request.budget, maxOutputBytes: requested.request.budget.maxOutputBytes + 1 },
    sourceCapabilityDigest: '66'.repeat(32),
  }), /widens/)

  const offered = await worker.publishOffer({
    requestId: requested.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '66'.repeat(32),
  })
  await transport.flush()
  t.is(requesterEvents.at(-1)[0], 'offer')

  const assigned = await requester.assign({
    requestId: requested.request.requestId,
    offerId: offered.offer.offerId,
    deadline: current + 10_000,
  })
  await transport.flush()
  t.is(workerEvents.at(-1)[0], 'assignment')
  t.ok(transport.left.assignments.has(assigned.assignment.assignmentId))
  t.ok(transport.right.assignments.has(assigned.assignment.assignmentId))

  current += 1_000
  await worker.progress({
    assignmentId: assigned.assignment.assignmentId,
    sequence: 1,
    phase: 'acquiring',
    sourceBytes: 1024,
    outputBytes: 512,
    verifiedBlocks: 0,
    totalBlocks: 1,
  })
  await transport.flush()

  const progressWire = transport.wire.findLast(frame => frame.type === 'acquisition-progress')
  await t.exception(transport.left.inject(progressWire), /replay|sequence/)
  await t.exception(transport.left.inject({ ...progressWire, purpose: 'acquisition-discovery' }), /wrong acquisition discovery frame type/)
  await t.exception(transport.left.inject({ ...progressWire, assignmentId: 'ff'.repeat(32) }), /scope topic/)
  await t.exception(transport.left.inject({ ...progressWire, peerId: 'aa'.repeat(32) }), /Noise peer|audience/)

  const staticCore = createStaticAssetManifest({
    treeHash: '77'.repeat(32),
    blockLength: 1,
    byteLength: 1024,
    blockSize: 256 * 1024,
  })
  const rendition = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: staticCore })
  current += 1_000
  const resultInput = {
    assignmentId: assigned.assignment.assignmentId,
    sourceIdentity: { kind: 'sha256', value: '88'.repeat(32) },
    assets: [{ purpose: rendition.purpose, format: rendition.format, renditionId: rendition.renditionId, core: rendition.core }],
    acquiredBytes: 1024,
    completedAt: current,
    availabilityUntil: current + 30_000,
  }
  await worker.result(resultInput)
  await transport.flush()
  t.is(requesterEvents.at(-1)[0], 'result')
  await t.exception(worker.result(resultInput), /terminal|replay/)
  const resultWire = transport.wire.findLast(frame => frame.type === 'acquisition-result')
  await t.exception(transport.left.inject(resultWire), /scope topic|not retained|audience|terminal|replay/)
  t.absent(transport.left.assignments.get(assigned.assignment.assignmentId))
  t.ok(transport.right.assignments.has(assigned.assignment.assignmentId))

  current = assigned.assignment.deadline + 1
  const deadlineTimer = workerTimers.find(timer => !timer.cleared)
  await deadlineTimer.fn()
  t.absent(transport.right.assignments.get(assigned.assignment.assignmentId))

  await requester.cancel({
    requestId: requested.request.requestId,
    peerId: id(workerKeyPair),
    reasonCode: 'requester-cancelled',
  })
  await transport.flush()
  t.is(workerEvents.at(-1)[1].cancellation.reasonCode, 'requester-cancelled')

  const wrongTopic = createScopedProtocolSession({
    peerId: id(workerKeyPair),
    purpose: 'acquisition',
    topic: deriveAcquisitionTopic({ assignmentId: assigned.assignment.assignmentId }),
    requiredCapability: ACQUISITION_WORK_CAPABILITY,
  })
  await t.exception(wrongTopic.acceptHello(encodeScopedHello({
    purpose: 'acquisition',
    topic: deriveAcquisitionTopic({ assignmentId: 'ee'.repeat(32) }),
    capabilities: [ACQUISITION_WORK_CAPABILITY],
  })), /topic mismatch/)
  const wrongPurpose = createScopedProtocolSession({
    peerId: id(workerKeyPair),
    purpose: 'acquisition-discovery',
    topic: deriveAcquisitionDiscoveryTopic({ networkId: 'peartube-main' }),
    requiredCapability: ACQUISITION_DISCOVERY_CAPABILITY,
  })
  await t.exception(wrongPurpose.acceptHello(encodeScopedHello({
    purpose: 'acquisition',
    topic: deriveAcquisitionDiscoveryTopic({ networkId: 'peartube-main' }),
    capabilities: [ACQUISITION_WORK_CAPABILITY],
  })), /purpose mismatch/)

  const frame = encodePeerFrame({ purpose: 'acquisition', type: 'acquisition-progress', requestId: 1, payload: b4a.alloc(0) })
  t.ok(frame.byteLength > 0, 'new purpose is accepted without renumbering old frames')
  t.ok(requesterTimers.length > 0 && workerTimers.length > 0, 'assignment deadlines are armed')

  await requester.close()
  await worker.close()
  t.ok(transport.left.releasedDiscovery > 0)
  t.ok(transport.right.releasedDiscovery > 0)
})
