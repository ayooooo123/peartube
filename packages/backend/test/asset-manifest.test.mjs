import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createPublicationManifest,
  createRenditionDescriptor,
  decodePublicationManifest,
  deriveManifestId,
  derivePublicationId,
  encodePublicationManifest,
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

// Renditions can now carry a protected-media `encryption` descriptor. These
// values were derived BEFORE that field existed and are pinned here because a
// public publication has to stay bit-identical: the canonical encoder preserves
// explicit nulls, so a rendition that grew an `encryption: null` key would move
// every id in this table and invalidate every manifest already signed on disk.
test('public publications keep their pre-protection identity byte for byte', async (t) => {
  const original = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: { key: hex(3), length: 12, treeHash: hex(4), byteLength: 2048 },
  })
  t.is(original.renditionId, 'bcc6bf8e8aaccaeeadc0b9f235a95959bbb91bfc382ff162c0fe67805c0b18dc')
  t.absent(Object.hasOwn(original, 'encryption'))

  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 7,
    title: 'Pilot',
    description: 'Public vector',
    renditions: [original],
    claims: [{ claimId: hex(9), role: 'work' }],
    provenance: [{ type: 'upload', source: 'camera-roll' }],
    keyPair: publisher,
    signedAt: 100,
  })
  t.is(manifest.body.manifestId, 'b4f8decb9aa68daf749967cb8b11593684bdcb4f875757ba961d8ea0fbfec555')
  t.is(manifest.publicationId, 'dc519915abfee791acabcb99e9471cc89b0516df6f9bc5484f38b031ecd7b01c')

  const encoded = encodePublicationManifest(manifest)
  t.is(b4a.toString(crypto.hash(encoded), 'hex'), '2027b294da7fb46bef4613eb4ce484a08681aec08586097264b76573022eb35c')
  t.absent(JSON.stringify(manifest.body).includes('encryption'))
  t.alike(decodePublicationManifest(encoded).body, manifest.body)
  t.ok(await verifyPublicationManifest(manifest, { allowedSigners: [publisher.publicKey], now: 101 }))
})
