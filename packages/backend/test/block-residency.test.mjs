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

// Offloading a title once is a saving; keeping it offloaded is a storage
// extension. These tests are about the second thing: whatever puts block data
// back on the volume — a restore the bucket could not answer, a peer that
// filled the gap, a relay that boots with a full cache — the offload-backed
// core's local block data has to end up inside the window again.
//
// Every residency number below is read off the UNWRAPPED storage instance the
// wrapper delegates to. That path cannot restore anything, so it counts bytes
// on local disk and nothing else. An offload counter would not: the whole
// failure being tested is a footprint no counter was watching.

// Nine kilobytes prove a bound exactly as well as nine gigabytes, and the
// relay's disk is not the thing under test.
const BLOCK_SIZE = 1024
const WINDOW_BLOCKS = 3
const WINDOW_BYTES = WINDOW_BLOCKS * BLOCK_SIZE
const BLOCK_COUNT = 9
const WINDOW_INDICES = [6, 7, 8]
const PREFIX = 'relay'

function blocksOf (count) {
  const blocks = []
  for (let index = 0; index < count; index++) {
    blocks.push(b4a.alloc(BLOCK_SIZE, (index + 1) & 0xff))
  }
  return blocks
}

/**
 * An object store in a Map, with every call logged so a test can assert the
 * ORDER of upload, confirmation and delete rather than just the totals.
 *
 * `confirm: false` is the store that will not say it holds a block — the one
 * condition under which nothing may ever be deleted locally. `serve: false` is
 * a store that cannot answer a restore, which is what turns a served block into
 * a block a peer supplies and hypercore commits.
 */
function createBucket () {
  const objects = new Map()
  const log = []
  const state = { confirm: true, serve: true }
  const provider = {
    async putBlock ({ key, data }) {
      log.push(`put ${key}`)
      if (state.confirm === true) objects.set(key, b4a.from(data))
      return { success: state.confirm === true }
    },
    async hasBlock ({ key }) {
      log.push(`has ${key}`)
      return state.confirm === true && objects.has(key)
    },
    async getBlock ({ key }) {
      log.push(`get ${key}`)
      if (state.serve !== true) return null
      return objects.has(key) ? objects.get(key) : null
    },
    async deleteBlock ({ key }) {
      log.push(`delete ${key}`)
      objects.delete(key)
      return { success: true }
    },
  }
  return { objects, log, state, provider }
}

function storeFor (bucket, coreKey) {
  return createRemoteBlockStore({ provider: bucket.provider, prefix: PREFIX, coreKey })
}

function puts (bucket) {
  return bucket.log.reduce((total, entry) => total + (entry.startsWith('put ') ? 1 : 0), 0)
}

/**
 * One relay's storage, on `directory`.
 *
 * `window: null` is a relay with no eviction configured at all — the control
 * for every "and without it, nothing changed" assertion. `sweepEveryReads: 1`
 * only moves the automatic trigger's threshold; nine-block titles would never
 * reach the production one.
 */
async function openRelay (t, directory, { bucket, window = WINDOW_BYTES, isPinned = null, offloaded = null } = {}) {
  const raw = Hypercore.defaultStorage(directory)
  const lookups = []
  const messages = []
  const storage = createOffloadStorage({
    storage: raw,
    resolveStore: (identity) => {
      lookups.push(identity)
      if (typeof identity.keyHex !== 'string') return null
      if (offloaded !== null && !offloaded.has(identity.keyHex)) return null
      return storeFor(bucket, identity.keyHex)
    },
    eviction: window === null ? null : { windowBytes: window, sweepEveryReads: 1, isPinned },
    log: (message) => messages.push(message),
  })
  const store = new Corestore(storage)
  await store.ready()

  let closed = false
  async function close () {
    if (closed) return
    closed = true
    await store.close().catch(() => {})
  }
  t.teardown(close)

  return {
    store,
    storage,
    lookups,
    messages,
    close,

    /**
     * Block data on local disk for one core, straight off the unwrapped store.
     */
    async residency (discoveryKey) {
      const view = await raw.resumeCore(discoveryKey)
      const indices = []
      let bytes = 0
      for await (const block of view.createBlockStream()) {
        indices.push(block.index)
        bytes += block.value.byteLength
      }
      await view.close()
      return { bytes, indices }
    },
  }
}

function proofFor (core, index) {
  return core.proof({
    block: { index, nodes: 0 },
    upgrade: { start: 0, length: core.length },
  })
}

async function readAll (core, count) {
  const read = []
  for (let index = 0; index < count; index++) read.push(await core.get(index))
  return read
}

async function advertised (core, count) {
  let held = 0
  for (let index = 0; index < count; index++) {
    if (await core.has(index)) held++
  }
  return held
}

/**
 * Wait for the sweep the relay armed BY ITSELF. Nothing here asks for a sweep:
 * that is the point — a relay that boots holding a full cache has to converge
 * without being told to.
 */
async function convergence (relay, discoveryKey, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const resident = await relay.residency(discoveryKey)
    if (resident.bytes <= WINDOW_BYTES || Date.now() > deadline) return resident
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a title that came back through a bucket outage does not stay resident', async (t) => {
  const bucket = createBucket()
  const peerDirectory = mkdtempSync(join(tmpdir(), 'peartube-residency-peer-'))
  const relayDirectory = mkdtempSync(join(tmpdir(), 'peartube-residency-relay-'))
  t.teardown(() => {
    rmSync(peerDirectory, { recursive: true, force: true })
    rmSync(relayDirectory, { recursive: true, force: true })
  })

  // The publisher this relay archived from, still replicating with it. That
  // connection is what makes a restore the bucket cannot answer turn back into
  // a local copy: hypercore falls through to its peers and commits what they
  // send, without ever passing through the offload wrapper.
  const peer = new Corestore(peerDirectory)
  await peer.ready()
  const source = peer.get({ name: 'title' })
  await source.ready()
  const blocks = blocksOf(BLOCK_COUNT)
  for (const block of blocks) await source.append(block)

  const relay = await openRelay(t, relayDirectory, { bucket })
  const core = relay.store.get({ key: source.key })
  await core.ready()
  const discoveryKey = b4a.from(core.discoveryKey)

  const outbound = peer.replicate(true)
  const inbound = relay.store.replicate(false)
  outbound.pipe(inbound).pipe(outbound)
  t.teardown(() => {
    outbound.destroy()
    inbound.destroy()
  })

  // 1. The archive lands whole, then the oldest end goes to the bucket. Both
  //    the ingest window and the read path's own sweep are draining the same
  //    end here, which is exactly the overlap the design allows: whichever gets
  //    to a block first, it is uploaded, confirmed and only then dropped.
  await core.download({ start: 0, end: BLOCK_COUNT }).done()
  const offloader = createBlockOffloader({ core, store: storeFor(bucket, core.key), windowBytes: WINDOW_BYTES })
  for (let index = 0; index < BLOCK_COUNT; index++) offloader.track(index, BLOCK_SIZE)
  await offloader.drain()
  await relay.storage.offloadSweep()
  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'ingest leaves the window on disk and the rest in the bucket'
  )
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'the bucket holds every block that left')
  const archived = relay.storage.stats().eviction

  // 2. The bucket stops answering, and the whole title is served anyway. Each
  //    offloaded block is a local miss the bucket cannot fill, so the publisher
  //    fills it — permanently. This is the drift the bound exists for.
  bucket.state.serve = false
  bucket.state.confirm = false
  t.alike(await readAll(core, BLOCK_COUNT), blocks, 'every block is still served during the outage')
  await relay.storage.offloadSweep()

  const grown = await relay.residency(discoveryKey)
  t.is(grown.bytes, BLOCK_COUNT * BLOCK_SIZE, 'the whole title is resident again, not the window')
  t.is(grown.indices.length, BLOCK_COUNT, 'every block of it')
  // The sweeps that ran during the outage could not get a single confirmation,
  // so they deleted nothing. A block whose only copy might be local is a block
  // that stays local.
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'and the bucket lost nothing while it would not confirm')
  const refused = relay.storage.stats().eviction
  t.ok(refused.unconfirmed > archived.unconfirmed, 'the sweep recorded that it was refused a confirmation')
  t.is(refused.evicted, archived.evicted, 'and dropped nothing at all while it was being refused')

  // 3. The bucket comes back. One sweep and the window means something again.
  bucket.state.serve = true
  bucket.state.confirm = true
  const uploaded = puts(bucket)
  const stats = await relay.storage.offloadSweep()

  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'residency is the window again, measured on disk'
  )
  t.is(stats.eviction.evicted - refused.evicted, BLOCK_COUNT - WINDOW_BLOCKS, 'the blocks outside the window were the ones evicted')
  t.is(
    stats.eviction.bytesEvicted - refused.bytesEvicted,
    (BLOCK_COUNT - WINDOW_BLOCKS) * BLOCK_SIZE,
    'and their bytes are accounted for'
  )
  t.is(stats.eviction.residentBytes, WINDOW_BYTES, 'the reported residency matches the disk')
  t.is(puts(bucket), uploaded, 'nothing was re-uploaded: the bucket already held every block, and said so before any delete')

  // 4. Serving is untouched by any of it: the bitfield was never cleared, so
  //    the relay still advertises every block and still proves every block.
  t.is(await advertised(core, BLOCK_COUNT), BLOCK_COUNT, 'the relay still advertises every block')
  const proof = await proofFor(core, 0)
  t.alike(proof.block.value, blocks[0], 'core.proof serves an evicted block byte-for-byte, restored from the bucket')
  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'and proving it did not put it back on the volume'
  )

  await core.close()
})

test('a relay that boots holding a full local cache converges to the window', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-residency-boot-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  // Written with no window at all: the volume holds the entire title and the
  // bucket holds none of it. That is the state a relay restarts in when it was
  // filling its disk before the operator configured offload — and the state an
  // in-memory residency counter can never recover from, because there is no
  // counter left.
  const before = await openRelay(t, directory, { bucket, window: null })
  const written = before.store.get({ name: 'media' })
  await written.ready()
  const blocks = blocksOf(BLOCK_COUNT)
  for (const block of blocks) await written.append(block)
  const key = b4a.from(written.key)
  const discoveryKey = b4a.from(written.discoveryKey)

  t.is((await before.residency(discoveryKey)).bytes, BLOCK_COUNT * BLOCK_SIZE, 'the whole title is on local disk')
  t.is(bucket.objects.size, 0, 'and none of it is in the bucket')
  await before.close()

  // Boot. Nothing in memory survived; opening the core is the only event, and
  // residency is re-derived from the same disk.
  const after = await openRelay(t, directory, { bucket })
  const core = after.store.get({ key })
  await core.ready()

  t.alike(
    await convergence(after, discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'the sweep the relay armed for itself brought residency back to the window'
  )
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'every block that left the volume was uploaded first')
  t.ok(after.lookups.length > 0, 'opening the core is what asked whether it is offload-backed')

  t.is(await advertised(core, BLOCK_COUNT), BLOCK_COUNT, 'the relay advertises the whole title')
  t.alike(await readAll(core, BLOCK_COUNT), blocks, 'and reads every block back byte-for-byte')
  t.alike(
    await after.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'reading the whole title back leaves residency at the window, not at the title'
  )

  await core.close()
})

test('a block a player is reading through is not evicted until the window moves on', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-residency-pinned-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  // Two blocks inside the prioritized playback window. Taking them back off
  // disk now would cost the player a bucket round trip mid-stream.
  const playing = new Set([0, 1])
  const relay = await openRelay(t, directory, {
    bucket,
    isPinned: ({ index }) => playing.has(index),
  })
  const core = relay.store.get({ name: 'media' })
  await core.ready()
  // Settles the sweep that opening the core armed, so the counters below are
  // one sweep's worth and not two.
  await relay.storage.offloadSweep()

  const blocks = blocksOf(BLOCK_COUNT)
  for (const block of blocks) await core.append(block)
  const discoveryKey = b4a.from(core.discoveryKey)

  const stats = await relay.storage.offloadSweep()
  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES + (playing.size * BLOCK_SIZE), indices: [0, 1, ...WINDOW_INDICES] },
    'the pinned blocks stayed, and residency is over the window by exactly them'
  )
  t.is(stats.eviction.pinned, playing.size, 'the sweep counted the blocks it left for the player')
  t.is(stats.eviction.evicted, BLOCK_COUNT - WINDOW_BLOCKS - playing.size, 'and evicted every other block below the window')

  // Pinning delays an eviction, it does not cancel one.
  playing.clear()
  await relay.storage.offloadSweep()
  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'the first sweep past the playhead takes them'
  )
  t.is(await advertised(core, BLOCK_COUNT), BLOCK_COUNT, 'and every block is still advertised')

  await core.close()
})

test('a core with no remote store is never evicted from', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-residency-local-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  // `offloaded` is empty, so no core resolves a remote store: every local block
  // is the only copy that exists.
  const relay = await openRelay(t, directory, { bucket, offloaded: new Set() })
  const core = relay.store.get({ name: 'media' })
  await core.ready()
  const blocks = blocksOf(BLOCK_COUNT)
  for (const block of blocks) await core.append(block)
  const discoveryKey = b4a.from(core.discoveryKey)

  const stats = await relay.storage.offloadSweep()
  t.is((await relay.residency(discoveryKey)).bytes, BLOCK_COUNT * BLOCK_SIZE, 'every block is still on local disk')
  t.is(bucket.objects.size, 0, 'nothing was uploaded')
  t.is(stats.eviction.cores, 0, 'the core was never armed for eviction')
  t.is(stats.eviction.sweeps, 0, 'so nothing was ever swept')
  t.alike(await readAll(core, BLOCK_COUNT), blocks, 'and the title reads back whole')

  await core.close()
})

test('a core that already fits inside the window is left completely alone', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-residency-small-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  // Every catalog, bee and index core a relay opens is orders of magnitude
  // smaller than a media window, and is offload-backed by the same rule a
  // rendition core is. The sweep has to recognise them as already inside the
  // bound and touch nothing: metadata blocks traded for bucket round trips
  // would turn every catalog read into a network call.
  const relay = await openRelay(t, directory, { bucket })
  const core = relay.store.get({ name: 'catalog' })
  await core.ready()
  const held = WINDOW_BLOCKS - 1
  const blocks = blocksOf(held)
  for (const block of blocks) await core.append(block)
  const discoveryKey = b4a.from(core.discoveryKey)

  const stats = await relay.storage.offloadSweep()
  t.is((await relay.residency(discoveryKey)).bytes, held * BLOCK_SIZE, 'every block is still on local disk')
  t.is(bucket.objects.size, 0, 'and none of it was uploaded')
  t.is(stats.eviction.evicted, 0, 'nothing was evicted')
  t.is(stats.eviction.residentBytes, held * BLOCK_SIZE, 'residency reports it, inside the window')
  t.alike(await readAll(core, held), blocks, 'and it reads back locally, with no round trip to make')

  await core.close()
})

test('with no window configured the wrapper evicts nothing and asks nothing', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-residency-off-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  const relay = await openRelay(t, directory, { bucket, window: null })
  const core = relay.store.get({ name: 'media' })
  await core.ready()
  const blocks = blocksOf(BLOCK_COUNT)
  for (const block of blocks) await core.append(block)
  const discoveryKey = b4a.from(core.discoveryKey)

  t.is(relay.lookups.length, 0, 'opening and filling a core asked for no remote store')

  const offloader = createBlockOffloader({ core, store: storeFor(bucket, core.key), windowBytes: WINDOW_BYTES })
  for (let index = 0; index < BLOCK_COUNT; index++) offloader.track(index, BLOCK_SIZE)
  await offloader.drain()

  t.alike(await readAll(core, BLOCK_COUNT), blocks, 'the whole title reads back through the wrapper')
  t.alike(
    await relay.residency(discoveryKey),
    { bytes: WINDOW_BYTES, indices: WINDOW_INDICES },
    'residency is exactly what the ingest left: a restore is served, never written back'
  )
  t.alike(
    relay.storage.stats(),
    { restored: BLOCK_COUNT - WINDOW_BLOCKS, missing: 0, failed: 0, corrupt: 0 },
    'and the stats carry no residency section at all'
  )
  t.alike(
    await relay.storage.offloadSweep(),
    { restored: BLOCK_COUNT - WINDOW_BLOCKS, missing: 0, failed: 0, corrupt: 0 },
    'asking for a sweep on an unconfigured wrapper does nothing'
  )
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'nothing beyond the ingest window ever reached the bucket')

  await core.close()
})

// Offload exists so a title larger than the volume can still be served. It is
// not for the cores a node keeps its own bookkeeping in: those are small, they
// are read constantly, and putting their blocks in a bucket makes every read of
// the node's own state depend on someone else's uptime. A core the operator
// keeps local is never swept - and, because it still resolves a store, whatever
// was already evicted stays readable and comes home.
test('a core held back from eviction keeps its blocks and still restores the ones already gone', async (t) => {
  const bucket = createBucket()
  const directory = mkdtempSync(join(tmpdir(), 'peartube-keep-local-'))
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))

  const keepLocal = new Set()
  const raw = Hypercore.defaultStorage(directory)
  const storage = createOffloadStorage({
    storage: raw,
    resolveStore: (identity) => (typeof identity.keyHex === 'string' ? storeFor(bucket, identity.keyHex) : null),
    eviction: {
      windowBytes: WINDOW_BYTES,
      sweepEveryReads: 1,
      isEvictable: ({ keyHex }) => !keepLocal.has(keyHex),
    },
  })
  const store = new Corestore(storage)
  await store.ready()
  t.teardown(() => store.close().catch(() => {}))

  // The node's own bookkeeping core. It is registered by the core's own key,
  // which a name-derived keypair does not match, and evictability is read per
  // sweep so registering after open still holds every sweep back.
  const meta = store.get({ name: 'peartube-meta' })
  await meta.ready()
  keepLocal.add(b4a.toString(meta.key, 'hex'))
  const media = store.get({ name: 'media' })
  await media.ready()
  for (const block of blocksOf(BLOCK_COUNT)) {
    await meta.append(block)
    await media.append(block)
  }

  async function residency (core) {
    const view = await raw.resumeCore(b4a.from(core.discoveryKey))
    let bytes = 0
    for await (const block of view.createBlockStream()) bytes += block.value.byteLength
    return bytes
  }

  await storage.offloadSweep()

  t.is(await residency(meta), BLOCK_COUNT * BLOCK_SIZE, 'every block of the bookkeeping core is still on disk')
  t.is(await residency(media), WINDOW_BYTES, 'while the media core is trimmed to its window')
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'and only the media blocks were uploaded')

  // Holding a core local never strands what the bucket already took: the media
  // core's evicted blocks are still served, because a keep-local core is held
  // back from eviction rather than refused a store.
  t.alike(await readAll(media, BLOCK_COUNT), blocksOf(BLOCK_COUNT), 'the offloaded media blocks are still restored on read')
  t.alike(await readAll(meta, BLOCK_COUNT), blocksOf(BLOCK_COUNT), 'and the bookkeeping core reads straight off the volume')

  // A second sweep changes nothing for the held-back core.
  await storage.offloadSweep()
  t.is(await residency(meta), BLOCK_COUNT * BLOCK_SIZE, 'a later sweep still leaves it whole')
})
