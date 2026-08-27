import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'
import crypto from 'hypercore-crypto'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore, remoteBlockKey } from '../src/archive/remote-block-store.js'
import {
  ASSET_BLOCK_SIZE,
  DEFAULT_STAGING_TTL_MS,
  classifyIngestFailure,
  reclaimStagingState,
  sweepStagingState,
  verifyStaticAssetDescriptor,
  writeStaticAsset,
} from '../src/assets/static-core.js'
import { createBufferSourceReader, createSourceReader } from '../src/assets/source-reader.js'

// An interruption forty-two minutes into a 4K download used to throw away every
// byte. These tests are about the bytes surviving it.
//
// Seven canonical blocks over a two-block window with a 1000-byte tail, so a
// resume lands on a full-block boundary and the short final block is still
// exercised. The interruption is placed at block 3, which is inside the window
// and past the first offload, so a resume has to deal with both.
const WINDOW_BYTES = 2 * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 7
const TAIL_BYTES = 1000
const BYTE_LENGTH = ((BLOCK_COUNT - 1) * ASSET_BLOCK_SIZE) + TAIL_BYTES
const BREAK_AT_BLOCK = 3

const PREFIX = 'relay'
const ETAG = '"remote-sha256-0123456789abcdef"'
const RESUME_ID = 'ing_resume_0000000000000000000001'

// Source chunks are deliberately not block-aligned, so a resumed read has to
// re-chunk into canonical blocks from an offset exactly as the first read did.
const CHUNK_BYTES = 100000

async function rewriteStagingIdentityAsV1 (store, id) {
  const digest = crypto.hash(b4a.from(`peartube.asset.staging.id.v1\u0000${id}`))
  const keyPair = await store.createKeyPair(`asset-staging-${b4a.toString(digest, 'hex')}`)
  const core = store.get({ keyPair })
  await core.ready()
  try {
    const raw = await core.getUserData('peartube.asset.staging.v1')
    const current = JSON.parse(b4a.toString(raw, 'utf8'))
    await core.setUserData('peartube.asset.staging.v1', b4a.from(JSON.stringify({
      version: 1,
      etag: current.identity.value,
      createdAt: current.createdAt,
      touchedAt: current.touchedAt,
    })))
  } finally {
    await core.close()
  }
}

function assetBytes () {
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

function canonicalBlocks (bytes) {
  const blocks = []
  for (let offset = 0; offset < bytes.byteLength; offset += ASSET_BLOCK_SIZE) {
    blocks.push(bytes.subarray(offset, Math.min(offset + ASSET_BLOCK_SIZE, bytes.byteLength)))
  }
  return blocks
}

async function * chunksFrom (bytes, byteOffset) {
  for (let offset = byteOffset; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength))
  }
}

/**
 * A ranged source that records exactly which byte ranges it was asked for.
 *
 * `ranges` is the whole point of several assertions below: a resume that
 * silently re-downloaded the title would still produce the right core, and only
 * the ranges it asked for can tell the difference.
 */
function rangedSource (bytes, { breakAfterBytes = null, etag = ETAG } = {}) {
  const ranges = []
  let opens = 0
  const reader = createSourceReader({
    resumable: true,
    maxReadBytes: Math.max(1, bytes.byteLength),
    async describe () {
      return {
        identity: { kind: 'etag', value: etag },
        byteLength: bytes.byteLength,
        mimeType: 'application/octet-stream',
      }
    },
    open ({ offset, length }) {
      opens++
      const blockIndex = offset / ASSET_BLOCK_SIZE
      ranges.push({ byteOffset: offset, blockIndex, end: offset + length - 1 })
      const limit = breakAfterBytes === null ? offset + length : Math.min(offset + length, offset + breakAfterBytes)
      return (async function * () {
        let delivered = offset
        for await (const chunk of chunksFrom(bytes.subarray(0, offset + length), offset)) {
          if (delivered + chunk.byteLength >= limit && limit < offset + length) {
            if (delivered < limit) yield chunk.subarray(0, limit - delivered)
            const error = new Error('source connection reset')
            error.code = 'SOURCE_RANGE_SHORT'
            throw error
          }
          delivered += chunk.byteLength
          yield chunk
        }
      })()
    },
    async close () {},
  })
  return {
    reader,
    ranges,
    etag,
    get opens () {
      return opens
    },
  }
}

async function fixture (t) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-resumable-ingest-'))
  const objects = new Map()
  const deleted = []
  const hooks = { onDelete: null, onGet: null }

  const provider = {
    async putBlock ({ key, data }) {
      objects.set(key, b4a.from(data))
      return { success: true }
    },
    async hasBlock ({ key }) {
      return objects.has(key)
    },
    async getBlock ({ key }) {
      if (hooks.onGet !== null) await hooks.onGet(key)
      return objects.has(key) ? objects.get(key) : null
    },
    async deleteBlock ({ key }) {
      if (hooks.onDelete !== null) {
        const outcome = await hooks.onDelete(key)
        if (outcome === false) return { success: false }
      }
      deleted.push(key)
      objects.delete(key)
      return { success: true }
    },
  }

  // `raw` is the same CorestoreStorage the wrapper delegates to, so reading
  // through it is a view of local disk that cannot restore anything.
  let raw = null
  let store = null

  /**
   * Open a Corestore over the directory. Called again by `restart()` to model a
   * relay process that died and came back: same volume, nothing in memory.
   */
  async function open () {
    raw = Hypercore.defaultStorage(directory)
    const storage = createOffloadStorage({
      storage: raw,
      resolveStore: ({ keyHex }) => (
        typeof keyHex === 'string' ? createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: keyHex }) : null
      ),
      log: () => {},
    })
    store = new Corestore(storage)
    await store.ready()
    return store
  }

  await open()

  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  function storeFor ({ core }) {
    return createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key })
  }

  function offloadFor (overrides = {}) {
    return {
      createStagingStore: storeFor,
      createOffloader: ({ core }) => createBlockOffloader({
        core,
        store: createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key }),
        windowBytes: WINDOW_BYTES,
      }),
      ...overrides,
    }
  }

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

  return {
    get store () {
      return store
    },
    async restart () {
      await store.close()
      return open()
    },
    objects,
    deleted,
    hooks,
    provider,
    storeFor,
    offloadFor,
    residentBlockBytes,
  }
}

function stagingKeys (objects, finishedKeyHex) {
  const head = `${PREFIX}/blocks/`
  return [...objects.keys()]
    .filter((key) => key.startsWith(head) && !key.startsWith(`${head}${finishedKeyHex}/`))
    .sort()
}

test('an ingest interrupted mid-stream resumes to exactly the core an uninterrupted one produces', async (t) => {
  const bytes = assetBytes()
  const blocks = canonicalBlocks(bytes)

  // The control: the same content, one pass, nothing interrupted.
  const control = await fixture(t)
  const straight = await writeStaticAsset({
    store: control.store,
    reader: createBufferSourceReader(bytes),
    offload: control.offloadFor(),
  })
  const expected = {
    key: b4a.toString(straight.descriptor.key, 'hex'),
    treeHash: b4a.toString(straight.descriptor.treeHash, 'hex'),
    length: straight.descriptor.length,
    byteLength: straight.descriptor.byteLength,
  }
  await straight.core.close()

  const { store, objects, deleted, offloadFor, residentBlockBytes } = await fixture(t)
  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })

  const interrupted = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)

  t.is(interrupted?.code, 'SOURCE_RANGE_SHORT', 'the interruption surfaces as itself, not as a cleanup failure')
  t.is(classifyIngestFailure(interrupted), 'resumable', 'and a transport break is classified resumable')
  t.is(interrupted.staging?.retained, true, 'so the write says it kept its staging state')
  t.is(interrupted.staging?.id, RESUME_ID, 'under the id the caller can ask for it back with')
  t.is(interrupted.staging?.blockIndex, BREAK_AT_BLOCK, 'having staged every whole block it read')
  t.is(interrupted.staging?.byteOffset, BREAK_AT_BLOCK * ASSET_BLOCK_SIZE, 'and accounting for their bytes')
  t.is(interrupted.orphanedStagingKeys, undefined, 'nothing was purged, so nothing was orphaned')

  // The bytes that survived. This is the assertion the whole change exists for.
  t.is(objects.size, BREAK_AT_BLOCK, 'every confirmed staging block is still in the object store')
  t.is(deleted.length, 0, 'and not one object was deleted on the way out')
  t.is(await residentBlockBytes(), 0, 'while local disk still holds no block data at all')

  // Resume.
  const rest = rangedSource(bytes)
  const resumed = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: rest.reader,
    resume: { id: RESUME_ID },
  })

  t.alike(
    rest.ranges,
    [{ byteOffset: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE, blockIndex: BREAK_AT_BLOCK, end: BYTE_LENGTH - 1 }],
    'the resumed run asked the source for exactly the bytes after the last confirmed block, once'
  )
  t.is(rest.opens, 1, 'so a silent full re-download would have failed this test')

  t.is(b4a.toString(resumed.descriptor.key, 'hex'), expected.key, 'the resumed core has the same content-addressed key')
  t.is(b4a.toString(resumed.descriptor.treeHash, 'hex'), expected.treeHash, 'derived from the same tree hash')
  t.is(resumed.descriptor.length, expected.length, 'over the same number of blocks')
  t.is(resumed.descriptor.byteLength, expected.byteLength, 'and the same number of bytes')
  t.is(resumed.core.length, BLOCK_COUNT, 'the finished core holds the whole title')
  t.is(resumed.core.byteLength, BYTE_LENGTH, 'every byte of it')
  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'and verifies against its descriptor')
  t.is(resumed.ingest.mode, 'streaming', 'the resumed run still took the streaming path')
  t.is(resumed.ingest.blocks, BLOCK_COUNT, 'ingesting every block')
  t.is(resumed.ingest.staging.resumed, BREAK_AT_BLOCK, 'and reports the block it resumed from')
  t.is(resumed.ingest.staging.uploaded, BLOCK_COUNT, 'accounting for the earlier attempt\'s objects as its own')
  t.is(resumed.ingest.staging.deleted, BLOCK_COUNT, 'all of which it cleaned up')

  const served = []
  for (let index = 0; index < BLOCK_COUNT; index++) {
    const proof = await resumed.core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: resumed.core.length } })
    served.push(proof.block.value)
  }
  t.alike(served, blocks, 'every block the resumed core serves is the block the content says it is')

  const finishedKeyHex = b4a.toString(resumed.core.key, 'hex')
  t.is(stagingKeys(objects, finishedKeyHex).length, 0, 'no staging object outlived the finished archive')

  await resumed.core.close()
})

test('a version 1 staging identity migrates without discarding its confirmed prefix', async (t) => {
  const bytes = assetBytes()
  const { store, objects, offloadFor } = await fixture(t)
  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)
  t.is(objects.size, BREAK_AT_BLOCK, 'the legacy fixture starts with a confirmed staged prefix')
  await rewriteStagingIdentityAsV1(store, RESUME_ID)

  const source = rangedSource(bytes)
  const resumed = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: source.reader,
    resume: { id: RESUME_ID },
  })

  t.alike(
    source.ranges,
    [{ byteOffset: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE, blockIndex: BREAK_AT_BLOCK, end: BYTE_LENGTH - 1 }],
    'migration resumes after the confirmed prefix instead of downloading from zero'
  )
  t.is(resumed.core.byteLength, BYTE_LENGTH, 'the migrated staging state completes the title')
  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'the migrated result verifies')
  await resumed.core.close()
})

test('a resume whose source reports a different identity refuses to splice and keeps the staged prefix intact', async (t) => {
  const bytes = assetBytes()
  const { store, objects, deleted, offloadFor } = await fixture(t)

  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)
  const stagedObjects = [...objects.keys()].sort()
  t.is(stagedObjects.length, BREAK_AT_BLOCK, 'the interrupted attempt staged three blocks')

  // Different bytes AND a different identity: what a re-added torrent looks like.
  const otherBytes = assetBytes()
  otherBytes.fill(0xee, 0, ASSET_BLOCK_SIZE)
  const drifted = rangedSource(otherBytes, { etag: '"remote-sha256-something-else"' })
  const error = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: drifted.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (value) => value)

  t.is(error?.code, 'ASSET_SOURCE_IDENTITY_CHANGED', 'the resume fails with its own distinct code')
  t.alike(error.stagedIdentity, { kind: 'etag', value: ETAG }, 'naming the identity the staged blocks were read under')
  t.alike(error.sourceIdentity, { kind: 'etag', value: drifted.etag }, 'and the one the source now claims')
  t.is(classifyIngestFailure(error), 'permanent', 'a changed identity is never something to retry into')
  t.is(drifted.opens, 0, 'the second source was never read, so nothing could be spliced')
  t.alike([...objects.keys()].sort(), stagedObjects, 'the staged prefix is byte-for-byte the one it was')
  t.is(deleted.length, 0, 'and nothing was deleted on the way out')

  // The prefix is not corrupt: the ORIGINAL source still resumes it to the
  // correct key, which is the only proof that matters.
  const original = rangedSource(bytes)
  const resumed = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: original.reader,
    resume: { id: RESUME_ID },
  })
  t.is(resumed.core.byteLength, BYTE_LENGTH, 'the staging core resumed cleanly after the refusal')
  t.alike(
    original.ranges,
    [{ byteOffset: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE, blockIndex: BREAK_AT_BLOCK, end: BYTE_LENGTH - 1 }],
    'from the same offset it would have before'
  )
  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'and the finished core verifies')
  await resumed.core.close()
})

test('a staged block that is on neither disk nor in the bucket fails loudly instead of re-reading committed bytes', async (t) => {
  const bytes = assetBytes()
  const { store, objects, offloadFor } = await fixture(t)

  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)

  // Delete the middle staging object behind the store's back. The bisection then
  // finds a shorter confirmed prefix and the tail walk cannot restore the block
  // whose local copy the invariant says was only dropped after confirmation.
  const key = [...objects.keys()].sort()[1]
  objects.delete(key)

  const rest = rangedSource(bytes)
  const error = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: rest.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (value) => value)

  t.is(error?.code, 'ASSET_STAGED_BLOCK_MISSING', 'a hole in the confirmed prefix is named, not papered over')
  t.is(error.blockIndex, 1, 'and the block it is a hole for is named too')
  t.is(classifyIngestFailure(error), 'permanent', 'which is permanent: nothing can re-prove a block nobody has')
  t.is(rest.opens, 0, 'the source was never asked for anything')
  t.is(objects.size, 0, 'and the unusable staging state was reclaimed rather than left in the bucket')
})

test('staging state past its lifetime is reclaimed rather than resumed', async (t) => {
  const bytes = assetBytes()
  const { store, objects, offloadFor } = await fixture(t)

  let clock = 1_800_000_000_000
  const ttlMs = 60_000
  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID, ttlMs, now: () => clock },
  }).then(() => null, (error) => error)
  t.is(objects.size, BREAK_AT_BLOCK, 'the interruption left three staging objects')

  clock += ttlMs + 1
  const stale = rangedSource(bytes)
  const error = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: stale.reader,
    resume: { id: RESUME_ID, ttlMs, now: () => clock },
  }).then(() => null, (value) => value)

  t.is(error?.code, 'ASSET_STAGING_EXPIRED', 'stale staging state is never resumed')
  t.is(classifyIngestFailure(error), 'permanent', 'so it is reclaimed on the way out')
  t.is(stale.opens, 0, 'without reading a byte of the source')
  t.is(objects.size, 0, 'and the bucket is left holding none of it')

  // Which leaves a clean slate: the next attempt is a first attempt.
  const fresh = rangedSource(bytes)
  const written = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: fresh.reader,
    resume: { id: RESUME_ID, ttlMs, now: () => clock },
  })
  t.alike(
    fresh.ranges,
    [{ byteOffset: 0, blockIndex: 0, end: BYTE_LENGTH - 1 }],
    'starting from byte zero, as a first attempt must'
  )
  t.ok(await verifyStaticAssetDescriptor(written.core, written.descriptor), 'and finishing verified')
  await written.core.close()
})

test('the sweep reclaims staging state for a job nobody ever retried, and leaves a live one alone', async (t) => {
  const bytes = assetBytes()
  const { store, objects, offloadFor, storeFor } = await fixture(t)

  const abandonedId = 'ing_abandoned_00000000000000000001'
  const liveId = 'ing_live_000000000000000000000001'
  const clock = 1_800_000_000_000

  for (const id of [abandonedId, liveId]) {
    const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
    await writeStaticAsset({
      store,
      offload: offloadFor(),
      reader: broken.reader,
      resume: { id, now: () => clock },
    }).then(() => null, (error) => error)
  }
  t.is(objects.size, 2 * BREAK_AT_BLOCK, 'two interrupted jobs left two staged prefixes in the bucket')

  const swept = await sweepStagingState({
    store,
    createStagingStore: storeFor,
    ids: [abandonedId, liveId],
    keep: [liveId],
    now: () => clock,
  })

  t.alike(swept.reclaimed, [abandonedId], 'the job that is no longer live is reclaimed')
  t.alike(swept.retained, [liveId], 'the one still live is left alone')
  t.alike(swept.orphaned, [], 'and the bucket deleted everything it was asked to')
  t.is(objects.size, BREAK_AT_BLOCK, 'so exactly one staged prefix is left')

  // A live id is not immortal: its own TTL still condemns it.
  const expired = await sweepStagingState({
    store,
    createStagingStore: storeFor,
    ids: [liveId],
    keep: [liveId],
    ttlMs: 60_000,
    now: () => clock + 60_001,
  })
  t.alike(expired.reclaimed, [liveId], 'staging state untouched past its lifetime goes even while its job is live')
  t.is(objects.size, 0, 'leaving nothing in the bucket')
  t.is(DEFAULT_STAGING_TTL_MS, 24 * 60 * 60 * 1000, 'and the default lifetime is a day')
})

test('reclaiming keeps the staging core when the bucket will not delete, so the orphan is still findable', async (t) => {
  const bytes = assetBytes()
  const { store, objects, hooks, offloadFor, storeFor } = await fixture(t)

  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)

  const stubborn = [...objects.keys()].sort()[2]
  hooks.onDelete = (key) => (key === stubborn ? false : true)

  const outcome = await reclaimStagingState({ store, id: RESUME_ID, createStagingStore: storeFor })
  t.is(outcome.reclaimed, false, 'a reclaim that could not finish says so')
  t.is(outcome.blocks, BREAK_AT_BLOCK, 'naming how many objects it was accounting for')
  t.alike(outcome.orphaned, [stubborn], 'and exactly which one is still in the bucket')
  t.alike([...objects.keys()], [stubborn], 'which is what the bucket really still holds')

  // The core stayed, so a later sweep can try the same delete again.
  hooks.onDelete = null
  const retry = await reclaimStagingState({ store, id: RESUME_ID, createStagingStore: storeFor })
  t.is(retry.reclaimed, true, 'the retry finishes the job the first attempt could not')
  t.is(retry.blocks, BREAK_AT_BLOCK, 'because the staging core that knew the object keys was kept')
  t.is(objects.size, 0, 'and the bucket is finally empty')
})

test('a resume is refused outright when there is nowhere durable to keep the staged blocks', async (t) => {
  const bytes = assetBytes()
  const { store, objects, offloadFor } = await fixture(t)
  const source = rangedSource(bytes)

  const error = await writeStaticAsset({
    store,
    offload: offloadFor({ createStagingStore: undefined }),
    reader: source.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (value) => value)

  t.is(error?.code, 'ASSET_RESUME_UNSUPPORTED', 'a resumable write with no staging store is refused')
  t.ok(/createStagingStore/.test(error?.message || ''), 'and the refusal names what would make it work')
  t.is(source.opens, 0, 'nothing was read')
  t.is(objects.size, 0, 'and nothing was uploaded')

})

test('resume state survives the relay process dying: a fresh corestore over the same volume picks it up', async (t) => {
  const bytes = assetBytes()
  const relay = await fixture(t)

  const broken = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  const interrupted = await writeStaticAsset({
    store: relay.store,
    offload: relay.offloadFor(),
    reader: broken.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)
  t.is(interrupted?.staging?.retained, true, 'the interrupted attempt kept its staging state')
  t.is(relay.objects.size, BREAK_AT_BLOCK, 'with three blocks confirmed in the bucket')

  // The relay dies. Nothing at all is carried over in memory: the only inputs
  // to the next attempt are the volume, the bucket, and the resume id.
  await relay.restart()

  const rest = rangedSource(bytes)
  const resumed = await writeStaticAsset({
    store: relay.store,
    offload: relay.offloadFor(),
    reader: rest.reader,
    resume: { id: RESUME_ID },
  })

  t.alike(
    rest.ranges,
    [{ byteOffset: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE, blockIndex: BREAK_AT_BLOCK, end: BYTE_LENGTH - 1 }],
    'the restarted relay re-read only the bytes after the last confirmed block'
  )
  t.is(resumed.core.byteLength, BYTE_LENGTH, 'and finished the whole title')
  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'into a core that verifies')
  t.is(resumed.ingest.staging.resumed, BREAK_AT_BLOCK, 'from the block the staged tree on disk said it should')

  // And the identity guard survives the restart too, which is the only thing
  // that makes a resume across a restart safe.
  await relay.restart()
  const second = await fixture(t)
  const drifted = rangedSource(bytes, { breakAfterBytes: BREAK_AT_BLOCK * ASSET_BLOCK_SIZE })
  await writeStaticAsset({
    store: second.store,
    offload: second.offloadFor(),
    reader: drifted.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)
  await second.restart()
  const error = await writeStaticAsset({
    store: second.store,
    offload: second.offloadFor(),
    reader: rangedSource(bytes, { etag: '"remote-sha256-rotated"' }).reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (value) => value)
  t.is(error?.code, 'ASSET_SOURCE_IDENTITY_CHANGED', 'a restarted relay still refuses to splice a different source')

  await resumed.core.close()
})

test('an ingest interrupted after the whole source was read resumes without asking for a single byte', async (t) => {
  const bytes = assetBytes()
  const { store, objects, hooks, offloadFor } = await fixture(t)
  // Pass 1 completes — the whole title is read and staged — and pass 2 dies on
  // its very first restore. The download is done; only the transplant is not.
  const source = rangedSource(bytes)
  hooks.onGet = () => {
    const error = new Error('object store unreachable')
    error.code = 'PROVIDER_UNAVAILABLE'
    throw error
  }
  const interrupted = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: source.reader,
    resume: { id: RESUME_ID },
  }).then(() => null, (error) => error)

  t.is(interrupted?.code, 'PROVIDER_UNAVAILABLE', 'a bucket that will not answer interrupts pass 2')
  t.is(classifyIngestFailure(interrupted), 'resumable', 'which is resumable: the bytes are all still staged')
  t.is(interrupted.staging?.blockIndex, BLOCK_COUNT, 'and the staged tree is the whole title')
  t.is(objects.size, BLOCK_COUNT, 'every block of which is in the bucket')
  t.is(source.opens, 1, 'having been downloaded exactly once')
  hooks.onGet = null

  const again = rangedSource(bytes)
  const resumed = await writeStaticAsset({
    store,
    offload: offloadFor(),
    reader: again.reader,
    resume: { id: RESUME_ID },
  })

  t.is(again.opens, 0, 'the resumed run never opened the source at all: there was nothing left to fetch')
  t.is(resumed.core.byteLength, BYTE_LENGTH, 'and the whole title still landed')
  t.ok(await verifyStaticAssetDescriptor(resumed.core, resumed.descriptor), 'in a core that verifies')

  await resumed.core.close()
})
