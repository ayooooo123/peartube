import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createArchiveRequest,
  createArchiveChallenge,
  createArchiveChallengeEnvelope,
  createArchivePledge,
  createPermissionlessArchiveNetwork,
  createArchivePolicy,
  authorizeArchiveRequestFromManifestStore,
  verifyArchiveRequest,
} from '../src/archive/index.js'

const requester = crypto.keyPair(b4a.alloc(32, 71))
const volunteer = crypto.keyPair(b4a.alloc(32, 72))
const standby = crypto.keyPair(b4a.alloc(32, 73))
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)
const ranges = [{ coreKey, start: 0, end: 4 }]

function scopedRecorder () {
  const retained = []
  const released = []
  return {
    retained,
    released,
    async retainAuthorizedArchive (input) {
      retained.push(input)
      return { status: 'retained', archiveId: input.pledge.envelope.recordId }
    },
    async releaseAuthorizedArchive (input) {
      released.push(input)
      return { status: 'released', released: true }
    },
  }
}

function authorized (request) {
  return {
    accepted: true,
    requestedBytes: request.body.requestedBytes,
    ranges: request.body.ranges,
  }
}

test('archive requests are signed, bounded, and bind exact public rendition ranges', async (t) => {
  const request = createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 4096,
    retentionUntil: 20_000,
    expiresAt: 2_000,
    issuedAt: 1_000,
    nonce: 'request-1',
    keyPair: requester,
  })
  const verified = await verifyArchiveRequest(request.envelope, { now: 1_500 })
  t.ok(verified)
  t.alike(verified.body.ranges, ranges)
  t.is(verified.body.requestedBytes, 4096)

  const tampered = { ...request.envelope, body: b4a.from(request.envelope.body) }
  tampered.body[0] ^= 1
  t.is(await verifyArchiveRequest(tampered, { now: 1_500 }), false)
  t.exception(() => createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges: Array.from({ length: 65 }, (_, index) => ({ coreKey, start: index, end: index + 1 })),
    requestedBytes: 4096,
    retentionUntil: 20_000,
    expiresAt: 2_000,
    issuedAt: 1_000,
    keyPair: requester,
  }), /ranges/)
})

test('opted-in strangers randomly accept verified requests without API keys or trusted relay lists', async (t) => {
  const requesterScoped = scopedRecorder()
  const volunteerScoped = scopedRecorder()
  const standbyScoped = scopedRecorder()
  const deliveredPledges = []
  let requestNetwork
  const volunteerNetwork = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => 1_000,
    random: () => 0.1,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 0.5,
    authorizeRequest: authorized,
    scopedNetwork: volunteerScoped,
    publishPledge: async envelope => {
      deliveredPledges.push(envelope)
      await requestNetwork.ingestPledge(envelope)
    },
  })
  const standbyNetwork = createPermissionlessArchiveNetwork({
    keyPair: standby,
    now: () => 1_000,
    random: () => 0.9,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 0.5,
    authorizeRequest: authorized,
    scopedNetwork: standbyScoped,
  })
  requestNetwork = createPermissionlessArchiveNetwork({
    keyPair: requester,
    now: () => 1_000,
    enabled: false,
    scopedNetwork: requesterScoped,
    publishRequest: async envelope => {
      await volunteerNetwork.ingestRequest(envelope)
      await standbyNetwork.ingestRequest(envelope)
    },
  })

  const result = await requestNetwork.requestArchive({
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 4096,
    retentionUntil: 20_000,
    expiresAt: 2_000,
  })

  t.is(result.status, 'published')
  t.is(deliveredPledges.length, 1, 'only the randomly selected volunteer pledges')
  t.is(volunteerScoped.retained.length, 1, 'the volunteer starts filling the pledged range')
  t.is(standbyScoped.retained.length, 0)
  t.is(requesterScoped.retained.length, 1, 'the requester joins the pledge scope to serve and verify transfers')
  t.is(requesterScoped.retained[0].download, false, 'requesters do not refill an offloaded source range')
  t.is(volunteerNetwork.getStatus().reservedBytes, 4096)
  t.is(volunteerNetwork.getStatus().acceptedRequests, 1)
  t.is(standbyNetwork.getStatus().randomRejections, 1)
  t.is('apiKey' in volunteerNetwork.getStatus(), false)
  t.is('trustedRelayKeys' in volunteerNetwork.getStatus(), false)
})

test('participation defaults off, enforces local capacity, and releases custody immediately on opt-out', async (t) => {
  const scoped = scopedRecorder()
  const network = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => 1_000,
    random: () => 0,
    capacityBytes: 1024,
    acceptanceProbability: 1,
    authorizeRequest: authorized,
    scopedNetwork: scoped,
  })
  const request = createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 512,
    retentionUntil: 20_000,
    expiresAt: 2_000,
    issuedAt: 1_000,
    keyPair: requester,
  })

  t.is((await network.ingestRequest(request.envelope)).reason, 'participation-disabled')
  await network.setParticipation({ enabled: true, capacityBytes: 256 })
  t.is((await network.ingestRequest(request.envelope)).reason, 'capacity-exceeded')
  await network.setParticipation({ enabled: true, capacityBytes: 1024 })
  const accepted = await network.ingestRequest(request.envelope)
  t.is(accepted.status, 'accepted')
  t.is(network.getStatus().reservedBytes, 512)
  const lowered = await network.setParticipation({ enabled: true, capacityBytes: 256 })
  t.is(lowered.enabled, true)
  t.is(lowered.capacityBytes, 256)
  t.is(lowered.reservedBytes, 0, 'lowering the disk policy releases oversized archive reservations')

  const optedOut = await network.setParticipation({ enabled: false })
  t.is(optedOut.enabled, false)
  t.is(network.getStatus().reservedBytes, 0)
  t.is(scoped.released.length, 1)
})

test('unverified manifests, request replay, and unsolicited pledges fail closed', async (t) => {
  const scoped = scopedRecorder()
  const network = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => 1_000,
    random: () => 0,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 1,
    authorizeRequest: async () => false,
    scopedNetwork: scoped,
  })
  const request = createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 512,
    retentionUntil: 20_000,
    expiresAt: 2_000,
    issuedAt: 1_000,
    keyPair: requester,
  })
  t.is((await network.ingestRequest(request.envelope)).reason, 'manifest-not-authorized')
  t.is((await network.ingestRequest(request.envelope)).reason, 'request-replayed')
  t.is((await network.ingestPledge({})).reason, 'pledge-invalid')
  t.is(scoped.retained.length, 0)
})

test('manifest authorization recomputes full-copy bytes instead of trusting requester accounting', async (t) => {
  const manifest = {
    publicationId,
    body: {
      renditions: [{
        renditionId,
        core: { key: coreKey, length: 4, byteLength: 4096 },
      }],
    },
  }
  const manifestStore = {
    getManifest(id) {
      return id === publicationId ? manifest : null
    },
  }
  const authorizeRendition = async input => input.manifest === manifest && input.start === 0 && input.end === 4
  const request = {
    body: {
      publicationId,
      renditionId,
      ranges,
      requestedBytes: 4096,
    },
  }

  t.alike(await authorizeArchiveRequestFromManifestStore(request, { manifestStore, authorizeRendition }), {
    accepted: true,
    requestedBytes: 4096,
    ranges,
  })
  t.is(await authorizeArchiveRequestFromManifestStore({
    body: { ...request.body, requestedBytes: 1 },
  }, { manifestStore, authorizeRendition }), false, 'a requester cannot reserve a full core as one byte')
  t.is(await authorizeArchiveRequestFromManifestStore({
    body: { ...request.body, ranges: [{ coreKey, start: 1, end: 4 }] },
  }, { manifestStore, authorizeRendition }), false, 'archive participation accepts complete copies only')
})

test('random possession challenges bind transport identity, score proofs, and expire missed responses', async (t) => {
  const requesterTransport = crypto.keyPair(b4a.alloc(32, 81))
  const volunteerTransport = crypto.keyPair(b4a.alloc(32, 82))
  const requesterPeerId = b4a.toString(requesterTransport.publicKey, 'hex')
  const volunteerPeerId = b4a.toString(volunteerTransport.publicKey, 'hex')
  const proofBytes = b4a.from('verified-hypercore-block-proof')
  const observations = []
  const rewards = []
  let requesterNetwork
  let proofResult
  let responseTransportPeerId
  let currentTime = 1_000
  let respondToChallenge = true

  const requesterScoped = {
    ...scopedRecorder(),
    getLocalTransportPeerId: () => requesterPeerId,
    retainArchiveDiscovery: async () => ({ status: 'retained' }),
    releaseArchiveDiscovery: async () => ({ status: 'released' }),
    verifyAuthorizedArchiveChallengeProof: async input => b4a.equals(input.proofBytes, proofBytes),
  }
  const volunteerScoped = {
    ...scopedRecorder(),
    getLocalTransportPeerId: () => volunteerPeerId,
    retainArchiveDiscovery: async () => ({ status: 'retained' }),
    releaseArchiveDiscovery: async () => ({ status: 'released' }),
    createAuthorizedArchiveChallengeProof: async () => proofBytes,
  }
  const archiveStore = {
    async putPledge () {},
    async putObservation (observation) { observations.push(observation) },
  }

  const volunteerNetwork = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => currentTime,
    random: () => 0,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 1,
    challengeIntervalMs: 1_000,
    challengeTimeoutMs: 20,
    authorizeRequest: authorized,
    scopedNetwork: volunteerScoped,
    publishPledge: envelope => requesterNetwork.ingestPledge(envelope, { peerId: volunteerPeerId }),
    publishChallengeProof: packet => {
      responseTransportPeerId = JSON.parse(b4a.toString(packet.envelope.body)).transportPeerId
      if (!respondToChallenge) return { status: 'published', delivered: 0 }
      return requesterNetwork.ingestChallengeProof(packet, { peerId: volunteerPeerId }).then(result => {
        proofResult = result
        return result
      })
    },
  })
  requesterNetwork = createPermissionlessArchiveNetwork({
    keyPair: requester,
    transportPeerId: requesterPeerId,
    peerScorer: {
      usefulWork: {
        reward: (kind, amount, context) => rewards.push({ kind, amount, context }),
      },
    },
    now: () => currentTime,
    challengeIntervalMs: 1_000,
    challengeTimeoutMs: 20,
    archiveStore,
    scopedNetwork: requesterScoped,
    publishRequest: envelope => volunteerNetwork.ingestRequest(envelope),
    publishChallenge: envelope => volunteerNetwork.ingestChallenge(envelope, { peerId: requesterPeerId }),
  })

  await requesterNetwork.requestArchive({
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 4096,
    retentionUntil: 20_000,
    expiresAt: 2_000,
  })
  const issued = await requesterNetwork.runChallengeCycle()

  t.is(issued.status, 'published')
  t.is(proofResult.status, 'accepted')
  t.is(responseTransportPeerId, volunteerPeerId, 'proof binds the Noise transport identity rather than the signing identity')
  t.not(responseTransportPeerId, b4a.toString(volunteer.publicKey, 'hex'))
  t.ok(observations.some(observation => observation.status === 'challenge-issued'))
  t.ok(observations.some(observation => observation.status === 'challenge-passed'))
  t.alike(rewards.map(reward => [reward.kind, reward.context.peerId]), [['proof-accepted', volunteerPeerId]])
  t.is(requesterNetwork.getOffloadEvidence(publicationId, ranges).length, 1)
  t.is(requesterNetwork.getOffloadEvidence(publicationId, [
    { coreKey: 'd'.repeat(64), start: 0, end: 4 },
  ]).length, 0, 'proof for another core cannot authorize source deletion')

  respondToChallenge = false
  currentTime = 2_000
  t.is((await requesterNetwork.runChallengeCycle()).status, 'published')
  await new Promise(resolve => setTimeout(resolve, 30))
  t.ok(observations.some(observation =>
    observation.status === 'challenge-failed' && observation.failureCode === 'UNAVAILABLE'
  ), 'missed response deadline records a failed challenge')
  t.ok(rewards.some(reward => reward.kind === 'proof-rejected' && reward.context.peerId === volunteerPeerId))

  await requesterNetwork.close()
  await volunteerNetwork.close()
})

test('permissionless acceptance reserves before retain and releases reservation on failure and expiry', async (t) => {
  let currentTime = 1_000
  const timers = []
  const policy = createArchivePolicy({ capacityBytes: 1024, now: () => currentTime })
  const scoped = scopedRecorder()
  let failRetain = true
  scoped.retainAuthorizedArchive = async input => {
    const snapshot = await policy.snapshot()
    t.is(snapshot.reservedBytes, 512, 'retention starts only after exact bytes are reserved')
    if (failRetain) throw new Error('disk write failed')
    scoped.retained.push(input)
    return { status: 'retained' }
  }
  const network = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => currentTime,
    random: () => 0,
    enabled: true,
    capacityBytes: 1024,
    acceptanceProbability: 1,
    authorizeRequest: authorized,
    scopedNetwork: scoped,
    archivePolicy: policy,
    setTimeout(fn, delay) {
      const timer = { fn, delay, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeout() {},
  })
  await network.ready
  const makeRequest = nonce => createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 512,
    retentionUntil: 2_000,
    expiresAt: 1_500,
    issuedAt: 1_000,
    nonce,
    keyPair: requester,
  })

  t.is((await network.ingestRequest(makeRequest('fail').envelope)).reason, 'retention-failed')
  t.is((await policy.snapshot()).reservedBytes, 0, 'failed retention releases its reservation')

  failRetain = false
  t.is((await network.ingestRequest(makeRequest('success').envelope)).status, 'accepted')
  t.is((await policy.snapshot()).reservedBytes, 512)
  currentTime = 2_000
  await timers.at(-1).fn()
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is((await policy.snapshot()).reservedBytes, 0, 'retention expiry releases persisted capacity')
  t.is(network.getStatus().acceptedRequests, 0)
})

test('archive participation restores retained pledges and expiry timers after restart', async (t) => {
  let currentTime = 1_000
  const repository = (() => {
    let state = null
    return {
      async load () { return state == null ? null : structuredClone(state) },
      async save (next) { state = structuredClone(next) },
    }
  })()
  const timers = []
  const timerOptions = {
    setTimeout(fn, delay) {
      const timer = { fn, delay, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimeout() {},
  }
  const firstScoped = scopedRecorder()
  const first = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => currentTime,
    random: () => 0,
    enabled: true,
    capacityBytes: 1024,
    acceptanceProbability: 1,
    authorizeRequest: authorized,
    scopedNetwork: firstScoped,
    archivePolicy: createArchivePolicy({ capacityBytes: 1024, now: () => currentTime, repository }),
    ...timerOptions,
  })
  const request = createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 512,
    retentionUntil: 2_000,
    expiresAt: 1_500,
    issuedAt: 1_000,
    nonce: 'restart',
    keyPair: requester,
  })
  t.is((await first.ingestRequest(request.envelope)).status, 'accepted')
  await first.close()

  const restartedScoped = scopedRecorder()
  const restarted = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => currentTime,
    enabled: true,
    capacityBytes: 1024,
    authorizeRequest: authorized,
    scopedNetwork: restartedScoped,
    archivePolicy: createArchivePolicy({ capacityBytes: 1024, now: () => currentTime, repository }),
    ...timerOptions,
  })
  await restarted.ready
  t.is(restarted.getStatus().acceptedRequests, 1)
  t.is(restarted.getStatus().reservedBytes, 512)
  t.ok(timers.some(timer => timer.delay === 1_000), 'restored pledge schedules its remaining retention')

  currentTime = 2_000
  await timers.at(-1).fn()
  t.is(restarted.getStatus().acceptedRequests, 0)
  t.is(restarted.getStatus().reservedBytes, 0)
  t.is(restartedScoped.released.length, 1)
})

test('disabled persisted retention policy releases reservations before archive startup', async (t) => {
  let state = null
  const repository = {
    async load () { return state == null ? null : structuredClone(state) },
    async save (next) { state = structuredClone(next) },
  }
  const pledge = createArchivePledge({
    archivistId: volunteer.publicKey,
    publicationId,
    renditionId,
    ranges,
    retentionUntil: 2_000,
    uploadCeilingBytes: 1024,
    issuedAt: 1_000,
    nonce: 'disabled-restart',
    keyPair: volunteer,
  })
  const policy = createArchivePolicy({ capacityBytes: 1024, now: () => 1_000, repository })
  await policy.ready
  t.is((await policy.reserve({
    pledgeId: pledge.pledgeId,
    bytes: 512,
    expiresAt: 2_000,
    pledgeEnvelope: pledge.envelope,
  })).accepted, true)

  const scoped = scopedRecorder()
  const restartedPolicy = createArchivePolicy({ capacityBytes: 1024, now: () => 1_000, repository })
  const restarted = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => 1_000,
    enabled: false,
    capacityBytes: 1024,
    scopedNetwork: scoped,
    archivePolicy: restartedPolicy,
  })
  await restarted.ready

  t.is((await restartedPolicy.snapshot()).reservedBytes, 0)
  t.is(scoped.retained.length, 0)
  t.is(scoped.released.length, 1)
})

test('archive participation policy persists across backend restarts', async (t) => {
  let state = null
  const participationRepository = {
    async load () { return state == null ? null : structuredClone(state) },
    async save (next) { state = structuredClone(next) },
  }
  const first = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    scopedNetwork: scopedRecorder(),
    participationRepository,
  })
  await first.ready
  await first.setParticipation({
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 2048,
    acceptanceProbability: 0.75,
  })
  await first.close()

  const restarted = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    scopedNetwork: scopedRecorder(),
    participationRepository,
  })
  await restarted.ready
  t.alike(restarted.getStatus(), {
    enabled: true,
    capacityBytes: 8192,
    maxRequestBytes: 2048,
    acceptanceProbability: 0.75,
    reservedBytes: 0,
    availableBytes: 8192,
    acceptedRequests: 0,
    knownRequests: 0,
    receivedPledges: 0,
    randomRejections: 0,
    capacityRejections: 0,
    authorizationRejections: 0,
  })
  await restarted.close()
})

test('requester releases received pledge scopes when retention expires', async (t) => {
  let currentTime = 1_000
  const timers = []
  const scoped = scopedRecorder()
  const network = createPermissionlessArchiveNetwork({
    keyPair: requester,
    now: () => currentTime,
    scopedNetwork: scoped,
    publishRequest: async () => ({ status: 'published' }),
    setTimeout (fn, delay) {
      const timer = { fn, delay, unref () {} }
      timers.push(timer)
      return timer
    },
    clearTimeout () {},
  })
  const requested = await network.requestArchive({
    publicationId,
    renditionId,
    ranges,
    requestedBytes: 4096,
    expiresAt: 1_500,
    retentionUntil: 2_000,
  })
  const pledge = createArchivePledge({
    archivistId: volunteer.publicKey,
    publicationId,
    renditionId,
    ranges,
    retentionUntil: 2_000,
    uploadCeilingBytes: 4096,
    issuedAt: 1_000,
    nonce: requested.requestId,
    keyPair: volunteer,
  })
  t.is((await network.ingestPledge(pledge.envelope)).status, 'accepted')
  t.is(network.getStatus().receivedPledges, 1)
  currentTime = 2_000
  await timers.find(timer => timer.delay === 1_000).fn()
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(network.getStatus().receivedPledges, 0)
  t.ok(scoped.released.some(entry => entry.archiveId === pledge.pledgeId))
  await network.close()
})

test('one transport peer cannot run unbounded possession proofs concurrently', async (t) => {
  let releaseProof
  const proofGate = new Promise(resolve => { releaseProof = resolve })
  let proofCalls = 0
  const scoped = {
    ...scopedRecorder(),
    getLocalTransportPeerId: () => b4a.toString(volunteer.publicKey, 'hex'),
    async createAuthorizedArchiveChallengeProof () {
      proofCalls++
      await proofGate
      return b4a.from('bounded-proof')
    },
  }
  const network = createPermissionlessArchiveNetwork({
    keyPair: volunteer,
    now: () => 1_000,
    random: () => 0,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 1,
    maxActiveChallengesPerPeer: 1,
    authorizeRequest: authorized,
    scopedNetwork: scoped,
    publishChallengeProof: async () => ({ status: 'published' }),
  })
  const pledges = []
  for (const nonce of ['concurrent-a', 'concurrent-b']) {
    const request = createArchiveRequest({
      requesterId: requester.publicKey,
      publicationId,
      renditionId,
      ranges,
      requestedBytes: 512,
      retentionUntil: 20_000,
      expiresAt: 2_000,
      issuedAt: 1_000,
      nonce,
      keyPair: requester,
    })
    pledges.push((await network.ingestRequest(request.envelope)).pledge)
  }
  const peerId = b4a.toString(requester.publicKey, 'hex')
  const signedChallenges = pledges.map((pledge, index) => {
    const challenge = createArchiveChallenge({
      pledgeEnvelope: pledge.envelope,
      auditorEntropy: b4a.alloc(32, index + 1),
      auditorPublicKey: requester.publicKey,
      coreKey,
      range: { start: index, end: index + 1 },
      deadline: 1_500,
    })
    return createArchiveChallengeEnvelope({
      challenge,
      keyPair: requester,
      issuedAt: 1_000,
    }).envelope
  })

  const first = network.ingestChallenge(signedChallenges[0], { peerId })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is((await network.ingestChallenge(signedChallenges[1], { peerId })).reason, 'challenge-peer-busy')
  t.is(proofCalls, 1)
  releaseProof()
  t.is((await first).status, 'published')
  await network.close()
})
