import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createPublicationManifest, createRenditionDescriptor, encodePublicationManifest } from '../src/assets/index.js'
import {
  createConsumerCatalogProjection,
  createPublisherCatalogProjection,
  projectAuthenticatedPublisherMediaRecords,
} from '../src/media-graph/catalog-projection.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'
import { createEntityReference, createMediaClaim, encodeMediaClaimEnvelope } from '../src/media-graph/index.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { PUBLISHER_RECORD_TYPES, derivePublisherId } from '../src/publisher/index.js'
import { createUploadManager } from '../src/upload.js'

const keyPair = seed => crypto.keyPair(b4a.alloc(32, seed))
const hex = value => b4a.toString(value, 'hex')

function rendition(seed = 1) {
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: {
      key: hex(b4a.alloc(32, seed)),
      length: 8,
      treeHash: hex(b4a.alloc(32, seed + 1)),
      byteLength: 1024,
    },
  })
}

function operation(recordType, publisherId, signer, body, sequence) {
  return {
    recordType,
    issuerIdentityKey: b4a.from(publisherId),
    signerKey: b4a.from(signer.publicKey),
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: 100,
    body,
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
    provenance: [{ type: 'upload', renditionId: source.renditionId, coreKey: source.core.key, start: 2, end: 4 }],
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

  t.ok(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 2, end: 4 }))
  t.absent(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 0, end: 4 }))
  t.absent(await projection.authorizeRendition({ manifest: { ...manifest, publicationId: hex(b4a.alloc(32, 99)) }, renditionId: source.renditionId, start: 2, end: 4 }))
  t.absent(await projection.authorizeRendition({ manifest, renditionId: source.renditionId, start: 2, end: 9 }))
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
  let releaseFirstUpdate
  const firstUpdate = new Promise(resolve => { releaseFirstUpdate = resolve })
  let updateCalls = 0
  const catalog = {
    async update() {
      updateCalls++
      if (updateCalls === 1) await firstUpdate
    },
    async getAuthorizationState() { return { policyEpoch: 0, writers: [] } },
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
  releaseFirstUpdate()
  await Promise.all([first, second])

  t.is(updateCalls, 2, 'an overlapping rebuild request is not absorbed')
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
  const joined = []
  let rebuilt = 0
  const manager = createUploadManager({
    ctx: {},
    catalogRegistry: {
      async getWritableBindings() { return [binding] },
      async resolve() { return binding },
    },
    mediaCatalogProjection: { async rebuild() { rebuilt++ } },
    scopedNetwork: { async publishLocalPublisherCatalog(value) { joined.push(value); return { status: 'published' } } },
    deviceKeyPair: device,
    now: () => 200,
  })
  const channel = {
    blobs: true,
    blobsKeyHex: hex(b4a.alloc(32, 22)),
    localWriterKeyHex: hex(b4a.alloc(32, 23)),
    async putBlob(buffer) {
      return { id: `0:1:0:${buffer.byteLength}`, blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: buffer.byteLength }
    },
    async addVideo(metadata) { this.metadata = metadata },
  }

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
  t.ok(b4a.equals(joined[0].publisherId, publisherId))
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
  const manager = createUploadManager({
    ctx: {},
    catalogRegistry: {
      async getWritableBindings() { return [binding] },
      async resolve() { return binding },
    },
    mediaCatalogProjection: { async rebuild() {} },
    scopedNetwork: { async publishLocalPublisherCatalog() { return { status: 'published' } } },
    deviceKeyPair: device,
    now: () => 300,
  })
  let blobOffset = 0
  const channel = {
    blobs: true,
    blobsKeyHex: hex(b4a.alloc(32, 32)),
    localWriterKeyHex: hex(b4a.alloc(32, 33)),
    async putBlob(buffer) {
      const blockOffset = blobOffset++
      return { id: `${blockOffset}:1:0:${buffer.byteLength}`, blockOffset, blockLength: 1, byteOffset: 0, byteLength: buffer.byteLength }
    },
    async addVideo() {},
  }

  const [first, second] = await Promise.all([
    manager.uploadFromBuffer(channel, b4a.from('first'), { title: 'First', mimeType: 'video/webm' }),
    manager.uploadFromBuffer(channel, b4a.from('second'), { title: 'Second', mimeType: 'video/webm' }),
  ])

  t.is(first.success, true)
  t.is(second.success, true)
  t.alike(batches.map(batch => batch.map(value => value.issuerSequence)), [[1, 2, 3], [4, 5, 6]])
})
