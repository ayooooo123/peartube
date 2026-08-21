import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import * as assets from '../src/assets/index.js'
import { encodeCanonical, hashCanonical, sortPlain } from '../src/publisher/canonical.js'
import { createApplicationEnvelope } from '../src/records/application-envelope.js'

const publisher = crypto.keyPair(Buffer.alloc(32, 41))
const publicInfohash = b4a.toString(b4a.alloc(20, 42), 'hex')
const sourceRoot = b4a.toString(b4a.alloc(32, 43), 'hex')

function publication(byte, sequence, title, byteLength) {
  const core = assets.createStaticAssetManifest({
    treeHash: b4a.alloc(32, byte),
    blockLength: Math.ceil(byteLength / assets.ASSET_BLOCK_SIZE),
    byteLength,
  })
  const rendition = assets.createRenditionDescriptor({ purpose: 'original', format: 'video/x-matroska', core })
  const manifest = assets.createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence,
    title,
    renditions: [rendition],
    keyPair: publisher,
  })
  return { core, rendition, manifest }
}

function seasonEntries(first, second) {
  return [
    {
      sourceIndex: 1,
      sourcePath: './Season 01\\Show.S01E02.mkv',
      sourceOffset: first.core.byteLength,
      sourceLength: second.core.byteLength,
      publicationId: second.manifest.publicationId,
      renditionId: second.rendition.renditionId,
      assetId: second.core.assetId,
    },
    {
      sourceIndex: 0,
      sourcePath: 'Season 01//Show.S01E01.mkv',
      sourceOffset: 0,
      sourceLength: first.core.byteLength,
      publicationId: first.manifest.publicationId,
      renditionId: first.rendition.renditionId,
      assetId: first.core.assetId,
    },
  ]
}

function seasonBundle(first, second) {
  return assets.createAssetBundleManifest({
    sourceKind: 'public-torrent',
    sourceName: 'Show Season 01',
    sourceRoot,
    publicInfohash,
    publicTrackerIndependent: true,
    entries: seasonEntries(first, second),
  })
}

test('partial season-pack mappings preserve canonical per-file provenance and independent static assets', (t) => {
  const first = publication(1, 1, 'Episode 1', 300_000)
  const second = publication(2, 2, 'Episode 2', 180_000)
  const bundle = seasonBundle(first, second)
  const replayed = assets.createAssetBundleManifest({
    sourceKind: 'public-torrent',
    sourceName: 'Show Season 01',
    sourceRoot,
    publicInfohash,
    publicTrackerIndependent: true,
    entries: [...seasonEntries(first, second)].reverse(),
  })

  t.is(bundle.bundleId, replayed.bundleId, 'entry order and path separators do not change bundle identity')
  t.is(bundle.entries[0].sourcePath, 'Season 01/Show.S01E01.mkv')
  t.is(bundle.entries[1].sourcePath, 'Season 01/Show.S01E02.mkv')
  t.is(bundle.entries[0].sourceOffset, 0)
  t.is(bundle.entries[0].sourceLength, first.core.byteLength)
  t.is(bundle.sourceName, 'Show Season 01')
  t.is(bundle.sourceRoot, sourceRoot)
  t.is(bundle.publicInfohash, publicInfohash)
  t.is(bundle.publicTrackerIndependent, true)
  t.unlike(bundle.entries[0].assetId, bundle.entries[1].assetId)
  t.unlike(first.core.key, second.core.key)
  t.unlike(first.rendition.renditionId, second.rendition.renditionId)
  t.is(assets.normalizeAssetCoreRefV2(first.core).assetId, bundle.entries[0].assetId)
  t.is(assets.normalizeAssetCoreRefV2(second.core).assetId, bundle.entries[1].assetId)
})

test('bundle entry order is deterministic without host locale collation', (t) => {
  const first = publication(8, 8, 'Episode 8', 80_000)
  const second = publication(9, 9, 'Episode 9', 90_000)
  const bundle = assets.createAssetBundleManifest({
    sourceKind: 'folder',
    entries: [
      {
        sourcePath: 'ä.mkv',
        publicationId: first.manifest.publicationId,
        renditionId: first.rendition.renditionId,
        assetId: first.core.assetId,
      },
      {
        sourcePath: 'z.mkv',
        publicationId: second.manifest.publicationId,
        renditionId: second.rendition.renditionId,
        assetId: second.core.assetId,
      },
    ],
  })

  t.alike(bundle.entries.map(entry => entry.sourcePath), ['z.mkv', 'ä.mkv'])
})

test('signed bundle mappings survive canonical encode, decode, and replay', async (t) => {
  const first = publication(3, 3, 'Episode 3', 90_000)
  const second = publication(4, 4, 'Episode 4', 120_000)
  const bundle = seasonBundle(first, second)
  const signed = assets.signAssetBundleManifest({ manifest: bundle, keyPair: publisher, signedAt: 100 })
  const encoded = assets.encodeAssetBundleManifest(signed)
  const decoded = assets.decodeAssetBundleManifest(encoded)

  t.is(decoded.bundleId, bundle.bundleId)
  t.alike(assets.encodeAssetBundleManifest(decoded), encoded)
  t.ok(await assets.verifyAssetBundleManifest(decoded, { allowedSigners: [publisher.publicKey], now: 101 }))
  t.ok(await assets.verifyAssetBundleManifest(decoded, { allowedSigners: [publisher.publicKey], now: 101 }), 'nonce-free immutable mapping may be replay-verified')
  t.absent(await assets.verifyAssetBundleManifest(decoded, { allowedSigners: [crypto.keyPair(Buffer.alloc(32, 44)).publicKey], now: 101 }))

  const tampered = {
    ...decoded,
    body: {
      ...decoded.body,
      entries: decoded.body.entries.map((entry, index) => index === 0 ? { ...entry, assetId: second.core.assetId } : entry),
    },
  }
  t.exception(() => assets.encodeAssetBundleManifest(tampered), /bundleId|body mismatch/)
})

test('public infohash attestation cannot be bypassed during derivation, signing, or verification', async (t) => {
  const first = publication(10, 10, 'Episode 10', 100_000)
  const second = publication(11, 11, 'Episode 11', 110_000)
  const entries = seasonEntries(first, second)
  const valid = seasonBundle(first, second)
  const { bundleId: ignoredBundleId, publicTrackerIndependent: ignoredAttestation, ...unattestedUnsigned } = valid
  const canonicalUnsigned = sortPlain(unattestedUnsigned)
  const bundleId = b4a.toString(hashCanonical(assets.ASSET_BUNDLE_ID_DOMAIN, canonicalUnsigned), 'hex')
  const body = sortPlain({ bundleId, ...canonicalUnsigned })
  const envelope = createApplicationEnvelope({
    recordType: assets.ASSET_BUNDLE_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: publisher,
    issuedAt: 100,
  })
  const unattested = { bundleId, body, envelope }

  t.exception(() => assets.deriveAssetBundleId({
    sourceKind: 'public-torrent',
    publicInfohash,
    entries,
  }), /attestation/i)
  t.exception(() => assets.signAssetBundleManifest({ manifest: body, keyPair: publisher }), /attestation/i)
  t.absent(await assets.verifyAssetBundleManifest(unattested, { allowedSigners: [publisher.publicKey], now: 101 }))
})

test('publication batches validate mapped publications while sibling mappings remain metadata only', (t) => {
  const first = publication(5, 5, 'Episode 5', 100_000)
  const second = publication(6, 6, 'Episode 6', 110_000)
  const bundle = seasonBundle(first, second)
  const batch = assets.createPublicationBatch({ publisherId: publisher.publicKey, sequence: 5 })

  batch.addPublication({
    publicationId: first.manifest.publicationId,
    manifestId: first.manifest.body.manifestId,
    renditions: first.manifest.body.renditions,
  })
  batch.addBundle(bundle)
  const sealed = batch.seal()
  batch.commit()

  const publications = sealed.entries.filter(entry => entry.kind === 'publication')
  const bundled = sealed.entries.find(entry => entry.kind === 'bundle')
  t.alike(publications.map(entry => entry.publicationId), [first.manifest.publicationId])
  t.is(bundled.entries.length, 2, 'the sibling remains provenance, not publication authority')
  t.absent(sealed.entries.some(entry => entry.kind === 'publication' && entry.publicationId === second.manifest.publicationId))
  t.alike(batch.projectReadable().filter(entry => entry.kind === 'publication').map(entry => entry.publicationId), [first.manifest.publicationId])
  t.alike(Object.keys(bundled.entries[0]).sort(), ['assetId', 'publicationId', 'renditionId', 'sourceIndex', 'sourceLength', 'sourceOffset', 'sourcePath'])

  const mismatched = assets.createPublicationBatch({ publisherId: publisher.publicKey, sequence: 6 })
  mismatched.addPublication({
    publicationId: first.manifest.publicationId,
    manifestId: first.manifest.body.manifestId,
    renditions: first.manifest.body.renditions,
  })
  mismatched.addBundle(assets.createAssetBundleManifest({
    sourceKind: 'folder',
    entries: [{
      sourcePath: 'Show.S01E05.mkv',
      publicationId: first.manifest.publicationId,
      renditionId: first.rendition.renditionId,
      assetId: second.core.assetId,
    }],
  }))
  t.exception(() => mismatched.seal(), /does not match mapped asset/)
})

test('bundle manifests reject private locators, credentials, and unbounded source metadata', (t) => {
  const first = publication(7, 7, 'Episode 7', 130_000)
  const entry = seasonEntries(first, first)[0]
  const base = { sourceKind: 'public-torrent', publicInfohash, publicTrackerIndependent: true, entries: [entry] }
  const forbidden = [
    { sourceKind: 'private-torrent' },
    { publicTrackerIndependent: false },
    { trackerUrls: ['https://tracker.invalid/announce?passkey=secret'] },
    { passkey: 'secret' },
    { cookies: { session: 'secret' } },
    { signedUrl: 'https://cdn.invalid/file?signature=secret' },
    { sourceHeaders: { authorization: 'Bearer secret' } },
    { credentials: { token: 'secret' } },
    { localFilePath: '/private/source.mkv' },
  ]

  for (const extra of forbidden) {
    t.exception(() => assets.createAssetBundleManifest({ ...base, ...extra }), /private|public attestation|sourceKind/i)
  }
  t.exception(() => assets.createAssetBundleManifest({ ...base, entries: [{ ...entry, sourcePath: '../secret.mkv' }] }), /sourcePath/i)
  t.exception(() => assets.createAssetBundleManifest({ ...base, entries: [] }), /entries/i)
  t.exception(() => assets.createAssetBundleManifest({ ...base, sourceName: 'x'.repeat(513) }), /sourceName/i)
  const privatePaths = [
    'C:private\\episode.mkv',
    'C:\\private\\episode.mkv',
    '\\private\\episode.mkv',
    '/private/episode.mkv',
    '//server/share/episode.mkv',
    'https://cdn.invalid/episode.mkv',
    'urn:private:episode',
    'alice@10.0.0.4:season/episode.mkv',
    'alice@host:private/episode.mkv',
    '10.0.0.4:private/episode.mkv',
    '[2001:db8::1]:private/episode.mkv',
    'alice@[2001:db8::1]:private/episode.mkv',
    '1.example:private/episode.mkv',
  ]
  for (const sourcePath of privatePaths) {
    t.exception(() => assets.createAssetBundleManifest({
      ...base,
      entries: [{ ...entry, sourcePath }],
    }), /sourcePath|locator/i)
  }
  const privateNames = [
    'C:private\\season',
    'C:\\private\\season',
    '\\private\\season',
    '/private/season',
    '//server/share',
    'https://tracker.invalid/season',
    'urn:private:season',
    'private/season',
    'alice@10.0.0.4:season',
    'alice@host:season',
    '10.0.0.4:season',
    '[2001:db8::1]:season',
    'alice@[2001:db8::1]:season',
    '1.example:season',
  ]
  for (const sourceName of privateNames) {
    t.exception(() => assets.createAssetBundleManifest({ ...base, sourceName }), /sourceName|locator/i)
  }
  const ordinary = assets.createAssetBundleManifest({
    sourceKind: 'folder',
    sourceName: 'Episode 1: Pilot',
    entries: [{ ...entry, sourcePath: 'Season 01/Episode 1: Pilot.mkv' }],
  })
  t.is(ordinary.sourceName, 'Episode 1: Pilot')
  t.is(ordinary.entries[0].sourcePath, 'Season 01/Episode 1: Pilot.mkv')
})

test('bundle source coordinates reject nonadjacent duplicate paths and all duplicate indexes', (t) => {
  const first = publication(12, 12, 'Episode 12', 120_000)
  const entry = seasonEntries(first, first)[0]
  const mapped = (sourcePath, sourceIndex) => ({ ...entry, sourcePath, sourceIndex })

  t.exception(() => assets.createAssetBundleManifest({
    sourceKind: 'folder',
    entries: [
      mapped('same.mkv', 0),
      mapped('middle.mkv', 1),
      mapped('./same.mkv', 2),
    ],
  }), /distinct source paths/i)
  t.exception(() => assets.createAssetBundleManifest({
    sourceKind: 'folder',
    entries: [
      mapped('first.mkv', 7),
      mapped('second.mkv', 7),
    ],
  }), /distinct source .*indexes/i)

})