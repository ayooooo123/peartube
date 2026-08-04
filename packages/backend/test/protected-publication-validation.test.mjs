import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createProtectedRendition,
  protectedRenditionDigest,
  verifyProtectedRendition,
} from '../src/access/protected-rendition.js'
import {
  MANIFEST_RECORD_TYPE,
  createPublicationManifest,
  createRenditionDescriptor,
  decodePublicationManifest,
  deriveRenditionId,
  encodePublicationManifest,
  isProtectedRendition,
  validateProtectedPublication,
  verifyPublicationManifest,
} from '../src/assets/index.js'
import { encodeCanonical } from '../src/publisher/canonical.js'
import { createApplicationEnvelope, encodeApplicationEnvelope } from '../src/records/application-envelope.js'

// Where the protected-publication rule lives, and why it is not where the plan
// said it would be: there is no `src/content-publication.js` in this layout.
// The rule is `validateProtectedPublication` in `src/assets/media-validation.js`,
// invoked from manifest normalization in `src/assets/manifest.js`. Every path
// that mints or re-derives a manifest funnels through that normalization —
// `src/upload.js`, `src/migrations/publication-v1.js`,
// `src/assets/rendition-writer.js`, and decoding a peer's bytes in
// `src/media-graph/catalog-projection.js` — so none of them can route around
// it, and none of them passes `allowClearKeyForTests`.

function hex(byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

const publisher = crypto.keyPair(b4a.alloc(32, 1))
const KEY_ID = 'a1'.repeat(16)
const INIT_DATA = b4a.toString(b4a.alloc(64, 7), 'base64')

function drm(overrides = {}) {
  return {
    scheme: 'cenc',
    drmSystem: 'widevine',
    keyId: KEY_ID,
    initData: INIT_DATA,
    licenseEndpoint: 'https://license.example.com/widevine',
    certificateUrl: 'https://certs.example.com/widevine.cer',
    issuer: 'example-provider',
    entitlementId: 'ent-2026-08',
    ...overrides,
  }
}

function core(byte = 3) {
  return { key: hex(byte), length: 12, treeHash: hex(byte + 1), byteLength: 2048 }
}

function protectedRendition(overrides = {}, options = {}) {
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: core(),
    encryption: drm(overrides),
  }, options)
}

function publicRendition(byte = 5) {
  return createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core: core(byte) })
}

function poster(byte = 11, extra = {}) {
  return { purpose: 'poster', format: 'image/jpeg', core: core(byte), ...extra }
}

function publish(renditions, input = {}, options = {}) {
  return createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 4,
    title: 'Protected Title',
    renditions,
    keyPair: publisher,
    signedAt: 1000,
    ...input,
  }, options)
}

test('a protected publication round-trips through create, encode, decode and verify', async (t) => {
  const rendition = protectedRendition()
  const manifest = publish([rendition])
  const stored = manifest.body.renditions[0]

  t.ok(isProtectedRendition(stored))
  // The descriptor is shaped exactly like `@peartube/media-drm-descriptor`, so
  // the manifest and the wire never disagree about what a player is told.
  t.alike(Object.keys(stored.encryption).sort(), [
    'certificateUrl',
    'drmSystem',
    'entitlementId',
    'initData',
    'issuer',
    'keyId',
    'licenseEndpoint',
    'scheme',
    'version',
  ])
  t.is(stored.encryption.keyId, KEY_ID)
  t.is(stored.encryption.drmSystem, 'widevine')
  t.ok(verifyProtectedRendition(stored.encryption))

  // Protection is what the source advertises for the whole publication, which
  // is why the rule answers with exactly the two fields the wire carries.
  t.alike(validateProtectedPublication(manifest.body.unsignedBody), { protected: true, drmSystem: 'widevine' })

  const encoded = encodePublicationManifest(manifest)
  const decoded = decodePublicationManifest(encoded)
  t.alike(decoded.body, manifest.body)
  t.is(decoded.body.renditions[0].renditionId, rendition.renditionId)
  t.ok(await verifyPublicationManifest(manifest, { allowedSigners: [publisher.publicKey], now: 1001 }))

  // Ciphertext is cacheable without an entitlement: the manifest names a
  // licence service and a key IDENTIFIER, and nothing that could decrypt.
  const wire = b4a.toString(encoded, 'utf8')
  t.ok(wire.includes(KEY_ID))
  t.ok(wire.includes('https://license.example.com/widevine'))
  for (const forbidden of ['contentKey', 'licenseResponse', 'bearer', 'password', 'secret', 'providerToken']) {
    t.absent(wire.includes(forbidden), `${forbidden} must never reach a signed manifest`)
  }
})

test('every protected field is part of the rendition identity', (t) => {
  const baseline = protectedRendition()
  const tampers = {
    keyId: 'b2'.repeat(16),
    initData: b4a.toString(b4a.alloc(64, 9), 'base64'),
    scheme: 'cbcs',
    licenseEndpoint: 'https://license.attacker.example/widevine',
    issuer: 'attacker-provider',
  }

  for (const [field, value] of Object.entries(tampers)) {
    t.unlike(
      deriveRenditionId({ purpose: 'original', format: 'video/mp4', core: core(), encryption: drm({ [field]: value }) }),
      baseline.renditionId,
      `${field} must change the rendition identity`,
    )
    t.unlike(
      protectedRenditionDigest(createProtectedRendition(drm({ [field]: value }))),
      protectedRenditionDigest(baseline.encryption),
      `${field} must change the descriptor digest`,
    )
  }
})

test('editing a protected descriptor invalidates the signed manifest', async (t) => {
  const manifest = publish([protectedRendition()])
  const tampers = {
    keyId: 'b2'.repeat(16),
    initData: b4a.toString(b4a.alloc(64, 9), 'base64'),
    scheme: 'cbcs',
    licenseEndpoint: 'https://license.attacker.example/widevine',
    issuer: 'attacker-provider',
  }

  for (const [field, value] of Object.entries(tampers)) {
    const body = JSON.parse(JSON.stringify(manifest.body))
    body.unsignedBody.renditions[0].encryption[field] = value
    body.renditions[0].encryption[field] = value
    t.absent(
      await verifyPublicationManifest({ ...manifest, body }, { allowedSigners: [publisher.publicKey], now: 1001 }),
      `${field} must invalidate the manifest`,
    )
  }
})

test('a publisher who re-signs an edited descriptor cannot keep the rendition id', (t) => {
  const manifest = publish([protectedRendition()])
  const body = JSON.parse(JSON.stringify(manifest.body))
  body.unsignedBody.renditions[0].encryption.keyId = 'b2'.repeat(16)
  body.renditions[0].encryption.keyId = 'b2'.repeat(16)
  const envelope = createApplicationEnvelope({
    recordType: MANIFEST_RECORD_TYPE,
    body: encodeCanonical(body),
    keyPair: publisher,
    issuedAt: 1000,
  })

  // The signature is valid; the record is still not a manifest, because the
  // rendition id stored beside the descriptor no longer derives from it.
  t.exception(() => decodePublicationManifest(encodeApplicationEnvelope(envelope)), /noncanonical/)
})

test('ClearKey is publishable only through an explicitly injected test capability', (t) => {
  const clearKey = drm({ drmSystem: 'clearkey', certificateUrl: null })
  const input = { purpose: 'original', format: 'video/mp4', core: core(), encryption: clearKey }

  t.exception(() => createRenditionDescriptor(input), /drmSystem/)
  t.exception(() => publish([input]), /drmSystem/)

  const capability = { allowClearKeyForTests: true }
  const fixture = publish([input], {}, capability)
  t.is(fixture.body.renditions[0].encryption.drmSystem, 'clearkey')

  // A deterministic fixture stays a fixture: once encoded, the production
  // decode path refuses it, so a dev manifest cannot be replicated into a
  // consumer that has no ClearKey capability.
  const encoded = encodePublicationManifest(fixture)
  t.exception(() => decodePublicationManifest(encoded), /drmSystem/)
  t.is(decodePublicationManifest(encoded, capability).body.manifestId, fixture.body.manifestId)

  // The capability is an argument, never a field of the publication input.
  t.exception(() => publish([input], { allowClearKeyForTests: true }), /drmSystem/)
})

test('a malformed or key-bearing protected descriptor is refused at publication time', (t) => {
  const rendition = encryption => ({ purpose: 'original', format: 'video/mp4', core: core(), encryption })

  t.exception(() => publish([rendition({})]), /scheme/)
  t.exception(() => publish([rendition(drm({ scheme: 'aes-ctr' }))]), /scheme/)
  t.exception(() => publish([rendition(drm({ drmSystem: 'nagra' }))]), /drmSystem/)
  t.exception(() => publish([rendition(drm({ keyId: 'not-hex' }))]), /keyId/)
  t.exception(() => publish([rendition(drm({ initData: 'not base64!' }))]), /initData/)
  t.exception(() => publish([rendition(drm({ licenseEndpoint: 'http://license.example.com/wv' }))]), /licenseEndpoint/)
  t.exception(() => publish([rendition(drm({ licenseEndpoint: 'https://user:pw@license.example.com/wv' }))]), /licenseEndpoint/)
  t.exception(() => publish([rendition(drm({ issuer: '' }))]), /issuer/)
  t.exception(() => publish([rendition(true)]), /object/)

  // The by-construction half of the key boundary: a property SHAPED like key
  // material is refused before anything is hashed or signed, so it cannot
  // reach the manifest, storage, or a peer even by accident.
  t.exception(() => publish([rendition({ ...drm(), contentKey: 'aa'.repeat(16) })]), /contentKey/)
  t.exception(() => publish([rendition({ ...drm(), providerToken: 'abc' })]), /providerToken/)
})

// Do not loosen these two checks. `@peartube/media-publication-source` carries
// ONE `protected` bool and ONE `drmSystem` for the whole source, so a
// publication whose media renditions disagree has no honest representation on
// the wire: it would either offer a licence for bytes that need none or none
// for bytes that do. And a protected title has to stay browsable without an
// entitlement, which it only does while its cover art and subtitles are
// reachable by anyone — encrypt those and the catalog renders blank for every
// viewer, entitled or not.
test('a publication describes one protection status and one drm system', (t) => {
  t.exception(() => publish([protectedRendition(), publicRendition(21)]), /mix protected and public/)
  t.exception(
    () => publish([protectedRendition(), protectedRendition({ drmSystem: 'playready', keyId: 'c3'.repeat(16) })]),
    /one drm system/,
  )

  // Cover art and subtitles are the publicly reachable half of a protected
  // title, so they can never be protected themselves.
  t.exception(() => publish([protectedRendition(), poster(11, { encryption: drm() })]), /must not be protected/)
  t.exception(
    () => publish([protectedRendition()], { artwork: [poster(13, { encryption: drm() })] }),
    /must not be protected/,
  )
  t.exception(
    () => publish([protectedRendition()], {
      subtitles: [{ purpose: 'subtitle', format: 'text/vtt', core: core(15), encryption: drm() }],
    }),
    /must not be protected/,
  )

  // Artwork alongside protected media is the normal shape and stays allowed.
  const manifest = publish([protectedRendition(), poster()])
  t.alike(validateProtectedPublication(manifest.body.unsignedBody), { protected: true, drmSystem: 'widevine' })
})

test('a public publication is untouched by protection', async (t) => {
  const manifest = publish([publicRendition(), poster()], { title: 'Public Title' })

  for (const rendition of manifest.body.renditions) {
    t.absent(Object.hasOwn(rendition, 'encryption'))
    t.absent(isProtectedRendition(rendition))
  }
  t.alike(validateProtectedPublication(manifest.body.unsignedBody), { protected: false, drmSystem: null })
  t.absent(b4a.toString(encodePublicationManifest(manifest), 'utf8').includes('encryption'))
  t.alike(decodePublicationManifest(encodePublicationManifest(manifest)).body, manifest.body)
  t.ok(await verifyPublicationManifest(manifest, { allowedSigners: [publisher.publicKey], now: 1001 }))
})

test('the legacy migration shape cannot smuggle protection into a publication', (t) => {
  // `migrations/publication-v1.js` builds its rendition from named fields of a
  // legacy video record, so a record that carries DRM cannot leak it.
  const legacyVideo = {
    id: 'legacy-1',
    title: 'Legacy',
    mimeType: 'video/mp4',
    encryption: drm({ drmSystem: 'clearkey', certificateUrl: null }),
  }
  const migrated = publish([{
    purpose: 'original',
    format: legacyVideo.mimeType,
    core: core(),
  }], { title: legacyVideo.title })
  t.absent(Object.hasOwn(migrated.body.renditions[0], 'encryption'))

  // And had the whole record been forwarded, the production constructor the
  // migration uses would refuse it rather than publish it.
  t.exception(
    () => publish([{ purpose: 'original', format: legacyVideo.mimeType, core: core(), ...legacyVideo }]),
    /drmSystem/,
  )
})
