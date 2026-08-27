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
import { ASSET_BLOCK_SIZE, sweepStagingState } from '../src/assets/static-core.js'
import { createSourceReader } from '../src/assets/source-reader.js'
import {
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createUploadManager } from '../src/upload.js'

// Resumable ingest, reached the way production reaches it: through
// `uploadFromStream`, not by calling the asset writer directly.
//
// The claim under test is that an archive interrupted part-way is worth
// resuming — that the second attempt asks the origin only for the bytes it does
// not already hold, and that what it ends up with is byte-for-byte and
// key-for-key the same core a single uninterrupted pass would have produced. A
// resume that quietly re-downloaded the title would still produce the right
// core, so the ranges asked for are asserted, not just the result.
const WINDOW_BYTES = 2 * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 6
const TAIL_BYTES = 1500
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES

// Ranges are deliberately NOT block-aligned — a real grant serves whatever
// window it was asked for — so the ingest has to re-chunk them into canonical
// blocks, which is what keeps the asset key a function of the bytes alone.
const RANGE_BYTES = 100_000

// Far enough in that several blocks are staged and confirmed to the bucket, so
// there is a real prefix to resume from rather than a rounding error.
const FAIL_AFTER_BYTES = 1_000_000

const RESUME_ID = 'ing_resumable_upload_fixture'
const ETAG = '"remote-sha256-0123456789abcdef"'
const PREFIX = 'relay'

// `variant` changes the last byte, and so the merkle root and the asset key.
// Two titles in one store must be different content or the second write would
// find a finished core its prologue says is already complete.
function assetBytes(variant = 0) {
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
  bytes[BYTE_LENGTH - 1] = variant & 0xff
  return bytes
}

function chunksOf(bytes) {
  const chunks = []
  for (let offset = 0; offset < bytes.byteLength; offset += RANGE_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(offset + RANGE_BYTES, bytes.byteLength)))
  }
  return chunks
}

/**
 * A plain one-shot body: an iterable that throws if anybody reads it twice,
 * which is what a fetch body is. The form every caller without a ranged origin
 * passes, and the form that must keep behaving exactly as it did.
 */
function oneShotSource(chunks) {
  let reads = 0
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const source = createSourceReader({
    resumable: false,
    maxReadBytes: Math.max(1, byteLength),
    async describe() {
      return {
        identity: { kind: 'etag', value: `plain-upload:${byteLength}` },
        byteLength,
        mimeType: 'video/mp4',
      }
    },
    open() {
      return (async function * () {
        reads++
        if (reads > 1) throw new Error('source read more than once')
        yield* chunks
      })()
    },
    async close() {},
  })
  return { source, get reads() { return reads } }
}

/**
 * A RANGED origin: the shape a source grant has. It records the offset of every
 * attempt and every range that attempt asked for, so a resume that silently
 * re-downloaded the title fails the test instead of passing it.
 *
 * `failAfterBytes` severs the first attempt only, the way a reset connection
 * does: the ranges already delivered stay delivered.
 */
function rangedOrigin(bytes, { failAfterBytes = null, etag = ETAG, id = RESUME_ID } = {}) {
  const attempts = []
  let armed = failAfterBytes !== null
  function openReader() {
    return createSourceReader({
      resumable: true,
      maxReadBytes: Math.max(1, bytes.byteLength),
      async describe() {
        return {
          identity: { kind: 'etag', value: etag },
          byteLength: bytes.byteLength,
          mimeType: 'video/mp4',
        }
      },
      open({ offset, length }) {
        const attempt = { byteOffset: offset, ranges: [] }
        attempts.push(attempt)
        return (async function *ranges() {
          let position = offset
          const limit = offset + length
          while (position < limit) {
            const end = Math.min(position + RANGE_BYTES, limit)
            if (armed && end > failAfterBytes) {
              armed = false
              throw new Error('granted source range failed: connection reset')
            }
            attempt.ranges.push([position, end - 1])
            yield bytes.subarray(position, end)
            position = end
          }
        })()
      },
      async close() {},
    })
  }
  return { attempts, get source() { return openReader() }, id }
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
 * A relay with an object store behind it, or without one. `blockOffload` is the
 * capability shape archive/block-offload.js builds from a configured bucket;
 * `objects` is an in-memory stand-in for the bucket, so nothing here touches a
 * network.
 */
async function fixture(t, { offload = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-resumable-upload-'))
  const objects = new Map()

  const provider = {
    async putBlock({ key, data }) {
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

  // `raw` is the unwrapped storage the offload wrapper delegates to, so reading
  // through it is a view of local disk that cannot restore anything.
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

  return { manager, store, directory, objects, residentBlockBytes, storeFor }
}

function uploadOptions(overrides = {}) {
  return {
    title: 'Oversized Title',
    mimeType: 'video/mp4',
    category: 'archive',
    duration: 120,
    retentionClass: 'archive-pin',
    byteLength: BYTE_LENGTH,
    resumeId: RESUME_ID,
    ...overrides,
  }
}

/**
 * Everything that has to match between a resumed core and a single-pass one:
 * the key it is addressed by, its extent, the merkle root the key comes from,
 * and the bytes it serves.
 */
async function coreIdentity(store, keyHex) {
  const core = store.get({ key: b4a.from(keyHex, 'hex') })
  await core.ready()
  const blocks = []
  for (let index = 0; index < core.length; index++) blocks.push(await core.get(index))
  const identity = {
    key: b4a.toString(core.key, 'hex'),
    length: core.length,
    byteLength: core.byteLength,
    treeHash: b4a.toString(await core.treeHash(), 'hex'),
    bytes: b4a.concat(blocks),
  }
  await core.close()
  return identity
}

function rangeBytes(ranges) {
  return ranges.reduce((total, [start, end]) => total + (end - start + 1), 0)
}

test('an interrupted ranged upload resumes into the same core a single pass produces', async (t) => {
  const bytes = assetBytes()

  // The reference: the same content, one uninterrupted pass, its own relay.
  const reference = await fixture(t)
  const straight = rangedOrigin(bytes)
  const once = await reference.manager.uploadFromStream(makeChannel(), straight.source, uploadOptions())
  t.is(once.success, true, 'the uninterrupted ranged upload published')
  t.is(straight.attempts.length, 1, 'and opened the origin exactly once')
  const expected = await coreIdentity(reference.store, once.metadata.blobsCoreKey)

  // The subject: severed mid-title, then retried against the same relay.
  const subject = await fixture(t)
  const origin = rangedOrigin(bytes, { failAfterBytes: FAIL_AFTER_BYTES })
  const channel = makeChannel()

  const interrupted = await subject.manager.uploadFromStream(channel, origin.source, uploadOptions())
  t.is(interrupted.success, false, 'the interrupted attempt published nothing')
  t.is(channel.videos.length, 0, 'and left no video record behind')
  t.ok(subject.objects.size > 0, 'the staged prefix was kept in the bucket for a retry')

  const retried = await subject.manager.uploadFromStream(channel, origin.source, uploadOptions())
  t.is(retried.success, true, 'the retry published the title')

  const actual = await coreIdentity(subject.store, retried.metadata.blobsCoreKey)
  t.is(actual.key, expected.key, 'the resumed core is addressed by the same key')
  t.is(actual.length, expected.length, 'the resumed core has the same block length')
  t.is(actual.byteLength, expected.byteLength, 'the resumed core has the same byte length')
  t.is(actual.treeHash, expected.treeHash, 'the resumed core has the same merkle root')
  t.alike(actual.bytes, bytes, 'and it serves the whole title back byte-exact')

  // The point of resuming, and the thing a silent full re-download would fail:
  // the second attempt opened at an offset and asked for nothing it already had.
  t.is(origin.attempts.length, 2, 'the origin was opened once per attempt')
  t.is(origin.attempts[0].byteOffset, 0, 'the first attempt started at byte zero')
  const resumeOffset = origin.attempts[1].byteOffset
  t.ok(resumeOffset > 0, `the retry resumed at byte ${resumeOffset} instead of starting again`)
  t.ok(resumeOffset < BYTE_LENGTH, 'and there was still something left to fetch')
  t.is(resumeOffset % ASSET_BLOCK_SIZE, 0, 'the retry resumed on a canonical block boundary')

  const retry = origin.attempts[1].ranges
  t.is(retry[0][0], resumeOffset, 'the retry asked first for the byte after the staged prefix')
  t.is(retry[retry.length - 1][1], BYTE_LENGTH - 1, 'and carried on to the last byte of the title')
  t.absent(retry.some(([start]) => start < resumeOffset), 'no range below the resume offset was asked for again')
  t.is(rangeBytes(retry), BYTE_LENGTH - resumeOffset, 'exactly the missing bytes were fetched, and no more')
  t.ok(
    rangeBytes(origin.attempts[0].ranges) + rangeBytes(retry) < 2 * BYTE_LENGTH,
    'the two attempts together read less than the title twice'
  )
})

test('a ranged origin whose identity changed between attempts is refused rather than spliced', async (t) => {
  const bytes = assetBytes()
  const { manager, store } = await fixture(t)
  const channel = makeChannel()

  const first = rangedOrigin(bytes, { failAfterBytes: FAIL_AFTER_BYTES })
  const interrupted = await manager.uploadFromStream(channel, first.source, uploadOptions())
  t.is(interrupted.success, false, 'the first attempt was severed')

  // Same resume id, different bytes claimed: two sources must never be joined
  // into one content-addressed core.
  const rotated = rangedOrigin(bytes, { etag: '"remote-sha256-rotated"' })
  const refused = await manager.uploadFromStream(channel, rotated.source, uploadOptions())
  t.is(refused.success, false, 'the retry under a new identity was refused')
  t.ok(/identity changed/.test(refused.error), 'and said why')
  t.is(rotated.attempts.length, 0, 'not one byte was fetched under the rotated identity')
  t.is(channel.videos.length, 0, 'nothing was published')

  // The staged prefix is a truthful prefix of the source it was READ from — it
  // is the request that now points somewhere else — so it is kept, and an
  // attempt that comes back with the original identity picks it up rather than
  // paying for the download twice because a grant was reissued.
  const clean = rangedOrigin(bytes)
  const published = await manager.uploadFromStream(channel, clean.source, uploadOptions())
  t.is(published.success, true, 'a fresh attempt under the original identity publishes')
  t.ok(clean.attempts[0].byteOffset > 0, 'and still resumes from the prefix the refusal preserved')
  const identity = await coreIdentity(store, published.metadata.blobsCoreKey)
  t.alike(identity.bytes, bytes, 'serving the title back byte-exact')
})

test('a plain one-shot stream with no ranged opener is unchanged', async (t) => {
  const bytes = assetBytes()
  const { manager, store, directory } = await fixture(t)
  const source = oneShotSource(chunksOf(bytes))
  const channel = makeChannel()

  const result = await manager.uploadFromStream(channel, source.source, uploadOptions())

  t.is(result.success, true, 'the plain streaming upload succeeded')
  t.is(source.reads, 1, 'the one-shot source was read exactly once')
  t.is(result.metadata.size, BYTE_LENGTH, 'the whole title was ingested')
  t.is(result.metadata.mimeType, 'video/mp4', 'MIME type still came off the streamed magic bytes')
  t.is(channel.blobWrites.length, 0, 'no second full-size blob copy was written')
  t.is(readdirSync(directory).sort().join(','), 'CORESTORE,db', 'no file was staged')

  // Same bytes, same core: an opener is an optimisation for interruptions, not a
  // different way of addressing content.
  const identity = await coreIdentity(store, result.metadata.blobsCoreKey)
  t.alike(identity.bytes, bytes, 'and the finished core serves the title back byte-exact')
})

test('with offload unconfigured a ranged origin is read once from zero and resume never engages', async (t) => {
  const bytes = assetBytes()
  const { manager, store, residentBlockBytes } = await fixture(t, { offload: false })
  const origin = rangedOrigin(bytes)

  const result = await manager.uploadFromStream(makeChannel(), origin.source, uploadOptions())

  // Resume needs somewhere durable to keep a staged prefix. With no object store
  // there is nowhere, and engaging it would have failed the write outright with
  // ASSET_RESUME_UNSUPPORTED — so a success here IS the proof it stayed off.
  t.is(result.success, true, 'the upload succeeded with no object store configured')
  t.is(origin.attempts.length, 1, 'the ranged origin was opened exactly once')
  t.is(origin.attempts[0].byteOffset, 0, 'from byte zero, with no staged prefix consulted')
  t.is(rangeBytes(origin.attempts[0].ranges), BYTE_LENGTH, 'and read the title once, whole')
  t.is(result.metadata.size, BYTE_LENGTH, 'the whole title was ingested')

  const identity = await coreIdentity(store, result.metadata.blobsCoreKey)
  t.alike(identity.bytes, bytes, 'the finished core serves the title back byte-exact')
  // Unbounded, the title comes to rest here — exactly as a plain stream does.
  t.ok(await residentBlockBytes() >= BYTE_LENGTH, 'without offload the whole title is resident locally')
})

test('the startup sweep reclaims an abandoned ingest\'s staged prefix and leaves a live one alone', async (t) => {
  const abandonedId = 'ing_sweep_abandoned'
  const liveId = 'ing_sweep_live'
  const abandonedBytes = assetBytes(0x11)
  const liveBytes = assetBytes(0x22)
  const { manager, store, objects, storeFor } = await fixture(t)

  // Two archives interrupted mid-title, each leaving a real staged prefix in the
  // bucket under its own resume id.
  for (const [id, bytes] of [[abandonedId, abandonedBytes], [liveId, liveBytes]]) {
    const origin = rangedOrigin(bytes, { id, failAfterBytes: FAIL_AFTER_BYTES })
    const interrupted = await manager.uploadFromStream(makeChannel(), origin.source, uploadOptions({ resumeId: id }))
    t.is(interrupted.success, false, `the ${id} attempt was severed`)
  }
  const staged = objects.size
  t.ok(staged > 0, 'both interrupted attempts left staged blocks in the bucket')

  // What the relay does once at startup, before it schedules a single job: every
  // durable ingest job id, with the ones that have not settled marked to keep.
  const swept = await sweepStagingState({
    store,
    createStagingStore: ({ core }) => storeFor(core.key),
    ids: [abandonedId, liveId],
    keep: [liveId],
  })

  t.alike(swept.reclaimed, [abandonedId], 'the abandoned job\'s staging state was reclaimed')
  t.alike(swept.retained, [liveId], 'and the live job\'s was left exactly where it was')
  t.is(swept.orphaned.length, 0, 'with nothing stranded in the bucket')
  t.ok(objects.size < staged, 'the abandoned prefix cost the bucket nothing further')

  // What retention and reclamation actually mean, rather than what the return
  // value says: the kept job resumes, the reclaimed one starts over.
  const resumed = rangedOrigin(liveBytes, { id: liveId })
  const finished = await manager.uploadFromStream(makeChannel(), resumed.source, uploadOptions({ resumeId: liveId }))
  t.is(finished.success, true, 'the retained job finished')
  t.ok(resumed.attempts[0].byteOffset > 0, 'by picking up the prefix the sweep kept')
  t.alike(
    (await coreIdentity(store, finished.metadata.blobsCoreKey)).bytes,
    liveBytes,
    'and it serves its title back byte-exact'
  )

  const restarted = rangedOrigin(abandonedBytes, { id: abandonedId })
  const republished = await manager.uploadFromStream(makeChannel(), restarted.source, uploadOptions({ resumeId: abandonedId }))
  t.is(republished.success, true, 'the reclaimed job can still be archived')
  t.is(restarted.attempts[0].byteOffset, 0, 'but starts from byte zero, having nothing left to resume')
})
