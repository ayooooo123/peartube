import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ASSET_BLOCK_SIZE, writeStaticAsset } from '../src/assets/static-core.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { createAssetSession } from '../src/assets/asset-session.js'
import { createMultiPeerScheduler } from '../src/playback/multi-peer-scheduler.js'

function tempStore(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, store: new Corestore(directory) }
}

function assetBytes(blockCount = 3) {
  const value = b4a.alloc(blockCount * ASSET_BLOCK_SIZE)
  for (let index = 0; index < blockCount; index++) {
    value.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  }
  return value
}

async function fixture(t, { connect = false } = {}) {
  const source = tempStore('peartube-playback-source-')
  const reader = tempStore('peartube-playback-reader-')
  await source.store.ready()
  await reader.store.ready()
  const bytes = assetBytes()
  const asset = await writeStaticAsset({ store: source.store, reader: createBufferSourceReader(bytes) })
  const session = createAssetSession({ coreRef: asset.descriptor, store: reader.store })
  await session.ready()

  let sourceStream = null
  let readerStream = null
  if (connect) {
    sourceStream = source.store.replicate(true)
    readerStream = reader.store.replicate(false)
    sourceStream.pipe(readerStream).pipe(sourceStream)
  }

  t.teardown(async () => {
    sourceStream?.destroy()
    readerStream?.destroy()
    await session.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await source.store.close().catch(() => {})
    await reader.store.close().catch(() => {})
    fs.rmSync(source.directory, { recursive: true, force: true })
    fs.rmSync(reader.directory, { recursive: true, force: true })
  })
  return { asset, bytes, session }
}

function schedulerFor(value, options = {}) {
  return createMultiPeerScheduler({
    coreRef: value.asset.descriptor,
    session: value.session,
    ...options,
  })
}

test('Hypercore replication materializes an exact cross-block playback range', async t => {
  const value = await fixture(t, { connect: true })
  const scheduler = schedulerFor(value)
  const byteStart = ASSET_BLOCK_SIZE - 19
  const byteEnd = ASSET_BLOCK_SIZE * 2 + 31
  const result = await scheduler.requestRange({
    assetId: value.asset.descriptor.assetId,
    byteStart,
    byteEnd,
    deadlineMs: 5000,
  })

  t.is(result.status, 'ok')
  t.is(result.verified, true)
  t.is(result.originAttempted, false)
  t.ok(b4a.equals(result.bytes, value.bytes.subarray(byteStart, byteEnd)))
  t.ok(await value.session.core.has(0, 3))
})

test('a verified local range needs no peer protocol', async t => {
  const value = await fixture(t)
  for (let index = 0; index < value.asset.descriptor.length; index++) {
    const proof = await value.asset.core.proof({
      block: { index, nodes: 0 },
      upgrade: { start: 0, length: value.asset.descriptor.length },
    })
    await value.session.verifyBlock({
      index,
      proof: { ...proof, block: { ...proof.block, value: null } },
      value: proof.block.value,
    })
  }
  const result = await schedulerFor(value).requestRange({
    assetId: value.asset.descriptor.assetId,
    byteStart: 17,
    byteEnd: ASSET_BLOCK_SIZE + 31,
    deadlineMs: 1000,
  })

  t.is(result.status, 'ok')
  t.alike(result.peerIds, [])
  t.ok(b4a.equals(result.bytes, value.bytes.subarray(17, ASSET_BLOCK_SIZE + 31)))
})

test('a missing range observes its bounded deadline', async t => {
  const value = await fixture(t)
  const result = await schedulerFor(value).requestRange({
    assetId: value.asset.descriptor.assetId,
    byteStart: 0,
    byteEnd: ASSET_BLOCK_SIZE,
    deadlineMs: 25,
  })

  t.alike(result, {
    status: 'unavailable',
    errorCode: 'DEADLINE_EXCEEDED',
    originAttempted: false,
  })
})

test('caller abort cancels a pending Hypercore range', async t => {
  const value = await fixture(t)
  const controller = new AbortController()
  const pending = schedulerFor(value).requestRange({
    assetId: value.asset.descriptor.assetId,
    byteStart: 0,
    byteEnd: ASSET_BLOCK_SIZE,
    deadlineMs: 5000,
    signal: controller.signal,
  })
  setImmediate(() => controller.abort())
  await t.exception(pending, { name: 'AbortError' })
})

test('scheduler rejects a mismatched asset session before network work', async t => {
  const value = await fixture(t)
  const mismatched = {
    ...value.session,
    coreRef: { ...value.asset.descriptor, treeHash: 'f'.repeat(64) },
  }
  t.exception(() => createMultiPeerScheduler({
    coreRef: value.asset.descriptor,
    session: mismatched,
  }), /identity does not match/)
})
