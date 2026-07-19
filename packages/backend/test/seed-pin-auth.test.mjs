import assert from 'node:assert/strict'

import b4a from 'b4a'
import test from 'brittle'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'

import {
  createChannelRootDescriptor,
  signChannelRootDescriptor,
} from '../src/channel-descriptor.js'
import {
  createDurableManifest as createDurableManifestApi,
  encodeDurableManifest,
  MAX_DURABLE_MANIFEST_ROW_ID_BYTES,
} from '../src/seed-pin/manifest.js'
import {
  createSeedPinRequest,
  encodeSeedPinRequestPayload,
  verifySeedPinRequest,
} from '../src/seed-pin/auth.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const CHANNEL_KEY = '11'.repeat(32)
const OTHER_CHANNEL_KEY = '12'.repeat(32)
const METADATA_KEY = '22'.repeat(32)
const MEDIA_KEY = '33'.repeat(32)
const CORE_A = '44'.repeat(32)
const CORE_B = '55'.repeat(32)
const CORE_C = '66'.repeat(32)
const ROW_ID = 'video/雪/0001'
const NOW = 1_900_000_000_000
const EXPIRES_AT = NOW + 60_000
const PROOF_EPOCH = 1_800_000_000_000
const EXPECTED_REQUEST_ID = '23af210469f8f8062458a75813a05fc8d73f7a1bb37a9becb21e06a8a271981f'

function ref (coreKey, start, end, kind = 'media') {
  return { coreKey, start, end, kind }
}

function assetBindings (refs, artworkRoles = null) {
  const media = []
  const artworkRefs = []
  let thumbnail = null
  for (let index = 0; index < refs.length; index++) {
    if (refs[index]?.kind === 'media') media.push(index)
    else if (refs[index]?.kind === 'thumbnail' && thumbnail === null) thumbnail = index
    else if (refs[index]?.kind === 'artwork') artworkRefs.push(index)
  }
  const roles = artworkRoles === null
    ? ['avatar', 'poster', 'banner', 'backdrop'].slice(0, artworkRefs.length)
    : artworkRoles
  const artwork = { avatar: null, poster: null, banner: null, backdrop: null }
  for (let index = 0; index < roles.length; index++) {
    artwork[roles[index]] = artworkRefs[Math.min(index, artworkRefs.length - 1)] ?? null
  }
  return { media, thumbnail, artwork }
}

function createDurableManifest (input) {
  return createDurableManifestApi({
    ...input,
    assets: Object.prototype.hasOwnProperty.call(input, 'assets')
      ? input.assets
      : Array.isArray(input.refs) ? assetBindings(input.refs) : null,
  })
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function flipHexByte (value, byteOffset = 0) {
  const bytes = b4a.from(value, 'hex')
  bytes[byteOffset] ^= 0xff
  return b4a.toString(bytes, 'hex')
}

async function bootstrapAt (identity, publicKey, epoch = PROOF_EPOCH) {
  const originalNow = Date.now
  Date.now = () => epoch
  try {
    return await identity.bootstrap(publicKey)
  } finally {
    Date.now = originalNow
  }
}

async function buildFixture () {
  const identity = await IdentityKey.from({ mnemonic: MNEMONIC })
  const otherIdentity = await IdentityKey.from({ mnemonic: OTHER_MNEMONIC })
  const device = crypto.keyPair(b4a.alloc(32, 0x71))
  const otherDevice = crypto.keyPair(b4a.alloc(32, 0x72))
  const proof = await bootstrapAt(identity, device.publicKey)
  const otherDeviceProof = await bootstrapAt(identity, otherDevice.publicKey, PROOF_EPOCH + 1)
  const otherIdentityProof = await bootstrapAt(otherIdentity, device.publicKey, PROOF_EPOCH + 2)

  const descriptor = createChannelRootDescriptor({
    identityPublicKey: identity.identityPublicKey,
    channelId: CHANNEL_KEY,
    metadataKey: METADATA_KEY,
    mediaKey: MEDIA_KEY,
    seq: 4,
    createdAt: PROOF_EPOCH,
    updatedAt: PROOF_EPOCH + 10,
  })
  const signedDescriptor = await signChannelRootDescriptor({
    descriptor,
    deviceKeyPair: device,
    deviceProof: proof,
  })
  const otherDeviceDescriptor = await signChannelRootDescriptor({
    descriptor,
    deviceKeyPair: otherDevice,
    deviceProof: otherDeviceProof,
  })
  const otherIdentityDescriptor = await signChannelRootDescriptor({
    descriptor: createChannelRootDescriptor({
      identityPublicKey: otherIdentity.identityPublicKey,
      channelId: CHANNEL_KEY,
      metadataKey: METADATA_KEY,
      mediaKey: MEDIA_KEY,
      seq: 4,
      createdAt: PROOF_EPOCH,
      updatedAt: PROOF_EPOCH + 10,
    }),
    deviceKeyPair: device,
    deviceProof: otherIdentityProof,
  })
  const otherChannelDescriptor = await signChannelRootDescriptor({
    descriptor: createChannelRootDescriptor({
      identityPublicKey: identity.identityPublicKey,
      channelId: OTHER_CHANNEL_KEY,
      metadataKey: METADATA_KEY,
      mediaKey: MEDIA_KEY,
      seq: 4,
      createdAt: PROOF_EPOCH,
      updatedAt: PROOF_EPOCH + 10,
    }),
    deviceKeyPair: device,
    deviceProof: proof,
  })

  const refs = [
    ref(CORE_C, 7, 9, 'thumbnail'),
    ref(CORE_A, 10, 20, 'media'),
    ref(CORE_B, 1, 2, 'artwork'),
    ref(CORE_A, 10, 20, 'media'),
  ]
  const manifest = createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs })
  const request = await createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: proof,
    signedDescriptor,
  })

  return {
    identity,
    device,
    otherDevice,
    proof,
    signedDescriptor,
    otherDeviceDescriptor,
    otherIdentityDescriptor,
    otherChannelDescriptor,
    refs,
    manifest,
    request,
  }
}

let fixturePromise = null
function fixture () {
  if (fixturePromise === null) fixturePromise = buildFixture()
  return fixturePromise
}

async function invalid (request, remotePublicKey, now = NOW) {
  const result = await verifySeedPinRequest(request, { remotePublicKey, now })
  assert.equal(result.valid, false)
  assert.equal(typeof result.error, 'string')
  assert(result.error.length > 0)
}

test('canonical manifests deduplicate and byte-sort equivalent refs into one fixed request ID', async (t) => {
  const { refs } = await fixture()
  const original = clone(refs)
  const reversed = refs.slice().reverse().map((entry) => ({ ...entry }))
  const fromHex = createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs })
  const fromBytes = createDurableManifest({
    channelKey: b4a.from(CHANNEL_KEY, 'hex'),
    rowId: ROW_ID,
    refs: reversed,
  })

  t.is(fromHex.version, 1)
  t.is(fromHex.requestId, fromBytes.requestId)
  t.ok(b4a.equals(encodeDurableManifest(fromHex), encodeDurableManifest(fromBytes)))
  t.alike(fromHex.refs, [
    ref(CORE_A, 10, 20, 'media'),
    ref(CORE_B, 1, 2, 'artwork'),
    ref(CORE_C, 7, 9, 'thumbnail'),
  ])
  t.alike(refs, original, 'caller refs are not sorted or rewritten')
  t.is(fromHex.requestId, EXPECTED_REQUEST_ID, 'fixed vector request ID remains stable')
})

test('asset bindings encode explicit optional absence and derive the exact flat ref union', (t) => {
  const mediaOnly = [ref(CORE_A, 0, 8, 'media')]
  const manifest = createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: mediaOnly,
    assets: assetBindings(mediaOnly, []),
  })

  t.alike(manifest.refs, mediaOnly)
  t.alike(manifest.assets, {
    media: [0],
    thumbnail: null,
    artwork: {
      avatar: null,
      poster: null,
      banner: null,
      backdrop: null,
    },
  })
  t.ok(Object.isFrozen(manifest.assets))
  t.ok(Object.isFrozen(manifest.assets.media))
  t.ok(Object.isFrozen(manifest.assets.artwork))
})

test('asset bindings support two required artwork roles sharing one canonical ref', (t) => {
  const refs = [
    ref(CORE_C, 2, 3, 'thumbnail'),
    ref(CORE_B, 10, 12, 'artwork'),
    ref(CORE_A, 0, 10, 'media'),
  ]
  const manifest = createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs,
    assets: {
      media: [2],
      thumbnail: 0,
      artwork: {
        avatar: 1,
        poster: null,
        banner: 1,
        backdrop: null,
      },
    },
  })

  t.alike(manifest.refs, [
    ref(CORE_A, 0, 10, 'media'),
    ref(CORE_B, 10, 12, 'artwork'),
    ref(CORE_C, 2, 3, 'thumbnail'),
  ])
  t.alike(manifest.assets, {
    media: [0],
    thumbnail: 2,
    artwork: {
      avatar: 1,
      poster: null,
      banner: 1,
      backdrop: null,
    },
  })
})

test('asset bindings are canonical across reordered refs and bind each role into request identity', (t) => {
  const refs = [
    ref(CORE_C, 2, 3, 'thumbnail'),
    ref(CORE_B, 10, 12, 'artwork'),
    ref(CORE_A, 0, 10, 'media'),
  ]
  const forward = createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs,
    assets: {
      media: [2],
      thumbnail: 0,
      artwork: { avatar: 1, poster: null, banner: null, backdrop: null },
    },
  })
  const reversed = createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: refs.slice().reverse(),
    assets: {
      media: [0],
      thumbnail: 2,
      artwork: { backdrop: null, banner: null, poster: null, avatar: 1 },
    },
  })
  const otherRole = createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs,
    assets: {
      media: [2],
      thumbnail: 0,
      artwork: { avatar: null, poster: 1, banner: null, backdrop: null },
    },
  })

  t.is(reversed.requestId, forward.requestId)
  t.ok(b4a.equals(encodeDurableManifest(reversed), encodeDurableManifest(forward)))
  t.not(otherRole.requestId, forward.requestId)
})

test('asset bindings reject missing, extra, wrong-kind, out-of-set, and unbound refs', (t) => {
  const refs = [
    ref(CORE_A, 0, 10, 'media'),
    ref(CORE_B, 10, 12, 'artwork'),
    ref(CORE_C, 2, 3, 'thumbnail'),
  ]
  const valid = {
    media: [0],
    thumbnail: 2,
    artwork: { avatar: 1, poster: null, banner: null, backdrop: null },
  }
  const create = (assets, candidateRefs = refs) => createDurableManifestApi({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: candidateRefs,
    assets,
  })

  assert.throws(() => createDurableManifestApi({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs }), /assets/i)
  assert.throws(() => create({ ...valid, artwork: { avatar: 1, poster: null, banner: null } }), /backdrop/i)
  assert.throws(() => create({ ...valid, artwork: { ...valid.artwork, logo: null } }), /logo|unsupported/i)
  assert.throws(() => create({ ...valid, thumbnail: 0 }), /thumbnail.*kind/i)
  assert.throws(() => create({ ...valid, artwork: { ...valid.artwork, avatar: 2 } }), /artwork.*kind/i)
  assert.throws(() => create({ ...valid, thumbnail: 99 }), /index|range/i)
  assert.throws(() => create({ ...valid, thumbnail: null }), /unbound|union/i)
  assert.throws(() => create({
    media: [0],
    thumbnail: 2,
    artwork: { avatar: null, poster: null, banner: null, backdrop: null },
  }), /unbound|union/i)
  assert.throws(() => create({ ...valid, media: [] }), /media/i)
})

test('manifest identity changes for every semantic channel, row, range, or kind change', async (t) => {
  const { manifest, refs } = await fixture()
  const changed = [
    createDurableManifest({ channelKey: OTHER_CHANNEL_KEY, rowId: ROW_ID, refs }),
    createDurableManifest({ channelKey: CHANNEL_KEY, rowId: `${ROW_ID}-other`, refs }),
    createDurableManifest({
      channelKey: CHANNEL_KEY,
      rowId: ROW_ID,
      refs: refs.map((entry, index) => index === 1 ? { ...entry, end: entry.end + 1 } : entry),
    }),
    createDurableManifest({
      channelKey: CHANNEL_KEY,
      rowId: ROW_ID,
      refs: refs.map((entry, index) => index === 0 ? { ...entry, kind: 'artwork' } : entry),
    }),
  ]

  for (const candidate of changed) t.not(candidate.requestId, manifest.requestId)
})

test('manifest creation preserves all thumbnail and artwork refs and never aliases caller input', (t) => {
  const channelBytes = b4a.from(CHANNEL_KEY, 'hex')
  const refs = [
    ref(CORE_C, 8, 10, 'thumbnail'),
    ref(CORE_B, 2, 4, 'artwork'),
    ref(CORE_A, 0, 8, 'media'),
  ]
  const manifest = createDurableManifest({ channelKey: channelBytes, rowId: ROW_ID, refs })

  channelBytes.fill(0)
  refs[0].start = 99
  refs.push(ref(CORE_A, 99, 100, 'media'))

  t.is(manifest.channelKey, CHANNEL_KEY)
  t.alike(manifest.refs, [
    ref(CORE_A, 0, 8, 'media'),
    ref(CORE_B, 2, 4, 'artwork'),
    ref(CORE_C, 8, 10, 'thumbnail'),
  ])
  t.ok(Object.isFrozen(manifest))
  t.ok(Object.isFrozen(manifest.refs))
  t.ok(manifest.refs.every(Object.isFrozen))
})

test('manifest validation rejects malformed channel keys and row IDs', (t) => {
  const validRefs = [ref(CORE_A, 0, 1)]
  const badChannelKeys = [
    'aa',
    'ab'.repeat(32).toUpperCase(),
    `0x${CHANNEL_KEY}`,
    `${CHANNEL_KEY} `,
    'gg'.repeat(32),
    b4a.alloc(31),
    b4a.alloc(33),
    null,
  ]
  for (const channelKey of badChannelKeys) {
    assert.throws(() => createDurableManifest({ channelKey, rowId: ROW_ID, refs: validRefs }), /channelKey/i)
  }

  const badRowIds = [
    '',
    b4a.from('row'),
    null,
    1,
    '\ud800',
    'x'.repeat(MAX_DURABLE_MANIFEST_ROW_ID_BYTES + 1),
  ]
  for (const rowId of badRowIds) {
    assert.throws(() => createDurableManifest({ channelKey: CHANNEL_KEY, rowId, refs: validRefs }), /rowId/i)
  }
  assert.doesNotThrow(() => createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: 'é'.repeat(MAX_DURABLE_MANIFEST_ROW_ID_BYTES / 2),
    refs: validRefs,
  }))
})

test('manifest validation rejects empty, sparse, malformed, unknown-kind, and media-free refs', (t) => {
  assert.throws(() => createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs: [] }), /media/i)
  assert.throws(() => createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: [ref(CORE_A, 0, 1, 'thumbnail'), ref(CORE_B, 0, 1, 'artwork')],
  }), /media/i)
  assert.throws(() => createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs: new Array(1) }), /refs\[0\]/i)
  assert.throws(() => createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs: null }), /refs/i)
  assert.throws(() => createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: [ref(CORE_A, 0, 1, 'preview')],
  }), /kind/i)
  assert.throws(() => createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId: ROW_ID,
    refs: [ref(CORE_A, 1, 1)],
  }), /range|end/i)
})

test('a valid fixed identity/device/descriptor request verifies and replays deterministically', async (t) => {
  const { request, device, manifest } = await fixture()
  const first = await verifySeedPinRequest(request, { remotePublicKey: device.publicKey, now: NOW })
  const replay = await verifySeedPinRequest(clone(request), { remotePublicKey: b4a.from(device.publicKey), now: NOW })

  t.is(first.valid, true)
  t.is(replay.valid, true)
  t.is(first.requestId, manifest.requestId)
  t.alike(replay, first)
  t.ok(b4a.equals(
    encodeSeedPinRequestPayload(request),
    encodeSeedPinRequestPayload(clone(request)),
  ))
  t.is(first.requesterDevicePublicKey, b4a.toString(device.publicKey, 'hex'))
  t.is(first.channelKey, CHANNEL_KEY)
  t.absent(first.attestation)
  t.absent(first.proof)
  t.absent(first.secretKey)
})

test('auth canonical bytes and signatures are stable for reversed equivalent manifest input', async (t) => {
  const { refs, device, proof, signedDescriptor, request } = await fixture()
  const reversedManifest = createDurableManifest({
    channelKey: b4a.from(CHANNEL_KEY, 'hex'),
    rowId: ROW_ID,
    refs: refs.slice().reverse(),
  })
  const equivalent = await createSeedPinRequest({
    manifest: reversedManifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: proof,
    signedDescriptor: clone(signedDescriptor),
  })

  t.is(equivalent.requestId, request.requestId)
  t.ok(b4a.equals(encodeSeedPinRequestPayload(equivalent), encodeSeedPinRequestPayload(request)))
  t.is(equivalent.attestation, request.attestation)
})

test('auth signature changes with range, channel, row, or expiry', async (t) => {
  const { refs, device, proof, signedDescriptor, request, otherChannelDescriptor } = await fixture()
  const variants = [
    {
      manifest: createDurableManifest({
        channelKey: CHANNEL_KEY,
        rowId: ROW_ID,
        refs: refs.map((entry, index) => index === 1 ? { ...entry, end: 21 } : entry),
      }),
      signedDescriptor,
      expiresAt: EXPIRES_AT,
    },
    {
      manifest: createDurableManifest({ channelKey: OTHER_CHANNEL_KEY, rowId: ROW_ID, refs }),
      signedDescriptor: otherChannelDescriptor,
      expiresAt: EXPIRES_AT,
    },
    {
      manifest: createDurableManifest({ channelKey: CHANNEL_KEY, rowId: `${ROW_ID}-other`, refs }),
      signedDescriptor,
      expiresAt: EXPIRES_AT,
    },
    {
      manifest: createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs }),
      signedDescriptor,
      expiresAt: EXPIRES_AT + 1,
    },
  ]

  for (const variant of variants) {
    const candidate = await createSeedPinRequest({
      ...variant,
      deviceKeyPair: device,
      deviceProof: proof,
    })
    t.not(candidate.attestation, request.attestation)
  }
})

test('request creation does not mutate or alias manifest, proof, descriptor, or key inputs', async (t) => {
  const { refs, device, proof, signedDescriptor } = await fixture()
  const manifest = createDurableManifest({ channelKey: CHANNEL_KEY, rowId: ROW_ID, refs })
  const descriptorInput = clone(signedDescriptor)
  const descriptorBefore = clone(descriptorInput)
  const proofInput = b4a.from(proof)
  const proofBefore = b4a.from(proofInput)
  const request = await createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: proofInput,
    signedDescriptor: descriptorInput,
  })

  t.alike(descriptorInput, descriptorBefore)
  t.ok(b4a.equals(proofInput, proofBefore))
  t.not(request.manifest, manifest)
  t.not(request.signedDescriptor, descriptorInput)

  descriptorInput.descriptor.channelId = OTHER_CHANNEL_KEY
  proofInput.fill(0)
  t.is(request.signedDescriptor.descriptor.channelId, CHANNEL_KEY)
})

test('request creation rejects a secret key that does not match the attested device', async (t) => {
  const { manifest, device, otherDevice, proof, signedDescriptor } = await fixture()
  await t.exception(() => createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: {
      publicKey: device.publicKey,
      secretKey: otherDevice.secretKey,
    },
    deviceProof: proof,
    signedDescriptor,
  }), /key pair|attestation/i)
})

test('verification rejects malformed request shape, versions, request IDs, and expiry values', async (t) => {
  const { request, device } = await fixture()
  const cases = []
  cases.push(null, [], { ...request, version: 2 })
  cases.push({ ...request, requestId: '00'.repeat(32) })
  cases.push({ ...request, requestId: 'AA'.repeat(32) })
  cases.push({ ...request, requestId: request.requestId.slice(2) })
  cases.push({ ...request, expiresAt: Number.NaN })
  cases.push({ ...request, expiresAt: Number.POSITIVE_INFINITY })
  cases.push({ ...request, expiresAt: Number.MAX_SAFE_INTEGER + 1 })
  cases.push({ ...request, expiresAt: '1900000060000' })
  cases.push({ ...request, requesterPublicKey: b4a.toString(device.publicKey, 'hex') })
  cases.push({ ...request, verification: { valid: true, identityPublicKey: request.manifest.channelKey } })

  for (const candidate of cases) await invalid(candidate, device.publicKey)
  await invalid(request, b4a.toString(device.publicKey, 'hex'))
  await invalid(request, b4a.alloc(31))
})

test('verification rejects expired requests including the exact expiry boundary', async (t) => {
  const { request, device } = await fixture()
  await invalid(request, device.publicKey, EXPIRES_AT)
  await invalid(request, device.publicKey, EXPIRES_AT + 1)
})

test('verification rejects tampered manifest fields and unknown manifest versions or kinds', async (t) => {
  const { request, device } = await fixture()
  const cases = []

  const changedRange = clone(request)
  changedRange.manifest.refs[0].end++
  cases.push(changedRange)

  const changedChannel = clone(request)
  changedChannel.manifest.channelKey = OTHER_CHANNEL_KEY
  cases.push(changedChannel)

  const changedRow = clone(request)
  changedRow.manifest.rowId = `${ROW_ID}-tampered`
  cases.push(changedRow)

  const changedAssetBinding = clone(request)
  changedAssetBinding.manifest.assets.artwork.poster =
    changedAssetBinding.manifest.assets.artwork.avatar
  changedAssetBinding.manifest.assets.artwork.avatar = null
  cases.push(changedAssetBinding)

  const unknownVersion = clone(request)
  unknownVersion.manifest.version = 2
  cases.push(unknownVersion)

  const unknownKind = clone(request)
  unknownKind.manifest.refs[0].kind = 'preview'
  cases.push(unknownKind)

  const noMedia = clone(request)
  noMedia.manifest.refs = noMedia.manifest.refs.filter((entry) => entry.kind !== 'media')
  cases.push(noMedia)

  const extraManifestField = clone(request)
  extraManifestField.manifest.requesterKey = b4a.toString(device.publicKey, 'hex')
  cases.push(extraManifestField)

  for (const candidate of cases) await invalid(candidate, device.publicKey)
})

test('verification binds signed descriptor identity, device, and channel to request and live peer', async (t) => {
  const {
    request,
    device,
    otherDevice,
    otherIdentityDescriptor,
    otherDeviceDescriptor,
    otherChannelDescriptor,
  } = await fixture()

  await invalid({ ...request, signedDescriptor: otherIdentityDescriptor }, device.publicKey)
  await invalid({ ...request, signedDescriptor: otherDeviceDescriptor }, device.publicKey)
  await invalid({ ...request, signedDescriptor: otherChannelDescriptor }, device.publicKey)
  await invalid(request, otherDevice.publicKey)
})

test('verification rejects altered auth payload, attestation, descriptor proof, and descriptor attestation', async (t) => {
  const { request, device } = await fixture()
  const cases = [
    { ...request, expiresAt: request.expiresAt + 1 },
    { ...request, attestation: flipHexByte(request.attestation, 8) },
    { ...request, attestation: 'zz' },
  ]

  const changedProof = clone(request)
  changedProof.signedDescriptor.proof = flipHexByte(changedProof.signedDescriptor.proof, 8)
  cases.push(changedProof)

  const malformedProof = clone(request)
  malformedProof.signedDescriptor.proof = 'zz'
  cases.push(malformedProof)

  const changedDescriptorAttestation = clone(request)
  changedDescriptorAttestation.signedDescriptor.attestation = flipHexByte(
    changedDescriptorAttestation.signedDescriptor.attestation,
    8,
  )
  cases.push(changedDescriptorAttestation)

  const changedDescriptor = clone(request)
  changedDescriptor.signedDescriptor.descriptor.mediaKey = '99'.repeat(32)
  cases.push(changedDescriptor)

  for (const candidate of cases) await invalid(candidate, device.publicKey)
})

test('identity proofs and attestations reject trailing alternate encodings', async (t) => {
  const { request, device, proof, signedDescriptor, manifest } = await fixture()

  const trailingRequestAttestation = clone(request)
  trailingRequestAttestation.attestation += '00'
  await invalid(trailingRequestAttestation, device.publicKey)

  const trailingDescriptorAttestation = clone(request)
  trailingDescriptorAttestation.signedDescriptor.attestation += '00'
  await invalid(trailingDescriptorAttestation, device.publicKey)

  const trailingDescriptorProof = clone(request)
  trailingDescriptorProof.signedDescriptor.proof += '00'
  await invalid(trailingDescriptorProof, device.publicKey)

  const trailingProofDescriptor = clone(signedDescriptor)
  trailingProofDescriptor.proof += '00'
  await assert.rejects(createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: b4a.concat([proof, b4a.from([0])]),
    signedDescriptor: trailingProofDescriptor,
  }), /canonical|trailing|encoding/i)
})

test('wire proofs are hex strings while create-time device proofs are bounded bytes', async (t) => {
  const { request, device, signedDescriptor, manifest } = await fixture()

  const byteRequestAttestation = clone(request)
  byteRequestAttestation.attestation = b4a.from(request.attestation, 'hex')
  await invalid(byteRequestAttestation, device.publicKey)

  const byteDescriptorProof = clone(request)
  byteDescriptorProof.signedDescriptor.proof = b4a.from(
    request.signedDescriptor.proof,
    'hex',
  )
  await invalid(byteDescriptorProof, device.publicKey)

  const byteDescriptorAttestation = clone(request)
  byteDescriptorAttestation.signedDescriptor.attestation = b4a.from(
    request.signedDescriptor.attestation,
    'hex',
  )
  await invalid(byteDescriptorAttestation, device.publicKey)

  await assert.rejects(createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: signedDescriptor.proof,
    signedDescriptor,
  }), /deviceProof.*bytes/i)

  await assert.rejects(createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: b4a.alloc((16 * 1024) + 1),
    signedDescriptor,
  }), /deviceProof.*size|exceeds/i)

  await assert.rejects(createSeedPinRequest({
    manifest,
    expiresAt: EXPIRES_AT,
    deviceKeyPair: device,
    deviceProof: b4a.alloc(16 * 1024),
    signedDescriptor,
  }), /deviceProof.*canonical|deviceProof.*encoding/i)

  const exactMaxMalformedWire = clone(request)
  exactMaxMalformedWire.attestation = '00'.repeat(16 * 1024)
  await invalid(exactMaxMalformedWire, device.publicKey)
})

test('plausible caller-declared verification output cannot bypass production cryptography', async (t) => {
  const { request, device } = await fixture()
  const fake = {
    ...request,
    attestation: '00'.repeat(b4a.from(request.attestation, 'hex').byteLength),
    verifierResult: {
      valid: true,
      identityPublicKey: request.signedDescriptor.descriptor.identityPublicKey,
      devicePublicKey: b4a.toString(device.publicKey, 'hex'),
    },
  }

  const result = await verifySeedPinRequest(fake, {
    remotePublicKey: device.publicKey,
    now: NOW,
    verifyIdentity: () => fake.verifierResult,
    verifyDescriptor: () => ({ valid: true, ...fake.verifierResult }),
  })
  t.is(result.valid, false)
})

test('verification catches cryptographic parsing exceptions and fails closed', async (t) => {
  const { request, device } = await fixture()
  const malformed = clone(request)
  malformed.attestation = 'ff'.repeat(65_536)
  await invalid(malformed, device.publicKey)

  const malformedDescriptor = clone(request)
  malformedDescriptor.signedDescriptor.attestation = 'ff'.repeat(65_536)
  await invalid(malformedDescriptor, device.publicKey)
})
