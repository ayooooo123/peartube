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
import { createPublisherCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createEntityReference, createMediaClaim, encodeMediaClaimEnvelope } from '../src/media-graph/index.js'
import { PUBLISHER_RECORD_TYPES, derivePublisherId } from '../src/publisher/index.js'
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
  return {
    recordType,
    issuerIdentityKey: b4a.from(publisherId),
    signerKey: b4a.from(signer.publicKey),
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: 100,
    recordId: b4a.alloc(32, sequence),
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
      async clear() {},
    },
    async putBlob(buffer) {
      const offset = blockOffset++
      return { id: `${offset}:1:0:${buffer.byteLength}`, blockOffset: offset, blockLength: 1, byteOffset: 0, byteLength: buffer.byteLength }
    },
    async addVideo(metadata) { this.metadata = metadata },
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

  const api = createMediaGraphApi({ ctx: { mediaGraphStore: projection.mediaGraphStore, assetManifestStore: projection.assetManifestStore, mediaCatalogProjection: projection } })
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

test('upload confirms publication and canonical claims before joining its publisher scope', async t => {
  const root = keyPair(20)
  const device = keyPair(21)
  const publisherId = derivePublisherId(root.publicKey)
  const appended = []
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
          lastAcceptedSequence: 0,
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

  const result = await manager.uploadFromBuffer(channel, b4a.from('not-an-mp4'), { title: 'Uploaded', mimeType: 'video/webm' })
  t.is(result.success, true)
  t.alike(appended.map(value => value.recordType), [
    PUBLISHER_RECORD_TYPES.PUBLICATION,
    PUBLISHER_RECORD_TYPES.CLAIM,
    PUBLISHER_RECORD_TYPES.CLAIM,
  ])
  t.ok(result.metadata.immutablePublication?.manifest)
  t.is(rebuilt, 1)
  t.is(joined.length, 1)
  t.ok(b4a.equals(joined[0].publisherId, publisherId))
  t.alike(lifecycle, ['rebuild', 'retain', 'publish'])
  t.is(retained.length, 1)
  t.is(retained[0].manifest, result.manifest)
  t.is(retained[0].renditionId, result.renditionId)
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
