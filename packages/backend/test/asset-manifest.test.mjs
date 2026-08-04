import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createPublicationManifest,
  createRenditionDescriptor,
  deriveManifestId,
  derivePublicationId,
  verifyPublicationManifest,
} from '../src/assets/index.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const otherPublisher = crypto.keyPair(Buffer.alloc(32, 2))

function rendition(byte = 3) {
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: { key: hex(byte), length: 12, treeHash: hex(byte + 1), byteLength: 2048 },
  })
}

test('publication manifests derive non-circular manifest and publication ids then sign the outer envelope', async (t) => {
  const body = {
    publisherId: publisher.publicKey,
    sequence: 7,
    title: 'Pilot',
    renditions: [rendition()],
    claims: [{ claimId: hex(9), role: 'work' }],
    provenance: [{ type: 'upload', source: 'camera-roll' }],
  }
  const manifest = createPublicationManifest({ ...body, keyPair: publisher, signedAt: 100 })

  t.alike(manifest.body.manifestId, deriveManifestId(manifest.body))
  t.alike(manifest.publicationId, derivePublicationId({ publisherId: publisher.publicKey, manifestId: manifest.body.manifestId }))
  t.absent(JSON.stringify(manifest.body.unsignedBody).includes(manifest.publicationId))
  t.absent(JSON.stringify(manifest.body.unsignedBody).includes(Buffer.from(manifest.envelope.signature).toString('hex')))
  t.ok(await verifyPublicationManifest(manifest, { allowedSigners: [publisher.publicKey], now: 101 }))
})

test('publication id changes by publisher while exact rendition identity is reused', (t) => {
  const shared = rendition(5)
  const a = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 1, title: 'A', renditions: [shared], keyPair: publisher })
  const b = createPublicationManifest({ publisherId: otherPublisher.publicKey, sequence: 1, title: 'B', renditions: [shared], keyPair: otherPublisher })

  t.alike(a.body.renditions[0].renditionId, b.body.renditions[0].renditionId)
  t.unlike(a.publicationId, b.publicationId)
})

test('corrected releases create new manifests scoped to previous manifest references', (t) => {
  const first = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 1, title: 'Pilot', renditions: [rendition(7)], keyPair: publisher })
  const corrected = createPublicationManifest({ publisherId: publisher.publicKey, sequence: 2, title: 'Pilot fixed', previousManifestId: first.body.manifestId, renditions: [rendition(7)], keyPair: publisher })

  t.unlike(first.body.manifestId, corrected.body.manifestId)
  t.alike(corrected.body.previousManifestId, first.body.manifestId)
  t.exception(() => createPublicationManifest({ publisherId: publisher.publicKey, sequence: 3, title: 'bad', previousManifestId: 'abc', renditions: [rendition()], keyPair: publisher }), /previousManifestId/)
})
