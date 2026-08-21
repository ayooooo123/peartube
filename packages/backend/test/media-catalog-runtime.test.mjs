import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'

import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createPublicationManifest, createRenditionDescriptor, createStaticAssetManifest, encodePublicationManifest } from '../src/assets/index.js'
import {
  createConsumerCatalogProjection,
  createPublisherCatalogProjection,
  projectAuthenticatedPublisherMediaRecords,
} from '../src/media-graph/catalog-projection.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'
import { createEntityReference, createMediaClaim, encodeMediaClaimEnvelope } from '../src/media-graph/index.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import {
  PUBLISHER_RECORD_TYPES,
  derivePublisherId,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createUploadManager } from '../src/upload.js'

const keyPair = seed => crypto.keyPair(b4a.alloc(32, seed))
const hex = value => b4a.toString(value, 'hex')

function rendition(seed = 1) {
  const core = createStaticAssetManifest({
    treeHash: b4a.alloc(32, seed + 1),
    blockLength: 1,
    byteLength: 1024,
  })
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core,
  })
}

function operation(recordType, publisherId, signer, body, sequence) {
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: b4a.from(publisherId),
    signerKey: b4a.from(signer.publicKey),
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: 100,
    canonicalBody: encodePublisherOperationBody(recordType, body),
  }, { hash: crypto.hash })
  return {
    ...attachSignedEnvelopeSignature(
      prepared,
      crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey),
    ),
    body,
  }
}

function makeStore(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `peartube-${label}-`))
  const store = new Corestore(directory)
  t.teardown(async () => {
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return store
}

function makeUploadChannel() {
  let blockOffset = 0
  return {
    blobsKeyHex: hex(b4a.alloc(32, 22)),
    localWriterKeyHex: hex(b4a.alloc(32, 23)),
    blobs: {
      createWriteStream() {
        let byteLength = 0
        const writer = new Writable({
          write(chunk, _encoding, done) {
            byteLength += chunk.byteLength
            done()
          },
          final(done) {
            writer.id.byteLength = byteLength
            done()
          },
        })
        writer.id = { blockOffset: blockOffset++, blockLength: 1, byteOffset: 0, byteLength: 0 }
        return writer
      },
      async get() { return b4a.from('cover-bytes') },
      async clear() {},
    },
    async putBlob(buffer) {
      const offset = blockOffset++
      return { id: `${offset}:1:0:${buffer.byteLength}`, blockOffset: offset, blockLength: 1, byteOffset: 0, byteLength: buffer.byteLength }
    },
    async addVideo(metadata) { this.metadata = metadata },
    async updateVideo(_id, metadata) { this.metadata = metadata },
  }
}

function fakeCatalog({ publisherId, signer, publications, claims }) {
  let authorization = {
    policyEpoch: 0,
    writers: [{
      key: hex(b4a.alloc(32, 90)),
      signerKey: hex(signer.publicKey),
      capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1,
      lastAcceptedSequence: 100,
      expiresAt: 10_000,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  }
  const byKind = { publication: publications, claim: claims }
  return {
    async update() {},
    async getAuthorizationState() { return authorization },
    setAuthorization(value) { authorization = value },
    async listProjections(kind, { cursor = null, limit = 128 } = {}) {
      const rows = [...(byKind[kind] || [])].sort((a, b) => hex(a.body[kind === 'claim' ? 'claimId' : 'publicationId']).localeCompare(hex(b.body[kind === 'claim' ? 'claimId' : 'publicationId'])))
      const start = cursor == null ? 0 : rows.findIndex(row => hex(row.body[kind === 'claim' ? 'claimId' : 'publicationId']) === cursor) + 1
      const items = rows.slice(start, start + limit)
      return { items, nextCursor: start + limit < rows.length ? hex(items.at(-1).body[kind === 'claim' ? 'claimId' : 'publicationId']) : null }
    },
  }
}

test('accepted catalog payloads project canonical manifests and claims with bounded deterministic media pages', async t => {
  const root = keyPair(1)
  const device = keyPair(2)
  const publisherId = derivePublisherId(root.publicKey)
  const publisherIdHex = hex(publisherId)
  const source = rendition(3)
  const manifest = createPublicationManifest({
    publisherId,
    sequence: 1,
    title: 'Catalog title',
    renditions: [source],
    provenance: [{ type: 'upload', renditionId: source.renditionId, assetId: source.core.assetId, coreKey: source.core.key }],
    keyPair: device,
    signedAt: 100,
  })
  const subject = createEntityReference({ namespace: 'catalog-test', entityKind: 'work', normalizedIdentifier: 'one' })
  const claim = createMediaClaim({
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 900,
    issuerSequence: 2,
    policyEpoch: 0,
    keyPair: device,
    signedAt: 100,
  })
  const publicationOperation = operation(PUBLISHER_RECORD_TYPES.PUBLICATION, publisherId, device, {
    publicationId: b4a.from(manifest.publicationId, 'hex'),
    manifestId: b4a.from(manifest.body.manifestId, 'hex'),
    payload: encodePublicationManifest(manifest),
  }, 1)
  const claimOperation = operation(PUBLISHER_RECORD_TYPES.CLAIM, publisherId, device, {
    claimId: b4a.from(claim.claimId, 'hex'),
    claimType: claim.body.claimType,
    payload: encodeMediaClaimEnvelope(claim.envelope),
  }, 2)
  const catalog = fakeCatalog({ publisherId, signer: device, publications: [publicationOperation], claims: [claimOperation] })
  const events = []
  const projection = createPublisherCatalogProjection({
    catalogRegistry: { async listBindings() { return [{ publisherId, catalog }] } },
    now: () => 200,
    onUpdate: event => events.push(event),
  })

  const rebuilt = await projection.rebuild()
  t.is(rebuilt.acceptedPublications, 1)
  t.is(rebuilt.acceptedClaims, 1)
  t.is(projection.assetManifestStore.getManifest(manifest.publicationId).body.manifestId, manifest.body.manifestId)
  t.is(projection.mediaGraphStore.getClaim(claim.claimId).claimId, claim.claimId)
  t.is(projection.mediaGraphStore.getClaim(claim.claimId).publisherId, publisherIdHex,
    'publisher projection retains authenticated root provenance separately from its delegated writer')
  t.alike(projectAuthenticatedPublisherMediaRecords({
    mediaGraphStore: projection.mediaGraphStore,
    assetManifestStore: projection.assetManifestStore,
    moderationPolicy: {
      enabled: true,
      evaluate: entity => entity.publisherId === publisherIdHex
        ? { action: 'hidden', reason: 'blocked-root' }
        : { action: 'visible', reason: 'default' },
    },
  }), [], 'a blocked publisher root filters claims signed by its authenticated delegated writer')

  // Availability carries an observation timestamp, so a projection-determinism
  // comparison has to pin the clock rather than race the wall clock.
  const api = createMediaGraphApi({ ctx: { mediaGraphStore: projection.mediaGraphStore, assetManifestStore: projection.assetManifestStore, mediaCatalogProjection: projection }, now: () => 200 })
  const page = await api.getMediaCatalog({ limitProvided: true, limit: 1 })
  t.is(page.success, true)
  t.is(page.items.length, 1)
  t.is(page.items[0].entityId, subject.entityId)
  t.is(page.items[0].sources[0].publicationId, manifest.publicationId)
  t.is(page.items[0].renditions[0].renditionId, source.renditionId)
  t.is(page.nextCursor, null)
  t.is(events.length, 1)
  t.is(typeof events[0].revision, 'string')
  t.is(events[0].changedCount, 2)

  t.ok(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 0, end: 1 }))
  t.absent(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: -1, end: 1 }))
  t.absent(await projection.authorizeRendition({ manifest: { ...manifest, publicationId: hex(b4a.alloc(32, 99)) }, renditionId: source.renditionId, start: 0, end: 1 }))
  t.absent(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 0, end: 2 }))
  const restartedProjection = createPublisherCatalogProjection({
    catalogRegistry: { async listBindings() { return [{ publisherId, catalog }] } },
    now: () => 200,
  })
  const restarted = await restartedProjection.rebuild()
  const restartedApi = createMediaGraphApi({
    ctx: {
      mediaGraphStore: restartedProjection.mediaGraphStore,
      assetManifestStore: restartedProjection.assetManifestStore,
      mediaCatalogProjection: restartedProjection,
    },
    now: () => 200,
  })
  t.is(restarted.revision, rebuilt.revision)
  t.alike(await restartedApi.getMediaCatalog({ limitProvided: true, limit: 1 }), page)
  await restartedProjection.close()
  await projection.close()
  t.is(publisherIdHex, manifest.body.publisherId)
})

test('nested substitution and currently revoked or stale catalog signers fail closed', async t => {
  const root = keyPair(10)
  const device = keyPair(11)
  const attacker = keyPair(12)
  const publisherId = derivePublisherId(root.publicKey)
  const source = rendition(13)
  const manifest = createPublicationManifest({ publisherId, sequence: 1, title: 'Safe', renditions: [source], keyPair: device, signedAt: 100 })
  const substituted = createPublicationManifest({ publisherId, sequence: 1, title: 'Substituted', renditions: [source], keyPair: attacker, signedAt: 100 })
  const publicationOperation = operation(PUBLISHER_RECORD_TYPES.PUBLICATION, publisherId, device, {
    publicationId: b4a.from(manifest.publicationId, 'hex'),
    manifestId: b4a.from(manifest.body.manifestId, 'hex'),
    payload: encodePublicationManifest(substituted),
  }, 1)
  const claim = createMediaClaim({
    claimType: 'AvailabilityObservation',
    subjectRefs: [createEntityReference({ namespace: 'catalog-test', entityKind: 'work', normalizedIdentifier: 'two' })],
    payload: { publicationId: manifest.publicationId },
    confidence: 1,
    issuerSequence: 2,
    policyEpoch: 0,
    keyPair: attacker,
    signedAt: 100,
  })
  const claimOperation = operation(PUBLISHER_RECORD_TYPES.CLAIM, publisherId, device, {
    claimId: b4a.from(claim.claimId, 'hex'),
    claimType: claim.body.claimType,
    payload: encodeMediaClaimEnvelope(claim.envelope),
  }, 2)
  const catalog = fakeCatalog({ publisherId, signer: device, publications: [publicationOperation], claims: [claimOperation] })
  const projection = createPublisherCatalogProjection({ catalogRegistry: { async listBindings() { return [{ publisherId, catalog }] } }, now: () => 200 })

  const rejected = await projection.rebuild()
  t.is(rejected.acceptedPublications, 0)
  t.is(rejected.acceptedClaims, 0)
  t.absent(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 0, end: 1 }))

  catalog.setAuthorization({
    policyEpoch: 1,
    writers: [{
      key: hex(b4a.alloc(32, 90)), signerKey: hex(device.publicKey), capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1, lastAcceptedSequence: 2, expiresAt: 10_000, admissionPolicyEpoch: 0,
      revocation: { acceptedThroughSequence: 2, policyEpoch: 1 },
    }],
  })
  const revoked = await projection.rebuild()
  t.is(revoked.acceptedPublications, 0)
  t.is(revoked.acceptedClaims, 0)

  catalog.setAuthorization({
    policyEpoch: 1,
    writers: [{
      key: hex(b4a.alloc(32, 90)), signerKey: hex(device.publicKey), capabilities: ['claim', 'publish'],
      firstAcceptedSequence: 1, lastAcceptedSequence: 2, expiresAt: 150, admissionPolicyEpoch: 0, revocation: null,
    }],
  })
  const stale = await projection.rebuild()
  t.is(stale.acceptedPublications, 0)
  t.is(stale.acceptedClaims, 0)
})

test('catalog projection reruns when an update arrives during an in-flight rebuild', async t => {
  let releaseFirstScan
  const firstScan = new Promise(resolve => { releaseFirstScan = resolve })
  let scans = 0
  const catalog = {
    async update() {},
    // What a pass actually reads a binding through, so counting these counts
    // passes.
    async getAuthorizationState() {
      scans++
      if (scans === 1) await firstScan
      return { policyEpoch: 0, writers: [] }
    },
    async listProjections() { return { items: [], nextCursor: null } },
  }
  const projection = createPublisherCatalogProjection({
    catalogRegistry: {
      async listBindings() { return [{ publisherId: b4a.alloc(32, 1), catalog }] },
    },
  })

  const first = projection.rebuild()
  await Promise.resolve()
  const second = projection.rebuild()
  releaseFirstScan()
  await Promise.all([first, second])

  t.is(scans, 2, 'an overlapping rebuild request is not absorbed')
  await projection.close()
})

// A publisher catalog answers from an Autobase view, and both the advance before
// a read and the view read itself wait on peers with no bound. Seen on a live
// relay: one bound catalog went quiet and every projection pass behind it hung,
// so the boot-time rebuild never returned and the relay never opened its port.
test('a binding that stops answering is carried forward instead of hanging the projection', async t => {
  const root = keyPair(40)
  const device = keyPair(41)
  const publisherId = derivePublisherId(root.publicKey)
  const source = rendition(42)
  const manifest = createPublicationManifest({
    publisherId,
    sequence: 1,
    title: 'Held open by a quiet peer',
    renditions: [source],
    provenance: [{ type: 'upload', renditionId: source.renditionId, coreKey: source.core.key, start: 0, end: 4 }],
    keyPair: device,
    signedAt: 100,
  })
  const publicationOperation = operation(PUBLISHER_RECORD_TYPES.PUBLICATION, publisherId, device, {
    publicationId: b4a.from(manifest.publicationId, 'hex'),
    manifestId: b4a.from(manifest.body.manifestId, 'hex'),
    payload: encodePublicationManifest(manifest),
  }, 1)

  const answering = fakeCatalog({ publisherId, signer: device, publications: [publicationOperation], claims: [] })
  let quiet = false
  const catalog = {
    ...answering,
    async getAuthorizationState() {
      if (quiet) await new Promise(() => {})
      return answering.getAuthorizationState()
    },
  }
  const projection = createPublisherCatalogProjection({
    catalogRegistry: { async listBindings() { return [{ publisherId, catalog }] } },
    now: () => 200,
    bindingScanTimeoutMs: 50,
  })

  const first = await projection.rebuild()
  t.is(first.acceptedPublications, 1)

  quiet = true
  const stalled = await projection.rebuild()
  t.is(stalled.acceptedPublications, 1, 'a publication does not vanish because its publisher went quiet')
  t.is(projection.assetManifestStore.getManifest(manifest.publicationId).body.manifestId, manifest.body.manifestId)
  t.is(projection.revision, first.revision, 'and the projection is unchanged rather than emptied')

  await projection.close()
})

test('a binding that has never answered is skipped rather than held onto', async t => {
  const publisherId = b4a.alloc(32, 7)
  const projection = createPublisherCatalogProjection({
    catalogRegistry: {
      async listBindings() {
        return [{
          publisherId,
          catalog: {
            async update() {},
            async getAuthorizationState() { return new Promise(() => {}) },
            async listProjections() { return { items: [], nextCursor: null } },
          },
        }]
      },
    },
    bindingScanTimeoutMs: 50,
  })

  const rebuilt = await projection.rebuild()
  t.is(rebuilt.acceptedPublications, 0, 'the pass completes instead of waiting on a peer that never answers')
  t.is(rebuilt.acceptedClaims, 0)

  await projection.close()
})

test('episode upload publishes canonical collection claims and projects an ordered incomplete series', async t => {
  const root = keyPair(20)
  const device = keyPair(21)
  const publisherId = derivePublisherId(root.publicKey)
  const appended = []
  let lastAcceptedSequence = 0
  const catalog = {
    writable: true,
    localSignerKey: device.publicKey,
    async getAuthorizationState() {
      return {
        policyEpoch: 0,
        writers: [{
          key: hex(b4a.alloc(32, 91)),
          signerKey: hex(device.publicKey),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence,
          expiresAt: 10_000,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async createLocalOperation({ recordType, policyEpoch, sequence, signedAt, body }) {
      return { ...operation(recordType, publisherId, device, body, sequence), signedAt }
    },
    async appendBatchAndConfirm(values) {
      lastAcceptedSequence = values.at(-1).issuerSequence
      appended.push(...values)
      return values.map((value, index) => ({
        operationId: b4a.from(value.recordId || b4a.alloc(32, index + 1)),
        accepted: true,
      }))
    },
  }
  const binding = { publisherId, catalog }
  const store = makeStore(t, 'media-catalog-upload')
  const joined = []
  const retained = []
  const lifecycle = []
  let rebuilt = 0
  const manager = createUploadManager({
    ctx: { store },
    catalogRegistry: {
      async getWritableBindings() { return [binding] },
      async resolve() { return binding },
    },
    mediaCatalogProjection: {
      async rebuild() {
        rebuilt++
        lifecycle.push('rebuild')
      },
    },
    scopedNetwork: {
      async retainAuthorizedRendition(value) {
        lifecycle.push('retain')
        retained.push(value)
        return { status: 'retained' }
      },
      async publishLocalPublisherCatalog(value) {
        lifecycle.push('publish')
        joined.push(value)
        return { status: 'published' }
      },
    },
    deviceKeyPair: device,
    now: () => 200,
  })
  const channel = makeUploadChannel()

  const handlerBackend = {}
  const handlerResults = []
  attachMobileHandlers(handlerBackend, {
    api: {},
    identityManager: {
      getActiveIdentity: () => ({ driveKey: 'active-drive' }),
      getActiveChannel: async () => channel,
      getIdentities: () => [],
    },
    uploadManager: {
      async uploadFromPath(target, filePath, options) {
        const uploaded = await manager.uploadFromBuffer(target, b4a.from(filePath), options)
        handlerResults.push(uploaded)
        return uploaded
      },
    },
    ctx: {},
    initializeIdentityFromMnemonic: async () => ({}),
    rpc: { eventUploadProgress() {} },
    fs: {},
    path: {},
    generateAndStoreThumbnail: async () => null,
    transcoder: {},
    castTranscoder: {},
    player: 'exoplayer',
  })

  const result = await handlerBackend.uploadVideo({
    filePath: '/fixtures/first.webm',
    title: 'Pilot',
    description: '',
    skipThumbnailGeneration: true,
    contentKind: 'episode',
    mediaProvider: 'tmdb',
    mediaId: '42',
    seasonNumber: 2,
    episodeNumber: 1,
    seriesId: 'show-42',
    seriesTitle: 'Authenticated Show',
    expectedEpisodeCount: 4,
  })
  t.ok(result.video.id)
  t.alike(appended.map(value => value.recordType), [
    PUBLISHER_RECORD_TYPES.PUBLICATION,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
  ])
  t.is(rebuilt, 1)
  t.is(joined.length, 1)
  t.is(joined[0].publisherId, hex(publisherId))
  t.alike(lifecycle, ['rebuild', 'retain', 'publish'])
  t.is(retained.length, 1)
  // The handler returns a view for the app; the upload result it recorded is
  // what carries the publication, so the manifest assertions read that.
  t.is(retained[0].manifest, handlerResults[0].manifest)
  t.is(retained[0].renditionId, handlerResults[0].renditionId)
  t.ok(handlerResults[0].metadata.immutablePublication?.manifest)
  t.ok((await handlerBackend.uploadVideo({
    filePath: '/fixtures/second.webm',
    title: 'Second',
    description: '',
    skipThumbnailGeneration: true,
    contentKind: 'episode',
    mediaProvider: 'tmdb',
    mediaId: '42',
    seasonNumber: 1,
    episodeNumber: 2,
    seriesId: 'show-42',
    seriesTitle: 'Authenticated Show',
    expectedEpisodeCount: 4,
  })).video.id)
  t.ok((await handlerBackend.uploadVideo({
    filePath: '/fixtures/movie.webm',
    title: 'Authenticated Movie',
    description: '',
    skipThumbnailGeneration: true,
  })).video.id)
  const projectedCatalog = fakeCatalog({
    publisherId,
    signer: device,
    publications: appended.filter(value => value.recordType === PUBLISHER_RECORD_TYPES.PUBLICATION),
    claims: appended.filter(value => value.recordType === PUBLISHER_RECORD_TYPES.CLAIM),
  })
  const publisherProjection = createPublisherCatalogProjection({
    catalogRegistry: { async listBindings() { return [{ publisherId, catalog: projectedCatalog }] } },
    now: () => 300,
  })
  await publisherProjection.rebuild()
  const consumerProjection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    publisherRecords: () => projectAuthenticatedPublisherMediaRecords({
      mediaGraphStore: publisherProjection.mediaGraphStore,
      assetManifestStore: publisherProjection.assetManifestStore,
    }),
  })
  consumerProjection.rebuild()
  const catalogItems = consumerProjection.getCatalog().items
  t.alike(catalogItems.map(item => item.entityKind), ['movie', 'series'])
  const series = catalogItems[1]
  t.is(series.entityKind, 'series')
  t.is(series.title, 'Authenticated Show')
  t.alike(series.series.seasons.map(season => [
    season.seasonNumber,
    season.episodes.map(episode => episode.episodeNumber),
  ]), [[1, [2]], [2, [1]]])
  t.is(series.series.expectedEpisodes, 4)
  t.is(series.series.availableEpisodes, 2)
  t.is(series.series.complete, false)
  t.is(rebuilt, 3)
  t.is(joined.length, 3)
})

test('concurrent uploads reserve disjoint catalog sequence batches without partial publication', async t => {
  const root = keyPair(30)
  const device = keyPair(31)
  const publisherId = derivePublisherId(root.publicKey)
  let lastAcceptedSequence = 0
  const batches = []
  const catalog = {
    writable: true,
    localSignerKey: device.publicKey,
    async getAuthorizationState() {
      return {
        policyEpoch: 0,
        writers: [{
          key: hex(b4a.alloc(32, 92)),
          signerKey: hex(device.publicKey),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence,
          expiresAt: 10_000,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async createLocalOperation({ recordType, policyEpoch, sequence, signedAt, body }) {
      return operation(recordType, publisherId, device, body, sequence)
    },
    async appendBatchAndConfirm(values) {
      await new Promise(resolve => setTimeout(resolve, 10))
      const expected = lastAcceptedSequence + 1
      if (values[0]?.issuerSequence !== expected) return values.map(() => ({ accepted: false }))
      lastAcceptedSequence += values.length
      batches.push(values)
      return values.map((_value, index) => ({ operationId: b4a.alloc(32, index + 1), accepted: true }))
    },
  }
  const binding = { publisherId, catalog }
  const store = makeStore(t, 'media-catalog-concurrent-upload')
  const manager = createUploadManager({
    ctx: { store },
    catalogRegistry: {
      async getWritableBindings() { return [binding] },
      async resolve() { return binding },
    },
    mediaCatalogProjection: { async rebuild() {} },
    scopedNetwork: {
      async retainAuthorizedRendition() { return { status: 'retained' } },
      async publishLocalPublisherCatalog() { return { status: 'published' } },
    },
    deviceKeyPair: device,
    now: () => 300,
  })
  const channel = makeUploadChannel()

  const [first, second] = await Promise.all([
    manager.uploadFromBuffer(channel, b4a.from('first'), { title: 'First', mimeType: 'video/webm' }),
    manager.uploadFromBuffer(channel, b4a.from('second'), { title: 'Second', mimeType: 'video/webm' }),
  ])

  t.is(first.success, true)
  t.is(second.success, true)
  t.alike(batches.map(batch => batch.map(value => value.issuerSequence)), [[1, 2, 3], [4, 5, 6]])
})

// Relays exist for availability: a peer that seeds a title has to be able to
// answer for what it looks like too. That only holds if the cover is part of
// the publication rather than a side channel, so it rides the signed manifest
// as a rendition and travels the same authorized asset path as the video.
test('a published cover rides the manifest and never stands in for the media', async t => {
  const retained = []
  const root = keyPair(40)
  const device = keyPair(41)
  const publisherId = derivePublisherId(root.publicKey)
  let lastAcceptedSequence = 0
  const catalog = {
    writable: true,
    localSignerKey: device.publicKey,
    async getAuthorizationState() {
      return {
        policyEpoch: 0,
        writers: [{
          key: hex(b4a.alloc(32, 92)),
          signerKey: hex(device.publicKey),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence,
          expiresAt: 10_000,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async createLocalOperation({ recordType, policyEpoch, sequence, signedAt, body }) {
      return { ...operation(recordType, publisherId, device, body, sequence), signedAt }
    },
    async appendBatchAndConfirm(values) {
      lastAcceptedSequence = values.at(-1).issuerSequence
      return values.map((value, index) => ({
        operationId: b4a.from(value.recordId || b4a.alloc(32, index + 1)),
        accepted: true,
      }))
    },
  }
  const binding = { publisherId, catalog }
  const manager = createUploadManager({
    // The static-core rendition write needs a real Corestore, same as the
    // other upload tests in this file.
    ctx: { store: makeStore(t, 'media-catalog-cover-upload') },
    catalogRegistry: {
      async getWritableBindings() { return [binding] },
      async resolve() { return binding },
    },
    mediaCatalogProjection: { async rebuild() {} },
    scopedNetwork: {
      async publishLocalPublisherCatalog() { return { status: 'published' } },
      async retainAuthorizedRendition(request) { retained.push(request); return { status: 'retained' } },
    },
    deviceKeyPair: device,
    now: () => 200,
  })
  // The publication path writes the rendition through a real blob stream, so
  // this test uses the same channel fixture as the other upload tests.
  const channel = makeUploadChannel()
  const blobsKeyHex = channel.blobsKeyHex

  const result = await manager.uploadFromBuffer(channel, b4a.from('video-bytes'), {
    title: 'Illustrated',
    mimeType: 'video/webm',
    publicationState: 'published',
    artwork: [{ role: 'poster', blobId: '7:1:900:53905', blobsCoreKey: blobsKeyHex, mimeType: 'image/jpeg' }],
  })

  t.is(result.success, true)
  const manifest = result.metadata.immutablePublication.manifest
  const renditions = manifest.body.renditions
  t.is(renditions.length, 2, 'the cover is published with the media, not separately')

  const poster = renditions.find(rendition => rendition.purpose === 'poster')
  t.ok(poster, 'the manifest carries the cover as a rendition a peer can be authorized for')
  t.is(poster.format, 'image/jpeg')
  // A v2 rendition names a static asset core, so the cover gets one of its own
  // rather than borrowing a block range out of the channel's blob core.
  t.is(poster.core.kind, 'static-prologue-v1')
  t.is(poster.core.assetId, poster.core.key, 'the cover is addressed as its own asset')
  t.not(poster.core.key, blobsKeyHex, 'the cover is a published asset, not a blob reference')

  // The whole point of the provenance entry: byteOffset cannot be recovered
  // from a block range, and reading the wrong offset returns the wrong bytes.
  const provenance = manifest.body.provenance.find(entry => entry.type === 'artwork')
  t.ok(provenance, 'the cover has provenance of its own')
  t.is(provenance.blobId, '7:1:900:53905', 'the exact blob a peer must ask for survives verbatim')
  t.is(provenance.renditionId, poster.renditionId, 'provenance names the rendition it describes')

  t.is(
    result.metadata.immutablePublication.renditionId,
    renditions.find(rendition => rendition.purpose === 'original').renditionId,
    'the publication still plays the media, never the cover',
  )

  // Announcing a catalog only says the title exists. A consumer looks for the
  // bytes on the rendition's asset scope, so a publisher that never joins it is
  // a title nobody can fetch: catalog syncs, sources read awaiting replication.
  // The cover is retained too: a relay that seeds this movie holds the poster,
  // so a consumer fetches both over the same authorized asset path.
  t.is(retained.length, 2, 'publishing makes the publisher a source for its own title')
  const retainedMedia = retained.find(request =>
    request.renditionId === renditions.find(rendition => rendition.purpose === 'original').renditionId)
  t.ok(retainedMedia, 'the media rendition is held')
  t.is(retainedMedia.ownerId, manifest.publicationId, 'it is held as the publication it belongs to')
  t.ok(retained.some(request => request.renditionId === poster.renditionId), 'the cover is held as well')
})

test('an upload with no cover publishes exactly one rendition', async t => {
  const root = keyPair(44)
  const device = keyPair(45)
  const publisherId = derivePublisherId(root.publicKey)
  let lastAcceptedSequence = 0
  const catalog = {
    writable: true,
    localSignerKey: device.publicKey,
    async getAuthorizationState() {
      return {
        policyEpoch: 0,
        writers: [{
          key: hex(b4a.alloc(32, 93)),
          signerKey: hex(device.publicKey),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence,
          expiresAt: 10_000,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async createLocalOperation({ recordType, policyEpoch, sequence, signedAt, body }) {
      return { ...operation(recordType, publisherId, device, body, sequence), signedAt }
    },
    async appendBatchAndConfirm(values) {
      lastAcceptedSequence = values.at(-1).issuerSequence
      return values.map((value, index) => ({ operationId: b4a.from(value.recordId || b4a.alloc(32, index + 1)), accepted: true }))
    },
  }
  const binding = { publisherId, catalog }
  const manager = createUploadManager({
    ctx: { store: makeStore(t, 'media-catalog-plain-upload') },
    catalogRegistry: { async getWritableBindings() { return [binding] }, async resolve() { return binding } },
    mediaCatalogProjection: { async rebuild() {} },
    scopedNetwork: { async publishLocalPublisherCatalog() { return { status: 'published' } } },
    deviceKeyPair: device,
    now: () => 200,
  })
  // Same channel surface as the other publication tests: the rendition is
  // written through a blob stream and finalized through the channel.
  const channel = makeUploadChannel()

  const result = await manager.uploadFromBuffer(channel, b4a.from('video-bytes'), {
    title: 'Plain',
    mimeType: 'video/webm',
    publicationState: 'published',
  })

  t.is(result.success, true)
  t.is(result.metadata.immutablePublication.manifest.body.renditions.length, 1,
    'nothing invents a cover rendition for a title that has none')
})
