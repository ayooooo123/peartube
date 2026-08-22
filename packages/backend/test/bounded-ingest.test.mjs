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
  verifyStaticAssetDescriptor,
  writeStaticAsset,
} from '../src/assets/static-core.js'

// Nine canonical blocks over a three-block window: three windows of title, with
// the last block a 1000-byte tail so the partial block is ingested on the same
// path as the full ones. The point is the BOUND, not the volume — two megabytes
// prove the window governs residency exactly as well as two terabytes would,
// and a relay's disk is not the thing under test.
const WINDOW_BLOCKS = 3
const WINDOW_BYTES = WINDOW_BLOCKS * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 9
const TAIL_BYTES = 1000
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES
const OFFLOADED_BLOCKS = 6
const RESIDENT_AFTER = (2 * ASSET_BLOCK_SIZE) + TAIL_BYTES
const PREFIX = 'relay'

// Source chunks are deliberately not block-aligned, so both passes have to do
// the same re-chunking to arrive at the same canonical blocks.
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

/**
 * A one-shot source: a generator object that refuses to be iterated twice,
 * which is what a pipe or a decode stream is. Bounded ingest has to refuse it,
 * not buffer the title to work around it.
 */
function oneShotSource(chunks) {
  let iterations = 0
  return {
    get iterations() {
      return iterations
    },
    async *[Symbol.asyncIterator]() {
      iterations++
      if (iterations > 1) throw new Error('source iterated more than once')
      yield* chunks
    },
  }
}

/**
 * An object store in a Map that writes every put and every existence check into
 * an ordered log, so a test can assert the ORDER of upload, confirmation and
 * local delete rather than just their totals.
 */
function createRecordingProvider(log) {
  const objects = new Map()
  return {
    objects,
    provider: {
      async putBlock({ key, data }) {
        log.push(`put ${key}`)
        objects.set(key, b4a.from(data))
        return { success: true }
      },
      async hasBlock({ key }) {
        log.push(`has ${key}`)
        return objects.has(key)
      },
      async getBlock({ key }) {
        return objects.has(key) ? objects.get(key) : null
      },
      async deleteBlock({ key }) {
        objects.delete(key)
        return { success: true }
      },
    },
  }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-bounded-ingest-'))
  const log = []
  const messages = []
  const { provider, objects } = createRecordingProvider(log)

  // `raw` is kept on purpose: it is the same CorestoreStorage the wrapper
  // delegates to, so reading through it is a view of local disk that cannot
  // restore anything. That is how residency is measured below — real bytes in
  // every core of the store, never the offloader's own counters.
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

  function offloaderFor(core, options = {}) {
    return createBlockOffloader({
      core,
      store: createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key }),
      windowBytes: WINDOW_BYTES,
      ...options,
    })
  }

  function boundedOffload(options = {}) {
    return { createOffloader: ({ core }) => offloaderFor(core, options) }
  }

  return { store, storage, raw, provider, objects, log, messages, residentBlockBytes, offloaderFor, boundedOffload }
}

function keyFor(core, blockIndex) {
  return remoteBlockKey({ prefix: PREFIX, coreKey: core.key, blockIndex })
}

function proofFor(core, index) {
  return core.proof({
    block: { index, nodes: 0 },
    upgrade: { start: 0, length: core.length },
  })
}

test('bounded ingest bounds local block data by the window, confirms every upload before deleting it, and still serves every block', async (t) => {
  const { store, storage, objects, log, residentBlockBytes, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)
  const chunks = chunksOf(bytes)

  let peakOnDisk = 0
  async function sample() {
    const onDisk = await residentBlockBytes()
    if (onDisk > peakOnDisk) peakOnDisk = onDisk
  }

  let sourceOpens = 0
  const written = await writeStaticAsset({
    store,
    createSource: () => {
      sourceOpens++
      return replay(chunks)
    },
    offload: {
      createOffloader({ core, descriptor }) {
        t.is(descriptor.length, BLOCK_COUNT, 'the offloader is handed the finished descriptor before a block is written')
        t.is(core.length, BLOCK_COUNT, 'and a core whose tree is already the whole title')
        t.is(core.byteLength, BYTE_LENGTH, 'accounting for every byte of it')

        // The worst moment for local residency is the instant a block exists in
        // BOTH the staging core and the finished core: after the transplant and
        // before the staged copy is dropped. Sampling right here is the only
        // honest place to measure a peak.
        const copyPrologue = core.core.copyPrologue.bind(core.core)
        core.core.copyPrologue = async (sourceState) => {
          await copyPrologue(sourceState)
          await sample()
        }

        const offloader = offloaderFor(core, {
          // Fires only after the local copy is gone, so appending to the same
          // log the provider writes into records the delete in its true place.
          onOffloaded: ({ index }) => log.push(`delete ${index}`),
        })

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

  t.is(sourceOpens, 2, 'the source was opened exactly twice: once to derive the key, once to write the blocks')

  // The bound. Peak local block data is the window plus the one block being
  // moved through it (its staged copy and its finished copy), whatever the size
  // of the title.
  t.is(peakOnDisk, WINDOW_BYTES + (2 * ASSET_BLOCK_SIZE), 'peak block data on local disk is the window plus the block in flight')
  t.is(written.ingest.peakLocalBytes, peakOnDisk, 'and the reported peak is the peak that really happened on disk')
  t.ok(peakOnDisk < BYTE_LENGTH, 'which is less than the title, so a title larger than the volume ingests')
  t.is(written.ingest.blocks, BLOCK_COUNT, 'every canonical block was ingested')
  t.is(written.ingest.bytes, BYTE_LENGTH, 'accounting for every byte of the title')
  t.is(written.ingest.windowBytes, WINDOW_BYTES, 'the ingest reports the window it was bounded by')
  t.is(await residentBlockBytes(), RESIDENT_AFTER, 'a window of block data is what is left on disk afterwards')

  // The ordering IS the safety property: a block is uploaded, the object store
  // is asked whether it really holds it, and only then does the local copy go.
  const expectedLog = []
  for (let index = 0; index < OFFLOADED_BLOCKS; index++) {
    const key = keyFor(written.core, index)
    expectedLog.push(`put ${key}`, `has ${key}`, `delete ${index}`)
  }
  t.alike(log, expectedLog, 'each offloaded block was put, confirmed present, and only then deleted locally')

  t.alike(written.ingest.offload, {
    windowBytes: WINDOW_BYTES,
    residentBytes: RESIDENT_AFTER,
    peakResidentBytes: WINDOW_BYTES + ASSET_BLOCK_SIZE,
    pending: BLOCK_COUNT - OFFLOADED_BLOCKS,
    blocksOffloaded: OFFLOADED_BLOCKS,
    bytesOffloaded: OFFLOADED_BLOCKS * ASSET_BLOCK_SIZE,
    confirmed: OFFLOADED_BLOCKS,
  }, 'no block was deleted without its own confirmation')
  t.is(objects.size, OFFLOADED_BLOCKS, 'the object store holds exactly the offloaded blocks')

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
  t.alike(
    storage.stats(),
    { restored: OFFLOADED_BLOCKS, missing: 0, failed: 0, corrupt: 0 },
    'exactly the offloaded blocks needed a restore, and none was missing, unreachable or unverifiable'
  )

  await written.core.close()
})

test('bounded ingest derives the identical descriptor to the unbounded path', async (t) => {
  const { store, boundedOffload } = await fixture(t)
  const plainDirectory = mkdtempSync(join(tmpdir(), 'peartube-bounded-ingest-plain-'))
  const plainStore = new Corestore(plainDirectory)
  await plainStore.ready()

  t.teardown(async () => {
    await plainStore.close().catch(() => {})
    rmSync(plainDirectory, { recursive: true, force: true })
  })

  const bytes = assetBytes()
  const chunks = chunksOf(bytes)

  // Today's path: no offload configured at all, one pass, whole title resident.
  const plainSource = oneShotSource(chunks)
  const plain = await writeStaticAsset({ store: plainStore, source: plainSource })
  const bounded = await writeStaticAsset({
    store,
    createSource: () => replay(chunks),
    offload: boundedOffload(),
  })

  t.is(plainSource.iterations, 1, 'the unbounded path still reads the source exactly once')
  t.alike(bounded.descriptor, plain.descriptor, 'the bounded write derives the identical descriptor, byte for byte')
  t.is(bounded.descriptor.assetId, plain.descriptor.assetId, 'so the network asks for the same asset')
  t.alike(await bounded.core.treeHash(), await plain.core.treeHash(), 'and both finished cores hold the identical tree')
  t.is(plain.ingest, undefined, 'the unbounded write reports no ingest accounting, exactly as before')
  t.is(bounded.ingest.peakLocalBytes, WINDOW_BYTES + (2 * ASSET_BLOCK_SIZE), 'while the bounded write reports its bound')
  t.ok(await verifyStaticAssetDescriptor(plain.core, bounded.descriptor), 'either core verifies against the other one\'s descriptor')

  await bounded.core.close()
  await plain.core.close()
})

test('bounded ingest refuses a one-shot source instead of buffering the title', async (t) => {
  const { store, objects, boundedOffload } = await fixture(t)
  const source = oneShotSource(chunksOf(assetBytes()))

  const error = await writeStaticAsset({
    store,
    source,
    offload: boundedOffload(),
  }).then(() => null, (err) => err)

  t.is(error?.code, 'ASSET_SOURCE_NOT_REOPENABLE', 'a source that can only be read once is refused')
  t.ok(/createSource/.test(error?.message || ''), 'and the refusal names what to pass instead')
  t.is(source.iterations, 0, 'the source was never read, so nothing was buffered')
  t.is(objects.size, 0, 'and nothing was uploaded')

  const keys = []
  for await (const discoveryKey of store.list()) keys.push(discoveryKey)
  t.is(keys.length, 0, 'no core was created for an asset that was never written')
})

test('bounded ingest refuses bytes that changed between the two passes', async (t) => {
  const { store, objects, residentBlockBytes, boundedOffload } = await fixture(t)
  const bytes = assetBytes()

  let opens = 0
  const error = await writeStaticAsset({
    store,
    createSource: () => {
      opens++
      if (opens === 1) return replay(chunksOf(bytes))
      // The second read of the source hands back one flipped bit in block 1.
      const changed = b4a.from(bytes)
      changed[ASSET_BLOCK_SIZE + 7] ^= 1
      return replay(chunksOf(changed))
    },
    offload: boundedOffload(),
  }).then(() => null, (err) => err)

  t.is(error?.code, 'ASSET_SOURCE_CHANGED', 'a source that reads back differently fails the write')
  t.is(error?.blockIndex, 1, 'and names the first block that did not match the tree the key came from')
  t.is(opens, 2, 'the mismatch was caught on the second pass')
  t.is(objects.size, 0, 'nothing was uploaded on the strength of bytes the tree does not commit to')
  t.is(await residentBlockBytes(), ASSET_BLOCK_SIZE, 'only the block written before the mismatch is on disk, and no asset was published')
})
