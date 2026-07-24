import test from 'brittle'
import crypto from 'hypercore-crypto'

import {
  createEntityReference,
  createMediaClaim,
} from '../src/media-graph/index.js'
import { createMediaGraphStore } from '../src/media-graph/store.js'
import { resolveMediaEntity } from '../src/media-graph/resolver.js'

const curator = crypto.keyPair(Buffer.alloc(32, 1))
const publisherA = crypto.keyPair(Buffer.alloc(32, 2))
const publisherB = crypto.keyPair(Buffer.alloc(32, 3))

function workRef(id) {
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: id })
}

function nativeWork(id, issuer = publisherA.publicKey) {
  return createEntityReference({ entityKind: 'work', namespace: 'issuer-native', issuerRootKey: issuer, issuerLocalId: id })
}

test('resolver produces deterministic projections from accepted metadata claims', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [publisherA.publicKey, publisherB.publicKey] })
  const subject = workRef('episode-1')
  await store.ingestClaim(createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Pilot B' }, confidence: 700, keyPair: publisherB }).envelope)
  await store.ingestClaim(createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Pilot A' }, confidence: 900, keyPair: publisherA }).envelope)

  const resolved = resolveMediaEntity(store, subject.entityId, {
    trust: { [Buffer.from(publisherA.publicKey).toString('hex')]: 10, [Buffer.from(publisherB.publicKey).toString('hex')]: 10 },
  })

  t.alike(resolved.entityId, subject.entityId)
  t.alike(resolved.metadata.title, 'Pilot A')
  t.alike(resolved.claims.length, 2)
})

test('resolver applies trusted equivalence claims without serializing local cluster ids as global truth', async (t) => {
  const store = createMediaGraphStore({ trustedSigners: [curator.publicKey, publisherA.publicKey] })
  const external = workRef('episode-1')
  const native = nativeWork('local-episode-1')
  await store.ingestClaim(createMediaClaim({ claimType: 'EquivalentEntityClaim', subjectRefs: [external, native], payload: { relation: 'same-work' }, keyPair: curator }).envelope)
  await store.ingestClaim(createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [native], payload: { title: 'Native Pilot' }, confidence: 800, keyPair: publisherA }).envelope)

  const resolved = resolveMediaEntity(store, external.entityId, { trust: { [Buffer.from(curator.publicKey).toString('hex')]: 100 } })

  t.ok(resolved.localClusterId.startsWith('local:'))
  t.absent(resolved.globalClusterId)
  t.alike(resolved.members.sort(), [external.entityId, native.entityId].sort())
  t.alike(resolved.metadata.title, 'Native Pilot')
})
