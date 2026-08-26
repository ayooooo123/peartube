import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore } from '../src/archive/remote-block-store.js'
import { ASSET_BLOCK_SIZE } from '../src/assets/static-core.js'
import {
  encodePublisherCatalogFrame,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createUploadManager } from '../src/upload.js'

// `uploadFromStream` is the entry point that lets a relay archive a title it
// could never hold: the bytes arrive once, over the wire, and are never staged
// as a file. These tests are about that — the absence of the staging copy, the
// single read of the source, and the finished core still serving byte-exact
// bytes afterwards.
//
// Six canonical blocks over a two-block window, with a short tail so the partial
// block travels the same path as the full ones. The point is the BOUND, not the
// volume: one and a half megabytes proves the window governs residency exactly
// as well as a hundred gigabytes would, and this machine's disk is not under
// test.
const WINDOW_BYTES = 2 * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 6
const TAIL_BYTES = 1500
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES

// What the mode exists to hold: the window, plus the one block being moved held
// twice (its staged copy and its finished copy). Independent of title size.
const PEAK_BOUND = WINDOW_BYTES + (2 * ASSET_BLOCK_SIZE)

// Source chunks are deliberately not block-aligned, so the single read has to
// re-chunk into canonical blocks the way a real HTTP body does.
const CHUNK_BYTES = 100_000

const PREFIX = 'relay'

function assetBytes() {
  const bytes = b4a.alloc(BYTE_LENGTH)
  // An MP4 header, so the upload path detects the MIME type off magic bytes
  // exactly as it does for a file.
  b4a.copy(b4a.from('\x00\x00\x00\x18ftypmp42', 'binary'), bytes, 0)
  for (let index = 1; index < BLOCK_COUNT; index++) {
    bytes.fill(
      (index + 1) & 0xff,
      index * ASSET_BLOCK_SIZE,
      Math.min((index + 1) * ASSET_BLOCK_SIZE, BYTE_LENGTH)
    )
  }
  return bytes
}

function chunksOf(bytes) {
  const chunks = []
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)))
  }
  return chunks
}

/**
 * The source under test: an iterable that throws if anybody reads it twice,
 * which is what a fetch body is. A test that allowed a second read would prove
 * nothing about a real download.
 */
function oneShotSource(chunks) {
  let reads = 0
  return {
    get reads() {
      return reads
    },
    async *[Symbol.asyncIterator]() {
      reads++
      if (reads > 1) throw new Error('source read more than once')
      yield* chunks
    },
  }
}

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
            chunks.push(b4a.from(chunk))
            done()
          },
          final(done) {
            const bytes = b4a.concat(chunks)
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
    async updateVideo(id, value) {
      const index = videos.findIndex(video => video.id === id)
      if (index >= 0) videos[index] = value
      else videos.push(value)
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

function signedPublisherOperation(value, deviceKeyPair) {
  const prepared = prepareSignedEnvelope({
    recordType: value.recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: deviceKeyPair.publicKey,
    signerKey: deviceKeyPair.publicKey,
    policyEpoch: value.policyEpoch,
    issuerSequence: value.sequence,
    signedAt: value.signedAt,
    canonicalBody: encodePublisherOperationBody(value.recordType, value.body),
  }, { hash: crypto.hash })
  return {
    ...attachSignedEnvelopeSignature(
      prepared,
      crypto.sign(signedRecordSignaturePreimage(prepared), deviceKeyPair.secretKey),
    ),
    body: value.body,
  }
}

function makeCatalog(deviceKeyPair, appended) {
  return {
    writable: true,
    localSignerKey: deviceKeyPair.publicKey,
    async getAuthorizationState() {
      return {
        writers: [{
          signerKey: b4a.toString(deviceKeyPair.publicKey, 'hex'),
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
      return signedPublisherOperation(value, deviceKeyPair)
    },
    async appendBatchAndConfirm(operations) {
      appended.push(operations)
      return operations.map(() => ({ accepted: true }))
    },
  }
}

/**
 * A relay with an object store behind it. `offload` is the same capability shape
 * archive/block-offload.js builds from a configured bucket; `provider` is an
 * in-memory stand-in for the bucket itself, so nothing here touches a network.
 */
async function fixture(t, { offload = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-streaming-upload-'))
  const objects = new Map()
  const hooks = { onPut: null }

  const provider = {
    async putBlock({ key, data }) {
      if (hooks.onPut !== null) await hooks.onPut(key)
      objects.set(key, b4a.from(data))
      return { success: true }
    },
    async hasBlock({ key }) {
      return objects.has(key)
    },
    async getBlock({ key }) {
      return objects.has(key) ? objects.get(key) : null
    },
    async deleteBlock({ key }) {
      objects.delete(key)
      return { success: true }
    },
  }

  const storeFor = (coreKey) => createRemoteBlockStore({ provider, prefix: PREFIX, coreKey })

  // `raw` is the unwrapped CorestoreStorage the offload wrapper delegates to, so
  // reading through it is a view of local disk that cannot restore anything.
  // That is how residency is measured below: real bytes in every core of the
  // store, never a counter kept by the code under test.
  const raw = Hypercore.defaultStorage(directory)
  const storage = offload
    ? createOffloadStorage({
      storage: raw,
      resolveStore: ({ keyHex }) => (typeof keyHex === 'string' ? storeFor(keyHex) : null),
      log: () => {},
    })
    : raw
  const store = new Corestore(storage)
  await store.ready()

  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  async function residentBlockBytes() {
    let bytes = 0
    for await (const { discoveryKey } of raw.createCoreStream()) {
      const view = await raw.resumeCore(discoveryKey)
      if (!view) continue
      try {
        for await (const { value } of view.createBlockStream()) bytes += value.byteLength
      } finally {
        await view.close()
      }
    }
    return bytes
  }

  const blockOffload = offload
    ? {
      createOffloader({ core }) {
        // Deliberately NOT pre-tracked: the ingest tracks and drains one block
        // at a time, which is what keeps residency inside the window while the
        // title is still arriving.
        return createBlockOffloader({
          core,
          store: storeFor(core.key),
          windowBytes: WINDOW_BYTES,
        })
      },
      createStagingStore({ core }) {
        return storeFor(core.key)
      },
    }
    : null

  const deviceKeyPair = crypto.keyPair(b4a.alloc(32, 7))
  const appended = []
  const manager = createUploadManager({
    ctx: { store, blockOffload },
    deviceKeyPair,
    catalogRegistry: {
      async getWritableBindings() {
        return [{ publisherId: deviceKeyPair.publicKey, catalog: makeCatalog(deviceKeyPair, appended) }]
      },
      async resolve() {
        return { publisherId: deviceKeyPair.publicKey, catalog: makeCatalog(deviceKeyPair, appended) }
      },
    },
    scopedNetwork: {
      async retainAuthorizedRendition() { return { status: 'retained' } },
      async publishLocalPublisherCatalog() { return { status: 'published' } },
    },
    now: () => 1_700_000_000_000,
  })

  return { manager, store, directory, objects, hooks, residentBlockBytes, appended, deviceKeyPair }
}

function uploadOptions(overrides = {}) {
  return {
    title: 'Oversized Title',
    mimeType: 'video/mp4',
    category: 'archive',
    duration: 120,
    retentionClass: 'archive-pin',
    ...overrides,
  }
}

test('a streaming archive publishes a multi-block title from one read, with no title-sized copy anywhere', async (t) => {
  const { manager, store, directory, hooks, residentBlockBytes } = await fixture(t)
  const bytes = assetBytes()
  const source = oneShotSource(chunksOf(bytes))
  const channel = makeChannel()

  // Sampled at every upload: the one instant a block is guaranteed to exist
  // both locally and remotely, so it is the worst case for local residency.
  let peak = 0
  hooks.onPut = async () => {
    const resident = await residentBlockBytes()
    if (resident > peak) peak = resident
  }

  const result = await manager.uploadFromStream(channel, source, uploadOptions({ byteLength: BYTE_LENGTH }))

  t.is(result.success, true, 'streaming upload succeeded')
  t.is(source.reads, 1, 'the one-shot source was read exactly once')
  t.is(result.metadata.size, BYTE_LENGTH, 'the whole title was ingested')
  t.is(result.metadata.mimeType, 'video/mp4', 'MIME type came off the streamed magic bytes')
  t.ok(result.metadata.immutablePublication, 'the title was published as an immutable rendition')

  // No file was staged: nothing but the store's own directory tree exists, and
  // the channel's blob core never received a second copy.
  t.is(channel.blobWrites.length, 0, 'no second full-size blob copy was written')
  t.is(readdirSync(directory).sort().join(','), 'CORESTORE,db', 'the store directory holds only its own corestore files')

  // The bound the mode exists for. Measured from disk, not reported by the code
  // under test, and a fraction of the title rather than a multiple of it.
  t.ok(peak > 0, 'residency was actually sampled during the ingest')
  t.ok(peak <= PEAK_BOUND, `peak local block bytes ${peak} stayed within ${PEAK_BOUND}`)
  t.ok(peak < BYTE_LENGTH, `peak local block bytes ${peak} never reached the title's ${BYTE_LENGTH}`)

  const resident = await residentBlockBytes()
  t.ok(resident <= WINDOW_BYTES, `only ${resident} bytes of block data are resident, within the ${WINDOW_BYTES} window`)

  // Playback resolves against the rendition core, so that is what has to serve
  // the title back — byte-exact, restoring the offloaded blocks from the object
  // store on the way.
  const blobsCoreKey = result.metadata.blobsCoreKey
  t.is(typeof blobsCoreKey, 'string', 'playback names a rendition core')
  const served = store.get({ key: b4a.from(blobsCoreKey, 'hex') })
  await served.ready()
  t.is(served.byteLength, BYTE_LENGTH, 'the finished core reports the whole title')
  const blocks = []
  for (let index = 0; index < served.length; index++) blocks.push(await served.get(index))
  t.alike(b4a.concat(blocks), bytes, 'every block reads back byte-exact')
  await served.close()
})

test('a streaming archive rolls back and keeps no partial publication when the source fails mid-flight', async (t) => {
  const { manager, directory, objects, residentBlockBytes } = await fixture(t)
  const chunks = chunksOf(assetBytes())
  const channel = makeChannel()

  // A download the free-disk guard stops part-way: the body simply stops with
  // the guard's error, which is the shape direct-download.js throws.
  async function *severed() {
    for (let index = 0; index < 4; index++) yield chunks[index]
    throw new Error('direct download exceeded available storage headroom of 0 bytes')
  }

  const result = await manager.uploadFromStream(channel, severed(), uploadOptions())

  t.is(result.success, false, 'the upload failed rather than publishing a truncated title')
  t.ok(/storage headroom/.test(result.error), 'the guard error is reported verbatim')
  t.is(channel.videos.length, 0, 'no video record survived the failure')
  t.is(readdirSync(directory).sort().join(','), 'CORESTORE,db', 'no staged file was left behind')
  t.is(objects.size, 0, 'the staging objects were purged from the bucket')
  t.is(await residentBlockBytes(), 0, 'no block data was left resident')
})

test('with offload unconfigured a streamed title still takes the single-pass local path', async (t) => {
  const { manager, residentBlockBytes } = await fixture(t, { offload: false })
  const bytes = assetBytes()
  const source = oneShotSource(chunksOf(bytes))
  const channel = makeChannel()

  const result = await manager.uploadFromStream(channel, source, uploadOptions())

  t.is(result.success, true, 'the upload succeeded with no object store configured')
  t.is(source.reads, 1, 'the one-shot source was still read exactly once')
  t.is(result.metadata.size, BYTE_LENGTH, 'the whole title was ingested')
  // Unbounded, the title comes to rest here — that is exactly why the CLI keeps
  // the temp-file path unless offload is configured.
  t.ok(await residentBlockBytes() >= BYTE_LENGTH, 'without offload the whole title is resident locally')
})
