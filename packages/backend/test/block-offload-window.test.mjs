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

// A three-block window over KB-sized blocks. The point is the bound, not the
// volume: nine kilobytes prove the window governs residency exactly as well as
// nine gigabytes would, and a relay's disk is not the thing under test.
const BLOCK_SIZE = 1024
const WINDOW_BLOCKS = 3
const WINDOW_BYTES = WINDOW_BLOCKS * BLOCK_SIZE
const BLOCK_COUNT = 9
const PREFIX = 'relay'

/**
 * An object store in a Map that writes every put and every existence check into
 * an ordered log, so the test can assert the ORDER of upload, confirmation and
 * local delete rather than just their totals.
 *
 * `confirm: false` models the put that reported success and did not land — the
 * failure that would turn a local delete into a hole.
 */
function createRecordingProvider (log, { confirm = true } = {}) {
  const objects = new Map()
  return {
    objects,
    provider: {
      async putBlock ({ key, data }) {
        log.push(`put ${key}`)
        if (confirm === true) objects.set(key, b4a.from(data))
        return { success: confirm === true }
      },
      async hasBlock ({ key }) {
        log.push(`has ${key}`)
        return confirm === true && objects.has(key)
      },
      async getBlock ({ key }) {
        return objects.has(key) ? objects.get(key) : null
      },
      async deleteBlock ({ key }) {
        objects.delete(key)
        return { success: true }
      },
    },
  }
}

async function fixture (t, { confirm = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-block-offload-'))
  const log = []
  const messages = []
  const { provider, objects } = createRecordingProvider(log, { confirm })

  // `raw` is kept on purpose: it is the same CorestoreStorage the wrapper
  // delegates to, so `raw.resumeCore()` yields an UNWRAPPED view of the very
  // same database. That is how residency is measured below — real bytes on
  // local disk, read on a path that cannot restore anything, never the
  // offloader's own counters.
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

  const core = store.get({ name: 'media' })
  await core.ready()

  const localView = await raw.resumeCore(core.discoveryKey)

  async function localBlock (index) {
    const rx = localView.read()
    let pending = null
    try {
      pending = rx.getBlock(index)
    } finally {
      rx.tryFlush()
    }
    const block = await pending
    return block === undefined ? null : block
  }

  async function residentBytes (count) {
    let bytes = 0
    for (let index = 0; index < count; index++) {
      const block = await localBlock(index)
      if (block !== null) bytes += block.byteLength
    }
    return bytes
  }

  function offloaderFor (windowBytes) {
    return createBlockOffloader({
      core,
      store: createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key }),
      windowBytes,
      // Fires only after the local copy is gone, so appending to the same log
      // the provider writes into records the delete in its true position.
      onOffloaded: ({ index }) => log.push(`delete ${index}`),
    })
  }

  return { core, storage, objects, log, messages, localBlock, residentBytes, offloaderFor }
}

function keyFor (core, blockIndex) {
  return remoteBlockKey({ prefix: PREFIX, coreKey: core.key, blockIndex })
}

function proofFor (core, index) {
  return core.proof({
    block: { index, nodes: 0 },
    upgrade: { start: 0, length: core.length },
  })
}

test('a three-block window bounds local block data, confirms every upload before deleting it, and still serves every block', async (t) => {
  const { core, storage, objects, log, localBlock, residentBytes, offloaderFor } = await fixture(t)

  const blocks = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    blocks.push(b4a.alloc(BLOCK_SIZE, (index + 1) & 0xff))
  }

  const offloader = offloaderFor(WINDOW_BYTES)
  let peakOnDisk = 0
  for (let index = 0; index < BLOCK_COUNT; index++) {
    await core.append(blocks[index])
    offloader.track(index, blocks[index].byteLength)
    await offloader.drain()
    const onDisk = await residentBytes(index + 1)
    if (onDisk > peakOnDisk) peakOnDisk = onDisk
  }

  t.is(peakOnDisk, WINDOW_BYTES, 'peak block data on local disk is the window, not the size of the title')
  t.is(core.length, BLOCK_COUNT, 'the whole title was written')
  t.is(core.byteLength, BLOCK_COUNT * BLOCK_SIZE, 'the core still accounts for every byte of it')

  // The ordering IS the safety property: a block is uploaded, confirmed by
  // successful put, and only then does the local copy go.
  const expectedLog = []
  for (let index = 0; index < BLOCK_COUNT - WINDOW_BLOCKS; index++) {
    const key = keyFor(core, index)
    expectedLog.push(`put ${key}`, `delete ${index}`)
  }
  t.alike(log, expectedLog, 'each offloaded block was put, confirmed present, and only then deleted locally')

  const stats = offloader.stats()
  t.is(stats.blocksOffloaded, BLOCK_COUNT - WINDOW_BLOCKS, 'every block outside the window was offloaded')
  t.is(stats.bytesOffloaded, (BLOCK_COUNT - WINDOW_BLOCKS) * BLOCK_SIZE, 'the offloaded byte count is the offloaded blocks')
  t.is(stats.confirmed, stats.blocksOffloaded, 'no block was deleted without its own confirmation')
  t.is(stats.residentBytes, WINDOW_BYTES, 'a full window is still held locally when the write finishes')
  t.is(stats.peakResidentBytes, WINDOW_BYTES + BLOCK_SIZE,
    'accounting peaks one block over the window: the block being handed over is local until it is confirmed')

  t.is(objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'the object store holds exactly the offloaded blocks')
  t.is(await localBlock(0), null, 'the oldest block really is off local disk')
  t.alike(await localBlock(BLOCK_COUNT - 1), blocks[BLOCK_COUNT - 1], 'the newest block is still local')

  // The bitfield was never touched, so the relay keeps advertising every block
  // it can serve. `core.clear()` would have broken exactly this.
  let advertised = 0
  for (let index = 0; index < BLOCK_COUNT; index++) {
    if (await core.has(index)) advertised++
  }
  t.is(advertised, BLOCK_COUNT, 'the relay still advertises every block')

  // And an authorized peer request is answered for all of them, offloaded or
  // not, through the committed offload-storage wrapper.
  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await proofFor(core, index)
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'core.proof serves every block, restored from the object store where it had to be')
  t.alike(
    storage.stats(),
    { restored: BLOCK_COUNT - WINDOW_BLOCKS, missing: 0, failed: 0, corrupt: 0 },
    'exactly the offloaded blocks needed a restore, and none was missing, unreachable or unverifiable'
  )

  await core.close()
})

test('an unconfirmed upload keeps the local block and refuses loudly', async (t) => {
  const { core, log, localBlock, offloaderFor } = await fixture(t, { confirm: false })

  const blocks = []
  for (let index = 0; index < WINDOW_BLOCKS + 1; index++) {
    const block = b4a.alloc(BLOCK_SIZE, (index + 1) & 0xff)
    blocks.push(block)
    await core.append(block)
  }

  const offloader = offloaderFor(WINDOW_BYTES)
  for (let index = 0; index < blocks.length; index++) {
    offloader.track(index, blocks[index].byteLength)
  }

  const error = await offloader.drain().then(() => null, (err) => err)
  t.is(error?.code, 'OFFLOAD_BLOCK_UNCONFIRMED', 'an object store that will not confirm the block stops the offload')
  t.is(error?.blockIndex, 0, 'the refusal names the block it refused to give up')
  t.alike(log, [`put ${keyFor(core, 0)}`], 'the block was put and checked, and never deleted')
  t.alike(await localBlock(0), blocks[0], 'the local copy is still there, so nothing is lost')
  t.is(offloader.stats().blocksOffloaded, 0, 'nothing counts as offloaded')
  t.is(offloader.stats().residentBytes, blocks.length * BLOCK_SIZE, 'every block is still accounted for locally')

  await core.close()
})
