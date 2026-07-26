import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createAssetManifestStore, createPublicationManifest, createRenditionDescriptor } from '../src/assets/index.js'
import { createEntityReference, createMediaClaim, createMediaGraphStore } from '../src/media-graph/index.js'
import { createAvailabilityEvidenceStore } from '../src/assets/availability-evidence.js'

import {
  AVAILABILITY_EVIDENCE_TTL_MS,
  AVAILABILITY_REASON_CODES,
  AVAILABILITY_STATES,
  MIN_HEALTHY_PEERS,
  assessAvailability,
  availabilityScoreForState,
  isPlayableAvailability,
  requiredRangesForRendition,
} from '../src/assets/availability.js'

const NOW = 1_700_000_000_000
const REQUIRED = [{ start: 0, end: 100 }]
const REASONS = new Set(AVAILABILITY_REASON_CODES)

function peer(transportKey, overrides = {}) {
  return {
    transportKey,
    connected: true,
    advertisedRanges: REQUIRED,
    advertisedAt: NOW - 5_000,
    challengeStatus: 'passed',
    verifiedAt: NOW - 1_000,
    ...overrides,
  }
}

function assess(input = {}, now = NOW) {
  return assessAvailability({ publicationId: 'pub-1', renditionId: 'rendition-1', requiredRanges: REQUIRED, ...input }, { now })
}

test('a never-assessed publication is awaiting replication, not unavailable', (t) => {
  const result = assess({ peers: [] })
  t.is(result.state, AVAILABILITY_STATES.awaitingReplication)
  t.alike(result.reasonCodes, ['NEVER_ASSESSED'])
  t.is(result.observedAt, NOW)
  t.is(result.expiresAt, NOW, 'nothing is holding, so nothing expires later')
  t.is(result.requiredRangeCount, 1)
  t.is(result.reachableRangeCount, 0)
  t.is(result.independentPeerCount, 0)
  t.is(result.completePeerCount, 0)
})

test('metadata without an immutable rendition is never healthy', (t) => {
  const result = assess({ requiredRanges: [], peers: [peer('aa'), peer('bb')] })
  t.is(result.state, AVAILABILITY_STATES.awaitingReplication)
  t.alike(result.reasonCodes, ['METADATA_ONLY'])
  t.is(result.requiredRangeCount, 0)
  t.is(result.independentPeerCount, 0)
})

test('one complete peer is limited, never healthy', (t) => {
  const result = assess({ peers: [peer('aa')] })
  t.is(result.state, AVAILABILITY_STATES.limited)
  t.alike(result.reasonCodes, ['COMPLETE_PEER_EVIDENCE', 'INSUFFICIENT_INDEPENDENT_PEERS'])
  t.is(result.reachableRangeCount, 1)
  t.is(result.independentPeerCount, 1)
  t.is(result.completePeerCount, 1)
  t.is(result.expiresAt, NOW - 1_000 + AVAILABILITY_EVIDENCE_TTL_MS)
})

test('two independent transport identities with fresh complete evidence are healthy', (t) => {
  const result = assess({
    peers: [peer('aa', { verifiedAt: NOW - 1_000 }), peer('bb', { advertisedAt: NOW - 20_000, verifiedAt: NOW - 10_000 })],
  })
  t.is(result.state, AVAILABILITY_STATES.healthy)
  t.alike(result.reasonCodes, ['COMPLETE_PEER_EVIDENCE'])
  t.is(result.independentPeerCount, MIN_HEALTHY_PEERS)
  t.is(result.completePeerCount, MIN_HEALTHY_PEERS)
  t.is(
    result.expiresAt,
    NOW - 10_000 + AVAILABILITY_EVIDENCE_TTL_MS,
    'healthy decays when the second-freshest complete proof ages out'
  )
})

test('duplicate sockets from one Noise key count once', (t) => {
  const result = assess({
    peers: [
      peer('aa', { verifiedAt: NOW - 1_000 }),
      peer('AA', { verifiedAt: NOW - 2_000 }),
      peer('aa', { verifiedAt: NOW - 3_000 }),
    ],
  })
  t.is(result.state, AVAILABILITY_STATES.limited)
  t.is(result.independentPeerCount, 1)
  t.is(result.completePeerCount, 1)
})

test('a failed validation on one socket disqualifies the whole transport identity', (t) => {
  const result = assess({
    peers: [peer('aa'), peer('aa', { challengeStatus: 'failed' }), peer('bb')],
  })
  t.is(result.state, AVAILABILITY_STATES.limited, 'only the honest identity still counts')
  t.is(result.independentPeerCount, 1)
  t.ok(result.reasonCodes.includes('VALIDATION_MISMATCH'))
})

test('partial peers that together cover every required range are limited', (t) => {
  const result = assess({
    peers: [
      peer('aa', { advertisedRanges: [{ start: 0, end: 60 }] }),
      peer('bb', { advertisedRanges: [{ start: 55, end: 100 }] }),
    ],
  })
  t.is(result.state, AVAILABILITY_STATES.limited)
  t.alike(result.reasonCodes, ['UNION_RANGE_COVERAGE', 'INSUFFICIENT_INDEPENDENT_PEERS'])
  t.is(result.reachableRangeCount, 1)
  t.is(result.independentPeerCount, 2)
  t.is(result.completePeerCount, 0, 'two partial peers are not two complete peers')
})

test('active sessions that cannot reach every required range are unavailable', (t) => {
  const result = assess({
    peers: [
      peer('aa', { advertisedRanges: [{ start: 0, end: 40 }] }),
      peer('bb', { advertisedRanges: [{ start: 60, end: 100 }] }),
    ],
  })
  t.is(result.state, AVAILABILITY_STATES.unavailable)
  t.ok(result.reasonCodes.includes('PARTIAL_RANGE_COVERAGE'))
  t.is(result.reachableRangeCount, 0)
})

test('an advertisement the challenge never reached proves nothing', (t) => {
  const result = assess({
    peers: [
      peer('aa', { provenRanges: [{ start: 0, end: 10 }] }),
      peer('bb', { provenRanges: [{ start: 0, end: 10 }] }),
    ],
  })
  t.is(result.state, AVAILABILITY_STATES.unavailable)
  t.is(result.completePeerCount, 0)
  t.is(result.reachableRangeCount, 0)
})

test('a challenge older than the advertisement it claims to prove is rejected', (t) => {
  const result = assess({ peers: [peer('aa', { advertisedAt: NOW - 500, verifiedAt: NOW - 1_000 })] })
  t.is(
    result.state,
    AVAILABILITY_STATES.awaitingReplication,
    'the current advertisement is unproven, which is not the same as proven unreachable'
  )
  t.is(result.independentPeerCount, 0)
  t.alike(result.reasonCodes, ['NEVER_ASSESSED'])
})

test('evidence expires exactly at the versioned TTL', (t) => {
  const atBoundary = assess({ peers: [peer('aa', { advertisedAt: 0, verifiedAt: NOW - AVAILABILITY_EVIDENCE_TTL_MS })] })
  t.is(atBoundary.state, AVAILABILITY_STATES.limited, 'evidence is valid through its final millisecond')

  const expired = assess({ peers: [peer('aa', { advertisedAt: 0, verifiedAt: NOW - AVAILABILITY_EVIDENCE_TTL_MS - 1 })] })
  t.is(expired.state, AVAILABILITY_STATES.unavailable, 'expiry without replacement downgrades an observed source')
  t.ok(expired.reasonCodes.includes('EVIDENCE_EXPIRED'))
  t.is(expired.expiresAt, NOW)
})

test('disconnect and timeout remove a peer from current evidence', (t) => {
  const disconnected = assess({ peers: [peer('aa', { connected: false }), peer('bb', { connected: false })] })
  t.is(disconnected.state, AVAILABILITY_STATES.unavailable)
  t.alike(disconnected.reasonCodes, ['PEER_DISCONNECT'])

  const timedOut = assess({ peers: [peer('aa', { challengeStatus: 'timeout', verifiedAt: 0 })] })
  t.is(timedOut.state, AVAILABILITY_STATES.unavailable)
  t.alike(timedOut.reasonCodes, ['PEER_TIMEOUT'])
})

test('a local complete copy is offline-playable and never inflates peer counts', (t) => {
  const result = assess({ peers: [], localRanges: REQUIRED, previouslyObserved: false })
  t.is(result.offlinePlayable, true)
  t.is(result.independentPeerCount, 0)
  t.is(result.state, AVAILABILITY_STATES.awaitingReplication, 'a local copy is not network availability')
  t.ok(result.reasonCodes.includes('LOCAL_COMPLETE_COPY'))
})

test('a static archive pledge is durability evidence and never advances availability', (t) => {
  const result = assess({ peers: [], archivePledgeCount: 3 })
  t.is(result.state, AVAILABILITY_STATES.awaitingReplication)
  t.is(result.archivePledged, true)
  t.is(result.independentPeerCount, 0)
  t.ok(result.reasonCodes.includes('ARCHIVE_PLEDGE_ONLY'))
})

test('a fresh archivist possession challenge counts only while its transport is active', (t) => {
  const active = assess({ peers: [peer('archivist-key', { archivist: true }), peer('bb')], archivePledgeCount: 1 })
  t.is(active.state, AVAILABILITY_STATES.healthy)
  t.is(active.completePeerCount, 2)

  const gone = assess({
    peers: [peer('archivist-key', { archivist: true, connected: false }), peer('bb')],
    archivePledgeCount: 1,
  })
  t.is(gone.state, AVAILABILITY_STATES.limited, 'the pledge survives, the reachability does not')
})

test('a lazy assessment that never ran reports its budget instead of guessing', (t) => {
  const result = assess({ peers: [], budgetExceeded: true })
  t.is(result.state, AVAILABILITY_STATES.awaitingReplication)
  t.alike(result.reasonCodes, ['ASSESSMENT_BUDGET_EXCEEDED'])
})

test('a source recovers when a new peer replaces expired evidence', (t) => {
  const stale = [peer('aa', { advertisedAt: 0, verifiedAt: NOW - AVAILABILITY_EVIDENCE_TTL_MS - 1 })]
  t.is(assess({ peers: stale }).state, AVAILABILITY_STATES.unavailable)
  t.is(assess({ peers: [...stale, peer('bb'), peer('cc')] }).state, AVAILABILITY_STATES.healthy)
})

test('assessment is deterministic under fixed time and emits only bounded reason codes', (t) => {
  const input = {
    peers: [peer('bb', { advertisedRanges: [{ start: 0, end: 70 }] }), peer('aa', { connected: false })],
    localRanges: REQUIRED,
    archivePledgeCount: 1,
  }
  const first = assess(input)
  const second = assess(input)
  t.alike(first, second)
  t.ok(first.reasonCodes.length <= 8)
  t.ok(first.reasonCodes.every(code => REASONS.has(code)))
})

test('availability scoring and playability follow the four-state contract', (t) => {
  t.ok(availabilityScoreForState(AVAILABILITY_STATES.healthy) > availabilityScoreForState(AVAILABILITY_STATES.limited))
  t.is(availabilityScoreForState(AVAILABILITY_STATES.unavailable), 0)
  t.is(availabilityScoreForState(AVAILABILITY_STATES.awaitingReplication), 0)
  t.is(availabilityScoreForState('nonsense'), 0)
  t.is(isPlayableAvailability({ state: AVAILABILITY_STATES.limited }), true)
  t.is(isPlayableAvailability({ state: AVAILABILITY_STATES.awaitingReplication }), false)
})

test('required ranges come from the immutable rendition core, not publisher claims', (t) => {
  t.alike(requiredRangesForRendition({ core: { length: 12 } }), [{ start: 0, end: 12 }])
  t.alike(requiredRangesForRendition({ core: { length: 0 } }), [])
  t.alike(requiredRangesForRendition(null), [])
})

test('malformed evidence is rejected rather than silently scored', (t) => {
  t.exception(() => assess({ peers: [{ transportKey: '' }] }), /transportKey/)
  t.exception(() => assess({ peers: [peer('aa', { advertisedRanges: [{ start: 5, end: 5 }] })] }), /invalid range/)
  t.exception(() => assess({ peers: Array.from({ length: 257 }, (_, index) => peer(`k${index}`)) }), /bounded array/)
})

const publisher = crypto.keyPair(Buffer.alloc(32, 7))
const CORE_LENGTH = 8

async function graphFixture(evidenceByPublication = new Map()) {
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore: new Map(),
    availabilityEvidenceStore: { getCachedEvidence: publicationId => evidenceByPublication.get(publicationId) || {} },
    now: () => NOW,
    trust: { [b4a.toString(publisher.publicKey, 'hex')]: 10 },
  })
  const subject = createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: 'availabl123' })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Assessed title',
    renditions: [createRenditionDescriptor({
      purpose: 'original',
      format: 'video/mp4',
      core: { key: '1'.repeat(64), length: CORE_LENGTH, treeHash: '2'.repeat(64), byteLength: 4_096 },
    })],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(manifest)
  const claim = createMediaClaim({
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 500,
    keyPair: publisher,
  })
  await mediaGraphStore.ingestClaim(claim.envelope)
  return { api, mediaGraphStore, subject, manifest, evidenceByPublication }
}

test('the manifest rendition, not the publisher claim, defines what must be reachable', async (t) => {
  const { api, subject } = await graphFixture()
  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  t.is(detail.entity.availability.state, AVAILABILITY_STATES.awaitingReplication)
  t.is(detail.entity.availability.requiredRangeCount, 1)
  t.is(detail.entity.availability.reachableRangeCount, 0)
  t.alike(detail.entity.availability.reasonCodes, ['NEVER_ASSESSED'])
})

test('cards, detail, and Other Sources quote one assessment for one title', async (t) => {
  const evidence = new Map()
  const { api, subject, manifest } = await graphFixture(evidence)
  evidence.set(manifest.publicationId, {
    peers: [
      peer('aa', { advertisedRanges: [{ start: 0, end: CORE_LENGTH }] }),
      peer('bb', { advertisedRanges: [{ start: 0, end: CORE_LENGTH }] }),
    ],
  })

  const catalog = await api.getMediaCatalog({})
  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  const sources = await api.getPublicationSources({ entityId: subject.entityId })

  const card = catalog.items.find(item => item.entityId === subject.entityId)
  t.alike(card.availability, detail.entity.availability, 'a card and its detail never disagree')
  t.alike(card.sources[0].availability, sources.items[0].availability, 'Other Sources quotes the same evidence')
  t.is(detail.entity.availability.state, AVAILABILITY_STATES.healthy)
  t.is(detail.entity.availability.observedAt, NOW)
  t.is(detail.entity.sources[0].availability.expiresAt, NOW - 1_000 + AVAILABILITY_EVIDENCE_TTL_MS)
})

test('one operation assesses one rendition once', async (t) => {
  const evidence = new Map()
  const { api, mediaGraphStore, subject, manifest } = await graphFixture(evidence)
  // A second signed observation of the same publication must not trigger a
  // second assessment: the operation-scoped cache is what keeps every surface
  // quoting one answer.
  const echo = createMediaClaim({
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 400,
    keyPair: publisher,
  })
  await mediaGraphStore.ingestClaim(echo.envelope)

  const peers = [peer('aa'), peer('bb')]
  let reads = 0
  evidence.set(manifest.publicationId, {
    get peers() {
      reads += 1
      return peers
    },
  })

  const sources = await api.getPublicationSources({ entityId: subject.entityId })
  t.is(sources.items.length, 2, 'both observations are projected as sources')
  t.is(sources.items[0].availability.state, AVAILABILITY_STATES.healthy)
  t.is(reads, 1, 'the per-operation cache assesses each rendition exactly once')
})

function evidenceFixture(overrides = {}) {
  let clock = NOW
  const store = createAvailabilityEvidenceStore({ now: () => clock, ...overrides })
  return { store, advance(ms) { clock += ms }, at() { return clock } }
}

test('evidence collection is lazy: an unadmitted rendition reports its budget', (t) => {
  const { store } = evidenceFixture({ assessmentBudget: 1 })
  t.is(store.requestAssessment('pub-1'), true)
  t.is(store.requestAssessment('pub-2'), false, 'the bounded active set refuses a second rendition')
  t.is(store.trackedRenditionCount(), 1)

  const unadmitted = store.getCachedEvidence('pub-2')
  t.is(unadmitted.budgetExceeded, true)
  const assessment = assessAvailability({ ...unadmitted, requiredRanges: REQUIRED }, { now: NOW })
  t.is(assessment.state, AVAILABILITY_STATES.awaitingReplication)
  t.alike(assessment.reasonCodes, ['ASSESSMENT_BUDGET_EXCEEDED'])
})

test('an advertisement without a passed challenge never reaches limited', (t) => {
  const { store } = evidenceFixture()
  store.requestAssessment('pub-1')
  store.recordAdvertisement('pub-1', null, { transportKey: 'aa', ranges: REQUIRED, at: NOW })
  const assessment = assessAvailability(
    { ...store.getCachedEvidence('pub-1'), requiredRanges: REQUIRED },
    { now: NOW }
  )
  t.is(assessment.state, AVAILABILITY_STATES.awaitingReplication, 'an unproven advertisement is not evidence')
  t.is(assessment.independentPeerCount, 0)
})

test('a passed challenge over an advertisement produces usable evidence', (t) => {
  const { store, advance } = evidenceFixture()
  store.requestAssessment('pub-1')
  for (const key of ['aa', 'bb']) {
    store.recordAdvertisement('pub-1', null, { transportKey: key, ranges: REQUIRED, at: NOW })
    advance(10)
    store.recordChallengeResult('pub-1', null, { transportKey: key, status: 'passed' })
  }
  const at = NOW + 20
  const assessment = assessAvailability(
    { ...store.getCachedEvidence('pub-1'), requiredRanges: REQUIRED },
    { now: at }
  )
  t.is(assessment.state, AVAILABILITY_STATES.healthy)
  t.is(assessment.completePeerCount, 2)
})

test('a re-advertisement invalidates the proof it replaces', (t) => {
  const { store } = evidenceFixture()
  store.requestAssessment('pub-1')
  store.recordAdvertisement('pub-1', null, { transportKey: 'aa', ranges: REQUIRED, at: NOW })
  store.recordChallengeResult('pub-1', null, { transportKey: 'aa', status: 'passed', at: NOW + 5 })
  store.recordAdvertisement('pub-1', null, { transportKey: 'aa', ranges: [{ start: 0, end: 200 }], at: NOW + 10 })

  const peer = store.getCachedEvidence('pub-1').peers[0]
  t.is(peer.challengeStatus, 'pending')
  t.is(peer.verifiedAt, 0, 'the old proof cannot vouch for a new advertisement')
})

test('a disconnect removes a transport from evidence everywhere at once', (t) => {
  const { store } = evidenceFixture()
  store.requestAssessment('pub-1')
  store.requestAssessment('pub-2')
  for (const publicationId of ['pub-1', 'pub-2']) {
    store.recordAdvertisement(publicationId, null, { transportKey: 'aa', ranges: REQUIRED, at: NOW })
    store.recordChallengeResult(publicationId, null, { transportKey: 'aa', status: 'passed', at: NOW + 1 })
  }
  store.recordDisconnect('aa')

  for (const publicationId of ['pub-1', 'pub-2']) {
    const assessment = assessAvailability(
      { ...store.getCachedEvidence(publicationId), requiredRanges: REQUIRED },
      { now: NOW + 2 }
    )
    t.is(assessment.state, AVAILABILITY_STATES.unavailable)
    t.ok(assessment.reasonCodes.includes('PEER_DISCONNECT'))
  }
})

test('a static pledge and a local copy are recorded without becoming reachability', (t) => {
  const { store } = evidenceFixture()
  store.recordArchivePledgeCount('pub-1', null, 4)
  store.recordLocalRanges('pub-1', null, REQUIRED)
  const assessment = assessAvailability(
    { ...store.getCachedEvidence('pub-1'), requiredRanges: REQUIRED },
    { now: NOW }
  )
  t.is(assessment.state, AVAILABILITY_STATES.awaitingReplication)
  t.is(assessment.archivePledged, true)
  t.is(assessment.offlinePlayable, true)
  t.is(assessment.independentPeerCount, 0)
})
