import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createPublicationBatch } from '../src/assets/publication-batch.js'
import { createRenditionDescriptor, createStaticAssetManifest } from '../src/assets/index.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

const publisher = crypto.keyPair(Buffer.alloc(32, 1))

function rendition(byte) {
  const core = createStaticAssetManifest({
    treeHash: b4a.alloc(32, byte),
    blockLength: 1,
    byteLength: 100,
  })
  return createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core })
}

test('publication batch seals child publications, typed claims, bounded pages, and one catalog digest', (t) => {
  const batch = createPublicationBatch({ publisherId: publisher.publicKey, sequence: 1, pageSize: 2 })
  const first = batch.addPublication({ publicationId: hex(10), manifestId: hex(11), renditions: [rendition(12)] })
  const second = batch.addPublication({ publicationId: hex(20), manifestId: hex(21), renditions: [rendition(22)] })
  const claim = batch.addClaim({ claimType: 'CollectionMembershipClaim', claimId: hex(30), subjectRefs: ['collection-1'], payload: { member: first.publicationId } })
  const sealed = batch.seal()

  t.alike(sealed.entries.length, 3)
  t.alike(sealed.pages.length, 2)
  t.alike(sealed.catalogCommit.batchDigest, sealed.digest)
  t.alike(claim.claimType, 'CollectionMembershipClaim')
  t.exception(() => batch.addPublication({ publicationId: hex(40), manifestId: hex(41), renditions: [rendition(42)] }), /sealed/)
})

test('publication batch rejects legacy writable-range rendition shapes', (t) => {
  const batch = createPublicationBatch({ publisherId: publisher.publicKey, sequence: 3 })
  t.exception(() => batch.addPublication({
    publicationId: hex(60),
    manifestId: hex(61),
    renditions: [{
      version: 1,
      renditionId: hex(62),
      purpose: 'original',
      format: 'video/mp4',
      core: {
        key: hex(63),
        length: 2,
        treeHash: hex(64),
        byteLength: 100,
      },
      range: { start: 1, end: 2 },
    }],
  }), /static asset core reference required/)
})

test('publication batch readers project zero before seal and all after commit, never half imports', (t) => {
  const batch = createPublicationBatch({ publisherId: publisher.publicKey, sequence: 2, pageSize: 10 })
  batch.addPublication({ publicationId: hex(50), manifestId: hex(51), renditions: [rendition(52)] })

  t.alike(batch.projectReadable({ phase: 'before-seal' }), [])
  const sealed = batch.seal()
  t.alike(batch.projectReadable({ phase: 'before-commit' }), [])
  batch.commit()
  t.alike(batch.projectReadable().map(entry => entry.publicationId), sealed.entries.filter(entry => entry.kind === 'publication').map(entry => entry.publicationId))
})
