import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore, remoteBlockKey } from '../src/archive/remote-block-store.js'

// Small on purpose: this proves a code path, not a disk.
const BLOCK_SIZE = 1024
const BLOCK_COUNT = 3

function blocksFor (seed) {
  const blocks = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    blocks.push(b4a.alloc(BLOCK_SIZE, (seed + index) & 0xff))
  }
  return blocks
}

// An object store that lives in a Map. `unreachable` models a transport
// outage; the objects themselves stay put, so one fixture can move between
// absent, unreachable and tampered without re-uploading.
function createFakeProvider () {
  const objects = new Map()
  const provider = {
    getCalls: [],
    unreachable: null,
    async putBlock ({ key, data }) {
      objects.set(key, b4a.from(data))
      return { success: true }
    },
    async hasBlock ({ key }) {
      return objects.has(key)
    },
    async deleteBlock ({ key }) {
      objects.delete(key)
      return { success: true }
    },
    async getBlock ({ key }) {
      provider.getCalls.push(key)
      if (provider.unreachable) throw provider.unreachable
      return objects.has(key) ? objects.get(key) : null
    },
  }
  return { provider, objects }
}

async function fixture (t, { resolveStore, ...options }) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-offload-storage-'))
  const messages = []
  const storage = createOffloadStorage({
    storage: Hypercore.defaultStorage(directory),
    resolveStore,
    log: (message) => messages.push(message),
    ...options,
  })
  const store = new Corestore(storage)
  await store.ready()

  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  return { store, storage, messages }
}

async function appendBlocks (core, blocks) {
  for (const block of blocks) await core.append(block)
}

// Removes the block DATA and nothing else, straight through the storage layer:
// no `core.clear()`, so the bitfield and the merkle tree stay exactly as the
// core wrote them.
async function deleteLocalBlocks (core, start, end) {
  const tx = core.state.storage.write()
  tx.deleteBlockRange(start, end)
  await tx.flush()
}

function proofFor (core, index) {
  return core.proof({
    block: { index, nodes: 0 },
    upgrade: { start: 0, length: core.length },
  })
}

async function readBlockDirect (core, index) {
  const rx = core.state.storage.read()
  const block = rx.getBlock(index)
  rx.tryFlush()
  return block
}

test('offload storage with no offloaded core behaves exactly like the storage it wraps', async (t) => {
  const lookups = []
  const { store, storage } = await fixture(t, {
    resolveStore: (identity) => {
      lookups.push(identity)
      return null
    },
  })

  const blocks = blocksFor(1)
  const core = store.get({ name: 'plain' })
  await core.ready()
  await appendBlocks(core, blocks)

  t.is(core.length, BLOCK_COUNT, 'every block was appended')
  t.alike(await core.get(0), blocks[0], 'core.get reads through the wrapper')
  t.alike(await core.get(2), blocks[2], 'core.get reads the last block through the wrapper')
  t.ok(await core.has(1), 'the bitfield answers for a locally held block')

  const proof = await proofFor(core, 1)
  t.alike(proof.block.value, blocks[1], 'core.proof serves the block through the wrapper')
  t.is(proof.block.index, 1, 'the proof is for the requested block')

  t.is(lookups.length, 0, 'a core with no local miss never asks for a remote store')
  t.alike(storage.stats(), { restored: 0, missing: 0, failed: 0, corrupt: 0 }, 'nothing was restored')

  // A genuine local miss on a non-offloaded core is still a miss, and it is
  // reported without ever producing a block.
  await deleteLocalBlocks(core, 0, 1)
  t.is(await readBlockDirect(core, 0), null, 'a local miss on a non-offloaded core resolves null')
  t.is(lookups.length, 1, 'the miss consulted resolveStore exactly once')
  t.ok(b4a.equals(lookups[0].key, core.key), 'resolveStore is given the core public key')
  t.ok(b4a.equals(lookups[0].discoveryKey, core.discoveryKey), 'resolveStore is given the discovery key')
  t.is(lookups[0].keyHex, b4a.toString(core.key, 'hex'), 'the hex key is supplied too')
  t.alike(storage.stats(), { restored: 0, missing: 0, failed: 0, corrupt: 0 }, 'a plain miss is not offload activity')

  await core.close()
})

test('offloaded blocks are restored on read through has, proof and get', async (t) => {
  const { provider, objects } = createFakeProvider()
  let remote = null
  let storeLookups = 0

  const { store, storage } = await fixture(t, {
    resolveStore: (identity) => {
      storeLookups++
      return remote && identity.keyHex === remote.coreKey ? remote : null
    },
  })

  const blocks = blocksFor(7)
  const core = store.get({ name: 'offloaded' })
  await core.ready()
  await appendBlocks(core, blocks)

  remote = createRemoteBlockStore({ provider, prefix: 'relay', coreKey: core.key })
  for (let index = 0; index < blocks.length; index++) await remote.put(index, blocks[index])
  for (let index = 0; index < blocks.length; index++) {
    t.ok(await remote.has(index), `block ${index} is confirmed present remotely before deletion`)
  }

  await deleteLocalBlocks(core, 0, core.length)
  t.is(objects.size, BLOCK_COUNT, 'the object store holds one object per block')

  for (let index = 0; index < BLOCK_COUNT; index++) {
    t.ok(await core.has(index), `has(${index}) is still true: the bitfield was never touched`)
  }

  const proof = await proofFor(core, 1)
  t.alike(proof.block.value, blocks[1], 'core.proof restores the block from the object store')
  t.is(proof.block.index, 1, 'the restored proof is for the requested block')

  t.alike(await core.get(2), blocks[2], 'core.get restores the block from the object store')
  t.alike(await core.get(0), blocks[0], 'core.get restores an earlier block too')

  t.is(storage.stats().restored, 3, 'three blocks were restored')
  t.is(storage.stats().corrupt, 0, 'nothing failed verification')
  t.is(storage.stats().failed, 0, 'nothing was unreachable')

  // A snapshot derives a per-core storage of its own; it must restore too.
  const snapshot = core.snapshot()
  await snapshot.ready()
  t.alike(await snapshot.get(1), blocks[1], 'a derived snapshot storage restores as well')
  await snapshot.close()

  // The caller's own read transaction is never left unflushed by a restore:
  // two blocks batched into one transaction both resolve.
  const rx = core.state.storage.read()
  const first = rx.getBlock(0)
  const second = rx.getBlock(2)
  rx.tryFlush()
  const [a, b] = await Promise.all([first, second])
  t.alike(a, blocks[0], 'a batched restore resolves the first block')
  t.alike(b, blocks[2], 'a batched restore resolves the second block')

  // A player can ask for the same startup block through overlapping proof and
  // data reads. One bucket request must serve every concurrent waiter.
  const getCallsBefore = provider.getCalls.length
  const sameBlockRxA = core.state.storage.read()
  const sameBlockA = sameBlockRxA.getBlock(0)
  sameBlockRxA.tryFlush()
  const sameBlockRxB = core.state.storage.read()
  const sameBlockB = sameBlockRxB.getBlock(0)
  sameBlockRxB.tryFlush()
  const [sameA, sameB] = await Promise.all([sameBlockA, sameBlockB])
  t.alike(sameA, blocks[0], 'the first concurrent waiter receives the restored block')
  t.alike(sameB, blocks[0], 'the second concurrent waiter shares the restored block')
  t.is(provider.getCalls.length, getCallsBefore + 1, 'concurrent reads issue one object-store GET')
  t.is(storeLookups, 1, 'the remote store is resolved once per opened core')

  // A restore only happens for a block the tree committed to.
  t.is(await readBlockDirect(core, BLOCK_COUNT + 5), null, 'a block the tree never committed to is not fetched')

  await core.close()
})
test('read-ahead restores sequential playback blocks concurrently and caches the window', async t => {
  const { provider } = createFakeProvider()
  let remote = null
  const { store, storage } = await fixture(t, {
    resolveStore: identity => remote && identity.keyHex === remote.coreKey ? remote : null,
    readAheadBlocks: 2,
    restoreCacheBytes: BLOCK_SIZE * BLOCK_COUNT,
  })
  const blocks = blocksFor(19)
  const core = store.get({ name: 'read-ahead' })
  await core.ready()
  await appendBlocks(core, blocks)
  remote = createRemoteBlockStore({ provider, prefix: 'relay', coreKey: core.key })
  for (let index = 0; index < blocks.length; index++) await remote.put(index, blocks[index])
  await deleteLocalBlocks(core, 0, core.length)

  t.alike(await core.get(0), blocks[0], 'the requested startup block is restored')
  t.alike(await Promise.all([core.get(1), core.get(2)]), [blocks[1], blocks[2]], 'read-ahead fills the following playback blocks')
  t.is(provider.getCalls.length, 3, 'one parallel restore window fetches each block once')

  const callsBeforeReplay = provider.getCalls.length
  t.alike(await Promise.all([core.get(0), core.get(1), core.get(2)]), blocks, 'the restored window replays byte-exactly')
  t.is(provider.getCalls.length, callsBeforeReplay, 'repeated probes stay inside the bounded restore cache')
  t.is(storage.stats().restored, 3, 'only the initial window reached object storage')
  await core.close()
})


test('an absent, unreachable or tampered object never yields bytes and is counted', async (t) => {
  const { provider, objects } = createFakeProvider()
  let remote = null
  const { store, storage, messages } = await fixture(t, {
    resolveStore: (identity) => (remote && identity.keyHex === remote.coreKey ? remote : null),
  })

  const blocks = blocksFor(19)
  const core = store.get({ name: 'hostile' })
  await core.ready()
  await appendBlocks(core, blocks)

  remote = createRemoteBlockStore({ provider, prefix: 'relay', coreKey: core.key })
  for (let index = 0; index < blocks.length; index++) await remote.put(index, blocks[index])
  await deleteLocalBlocks(core, 0, core.length)

  // --- absent: the object store simply does not have it ----------------------
  await remote.delete(0)
  t.is(await remote.has(0), false, 'block 0 is gone from the object store')
  const absent = await proofFor(core, 0)
  t.absent(b4a.isBuffer(absent.block.value), 'an absent object yields no block value')
  t.is(storage.stats().missing, 1, 'an absent object counts as missing')
  t.is(storage.stats().failed, 0, 'an absent object is not a failure')
  t.is(messages.length, 1, 'an absent remote block is logged with its content key')

  // --- unreachable: the provider throws -------------------------------------
  provider.unreachable = new Error('connect ECONNREFUSED')
  const unreachable = await proofFor(core, 1)
  t.absent(b4a.isBuffer(unreachable.block.value), 'an unreachable store yields no block value')
  t.is(storage.stats().failed, 1, 'an unreachable store counts as failed')
  t.is(storage.stats().corrupt, 0, 'a transport outage is never reported as corruption')
  t.is(messages.length, 2, 'an unreachable store logs once after the missing object')
  t.ok(messages[1].includes('unreachable'), 'the log says the store was unreachable')
  t.ok(messages[1].includes('ECONNREFUSED'), 'the log carries the transport error')
  provider.unreachable = null

  // --- corrupt: the object store hands back the wrong bytes -----------------
  const tampered = b4a.alloc(BLOCK_SIZE, 0xab)
  const key = remoteBlockKey({ prefix: 'relay', coreKey: core.key, blockIndex: 2 })
  t.ok(objects.has(key), 'the tampered key addresses a real object')
  objects.set(key, tampered)

  const corrupt = await proofFor(core, 2)
  t.absent(b4a.isBuffer(corrupt.block.value), 'tampered bytes are never returned')
  t.is(storage.stats().corrupt, 1, 'tampered bytes count as corrupt')
  t.is(messages.length, 3, 'tampered bytes are logged')
  t.ok(messages[2].includes('CORRUPT'), 'the corruption log is loud')
  t.ok(messages[2].includes('refusing to serve'), 'the corruption log says the bytes were dropped')

  t.is(await readBlockDirect(core, 2), null, 'the storage layer resolves null rather than the tampered bytes')
  t.is(storage.stats().corrupt, 2, 'every tampered fetch is counted')
  t.is(messages.length, 4, 'every tampered fetch is logged')

  // --- and the honest object still restores ---------------------------------
  objects.set(key, blocks[2])
  t.alike(await core.get(2), blocks[2], 'a repaired object restores again')

  t.alike(
    storage.stats(),
    { restored: 1, missing: 1, failed: 1, corrupt: 2 },
    'stats account for every restore attempt'
  )
  t.alike(storage.offloadStats(), storage.stats(), 'offloadStats is the same report')

  await core.close()
})
