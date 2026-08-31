import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import * as assets from '../src/assets/index.js'
import {
  MANIFEST_ID_DOMAIN,
  MANIFEST_RECORD_TYPE,
  PUBLICATION_ID_DOMAIN,
  RENDITION_ID_DOMAIN,
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  deriveManifestId,
  derivePublicationId,
  verifyPublicationManifest,
} from '../src/assets/index.js'
import { encodeCanonical, hashCanonical, sortPlain } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

const publisher = crypto.keyPair(Buffer.alloc(32, 1))
const otherPublisher = crypto.keyPair(Buffer.alloc(32, 2))

function assetRef(byte = 3, byteLength = 300000) {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, byte),
    blockLength: Math.ceil(byteLength / (256 * 1024)),
    byteLength,
  })
  return {
    kind: descriptor.kind,
    key: descriptor.key,
    treeHash: descriptor.treeHash,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    blockSize: descriptor.blockSize,
    assetId: descriptor.assetId,
  }
}

function rawId(domain, value) {
  return b4a.toString(hashCanonical(domain, value), 'hex')
}

function createRawPublicationManifest(core) {
  const publisherId = b4a.toString(publisher.publicKey, 'hex')
  const unsignedRendition = sortPlain({
    version: 2,
    purpose: 'original',
    format: 'video/mp4',
    core,
    segmentIndex: null,
  })
  const fullRendition = sortPlain({
    ...unsignedRendition,
    renditionId: rawId(RENDITION_ID_DOMAIN, unsignedRendition),
  })
  const unsignedBody = sortPlain({
    version: 2,
    publisherId,
    sequence: 1,
    title: 'Tampered',
    sourceFileName: null,
    description: null,
    previousManifestId: null,
    renditions: [fullRendition],
    artwork: [],
    subtitles: [],
    claims: [],
    provenance: [],
  })
  const manifestId = rawId(MANIFEST_ID_DOMAIN, unsignedBody)
  const body = sortPlain({ manifestId, unsignedBody, ...unsignedBody })
  const envelope = createApplicationEnvelope({
    recordType: MANIFEST_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: publisher,
  })
  return {
    publicationId: rawId(PUBLICATION_ID_DOMAIN, { publisherId, manifestId }),
    body,
    envelope,
  }
}

function rendition(byte = 3) {
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: assetRef(byte),
  })
}

test('v2 asset core references canonicalize Plan 01 descriptors and reject malformed identities', (t) => {
  const input = assetRef(3)
  const core = assets.normalizeAssetCoreRefV2(input)

  t.is(core.key, input.assetId)
  t.is(core.assetId, input.assetId)
  t.is(core.treeHash, b4a.toString(input.treeHash, 'hex'))
  t.ok(Object.isFrozen(core))
  t.exception(() => assets.normalizeAssetCoreRefV2({ ...input, assetId: hex(99) }), /assetId/i)
  t.exception(() => assets.normalizeAssetCoreRefV2({ ...input, length: 1, byteLength: 262145 }), /canonical blocks/i)
  t.exception(() => assets.normalizeAssetCoreRefV2({ ...input, blockSize: 1024 }), /canonical blocks/i)
})

test('manifest verification rejects signed descriptors whose static manifest key or tree root does not reconstruct', async (t) => {
  const core = {
    ...assets.normalizeAssetCoreRefV2(assetRef(5)),
  }
  const valid = createRawPublicationManifest(core)
  const wrongKey = hex(90)
  const keyMismatch = createRawPublicationManifest({ ...core, key: wrongKey, assetId: wrongKey })
  const treeMismatch = createRawPublicationManifest({ ...core, treeHash: hex(91) })

  t.ok(await verifyPublicationManifest(valid, { allowedSigners: [publisher.publicKey] }))
  t.absent(await verifyPublicationManifest(keyMismatch, { allowedSigners: [publisher.publicKey] }))
  t.absent(await verifyPublicationManifest(treeMismatch, { allowedSigners: [publisher.publicKey] }))
})

test('legacy asset references require re-ingestion when identifiable and quarantine otherwise', async (t) => {
  const { classifyLegacyAssetReference } = await import('../src/migrations/asset-core-v2.js')

  t.is(classifyLegacyAssetReference({ key: hex(1), start: 4, end: 9 }), 'reingest-required')
  t.is(classifyLegacyAssetReference({ key: hex(1), localFilePath: '/tmp/video.mp4' }), 'reingest-required')
  t.is(classifyLegacyAssetReference({ key: hex(1) }), 'quarantine')
  t.is(classifyLegacyAssetReference({ key: 'invalid', start: true, end: 2 }), 'quarantine')
  t.is(classifyLegacyAssetReference({ key: hex(1), start: '4', end: 9 }), 'quarantine')
  t.is(classifyLegacyAssetReference({ key: hex(1), start: 4, end: Infinity }), 'quarantine')
})

test('publication manifests derive non-circular manifest and publication ids then sign the outer envelope', async (t) => {
  const body = {
    publisherId: publisher.publicKey,
    sequence: 7,
    title: 'Pilot',
    sourceFileName: 'Pilot.2026.1080p.WEB-DL.mkv',
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
  t.is(manifest.body.version, 2)
  t.is(manifest.body.sourceFileName, 'Pilot.2026.1080p.WEB-DL.mkv')
  t.exception(() => createPublicationManifest({ ...body, sourceFileName: '/private/Pilot.mkv', keyPair: publisher }), /sourceFileName/)
  t.is(manifest.body.renditions[0].version, 2)
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
