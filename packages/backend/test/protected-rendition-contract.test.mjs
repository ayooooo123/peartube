import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  MAX_DRM_INIT_DATA_BYTES,
  MAX_DRM_INIT_DATA_CHARS,
  MAX_DRM_ISSUER_CHARS,
  MAX_DRM_KEY_ID_CHARS,
  MAX_DRM_URL_CHARS,
  MAX_DRM_URL_QUERY_VALUE_CHARS,
  PROTECTED_DRM_SYSTEMS,
  PROTECTED_RENDITION_FIELDS,
  PROTECTION_SCHEMES,
  PUBLIC_DRM_PROPERTY_NAMES,
  SECRET_SHAPED_PROPERTY_TOKENS,
  TEST_ONLY_DRM_SYSTEMS,
  createProtectedRendition,
  findSecretShapedProperty,
  protectedRenditionDigest,
  verifyProtectedRendition,
} from '../src/access/protected-rendition.js'
import {
  MAX_ENTITLEMENT_REDIRECT_ORIGINS,
  createEntitlementDescriptor,
  decodeEntitlementDescriptor,
  encodeEntitlementDescriptor,
  verifyEntitlementDescriptor,
} from '../src/access/entitlement-descriptor.js'

const KEY_ID = '0123456789abcdef0123456789abcdef'
const LICENSE_ENDPOINT = 'https://license.example.com/acquire'
const ISSUER = 'https://provider.example.com'

function base64(text) {
  return b4a.toString(b4a.from(text), 'base64')
}

function protectedInput(overrides = {}) {
  return {
    scheme: 'cenc',
    drmSystem: 'widevine',
    keyId: KEY_ID,
    initData: base64('pssh-fixture-widevine'),
    licenseEndpoint: LICENSE_ENDPOINT,
    issuer: ISSUER,
    entitlementId: 'provider:tier-1',
    ...overrides,
  }
}

// Pinned canonical vectors. These digests are the rendition identity a signed
// manifest commits to, so they must be identical on Node and Bare and must not
// drift without a version bump.
const VECTORS = [
  {
    drmSystem: 'widevine',
    scheme: 'cenc',
    initData: 'cHNzaC1maXh0dXJlLXdpZGV2aW5l',
    certificateUrl: null,
    digest: '87bfe3fda8457414099414e2d2e5cbd4b4eb1122e514e9a7fecdd2c0f0cc3174',
  },
  {
    drmSystem: 'fairplay',
    scheme: 'cbcs',
    initData: 'cHNzaC1maXh0dXJlLWZhaXJwbGF5',
    certificateUrl: 'https://license.example.com/fps/cert',
    digest: 'd318b7d36beff7a8e86ba8e434c18ea8216d45efe906a178576d39820b1425e4',
  },
  {
    drmSystem: 'playready',
    scheme: 'cenc',
    initData: 'cHNzaC1maXh0dXJlLXBsYXlyZWFkeQ==',
    certificateUrl: null,
    digest: '2b226d0e0495c82249e80a3b869a9a5b27282eab4ffe43d2df5b6e7499b050ef',
  },
]

test('production drm systems produce pinned canonical public descriptors', (t) => {
  t.alike([...PROTECTED_DRM_SYSTEMS], ['widevine', 'fairplay', 'playready'])
  t.alike([...TEST_ONLY_DRM_SYSTEMS], ['clearkey'])
  t.alike([...PROTECTION_SCHEMES], ['cenc', 'cbcs'])
  t.is(MAX_DRM_INIT_DATA_BYTES, 4096)
  t.is(VECTORS.length, PROTECTED_DRM_SYSTEMS.length)

  for (const vector of VECTORS) {
    const descriptor = createProtectedRendition(protectedInput({
      scheme: vector.scheme,
      drmSystem: vector.drmSystem,
      initData: vector.initData,
      certificateUrl: vector.certificateUrl,
    }))

    t.alike(descriptor, {
      version: 1,
      scheme: vector.scheme,
      drmSystem: vector.drmSystem,
      keyId: KEY_ID,
      initData: vector.initData,
      licenseEndpoint: LICENSE_ENDPOINT,
      certificateUrl: vector.certificateUrl,
      issuer: ISSUER,
      entitlementId: 'provider:tier-1',
    })
    t.alike(Object.keys(descriptor), [...PROTECTED_RENDITION_FIELDS])
    t.ok(Object.isFrozen(descriptor))
    t.is(protectedRenditionDigest(descriptor), vector.digest)
    t.ok(verifyProtectedRendition(descriptor))
  }
})

test('absent optional fields are explicit nulls so canonical encoding is stable', (t) => {
  const descriptor = createProtectedRendition({
    scheme: 'cenc',
    drmSystem: 'widevine',
    keyId: 'abcdef0123456789abcdef0123456789',
    licenseEndpoint: LICENSE_ENDPOINT,
    issuer: 'provider.example.com',
  })

  t.is(descriptor.initData, null)
  t.is(descriptor.certificateUrl, null)
  t.is(descriptor.entitlementId, null)
  t.is(protectedRenditionDigest(descriptor), 'fe5a0c5d05f8b3a95b0372a2ae63c28fd228e303155a09b36e340fa58188cad3')
  t.ok(verifyProtectedRendition(descriptor))
})

test('clearkey is refused without the injected test capability and accepted with it', (t) => {
  const input = protectedInput({ drmSystem: 'clearkey', initData: base64('pssh-fixture-clearkey') })

  t.exception(() => createProtectedRendition(input), /drmSystem "clearkey" is not supported/)
  t.absent(verifyProtectedRendition({ ...createProtectedRendition(input, { allowClearKeyForTests: true }) }))

  const descriptor = createProtectedRendition(input, { allowClearKeyForTests: true })
  t.is(descriptor.drmSystem, 'clearkey')
  t.ok(verifyProtectedRendition(descriptor, { allowClearKeyForTests: true }))
})

test('malformed protected renditions are refused field by field', (t) => {
  const cases = [
    ['unknown scheme', { scheme: 'cbc1' }, /scheme "cbc1" is not supported/],
    ['missing scheme', { scheme: undefined }, /scheme must be a string/],
    ['unknown drm system', { drmSystem: 'nagra' }, /drmSystem "nagra" is not supported/],
    ['non-hex key id', { keyId: 'zzzzzzzz' }, /keyId must be an even-length hex identifier/],
    ['odd-length key id', { keyId: 'abc' }, /keyId must be an even-length hex identifier/],
    ['oversized key id', { keyId: 'ab'.repeat(MAX_DRM_KEY_ID_CHARS) }, /keyId must not exceed/],
    ['non-base64 init data', { initData: 'not base64!!' }, /initData must be canonical base64/],
    ['non-canonical base64 padding', { initData: 'cHNzaA=' }, /initData must be canonical base64/],
    ['init data over the character bound', { initData: 'A'.repeat(MAX_DRM_INIT_DATA_CHARS + 4) }, /initData must not exceed/],
    ['http license endpoint', { licenseEndpoint: 'http://license.example.com/acquire' }, /licenseEndpoint must be an absolute https URL/],
    ['relative license endpoint', { licenseEndpoint: '/acquire' }, /licenseEndpoint must be an absolute https URL/],
    ['license endpoint with embedded credentials', { licenseEndpoint: 'https://user:secret@license.example.com/acquire' }, /licenseEndpoint must not embed credentials/],
    ['license endpoint over the length bound', { licenseEndpoint: `https://license.example.com/${'a'.repeat(MAX_DRM_URL_CHARS)}` }, /licenseEndpoint must not exceed/],
    ['license endpoint with a token query parameter', { licenseEndpoint: 'https://license.example.com/acquire?token=abc' }, /query parameter "token" is key-material or credential shaped/],
    ['license endpoint with an opaque query value', { licenseEndpoint: `https://license.example.com/acquire?session=${'a'.repeat(MAX_DRM_URL_QUERY_VALUE_CHARS + 1)}` }, /query parameter "session" exceeds/],
    ['certificate url over http', { certificateUrl: 'http://license.example.com/cert' }, /certificateUrl must be an absolute https URL/],
    ['missing issuer', { issuer: undefined }, /issuer must be a string/],
    ['empty issuer', { issuer: '' }, /issuer must not be empty/],
    ['oversized issuer', { issuer: 'a'.repeat(MAX_DRM_ISSUER_CHARS + 1) }, /issuer must not exceed/],
    ['unsafe entitlement id', { entitlementId: 'tier one/../etc' }, /entitlementId must be a safe identifier/],
    ['unsupported version', { version: 2 }, /version 2 is not supported/],
  ]

  for (const [name, overrides, message] of cases) {
    const input = protectedInput(overrides)
    t.exception(() => createProtectedRendition(input), message, name)
    t.absent(verifyProtectedRendition(input), `${name} does not verify`)
  }
})

test('init data is rejected once it decodes past the byte bound', (t) => {
  const atBound = b4a.toString(b4a.alloc(MAX_DRM_INIT_DATA_BYTES, 7), 'base64')
  const overBound = b4a.toString(b4a.alloc(MAX_DRM_INIT_DATA_BYTES + 1, 7), 'base64')

  t.ok(atBound.length <= MAX_DRM_INIT_DATA_CHARS)
  t.ok(overBound.length <= MAX_DRM_INIT_DATA_CHARS, 'the character bound alone must not catch this case')
  t.is(createProtectedRendition(protectedInput({ initData: atBound })).initData, atBound)
  t.exception(() => createProtectedRendition(protectedInput({ initData: overBound })), /initData must not exceed 4096 decoded bytes/)
})

test('every key-material or credential shaped property is refused by name, including nested', (t) => {
  t.alike([...PUBLIC_DRM_PROPERTY_NAMES], ['certificateUrl', 'keyId', 'licenseEndpoint'])
  t.is(findSecretShapedProperty(protectedInput()), null)

  for (const token of SECRET_SHAPED_PROPERTY_TOKENS) {
    const flat = protectedInput({ [`${token}Value`]: 'canary' })
    t.exception(() => createProtectedRendition(flat), /is key-material or credential shaped/, `${token} at top level`)
    t.is(findSecretShapedProperty(flat), `${token}Value`)

    const nested = protectedInput({ provider: { session: { [`content${token}`]: 'canary' } } })
    t.exception(() => createProtectedRendition(nested), /is key-material or credential shaped/, `${token} nested`)
    t.is(findSecretShapedProperty(nested), `provider.session.content${token}`)

    const inArray = protectedInput({ extras: [{ ok: 1 }, { [token.toUpperCase()]: 'canary' }] })
    t.exception(() => createProtectedRendition(inArray), /is key-material or credential shaped/, `${token} inside an array`)
    t.is(findSecretShapedProperty(inArray), `extras[1].${token.toUpperCase()}`)
  }

  const realistic = protectedInput({ drm: { contentKey: '00112233445566778899aabbccddeeff' } })
  t.exception(() => createProtectedRendition(realistic), /property "drm.contentKey" is key-material or credential shaped/)
  t.exception(() => createProtectedRendition(protectedInput({ licenseResponse: 'canary' })), /property "licenseResponse"/)
  t.exception(() => createProtectedRendition(protectedInput({ authorization: { bearerToken: 'canary' } })), /property "authorization.bearerToken"/)
  t.absent(verifyProtectedRendition({ ...createProtectedRendition(protectedInput()), providerToken: 'canary' }))
})

test('the digest changes when any public field changes', (t) => {
  const descriptor = createProtectedRendition(protectedInput())
  const baseline = protectedRenditionDigest(descriptor)
  const tampered = {
    scheme: 'cbcs',
    drmSystem: 'playready',
    keyId: 'ffffffffffffffffffffffffffffffff',
    initData: base64('pssh-fixture-tampered'),
    licenseEndpoint: 'https://license.example.com/acquire-other',
    certificateUrl: 'https://license.example.com/cert',
    issuer: 'https://attacker.example.com',
    entitlementId: 'provider:tier-2',
    version: 2,
  }

  for (const [field, value] of Object.entries(tampered)) {
    t.unlike(protectedRenditionDigest({ ...descriptor, [field]: value }), baseline, `${field} changes the digest`)
  }
  t.is(protectedRenditionDigest({ ...descriptor }), baseline)
  t.is(protectedRenditionDigest({ ...descriptor, unrelated: 'ignored' }), baseline, 'only wire fields participate')
})

test('verifyProtectedRendition refuses non-canonical descriptors without throwing', (t) => {
  const descriptor = createProtectedRendition(protectedInput())

  t.absent(verifyProtectedRendition(null))
  t.absent(verifyProtectedRendition('descriptor'))
  t.absent(verifyProtectedRendition([descriptor]))
  t.absent(verifyProtectedRendition({ ...descriptor, extra: 1 }), 'extra fields are not canonical')
  const { entitlementId, ...missing } = descriptor
  t.absent(verifyProtectedRendition(missing), 'missing fields are not canonical')
  t.absent(verifyProtectedRendition({ ...descriptor, keyId: KEY_ID.toUpperCase() }), 'uppercase key id is not canonical')
  t.absent(verifyProtectedRendition({ ...descriptor, scheme: 'CENC' }), 'uppercase scheme is not canonical')
  t.absent(verifyProtectedRendition({ ...descriptor, licenseEndpoint: 'https://license.example.com/acquire?token=abc' }))
})

const provider = crypto.keyPair(b4a.alloc(32, 11))
const otherProvider = crypto.keyPair(b4a.alloc(32, 12))

function entitlementInput(overrides = {}) {
  return {
    providerId: provider.publicKey,
    issuer: ISSUER,
    authorizationEndpoint: 'https://auth.example.com/oauth/device',
    licenseEndpoint: LICENSE_ENDPOINT,
    certificateUrl: 'https://license.example.com/fps/cert',
    allowedRedirectOrigins: ['https://app.example.com'],
    drmSystems: ['widevine', 'fairplay'],
    notBefore: 1_000,
    expiresAt: 9_000,
    ...overrides,
  }
}

test('entitlement descriptors sign, encode, and verify as public provider records', async (t) => {
  const record = createEntitlementDescriptor(entitlementInput(), { keyPair: provider })

  t.is(record.entitlementId.length, 64)
  t.is(record.body.entitlementId, record.entitlementId)
  t.alike(record.body.drmSystems, ['fairplay', 'widevine'], 'systems are canonically sorted')
  t.alike(record.body.allowedRedirectOrigins, ['https://app.example.com'])
  t.is(findSecretShapedProperty(record.body), null, 'a signed provider record carries nothing secret shaped')
  t.ok(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 5_000 }))

  const decoded = decodeEntitlementDescriptor(encodeEntitlementDescriptor(record))
  t.is(decoded.entitlementId, record.entitlementId)
  t.ok(await verifyEntitlementDescriptor(decoded, { allowedSigners: [provider.publicKey], now: 5_000 }))

  const reissued = createEntitlementDescriptor(entitlementInput(), { keyPair: provider })
  t.is(reissued.entitlementId, record.entitlementId, 'the id is derived from the canonical unsigned body')
})

test('entitlement verification fails closed on signer, clock, and tampering', async (t) => {
  const record = createEntitlementDescriptor(entitlementInput(), { keyPair: provider })

  t.absent(await verifyEntitlementDescriptor(record, { allowedSigners: [otherProvider.publicKey], now: 5_000 }), 'wrong signer')
  t.absent(await verifyEntitlementDescriptor(record, { now: 5_000 }), 'no authorization context')
  t.absent(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey] }), 'no injected clock')
  t.absent(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 9_001 }), 'expired')
  t.absent(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 999 }), 'not yet valid')
  t.ok(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 1_000 }), 'valid at notBefore')
  t.ok(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 9_000 }), 'valid at expiry')

  t.exception(
    () => createEntitlementDescriptor(entitlementInput({ providerId: otherProvider.publicKey }), { keyPair: provider }),
    /providerId must be the signing provider key/
  )

  const tamperedBody = { ...record, body: { ...record.body, issuer: 'https://attacker.example.com' } }
  t.absent(await verifyEntitlementDescriptor(tamperedBody, { allowedSigners: [provider.publicKey], now: 5_000 }))

  const tamperedUnsigned = {
    ...record,
    body: { ...record.body, unsignedBody: { ...record.body.unsignedBody, licenseEndpoint: 'https://attacker.example.com/acquire' } },
  }
  t.absent(await verifyEntitlementDescriptor(tamperedUnsigned, { allowedSigners: [provider.publicKey], now: 5_000 }))

  const foreign = createEntitlementDescriptor(entitlementInput({ providerId: otherProvider.publicKey }), { keyPair: otherProvider })
  t.absent(
    await verifyEntitlementDescriptor({ ...foreign, envelope: { ...foreign.envelope, signer: provider.publicKey } }, { allowedSigners: [provider.publicKey], now: 5_000 }),
    'a swapped signer breaks the record id binding'
  )
})

test('entitlement descriptors bound their public fields and refuse unsafe origins', (t) => {
  const cases = [
    ['wildcard redirect origin', { allowedRedirectOrigins: ['https://*.example.com'] }, /must not contain a wildcard/],
    ['http redirect origin', { allowedRedirectOrigins: ['http://app.example.com'] }, /allowedRedirectOrigins must use https/],
    ['redirect origin with a path', { allowedRedirectOrigins: ['https://app.example.com/callback'] }, /must be a bare origin/],
    ['redirect origin with credentials', { allowedRedirectOrigins: ['https://user:secret@app.example.com'] }, /must not embed credentials/],
    ['empty redirect origins', { allowedRedirectOrigins: [] }, /allowedRedirectOrigins must be a non-empty array/],
    ['too many redirect origins', { allowedRedirectOrigins: Array.from({ length: MAX_ENTITLEMENT_REDIRECT_ORIGINS + 1 }, (_, i) => `https://app${i}.example.com`) }, /allowedRedirectOrigins must not exceed/],
    ['repeated redirect origin', { allowedRedirectOrigins: ['https://app.example.com', 'https://app.example.com'] }, /must not repeat an origin/],
    ['clearkey without the capability', { drmSystems: ['widevine', 'clearkey'] }, /drmSystem "clearkey" is not supported/],
    ['unknown drm system', { drmSystems: ['nagra'] }, /drmSystem "nagra" is not supported/],
    ['empty drm systems', { drmSystems: [] }, /drmSystems must be a non-empty array/],
    ['http authorization endpoint', { authorizationEndpoint: 'http://auth.example.com/oauth' }, /authorizationEndpoint must be an absolute https URL/],
    ['missing validity window', { notBefore: 0 }, /notBefore is required/],
    ['expiry before notBefore', { expiresAt: 500 }, /expiresAt must be greater than notBefore/],
    ['provider token in the input', { providerAccessToken: 'canary' }, /property "providerAccessToken" is key-material or credential shaped/],
    ['nested provider secret', { provider: { client: { secretValue: 'canary' } } }, /property "provider.client.secretValue"/],
  ]

  for (const [name, overrides, message] of cases) {
    t.exception(() => createEntitlementDescriptor(entitlementInput(overrides), { keyPair: provider }), message, name)
  }

  const clearKeyRecord = createEntitlementDescriptor(entitlementInput({ drmSystems: ['clearkey'] }), { keyPair: provider, allowClearKeyForTests: true })
  t.alike(clearKeyRecord.body.drmSystems, ['clearkey'])
})

test('a clearkey entitlement never verifies without the test capability', async (t) => {
  const record = createEntitlementDescriptor(entitlementInput({ drmSystems: ['clearkey'] }), { keyPair: provider, allowClearKeyForTests: true })

  t.absent(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 5_000 }))
  t.ok(await verifyEntitlementDescriptor(record, { allowedSigners: [provider.publicKey], now: 5_000, allowClearKeyForTests: true }))
})
