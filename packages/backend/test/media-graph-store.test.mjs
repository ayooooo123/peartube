import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createEntityReference,
  createMediaClaim,
} from '../src/media-graph/index.js'
import { createMediaGraphStore } from '../src/media-graph/store.js'

const issuer = crypto.keyPair(Buffer.alloc(32, 1))
const otherIssuer = crypto.keyPair(Buffer.alloc(32, 2))
const untrusted = crypto.keyPair(Buffer.alloc(32, 3))

function workRef(id = 'episode-1') {
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: `${id}___________`.slice(0, 11) })
}

function metadataClaim(keyPair = issuer, title = 'Pilot') {
  return createMediaClaim({
    claimType: 'EntityMetadataClaim',
    subjectRefs: [workRef()],
    payload: { title, sortTitle: title },
    confidence: 900,
    keyPair,
    issuerSequence: 1,
    policyEpoch: 1,
  })
}

test('media graph store ingests verified claims idempotently and indexes by issuer and subject', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const claim = metadataClaim()

  t.alike(await store.ingestClaim(claim.envelope), { status: 'accepted', claimId: claim.claimId })
  t.alike(await store.ingestClaim(claim.envelope), { status: 'duplicate', claimId: claim.claimId })
  t.alike(store.getClaimsBySubject(workRef().entityId).map(row => row.claimId), [claim.claimId])
  t.alike(store.getClaimsByIssuer(b4a.toString(issuer.publicKey, 'hex')).map(row => row.claimId), [claim.claimId])
})

test('media graph store quarantines invalid signatures without mutating accepted indexes', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const claim = metadataClaim()
  const forged = { ...claim.envelope, signature: b4a.alloc(64, 9) }

  const result = await store.ingestClaim(forged)
  t.alike(result.status, 'quarantined')
  t.alike(store.getClaimsBySubject(workRef().entityId), [])
  t.alike(store.getQuarantinedClaims().length, 1)
})

test('media graph store records retractions without deleting original provenance', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const original = metadataClaim()
  await store.ingestClaim(original.envelope)
  const retraction = createMediaClaim({
    claimType: 'RetractionClaim',
    subjectRefs: [workRef()],
    payload: { targetClaimIds: [original.claimId], reason: 'mistake' },
    keyPair: issuer,
    issuerSequence: 2,
    policyEpoch: 1,
  })

  t.alike(await store.ingestClaim(retraction.envelope), { status: 'accepted', claimId: retraction.claimId })
  t.ok(store.getClaim(original.claimId).revoked)
  t.alike(store.getClaimsBySubject(workRef().entityId).map(row => row.claimId), [original.claimId, retraction.claimId])
})

test('media graph store keeps untrusted equivalence inspectable but inactive', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const trusted = metadataClaim()
  const untrustedClaim = metadataClaim(untrusted, 'Fake Pilot')

  t.alike(await store.ingestClaim(trusted.envelope), { status: 'accepted', claimId: trusted.claimId })
  t.alike(await store.ingestClaim(untrustedClaim.envelope), { status: 'quarantined' })
  t.alike(store.getQuarantinedClaims()[0].body.payload.title, 'Fake Pilot')
})

test('media graph store indexes by predicate, external ref, publication, and collection', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const collection = createEntityReference({ entityKind: 'collection', namespace: 'issuer-native', issuerRootKey: issuer.publicKey, issuerLocalId: 'season-1' })
  const member = workRef('episode-2')
  const external = createMediaClaim({
    claimType: 'ExternalReferenceClaim',
    subjectRefs: [member],
    payload: { externalRef: { namespace: 'imdb-title', identifier: 'tt0903747' }, publicationId: 'pub-episode-2' },
    keyPair: issuer,
  })
  const membership = createMediaClaim({
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [collection],
    payload: { collectionRef: collection, memberRef: member, memberRole: 'episode', position: { season: 1, episode: 2 }, insertionId: 's1e2' },
    keyPair: issuer,
  })

  await store.ingestClaim(external.envelope)
  await store.ingestClaim(membership.envelope)

  t.alike(store.getClaimsByPredicate('ExternalReferenceClaim').map(row => row.claimId), [external.claimId])
  t.alike(store.getClaimsByExternalRef('imdb-title:tt0903747').map(row => row.claimId), [external.claimId])
  t.alike(store.getClaimsByPublication('pub-episode-2').map(row => row.claimId), [external.claimId])
  t.alike(store.getClaimsByCollection(collection.entityId).map(row => row.claimId), [membership.claimId])
})

test('media graph store bounded scans return stable pages and cursors', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [issuer.publicKey] })
  const claims = []
  for (let i = 0; i < 5; i++) {
    const claim = createMediaClaim({
      claimType: 'EntityMetadataClaim',
      subjectRefs: [workRef(`episode-${i}`)],
      payload: { title: `Episode ${i}` },
      keyPair: issuer,
      issuerSequence: i + 1,
    })
    claims.push(claim)
    await store.ingestClaim(claim.envelope)
  }

  const first = store.scanClaims({ limit: 2 })
  const second = store.scanClaims({ limit: 2, cursor: first.cursor })
  const third = store.scanClaims({ limit: 10, cursor: second.cursor })

  t.alike(first.rows.length, 2)
  t.alike(second.rows.length, 2)
  t.alike(third.rows.length, 1)
  t.alike(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.claimId)).size, 5)
  t.exception(() => store.scanClaims({ limit: 1001 }), /limit/)
})
