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
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: id })
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
