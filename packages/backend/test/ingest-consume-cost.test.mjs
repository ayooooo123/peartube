import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore } from '../src/archive/remote-block-store.js'
import {
  ASSET_BLOCK_SIZE,
  STAGING_UPLOAD_CONCURRENCY,
  verifyStaticAssetDescriptor,
  writeStaticAsset,
} from '../src/assets/static-core.js'

// What this file measures, and why it exists.
//
// A relay archiving a title off a single held HTTP response was moving 0.41
// MB/s while the source was demonstrably capable of far more: the upstream
// served 1.72 GiB in one response and cold opens had already been eliminated,
// yet throughput did not move. That leaves the consumer, and the consumer is
// pass 1 of the streaming ingest: read a canonical block, append it, upload it
// under the staging key, make the object store confirm it, drop the local copy.
//
// The number that decides the question is not how long an upload takes — it is
// how long the SOURCE spends not being read while one happens. A download's
// throughput is set by how fast its consumer drains it; every millisecond
// between one chunk being handed over and the next being asked for is a
// millisecond of an idle connection with a full receive window. So the source
// here times its own consumer, and the object store charges a realistic round
// trip for every operation.

// A round trip to a real bucket, scaled down so the whole file runs in seconds.
// The absolute numbers do not matter; the RATIO between what the uploads cost
// and what the download stalls for is the measurement.
const PUT_MS = 40
const HEAD_MS = 15
const GET_MS = 40
const DELETE_MS = 5

// Enough blocks that a pipeline has room to fill and to drain, and that per
// block averages mean something.
const BLOCK_COUNT = 16
const TAIL_BYTES = 1000
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES

const WINDOW_BLOCKS = 2
const WINDOW_BYTES = WINDOW_BLOCKS * ASSET_BLOCK_SIZE

// Pass 2's bound, unchanged by anything here: the offload window plus the one
// block being moved, held twice while it is moved.
const PASS2_PEAK_BOUND = WINDOW_BYTES + (2 * ASSET_BLOCK_SIZE)

// Pass 1's bound. A block's local copy is the only copy until the object store
// confirms it holds the object, so overlapping N uploads keeps N local copies.
// It is a constant times the block size, so it does not grow with the title.
const PASS1_PEAK_BOUND = STAGING_UPLOAD_CONCURRENCY * ASSET_BLOCK_SIZE

// The whole write's bound is whichever of the two passes costs more, and with
// a window this small that is pass 1. Neither term contains the title.
const PEAK_BOUND = Math.max(PASS1_PEAK_BOUND, PASS2_PEAK_BOUND)

const PREFIX = 'relay'

// Deliberately not block-aligned, like a real socket's chunks.
const CHUNK_BYTES = 100000

const clock = typeof globalThis.performance?.now === 'function'
  ? () => globalThis.performance.now()
  : () => Date.now()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function round(ms) {
  return Math.round(ms * 10) / 10
}

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

/**
 * A one-shot source that times its own consumer.
 *
 * A generator resumes only when somebody asks it for the next chunk, so the
 * span between handing a chunk over and being resumed IS the window in which a
 * real socket would be sitting on a full receive window with nobody draining
 * it. Summed, that is the download's stall — the thing 0.41 MB/s is made of.
 */
function timedSource(chunks) {
  const timing = { stalls: [], stalledMs: 0, wallMs: 0, iterations: 0 }
  return {
    timing,
    async *[Symbol.asyncIterator]() {
      timing.iterations++
      if (timing.iterations > 1) throw new Error('source iterated more than once')
      const openedAt = clock()
      for (const chunk of chunks) {
        const handedAt = clock()
        yield chunk
        const stalled = clock() - handedAt
        timing.stalls.push(stalled)
        timing.stalledMs += stalled
      }
      timing.wallMs = clock() - openedAt
    },
  }
}

/**
 * An object store with a real round trip, which charges every operation to the
 * core it was made against. Staging-key traffic is pass 1; finished-key traffic
 * is pass 2. The `inflight` high-water mark is how the test sees whether
 * uploads are overlapping at all, and by how much.
 */
function createTimingProvider() {
  const objects = new Map()
  const cost = {
    put: { staging: 0, final: 0, count: { staging: 0, final: 0 } },
    has: { staging: 0, final: 0, count: { staging: 0, final: 0 } },
    get: { staging: 0, final: 0, count: { staging: 0, final: 0 } },
    delete: { staging: 0, final: 0, count: { staging: 0, final: 0 } },
  }
  const state = { stagingKeyHex: null, inflight: 0, peakInflight: 0 }
  const hooks = { onPut: null, onHas: null }

  function role(key) {
    return state.stagingKeyHex !== null && key.startsWith(`${PREFIX}/blocks/${state.stagingKeyHex}/`)
      ? 'staging'
      : 'final'
  }

  function charge(op, key, elapsed) {
    const which = role(key)
    cost[op][which] += elapsed
    cost[op].count[which]++
  }

  return {
    objects,
    cost,
    state,
    hooks,
    role,
    provider: {
      async putBlock({ key, data }) {
        const startedAt = clock()
        state.inflight++
        if (state.inflight > state.peakInflight) state.peakInflight = state.inflight
        try {
          if (hooks.onPut !== null) await hooks.onPut(key)
          await sleep(PUT_MS)
          objects.set(key, b4a.from(data))
          return { success: true }
        } finally {
          state.inflight--
          charge('put', key, clock() - startedAt)
        }
      },
      async hasBlock({ key }) {
        const startedAt = clock()
        try {
          await sleep(HEAD_MS)
          const held = objects.has(key)
          if (held && hooks.onHas !== null) await hooks.onHas(key)
          return held
        } finally {
          charge('has', key, clock() - startedAt)
        }
      },
      async getBlock({ key }) {
        const startedAt = clock()
        try {
          await sleep(GET_MS)
          return objects.has(key) ? objects.get(key) : null
        } finally {
          charge('get', key, clock() - startedAt)
        }
      },
      async deleteBlock({ key }) {
        const startedAt = clock()
        try {
          await sleep(DELETE_MS)
          objects.delete(key)
          return { success: true }
        } finally {
          charge('delete', key, clock() - startedAt)
        }
      },
    },
  }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-consume-cost-'))
  const timing = createTimingProvider()

  // The unwrapped storage: a view of local disk that cannot restore anything,
  // so residency measured through it is real bytes rather than a counter kept
  // by the code under test.
  const raw = Hypercore.defaultStorage(directory)
  const storage = createOffloadStorage({
    storage: raw,
    resolveStore: ({ keyHex }) => (
      typeof keyHex === 'string'
        ? createRemoteBlockStore({ provider: timing.provider, prefix: PREFIX, coreKey: keyHex })
        : null
    ),
  })
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

  /**
   * Which blocks of one core still have DATA on local disk, read past the
   * offload wrapper so a missing block cannot be restored behind the test's
   * back.
   */
  async function localBlocks(discoveryKey) {
    const view = await raw.resumeCore(discoveryKey)
    if (!view) return new Set()
    const indexes = new Set()
    try {
      for await (const { index } of view.createBlockStream()) indexes.add(index)
    } finally {
      await view.close()
    }
    return indexes
  }

  function storeFor(core) {
    return createRemoteBlockStore({ provider: timing.provider, prefix: PREFIX, coreKey: core.key })
  }

  function offloaderFor(core, options = {}) {
    return createBlockOffloader({
      core,
      store: storeFor(core),
      windowBytes: WINDOW_BYTES,
      ...options,
    })
  }

  return { store, raw, timing, residentBlockBytes, localBlocks, storeFor, offloaderFor }
}

test('pass 1 overlaps its uploads with the download instead of idling the connection between blocks', async (t) => {
  const { store, timing, residentBlockBytes, localBlocks, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)
  const source = timedSource(chunksOf(bytes))

  let stagingCore = null
  let pass1EndedAt = null
  let pass1PeakOnDisk = 0
  let peakOnDisk = 0

  // Confirm-before-delete, observed at the only instant that can disprove it:
  // a block's local copy must still be on disk while its object is being put,
  // and while the store is answering that it holds it.
  const droppedEarly = []
  const stagedIndexOf = (key) => Number(key.slice(key.lastIndexOf('/') + 1))

  async function sample() {
    const onDisk = await residentBlockBytes()
    if (onDisk > peakOnDisk) peakOnDisk = onDisk
    return onDisk
  }

  timing.hooks.onPut = async (key) => {
    const onDisk = await sample()
    if (timing.role(key) !== 'staging') return
    if (onDisk > pass1PeakOnDisk) pass1PeakOnDisk = onDisk
    const index = stagedIndexOf(key)
    const present = await localBlocks(stagingCore.discoveryKey)
    if (!present.has(index)) droppedEarly.push({ index, at: 'put' })
  }

  timing.hooks.onHas = async (key) => {
    if (timing.role(key) !== 'staging') return
    const index = stagedIndexOf(key)
    const present = await localBlocks(stagingCore.discoveryKey)
    if (!present.has(index)) droppedEarly.push({ index, at: 'confirm' })
  }

  const startedAt = clock()
  const written = await writeStaticAsset({
    store,
    source,
    offload: {
      createStagingStore({ core }) {
        stagingCore = core
        timing.state.stagingKeyHex = b4a.toString(core.key, 'hex')
        return storeFor(core)
      },
      createOffloader({ core }) {
        // Called between the passes, so this is exactly where pass 1 ends.
        pass1EndedAt = clock()
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
  const totalMs = clock() - startedAt

  const pass1Ms = pass1EndedAt - startedAt
  const pass2Ms = totalMs - pass1Ms
  const uploadRoundTrips = timing.cost.put.staging + timing.cost.has.staging
  const perBlockRoundTrip = uploadRoundTrips / BLOCK_COUNT
  // What pass 1 would have cost with the uploads serialised against the read:
  // every round trip, end to end, plus the local work.
  const serialisedPass1Ms = uploadRoundTrips + (pass1Ms - source.timing.stalledMs)
  const localWorkMs = pass1Ms - source.timing.stalledMs

  t.comment('--- pass 1: one read of a one-shot source ---')
  t.comment(`blocks                       ${BLOCK_COUNT} x ${ASSET_BLOCK_SIZE} B (${BYTE_LENGTH} B)`)
  t.comment(`object store round trip      put ${PUT_MS}ms, head ${HEAD_MS}ms, get ${GET_MS}ms, delete ${DELETE_MS}ms`)
  t.comment(`pass 1 wall                  ${round(pass1Ms)}ms`)
  t.comment(`  download stalled           ${round(source.timing.stalledMs)}ms (${Math.round((source.timing.stalledMs / pass1Ms) * 100)}% of pass 1)`)
  t.comment(`  hash + append + storage    ${round(localWorkMs)}ms`)
  t.comment(`upload round trips issued    ${round(uploadRoundTrips)}ms total, ${round(perBlockRoundTrip)}ms per block`)
  t.comment(`  serialised, pass 1 costs   ${round(serialisedPass1Ms)}ms (before)`)
  t.comment(`  overlapped, pass 1 costs   ${round(pass1Ms)}ms (after)`)
  t.comment(`peak uploads in flight       ${timing.state.peakInflight} (limit ${STAGING_UPLOAD_CONCURRENCY})`)
  t.comment('--- pass 2: staged objects into the finished core ---')
  t.comment(`pass 2 wall                  ${round(pass2Ms)}ms`)
  t.comment(`  restore staged blocks      ${round(timing.cost.get.staging)}ms over ${timing.cost.get.count.staging} gets`)
  t.comment(`  offload finished blocks    ${round(timing.cost.put.final + timing.cost.has.final)}ms over ${timing.cost.put.count.final} puts`)
  t.comment(`  purge staging objects      ${round(timing.cost.delete.staging)}ms over ${timing.cost.delete.count.staging} deletes`)
  t.comment(`total wall                   ${round(totalMs)}ms`)

  // The measurement, as an assertion. Serialised, the download stalls for every
  // upload round trip it triggers; overlapped, it stalls for a fraction of one.
  t.ok(
    source.timing.stalledMs < uploadRoundTrips / 2,
    `the download stalled ${round(source.timing.stalledMs)}ms, well under the ${round(uploadRoundTrips)}ms of upload round trips it paid for`
  )
  t.ok(
    timing.state.peakInflight > 1,
    `uploads really did overlap: ${timing.state.peakInflight} in flight at once`
  )
  t.ok(
    timing.state.peakInflight <= STAGING_UPLOAD_CONCURRENCY,
    `and never more than the ${STAGING_UPLOAD_CONCURRENCY} the bound allows`
  )

  // Safety: nothing above may cost the ordering or the bound.
  t.alike(droppedEarly, [], 'no staged block was dropped from local disk before the object store confirmed it')
  t.ok(
    pass1PeakOnDisk <= PASS1_PEAK_BOUND,
    `pass 1 held at most ${pass1PeakOnDisk} B on disk, within the ${PASS1_PEAK_BOUND} B the overlap allows`
  )
  t.ok(pass1PeakOnDisk < BYTE_LENGTH, 'which is less than the title, so the overlap is not the title in memory')
  t.is(written.ingest.peakLocalBytes, PASS2_PEAK_BOUND, 'pass 2 still peaks at the window plus the block being moved')
  t.ok(peakOnDisk <= PEAK_BOUND, `and no sample of real local disk exceeded ${PEAK_BOUND} B across either pass`)

  t.is(source.timing.iterations, 1, 'the one-shot source was read exactly once')
  t.is(written.ingest.mode, 'streaming', 'on the streaming path')
  t.is(written.ingest.blocks, BLOCK_COUNT, 'every canonical block was ingested')
  t.is(written.ingest.bytes, BYTE_LENGTH, 'accounting for every byte')
  t.is(written.ingest.offload.confirmed, written.ingest.offload.blocksOffloaded, 'every offloaded block was confirmed before its local copy went')
  t.alike(written.ingest.staging, {
    uploaded: BLOCK_COUNT,
    restored: BLOCK_COUNT,
    deleted: BLOCK_COUNT,
    orphaned: [],
  }, 'and every staging object is accounted for and gone')

  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'the finished core verifies against its descriptor')
  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await written.core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: written.core.length } })
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'and serves every block byte for byte, offloaded or not')

  await written.core.close()
})

test('an upload that never lands fails the ingest rather than losing the block', async (t) => {
  const { store, timing, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const source = timedSource(chunksOf(bytes))

  // The failure that overlap must not be allowed to swallow: a put that throws
  // several blocks into the pipeline, while other uploads are in flight.
  const failAt = 5
  const put = timing.provider.putBlock
  timing.provider.putBlock = async (request) => {
    if (timing.role(request.key) === 'staging' && Number(request.key.slice(request.key.lastIndexOf('/') + 1)) === failAt) {
      throw new Error('the bucket refused the upload')
    }
    return put(request)
  }

  await t.exception(
    writeStaticAsset({
      store,
      source,
      offload: {
        createStagingStore({ core }) {
          timing.state.stagingKeyHex = b4a.toString(core.key, 'hex')
          return storeFor(core)
        },
        createOffloader({ core }) {
          return offloaderFor(core)
        },
      },
    }),
    /the bucket refused the upload/,
    'a staged upload that fails fails the whole write, in flight or not'
  )
})

test('a resume finds the block that overlapped uploads left behind, not just the end of the prefix', async (t) => {
  const { store, timing, storeFor, offloaderFor } = await fixture(t)
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)

  // Overlapping uploads is what makes this case exist. Blocks land out of
  // order, so an interruption no longer leaves the bucket holding a clean
  // prefix of the staged tree — it leaves a HOLE, with confirmed blocks above
  // it. The old resume looked for the end of a prefix by bisection, which is a
  // question a set with a hole in it has no honest answer to.
  const holeAt = 2
  const put = timing.provider.putBlock
  const stagedIndexOf = (key) => Number(key.slice(key.lastIndexOf('/') + 1))
  let breakOnHole = true
  const resumePuts = []

  timing.provider.putBlock = async (request) => {
    const staged = timing.role(request.key) === 'staging'
    const index = staged ? stagedIndexOf(request.key) : null
    if (!breakOnHole && staged) resumePuts.push(index)
    if (breakOnHole && staged && index === holeAt) {
      // Fail late, so the blocks queued behind this one have time to land and
      // the interruption really does leave a hole rather than a short prefix.
      await sleep(PUT_MS * 6)
      throw new Error('the bucket refused the upload')
    }
    return put(request)
  }

  const offload = {
    createStagingStore({ core }) {
      timing.state.stagingKeyHex = b4a.toString(core.key, 'hex')
      return storeFor(core)
    },
    createOffloader({ core }) {
      return offloaderFor(core)
    },
  }

  const resumeId = 'ing_resume_0000000000000000000042'
  const etag = '"remote-sha256-0123456789abcdef"'
  const opens = []
  const open = ({ byteOffset, blockIndex }) => {
    opens.push({ byteOffset, blockIndex })
    return (async function *() {
      for (let offset = byteOffset; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        yield bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength))
      }
    })()
  }

  const interrupted = await writeStaticAsset({ store, offload, resume: { id: resumeId, etag, open } })
    .then(() => null, (error) => error)

  t.is(interrupted?.message, 'the bucket refused the upload', 'the interruption is the upload that would not land')
  t.is(interrupted?.staging?.retained, true, 'and the staged prefix is kept, because it is still truthful')

  const confirmedAfterBreak = [...timing.objects.keys()].map(stagedIndexOf).sort((a, b) => a - b)
  t.absent(confirmedAfterBreak.includes(holeAt), `block ${holeAt} never made it to the bucket`)
  t.ok(
    confirmedAfterBreak.some((index) => index > holeAt),
    `while blocks above it did: ${confirmedAfterBreak.join(', ')} — a hole, not a prefix`
  )

  breakOnHole = false
  const resumed = await writeStaticAsset({ store, offload, resume: { id: resumeId, etag, open } })

  t.ok(resumePuts.includes(holeAt), `the resume went back for block ${holeAt} rather than trusting the end of the run`)
  for (const index of confirmedAfterBreak) {
    t.absent(resumePuts.includes(index), `and did not re-upload block ${index}, which the bucket already held`)
  }
  t.is(opens.length, 2, 'the source was opened once per attempt')
  t.ok(opens[1].blockIndex > holeAt, 'and the resumed read picked up after the staged tree, not at the hole')

  t.is(resumed.ingest.blocks, BLOCK_COUNT, 'every canonical block was ingested')
  t.is(resumed.ingest.bytes, BYTE_LENGTH, 'accounting for every byte')
  t.alike(resumed.ingest.staging, {
    uploaded: BLOCK_COUNT,
    restored: BLOCK_COUNT,
    deleted: BLOCK_COUNT,
    orphaned: [],
    resumed: opens[1].blockIndex,
  }, 'and every staging object, hole included, is accounted for and gone')

  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'the finished core verifies against its descriptor')
  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await resumed.core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: resumed.core.length } })
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'and serves every block byte for byte, including the one the interruption left behind')

  await resumed.core.close()
})
