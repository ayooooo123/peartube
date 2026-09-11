import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createRenditionDescriptor } from '../src/assets/rendition.js'
import { createStaticAssetManifest } from '../src/assets/static-core.js'
import {
  ACQUISITION_BODY_VERSION,
  ACQUISITION_DISCOVERY_CAPABILITY,
  ACQUISITION_WORK_CAPABILITY,
  createAcquisitionNetwork,
  createScopedProtocolSession,
  decodeAcquisitionOffer,
  decodeAcquisitionRequest,
  decodeAssetBlockRequest,
  deriveAcquisitionDiscoveryTopic,
  deriveAcquisitionTopic,
  encodeAcquisitionRequest,
  encodeAssetBlockError,
  encodeAssetBlockResponse,
  encodePeerFrame,
  encodeScopedHello,
  peerFrameTypeCode,
  topicHex,
} from '../src/network/index.js'
import {
  assertNoPrivateSourceMaterial,
  CLOSED_ACQUISITION_POLICY,
  createAcquisitionCoordinator,
  createAcquisitionStore,
  normalizeAcquisitionPolicy,
} from '../src/acquisition/index.js'
import { createProviderSubsystem } from '../src/provider/subsystem.js'

function queryView() {
  return {
    async query() { return { results: [], nextCursor: null } },
    async getEntity() { return null },
    async getPublication() { return null },
    async getManifest() { return null },
    async getRendition() { return null },
    async authorizeRendition() { return false },
    async isVisible() { return true },
  }
}

const emptyIndexVerifier = Object.freeze({
  async searchIndexCandidates() { return [] },
  async verifyIndexCandidate() { throw new Error('not found') },
})


function fakeBee() {
  const map = new Map()
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    async get(key) { return map.has(key) ? { value: clone(map.get(key)) } : null },
    batch() {
      const operations = []
      return {
        async put(key, value) { operations.push(['put', key, clone(value)]) },
        async del(key) { operations.push(['del', key]) },
        async flush() { for (const [op, key, val] of operations) { if (op === 'put') map.set(key, val); else map.delete(key) } }
      }
    },
    async * createReadStream({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if ((!gte || key >= gte) && (!lt || key < lt)) yield { key, value: clone(map.get(key)) }
      }
    }
  }
}

function id(keyPair) {
  return b4a.toString(keyPair.publicKey, 'hex')
}

function openAcquisitionPolicy(overrides = {}) {
  return normalizeAcquisitionPolicy({
    ...CLOSED_ACQUISITION_POLICY,
    migrationRequired: false,
    enabled: true,
    acceptPublicRequests: true,
    requesterMode: 'public',
    allowedPublisherIds: ['33'.repeat(32)],
    allowedAdapterIds: ['local-adapter'],
    maxQueuedJobs: 8,
    maxConcurrentJobs: 4,
    maxConcurrentPerRequester: 2,
    maxRequestBytes: 16 * 1024 * 1024,
    maxAcquireBytesPer24h: 64 * 1024 * 1024,
    maxAcquireBytesPerSecond: 10 * 1024 * 1024,
    maxStagingBytes: 16 * 1024 * 1024,
    minFreeDiskBytes: 1,
    maxJobRuntimeMs: 60_000,
    sourceGrantTtlMs: 30_000,
    publicRequestsPerMinute: 8,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 10,
    ...overrides,
  })
}

function acquisitionNetworkTerms({ enabled = true, generation = 1, overrides = {} } = {}) {
  const current = openAcquisitionPolicy({
    enabled,
    acceptPublicRequests: enabled,
    requesterMode: enabled ? 'public' : 'local-only',
    allowedPublisherIds: [],
    ...overrides,
  })
  return {
    ...current,
    generation,
    remainingAcquireBytes24h: current.maxAcquireBytesPer24h,
  }
}

function policy(enabled) {
  return {
    networkTerms: () => acquisitionNetworkTerms({ enabled }),
  }
}

async function persistAcquisitionPolicy(subsystem, policyValue) {
  const result = await subsystem.api.setAcquisitionPolicy({
    policy: { ...policyValue, revision: 0 },
    consent: { version: 1, granted: true },
    expectedRevision: 0,
  })
  if (!result.success) {
    const error = new Error(result.error?.message || 'test acquisition policy setup failed')
    error.code = result.error?.code || 'ACQUISITION_POLICY_SETUP_FAILED'
    throw error
  }
  return result.policy
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
        // Observe async rejection immediately; flush still propagates it.
        work.catch(() => {})
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
    generation: 1,
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

function requestBody(signerId, transportId, input) {
  return {
    version: ACQUISITION_BODY_VERSION,
    requesterId: signerId,
    requesterTransportKey: transportId,
    publisherId: input.publisherId,
    sourceRef: input.sourceRef,
    publicationIntentDigest: input.publicationIntentDigest,
    generation: input.generation ?? 1,
    output: input.output,
    budget: input.budget,
    resultHoldUntil: input.resultHoldUntil,
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
  const body = requestBody(id(signer), id(signer), input)
  const encoded = encodeAcquisitionRequest({
    body,
    keyPair: signer,
    nonce: b4a.alloc(32, 9),
    issuedAt,
    expiresAt: input.expiresAt,
  })
  const decoded = await decodeAcquisitionRequest(encoded, { now: issuedAt, transportPeerId: signer.publicKey })
  t.is(decoded.body.requesterId, id(signer))
  t.is(decoded.body.version, ACQUISITION_BODY_VERSION)
  t.is(decoded.body.generation, 1)
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
  // v1 body fields are rejected by v2 codecs (incompatible generation field).
  t.exception(() => encodeAcquisitionRequest({
    body: {
      version: 1,
      requesterId: id(signer),
      requesterTransportKey: id(signer),
      publisherId: input.publisherId,
      sourceRef: input.sourceRef,
      publicationIntentDigest: input.publicationIntentDigest,
      output: input.output,
      budget: input.budget,
      resultHoldUntil: input.resultHoldUntil,
    },
    keyPair: signer,
    nonce: b4a.alloc(32, 9),
    issuedAt,
    expiresAt: input.expiresAt,
  }), /version|fields/)
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
  const requesterAssignment = transport.left.assignments.get(assigned.assignment.assignmentId)
  transport.left.assignments.delete(assigned.assignment.assignmentId)
  const pendingExpiry = workerTimers.find(timer => !timer.cleared)
  const unavailable = await worker.result(resultInput)
  await transport.flush()
  t.is(unavailable.delivery.sent, 0, 'disconnected result recipient is not a successful delivery')
  t.is(requesterEvents.filter(([name]) => name === 'result').length, 0)
  t.is(pendingExpiry.cleared, false, 'undelivered result does not advance the assignment expiry')
  transport.left.assignments.set(assigned.assignment.assignmentId, requesterAssignment)
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
  t.ok(transport.right.assignments.has(assigned.assignment.assignmentId), 'result scope survives the acquisition deadline')
  current = resultInput.availabilityUntil
  await workerTimers.find(timer => !timer.cleared).fn()
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

test('synchronous cancellation publication failure tears down request, offer, and worker slot', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 13))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 14))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 250_000
  const workerTerms = {
    ...policy(true).networkTerms(),
    maxConcurrentJobs: 1,
    maxConcurrentPerRequester: 1,
  }
  const requester = createAcquisitionNetwork({
    scopedNetwork: transport.left,
    keyPair: requesterKeyPair,
    policy: policy(false),
    manager: manager([]),
    now: () => current,
  })
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: { networkTerms: () => workerTerms },
    manager: manager([]),
    now: () => current,
  })

  await requester.start()
  await worker.start()

  const first = await requester.publishRequest(requestInput(current))
  await transport.flush()
  const firstOffer = await worker.publishOffer({
    requestId: first.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '66'.repeat(32),
  })
  await transport.flush()

  // The frame reaches the peer, but the synchronous transport call reports a
  // failure. Both local finally paths must still release their indexes.
  const publish = transport.left.publishAcquisitionFrame
  let failOnce = true
  transport.left.publishAcquisitionFrame = function (input) {
    const delivery = publish.call(this, input)
    if (failOnce && input.type === 'acquisition-cancel') {
      failOnce = false
      throw Object.assign(new Error('synchronous cancellation publication failed'), { code: 'SYNC_PUBLISH_FAILED' })
    }
    return delivery
  }

  await t.exception(requester.cancel({
    requestId: first.request.requestId,
    peerId: id(workerKeyPair),
    reasonCode: 'requester-cancelled',
  }), /synchronous cancellation publication failed/)
  await transport.flush()

  // Requester teardown removed its local request and indexed remote offer.
  await t.exception(requester.assign({
    requestId: first.request.requestId,
    offerId: firstOffer.offer.offerId,
  }), /unknown/)
  // Authenticated peer teardown removed the worker request and its offer slot.
  await t.exception(worker.publishOffer({
    requestId: first.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '77'.repeat(32),
  }), /not retained/)

  const second = await requester.publishRequest({ ...requestInput(current), sourceRef: 'T'.repeat(43) })
  await transport.flush()
  const secondOffer = await worker.publishOffer({
    requestId: second.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '88'.repeat(32),
  })
  t.ok(secondOffer.offer.offerId, 'one-slot worker can offer again after failed cancellation publication')

  transport.left.publishAcquisitionFrame = publish
  await requester.cancel({
    requestId: second.request.requestId,
    peerId: id(workerKeyPair),
    reasonCode: 'requester-cancelled',
  })
  await transport.flush()
  await requester.close()
  await worker.close()
})

test('coordinator refuses worker execution without a bound acquisition manager', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 21))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 22))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 300_000

  const requesterBee = fakeBee()
  const requesterStore = createAcquisitionStore({ bee: requesterBee, now: () => current })
  const requesterPolicy = {
    getPolicy: async () => openAcquisitionPolicy(),
  }

  const workerBee = fakeBee()
  const workerStore = createAcquisitionStore({ bee: workerBee, now: () => current })
  const workerPolicy = {
    getPolicy: async () => openAcquisitionPolicy(),
    networkTerms: async () => policy(true).networkTerms(),
  }

  const staticCore = createStaticAssetManifest({
    treeHash: '99'.repeat(32),
    blockLength: 1,
    byteLength: 2048,
    blockSize: 256 * 1024,
  })
  const rendition = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: staticCore })
  const staticCoreRef = rendition.core

  let workerVerified = false
  const workerProvider = {
    canOpen() { return true },
    async open() {
      return {
        resumable: true,
        maxReadBytes: 1024 * 1024,
        async describe() { return { byteLength: 2048, identity: { kind: 'sha256', value: '88'.repeat(32) } } },
        async close() {},
      }
    },
    async acquire() {
      return { descriptor: staticCoreRef }
    },
    async verify() {
      workerVerified = true
      return { verified: true, byteLength: 2048 }
    },
  }

  let requesterVerified = false
  const requesterProvider = {
    async verify({ asset, expected }) {
      requesterVerified = asset.byteLength === expected.byteLength &&
        asset.assetId === staticCoreRef.assetId &&
        asset.key === staticCoreRef.key &&
        asset.treeHash === staticCoreRef.treeHash &&
        asset.length === staticCoreRef.length &&
        asset.blockSize === staticCoreRef.blockSize
      return { verified: requesterVerified, byteLength: expected.byteLength }
    },
  }

  let publisherPublished = false
  const requesterPublisher = {
    async hasAuthority() { return true },
    async publish({ asset, source }) {
      publisherPublished = true
      return {
        publicationId: '77'.repeat(32),
        manifestId: '66'.repeat(32),
        renditionId: rendition.renditionId,
        assetId: asset.assetId,
      }
    },
  }

  const requesterCoordinator = createAcquisitionCoordinator({
    store: requesterStore,
    policy: requesterPolicy,
    provider: requesterProvider,
    publisher: requesterPublisher,
    now: () => current,
  })

  const workerCoordinator = createAcquisitionCoordinator({
    store: workerStore,
    policy: workerPolicy,
    provider: workerProvider,
    publisher: { hasAuthority: async () => true, async publish() {} },
    now: () => current,
  })

  const requesterNetwork = createAcquisitionNetwork({
    scopedNetwork: transport.left,
    keyPair: requesterKeyPair,
    policy: policy(false),
    manager: requesterCoordinator.networkManager,
    now: () => current,
  })
  requesterCoordinator.attachNetwork(requesterNetwork)

  const workerNetwork = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: policy(true),
    manager: workerCoordinator.networkManager,
    now: () => current,
  })
  workerCoordinator.attachNetwork(workerNetwork)

  await requesterNetwork.start()
  await workerNetwork.start()
  await requesterCoordinator.start()
  await workerCoordinator.start()

  // 1. Create durable acquisition request on requester
  const acquisitionId = 'acq_coord_test_1'
  const expectedBytes = 2048
  const requestInputData = {
    schemaVersion: 1,
    resolutionRef: 'B'.repeat(43),
    publisherId: '33'.repeat(32),
    retentionClass: 'archive-pin',
  }
  await requesterStore.createOrReplay({
    idempotencyDigest: 'd'.repeat(64),
    requestFingerprint: 'f'.repeat(64),
    job: {
      schemaVersion: 1,
      acquisitionId,
      idempotencyDigest: 'd'.repeat(64),
      requestFingerprint: 'f'.repeat(64),
      state: 'queued',
      version: 0,
      principalId: 'local-user',
      publisherId: requestInputData.publisherId,
      requesterPublisherIds: [requestInputData.publisherId],
      isRemote: false,
      request: requestInputData,
      retentionClass: 'archive-pin',
      publicationMetadata: null,
      expectedBytes,
      expectedIdentity: null,
      sourceBytesRead: 0,
      sourceBytesAccepted: 0,
      bytesAcquired: 0,
      verifiedBytes: 0,
      committedBytes: 0,
      retainedBytes: 0,
      stagingBytes: 0,
      stagingPeakBytes: 0,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      verifiedPrefix: null,
      verifiedAsset: null,
      publication: null,
      errorCode: null,
      recoverable: true,
      createdAt: current,
      updatedAt: current,
    },
  })

  // Publish request via coordinator
  const published = await requesterCoordinator.managerNetwork.publishRequest({
    acquisitionId,
    request: { ...requestInputData, expectedBytes },
  })
  await t.exception(transport.flush(), { code: 'COORDINATION_MANAGER_UNAVAILABLE' })
  t.is((await requesterStore.get(acquisitionId)).state, 'queued')
  t.absent(workerVerified, 'no legacy provider-only acquisition bypasses the manager')
  t.absent(requesterVerified)
  t.absent(publisherPublished, 'an unbound worker cannot cause publication')
  t.absent(transport.wire.some(frame => frame.type === 'acquisition-result'))

  await requesterNetwork.close()
  await workerNetwork.close()
  await requesterCoordinator.close()
  await workerCoordinator.close()
})

test('decoupled signing authority from Noise transport identity rejects stale or mismatched session bindings', async (t) => {
  const appSigner = crypto.keyPair(b4a.alloc(32, 31))
  const transportPeer = crypto.keyPair(b4a.alloc(32, 32))
  const wrongTransportPeer = crypto.keyPair(b4a.alloc(32, 33))
  let current = 400_000

  const input = requestInput(current)
  const body = requestBody(id(appSigner), id(transportPeer), input)

  // 1. Signed by application key, binds transport key
  const payload = encodeAcquisitionRequest({
    body,
    keyPair: appSigner,
    nonce: b4a.alloc(32, 1),
    issuedAt: current,
    expiresAt: input.expiresAt,
  })

  // Valid when transportPeerId matches bound transport key
  const valid = await decodeAcquisitionRequest(payload, { now: current, transportPeerId: id(transportPeer) })
  t.is(valid.body.requesterId, id(appSigner))
  t.is(valid.body.requesterTransportKey, id(transportPeer))
  t.is(valid.body.generation, 1)

  // Fails when observed transportPeerId does not match bound transport key
  await t.exception(
    decodeAcquisitionRequest(payload, { now: current, transportPeerId: id(wrongTransportPeer) }),
    /Noise peer|transport key/
  )

  // 2. Fails when session binding has expired
  await t.exception(
    decodeAcquisitionRequest(payload, { now: input.expiresAt + 31_000, transportPeerId: id(transportPeer) }),
    /lifetime|expired/
  )
})

test('coordinator durability across restart: recovers active assignment, expires overdue deadlines, and rejects stale policy epoch', async (t) => {
  const bee = fakeBee()
  let current = 500_000
  const store = createAcquisitionStore({ bee, now: () => current })

  // 1. Save an active coordination record
  const fixtureBudget = {
    maxSourceBytes: 1024,
    maxOutputBytes: 1024,
    maxNetworkBytes: 2048,
    maxWallClockMs: 60_000,
  }
  // 1. Save an active coordination record
  await store.saveCoordination('acq_active_1', {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId: '33'.repeat(32),
    peerId: '44'.repeat(32),
    requesterId: 'aa'.repeat(32),
    acquirerId: 'bb'.repeat(32),
    publisherId: '33'.repeat(32),
    publicationIntentDigest: '55'.repeat(32),
    budget: fixtureBudget,
    resultHoldUntil: current + 120_000,
    requestGeneration: 2,
    epoch: 1,
    deadline: current + 10_000,
    progress: null,
    result: null,
    error: null,
  })

  // Save an expired coordination record
  await store.saveCoordination('acq_expired_1', {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '55'.repeat(32),
    offerId: '66'.repeat(32),
    assignmentId: '77'.repeat(32),
    peerId: '88'.repeat(32),
    requesterId: 'aa'.repeat(32),
    acquirerId: 'bb'.repeat(32),
    publisherId: '33'.repeat(32),
    publicationIntentDigest: '55'.repeat(32),
    budget: fixtureBudget,
    resultHoldUntil: current + 120_000,
    requestGeneration: 2,
    epoch: 1,
    deadline: current - 1_000,
    progress: null,
    result: null,
    error: null,
  })

  // Verify enumeration before restart
  const activeBefore = await store.listActiveCoordinations()
  t.is(activeBefore.length, 2)

  // Create new coordinator instance simulating restart
  const coordinator = createAcquisitionCoordinator({
    store,
    policy: { networkTerms: async () => acquisitionNetworkTerms({ generation: 2 }) },
    provider: { canOpen: () => true },
    publisher: { hasAuthority: async () => true, async publish() {} },
    now: () => current,
  })

  await coordinator.start()

  // Expired coordination was transitioned to failed
  const expiredCoord = await store.getCoordination('acq_expired_1')
  t.is(expiredCoord.phase, 'failed')
  t.is(expiredCoord.error?.code, 'ACQUISITION_DEADLINE_EXCEEDED')

  // Active unexpired coordination remains active
  const activeCoord = await store.getCoordination('acq_active_1')
  t.is(activeCoord.phase, 'assigned')

  // Lookup by assignment and request pointers work
  const byAssignment = await store.getCoordinationByAssignment('33'.repeat(32))
  t.is(byAssignment.acquisitionId, 'acq_active_1')
  const byRequest = await store.getCoordinationByRequest('11'.repeat(32))
  t.is(byRequest.acquisitionId, 'acq_active_1')

  await coordinator.close()
})


test('distributed acquisition: worker without publisher authority acquires/verifies only; requester imports exact blocks and publishes once under competing offers', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const Corestore = (await import('corestore')).default
  const { createBufferSourceReader } = await import('../src/assets/source-reader.js')

  const requesterDir = mkdtempSync(join(tmpdir(), 'peartube-acq-req-'))
  const workerDir = mkdtempSync(join(tmpdir(), 'peartube-acq-wrk-'))
  const requesterStore = new Corestore(requesterDir)
  const workerStore = new Corestore(workerDir)
  await requesterStore.ready()
  await workerStore.ready()
  t.teardown(async () => {
    await requesterStore.close().catch(() => {})
    await workerStore.close().catch(() => {})
    rmSync(requesterDir, { recursive: true, force: true })
    rmSync(workerDir, { recursive: true, force: true })
  })

  const SOURCE = b4a.from('permissionless distributed acquisition payload bytes')
  const workerSource = createBufferSourceReader(SOURCE, { mimeType: 'application/octet-stream' })
  const sourceIdentity = (await workerSource.describe()).identity
  const expectedBytes = SOURCE.byteLength

  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 51))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 52))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 700_000
  const publisherId = '33'.repeat(32)
  const sourceRef = 'R'.repeat(43)

  const openPolicy = openAcquisitionPolicy({ allowedPublisherIds: [publisherId] })

  let workerPublishCalls = 0
  let requesterPublishCalls = 0
  const workerUpload = {
    hasPublisherAuthority: async () => false,
    getAuthorizedPublisherIds: async () => [],
    getAcquiredPublication: async () => null,
    publishAcquiredAsset: async () => {
      workerPublishCalls++
      throw new Error('worker must never publish into requester catalog')
    },
  }
  const requesterUpload = {
    hasPublisherAuthority: async ({ publisherId: id }) => id === publisherId,
    getAuthorizedPublisherIds: async () => [publisherId],
    getAcquiredPublication: async () => null,
    publishAcquiredAsset: async ({ asset }) => {
      requesterPublishCalls++
      return {
        publicationId: 'p'.repeat(64),
        manifestId: 'm'.repeat(64),
        renditionId: 'r'.repeat(64),
        assetId: asset.assetId,
      }
    },
  }
  const mediaApi = { openMediaRenditionUrl: async () => ({ success: true, url: 'peartube://stream' }) }

  const workerSubsystem = await createProviderSubsystem({
    ctx: {
      metaDb: fakeBee(),
      store: workerStore,
      scopedNetwork: transport.right,
    },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: emptyIndexVerifier,
    uploadManager: workerUpload,
    mediaApi,
    config: {
      acquisitionPolicy: openPolicy,
      acquisitionKeyPair: workerKeyPair,
      acquisitionProvider: {
        adapterId: 'local-adapter',
        canOpen: ({ ref }) => ref === sourceRef,
        resolve: async () => ({
          adapterId: 'local-adapter',
          expected: { byteLength: expectedBytes, identity: sourceIdentity },
        }),
        // open only — default subsystem acquire writes via writeStaticAsset
        open: async () => workerSource,
      },
    },
    now: () => current,
  })

  const requesterSubsystem = await createProviderSubsystem({
    ctx: {
      metaDb: fakeBee(),
      store: requesterStore,
      scopedNetwork: transport.left,
    },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: emptyIndexVerifier,
    uploadManager: requesterUpload,
    mediaApi,
    config: {
      acquisitionPolicy: openPolicy,
      acquisitionKeyPair: requesterKeyPair,
      acquisitionProvider: {
        adapterId: 'local-adapter',
        canOpen: () => false,
        resolve: async () => ({
          expected: { byteLength: expectedBytes, identity: sourceIdentity },
          deferredInput: false,
        }),
      },
    },
    now: () => current,
  })
  t.teardown(async () => {
    await requesterSubsystem.close().catch(() => {})
    await workerSubsystem.close().catch(() => {})
  })

  for (const subsystem of [workerSubsystem, requesterSubsystem]) {
    const appliedPolicy = await persistAcquisitionPolicy(subsystem, openPolicy)
    t.is(appliedPolicy.revision, 1, 'provider policy revision establishes the node-local network generation')
  }

  // Local-only private path still works without network when no scoped network is configured.
  {
    const localDir = mkdtempSync(join(tmpdir(), 'peartube-acq-local-'))
    const localStore = new Corestore(localDir)
    await localStore.ready()
    t.teardown(async () => {
      await localStore.close().catch(() => {})
      rmSync(localDir, { recursive: true, force: true })
    })
    const localPolicy = { ...openPolicy, requesterMode: 'local-only', acceptPublicRequests: false, allowedAdapterIds: ['memory-source'] }
    const local = await createProviderSubsystem({
      ctx: { metaDb: fakeBee(), store: localStore },
      verifiedQueryView: queryView(),
      indexVerificationRuntime: emptyIndexVerifier,
      uploadManager: requesterUpload,
      mediaApi,
      config: {
        acquisitionPolicy: localPolicy,
        sourceGrantResolver: {
          async resolve() { return createBufferSourceReader(SOURCE, { mimeType: 'application/octet-stream' }) },
        },
      },
      now: () => current,
    })
    t.teardown(() => local.close())
    await persistAcquisitionPolicy(local, localPolicy)
    const resolution = local.issueLocalResolution({
      title: 'Local only',
      selector: { namespace: 'catalog', identifier: 'local-1', kind: 'movie' },
      publisherId,
      expectedBytes: SOURCE.byteLength,
    })
    const principal = { principalId: 'local-user', isLocal: true, publisherIds: [publisherId] }
    const queued = await local.manager.request({
      idempotencyKey: 'local-only-1',
      request: {
        schemaVersion: 1,
        resolutionRef: resolution.resolutionRef,
        publisherId,
        retentionClass: 'archive-pin',
      },
      principal,
    })
    await local.manager.attachGrant({
      acquisitionId: queued.acquisitionId,
      principal,
      grant: {
        token: 'G'.repeat(43),
        adapterId: 'memory-source',
        audience: { principalId: principal.principalId, acquisitionId: queued.acquisitionId },
        expiresAt: current + 10_000,
      },
    })
    let localDone = null
    for (let i = 0; i < 400; i++) {
      localDone = await local.manager.get({ acquisitionId: queued.acquisitionId, principal })
      if (localDone.state === 'completed' || localDone.state === 'failed') break
      await new Promise(r => setTimeout(r, 5))
    }
    t.is(localDone.state, 'completed', localDone.errorCode || 'local completed')
  }
  const publicationsBeforeRemote = requesterPublishCalls

  let assignmentPersistedBeforeDispatch = false
  const dispatchAssignment = requesterSubsystem.acquisitionNetwork.dispatchAssignment
  requesterSubsystem.acquisitionNetwork.dispatchAssignment = async prepared => {
    const persisted = await requesterSubsystem.store.getCoordinationByAssignment(prepared.assignment.assignmentId)
    assignmentPersistedBeforeDispatch = persisted?.assignmentId === prepared.assignment.assignmentId
    return dispatchAssignment(prepared)
  }
  const publishOffer = workerSubsystem.acquisitionNetwork.publishOffer
  workerSubsystem.acquisitionNetwork.publishOffer = async input => {
    const [first] = await Promise.all([
      publishOffer(input),
      publishOffer({ ...input, availableUntil: input.availableUntil - 1 }),
    ])
    return first
  }

  // Requester creates public acquisition; worker has no local source grant and no publisher authority.
  const job = await requesterSubsystem.manager.request({
    idempotencyKey: 'distributed-real-1',
    request: {
      schemaVersion: 1,
      resolutionRef: sourceRef,
      publisherId,
      retentionClass: 'archive-pin',
    },
    principal: { principalId: 'requester-principal', isLocal: true, publisherIds: [publisherId] },
  })
  t.is(job.state, 'queued')
  // Before assignment the requester must not hold any random core under a known key.
  // Worker store must also start empty for this source (no pre-seed).
  {
    // Probe a non-existent key shape — worker has no verifiedAsset yet.
    const probeKey = crypto.hash(b4a.from('no-asset-yet'))
    const empty = workerStore.get({ key: probeKey })
    await empty.ready()
    t.is(empty.length, 0, 'worker starts without the acquired core')
    await empty.close()
  }

  await transport.flush()
  const requesterCoord = await requesterSubsystem.store.getCoordination(job.acquisitionId)
  t.ok(requesterCoord)
  t.ok(requesterCoord.requestId)
  t.ok(requesterCoord.assignmentId)
  t.ok(assignmentPersistedBeforeDispatch, 'durable assignment exists before dispatch')

  // Competing offers: only one assignment wins under CAS.
  const offerFrames = transport.wire.filter(frame => frame.type === 'acquisition-offer')
  t.is(offerFrames.length, 2, 'worker emitted competing valid offers')
  t.is(transport.wire.filter(frame => frame.type === 'acquisition-assignment').length, 1, 'only one assignment was dispatched')
  let secondError = null
  try {
    await requesterSubsystem.store.claimCoordinationAssignment(job.acquisitionId, {
      schemaVersion: 1,
      offerId: 'ab'.repeat(32),
      assignmentId: 'cd'.repeat(32),
      peerId: 'ef'.repeat(32),
      requesterId: id(requesterKeyPair),
      acquirerId: id(workerKeyPair),
      publisherId,
      publicationIntentDigest: '55'.repeat(32),
      budget: {
        maxSourceBytes: expectedBytes,
        maxOutputBytes: expectedBytes,
        maxNetworkBytes: expectedBytes * 2,
        maxWallClockMs: 60_000,
      },
      resultHoldUntil: current + 120_000,
      epoch: 1,
      deadline: current + 10_000,
    })
  } catch (error) {
    secondError = error
  }
  t.is(secondError?.code, 'COORDINATION_ALREADY_ASSIGNED', 'second concurrent assignment loses the durable CAS')

  await transport.flush()
  await transport.flush()

  // Worker must finish acquisition-only as verified without publishing.
  let workerJob = null
  // Enumerate worker jobs via store list.
  const workerPage = await workerSubsystem.store.list({ limit: 16 })
  workerJob = workerPage.items.find(item => item.isRemote === true) || workerPage.items[0]
  t.ok(workerJob, 'worker created a durable acquisition job')
  t.is(workerJob.isRemote, true)
  for (let i = 0; i < 400; i++) {
    workerJob = await workerSubsystem.store.get(workerJob.acquisitionId)
    if (workerJob.state === 'verified' || workerJob.state === 'failed' || workerJob.state === 'cancelled') break
    await transport.flush()
    await new Promise(r => setTimeout(r, 5))
  }
  t.is(workerJob.state, 'verified', workerJob.errorCode || 'worker verified')
  t.is(workerPublishCalls, 0, 'worker never published')
  t.ok(workerJob.verifiedAsset, 'worker holds verified static output')
  const descriptor = workerJob.verifiedAsset

  // Worker coordination bound to the same manager-generated acquisitionId.
  const boundWorkerCoord = await workerSubsystem.store.getCoordination(workerJob.acquisitionId)
  t.ok(boundWorkerCoord)
  t.is(boundWorkerCoord.role, 'worker')
  t.is(boundWorkerCoord.acquisitionId, workerJob.acquisitionId)

  // Drive result delivery + requester import/publish.
  await transport.flush()
  await transport.flush()
  let completed = null
  for (let i = 0; i < 800; i++) {
    completed = await requesterSubsystem.manager.get({
      acquisitionId: job.acquisitionId,
      principal: { principalId: 'requester-principal' },
    })
    if (completed.state === 'completed' || completed.state === 'failed') break
    await transport.flush()
    await new Promise(r => setTimeout(r, 5))
  }
  t.is(completed.state, 'completed', completed.errorCode || 'requester completed')
  t.is(requesterPublishCalls, publicationsBeforeRemote + 1, 'requester published exactly once')
  t.is(workerPublishCalls, 0, 'worker still never published')
  const completedWorkerCoord = await workerSubsystem.store.getCoordination(workerJob.acquisitionId)
  const wireSourceIdentity = completedWorkerCoord.result.sourceIdentity
  t.not(wireSourceIdentity.value, sourceIdentity.value, 'raw source identity stays off the wire')
  const durableRequesterJob = await requesterSubsystem.store.get(job.acquisitionId)
  t.is(durableRequesterJob.verifiedBytes, expectedBytes)
  t.is(workerJob.verifiedBytes, expectedBytes)
  const projection = await requesterSubsystem.manager.getPublicProjection({ acquisitionId: job.acquisitionId })
  t.is(projection.state, 'completed')
  t.is(projection.publisherId, publisherId)
  t.is(projection.expectedBytes, expectedBytes)
  t.is(projection.publicationId, completed.publicationId)
  t.is(projection.renditionId, completed.renditionId)

  // Requester now holds verified blocks for the immutable descriptor produced by worker.
  const imported = requesterStore.get({ key: b4a.from(descriptor.key, 'hex') })
  await imported.ready()
  t.is(imported.length, descriptor.length)
  t.is(imported.byteLength, descriptor.byteLength)
  t.alike(await imported.get(0), SOURCE, 'requester imported the exact worker bytes through the verified block protocol')
  await imported.close()

  // Forged/stale binding rejected by transport key mismatch.
  const forged = encodeAcquisitionRequest({
    body: {
      version: ACQUISITION_BODY_VERSION,
      requesterId: id(requesterKeyPair),
      requesterTransportKey: id(workerKeyPair), // wrong transport binding
      publisherId,
      sourceRef,
      publicationIntentDigest: '55'.repeat(32),
      generation: 1,
      output: { purpose: 'original', formats: ['application/octet-stream'] },
      budget: {
        maxSourceBytes: expectedBytes,
        maxOutputBytes: expectedBytes,
        maxNetworkBytes: expectedBytes * 2,
        maxWallClockMs: 20_000,
      },
      resultHoldUntil: current + 120_000,
    },
    keyPair: requesterKeyPair,
    nonce: crypto.randomBytes(32),
    issuedAt: current,
    expiresAt: current + 30_000,
  })
  await t.exception(
    decodeAcquisitionRequest(forged, { now: current, transportPeerId: id(requesterKeyPair) }),
    /transport key|Noise peer/
  )

  // Restart recovery: result-ready re-dispatch path.
  const resultReadyId = 'restart-result-1'
  await requesterSubsystem.store.saveCoordination(resultReadyId, {
    schemaVersion: 1,
    role: 'requester',
    phase: 'result-ready',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId: '33'.repeat(32),
    peerId: id(workerKeyPair),
    requesterId: id(requesterKeyPair),
    acquirerId: id(workerKeyPair),
    sourceRef,
    publisherId,
    publicationIntentDigest: '55'.repeat(32),
    budget: {
      maxSourceBytes: expectedBytes,
      maxOutputBytes: expectedBytes,
      maxNetworkBytes: expectedBytes * 2,
      maxWallClockMs: 60_000,
    },
    resultHoldUntil: current + 120_000,
    epoch: 1,
    deadline: current + 60_000,
    progress: null,
    result: {
      acquiredBytes: descriptor.byteLength,
      completedAt: current,
      availabilityUntil: current + 120_000,
      sourceIdentity: wireSourceIdentity,
      assets: [{
        purpose: 'original',
        format: 'application/octet-stream',
        renditionId: createRenditionDescriptor({ purpose: 'original', format: 'application/octet-stream', core: { kind: 'static-prologue-v1', ...descriptor } }).renditionId,
        core: { kind: 'static-prologue-v1', ...descriptor },
      }],
    },
    error: null,
  })
  // Assigned coordination remains active across reconcile when deadline is live.
  await requesterSubsystem.store.saveCoordination('restart-assigned-1', {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '44'.repeat(32),
    offerId: '55'.repeat(32),
    assignmentId: '66'.repeat(32),
    peerId: id(workerKeyPair),
    requesterId: id(requesterKeyPair),
    acquirerId: id(workerKeyPair),
    publisherId,
    publicationIntentDigest: '55'.repeat(32),
    budget: {
      maxSourceBytes: expectedBytes,
      maxOutputBytes: expectedBytes,
      maxNetworkBytes: expectedBytes * 2,
      maxWallClockMs: 60_000,
    },
    resultHoldUntil: current + 120_000,
    epoch: 1,
    deadline: current + 30_000,
    progress: null,
    result: null,
    error: null,
  })
  await requesterSubsystem.coordinator.reconcile()
  const stillAssigned = await requesterSubsystem.store.getCoordination('restart-assigned-1')
  t.is(stillAssigned.phase, 'assigned')
})

test('requested-phase crash recovery: re-signs from durable intent, rotates requestId, rejects old callbacks, accepts competing offers', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 71))
  const workerAKeyPair = crypto.keyPair(b4a.alloc(32, 72))
  const workerBKeyPair = crypto.keyPair(b4a.alloc(32, 73))
  let current = 900_000

  const sourceRef = 'R'.repeat(43)
  const publisherId = id(requesterKeyPair)
  const openPolicy = {
    ...openAcquisitionPolicy({
      allowedPublisherIds: [publisherId],
      publicRequestsPerMinute: 32,
    }),
    // `generation` and `remainingAcquireBytes24h` are node-local network
    // terms derived from the normalized policy, not durable policy fields.
    generation: 3,
    remainingAcquireBytes24h: 64 * 1024 * 1024,
  }
  const networkPolicy = {
    networkTerms: () => openPolicy,
  }

  // Multi-peer transport: requester + two workers.
  const peers = new Map()
  const wire = []
  const pending = []
  function makeEndpoint (keyPair) {
    const endpoint = {
      peers: [],
      discovery: null,
      assignments: new Map(),
      getLocalTransportPeerId () { return id(keyPair) },
      async retainAcquisitionDiscovery (input) { this.discovery = input },
      async releaseAcquisitionDiscovery () { this.discovery = null; return true },
      async retainAcquisitionAssignment (input) { this.assignments.set(input.assignmentId, input) },
      async releaseAcquisitionAssignment ({ assignmentId }) {
        this.assignments.delete(assignmentId)
        return true
      },
      publishAcquisitionFrame (input) {
        const frame = { ...input, payload: b4a.from(input.payload), peerId: id(keyPair) }
        wire.push(frame)
        const targets = input.peerId
          ? this.peers.filter(peer => peer.getLocalTransportPeerId() === input.peerId)
          : this.peers
        for (const target of targets) {
          const retained = input.purpose === 'acquisition-discovery'
            ? target.discovery
            : target.assignments.get(input.assignmentId)
          if (!retained) continue
          const work = Promise.resolve().then(() => retained.onFrame(
            { type: input.type, payload: frame.payload },
            { peerId: id(keyPair), purpose: input.purpose, scopeId: input.assignmentId || 'peartube-main' },
          ))
          work.catch(() => {})
          pending.push(work)
        }
        return { sent: targets.length, peerIds: targets.map(peer => peer.getLocalTransportPeerId()) }
      },
    }
    peers.set(id(keyPair), endpoint)
    return endpoint
  }
  const requesterScoped = makeEndpoint(requesterKeyPair)
  const workerAScoped = makeEndpoint(workerAKeyPair)
  const workerBScoped = makeEndpoint(workerBKeyPair)
  requesterScoped.peers = [workerAScoped, workerBScoped]
  workerAScoped.peers = [requesterScoped]
  workerBScoped.peers = [requesterScoped]
  async function flush () {
    while (pending.length) await pending.shift().catch(() => {})
  }

  const bee = fakeBee()
  const store = createAcquisitionStore({ bee, now: () => current })

  function makeRequesterStack (scopedNetwork) {
    // Coordinator first so network can bind its live networkManager (not a stub).
    const coordinator = createAcquisitionCoordinator({
      store,
      policy: { networkTerms: async () => openPolicy },
      provider: { canOpen: () => false },
      publisher: { hasAuthority: async () => true, async publish () {} },
      network: null,
      autoSelect: false,
      now: () => current,
    })
    const network = createAcquisitionNetwork({
      scopedNetwork,
      keyPair: requesterKeyPair,
      policy: networkPolicy,
      manager: coordinator.networkManager,
      now: () => current,
    })
    coordinator.attachNetwork(network)
    return { network, coordinator }
  }

  // Phase 1: original requester publishes through coordinator (persist-before-wire).
  const first = makeRequesterStack(requesterScoped)
  await first.network.start()
  t.is(typeof first.network.republishRequest, 'undefined', 'memory-only republish path is eliminated')

  const published = await first.coordinator.managerNetwork.publishRequest({
    acquisitionId: 'acq-recover-1',
    request: {
      resolutionRef: sourceRef,
      publisherId,
      expectedBytes: 64 * 1024,
      output: { purpose: 'original', formats: ['application/octet-stream'] },
    },
  })
  const oldRequestId = published.request.requestId
  const beforeCrash = await store.getCoordination('acq-recover-1')
  t.is(beforeCrash.phase, 'requested')
  t.is(beforeCrash.requestId, oldRequestId)
  t.ok(beforeCrash.budget)
  t.ok(beforeCrash.output)
  t.ok(beforeCrash.publicationIntentDigest)
  t.is(beforeCrash.requestGeneration, 3)
  t.is(beforeCrash.epoch, 3)
  const durableDeadline = beforeCrash.deadline
  const durableHold = beforeCrash.resultHoldUntil

  // Crash before any offer: close requester network/coordinator; Bee survives.
  await first.network.close()
  await first.coordinator.close()
  // Clear live discovery so only durable store remains authoritative.
  requesterScoped.discovery = null

  // Phase 2: recreate requester over the same Bee; no memory of localRequests.
  const second = makeRequesterStack(requesterScoped)
  await second.network.start()
  await second.coordinator.start() // reconcile → recoverRequested
  await flush()

  const recovered = await store.getCoordination('acq-recover-1')
  t.is(recovered.phase, 'requested')
  t.ok(recovered.requestId)
  t.not(recovered.requestId, oldRequestId, 'requestId rotated on recovery')
  t.ok(recovered.supersededRequestIds.includes(oldRequestId), 'old requestId marked superseded')
  t.is(recovered.deadline, durableDeadline, 'canonical deadline not widened')
  t.is(recovered.resultHoldUntil, durableHold, 'canonical hold not widened')
  t.ok(await store.isSupersededRequest(oldRequestId))
  t.is(await store.getCoordinationByRequest(oldRequestId), null)
  t.is((await store.getCoordinationByRequest(recovered.requestId)).acquisitionId, 'acq-recover-1')

  // Old ID callback rejection at coordinator boundary.
  const stale = await second.coordinator.networkManager.onOffer({
    offer: {
      offerId: '22'.repeat(32),
      requestId: oldRequestId,
      acceptedBudget: recovered.budget,
      availableUntil: current + 10_000,
      policyEpoch: 3,
    },
    peerId: id(workerAKeyPair),
  })
  t.is(stale?.status, 'rejected')
  t.is(stale?.reason, 'request-superseded')
  t.is((await store.getCoordination('acq-recover-1')).assignmentId, null)

  const requestFrames = wire.filter(frame => frame.type === 'acquisition-request')
  t.ok(requestFrames.length >= 2, 'original + recovered request both hit the wire')
  const recoveredFrame = await decodeAcquisitionRequest(requestFrames.at(-1).payload, {
    now: current,
    transportPeerId: id(requesterKeyPair),
  })
  t.is(recoveredFrame.requestId, recovered.requestId)
  t.is(recoveredFrame.body.version, ACQUISITION_BODY_VERSION)
  t.is(recoveredFrame.body.generation, 3)

  // Two workers start and offer against the recovered requestId.
  const workerAEvents = []
  const workerBEvents = []
  const workerA = createAcquisitionNetwork({
    scopedNetwork: workerAScoped,
    keyPair: workerAKeyPair,
    policy: networkPolicy,
    manager: manager(workerAEvents),
    now: () => current,
  })
  const workerB = createAcquisitionNetwork({
    scopedNetwork: workerBScoped,
    keyPair: workerBKeyPair,
    policy: networkPolicy,
    manager: manager(workerBEvents),
    now: () => current,
  })
  await workerA.start()
  await workerB.start()

  // Replay recovered request onto both workers (discovery was down during resign).
  for (const workerScoped of [workerAScoped, workerBScoped]) {
    if (!workerScoped.discovery) continue
    await workerScoped.discovery.onFrame(
      { type: 'acquisition-request', payload: requestFrames.at(-1).payload },
      { peerId: id(requesterKeyPair), purpose: 'acquisition-discovery', scopeId: 'peartube-main' },
    )
  }
  await flush()

  // Competing offers arrive on the wire so network remoteOffers is armed before assign.
  const offerA = await workerA.publishOffer({
    requestId: recovered.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '66'.repeat(32),
  })
  const offerB = await workerB.publishOffer({
    requestId: recovered.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '77'.repeat(32),
  })
  await flush()

  // First assignment wins through coordinator managerNetwork (persist-before-wire + CAS).
  const firstAssign = await second.coordinator.managerNetwork.assign({
    acquisitionId: 'acq-recover-1',
    offer: offerA.offer,
  })
  t.is(firstAssign.claimed, true)
  t.ok(firstAssign.assignment?.assignmentId)

  // Second competing offer loses at the coordinator/manager boundary.
  const secondAssign = await second.coordinator.managerNetwork.assign({
    acquisitionId: 'acq-recover-1',
    offer: offerB.offer,
  })
  t.is(secondAssign.claimed, false, 'competing offer loses after recovery assignment')
  t.is(secondAssign.assignment.assignmentId, firstAssign.assignment.assignmentId)

  const assigned = await store.getCoordination('acq-recover-1')
  t.is(assigned.phase, 'assigned')
  t.is(assigned.requestId, recovered.requestId)
  t.is(assigned.assignmentId, firstAssign.assignment.assignmentId)
  t.is(assigned.peerId, id(workerAKeyPair))
  t.is(assigned.requestGeneration, 3)

  await second.network.close()
  await second.coordinator.close()
  await workerA.close()
  await workerB.close()
})

test('result-ready reconcile leaves phase result-ready when import/publish fails; never marks completed', async (t) => {
  const bee = fakeBee()
  let current = 1_000_000
  const store = createAcquisitionStore({ bee, now: () => current })
  const budget = {
    maxSourceBytes: 1024,
    maxOutputBytes: 1024,
    maxNetworkBytes: 2048,
    maxWallClockMs: 60_000,
  }
  const asset = {
    kind: 'static-prologue-v1',
    key: 'aa'.repeat(32),
    assetId: 'bb'.repeat(32),
    treeHash: 'cc'.repeat(32),
    length: 1,
    byteLength: 1024,
    blockSize: 1024,
  }

  await store.saveCoordination('acq_import_fail_1', {
    schemaVersion: 1,
    role: 'requester',
    phase: 'result-ready',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId: '33'.repeat(32),
    peerId: '44'.repeat(32),
    requesterId: 'aa'.repeat(32),
    acquirerId: 'bb'.repeat(32),
    publisherId: '33'.repeat(32),
    publicationIntentDigest: '55'.repeat(32),
    budget,
    resultHoldUntil: current + 120_000,
    epoch: 1,
    deadline: current + 60_000,
    progress: null,
    result: {
      acquiredBytes: 1024,
      completedAt: current,
      availabilityUntil: current + 120_000,
      sourceIdentity: { kind: 'sha256', value: '88'.repeat(32) },
      assets: [{
        purpose: 'original',
        format: 'application/octet-stream',
        renditionId: asset.assetId,
        core: asset,
      }],
    },
    error: null,
  })

  let importCalls = 0
  const coordinator = createAcquisitionCoordinator({
    store,
    policy: { networkTerms: async () => acquisitionNetworkTerms({ generation: 1 }) },
    provider: { canOpen: () => false },
    publisher: { hasAuthority: async () => true, async publish() {} },
    now: () => current,
  })
  coordinator.bindManager({
    async acceptTransferredResult () {
      importCalls++
      const error = new Error('import refused')
      error.code = 'ASSET_IMPORT_UNAVAILABLE'
      throw error
    },
  })

  await coordinator.reconcile()

  const after = await store.getCoordination('acq_import_fail_1')
  t.is(importCalls, 1, 'reconcile attempted import once')
  t.is(after.phase, 'result-ready', 'failed import must not report completed')
  t.is(after.error?.code, 'ASSET_IMPORT_UNAVAILABLE')
  t.ok(after.result, 'durable result retained for retry')

  // acceptTransferredResult returns normally for already-terminal failed jobs.
  // Coordination must still not mark completed without manager state===completed.
  await store.saveCoordination('acq_terminal_failed_1', {
    schemaVersion: 1,
    role: 'requester',
    phase: 'result-ready',
    requestId: '66'.repeat(32),
    offerId: '77'.repeat(32),
    assignmentId: '88'.repeat(32),
    peerId: '44'.repeat(32),
    requesterId: 'aa'.repeat(32),
    acquirerId: 'bb'.repeat(32),
    publisherId: '33'.repeat(32),
    publicationIntentDigest: '55'.repeat(32),
    budget,
    resultHoldUntil: current + 120_000,
    epoch: 1,
    deadline: current + 60_000,
    progress: null,
    result: {
      acquiredBytes: 1024,
      completedAt: current,
      availabilityUntil: current + 120_000,
      sourceIdentity: { kind: 'sha256', value: '88'.repeat(32) },
      assets: [{
        purpose: 'original',
        format: 'application/octet-stream',
        renditionId: asset.assetId,
        core: asset,
      }],
    },
    error: null,
  })

  coordinator.bindManager({
    async acceptTransferredResult () {
      // Mirrors manager short-circuit: any terminal job returns without throw.
      return {
        acquisitionId: 'acq_terminal_failed_1',
        state: 'failed',
        errorCode: 'VERIFICATION_FAILED',
        recoverable: false,
      }
    },
  })
  await coordinator.reconcile()
  const terminal = await store.getCoordination('acq_terminal_failed_1')
  t.is(terminal.phase, 'failed', 'a failed manager job terminates coordination instead of retrying publication')
  t.is(terminal.error?.code, 'VERIFICATION_FAILED')

  await coordinator.close()
})

test('coordinator cancellation uses the durable principal and delayed results cannot revive terminal coordination', async (t) => {
  const acquisitionId = 'acq_cancel_principal_1'
  const requestId = '11'.repeat(32)
  const offerId = '22'.repeat(32)
  const assignmentId = '33'.repeat(32)
  const peerId = '44'.repeat(32)
  const budget = {
    maxSourceBytes: 1024,
    maxOutputBytes: 1024,
    maxNetworkBytes: 2048,
    maxWallClockMs: 60_000,
  }
  let coordination = {
    schemaVersion: 1,
    acquisitionId,
    role: 'requester',
    phase: 'assigned',
    requestId,
    offerId,
    assignmentId,
    peerId,
    requesterId: 'aa'.repeat(32),
    acquirerId: 'bb'.repeat(32),
    publisherId: 'cc'.repeat(32),
    publicationIntentDigest: 'dd'.repeat(32),
    budget,
    output: { purpose: 'original', formats: ['application/octet-stream'] },
    resultHoldUntil: 2_000_000,
    epoch: 1,
    deadline: 1_500_000,
    progress: null,
    result: null,
    error: null,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
  }
  const durableJob = { acquisitionId, principalId: 'original-principal', state: 'acquiring' }
  const store = {
    async get(id) { return id === acquisitionId ? durableJob : null },
    async getCoordination(id) { return id === acquisitionId ? { ...coordination } : null },
    async getCoordinationByAssignment(id) { return id === assignmentId ? { ...coordination } : null },
    async getCoordinationByRequest(id) { return id === requestId ? { ...coordination } : null },
    async saveCoordination(id, input) {
      if (id !== acquisitionId) throw new Error('unexpected acquisition')
      coordination = { ...coordination, ...input, acquisitionId }
      return { ...coordination }
    },
    async listActiveCoordinations() { return coordination.phase === 'completed' ? [] : [{ ...coordination }] },
  }

  let cancellationStarted
  let startCancellation
  let finishCancellation
  const cancellationFinished = new Promise(resolve => { finishCancellation = resolve })
  const manager = {
    async cancel(input) {
      t.is(input.principal, 'original-principal', 'manager cancellation uses the original requester principal')
      startCancellation()
      await cancellationFinished
    },
  }
  cancellationStarted = new Promise(resolve => { startCancellation = resolve })

  const coordinator = createAcquisitionCoordinator({
    store,
    policy: { networkTerms: async () => acquisitionNetworkTerms({ generation: 1 }) },
    provider: { canOpen: () => false },
    publisher: { hasAuthority: async () => true, async publish() {} },
    now: () => 1_000_001,
  })
  coordinator.bindManager(manager)

  const pendingCancellation = coordinator.networkManager.onCancellation({
    cancellation: { requestId, assignmentId, reasonCode: 'requester-cancelled' },
    peerId,
  })
  await cancellationStarted
  t.is(coordination.phase, 'cancelled', 'cancellation is durable before manager completion')

  const delayedResult = coordinator.networkManager.onResult({
    result: { assignmentId },
    peerId,
  })
  await t.exception(delayedResult, /terminal|COORDINATION_TERMINAL/)

  finishCancellation()
  await pendingCancellation
  await coordinator.close()
})

test('stale recovery epochs are rejected by the network and cancelled by coordinator reconcile', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 181))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 182))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 1_100_000
  const requesterTerms = { ...policy(false).networkTerms(), generation: 3 }
  const liveStore = createAcquisitionStore({ bee: fakeBee(), now: () => current })
  const liveCoordinator = createAcquisitionCoordinator({
    store: liveStore,
    policy: { networkTerms: async () => requesterTerms },
    provider: { canOpen: () => false },
    publisher: { hasAuthority: async () => true, async publish() {} },
    autoSelect: false,
    now: () => current,
  })
  const requester = createAcquisitionNetwork({
    scopedNetwork: transport.left,
    keyPair: requesterKeyPair,
    policy: { networkTerms: () => requesterTerms },
    manager: liveCoordinator.networkManager,
    now: () => current,
  })
  liveCoordinator.attachNetwork(requester)
  await liveCoordinator.start()
  await requester.start()
  await t.exception(requester.prepareRequest({ ...requestInput(current), generation: 1 }), /generation|epoch|stale/)
  const prepared = await requester.prepareRequest({ ...requestInput(current), generation: 3 })
  t.is(prepared.request.generation, 3)

  // Request and worker policy generations are node-local. A requester at 3
  // must be able to negotiate with a worker at 7, while the worker still
  // authenticates the assignment against its own current offered epoch.
  const workerTerms = { ...policy(true).networkTerms(), generation: 7 }
  const workerEvents = []
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: { networkTerms: () => workerTerms },
    manager: manager(workerEvents),
    now: () => current,
  })
  await worker.start()
  const crossGeneration = await liveCoordinator.managerNetwork.publishRequest({
    acquisitionId: 'acq_cross_generation_1',
    request: {
      resolutionRef: 'S'.repeat(43),
      publisherId: '33'.repeat(32),
      retentionClass: 'archive-pin',
      expectedBytes: 2 * 1024 * 1024,
      output: { purpose: 'original', formats: ['video/mp4'] },
    },
  })
  await transport.flush()
  const workerOffer = await worker.publishOffer({
    requestId: crossGeneration.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '66'.repeat(32),
  })
  await transport.flush()
  t.is(workerOffer.offer.policyEpoch, 7)
  const assigned = await liveCoordinator.managerNetwork.assign({
    acquisitionId: 'acq_cross_generation_1',
    offer: workerOffer.offer,
  })
  t.is(assigned.assignment.policyEpoch, 7, 'assignment binds the worker offer epoch')
  const durableAssignment = await liveStore.getCoordination('acq_cross_generation_1')
  t.is(durableAssignment.requestGeneration, 3, 'requester generation remains durable')
  t.is(durableAssignment.epoch, 7, 'worker epoch is stored separately as the negotiated epoch')
  await transport.flush()
  t.ok(workerEvents.some(([type]) => type === 'assignment'), 'worker accepts an assignment from a different requester generation')
  await requester.close()
  await transport.flush()
  await worker.close()
  await liveCoordinator.close()

  const acquisitionId = 'acq_stale_epoch_1'
  let coordination = {
    schemaVersion: 1,
    acquisitionId,
    role: 'requester',
    phase: 'requested',
    requestId: 'aa'.repeat(32),
    offerId: null,
    assignmentId: null,
    peerId: null,
    requesterId: null,
    acquirerId: null,
    sourceRef: 'R'.repeat(43),
    publisherId: 'bb'.repeat(32),
    publicationIntentDigest: 'cc'.repeat(32),
    budget: requestInput(current).budget,
    output: requestInput(current).output,
    resultHoldUntil: current + 120_000,
    requestGeneration: 1,
    epoch: 1,
    deadline: current + 30_000,
    progress: null,
    result: null,
    error: null,
    createdAt: current,
    updatedAt: current,
  }
  let prepareCalls = 0
  const coordinationStore = {
    async getCoordination(id) { return id === acquisitionId ? { ...coordination } : null },
    async saveCoordination(id, input) {
      coordination = { ...coordination, ...input, acquisitionId: id }
      return { ...coordination }
    },
    async listActiveCoordinations() { return [{ ...coordination }] },
  }
  const coordinator = createAcquisitionCoordinator({
    store: coordinationStore,
    policy: { networkTerms: async () => acquisitionNetworkTerms({ generation: 3 }) },
    provider: { canOpen: () => false },
    publisher: { hasAuthority: async () => true, async publish() {} },
    network: {
      async prepareRequest() { prepareCalls++; throw new Error('stale request was re-signed') },
      async dispatchRequest() { throw new Error('stale request was dispatched') },
    },
    now: () => current,
  })
  await coordinator.reconcile()
  t.is(prepareCalls, 0, 'reconcile does not re-sign stale durable intent')
  t.is(coordination.phase, 'cancelled')
  t.is(coordination.error.code, 'COORDINATION_POLICY_CHANGED')
  await coordinator.close()
})

test('authenticated request cancellation removes worker offer indexes and releases its concurrency slot', async (t) => {
  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 191))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 192))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 1_200_000
  const workerTerms = { ...policy(true).networkTerms(), maxConcurrentJobs: 1, maxConcurrentPerRequester: 1 }
  const requester = createAcquisitionNetwork({
    scopedNetwork: transport.left,
    keyPair: requesterKeyPair,
    policy: policy(false),
    manager: manager([]),
    now: () => current,
  })
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: { networkTerms: () => workerTerms },
    manager: manager([]),
    now: () => current,
  })
  await requester.start()
  await worker.start()

  const first = await requester.publishRequest(requestInput(current))
  await transport.flush()
  const firstOffer = await worker.publishOffer({
    requestId: first.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '66'.repeat(32),
  })
  await transport.flush()
  t.ok(firstOffer.offer.offerId)
  await t.exception(worker.publishOffer({
    requestId: first.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '77'.repeat(32),
  }), /concurrency|exhausted/)

  await requester.cancel({
    requestId: first.request.requestId,
    peerId: id(workerKeyPair),
    reasonCode: 'requester-cancelled',
  })
  await transport.flush()

  const second = await requester.publishRequest({ ...requestInput(current), sourceRef: 'T'.repeat(43) })
  await transport.flush()
  const secondOffer = await worker.publishOffer({
    requestId: second.request.requestId,
    peerId: id(requesterKeyPair),
    sourceCapabilityDigest: '88'.repeat(32),
  })
  t.ok(secondOffer.offer.offerId, 'worker can offer again after cancellation teardown')

  await requester.close()
  await worker.close()
})

function spyCoreStore (store, log) {
  return {
    get (options) {
      log.opened += 1
      const core = store.get(options)
      return new Proxy(core, {
        get (target, prop) {
          if (prop === 'close') {
            return (...args) => { log.closed += 1; return target.close(...args) }
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
}

// The requester pushes its block request onto the shared wire synchronously at
// publish time, but readiness and the local block check run against real store
// I/O, so wait on the frame appearing instead of a flush() that both rejects on
// the deliberately silent worker scope and cannot span the I/O turn.
async function waitForBlockRequestsOnWire (h, count = 1) {
  for (let tick = 0; tick < 1000; tick++) {
    const seen = h.transport.wire.filter(frame => frame.type === 'acquisition-block-request').length
    if (seen >= count) return
    await new Promise(resolve => setImmediate(resolve))
  }
  const seen = h.transport.wire.filter(frame => frame.type === 'acquisition-block-request').length
  throw new Error(`timed out waiting for ${count} block request(s) on the wire, saw ${seen}`)
}

async function setupVerifiedImportHarness (t, { seedRequester = false, assignmentCount = 1, generationRef = null, managerOverride = null } = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const Corestore = (await import('corestore')).default
  const { createBufferSourceReader } = await import('../src/assets/source-reader.js')
  const { writeStaticAsset } = await import('../src/assets/static-core.js')

  const requesterDir = mkdtempSync(join(tmpdir(), 'peartube-imp-req-'))
  const workerDir = mkdtempSync(join(tmpdir(), 'peartube-imp-wrk-'))
  const requesterStore = new Corestore(requesterDir)
  const workerStore = new Corestore(workerDir)
  await requesterStore.ready()
  await workerStore.ready()
  t.teardown(async () => {
    await requesterStore.close().catch(() => {})
    await workerStore.close().catch(() => {})
    rmSync(requesterDir, { recursive: true, force: true })
    rmSync(workerDir, { recursive: true, force: true })
  })

  const SOURCE = b4a.from('verified network transfer regression fixture bytes')
  const written = await writeStaticAsset({
    store: workerStore,
    reader: createBufferSourceReader(SOURCE, { mimeType: 'application/octet-stream' }),
  })
  const descriptor = written.descriptor
  await written.core.close().catch(() => {})

  if (seedRequester) {
    const seeded = await writeStaticAsset({
      store: requesterStore,
      reader: createBufferSourceReader(SOURCE, { mimeType: 'application/octet-stream' }),
    })
    await seeded.core.close().catch(() => {})
  }

  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, 201))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, 202))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)
  let current = 1_400_000
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
    policy: generationRef
      ? { networkTerms: () => acquisitionNetworkTerms({ generation: generationRef.value }) }
      : policy(true),
    manager: managerOverride || manager([]),
    now: () => current,
    setTimeout: makeTimer(requesterTimers),
    clearTimeout: clearTimer,
    store: requesterStore,
  })
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: policy(true),
    manager: manager([]),
    now: () => current,
    setTimeout: makeTimer(workerTimers),
    clearTimeout: clearTimer,
    store: workerStore,
  })

  const assignmentPairs = Array.from({ length: assignmentCount }, (_, index) => ({
    assignmentId: String.fromCharCode(97 + index).repeat(64),
    requestId: String.fromCharCode(100 + index).repeat(64),
    offerId: String.fromCharCode(101 + index).repeat(64),
  }))
  const deadline = current + 60_000
  for (const pair of assignmentPairs) {
    const restoreInput = {
      assignmentId: pair.assignmentId,
      requestId: pair.requestId,
      offerId: pair.offerId,
      peerId: id(workerKeyPair),
      role: 'requester',
      requesterId: id(requesterKeyPair),
      acquirerId: id(workerKeyPair),
      publisherId: '33'.repeat(32),
      publicationIntentDigest: '55'.repeat(32),
      budget: {
        maxSourceBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxNetworkBytes: 2 * 1024 * 1024,
        maxWallClockMs: 60_000,
      },
      deadline,
      resultHoldUntil: current + 120_000,
      policyEpoch: 1,
      requestGeneration: 1,
    }
    await requester.restoreAssignment(restoreInput)
    await worker.restoreAssignment({ ...restoreInput, role: 'worker', peerId: id(requesterKeyPair) })
  }

  const coreRef = {
    kind: 'static-prologue-v1',
    assetId: descriptor.assetId,
    key: descriptor.key,
    treeHash: descriptor.treeHash,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    blockSize: descriptor.blockSize,
  }

  return {
    requester,
    worker,
    transport,
    requesterStore,
    workerStore,
    requesterTimers,
    SOURCE,
    coreRef,
    assignmentPairs,
    assignmentId: assignmentPairs[0].assignmentId,
    requestId: assignmentPairs[0].requestId,
    deadline,
    workerPeerId: id(workerKeyPair),
    requesterPeerId: id(requesterKeyPair),
    advance (ms) { current += ms },
  }
}

test('local-complete verified import closes the owned core and returns only descriptor metadata', async (t) => {
  const h = await setupVerifiedImportHarness(t, { seedRequester: true })
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const imported = await h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })

  t.is(imported.imported, true)
  t.is(imported.byteLength, h.SOURCE.byteLength)
  t.is(imported.descriptor.assetId, h.coreRef.assetId)
  t.is(imported.descriptor.key, b4a.toString(h.coreRef.key, 'hex'))
  t.is(imported.descriptor.byteLength, h.coreRef.byteLength)
  t.absent(imported.session, 'no live session escapes the import')
  t.absent(imported.core, 'no live core escapes the import')
  t.is(log.opened, 1, 'import opened exactly one owned core')
  t.is(log.closed, 1, 'local-complete import closed the owned core')
  t.is(h.transport.wire.filter(frame => frame.type === 'acquisition-block-request').length, 0, 'local-complete import sends no wire transfer')
})

test('caller abort during a stalled asset readiness closes the owned core and settles without releasing the ready gate', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const gate = { readyCalls: 0, closed: 0, released: false, release: null }
  h.requester.setAssetStore({
    get (options) {
      const core = h.requesterStore.get(options)
      return new Proxy(core, {
        get (target, prop) {
          if (prop === 'ready') {
            return async () => {
              gate.readyCalls += 1
              await new Promise(resolve => { gate.release = () => { gate.released = true; resolve() } })
              return target.ready()
            }
          }
          if (prop === 'close') {
            return () => { gate.closed += 1; return target.close() }
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  })

  const controller = new AbortController()
  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal: controller.signal,
  })
  while (gate.readyCalls === 0) await new Promise(resolve => setImmediate(resolve))
  controller.abort()

  const error = await importPromise.then(() => null, cause => cause)
  t.ok(error, 'import settles on caller abort')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.is(gate.closed, 1, 'owned core closed exactly once on abort')
  t.is(gate.released, false, 'ready gate was never released')

  gate.release?.()
  await new Promise(resolve => setImmediate(resolve))
})

test('caller abort during a stalled local block check settles and closes once without releasing that gate', async (t) => {
  const h = await setupVerifiedImportHarness(t, { seedRequester: true })
  const gate = { hasCalls: 0, closed: 0, released: false, release: null }
  let markHasStarted
  const hasStarted = new Promise(resolve => { markHasStarted = resolve })
  h.requester.setAssetStore({
    get (options) {
      const core = h.requesterStore.get(options)
      return new Proxy(core, {
        get (target, prop) {
          if (prop === 'has') {
            return async (...args) => {
              gate.hasCalls += 1
              markHasStarted()
              await new Promise(resolve => { gate.release = () => { gate.released = true; resolve() } })
              return target.has(...args)
            }
          }
          if (prop === 'close') {
            return () => { gate.closed += 1; return target.close() }
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  })

  const controller = new AbortController()
  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal: controller.signal,
  })
  await hasStarted
  t.ok(gate.hasCalls > 0, 'import reached the gated local block check')
  controller.abort()

  let settled = false
  let error = null
  importPromise.then(() => { settled = true }, cause => { error = cause; settled = true })
  for (let tick = 0; tick < 500 && !settled; tick++) await new Promise(resolve => setImmediate(resolve))
  t.ok(settled, 'caller abort settles a stalled core.has without waiting for it')
  t.is(error?.code, 'ACQUISITION_CANCELLED')
  t.is(gate.closed, 1, 'owned core closed exactly once on abort')
  t.is(gate.released, false, 'has gate was never released')

  gate.release?.()
  await new Promise(resolve => setImmediate(resolve))
})

test('assignment release settles a silent pending block transfer and releases its resources', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const errorPromise = importPromise.then(() => null, cause => cause)
  await waitForBlockRequestsOnWire(h)
  t.ok(h.transport.wire.some(frame => frame.type === 'acquisition-block-request'), 'block request reached the wire')

  let settled = false
  importPromise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  t.is(settled, false, 'silent transfer stays pending while the assignment is live')

  await h.requester.cancel({
    assignmentId: h.assignmentId,
    requestId: h.requestId,
    reasonCode: 'requester-cancelled',
  })

  const error = await errorPromise
  t.ok(error, 'assignment release settles the silent transfer')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.ok(h.transport.left.releasedAssignments.includes(h.assignmentId), 'assignment scope released')
  t.is(log.closed, 1, 'owned session core closed on release')

  const requestFrame = h.transport.wire.find(frame => frame.type === 'acquisition-block-request')
  const decodedRequest = decodeAssetBlockRequest(requestFrame.payload)
  await t.exception(h.transport.left.inject({
    type: 'acquisition-block-unavailable',
    payload: encodeAssetBlockError({
      assetId: b4a.from(h.coreRef.assetId, 'hex'),
      transferId: decodedRequest.transferId,
      startBlock: decodedRequest.startBlock,
      endBlock: decodedRequest.endBlock,
      code: 'ASSET_BLOCK_UNAVAILABLE',
    }),
    assignmentId: h.assignmentId,
    peerId: h.workerPeerId,
    purpose: 'acquisition',
  }))
  await t.exception(h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  }))
  t.is(log.opened, 1, 'released assignment authority cannot reopen an import session')
})

test('assignment expiry settles a silent pending block transfer', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const errorPromise = importPromise.then(() => null, cause => cause)
  await waitForBlockRequestsOnWire(h)

  const expiryTimer = h.requesterTimers.find(timer => !timer.cleared)
  t.ok(expiryTimer, 'assignment expiry timer is armed')
  h.advance(60_001)
  await expiryTimer.fn()

  const error = await errorPromise
  t.ok(error, 'assignment expiry settles the silent transfer')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.ok(h.transport.left.releasedAssignments.includes(h.assignmentId), 'assignment scope released on expiry')
  t.is(log.closed, 1, 'owned session core closed on expiry')
})

test('network close settles a silent pending block transfer and releases its resources', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const errorPromise = importPromise.then(() => null, cause => cause)
  await waitForBlockRequestsOnWire(h)

  await h.requester.close()

  const error = await errorPromise
  t.ok(error, 'network close settles the silent transfer')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.ok(h.transport.left.releasedAssignments.includes(h.assignmentId), 'assignment scope released on close')
  t.is(log.closed, 1, 'owned session core closed on close')
})

test('a malformed block proof rejects the matching transfer promptly', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const errorPromise = importPromise.then(() => null, cause => cause)
  await waitForBlockRequestsOnWire(h)

  const requestFrame = h.transport.wire.find(frame => frame.type === 'acquisition-block-request')
  const decodedRequest = decodeAssetBlockRequest(requestFrame.payload)
  const malformed = encodeAssetBlockResponse({
    assetId: b4a.from(h.coreRef.assetId, 'hex'),
    transferId: decodedRequest.transferId,
    startBlock: decodedRequest.startBlock,
    endBlock: decodedRequest.endBlock,
    blockIndex: decodedRequest.startBlock,
    kind: 'proof',
    offset: 0,
    totalBytes: 16,
    chunk: b4a.alloc(16, 7),
  })

  const result = await h.transport.left.inject({
    type: 'acquisition-block-proof',
    payload: malformed,
    assignmentId: h.assignmentId,
    peerId: h.workerPeerId,
    purpose: 'acquisition',
  })
  t.is(result.status, 'rejected', 'malformed proof fails only the matching transfer')

  const error = await errorPromise
  t.ok(error, 'import rejects promptly on the malformed proof')
  t.is(log.closed, 1, 'owned session core closed after the malformed proof')
})

test('a foreign peer or foreign asset unavailable frame does not cancel a valid pending import', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))

  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  await waitForBlockRequestsOnWire(h)

  const requestFrame = h.transport.wire.find(frame => frame.type === 'acquisition-block-request')
  const decodedRequest = decodeAssetBlockRequest(requestFrame.payload)
  const unavailable = encodeAssetBlockError({
    assetId: b4a.from(h.coreRef.assetId, 'hex'),
    transferId: decodedRequest.transferId,
    startBlock: decodedRequest.startBlock,
    endBlock: decodedRequest.endBlock,
    code: 'ASSET_BLOCK_UNAVAILABLE',
  })

  const foreignTransfer = await h.transport.left.inject({
    type: 'acquisition-block-unavailable',
    payload: encodeAssetBlockError({
      assetId: b4a.from(h.coreRef.assetId, 'hex'),
      transferId: 12345n,
      startBlock: decodedRequest.startBlock,
      endBlock: decodedRequest.endBlock,
      code: 'ASSET_BLOCK_UNAVAILABLE',
    }),
    assignmentId: h.assignmentId,
    peerId: h.workerPeerId,
    purpose: 'acquisition',
  })
  t.alike(foreignTransfer, { status: 'unavailable' })

  const foreignPeer = await h.transport.left.inject({
    type: 'acquisition-block-unavailable',
    payload: unavailable,
    assignmentId: h.assignmentId,
    peerId: 'ce'.repeat(32),
    purpose: 'acquisition',
  })
  t.alike(foreignPeer, { status: 'unavailable' })

  const foreignAsset = await h.transport.left.inject({
    type: 'acquisition-block-unavailable',
    payload: encodeAssetBlockError({
      assetId: b4a.alloc(32, 9),
      transferId: decodedRequest.transferId,
      startBlock: decodedRequest.startBlock,
      endBlock: decodedRequest.endBlock,
      code: 'ASSET_BLOCK_UNAVAILABLE',
    }),
    assignmentId: h.assignmentId,
    peerId: h.workerPeerId,
    purpose: 'acquisition',
  })
  t.alike(foreignAsset, { status: 'unavailable' })

  let settled = false
  importPromise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  t.is(settled, false, 'valid pending import survives foreign unavailable frames')

  await h.requester.cancel({
    assignmentId: h.assignmentId,
    requestId: h.requestId,
    reasonCode: 'requester-cancelled',
  })
  const error = await importPromise.then(() => null, cause => cause)
  t.is(error.code, 'ACQUISITION_CANCELLED', 'the surviving import settles through assignment release')
})

test('a signed proof-verified transfer completes with exact bytes and no remaining listener or session', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))
  await h.worker.holdVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    availabilityUntil: h.deadline,
  })

  const signal = {
    aborted: false,
    listeners: [],
    addEventListener (type, listener) { this.listeners.push(listener) },
    removeEventListener (type, listener) { this.listeners = this.listeners.filter(entry => entry !== listener) },
  }
  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal,
  })
  const imported = await importPromise

  t.is(imported.imported, true)
  t.is(imported.byteLength, h.SOURCE.byteLength)
  t.is(imported.descriptor.assetId, h.coreRef.assetId)
  t.absent(imported.session, 'no live session escapes a successful import')
  t.absent(imported.core, 'no live core escapes a successful import')
  t.is(signal.listeners.length, 0, 'caller abort listener removed on success')
  t.is(log.closed, 1, 'owned session core closed on success')

  const importedCore = h.requesterStore.get({ key: b4a.from(h.coreRef.key, 'hex') })
  await importedCore.ready()
  t.is(importedCore.length, h.coreRef.length)
  t.alike(await importedCore.get(0), h.SOURCE, 'requester holds the exact worker bytes')
  await importedCore.close()
})

test('caller abort during a stalled final verification settles with the cancellation error, not a missing-block error', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  await h.worker.holdVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    availabilityUntil: h.deadline,
  })
  // An empty core bypasses handle.has during the local sweep. Each transferred
  // block has one commit re-check before the final exact-verification sweep.
  const preFinalCalls = h.coreRef.length
  const gate = { hasCalls: 0, closed: 0, released: false, release: null }
  let markFinalCheck
  const finalCheckStarted = new Promise(resolve => { markFinalCheck = resolve })
  h.requester.setAssetStore({
    get (options) {
      const core = h.requesterStore.get(options)
      return new Proxy(core, {
        get (target, prop) {
          if (prop === 'has') {
            return async (...args) => {
              gate.hasCalls += 1
              if (gate.hasCalls > preFinalCalls) {
                markFinalCheck()
                await new Promise(resolve => { gate.release = () => { gate.released = true; resolve() } })
              }
              return target.has(...args)
            }
          }
          if (prop === 'close') {
            return () => { gate.closed += 1; return target.close() }
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  })

  const controller = new AbortController()
  const importPromise = h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal: controller.signal,
  })
  await finalCheckStarted
  controller.abort()

  let settled = false
  let error = null
  importPromise.then(() => { settled = true }, cause => { error = cause; settled = true })
  for (let tick = 0; tick < 500 && !settled; tick++) await new Promise(resolve => setImmediate(resolve))
  t.ok(settled, 'caller abort settles the stalled final verification check')
  t.is(error?.code, 'ACQUISITION_CANCELLED', 'cancelled race result is guarded before the exact check')
  t.is(gate.closed, 1, 'owned core closed exactly once on abort')
  t.is(gate.released, false, 'has gate was never released')

  gate.release?.()
  await new Promise(resolve => setImmediate(resolve))
})

test('an already-aborted caller signal stops the import before any owned core is opened', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))
  const controller = new AbortController()
  controller.abort()

  const error = await h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal: controller.signal,
  }).then(() => null, cause => cause)

  t.ok(error, 'pre-aborted import settles')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.is(log.opened, 0, 'an already-aborted import opens no owned core')
  t.is(log.closed, 0, 'an already-aborted import closes no core it never opened')

  await h.requester.cancel({
    assignmentId: h.assignmentId,
    requestId: h.requestId,
    reasonCode: 'requester-cancelled',
  })
  t.ok(h.transport.left.releasedAssignments.includes(h.assignmentId), 'the aborted import leaves a clean registry for release')
})

test('cancellation delivered at immediate readiness settles once and drains through assignment release', async (t) => {
  const h = await setupVerifiedImportHarness(t, {})
  const gate = { readyCalls: 0, closed: 0 }
  const controller = new AbortController()
  h.requester.setAssetStore({
    get (options) {
      const core = h.requesterStore.get(options)
      return new Proxy(core, {
        get (target, prop) {
          if (prop === 'ready') {
            return async () => {
              gate.readyCalls += 1
              controller.abort()
              return target.ready()
            }
          }
          if (prop === 'close') {
            return () => { gate.closed += 1; return target.close() }
          }
          const value = target[prop]
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  })

  const error = await h.requester.importVerifiedAsset({
    assignmentId: h.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
    signal: controller.signal,
  }).then(() => null, cause => cause)

  t.ok(error, 'import settles when the caller cancels exactly as readiness completes')
  t.is(error.code, 'ACQUISITION_CANCELLED')
  t.is(gate.readyCalls, 1, 'readiness ran once')
  t.is(gate.closed, 1, 'owned core closed exactly once at readiness cancellation')

  await h.requester.cancel({
    assignmentId: h.assignmentId,
    requestId: h.requestId,
    reasonCode: 'requester-cancelled',
  })
  t.ok(h.transport.left.releasedAssignments.includes(h.assignmentId), 'release drains the settled import registry')
  t.is(gate.closed, 1, 'release does not double-close the settled owned core')
})

test('terminal close cancels every tracked import before awaiting the first stalled scope release', async (t) => {
  const h = await setupVerifiedImportHarness(t, { assignmentCount: 2 })
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))
  const [first, second] = h.assignmentPairs

  const firstImport = h.requester.importVerifiedAsset({
    assignmentId: first.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const secondImport = h.requester.importVerifiedAsset({
    assignmentId: second.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  await waitForBlockRequestsOnWire(h, 2)
  t.is(h.transport.wire.filter(frame => frame.type === 'acquisition-block-request').length, 2, 'both imports hold silent pending transfers')

  const left = h.transport.left
  const originalRelease = left.releaseAcquisitionAssignment
  let openGate = null
  left.releaseAcquisitionAssignment = async (input) => {
    if (input.assignmentId === first.assignmentId) {
      await new Promise(resolve => { openGate = resolve })
    }
    return originalRelease.call(left, input)
  }

  const closePromise = h.requester.close()
  const firstError = await firstImport.then(() => null, cause => cause)
  const secondError = await secondImport.then(() => null, cause => cause)
  t.is(firstError?.code, 'ACQUISITION_CANCELLED', 'the stalled assignment import settles at close entry')
  t.is(secondError?.code, 'ACQUISITION_CANCELLED', 'the unrelated import is cancelled while the first release is still stalled')
  t.is(left.releasedAssignments.length, 0, 'no scope release completes while the first release is gated')

  for (let tick = 0; tick < 25 && openGate === null; tick++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  t.ok(openGate, 'close reached the first gated scope release')
  openGate?.()
  await closePromise
  t.ok(left.releasedAssignments.includes(first.assignmentId), 'first scope released after the gate opens')
  t.ok(left.releasedAssignments.includes(second.assignmentId), 'second scope released through serial teardown')
  t.is(log.closed, 2, 'both owned sessions closed exactly once')
})

test('policy invalidation cancels every tracked import before awaiting the first stalled scope release', async (t) => {
  const generation = { value: 1 }
  const h = await setupVerifiedImportHarness(t, { assignmentCount: 2, generationRef: generation })
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))
  const [first, second] = h.assignmentPairs

  const firstImport = h.requester.importVerifiedAsset({
    assignmentId: first.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const secondImport = h.requester.importVerifiedAsset({
    assignmentId: second.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  await waitForBlockRequestsOnWire(h, 2)

  let firstError = null
  let secondError = null
  firstImport.then(() => {}, cause => { firstError = cause })
  secondImport.then(() => {}, cause => { secondError = cause })

  const left = h.transport.left
  const originalRelease = left.releaseAcquisitionAssignment
  let openGate = null
  left.releaseAcquisitionAssignment = async (input) => {
    if (input.assignmentId === first.assignmentId) {
      await new Promise(resolve => { openGate = resolve })
    }
    return originalRelease.call(left, input)
  }

  generation.value = 2
  const preparedOutcome = h.requester
    .prepareRequest({ ...requestInput(1_400_000), generation: 2 })
    .then(value => ({ value }), cause => ({ cause }))

  for (let tick = 0; tick < 25 && (secondError === null || openGate === null); tick++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  t.ok(firstError, 'the stalled assignment import settles at invalidation entry')
  t.ok(secondError, 'the unrelated import is cancelled while the first release is still stalled')
  t.is(firstError?.code, 'ACQUISITION_CANCELLED')
  t.is(secondError?.code, 'ACQUISITION_CANCELLED', 'no late generic sweep settles the unrelated import')
  t.ok(openGate, 'invalidation reached the first gated scope release')
  t.is(left.releasedAssignments.length, 0, 'no scope release completes while the first release is gated')

  openGate?.()
  const outcome = await preparedOutcome
  t.absent(outcome.cause, 'invalidation completes and the refreshed request prepares')
  t.ok(left.releasedAssignments.includes(first.assignmentId), 'first scope released after the gate opens')
  t.ok(left.releasedAssignments.includes(second.assignmentId), 'second scope released through serial invalidation cleanup')
  await h.requester.close().catch(() => {})
  t.is(log.closed, 2, 'both owned sessions closed exactly once')
})

test('policy invalidation finishes every cleanup and teardown when the first manager cancellation throws', async (t) => {
  const generation = { value: 1 }
  const managerError = Object.assign(new Error('first manager cancellation exploded'), {
    code: 'TEST_MANAGER_CANCELLATION_FAILED',
  })
  const cancellationCalls = []
  const harnessManager = {
    ...manager([]),
    async onCancellation (input) {
      cancellationCalls.push(input.cancellation.assignmentId)
      if (cancellationCalls.length === 1) throw managerError
    },
  }
  const h = await setupVerifiedImportHarness(t, {
    assignmentCount: 2,
    generationRef: generation,
    managerOverride: harnessManager,
  })
  const log = { opened: 0, closed: 0 }
  h.requester.setAssetStore(spyCoreStore(h.requesterStore, log))
  const [first, second] = h.assignmentPairs

  const armed = await h.requester.publishRequest(requestInput(1_400_000))
  const firstImport = h.requester.importVerifiedAsset({
    assignmentId: first.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  const secondImport = h.requester.importVerifiedAsset({
    assignmentId: second.assignmentId,
    asset: h.coreRef,
    peerId: h.workerPeerId,
  })
  await waitForBlockRequestsOnWire(h, 2)

  let firstError = null
  let secondError = null
  firstImport.then(() => {}, cause => { firstError = cause })
  secondImport.then(() => {}, cause => { secondError = cause })

  generation.value = 2
  const outcome = await h.requester
    .prepareRequest({ ...requestInput(1_400_000), generation: 2 })
    .then(value => ({ value }), cause => ({ cause }))

  t.is(firstError?.code, 'ACQUISITION_CANCELLED', 'the first owned import settles')
  t.is(secondError?.code, 'ACQUISITION_CANCELLED', 'the second owned import settles despite the manager throw')
  t.is(log.closed, 2, 'both owned sessions closed exactly once')
  t.ok(outcome.cause, 'the request operation rejects')
  t.is(outcome.cause, managerError, 'the first original thrown error identity is preserved')
  t.alike(cancellationCalls, [first.assignmentId, second.assignmentId], 'every removed state still reaches the manager in order')
  t.alike(h.transport.left.releasedAssignments, [first.assignmentId, second.assignmentId], 'every scope releases serially even after the first callback throws')
  t.is(h.requester.dropLocalRequest(armed.request.requestId), false, 'teardownAllRequests executed after owned cleanup')

  await h.requester.close().catch(() => {})
  t.is(log.closed, 2, 'close does not double-close the already-drained owned cores')
})
