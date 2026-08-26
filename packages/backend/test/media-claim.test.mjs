import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  CLAIM_TYPES,
  createEntityReference,
  createMediaClaim,
  decodeClaimBody,
  encodeClaimBody,
  verifyMediaClaim,
} from '../src/media-graph/index.js'
import { createApplicationEnvelope, toHex } from '../src/records/application-envelope.js'

const issuer = crypto.keyPair(Buffer.alloc(32, 1))
const otherIssuer = crypto.keyPair(Buffer.alloc(32, 2))

function workRef(id = 'episode-1') {
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: `${id}___________`.slice(0, 11) })
}

function collectionRef(id = 'show:season:1') {
  return createEntityReference({ entityKind: 'collection', namespace: 'issuer-native', issuerRootKey: issuer.publicKey, issuerLocalId: id })
}

function agentRef(id = 'agent-1') {
  return createEntityReference({ entityKind: 'agent', namespace: 'issuer-native', issuerRootKey: issuer.publicKey, issuerLocalId: id })
}

test('claim type registry covers Task 3 canonical claim variants', (t) => {
  t.alike(CLAIM_TYPES, [
    'EntityMetadataClaim',
    'ExternalReferenceClaim',
    'EquivalentEntityClaim',
    'EditionOfClaim',
    'RecordingOfClaim',
    'ContributionClaim',
    'CollectionStructureClaim',
    'CollectionMembershipClaim',
    'SupersedesClaim',
    'RetractionClaim',
    'ModerationClaim',
    'AvailabilityObservation',
  ])
})

test('media claims specialize SignedEnvelope and use recordId as claimId', async (t) => {
  const claim = createMediaClaim({
    claimType: 'EntityMetadataClaim',
    subjectRefs: [workRef()],
    payload: { title: 'Pilot', sortTitle: 'Pilot', releaseYear: 2004 },
    evidenceRefs: [{ type: 'url', url: 'https://example.test/evidence' }],
    confidence: 900,
    keyPair: issuer,
    issuerSequence: 1,
    policyEpoch: 3,
    signedAt: 10,
  })

  t.alike(claim.envelope.recordType, 'peartube.media-claim.v1')
  t.alike(claim.claimId, toHex(claim.envelope.recordId))
  t.alike(claim.body.claimType, 'EntityMetadataClaim')
  t.alike(claim.body.issuerSequence, 1)
  t.alike(claim.body.policyEpoch, 3)
  t.ok(await verifyMediaClaim(claim.envelope, { allowedSigners: [issuer.publicKey], now: 11 }))
})

test('claim body codec is canonical, bounded, and round-trips typed refs', (t) => {
  const body = {
    claimType: 'EquivalentEntityClaim',
    subjectRefs: [workRef('a'), workRef('b')],
    payload: { relation: 'same-work' },
    evidenceRefs: [{ type: 'fingerprint', digest: 'sha256:' + 'a'.repeat(64) }],
    confidence: 750,
    issuerSequence: 2,
    policyEpoch: 1,
  }

  const encoded = encodeClaimBody(body)
  const decoded = decodeClaimBody(encoded)

  t.alike(decoded, body)
  t.alike(encodeClaimBody(decoded), encoded)
  t.exception(() => encodeClaimBody({ ...body, subjectRefs: Array.from({ length: 65 }, () => workRef('x')) }), /subjectRefs/)
  t.exception(() => encodeClaimBody({ ...body, evidenceRefs: Array.from({ length: 65 }, () => ({ type: 'url', url: 'https://example.test' })) }), /evidenceRefs/)
  t.exception(() => encodeClaimBody({ ...body, payload: { text: 'x'.repeat(70 * 1024) } }), /payload/)
})

test('typed claim payloads enforce endpoint compatibility and numeric bounds', (t) => {
  t.exception(() => createMediaClaim({ claimType: 'ContributionClaim', subjectRefs: [workRef()], payload: { subjectRef: workRef(), role: 'director' }, keyPair: issuer }), /agentRef/)
  t.exception(() => createMediaClaim({ claimType: 'CollectionMembershipClaim', subjectRefs: [collectionRef()], payload: { collectionRef: collectionRef(), memberRef: workRef(), position: { episode: -1 }, insertionId: 'a' }, keyPair: issuer }), /position/)
  t.exception(() => createMediaClaim({ claimType: 'CollectionStructureClaim', subjectRefs: [collectionRef()], payload: { collectionRef: collectionRef(), expectedSlots: 100001 }, keyPair: issuer }), /expectedSlots/)

  const contribution = createMediaClaim({
    claimType: 'ContributionClaim',
    subjectRefs: [workRef()],
    payload: { agentRef: agentRef(), subjectRef: workRef(), role: 'director', creditedName: 'A Director', ordinal: 1 },
    keyPair: issuer,
  })
  t.alike(contribution.body.payload.role, 'director')

  const membership = createMediaClaim({
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [collectionRef()],
    payload: { collectionRef: collectionRef(), memberRef: workRef(), memberRole: 'episode', position: { season: 1, episode: 2 }, insertionId: 's1e2' },
    keyPair: issuer,
  })
  t.alike(membership.body.payload.position.episode, 2)
})

test('semantic claims cannot expire while observations may expire', (t) => {
  t.exception(() => createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef()], payload: { title: 'Pilot' }, keyPair: issuer, expiresAt: 20 }), /does not expire/)
  const observation = createMediaClaim({ claimType: 'AvailabilityObservation', subjectRefs: [workRef()], payload: { publicationId: 'pub-1', availabilityStatus: 'available' }, keyPair: issuer, signedAt: 10, expiresAt: 20 })
  t.alike(observation.envelope.expiresAt, 20)
})

test('retractions are scoped to exact prior claim ids and same issuer authority', async (t) => {
  const original = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef()], payload: { title: 'Pilot' }, keyPair: issuer })
  const retraction = createMediaClaim({
    claimType: 'RetractionClaim',
    subjectRefs: [workRef()],
    payload: { targetClaimIds: [original.claimId], reason: 'mistake' },
    keyPair: issuer,
  })
  const foreignRetraction = createMediaClaim({
    claimType: 'RetractionClaim',
    subjectRefs: [workRef()],
    payload: { targetClaimIds: [original.claimId], reason: 'not mine' },
    keyPair: otherIssuer,
  })

  t.ok(await verifyMediaClaim(retraction.envelope, { allowedSigners: [issuer.publicKey], targetClaims: [original] }))
  t.absent(await verifyMediaClaim(foreignRetraction.envelope, { allowedSigners: [otherIssuer.publicKey], targetClaims: [original] }))
})

test('claim verification rejects record type mismatch and candidate-id substitution', async (t) => {
  const claim = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef()], payload: { title: 'Pilot' }, keyPair: issuer })
  const wrongType = createApplicationEnvelope({ recordType: 'peartube.other.v1', body: encodeClaimBody(claim.body), keyPair: issuer })
  const substituted = { ...claim.envelope, recordId: b4a.alloc(32, 9) }

  t.absent(await verifyMediaClaim(wrongType, { allowedSigners: [issuer.publicKey] }))
  t.absent(await verifyMediaClaim(substituted, { allowedSigners: [issuer.publicKey] }))
})
