import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'

import {
  PUBLISHER_RECORD_TYPES,
  createPublisherNamespaceDescriptor,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody
} from '../src/publisher/index.js'
import {
  attachMultiSignedEnvelopeSignatures,
  attachSignedEnvelopeSignature,
  multiSignedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage
} from '../src/records/index.js'
import {
  MAX_PORTABLE_MANIFEST_BYTES,
  MAX_PORTABLE_ITEMS,
  PORTABILITY_CLASSIFICATIONS,
  PORTABLE_STATE_VERSION,
  classifyPortability,
  countPortableStateItems,
  createMemoryPortableStateRepository,
  createPortableStateManifest,
  createPortableStateService
} from '../src/portability/index.js'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const hex = value => b4a.toString(value, 'hex')
const numericId = value => {
  const output = b4a.alloc(32)
  output[28] = value >>> 24
  output[29] = value >>> 16
  output[30] = value >>> 8
  output[31] = value
  return hex(output)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key])
  return output
}

function canonicalBytes(value) {
  return b4a.from(JSON.stringify(canonicalize(value)))
}

function sha256(value) {
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, value)
  return hex(digest)
}

function signedOperation({ descriptor, signer, recordType, policyEpoch, sequence, body, signedAt = 1_700_000_000_000 }) {
  const canonicalBody = recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? encodePublisherNamespaceDescriptor(body)
    : encodePublisherOperationBody(recordType, body)
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey))
}

function signedTransition({ descriptor, signers, policyEpoch = 0, sequence, body, signedAt = 1_700_000_000_001 }) {
  const prepared = prepareMultiSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, body)
  }, { hash: crypto.hash })
  const signatures = signers.map(signer => ({
    signerKey: signer.publicKey,
    signature: crypto.sign(multiSignedRecordSignaturePreimage(prepared), signer.secretKey)
  })).sort((left, right) => b4a.compare(left.signerKey, right.signerKey))
  return attachMultiSignedEnvelopeSignatures(prepared, signatures)
}

function aggregatePublisherCatalog(seed) {
  const root = crypto.keyPair(bytes(32, seed))
  const nextA = crypto.keyPair(bytes(32, seed + 64))
  const nextB = crypto.keyPair(bytes(32, seed + 128))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: b4a.from(numericId(10_000 + seed), 'hex'),
    profileRef: b4a.from(`aggregate:${seed}`),
    recoveryKeys: [],
    recoveryThreshold: 0
  })
  const genesis = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const rotationA = signedTransition({
    descriptor,
    signers: [root, nextA],
    sequence: 1,
    body: {
      mode: 'rotation',
      previousRootKey: root.publicKey,
      newRootKey: nextA.publicKey,
      newCatalogEpoch: 1,
      recoveryKeys: [],
      recoveryThreshold: 0,
      profileRef: descriptor.profileRef
    }
  })
  const rotationB = signedTransition({
    descriptor,
    signers: [nextA, nextB],
    sequence: 2,
    body: {
      mode: 'rotation',
      previousRootKey: nextA.publicKey,
      newRootKey: nextB.publicKey,
      newCatalogEpoch: 2,
      recoveryKeys: [],
      recoveryThreshold: 0,
      profileRef: descriptor.profileRef
    }
  })
  return {
    publisherId: descriptor.publisherId,
    catalogBootstrapKey: descriptor.catalogBootstrapKey,
    rootHistory: [
      { frame: encodePublisherCatalogFrame(genesis) },
      { frame: encodePublisherCatalogFrame(rotationA) },
      { frame: encodePublisherCatalogFrame(rotationB) }
    ]
  }
}

function archiveFixture() {
  const signer = crypto.keyPair(bytes(32, 80))
  const body = b4a.from(JSON.stringify({ pledgeId: hex(bytes(32, 90)), durable: true }))
  const envelope = canonicalBytes({
    body: hex(body),
    signerKey: hex(signer.publicKey),
    signature: hex(crypto.sign(body, signer.secretKey))
  })
  return {
    evidence: {
      id: hex(bytes(32, 91)),
      kind: 'archive-pledge',
      envelope,
      checkpoint: { sequence: 7, digest: sha256(envelope) },
      privateKey: signer.secretKey
    },
    verify(evidence) {
      const decoded = JSON.parse(b4a.toString(evidence.envelope))
      return crypto.verify(
        b4a.from(decoded.body, 'hex'),
        b4a.from(decoded.signature, 'hex'),
        b4a.from(decoded.signerKey, 'hex')
      )
    }
  }
}

function portableFixture() {
  const root = crypto.keyPair(bytes(32, 1))
  const nextRoot = crypto.keyPair(bytes(32, 2))
  const recoveryA = crypto.keyPair(bytes(32, 3))
  const recoveryB = crypto.keyPair(bytes(32, 4))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 20),
    profileRef: b4a.from('profile:portable'),
    recoveryKeys: [recoveryA.publicKey, recoveryB.publicKey].sort(b4a.compare),
    recoveryThreshold: 2
  })
  const genesis = signedOperation({
    descriptor,
    signer: root,
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0,
    sequence: 0,
    body: descriptor
  })
  const rotation = signedTransition({
    descriptor,
    signers: [root, nextRoot],
    sequence: 1,
    body: {
      mode: 'rotation',
      previousRootKey: root.publicKey,
      newRootKey: nextRoot.publicKey,
      newCatalogEpoch: 1,
      recoveryKeys: descriptor.recoveryKeys,
      recoveryThreshold: descriptor.recoveryThreshold,
      profileRef: descriptor.profileRef
    }
  })
  const archive = archiveFixture()
  const knownRootSecret = hex(root.secretKey)
  const knownRecoverySecret = hex(recoveryA.secretKey)
  const knownDeviceSecret = hex(bytes(64, 130))
  const knownArchiveSecret = hex(archive.evidence.privateKey)
  const state = {
    publisherCatalogs: [{
      publisherId: descriptor.publisherId,
      catalogBootstrapKey: descriptor.catalogBootstrapKey,
      rootHistory: [
        { frame: encodePublisherCatalogFrame(genesis) },
        { frame: encodePublisherCatalogFrame(rotation) }
      ],
      rootSecretKey: root.secretKey,
      recoverySecretKeys: [recoveryA.secretKey]
    }],
    graphPreferences: [{
      entityId: hex(bytes(32, 30)),
      publicationId: hex(bytes(32, 31)),
      preferred: true,
      cachePath: '/device-only/cache'
    }],
    indexPreferences: [{ indexId: hex(bytes(32, 32)), enabled: true, priority: 3, privateToken: knownDeviceSecret }],
    followedFeeds: {
      publishers: [hex(bytes(32, 40))],
      indexes: [hex(bytes(32, 41))],
      moderation: [hex(bytes(32, 42))]
    },
    archiveEvidence: [
      archive.evidence,
      {
        ...archive.evidence,
        id: hex(bytes(32, 92)),
        kind: 'offload-assessment'
      }
    ],
    policy: {
      uploadPermission: 'manual',
      meteredNetwork: 'local-only',
      backgroundMode: 'allow',
      diskCeilingBytes: 8 * 1024 * 1024,
      uploadCeilingBytes: 2 * 1024 * 1024,
      retentionMode: 'archive-pledges',
      aiAnalysis: 'local-only',
      privateToken: knownDeviceSecret
    },
    deviceCache: { privateKey: knownDeviceSecret, blocks: ['not-portable'] }
  }
  return { archive, descriptor, knownRootSecret, knownRecoverySecret, knownDeviceSecret, knownArchiveSecret, nextRoot, state }
}

async function exportFixture(fixture, target = createMemoryPortableStateRepository()) {
  const source = createMemoryPortableStateRepository(fixture.state)
  const service = createPortableStateService({
    snapshotPortableState: () => source.snapshotPortableState(),
    restoreTransaction: request => target.restorePortableStateTransaction(request),
    verifyArchiveEvidence: evidence => fixture.archive.verify(evidence),
    now: () => 1_700_000_100_000
  })
  const exported = await service.exportPortableState({})
  return { exported, service, source, target }
}

test('portable state completes a canonical round-trip onto a new device', async t => {
  const fixture = portableFixture()
  const target = createMemoryPortableStateRepository()
  const { exported, service } = await exportFixture(fixture, target)

  t.ok(exported.success)
  t.is(exported.schemaVersion, PORTABLE_STATE_VERSION)
  t.ok(exported.manifestBytes.byteLength > 0)
  t.is(exported.manifestDigest, sha256(exported.manifestBytes))
  t.ok(exported.itemCount > 0)

  const restored = await service.restorePortableState({
    manifestBytes: exported.manifestBytes,
    manifestDigest: exported.manifestDigest
  })
  t.alike(restored, {
    success: true,
    schemaVersion: PORTABLE_STATE_VERSION,
    importedCount: exported.itemCount,
    skippedCount: 0,
    idempotent: false
  })

  const imported = await target.snapshotPortableState()
  t.is(imported.publisherCatalogs.length, 1)
  t.is(imported.publisherCatalogs[0].rootHistory.length, 2)
  t.is(imported.publisherCatalogs[0].recoveryMetadata.activeRootKey, hex(fixture.nextRoot.publicKey))
  t.alike(imported.graphPreferences, [{
    entityId: hex(bytes(32, 30)),
    publicationId: hex(bytes(32, 31)),
    preferred: true
  }])
  t.alike(imported.followedFeeds, fixture.state.followedFeeds)
  t.alike(imported.archiveEvidence.map(evidence => evidence.kind), ['archive-pledge', 'offload-assessment'])
  t.alike(imported.policy, {
    uploadPermission: 'manual',
    meteredNetwork: 'local-only',
    backgroundMode: 'allow',
    diskCeilingBytes: 8 * 1024 * 1024,
    uploadCeilingBytes: 2 * 1024 * 1024,
    retentionMode: 'archive-pledges',
    aiAnalysis: 'local-only'
  })
})

test('restore rejects corrupt signatures and checkpoints before transaction mutation', async t => {
  const fixture = portableFixture()
  let mutations = 0
  const { exported } = await exportFixture(fixture)
  const rejectingService = createPortableStateService({
    snapshotPortableState: async () => fixture.state,
    restoreTransaction: async () => {
      mutations++
      return { importedCount: 0, skippedCount: 0, idempotent: false }
    },
    verifyArchiveEvidence: evidence => fixture.archive.verify(evidence)
  })

  const badSignature = JSON.parse(b4a.toString(exported.manifestBytes))
  const frame = b4a.from(badSignature.state.publisherCatalogs[0].rootHistory[0].frame, 'hex')
  frame[frame.byteLength - 1] ^= 1
  badSignature.state.publisherCatalogs[0].rootHistory[0].frame = hex(frame)
  const badSignatureBytes = canonicalBytes(badSignature)
  const signatureResult = await rejectingService.restorePortableState({
    manifestBytes: badSignatureBytes,
    manifestDigest: sha256(badSignatureBytes)
  })
  t.absent(signatureResult.success)
  t.is(signatureResult.errorCode, 'PORTABLE_STATE_SIGNATURE_INVALID')
  t.is(mutations, 0)

  const badCheckpoint = JSON.parse(b4a.toString(exported.manifestBytes))
  badCheckpoint.state.publisherCatalogs[0].checkpoint.authorizationStateDigest = '00'.repeat(32)
  const badCheckpointBytes = canonicalBytes(badCheckpoint)
  const checkpointResult = await rejectingService.restorePortableState({
    manifestBytes: badCheckpointBytes,
    manifestDigest: sha256(badCheckpointBytes)
  })
  t.absent(checkpointResult.success)
  t.is(checkpointResult.errorCode, 'PORTABLE_STATE_CHECKPOINT_INVALID')
  t.is(mutations, 0)
})

test('restore rejects oversized, duplicate, and unknown-field manifests before mutation', async t => {
  const fixture = portableFixture()
  let mutations = 0
  const { exported } = await exportFixture(fixture)
  const service = createPortableStateService({
    snapshotPortableState: async () => fixture.state,
    restoreTransaction: async () => {
      mutations++
      return { importedCount: 0, skippedCount: 0, idempotent: false }
    },
    verifyArchiveEvidence: evidence => fixture.archive.verify(evidence)
  })

  const oversized = await service.restorePortableState({ manifestBytes: b4a.alloc(MAX_PORTABLE_MANIFEST_BYTES + 1) })
  t.is(oversized.errorCode, 'PORTABLE_STATE_TOO_LARGE')

  const duplicate = JSON.parse(b4a.toString(exported.manifestBytes))
  duplicate.state.graphPreferences.push({ ...duplicate.state.graphPreferences[0] })
  const duplicateBytes = canonicalBytes(duplicate)
  const duplicateResult = await service.restorePortableState({ manifestBytes: duplicateBytes, manifestDigest: sha256(duplicateBytes) })
  t.is(duplicateResult.errorCode, 'PORTABLE_STATE_DUPLICATE_ID')

  const unknown = JSON.parse(b4a.toString(exported.manifestBytes))
  unknown.state.publisherCatalogs[0].rootSecretKey = fixture.knownRootSecret
  const unknownBytes = canonicalBytes(unknown)
  const unknownResult = await service.restorePortableState({ manifestBytes: unknownBytes, manifestDigest: sha256(unknownBytes) })
  t.is(unknownResult.errorCode, 'PORTABLE_STATE_UNKNOWN_FIELD')
  t.is(mutations, 0)
})

test('restore enforces digest, version, canonical, item, and archive evidence gates before mutation', async t => {
  const fixture = portableFixture()
  const { exported } = await exportFixture(fixture)
  let mutations = 0
  const restoreTransaction = async () => {
    mutations++
    return { importedCount: exported.itemCount, skippedCount: 0, idempotent: false }
  }
  const service = createPortableStateService({
    snapshotPortableState: async () => fixture.state,
    restoreTransaction,
    verifyArchiveEvidence: evidence => fixture.archive.verify(evidence)
  })

  const checksum = await service.restorePortableState({
    manifestBytes: exported.manifestBytes,
    manifestDigest: '00'.repeat(32)
  })
  t.is(checksum.errorCode, 'PORTABLE_STATE_CHECKSUM_MISMATCH')

  const unsupported = JSON.parse(b4a.toString(exported.manifestBytes))
  unsupported.version = PORTABLE_STATE_VERSION + 1
  const unsupportedBytes = canonicalBytes(unsupported)
  const version = await service.restorePortableState({
    manifestBytes: unsupportedBytes,
    manifestDigest: sha256(unsupportedBytes)
  })
  t.is(version.errorCode, 'PORTABLE_STATE_UNSUPPORTED_VERSION')

  const noncanonicalBytes = b4a.concat([exported.manifestBytes, b4a.from(' ')])
  const noncanonical = await service.restorePortableState({
    manifestBytes: noncanonicalBytes,
    manifestDigest: sha256(noncanonicalBytes)
  })
  t.is(noncanonical.errorCode, 'PORTABLE_STATE_NONCANONICAL')

  const tooMany = JSON.parse(b4a.toString(exported.manifestBytes))
  tooMany.state.graphPreferences = Array.from({ length: 513 }, (_, index) => ({
    entityId: hex(bytes(32, index)),
    publicationId: hex(bytes(32, index + 1)),
    preferred: true
  }))
  const tooManyBytes = canonicalBytes(tooMany)
  const itemLimit = await service.restorePortableState({
    manifestBytes: tooManyBytes,
    manifestDigest: sha256(tooManyBytes)
  })
  t.is(itemLimit.errorCode, 'PORTABLE_STATE_ITEM_LIMIT')

  const badArchiveSignature = JSON.parse(b4a.toString(exported.manifestBytes))
  const archiveEnvelope = JSON.parse(b4a.toString(b4a.from(badArchiveSignature.state.archiveEvidence[0].envelope, 'hex')))
  const archiveSignature = b4a.from(archiveEnvelope.signature, 'hex')
  archiveSignature[0] ^= 1
  archiveEnvelope.signature = hex(archiveSignature)
  badArchiveSignature.state.archiveEvidence[0].envelope = hex(canonicalBytes(archiveEnvelope))
  const badArchiveSignatureBytes = canonicalBytes(badArchiveSignature)
  const archiveSignatureResult = await service.restorePortableState({
    manifestBytes: badArchiveSignatureBytes,
    manifestDigest: sha256(badArchiveSignatureBytes)
  })
  t.is(archiveSignatureResult.errorCode, 'PORTABLE_STATE_SIGNATURE_INVALID')

  const badArchiveCheckpoint = JSON.parse(b4a.toString(exported.manifestBytes))
  badArchiveCheckpoint.state.archiveEvidence[0].checkpoint.digest = '00'.repeat(32)
  const badArchiveCheckpointBytes = canonicalBytes(badArchiveCheckpoint)
  const archiveCheckpointResult = await service.restorePortableState({
    manifestBytes: badArchiveCheckpointBytes,
    manifestDigest: sha256(badArchiveCheckpointBytes)
  })
  t.is(archiveCheckpointResult.errorCode, 'PORTABLE_STATE_CHECKPOINT_INVALID')

  const noArchiveVerifier = createPortableStateService({
    snapshotPortableState: async () => fixture.state,
    restoreTransaction
  })
  const missingVerifier = await noArchiveVerifier.restorePortableState({
    manifestBytes: exported.manifestBytes,
    manifestDigest: exported.manifestDigest
  })
  t.is(missingVerifier.errorCode, 'PORTABLE_STATE_SIGNATURE_INVALID')
  t.is(mutations, 0)

  const aggregatePublishers = []
  for (let index = 0; index < 64; index++) {
    const publisherManifest = await createPortableStateManifest({
      publisherCatalogs: [aggregatePublisherCatalog(index)]
    }, { createdAt: 1_700_000_100_000 })
    aggregatePublishers.push(publisherManifest.state.publisherCatalogs[0])
  }
  const aggregateArchive = archiveFixture()
  const aggregateBase = await createPortableStateManifest({
    graphPreferences: Array.from({ length: 512 }, (_, index) => ({
      entityId: numericId(index),
      publicationId: numericId(1_000 + index),
      preferred: true
    })),
    indexPreferences: Array.from({ length: 256 }, (_, index) => ({
      indexId: numericId(2_000 + index),
      enabled: true,
      priority: index
    })),
    followedFeeds: {
      publishers: Array.from({ length: 256 }, (_, index) => numericId(3_000 + index)),
      indexes: Array.from({ length: 256 }, (_, index) => numericId(4_000 + index)),
      moderation: Array.from({ length: 256 }, (_, index) => numericId(5_000 + index))
    },
    archiveEvidence: Array.from({ length: 256 }, (_, index) => ({
      ...aggregateArchive.evidence,
      id: numericId(6_000 + index)
    }))
  }, {
    createdAt: 1_700_000_100_000,
    verifyArchiveEvidence: evidence => aggregateArchive.verify(evidence)
  })
  aggregateBase.state.publisherCatalogs = aggregatePublishers
  const aggregateBytes = canonicalBytes(aggregateBase)
  const aggregateLimit = await service.restorePortableState({
    manifestBytes: aggregateBytes,
    manifestDigest: sha256(aggregateBytes)
  })
  t.is(aggregateLimit.errorCode, 'PORTABLE_STATE_ITEM_LIMIT')
  t.is(mutations, 0)

  t.exception(() => countPortableStateItems({
    publisherCatalogs: [{ rootHistory: Array(MAX_PORTABLE_ITEMS + 1) }],
    graphPreferences: [],
    indexPreferences: [],
    followedFeeds: { publishers: [], indexes: [], moderation: [] },
    archiveEvidence: []
  }), /total item limit/)
})

test('repeated restore is idempotent and skips every already imported item', async t => {
  const fixture = portableFixture()
  const { exported, service } = await exportFixture(fixture)
  const first = await service.restorePortableState({ manifestBytes: exported.manifestBytes, manifestDigest: exported.manifestDigest })
  const second = await service.restorePortableState({ manifestBytes: exported.manifestBytes, manifestDigest: exported.manifestDigest })

  t.absent(first.idempotent)
  t.alike(second, {
    success: true,
    schemaVersion: PORTABLE_STATE_VERSION,
    importedCount: 0,
    skippedCount: exported.itemCount,
    idempotent: true
  })
})

test('restore preserves device-local state and only treats the currently installed manifest as idempotent', async t => {
  const fixtureA = portableFixture()
  const fixtureB = portableFixture()
  fixtureB.state.graphPreferences = [{
    entityId: hex(bytes(32, 33)),
    publicationId: hex(bytes(32, 34)),
    preferred: true
  }]
  const target = createMemoryPortableStateRepository({
    deviceCache: { blocks: ['keep-me'], privateKey: fixtureA.knownDeviceSecret },
    downloads: { partialRanges: ['keep-me-too'] }
  })
  const exportedA = await exportFixture(fixtureA, target)
  const exportedB = await exportFixture(fixtureB, target)

  const firstA = await exportedA.service.restorePortableState({
    manifestBytes: exportedA.exported.manifestBytes,
    manifestDigest: exportedA.exported.manifestDigest
  })
  const firstB = await exportedB.service.restorePortableState({
    manifestBytes: exportedB.exported.manifestBytes,
    manifestDigest: exportedB.exported.manifestDigest
  })
  const secondA = await exportedA.service.restorePortableState({
    manifestBytes: exportedA.exported.manifestBytes,
    manifestDigest: exportedA.exported.manifestDigest
  })
  const restored = await target.snapshotPortableState()

  t.absent(firstA.idempotent)
  t.absent(firstB.idempotent)
  t.absent(secondA.idempotent)
  t.is(secondA.importedCount, exportedA.exported.itemCount)
  t.alike(restored.deviceCache, { blocks: ['keep-me'], privateKey: fixtureA.knownDeviceSecret })
  t.alike(restored.downloads, { partialRanges: ['keep-me-too'] })
  t.is(restored.graphPreferences[0].entityId, fixtureA.state.graphPreferences[0].entityId)
})

test('classification identifies portable, device-local, and never-exported state', t => {
  t.is(classifyPortability('publisher.publicRootHistory'), PORTABILITY_CLASSIFICATIONS.PORTABLE)
  t.is(classifyPortability('preferences.graph'), PORTABILITY_CLASSIFICATIONS.PORTABLE)
  t.is(classifyPortability('cache.playbackWindows'), PORTABILITY_CLASSIFICATIONS.DEVICE_LOCAL)
  t.is(classifyPortability('publisher.rootSecretKey'), PORTABILITY_CLASSIFICATIONS.NEVER_EXPORTED)
  t.is(classifyPortability('vault.credentials'), PORTABILITY_CLASSIFICATIONS.NEVER_EXPORTED)
  t.is(classifyPortability('unclassified.futureField'), PORTABILITY_CLASSIFICATIONS.UNKNOWN)
})

test('canonical export byte scan excludes known private root, recovery, and device secrets', async t => {
  const fixture = portableFixture()
  const { exported } = await exportFixture(fixture)
  const text = b4a.toString(exported.manifestBytes)

  t.absent(text.includes(fixture.knownRootSecret))
  t.absent(text.includes(fixture.knownRecoverySecret))
  t.absent(text.includes(fixture.knownDeviceSecret))
  t.absent(text.includes(fixture.knownArchiveSecret))
  t.absent(text.includes('deviceCache'))
  t.absent(text.includes('rootSecretKey'))
  t.absent(text.includes('privateToken'))
})
