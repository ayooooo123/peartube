import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import Corestore from 'corestore'
import crypto from 'hypercore-crypto'

import { decodePublicationManifest } from '../src/assets/index.js'
import { createUploadManager } from '../src/upload.js'

function makeChannel() {
  const videos = []
  const blobWrites = []
  return {
    localWriterKeyHex: '11'.repeat(32),
    blobsKeyHex: '22'.repeat(32),
    videos,
    blobWrites,
    blobs: {
      createWriteStream() {
        const chunks = []
        const writer = new Writable({
          write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk))
            done()
          },
          final(done) {
            const bytes = Buffer.concat(chunks)
            blobWrites.push(bytes)
            writer.id.byteLength = bytes.byteLength
            done()
          },
        })
        writer.id = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 0 }
        return writer
      },
      async clear() {},
    },
    async putBlob(buffer) {
      blobWrites.push(Buffer.from(buffer))
      return { id: `0:1:0:${buffer.byteLength}` }
    },
    async addVideo(metadata) {
      videos.push(metadata)
    },
    async deleteVideo(id) {
      const index = videos.findIndex(video => video.id === id)
      if (index >= 0) videos.splice(index, 1)
    },
  }
}

function makeStore(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `peartube-${label}-`))
  const store = new Corestore(directory)
  t.after(async () => {
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return store
}

function makeCatalog(deviceKeyPair, appended, counters = {}) {
  return {
    writable: true,
    localSignerKey: deviceKeyPair.publicKey,
    async getAuthorizationState() {
      return {
        writers: [{
          signerKey: Buffer.from(deviceKeyPair.publicKey).toString('hex'),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async createLocalOperation(value) {
      counters.created = (counters.created || 0) + 1
      return { ...value, recordId: Buffer.alloc(32, value.sequence) }
    },
    async appendBatchAndConfirm(operations) {
      counters.appended = (counters.appended || 0) + 1
      appended.push(operations)
      return operations.map(() => ({ accepted: true }))
    },
  }
}

function makePublishingManager({ store, deviceKeyPair, catalog, scopedNetwork = null, mediaCatalogProjection = null }) {
  return createUploadManager({
    ctx: { store },
    deviceKeyPair,
    catalogRegistry: {
      async getWritableBindings() {
        return [{ publisherId: deviceKeyPair.publicKey, catalog }]
      },
    },
    mediaCatalogProjection,
    scopedNetwork: scopedNetwork || {
      async retainAuthorizedRendition() { return { status: 'retained' } },
      async publishLocalPublisherCatalog() { return { status: 'published' } },
    },
    now: () => 1_700_000_000_000,
  })
}

test('uploadFromBuffer marks Matroska uploads playable with unverified playback support', async () => {
  const manager = createUploadManager({ ctx: {} })
  const channel = makeChannel()
  const header = Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    Buffer.from('matroska'),
    Buffer.alloc(32),
  ])

  const result = await manager.uploadFromBuffer(channel, header, { title: 'Movie' })

  assert.equal(result.success, true)
  assert.equal(result.metadata.mimeType, 'video/x-matroska')
  assert.equal(result.metadata.availability, 'playable')
  assert.equal(result.metadata.playbackSupport, 'unverified-container')
  assert.equal(channel.videos[0].playbackSupport, 'unverified-container')
})

test('published uploads use one verified static descriptor and converge across publisher stores', async (t) => {
  const bytes = Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    Buffer.from('same immutable publication bytes'),
  ])
  const stores = [makeStore(t, 'static-upload-a'), makeStore(t, 'static-upload-b')]
  const devices = [
    crypto.keyPair(Buffer.alloc(32, 3)),
    crypto.keyPair(Buffer.alloc(32, 4)),
  ]
  const appended = [[], []]
  const results = []

  for (let index = 0; index < stores.length; index++) {
    const catalog = makeCatalog(devices[index], appended[index])
    const manager = makePublishingManager({
      store: stores[index],
      deviceKeyPair: devices[index],
      catalog,
    })
    results.push(await manager.uploadFromBuffer(
      makeChannel(),
      bytes,
      { title: 'Convergent fixture', mimeType: 'video/webm' },
    ))
  }

  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    assert.equal(result.success, true)
    const storedManifest = decodePublicationManifest(appended[index][0][0].body.payload)
    const storedCore = storedManifest.body.renditions[0].core
    assert.equal(result.publicationId, storedManifest.publicationId)
    assert.equal(result.manifestId, storedManifest.body.manifestId)
    assert.equal(result.renditionId, storedManifest.body.renditions[0].renditionId)
    assert.equal(result.assetId, storedCore.assetId)
    assert.equal(result.coreKey, storedCore.key)
    assert.equal(result.manifest.body.renditions[0].core.kind, 'static-prologue-v1')
    assert.equal(result.assetId, result.manifest.body.renditions[0].core.assetId)
    assert.equal(result.coreKey, result.manifest.body.renditions[0].core.key)
    assert.equal('start' in result.manifest.body.provenance[0], false)
    assert.equal('end' in result.manifest.body.provenance[0], false)
  }

  assert.equal(results[0].assetId, results[1].assetId)
  assert.equal(results[0].coreKey, results[1].coreKey)
  assert.notEqual(results[0].publicationId, results[1].publicationId)
  assert.notEqual(results[0].manifest.body.publisherId, results[1].manifest.body.publisherId)
})

test('path publication materializes the file once and derives playback bytes from the verified core', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-static-path-'))
  const filePath = path.join(directory, 'fixture.webm')
  const bytes = Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    Buffer.from('single immutable path source'),
  ])
  fs.writeFileSync(filePath, bytes)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = makeStore(t, 'static-path-store')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 6))
  const appended = []
  const channel = makeChannel()
  let sourceReads = 0
  const fileSystem = {
    statSync: fs.statSync,
    createReadStream(pathname, options) {
      sourceReads++
      return fs.createReadStream(pathname, options)
    },
  }
  const result = await makePublishingManager({
    store,
    deviceKeyPair,
    catalog: makeCatalog(deviceKeyPair, appended),
  }).uploadFromPath(channel, filePath, { title: 'One source' }, fileSystem)

  assert.equal(result.success, true)
  assert.equal(sourceReads, 1)
  assert.deepEqual(channel.blobWrites, [bytes])
  assert.equal(result.manifest.body.renditions[0].core.byteLength, bytes.byteLength)
})

test('mid-signing cancellation appends no catalog batch', async (t) => {
  const store = makeStore(t, 'cancelled-signing-upload')
  const controller = new AbortController()
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 8))
  let created = 0
  let appended = 0
  const catalog = makeCatalog(deviceKeyPair, [], {})
  const createLocalOperation = catalog.createLocalOperation
  catalog.createLocalOperation = async (value) => {
    const operation = await createLocalOperation(value)
    created++
    if (created === 1) controller.abort()
    return operation
  }
  catalog.appendBatchAndConfirm = async () => {
    appended++
    return []
  }
  const channel = makeChannel()
  const result = await makePublishingManager({
    store,
    deviceKeyPair,
    catalog,
  }).uploadFromBuffer(
    channel,
    Buffer.from('cancel while signing'),
    { title: 'Cancelled signing', mimeType: 'video/webm', signal: controller.signal },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /cancelled/)
  assert.equal(created, 1)
  assert.equal(appended, 0)
  assert.equal(channel.videos.length, 0)
})

test('publisher announcement failure does not release a pre-retained rendition', async (t) => {
  const store = makeStore(t, 'pre-retained-upload')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 10))
  const catalog = makeCatalog(deviceKeyPair, [])
  let releases = 0
  const scopedNetwork = {
    async retainAuthorizedRendition() {
      return { status: 'already-retained' }
    },
    async publishLocalPublisherCatalog() {
      throw new Error('injected publisher announcement failure')
    },
    async releaseAuthorizedRendition() {
      releases++
      return { status: 'released' }
    },
  }
  const result = await makePublishingManager({
    store,
    deviceKeyPair,
    catalog,
    scopedNetwork,
  }).uploadFromBuffer(
    makeChannel(),
    Buffer.from('pre-retained immutable asset'),
    { title: 'Pre-retained', mimeType: 'video/webm' },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /announcement failure/)
  assert.equal(releases, 0)
})

test('local metadata failure emits no catalog operation and acquires no retention', async (t) => {
  const store = makeStore(t, 'metadata-failure-upload')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 11))
  const appended = []
  const counters = {}
  const catalog = makeCatalog(deviceKeyPair, appended, counters)
  let retentions = 0
  const channel = makeChannel()
  channel.addVideo = async () => {
    throw new Error('injected local metadata failure')
  }
  const result = await makePublishingManager({
    store,
    deviceKeyPair,
    catalog,
    scopedNetwork: {
      async retainAuthorizedRendition() {
        retentions++
        return { status: 'retained' }
      },
    },
  }).uploadFromBuffer(
    channel,
    Buffer.from('metadata must precede publication'),
    { title: 'Metadata failure', mimeType: 'video/webm' },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /local metadata failure/)
  assert.equal(counters.appended || 0, 0)
  assert.deepEqual(appended, [])
  assert.equal(retentions, 0)
})

test('catalog rejection with staged metadata rollback failure reconciles deterministically on retry', async (t) => {
  const store = makeStore(t, 'staged-rollback-retry')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 12))
  const appended = []
  const catalog = makeCatalog(deviceKeyPair, appended)
  const acceptBatch = catalog.appendBatchAndConfirm.bind(catalog)
  let appendAttempts = 0
  catalog.appendBatchAndConfirm = async operations => {
    appendAttempts++
    if (appendAttempts === 1) return operations.map(() => ({ accepted: false }))
    return acceptBatch(operations)
  }
  const channel = makeChannel()
  const cleared = []
  channel.blobs.clear = async value => {
    cleared.push(value)
  }
  channel.getVideo = async id => channel.videos.find(video => video.id === id) || null
  const deleteVideo = channel.deleteVideo.bind(channel)
  let deleteAttempts = 0
  channel.deleteVideo = async id => {
    deleteAttempts++
    if (deleteAttempts === 1) throw new Error('injected staged metadata delete failure')
    return deleteVideo(id)
  }
  const manager = makePublishingManager({ store, deviceKeyPair, catalog })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-upload-retry-'))
  const filePath = path.join(directory, 'video.webm')
  fs.writeFileSync(filePath, Buffer.from('deterministic rollback retry'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = {
    videoId: 'ab'.repeat(16),
    title: 'Rollback retry',
    mimeType: 'video/webm',
  }

  const rejected = await manager.uploadFromPath(channel, filePath, options, fs)
  assert.equal(rejected.success, false)
  assert.equal(rejected.rollbackPending, true)
  assert.match(rejected.error, /rollback.*pending/i)
  assert.equal(channel.videos.length, 1)
  assert.equal(channel.videos[0].publicationState, 'replicationPending')
  assert.equal(cleared.length, 1, 'blob clear completes before pending metadata deletion is attempted')

  const retried = await manager.uploadFromPath(channel, filePath, options, fs)
  assert.equal(retried.success, true)
  assert.equal(retried.reused, undefined)
  assert.equal(appendAttempts, 2)
  assert.equal(channel.videos.length, 1)
  assert.equal(channel.videos[0].publicationState, 'published')
  assert.equal(cleared.length, 2, 'retry may idempotently clear before deleting the durable anchor')
  assert.equal(channel.blobWrites.length, 2, 'retry writes one replacement playback blob')
})

test('buffer upload reconciles rollback-pending metadata with the same deterministic id', async (t) => {
  const store = makeStore(t, 'buffer-staged-rollback-retry')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 13))
  const appended = []
  const catalog = makeCatalog(deviceKeyPair, appended)
  const acceptBatch = catalog.appendBatchAndConfirm.bind(catalog)
  let appendAttempts = 0
  catalog.appendBatchAndConfirm = async operations => {
    appendAttempts++
    if (appendAttempts === 1) return operations.map(() => ({ accepted: false }))
    return acceptBatch(operations)
  }
  const channel = makeChannel()
  const cleared = []
  let clearAttempts = 0
  channel.blobs.clear = async value => {
    cleared.push(value)
    clearAttempts++
    if (clearAttempts === 1) throw new Error('injected mobile staged blob clear failure')
  }
  channel.getVideo = async id => channel.videos.find(video => video.id === id) || null
  const deleteVideo = channel.deleteVideo.bind(channel)
  let deleteAttempts = 0
  channel.deleteVideo = async id => {
    deleteAttempts++
    if (deleteAttempts === 1) throw new Error('injected mobile staged metadata delete failure')
    return deleteVideo(id)
  }
  const manager = makePublishingManager({ store, deviceKeyPair, catalog })
  const buffer = Buffer.from('deterministic mobile rollback retry')
  const options = {
    videoId: 'cd'.repeat(16),
    title: 'Mobile rollback retry',
    mimeType: 'video/webm',
  }

  const rejected = await manager.uploadFromBuffer(channel, buffer, options)
  assert.equal(rejected.success, false)
  assert.equal(rejected.rollbackPending, true)
  assert.equal(channel.videos.length, 1)
  assert.equal(channel.videos[0].id, options.videoId)
  assert.equal(cleared.length, 1)

  const deleteRejected = await manager.uploadFromBuffer(channel, buffer, options)
  assert.equal(deleteRejected.success, false)
  assert.equal(deleteRejected.rollbackPending, true)
  assert.equal(appendAttempts, 1, 'pending reconciliation never reaches catalog append')
  assert.equal(channel.videos.length, 1)
  assert.equal(channel.videos[0].publicationState, 'replicationPending')
  assert.equal(cleared.length, 2)

  const retried = await manager.uploadFromBuffer(channel, buffer, options)
  assert.equal(retried.success, true)
  assert.equal(retried.videoId, options.videoId)
  assert.equal(retried.reused, undefined)
  assert.equal(appendAttempts, 2)
  assert.equal(channel.videos.length, 1)
  assert.equal(channel.videos[0].publicationState, 'published')
  assert.equal(cleared.length, 3)
  assert.equal(channel.blobWrites.length, 2)
})

test('deterministic reused uploads return the original publication contract', async () => {
  const manifest = { publicationId: 'aa'.repeat(32), body: { manifestId: 'bb'.repeat(32) } }
  const metadata = {
    id: 'feed',
    immutablePublication: {
      publicationId: manifest.publicationId,
      manifestId: manifest.body.manifestId,
      renditionId: 'cc'.repeat(32),
      assetId: 'dd'.repeat(32),
      coreKey: 'dd'.repeat(32),
      manifest,
    },
  }
  const manager = createUploadManager({ ctx: {} })
  const result = await manager.uploadFromPath({
    blobs: true,
    async getVideo() { return metadata },
  }, '/must-not-read', { videoId: metadata.id }, {})

  assert.equal(result.success, true)
  assert.equal(result.reused, true)
  assert.equal(result.publicationId, metadata.immutablePublication.publicationId)
  assert.equal(result.manifestId, metadata.immutablePublication.manifestId)
  assert.equal(result.renditionId, metadata.immutablePublication.renditionId)
  assert.equal(result.assetId, metadata.immutablePublication.assetId)
  assert.equal(result.coreKey, metadata.immutablePublication.coreKey)
  assert.equal(result.manifest, manifest)
})

test('static upload cancellation closes staging and emits no catalog operation', async (t) => {
  const underlyingStore = makeStore(t, 'cancelled-static-upload')
  const controller = new AbortController()
  const opened = []
  const store = {
    createKeyPair(name) {
      return underlyingStore.createKeyPair(name)
    },
    get(options) {
      const core = underlyingStore.get(options)
      opened.push(core)
      controller.abort()
      return core
    },
  }
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 5))
  const appended = []
  const counters = {}
  const catalog = makeCatalog(deviceKeyPair, appended, counters)
  const channel = makeChannel()
  const result = await makePublishingManager({
    store,
    deviceKeyPair,
    catalog,
  }).uploadFromBuffer(
    channel,
    Buffer.from('cancel after staging opens'),
    { title: 'Cancelled fixture', mimeType: 'video/webm', signal: controller.signal },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /cancelled/)
  assert.equal(counters.created || 0, 0)
  assert.equal(counters.appended || 0, 0)
  assert.deepEqual(appended, [])
  assert.equal(channel.videos.length, 0)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].closed, true)
})

test('catalog commit failure clears the newly written blob and leaves no upload metadata', async (t) => {
  const store = makeStore(t, 'failed-static-upload')
  const deviceKeyPair = crypto.keyPair(Buffer.alloc(32, 7))
  const blob = { id: '4:2:128:64', blockOffset: 4, blockLength: 2, byteOffset: 128, byteLength: 64 }
  const cleared = []
  const videos = []
  const channel = {
    localWriterKeyHex: '11'.repeat(32),
    blobsKeyHex: '22'.repeat(32),
    blobs: {
      createWriteStream() {
        const writer = new Writable({ write(_chunk, _encoding, done) { done() } })
        writer.id = { ...blob }
        return writer
      },
      async clear(value) {
        cleared.push({ ...value })
      },
    },
    async putBlob() {
      return { ...blob }
    },
    async addVideo(metadata) {
      videos.push(metadata)
    },
    async deleteVideo(id) {
      const index = videos.findIndex(video => video.id === id)
      if (index >= 0) videos.splice(index, 1)
    },
  }
  const catalog = {
    writable: true,
    localSignerKey: deviceKeyPair.publicKey,
    async getAuthorizationState() {
      return {
        writers: [{
          signerKey: Buffer.from(deviceKeyPair.publicKey).toString('hex'),
          capabilities: ['claim', 'publish'],
          firstAcceptedSequence: 1,
          lastAcceptedSequence: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async getOperationReceipt() {
      return { accepted: false }
    },
    async createLocalOperation(value) {
      return { ...value, recordId: Buffer.alloc(32, value.sequence) }
    },
    async appendBatchAndConfirm() {
      throw new Error('injected immutable catalog commit failure')
    },
  }
  const manager = createUploadManager({
    ctx: { store },
    deviceKeyPair,
    catalogRegistry: {
      async getWritableBindings() {
        return [{
          publisherId: deviceKeyPair.publicKey,
          catalog,
        }]
      },
    },
    now: () => 1_700_000_000_000,
  })

  const result = await manager.uploadFromBuffer(
    channel,
    Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.from('matroska'), Buffer.alloc(48)]),
    { title: 'Rollback fixture' },
  )

  assert.equal(result.success, false)
  assert.match(result.error, /catalog commit failure/)
  assert.deepEqual(cleared, [blob])
  assert.deepEqual(videos, [])
})
