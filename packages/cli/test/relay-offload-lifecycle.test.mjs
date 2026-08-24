import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import c from 'compact-encoding'
import Hypercore from 'hypercore'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'

import { ASSET_BLOCK_SIZE, verifyStaticAssetDescriptor, writeStaticAsset } from '@peartube/backend/assets'
import {
  prioritizeBlobServerRangeRequest,
  releaseAllPrioritizedBlobRanges
} from '@peartube/backend/blob-range-priority'

import { createRelayBlockOffload } from '../src/archive/block-offload.js'

// Corestore is the backend's dependency, not the CLI's — the relay only ever
// sees the store the backend built. Resolving it through the backend package is
// how this test gets the same class the relay runs on without the CLI claiming
// a dependency it does not have.
const Corestore = createRequire(import.meta.resolve('@peartube/backend/assets'))('corestore')

// Does the cloud tier actually run in production? The existing suites drive
// createBlockOffloader and createOffloadStorage directly, with hand-built cores
// and hand-written offloaders. Nothing drove the capability the relay itself
// builds — createRelayBlockOffload — through an asset write, which is the only
// path a real title ever takes. That gap is why a relay reporting
// `blockOffload.enabled: true` alongside `blocksOffloaded: 0` looked plausible.
//
// So this is the whole lifecycle with only the HTTP transport faked: resolved
// operator config, the real provider, the real remote block store, the real
// storage wrapper, and writeStaticAsset as the entry point. Every residency
// number is read off the UNWRAPPED storage instance, which cannot restore
// anything, so it is bytes on the relay's volume and not a counter's opinion.

// Three and a half windows of title. The claim is the BOUND, not the volume: a
// megabyte and a half proves the window governs residency exactly as well as a
// terabyte would, and the relay's disk is not the thing under test.
const WINDOW_BLOCKS = 2
const WINDOW_BYTES = WINDOW_BLOCKS * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 7
const TAIL_BYTES = 1000
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES

// The window slides one block at a time as the ingest moves past it, so what is
// left resident at the end is the tail of the title inside the window.
const OFFLOADED_BLOCKS = BLOCK_COUNT - WINDOW_BLOCKS
const OFFLOADED_BYTES = OFFLOADED_BLOCKS * ASSET_BLOCK_SIZE
const RESIDENT_AFTER = ASSET_BLOCK_SIZE + TAIL_BYTES

// Source chunks are deliberately not block-aligned: a download grant serves
// whatever window it was asked for, so the ingest has to re-chunk into
// canonical blocks on both passes.
const CHUNK_BYTES = 100_000

const BUCKET = 'peartube-archive'
const PREFIX = 'relay'

function assetBytes () {
  const bytes = b4a.alloc(BYTE_LENGTH)
  let state = 0x2f6e2b1
  for (let index = 0; index < BYTE_LENGTH; index++) {
    state = ((state * 1103515245) + 12345) & 0x7fffffff
    bytes[index] = (state >>> 16) & 0xff
  }
  return bytes
}

function canonicalBlocks (bytes) {
  const blocks = []
  for (let start = 0; start < bytes.byteLength; start += ASSET_BLOCK_SIZE) {
    blocks.push(bytes.subarray(start, Math.min(start + ASSET_BLOCK_SIZE, bytes.byteLength)))
  }
  return blocks
}

function chunksOf (bytes) {
  const chunks = []
  for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
    chunks.push(bytes.subarray(start, Math.min(start + CHUNK_BYTES, bytes.byteLength)))
  }
  return chunks
}

async function * replay (chunks) {
  yield * chunks
}

/**
 * A one-shot source: a generator object that refuses to be iterated twice,
 * which is what a network download is. This is the shape the relay's archive
 * ingest really hands the writer, and the one that has to reach the bucket
 * through the capability's staging store rather than be buffered.
 */
function oneShotSource (chunks) {
  let opened = false
  return {
    [Symbol.asyncIterator] () {
      if (opened) throw new Error('this source can only be read once')
      opened = true
      return replay(chunks)[Symbol.asyncIterator]()
    }
  }
}

/**
 * A bucket in a Map, behind the provider's own fetch. PUT stores, HEAD is the
 * confirmation that has to answer yes before any local copy is dropped, GET is
 * a restore, 404 is absence.
 */
function createFakeBucket () {
  const objects = new Map()
  const requests = []
  async function fetchImpl (url, init = {}) {
    const key = new URL(url).pathname.slice(1)
    const method = (init.method || 'GET').toUpperCase()
    requests.push(`${method} ${key}`)
    if (method === 'PUT') {
      objects.set(key, b4a.from(init.body))
      return { ok: true, status: 200 }
    }
    if (!objects.has(key)) return { ok: false, status: 404 }
    if (method === 'HEAD') return { ok: true, status: 200 }
    if (method === 'DELETE') {
      objects.delete(key)
      return { ok: true, status: 200 }
    }
    const body = objects.get(key)
    return {
      ok: true,
      status: 200,
      async arrayBuffer () {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      }
    }
  }
  return { objects, requests, fetchImpl }
}

function relayConfig (offloadWindowBytes) {
  return {
    archive: {
      s3: {
        offload: true,
        endpoint: 'https://s3.example.com',
        bucket: BUCKET,
        accessKeyId: 'AKIA-TEST',
        secretAccessKey: 'secret',
        prefix: PREFIX,
        offloadWindowBytes
      }
    }
  }
}

/**
 * The relay's storage as the service builds it: the operator's config through
 * createRelayBlockOffload, its wrapper around the real CorestoreStorage, and a
 * Corestore over that. `raw` is the unwrapped instance the wrapper delegates to,
 * so reading through it is a view of local disk with no restore path.
 */
async function fixture (t, { window: offloadWindowBytes }) {
  const bucket = createFakeBucket()
  const offload = await createRelayBlockOffload({
    config: relayConfig(offloadWindowBytes),
    fetchImpl: bucket.fetchImpl,
    createSigner: ({ key }) => ({ url: `https://${BUCKET}.s3.example.com/${key}` })
  })

  const directory = mkdtempSync(join(tmpdir(), 'pt-relay-offload-lifecycle-'))
  const raw = Hypercore.defaultStorage(directory)
  const storage = offload.wrapStorage(raw)
  const store = new Corestore(storage)
  await store.ready()

  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  /**
   * Every byte of block data on local disk, across every core in the store —
   * the staging core included. This is the number the relay's volume sees.
   */
  async function residentBlockBytes () {
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

  async function residency (discoveryKey) {
    const view = await raw.resumeCore(discoveryKey)
    const indices = []
    let bytes = 0
    for await (const block of view.createBlockStream()) {
      indices.push(block.index)
      bytes += block.value.byteLength
    }
    await view.close()
    return { bytes, indices }
  }

  return { bucket, offload, storage, store, raw, residentBlockBytes, residency }
}

test('a title written through the relay capability leaves the volume for the bucket and reads back whole', async (t) => {
  const { bucket, offload, store, residentBlockBytes } = await fixture(t, { window: WINDOW_BYTES })
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)

  // `offload` is passed exactly as upload.js passes it: the capability object,
  // whose createOffloader is what turns this into a bounded ingest.
  const written = await writeStaticAsset({
    store,
    createSource: () => replay(chunksOf(bytes)),
    offload
  })

  t.is(written.ingest.mode, 'reopen', 'a re-openable source is read twice rather than pushed through the bucket')
  t.is(written.ingest.blocks, BLOCK_COUNT, 'every canonical block was ingested')
  t.is(written.ingest.bytes, BYTE_LENGTH, 'accounting for every byte of the title')
  t.is(written.ingest.windowBytes, WINDOW_BYTES, 'and the ingest reports the window the operator configured')
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the finished core verifies against its descriptor')

  // The assertion production was failing silently: a relay with offload enabled
  // that had never moved a block.
  const stats = offload.stats()
  t.is(stats.enabled, true, 'the capability reports itself enabled')
  t.ok(stats.blocksOffloaded > 0, 'and the cloud tier actually engaged, which is what blocksOffloaded: 0 meant it had not')
  t.is(stats.blocksOffloaded, OFFLOADED_BLOCKS, 'every block the window slid past left the volume')
  t.is(stats.bytesOffloaded, OFFLOADED_BYTES, 'and the bytes reported are those blocks bytes')
  t.is(bucket.objects.size, OFFLOADED_BLOCKS, 'the bucket holds exactly them')

  // Confirm-before-delete, per block. A delete without its own confirmation is
  // a delete of the only copy.
  t.is(written.ingest.offload.confirmed, stats.blocksOffloaded, 'no block was deleted locally without the bucket confirming it holds it')
  t.is(written.ingest.offload.pending, WINDOW_BLOCKS, 'and the blocks still resident are the window, not a backlog')

  // THIS is the unlimited-capacity claim: what stayed on the volume is a
  // function of the window the operator set, not of the size of the title.
  const resident = await residentBlockBytes()
  t.is(resident, RESIDENT_AFTER, 'what is left on local disk is the tail of the title inside the window')
  t.ok(resident <= WINDOW_BYTES, 'local block data is bounded by the window')
  t.ok(resident < BYTE_LENGTH, 'so a title larger than the volume archives, which is the whole point of the tier')

  // Restore on read. A block whose only copy is in the bucket has to come back
  // byte-identical, or the relay is serving corruption to a peer.
  const before = offload.stats().restored
  const restored = await written.core.get(0)
  t.alike(restored, blocks[0], 'a block that exists only in the bucket reads back byte-identical')
  t.is(offload.stats().restored, before + 1, 'and the read is visible as a restore')

  const served = []
  let advertised = 0
  for (let index = 0; index < BLOCK_COUNT; index++) {
    if (await written.core.has(index)) advertised++
    served.push(await written.core.get(index))
  }
  t.is(advertised, BLOCK_COUNT, 'the relay still advertises the whole title, offloaded or not')
  t.alike(served, blocks, 'and serves every block of it')
  t.is(offload.stats().restored, before + 1 + OFFLOADED_BLOCKS, 'exactly the offloaded blocks needed a restore')
  t.is(await residentBlockBytes(), RESIDENT_AFTER, 'and reading the title back left residency at the window, not at the title')

  await written.core.close()
})

test('a one-shot download archives through the capability staging store and leaves nothing behind', async (t) => {
  const { bucket, offload, store, residentBlockBytes } = await fixture(t, { window: WINDOW_BYTES })
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)

  // The relay's real archive path: the title arrives over the network once and
  // cannot be re-read, so pass 2 has to get it back from the bucket.
  const written = await writeStaticAsset({
    store,
    source: oneShotSource(chunksOf(bytes)),
    offload
  })

  t.is(written.ingest.mode, 'streaming', 'a source that can only be read once went through the staging store')
  t.is(written.ingest.bytes, BYTE_LENGTH, 'and every byte of the download landed')
  t.alike(
    written.ingest.staging,
    { uploaded: BLOCK_COUNT, restored: BLOCK_COUNT, deleted: BLOCK_COUNT, orphaned: [] },
    'every staged block went to the bucket, came back for the transplant, and was deleted once the finished core verified'
  )

  const stats = offload.stats()
  t.is(stats.blocksOffloaded, OFFLOADED_BLOCKS, 'the relay counted the blocks that left, once each')
  t.is(stats.bytesOffloaded, OFFLOADED_BYTES, 'and their bytes')
  t.is(bucket.objects.size, OFFLOADED_BLOCKS, 'and what the bucket is left holding is the offloaded title, not a staging copy of it')

  const resident = await residentBlockBytes()
  t.is(resident, RESIDENT_AFTER, 'local block data is the window, off a download that was never re-read')
  t.ok(resident < BYTE_LENGTH, 'so the relay archives a title it could not have held')

  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) served.push(await written.core.get(index))
  t.alike(served, blocks, 'and the title reads back byte-identical to what was downloaded')

  await written.core.close()
})

// A player reading through a block is the one condition under which taking it
// back off local disk is worse than keeping it: the next read would stall on a
// bucket round trip mid-stream. The relay wires that decision to the registry
// the blob server writes into, so the only honest way to test it is to put a
// real prioritized range in that registry.
const PIN_BLOCK_SIZE = 1024
const PIN_BLOCK_COUNT = 9
const PIN_WINDOW_BLOCKS = 3
const PIN_WINDOW_BYTES = PIN_WINDOW_BLOCKS * PIN_BLOCK_SIZE
const PIN_WINDOW_INDICES = [6, 7, 8]
const PINNED_INDICES = [0, 1]

// The blob-server range request's `blob` parameter: z32 over four compact
// uints, which is what decodeBlobParam reads back.
const blobIdEncoding = {
  preencode (state, blob) {
    c.uint.preencode(state, blob.blockOffset)
    c.uint.preencode(state, blob.blockLength)
    c.uint.preencode(state, blob.byteOffset)
    c.uint.preencode(state, blob.byteLength)
  },
  encode (state, blob) {
    c.uint.encode(state, blob.blockOffset)
    c.uint.encode(state, blob.blockLength)
    c.uint.encode(state, blob.byteOffset)
    c.uint.encode(state, blob.byteLength)
  }
}

/**
 * Register the blocks a player is blocking on, through the real entry point.
 *
 * The core handed to the priority registry is a stand-in whose download never
 * finishes, because a range over blocks this relay already holds would resolve
 * instantly and un-pin itself before any sweep could see it. What is being
 * tested is the sweep's response to a live prioritized range, not hypercore's
 * replication.
 */
async function pinPlayback (core, { blocks, blockSize }) {
  const blob = {
    blockOffset: 0,
    blockLength: blocks,
    byteOffset: 0,
    byteLength: blocks * blockSize
  }
  const held = { done: () => new Promise(() => {}), destroy () {} }
  const range = await prioritizeBlobServerRangeRequest(
    { token: '', _getCore: async () => ({ download: () => held }) },
    {
      method: 'GET',
      url: `/?key=${HypercoreID.encode(core.key)}&blob=${z32.encode(c.encode(blobIdEncoding, blob))}`,
      headers: { range: `bytes=0-${(PINNED_INDICES.length * blockSize) - 1}` }
    },
    // No read-ahead: the prioritized window is exactly the requested bytes, so
    // the pinned blocks are the two this test names.
    { readAheadBytes: 0, timeoutMs: 60_000 }
  )
  return range
}

test('a block a player is reading through survives the relay residency sweep', async (t) => {
  const { offload, storage, store, residency } = await fixture(t, { window: PIN_WINDOW_BYTES })
  t.teardown(() => releaseAllPrioritizedBlobRanges())

  const core = store.get({ name: 'media' })
  await core.ready()
  // Settles the sweep that opening the core armed, so the counters below are
  // this test's sweeps and not the empty core's.
  await storage.offloadSweep()

  for (let index = 0; index < PIN_BLOCK_COUNT; index++) {
    await core.append(b4a.alloc(PIN_BLOCK_SIZE, (index + 1) & 0xff))
  }
  const discoveryKey = b4a.from(core.discoveryKey)

  const range = await pinPlayback(core, { blocks: PIN_BLOCK_COUNT, blockSize: PIN_BLOCK_SIZE })
  t.alike(
    { start: range?.start, end: range?.end },
    { start: PINNED_INDICES[0], end: PINNED_INDICES[PINNED_INDICES.length - 1] + 1 },
    'the player registered interest in exactly the blocks this test pins'
  )

  const before = offload.stats()
  await storage.offloadSweep()
  const after = offload.stats()

  t.alike(
    await residency(discoveryKey),
    {
      bytes: PIN_WINDOW_BYTES + (PINNED_INDICES.length * PIN_BLOCK_SIZE),
      indices: [...PINNED_INDICES, ...PIN_WINDOW_INDICES]
    },
    'the blocks the player is reading stayed on disk, and residency is over the window by exactly them'
  )
  t.is(after.playbackPinned - before.playbackPinned, PINNED_INDICES.length, 'the relay counted the blocks it left for the player')
  t.is(
    after.blocksEvicted - before.blocksEvicted,
    PIN_BLOCK_COUNT - PIN_WINDOW_BLOCKS - PINNED_INDICES.length,
    'and gave back every other block below the window'
  )

  // Pinning delays an eviction, it does not cancel one.
  releaseAllPrioritizedBlobRanges()
  await storage.offloadSweep()
  t.alike(
    await residency(discoveryKey),
    { bytes: PIN_WINDOW_BYTES, indices: PIN_WINDOW_INDICES },
    'the first sweep past the playhead takes them'
  )

  let advertised = 0
  for (let index = 0; index < PIN_BLOCK_COUNT; index++) {
    if (await core.has(index)) advertised++
  }
  t.is(advertised, PIN_BLOCK_COUNT, 'and every block is still advertised')

  await core.close()
})
