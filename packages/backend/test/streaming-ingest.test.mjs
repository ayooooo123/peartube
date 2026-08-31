import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore, remoteBlockKey } from '../src/archive/remote-block-store.js'
import {
  ASSET_BLOCK_SIZE,
  STAGING_UPLOAD_CONCURRENCY,
  verifyStaticAssetDescriptor,
  writeStaticAsset,
} from '../src/assets/static-core.js'
import { createSourceReader } from '../src/assets/source-reader.js'

// A network download is a ONE-SHOT source: there is no second fetch, and the
// relay cannot stage the title on its volume first, because the title is the
// thing that does not fit. These tests are about that source.
//
// Seven canonical blocks over a two-block window, the last one a 1000-byte tail
// so the partial block is ingested on the same path as the full ones. The point
// is the BOUND, not the volume — one and a half megabytes prove the window
// governs residency exactly as well as forty gigabytes would, and a relay's disk
// is not the thing under test.
const WINDOW_BLOCKS = 2
const WINDOW_BYTES = WINDOW_BLOCKS * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 7
const TAIL_BYTES = 1000
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES
const OFFLOADED_BLOCKS = 5
const RESIDENT_AFTER = ASSET_BLOCK_SIZE + TAIL_BYTES

// The bound pass 2 exists to hold: the offload window, plus the one block being
// moved, held twice while it is being moved (its staged copy and its finished
// copy). Independent of the size of the title.
const PEAK_BOUND = WINDOW_BYTES + (2 * ASSET_BLOCK_SIZE)

const PREFIX = 'relay'

// Source chunks are deliberately not block-aligned, so the single read has to
// re-chunk into canonical blocks the same way a real download does.
const CHUNK_BYTES = 100000

function assetBytes() {
  const bytes = b4a.alloc(BYTE_LENGTH)
  for (let index = 0; index < BLOCK_COUNT; index++) {
    bytes.fill(
      (index + 1) & 0xff,
      index * ASSET_BLOCK_SIZE,
      Math.min((index + 1) * ASSET_BLOCK_SIZE, BYTE_LENGTH)
    )
  }
  return bytes
}

function canonicalBlocks(bytes) {
  const blocks = []
  for (let offset = 0; offset < bytes.byteLength; offset += ASSET_BLOCK_SIZE) {
    blocks.push(bytes.subarray(offset, Math.min(offset + ASSET_BLOCK_SIZE, bytes.byteLength)))
  }
  return blocks
}

function chunksOf(bytes) {
  const chunks = []
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)))
  }
  return chunks
}

async function *replay(chunks) {
  yield* chunks
}

function reopenableReader(byteLength, open) {
  return createSourceReader({
    resumable: true,
    maxReadBytes: Math.max(1, byteLength),
    async describe() {
      return {
        identity: { kind: 'etag', value: `streaming-reopenable:${byteLength}` },
        byteLength,
        mimeType: 'application/octet-stream',
      }
    },
    open,
    async close() {},
  })
}

function oneShotSource(chunks) {
  let iterations = 0
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const reader = createSourceReader({
    resumable: false,
    maxReadBytes: Math.max(1, byteLength),
    async describe() {
      return {
        identity: { kind: 'etag', value: `streaming-one-shot:${byteLength}` },
        byteLength,
        mimeType: 'application/octet-stream',
      }
    },
    open() {
      return (async function * () {
        iterations++
        if (iterations > 1) throw new Error('source iterated more than once')
        yield* chunks
      })()
    },
    async close() {},
  })
  return { reader, get iterations() { return iterations } }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-streaming-ingest-'))
  const messages = []
  const objects = new Map()
  // Set by a test that wants to measure or interfere at the instant a block is
  // uploaded — the one moment a block is guaranteed to exist both locally and
  // remotely — or at the instant one is deleted.
  const hooks = { onPut: null, onDelete: null }

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
      if (hooks.onDelete !== null) await hooks.onDelete(key)
      objects.delete(key)
      return { success: true }
    },
  }

  // `raw` is kept on purpose: it is the same CorestoreStorage the wrapper
  // delegates to, so reading through it is a view of local disk that cannot
  // restore anything. That is how residency is measured below — real bytes in
  // every core of the store, never a counter kept by the code under test.
  const raw = Hypercore.defaultStorage(directory)
  const storage = createOffloadStorage({
    storage: raw,
    resolveStore: ({ keyHex }) => (
      typeof keyHex === 'string' ? createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: keyHex }) : null
    ),
    log: (message) => messages.push(message),
  })
  const store = new Corestore(storage)
  await store.ready()

  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  /**
   * Every byte of block data on local disk, across every core in the store —
   * the staging core included. This is the number a relay's volume sees.
   */
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

  function storeFor(core) {
    return createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key })
  }

  function offloaderFor(core, options = {}) {
    return createBlockOffloader({
      core,
      store: storeFor(core),
      windowBytes: WINDOW_BYTES,
      ...options,
    })
  }

  return { store, storage, raw, provider, objects, messages, hooks, residentBlockBytes, storeFor, offloaderFor }
}

function keysUnder(objects, coreKeyHex) {
  const head = `${PREFIX}/blocks/${coreKeyHex}/`
  return [...objects.keys()].filter((key) => key.startsWith(head)).sort()
}

function proofFor(core, index) {
  return core.proof({
    block: { index, nodes: 0 },
    upgrade: { start: 0, length: core.length },
  })
}

test('streaming ingest archives a title larger than its local footprint from a single read of a one-shot source', async (t) => {
  const { store, storage, objects, hooks, residentBlockBytes, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)
  const source = oneShotSource(chunksOf(bytes))

  let stagingKeyHex = null
  let peakOnDisk = 0
  let pass1Peak = 0
  let stagedObjectsAtHandover = null

  async function sample() {
    const onDisk = await residentBlockBytes()
    if (onDisk > peakOnDisk) peakOnDisk = onDisk
    return onDisk
  }

  // Pass 1 has its own worst instant: a block is on local disk and is being
  // uploaded, alongside every other upload still waiting to be confirmed.
  // Sampling inside the put is the only honest place to catch it, and it is
  // kept apart from `peakOnDisk` because the two passes bound different things:
  // pass 1 by how many uploads may overlap, pass 2 by the offload window.
  hooks.onPut = async (key) => {
    if (stagingKeyHex !== null && key.startsWith(`${PREFIX}/blocks/${stagingKeyHex}/`)) {
      const onDisk = await residentBlockBytes()
      if (onDisk > pass1Peak) pass1Peak = onDisk
      return
    }
    await sample()
  }

  const written = await writeStaticAsset({
    store,
    reader: source.reader,
    offload: {
      createStagingStore({ core }) {
        t.ok(core.writable, 'the staging store is bound to the staging core, before a byte has been read')
        stagingKeyHex = b4a.toString(core.key, 'hex')
        return storeFor(core)
      },
      createOffloader({ core, descriptor }) {
        // Called between the passes: pass 1 is done, so the whole title is in
        // the object store under the staging key and none of it is on disk.
        stagedObjectsAtHandover = keysUnder(objects, stagingKeyHex)
        t.is(descriptor.length, BLOCK_COUNT, 'the offloader is handed the finished descriptor before a block is written')
        t.is(core.length, BLOCK_COUNT, 'and a core whose tree is already the whole title')
        t.is(core.byteLength, BYTE_LENGTH, 'accounting for every byte of it')

        // The worst moment for local residency is the instant a block exists in
        // BOTH the staging core and the finished core: after the transplant and
        // before the staged copy is dropped.
        const copyPrologue = core.core.copyPrologue.bind(core.core)
        core.core.copyPrologue = async (sourceState) => {
          await copyPrologue(sourceState)
          await sample()
        }

        const offloader = offloaderFor(core)
        return {
          ...offloader,
          async drain(options) {
            const stats = await offloader.drain(options)
            await sample()
            return stats
          },
        }
      },
    },
  })

  t.is(source.iterations, 1, 'the one-shot source was read exactly once: one CDN fetch for the whole archive')
  t.is(written.ingest.mode, 'streaming', 'and the write reports it took the streaming path')
  t.is(stagedObjectsAtHandover.length, BLOCK_COUNT, 'pass 1 put the whole title in the object store under the staging key')
  // Pass 1 uploads several blocks at once so the download is not stopped for
  // each round trip, and a block's local copy is the only copy until the object
  // store confirms the object — so it has to outlive its own upload. That makes
  // the footprint the overlap depth, not one block. What still matters, and is
  // what this asserts, is that it is a CONSTANT: bounded, and no function of how
  // large the title is.
  t.ok(
    pass1Peak <= STAGING_UPLOAD_CONCURRENCY * ASSET_BLOCK_SIZE,
    `pass 1 held ${pass1Peak} B, within the ${STAGING_UPLOAD_CONCURRENCY} blocks its overlapped uploads allow`
  )
  t.ok(pass1Peak < BYTE_LENGTH, 'which is less than the title, so overlapping uploads is not buffering the title')

  // Pass 2's bound.
  t.is(peakOnDisk, PEAK_BOUND, 'peak block data on local disk is the window plus the block in flight')
  t.is(written.ingest.peakLocalBytes, peakOnDisk, 'and the reported peak is the peak that really happened on disk')
  t.ok(peakOnDisk < BYTE_LENGTH, 'which is less than the title, so a title larger than the volume ingests')
  t.is(written.ingest.blocks, BLOCK_COUNT, 'every canonical block was ingested')
  t.is(written.ingest.bytes, BYTE_LENGTH, 'accounting for every byte of the title')
  t.is(written.ingest.windowBytes, WINDOW_BYTES, 'the ingest reports the window it was bounded by')
  t.is(await residentBlockBytes(), RESIDENT_AFTER, 'a window of block data is what is left on disk afterwards')

  // Correctness is not negotiable for capacity: the core the network asks for is
  // the content-addressed core, complete and provable.
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the finished core verifies against its descriptor')
  t.is(written.core.length, BLOCK_COUNT, 'the whole title is there')
  t.is(written.core.byteLength, BYTE_LENGTH, 'every byte of it')
  t.is(written.core.contiguousLength, BLOCK_COUNT, 'and the core does not lie about how much of it is contiguous')

  let advertised = 0
  for (let index = 0; index < BLOCK_COUNT; index++) {
    if (await written.core.has(index)) advertised++
  }
  t.is(advertised, BLOCK_COUNT, 'the relay advertises every block, offloaded or not')

  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await proofFor(written.core, index)
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'core.proof serves every block, restored from the object store where it had to be')

  // Objects are addressed BY CORE KEY, so the staging objects could never have
  // been handed to the finished core. They were re-keyed by the transplant and
  // are now dead weight in the bucket.
  const finalKeyHex = b4a.toString(written.core.key, 'hex')
  t.is(keysUnder(objects, stagingKeyHex).length, 0, 'every staging object is gone from the object store')
  t.alike(
    keysUnder(objects, finalKeyHex),
    Array.from({ length: OFFLOADED_BLOCKS }, (_, index) => remoteBlockKey({ prefix: PREFIX, coreKey: finalKeyHex, blockIndex: index })),
    'and what is left is exactly the finished core\'s own offloaded blocks'
  )
  t.is(objects.size, OFFLOADED_BLOCKS, 'so the bucket holds one copy of the offloaded part of the title, not two')
  t.alike(written.ingest.staging, {
    uploaded: BLOCK_COUNT,
    restored: BLOCK_COUNT,
    deleted: BLOCK_COUNT,
    orphaned: [],
  }, 'the write accounts for every staging object it created, restored and deleted')

  t.alike(
    storage.stats(),
    { restored: BLOCK_COUNT + OFFLOADED_BLOCKS, missing: 0, failed: 0, corrupt: 0 },
    'the staged blocks and the offloaded blocks were all restored through the wrapper, none missing or unverifiable'
  )

  await written.core.close()
})

test('streaming ingest refuses a tampered staging object instead of writing unprovable bytes into the finished core', async (t) => {
  const { store, storage, objects, messages, residentBlockBytes, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const source = oneShotSource(chunksOf(bytes))

  let stagingKeyHex = null
  const error = await writeStaticAsset({
    store,
    reader: source.reader,
    offload: {
      createStagingStore({ core }) {
        stagingKeyHex = b4a.toString(core.key, 'hex')
        return storeFor(core)
      },
      createOffloader({ core }) {
        // Between the passes the object store holds the only copy of the title.
        // Flip one bit of block 0 there and pass 2 is reading a lie.
        const key = remoteBlockKey({ prefix: PREFIX, coreKey: stagingKeyHex, blockIndex: 0 })
        const tampered = b4a.from(objects.get(key))
        tampered[11] ^= 1
        objects.set(key, tampered)
        return offloaderFor(core)
      },
    },
  }).then(() => null, (err) => err)

  t.is(error?.code, 'REMOTE_BLOCK_CORRUPT', 'the restored bytes are refused because they do not match the staged tree')
  t.is(source.iterations, 1, 'and there was no second read of the source to paper over it')
  t.is(storage.stats().corrupt, 1, 'the wrapper counted the object store handing back bytes the tree does not commit to')
  t.ok(messages.some((message) => /CORRUPT/.test(message)), 'and said so, once, naming the block')
  t.is(await residentBlockBytes(), 0, 'not one unprovable byte reached local disk')

  // The write failed after uploading the whole title, so the cleanup on the
  // failure path is the only thing between the operator and a bucket paying to
  // store a title nobody will finish.
  t.is(keysUnder(objects, stagingKeyHex).length, 0, 'the staging objects were cleaned up on the failure path')
  t.is(objects.size, 0, 'so nothing at all is left behind')
  t.is(error.orphanedStagingKeys, undefined, 'and there is nothing to report as orphaned')
})

test('a tampered object is refused rather than served to a peer', async (t) => {
  const { store, storage, objects, messages, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()

  let stagingKeyHex = null
  const written = await writeStaticAsset({
    store,
    reader: oneShotSource(chunksOf(bytes)).reader,
    offload: {
      createStagingStore({ core }) {
        stagingKeyHex = b4a.toString(core.key, 'hex')
        return storeFor(core)
      },
      createOffloader: ({ core }) => offloaderFor(core),
    },
  })

  t.is(keysUnder(objects, stagingKeyHex).length, 0, 'the archive is finished and its staging objects are gone')

  // Block 0 was offloaded, so the object store holds the only copy of it.
  const key = remoteBlockKey({ prefix: PREFIX, coreKey: b4a.toString(written.core.key, 'hex'), blockIndex: 0 })
  const tampered = b4a.from(objects.get(key))
  tampered[3] ^= 1
  objects.set(key, tampered)

  // `core.proof()` reads the block through the same wrapper a peer request goes
  // through, and the wrapper drops bytes the tree does not commit to rather than
  // returning them. So the proof comes back with nothing in it: the relay serves
  // no block at all, which is the only safe answer.
  const refused = await proofFor(written.core, 0)
  t.absent(refused.block.value, 'a peer asking for a tampered block is served no bytes at all')
  t.is(storage.stats().corrupt, 1, 'because the proof read caught the object against the merkle tree')
  t.is(await written.core.get(0, { wait: false }), null, 'and a local read of it fails rather than handing back bad bytes')
  t.ok(storage.stats().corrupt > 1, 'catching it again rather than trusting the first refusal')
  t.ok(messages.some((message) => /CORRUPT/.test(message)), 'and the relay said so')

  const proof = await proofFor(written.core, 1)
  t.alike(proof.block.value, canonicalBlocks(bytes)[1], 'while an untampered block is still served')

  await written.core.close()
})

test('with offload unconfigured the plain path is unchanged: one read of the source, everything local', async (t) => {
  const { store, storage, objects, residentBlockBytes } = await fixture(t)
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)
  const source = oneShotSource(chunksOf(bytes))

  const written = await writeStaticAsset({ store, reader: source.reader })

  t.is(source.iterations, 1, 'the plain path still reads the source exactly once')
  t.is(written.ingest, undefined, 'and reports no ingest accounting, exactly as before')
  t.is(objects.size, 0, 'with offload unconfigured nothing is uploaded anywhere')
  t.is(await residentBlockBytes(), BYTE_LENGTH, 'the whole title is stored locally, as it always was')
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the finished core verifies against its descriptor')

  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await proofFor(written.core, index)
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'every block is served from local disk')
  t.alike(
    storage.stats(),
    { restored: 0, missing: 0, failed: 0, corrupt: 0 },
    'and no read ever went looking for an object store'
  )

  await written.core.close()
})

test('a re-openable source is still read twice and never touches the staging store', async (t) => {
  const { store, objects, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const chunks = chunksOf(bytes)

  let opens = 0
  let stagingCalls = 0
  const written = await writeStaticAsset({
    store,
    reader: reopenableReader(BYTE_LENGTH, () => {
      opens++
      return replay(chunks)
    }),
    offload: {
      createStagingStore({ core }) {
        stagingCalls++
        return storeFor(core)
      },
      createOffloader: ({ core }) => offloaderFor(core),
    },
  })

  t.is(opens, 2, 'a source that can be re-opened is re-opened, as before')
  t.is(stagingCalls, 0, 'so a caller with a cheap local source is never pushed through the object store')
  t.is(written.ingest.mode, 'reopen', 'and the write reports the path it took')
  t.is(written.ingest.staging, undefined, 'with no staging accounting, because nothing was staged remotely')
  t.is(written.ingest.peakLocalBytes, PEAK_BOUND, 'bounded by the same window either way')
  t.is(objects.size, OFFLOADED_BLOCKS, 'the only objects are the finished core\'s offloaded blocks')
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'and the finished core verifies')

  await written.core.close()
})

test('a one-shot source with no staging store is still refused instead of buffering the title', async (t) => {
  const { store, objects, offloaderFor } = await fixture(t)
  const source = oneShotSource(chunksOf(assetBytes()))

  const error = await writeStaticAsset({
    store,
    reader: source.reader,
    offload: { createOffloader: ({ core }) => offloaderFor(core) },
  }).then(() => null, (err) => err)

  t.is(error?.code, 'ASSET_SOURCE_NOT_REOPENABLE', 'a one-shot source with nowhere to stage it is refused')
  t.ok(/durable staging/.test(error?.message || ''), 'and the refusal names the option that would make it work')
  t.is(source.iterations, 0, 'the source was never read, so nothing was buffered')
  t.is(objects.size, 0, 'and nothing was uploaded')
})

test('a staging object that will not delete is named rather than silently left in the bucket', async (t) => {
  const { store, objects, hooks, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()

  let stagingKeyHex = null
  // The bucket refuses to delete the middle of the staged title. The archive is
  // already verified at that point, so failing the write would throw away a good
  // archive over a cleanup — but saying nothing would leave an operator paying
  // for objects nobody can find.
  const stuck = new Set([2, 3])
  hooks.onDelete = (key) => {
    for (const blockIndex of stuck) {
      if (key === remoteBlockKey({ prefix: PREFIX, coreKey: stagingKeyHex, blockIndex })) {
        throw new Error('bucket policy denies delete')
      }
    }
  }

  const written = await writeStaticAsset({
    store,
    reader: oneShotSource(chunksOf(bytes)).reader,
    offload: {
      createStagingStore({ core }) {
        stagingKeyHex = b4a.toString(core.key, 'hex')
        return storeFor(core)
      },
      createOffloader: ({ core }) => offloaderFor(core),
    },
  })

  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the archive is finished and verified regardless')
  t.is(written.ingest.staging.deleted, BLOCK_COUNT - stuck.size, 'every staging object that could be deleted was')
  t.alike(
    written.ingest.staging.orphaned,
    [...stuck].map((blockIndex) => remoteBlockKey({ prefix: PREFIX, coreKey: stagingKeyHex, blockIndex })),
    'and the ones that would not go are reported by key, in order'
  )
  t.is(written.ingest.staging.error?.message, 'bucket policy denies delete', 'with the reason the bucket gave')
  t.alike(keysUnder(objects, stagingKeyHex), written.ingest.staging.orphaned, 'which is exactly what is still in the bucket')

  await written.core.close()
})

// An expensive source - a remote title where a pass-2 re-read is a second
// full download through the source - asks for staging instead. Pass 1 then
// uploads every staged block, pass 2 restores them from the object store, and
// the source is read exactly ONCE. A local caller that leaves preferStaging
// unset keeps the cheap re-read (the test above pins that).
test('preferStaging reads an expensive source once and restores pass 2 from the object store', async (t) => {
  const { store, objects, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const chunks = chunksOf(bytes)

  let opens = 0
  let stagingCalls = 0
  const written = await writeStaticAsset({
    store,
    reader: reopenableReader(BYTE_LENGTH, () => {
      opens++
      return replay(chunks)
    }),
    offload: {
      createStagingStore({ core }) {
        stagingCalls++
        return storeFor(core)
      },
      createOffloader: ({ core }) => offloaderFor(core),
    },
    preferStaging: true,
  })

  t.is(opens, 1, 'the expensive source was read exactly once')
  t.ok(stagingCalls > 0, 'the staging store was used')
  t.is(written.ingest.mode, 'streaming', 'and the write reports the streaming path')
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the finished core verifies')

  await written.core.close()
})
