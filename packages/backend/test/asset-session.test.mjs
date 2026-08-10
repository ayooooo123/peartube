import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAssetSession } from '../src/assets/asset-session.js'
import {
  ASSET_BLOCK_SIZE,
  createStaticAssetManifest,
  writeStaticAsset,
} from '../src/assets/static-core.js'
import { createPublicationManifest } from '../src/assets/manifest.js'
import { createRenditionDescriptor } from '../src/assets/rendition.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import {
  PEER_FRAME_TYPE_NAMES,
  decodePeerFrame,
  encodeAssetBlockRequest,
  encodeAssetBlockResponse,
  encodePeerFrame,
} from '../src/network/frame.js'

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
  const asset = await writeStaticAsset({ store: source.store, source: [value] })
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

test('asset session rejects descriptor state and block value mismatches before reporting availability', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 51),
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 3,
  })
  const core = {
    key: descriptor.key,
    length: 1,
    byteLength: descriptor.byteLength,
    async ready() {},
    async has() { return false },
    async applyProof() { t.fail('invalid state must not apply a proof') },
    async close() { this.closed = true },
  }
  const session = createAssetSession({ coreRef: descriptor, core })
  await session.ready()
  await t.exception(session.listAssetRanges({ cursor: null, limit: 1 }), /core length/)
  await t.exception(session.verifyBlock({
    index: 1,
    proof: { block: { index: 1, value: null } },
    value: b4a.alloc(4),
  }), /core state|core length|value length/)
  t.ok(core.closed, 'incompatible preexisting state is quarantined')
  await session.close()
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

function fakeSwarm() {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.join = () => ({
    async flushed() {},
    destroy() {},
    async suspend() {},
    async resume() {},
  })
  return swarm
}

function fakeMux() {
  const channels = []
  return {
    channels,
    pair() {},
    createChannel(spec) {
      const outbound = []
      const message = {
        ...spec.messages[0],
        send(frame) {
          outbound.push(frame)
          return true
        },
      }
      const channel = {
        closed: false,
        messages: [message],
        open(hello) {
          queueMicrotask(() => spec.onopen(hello))
        },
        close() {
          if (this.closed) return
          this.closed = true
          spec.onclose()
        },
        async fullyOpened() { return true },
        cork() {},
        uncork() {},
      }
      channels.push({ spec, channel, outbound })
      return channel
    },
  }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

async function scopedAssetHarness(t, coreOverrides = {}) {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 71),
    blockLength: 1,
    byteLength: ASSET_BLOCK_SIZE,
  })
  const publisher = crypto.keyPair(b4a.alloc(32, 72))
  const rendition = createRenditionDescriptor({
    purpose: 'video',
    format: 'video/mp4',
    core: descriptor,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Bounded transport',
    renditions: [rendition],
    keyPair: publisher,
    signedAt: 1,
    expiresAt: 100,
  })
  const core = {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    download() { return { destroy() {} } },
    async has() { return false },
    async close() {},
    ...coreOverrides,
  }
  const swarm = fakeSwarm()
  const mux = fakeMux()
  const runtime = createScopedNetworkRuntime({
    swarm,
    muxFactory: () => mux,
    authorizePublication: async request => request.manifest === manifest,
    store: { get() { return core } },
  })
  await runtime.start()
  await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: 1,
  })
  const connection = new EventEmitter()
  connection.remotePublicKey = b4a.alloc(32, 73)
  swarm.emit('connection', connection, { client: true })
  const assetChannel = await until(() => mux.channels.find(entry => entry.spec.protocol.endsWith('/asset')))
  await until(() => runtime.getDiagnostics().sessions.some(session => session.purpose === 'asset' && session.state === 'active'))
  t.teardown(() => runtime.close())
  return { assetChannel, descriptor, runtime }
}

test('aborted scoped block requests discard late responses before proof application', async (t) => {
  let applied = 0
  const { assetChannel, descriptor, runtime } = await scopedAssetHarness(t, {
    async applyProof() { applied++; return true },
  })
  const controller = new AbortController()
  const pending = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    signal: controller.signal,
  })
  await until(() => assetChannel.outbound.some(frame =>
    decodePeerFrame(frame, { typeCodes: PEER_FRAME_TYPE_NAMES }).type === 'asset-block-request'))
  controller.abort()
  await t.exception(pending, /aborted/)

  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 1,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      startBlock: 0,
      endBlock: 1,
      blockIndex: 0,
      kind: 'block',
      offset: 0,
      totalBytes: 1,
      chunk: b4a.from([1]),
    }),
  }))
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(applied, 0)
})

test('asset responder teardown suppresses proof and block frames after its channel closes', async (t) => {
  let resolveProof
  let proofStarted = false
  const value = b4a.alloc(ASSET_BLOCK_SIZE, 74)
  const proofPromise = new Promise(resolve => { resolveProof = resolve })
  const { assetChannel, descriptor } = await scopedAssetHarness(t, {
    async has() { return true },
    async proof() {
      proofStarted = true
      return proofPromise
    },
  })
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-request',
    requestId: 1,
    payload: encodeAssetBlockRequest({ assetId: descriptor.assetId, startBlock: 0, endBlock: 1 }),
  }))
  await until(() => proofStarted)
  assetChannel.channel.close()
  resolveProof({
    fork: 0,
    block: { index: 0, nodes: [], value },
    hash: null,
    seek: null,
    upgrade: null,
    manifest: null,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const responseTypes = assetChannel.outbound.map(frame =>
    decodePeerFrame(frame, { typeCodes: PEER_FRAME_TYPE_NAMES }).type)
  t.absent(responseTypes.find(type => type === 'asset-block-response' || type === 'asset-block-error'))
})
