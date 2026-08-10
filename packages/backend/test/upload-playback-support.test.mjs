import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'
import crypto from 'hypercore-crypto'

import { decodePublicationManifest } from '../src/assets/index.js'
import { createUploadManager } from '../src/upload.js'

function makeChannel() {
  const videos = []
  return {
    localWriterKeyHex: '11'.repeat(32),
    blobsKeyHex: '22'.repeat(32),
    videos,
    blobs: {
      createWriteStream() {
        return {
          id: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 32 },
          on() { return this },
          close() {},
        }
      },
      async clear() {},
    },
    async putBlob() {
      return { id: '0:1:0:32' }
    },
    async addVideo(metadata) {
      videos.push(metadata)
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

function makePublishingManager({ store, deviceKeyPair, catalog }) {
  return createUploadManager({
    ctx: { store },
    deviceKeyPair,
    catalogRegistry: {
      async getWritableBindings() {
        return [{ publisherId: deviceKeyPair.publicKey, catalog }]
      },
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
