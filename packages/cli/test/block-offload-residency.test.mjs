import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Hypercore from 'hypercore'

import { createRelayBlockOffload } from '../src/archive/block-offload.js'

// The relay's side of block residency: the window an operator configured has to
// govern the READ path too, not just ingest, and what it is holding has to show
// up where an operator looks.
//
// This drives the real wiring end to end — resolved config, the real SigV4-
// shaped provider, the real remote block store, the real storage wrapper — with
// only the HTTP transport faked. Residency is read off the UNWRAPPED storage
// instance, which cannot restore anything, so it is bytes on local disk.

const BLOCK_SIZE = 1024
const WINDOW_BLOCKS = 3
const WINDOW_BYTES = WINDOW_BLOCKS * BLOCK_SIZE
const BLOCK_COUNT = 9

/**
 * A bucket in a Map, behind the provider's own fetch. PUT stores, HEAD is the
 * confirmation an eviction waits for, GET is a restore, 404 is absence.
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
      },
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
        bucket: 'peartube-archive',
        accessKeyId: 'AKIA-TEST',
        secretAccessKey: 'secret',
        prefix: 'relay',
        offloadWindowBytes,
      },
    },
  }
}

async function residency (raw, discoveryKey) {
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

async function fixture (t, { window: offloadWindowBytes }) {
  const bucket = createFakeBucket()
  const offload = await createRelayBlockOffload({
    config: relayConfig(offloadWindowBytes),
    fetchImpl: bucket.fetchImpl,
    createSigner: ({ key }) => ({ url: `https://peartube-archive.s3.example.com/${key}` }),
  })

  const directory = mkdtempSync(join(tmpdir(), 'pt-offload-residency-'))
  const raw = Hypercore.defaultStorage(directory)
  const storage = offload.wrapStorage(raw)
  const core = new Hypercore(storage)
  await core.ready()

  t.teardown(async () => {
    await core.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const blocks = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    blocks.push(b4a.alloc(BLOCK_SIZE, (index + 1) & 0xff))
  }
  for (const block of blocks) await core.append(block)

  return { bucket, offload, storage, core, blocks, discoveryKey: b4a.from(core.discoveryKey), raw }
}

test('the relay holds an offload-backed core to the configured window and reports what it holds', async (t) => {
  const { bucket, offload, storage, core, blocks, discoveryKey, raw } = await fixture(t, { window: WINDOW_BYTES })

  t.is((await residency(raw, discoveryKey)).bytes, BLOCK_COUNT * BLOCK_SIZE, 'the whole title starts on local disk')

  await storage.offloadSweep()

  t.alike(
    await residency(raw, discoveryKey),
    { bytes: WINDOW_BYTES, indices: [6, 7, 8] },
    'the window the operator configured is what is left on the volume'
  )
  t.is(bucket.objects.size, BLOCK_COUNT - WINDOW_BLOCKS, 'and every block that left is in the bucket')

  // The safety sequence in the relay's own transport. The leading HEAD is the
  // probe that makes the normal case — a block this relay restored FROM the
  // bucket — cost one round trip and no upload; here the bucket has never seen
  // the block, so it uploads and then confirms. Either way the request
  // immediately before the local delete is a HEAD that answered yes.
  const key = bucket.requests.find((entry) => entry.startsWith('PUT '))?.slice(4)
  t.ok(key, 'the eviction uploaded through the provider')
  const forKey = bucket.requests.filter((entry) => entry.endsWith(key))
  t.alike(
    forKey.map((entry) => entry.split(' ')[0]),
    ['HEAD', 'PUT', 'HEAD'],
    'the bucket was asked, then given the block, then asked again before the local copy went'
  )
  t.absent(bucket.requests.some((entry) => entry.startsWith('DELETE ')), 'and an eviction never deletes the remote copy')

  const stats = offload.stats()
  t.is(stats.enabled, true, 'offload is on')
  t.is(stats.windowBytes, WINDOW_BYTES, 'the operator sees the window they set')
  t.is(stats.residentBytes, WINDOW_BYTES, 'and how much block data the offload-backed cores are holding against it')

  // Still a complete core: every block advertised, every block serveable.
  let advertised = 0
  const read = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    if (await core.has(index)) advertised++
    read.push(await core.get(index))
  }
  t.is(advertised, BLOCK_COUNT, 'the relay still advertises the whole title')
  t.alike(read, blocks, 'and serves every block, restoring the evicted ones from the bucket')
  t.is(offload.stats().restored, BLOCK_COUNT - WINDOW_BLOCKS, 'exactly the evicted blocks needed a restore')

  t.alike(
    await residency(raw, discoveryKey),
    { bytes: WINDOW_BYTES, indices: [6, 7, 8] },
    'and reading the whole title back left residency at the window, not at the title'
  )
})

test('a window of zero keeps no block data local, and offload off keeps all of it', async (t) => {
  const zero = await fixture(t, { window: 0 })
  await zero.storage.offloadSweep()
  t.alike(
    await residency(zero.raw, zero.discoveryKey),
    { bytes: 0, indices: [] },
    'a zero window holds nothing local'
  )
  t.is(zero.bucket.objects.size, BLOCK_COUNT, 'every block is in the bucket')
  t.is(zero.offload.stats().residentBytes, 0, 'and residency reports it')
  const read = []
  for (let index = 0; index < BLOCK_COUNT; index++) read.push(await zero.core.get(index))
  t.alike(read, zero.blocks, 'and the title still reads back whole, entirely from the bucket')

  t.absent(
    await createRelayBlockOffload({ config: { archive: { s3: { offload: false } } } }),
    'with offload off there is no wrapper, so there is nothing to evict from'
  )
})

// The storage layer learns a core's key only after that core is open, and
// opening it already arms its residency ledger. The hold is what keeps a sweep
// out of that window, so a core registered as keep-local a moment later still
// has all its blocks.
test('a sweep asked for while eviction is held runs only after the keep-local list is registered', async (t) => {
  const { offload, storage, core, discoveryKey, raw } = await fixture(t, { window: WINDOW_BYTES })

  offload.holdEviction()

  let swept = false
  const sweeping = storage.offloadSweep().then((stats) => { swept = true; return stats })
  await new Promise(resolve => setTimeout(resolve, 50))

  t.is(swept, false, 'the sweep is still waiting on the hold')
  t.is((await residency(raw, discoveryKey)).bytes, BLOCK_COUNT * BLOCK_SIZE, 'and nothing has left the volume')

  // Registered inside the hold: this is the ordering the storage layer relies on.
  offload.excludeCore(b4a.toString(core.key, 'hex'))
  offload.startEviction()
  await sweeping

  t.is(swept, true, 'the sweep completes once the hold is released')
  t.is((await residency(raw, discoveryKey)).bytes, BLOCK_COUNT * BLOCK_SIZE, 'and the core registered during the hold kept every block')
})

// A hold that outlives the open would stop every sweep for the life of the
// process, and offload would look configured while quietly doing nothing. The
// release therefore has to survive a failing open, which is why the storage
// layer releases in a `finally`.
test('a hold released after a failed open still lets sweeps run', async (t) => {
  const { offload, storage, discoveryKey, raw } = await fixture(t, { window: WINDOW_BYTES })

  offload.holdEviction()
  // The storage layer's failure path: cleanup throws, the release still runs.
  try {
    await Promise.reject(new Error('metaCore.ready failed'))
  } catch {
    offload.startEviction()
  }

  await storage.offloadSweep()

  t.is((await residency(raw, discoveryKey)).bytes, WINDOW_BYTES, 'the sweep ran and trimmed to the window')
})
