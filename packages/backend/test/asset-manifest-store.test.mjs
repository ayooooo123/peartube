import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createAssetManifestStore,
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
} from '../src/assets/index.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const otherPublisher = crypto.keyPair(Buffer.alloc(32, 2))

function assetRef(byte = 3, byteLength = 300000) {
  return createStaticAssetManifest({
    treeHash: b4a.alloc(32, byte),
    blockLength: Math.ceil(byteLength / (256 * 1024)),
    byteLength,
  })
}

function rendition(byte = 3, purpose = 'original') {
  return createRenditionDescriptor({
    purpose,
    format: 'video/mp4',
    core: assetRef(byte),
  })
}

test('manifest store indexes by publication, publisher sequence, rendition, and current head', async (t) => {
  const store = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const first = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 1, title: 'Pilot', renditions: [rendition(3)], keyPair: publisher })
  const second = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 2, title: 'Pilot fixed', previousManifestId: first.body.manifestId, renditions: [rendition(3)], keyPair: publisher })

  t.alike(await store.ingestManifest(first), { status: 'accepted', publicationId: first.publicationId })
  t.alike(await store.ingestManifest(first), { status: 'duplicate', publicationId: first.publicationId })
  t.alike(await store.ingestManifest(second), { status: 'accepted', publicationId: second.publicationId })

  t.alike(store.getManifest(first.publicationId).body.sequence, 1)
  t.alike(store.getManifestByPublisherSequence(Buffer.from(publisher.publicKey).toString('hex'), 2).publicationId, second.publicationId)
  t.alike(store.getManifestsByRendition(rendition(3).renditionId).map(row => row.publicationId), [first.publicationId, second.publicationId])
  t.alike(store.getCurrentPublisherHead(Buffer.from(publisher.publicKey).toString('hex')).publicationId, second.publicationId)
  t.alike(store.getSupersedingManifests(first.body.manifestId).map(row => row.publicationId), [second.publicationId])
})

test('manifest store deduplicates asset references per publication without conflating publishers', async (t) => {
  const store = createAssetManifestStore({ trustedSigners: [publisher.publicKey, otherPublisher.publicKey] })
  const shared = assetRef(8)
  const first = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'First',
    renditions: [
      createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: shared }),
      createRenditionDescriptor({ purpose: 'preview', format: 'video/mp4', core: shared }),
    ],
    keyPair: publisher,
  })
  const second = createPublicationManifest({
    publisherId: otherPublisher.publicKey,
    sequence: 1,
    title: 'Second',
    renditions: [createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: shared })],
    keyPair: otherPublisher,
  })

  await store.ingestManifest(first)
  await store.ingestManifest(second)

  const rows = store.getManifestsByAssetId(shared.assetId)
  t.alike(rows.map(row => row.publicationId), [first.publicationId, second.publicationId])
  t.alike(rows.map(row => row.body.publisherId), [
    b4a.toString(publisher.publicKey, 'hex'),
    b4a.toString(otherPublisher.publicKey, 'hex'),
  ])
})

test('manifest store rejects conflicting bytes and untrusted publishers while preserving reusable renditions', async (t) => {
  const store = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const manifest = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 1, title: 'Pilot', renditions: [rendition(9)], keyPair: publisher })
  const untrusted = createPublicationManifest({ publisherId: otherPublisher.publicKey, sequence: 1, title: 'Other', renditions: [rendition(9)], keyPair: otherPublisher })

  await store.ingestManifest(manifest)
  const conflicting = { ...manifest, body: { ...manifest.body, title: 'tampered' } }

  t.alike(await store.ingestManifest(conflicting), { status: 'conflict', publicationId: manifest.publicationId })
  t.alike(await store.ingestManifest(untrusted), { status: 'quarantined' })
  t.alike(store.getManifestsByRendition(rendition(9).renditionId).map(row => row.publicationId), [manifest.publicationId])
})
