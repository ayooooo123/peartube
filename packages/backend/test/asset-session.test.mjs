import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAssetSession } from '../src/assets/asset-session.js'
import {
  ASSET_BLOCK_SIZE,
  createStaticAssetManifest,
  writeStaticAsset,
} from '../src/assets/static-core.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'

function tempStore(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, store: new Corestore(directory) }
}

async function assetFixture(t) {
  const source = tempStore('peartube-asset-session-source-')
  const reader = tempStore('peartube-asset-session-reader-')
  await source.store.ready()
  await reader.store.ready()
  const value = b4a.alloc(ASSET_BLOCK_SIZE, 31)
  const asset = await writeStaticAsset({ store: source.store, reader: createBufferSourceReader(value) })
  const opened = []
  const store = {
    get(options) {
      const core = reader.store.get(options)
      opened.push({ options, core })
      return core
    },
  }
  const session = createAssetSession({ coreRef: asset.descriptor, store })
  await session.ready()
  t.teardown(async () => {
    await session.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await source.store.close().catch(() => {})
    await reader.store.close().catch(() => {})
    fs.rmSync(source.directory, { recursive: true, force: true })
    fs.rmSync(reader.directory, { recursive: true, force: true })
  })
  return { asset, opened, session, value }
}

test('asset session reconstructs and opens the exact readonly zero-signer static manifest', async (t) => {
  const { asset, opened, session } = await assetFixture(t)
  t.is(opened.length, 1)
  t.alike(opened[0].options.key, asset.descriptor.key)
  t.is(opened[0].options.writable, false)
  t.is(opened[0].options.manifest.quorum, 0)
  t.alike(opened[0].options.manifest.signers, [])
  t.alike(opened[0].options.manifest.prologue, {
    hash: asset.descriptor.treeHash,
    length: asset.descriptor.length,
  })
  t.alike(session.assetId, asset.descriptor.assetId)
})

test('asset session rejects refs whose key or assetId differs from the reconstructed static manifest', (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 41),
    blockLength: 1,
    byteLength: ASSET_BLOCK_SIZE,
  })
  t.exception(() => createAssetSession({
    coreRef: { ...descriptor, assetId: '42'.repeat(32) },
    store: { get() { t.fail('mismatched asset must not open') } },
  }), /assetId|reconstructed/)
  t.exception(() => createAssetSession({
    coreRef: { ...descriptor, key: '43'.repeat(32) },
    store: { get() { t.fail('mismatched key must not open') } },
  }), /key|reconstructed/)
})

test('asset session applies only valid block proofs and reports possession after verification', async (t) => {
  const { asset, opened, session, value } = await assetFixture(t)
  const proof = await asset.core.proof({
    block: { index: 0, nodes: 0 },
    upgrade: { start: 0, length: asset.descriptor.length },
  })
  const proofWithoutValue = {
    ...proof,
    block: { ...proof.block, value: null },
  }
  const poisonedCore = session.core
  const tampered = b4a.from(value)
  tampered[0] ^= 0xff
  await t.exception(session.verifyBlock({ index: 0, proof: proofWithoutValue, value: tampered }), /proof|verification/)
  t.ok(poisonedCore.closed, 'the exact handle touched by a rejected proof is closed')
  t.absent(session.core, 'the poisoned handle is discarded before rejection')

  const retryProof = await asset.core.proof({
    block: { index: 0, nodes: 0 },
    upgrade: { start: 0, length: asset.descriptor.length },
  })
  const verified = await session.verifyBlock({
    index: 0,
    proof: { ...retryProof, block: { ...retryProof.block, value: null } },
    value,
  })
  t.is(opened.length, 2, 'clean retry reopens the exact readonly manifest')
  t.not(session.core, poisonedCore)
  t.alike(verified, { index: 0 })
  t.is(await session.core.has(0), true)
})

test('asset session restores offloaded blocks before reporting verified custody', async t => {
  const value = b4a.alloc(ASSET_BLOCK_SIZE, 32)
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 52),
    blockLength: 1,
    byteLength: value.byteLength,
  })
  const calls = []
  const core = {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has(index) { calls.push(['has', index]); return false },
    async get(index, options) { calls.push(['get', index, options]); return value },
    async close() { calls.push(['close']) },
  }
  const session = createAssetSession({ coreRef: descriptor, core, ownsCore: true })
  await session.ready()

  t.is(await session.hasVerifiedBlock(0), true)
  t.alike(await session.readVerifiedBlock(0), value)
  t.alike(calls, [
    ['has', 0],
    ['get', 0, { wait: false }],
    ['get', 0, { wait: false }],
  ])

  await session.close()
  t.alike(calls.at(-1), ['close'])
})

test('asset session quarantines descriptor state conflicts before reporting availability', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 51),
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 3,
  })
  let closed = 0
  const core = {
    key: descriptor.key,
    length: 1,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has() { t.fail('conflicting state must not be probed') },
    async applyProof() { t.fail('conflicting state must not apply a proof') },
    async close() { closed++ },
  }
  const session = createAssetSession({ coreRef: descriptor, core })
  await session.ready()
  await t.exception(
    session.listAssetRanges({ cursor: null, limit: 1 }),
    /asset core state conflicts with the verified descriptor/,
  )
  t.is(closed, 1, 'incompatible preexisting state is quarantined')
  t.absent(session.core)
  await session.close()
})

test('asset session rejects wrong block value length before proof application', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 51),
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 3,
  })
  let applied = 0
  let closed = 0
  const core = {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has() { return false },
    async applyProof() { applied++; return true },
    async close() { closed++ },
  }
  const session = createAssetSession({ coreRef: descriptor, core, ownsCore: true })
  await session.ready()
  await t.exception(session.verifyBlock({
    index: 1,
    proof: { block: { index: 1, value: null }, upgrade: null },
    value: b4a.alloc(4),
  }), /asset block value length does not match the verified descriptor/)
  t.is(applied, 0)
  await session.close()
  t.is(closed, 1)
})

test('an injected core is permanently poisoned after any rejected proof application', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 52),
    blockLength: 1,
    byteLength: ASSET_BLOCK_SIZE,
  })
  let applied = 0
  let closed = 0
  const core = {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has() { return false },
    async applyProof() { applied++; return false },
    async close() { closed++ },
  }
  const session = createAssetSession({ coreRef: descriptor, core })
  const candidate = {
    fork: 0,
    block: { index: 0, value: null },
    upgrade: null,
  }
  await t.exception(session.verifyBlock({
    index: 0,
    proof: candidate,
    value: b4a.alloc(ASSET_BLOCK_SIZE),
  }), /verification/)
  t.is(closed, 1)
  t.absent(session.core)
  await t.exception(session.verifyBlock({
    index: 0,
    proof: candidate,

    value: b4a.alloc(ASSET_BLOCK_SIZE),
  }), /poisoned/)
  t.is(applied, 1, 'late retries never touch the discarded injected handle')
})
test('cached possession quarantines conflicting descriptor state before core.has', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 62),
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 3,
  })
  let probed = 0
  let closed = 0
  const core = {
    key: descriptor.key,
    length: 1,
    byteLength: ASSET_BLOCK_SIZE,
    async ready() {},
    async has() { probed++; return true },
    async close() { closed++ },
  }
  const session = createAssetSession({ coreRef: descriptor, core })
  await t.exception(session.hasVerifiedBlock(0), /length|descriptor/)
  t.is(probed, 0, 'conflicting cached state is rejected before core.has')
  t.is(closed, 1, 'the conflicting handle is quarantined')
  t.absent(session.core)
})

test('proof metadata classification requires fresh upgrades but permits exact cached no-upgrade proofs', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 63),
    blockLength: 1,
    byteLength: ASSET_BLOCK_SIZE,
  })
  const proof = {
    fork: 0,
    block: { index: 0, nodes: [], value: null },
    hash: null,
    seek: null,
    upgrade: null,
    manifest: null,
  }
  const fresh = createAssetSession({
    coreRef: descriptor,
    core: {
      key: descriptor.key,
      length: 0,
      byteLength: 0,
      async ready() {},
      async close() {},
    },
  })
  await fresh.ready()
  t.exception(() => fresh.validateProofMetadata({
    index: 0,
    proof,
    byteLength: ASSET_BLOCK_SIZE,
  }), /fresh asset core requires an exact descriptor-length upgrade proof/)

  let cachedApplications = 0
  const cached = createAssetSession({
    coreRef: descriptor,
    core: {
      key: descriptor.key,
      length: descriptor.length,
      byteLength: descriptor.byteLength,
      async ready() {},
      async has() { return true },
      async applyProof() { cachedApplications++; return true },
      async close() {},
    },
  })
  await cached.ready()
  t.is(cached.validateProofMetadata({
    index: 0,
    proof,
    byteLength: ASSET_BLOCK_SIZE,
  }), ASSET_BLOCK_SIZE)
  t.alike(await cached.verifyBlock({
    index: 0,
    proof,
    value: b4a.alloc(ASSET_BLOCK_SIZE),
  }), { index: 0 })
  t.is(cachedApplications, 1)
  await fresh.close()
  await cached.close()
})

test('conflicting proof metadata makes the handle unusable and awaits quarantine completion', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 64),
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 7,
  })
  const events = []
  const session = createAssetSession({
    coreRef: descriptor,
    core: {
      key: descriptor.key,
      length: 1,
      byteLength: ASSET_BLOCK_SIZE,
      async ready() {},
      async close() { events.push('close') },
    },
    async onQuarantine() { events.push('callback') },
  })
  await session.ready()
  const rejected = t.exception(session.validateProofMetadata({
    index: 0,
    byteLength: ASSET_BLOCK_SIZE,
    proof: {
      block: { index: 0, value: null },
      upgrade: { start: 0, length: descriptor.length },
    },
  }), /asset core state conflicts with the verified descriptor/)
  t.absent(session.core, 'the conflicting handle is synchronously unavailable')
  await rejected
  t.alike(events, ['close', 'callback'])
})

test('closed asset sessions reject late proof application and release their owned core', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 61),
    blockLength: 1,
    byteLength: ASSET_BLOCK_SIZE,
  })
  let closed = 0
  let applied = 0
  const core = {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has() { return false },
    async applyProof() { applied++; return true },
    async close() { closed++ },
  }
  const session = createAssetSession({ coreRef: descriptor, core, ownsCore: true })
  await session.ready()
  await session.close()
  await t.exception(session.verifyBlock({
    index: 0,
    proof: { block: { index: 0, value: null } },
    value: b4a.alloc(ASSET_BLOCK_SIZE),
  }), /closed/)
  t.is(applied, 0)
  t.is(closed, 1)
})
