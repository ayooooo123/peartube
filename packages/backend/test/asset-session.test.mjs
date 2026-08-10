import test from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'
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
import { createScopedNetworkApi, createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import {
  ASSET_BLOCK_ERROR_CODES,
  PEER_FRAME_TYPE_NAMES,
  decodeAssetBlockRequest,
  decodeAssetRangeSummaryRequest,
  decodePeerFrame,
  encodeAssetBlockError,
  encodeAssetBlockRequest,
  encodeAssetBlockResponse,
  encodeAssetRangeSummaryPage,
  encodeAssetRangeSummaryRequest,
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

async function scopedAssetHarness(t, coreOverrides = {}, descriptorOverrides = {}, runtimeOverrides = {}) {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 71),
    blockLength: descriptorOverrides.blockLength ?? 1,
    byteLength: descriptorOverrides.byteLength ?? ASSET_BLOCK_SIZE,
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
    ...runtimeOverrides,
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
  return {
    assetChannel,
    core,
    descriptor,
    manifest,
    mux,
    peerId: b4a.toString(connection.remotePublicKey, 'hex'),
    rendition,
    runtime,
    swarm,
  }
}

function sentAssetRequests(assetChannel) {
  return assetChannel.outbound
    .map(frame => decodePeerFrame(frame, { typeCodes: PEER_FRAME_TYPE_NAMES }))
    .filter(frame => frame.type === 'asset-block-request')
    .map(frame => decodeAssetBlockRequest(frame.payload))
}

function sentAssetRangeRequests(assetChannel) {
  return assetChannel.outbound
    .map(frame => decodePeerFrame(frame, { typeCodes: PEER_FRAME_TYPE_NAMES }))
    .filter(frame => frame.type === 'asset-range-summary-request')
    .map(frame => decodeAssetRangeSummaryRequest(frame.payload))
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
  const transferId = sentAssetRequests(assetChannel)[0].transferId
  controller.abort()
  await t.exception(pending, /aborted/)

  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 1,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId,
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

test('aborting during valid proof application leaves the peer healthy for a later request', async (t) => {
  let applied = 0
  let releaseApply
  let firstApplyFinished = false
  let firstCommittedRead = false
  const applyGate = new Promise(resolve => { releaseApply = resolve })
  const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t, {
    async has() {
      if (applied === 0) return false
      if (applied === 1 && !firstCommittedRead) {
        firstCommittedRead = true
        return true
      }
      return applied > 1
    },
    async applyProof() {
      applied++
      if (applied === 1) {
        await applyGate
        firstApplyFinished = true
      }
      return true
    },
  }, {
    byteLength: 7,
  })
  const sendResponse = (firstRequestId, transferId) => {
    const proof = c.encode(c.any, {
      index: 0,
      byteLength: 7,
      proof: {
        fork: 0,
        block: { index: 0, nodes: [], value: null },
        hash: null,
        seek: null,
        upgrade: null,
        manifest: null,
      },
    })
    let requestId = firstRequestId
    for (const [kind, chunk] of [
      ['proof', proof],
      ['block', b4a.alloc(7, firstRequestId)],
    ]) {
      assetChannel.spec.messages[0].onmessage(encodePeerFrame({
        purpose: 'asset',
        type: 'asset-block-response',
        requestId: requestId++,
        payload: encodeAssetBlockResponse({
          assetId: descriptor.assetId,
          transferId,
          startBlock: 0,
          endBlock: 1,
          blockIndex: 0,
          kind,
          offset: 0,
          totalBytes: chunk.byteLength,
          chunk,
        }),
      }))
    }
  }

  const controller = new AbortController()
  const first = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
    signal: controller.signal,
  })
  const firstRejected = t.exception(first, /aborted/)
  await until(() => sentAssetRequests(assetChannel).length === 1)
  sendResponse(1, sentAssetRequests(assetChannel)[0].transferId)
  await until(() => applied === 1)
  controller.abort()
  await firstRejected
  releaseApply()
  await until(() => firstApplyFinished)
  await new Promise(resolve => setTimeout(resolve, 0))

  const afterAbort = runtime.getDiagnostics()
  t.ok(afterAbort.sessions.some(session =>
    session.purpose === 'asset' &&
    session.peerId === peerId &&
    session.state === 'active'))
  t.not(assetChannel.channel.closed)
  t.not(afterAbort.recentErrors.some(error =>
    error.peerId === peerId &&
    (error.code === 'INVALID_PROOF' || /invalid proof/i.test(error.message))))

  const second = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
  })
  await until(() => sentAssetRequests(assetChannel).length === 2)
  sendResponse(3, sentAssetRequests(assetChannel)[1].transferId)
  const result = await second
  t.alike(result.verifiedBlockIndexes, [0])
  t.alike(result.peerIds, [peerId])
  t.not(assetChannel.channel.closed)
})

test('asset block receivers reject bytes before a complete canonical proof', async (t) => {
  let applied = 0
  const { assetChannel, descriptor, runtime } = await scopedAssetHarness(t, {
    async applyProof() { applied++; return true },
  })
  const pending = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
  })
  const rejected = t.exception(pending, /unavailable|proof|peer/)
  await until(() => sentAssetRequests(assetChannel).length === 1)
  const [{ transferId }] = sentAssetRequests(assetChannel)
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 1,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId,
      startBlock: 0,
      endBlock: 1,
      blockIndex: 0,
      kind: 'block',
      offset: 0,
      totalBytes: 1,
      chunk: b4a.from([1]),
    }),
  }))
  await until(() => assetChannel.channel.closed)
  await rejected
  t.is(applied, 0)
})

test('fresh scoped receivers reject canonical no-upgrade proof metadata before block bytes', async (t) => {
  let applied = 0
  const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t, {
    length: 0,
    byteLength: 0,
    async applyProof() { applied++; return true },
  })
  const pending = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
  })
  const rejected = pending.then(() => null, error => error)
  await until(() => sentAssetRequests(assetChannel).length === 1)
  const [{ transferId }] = sentAssetRequests(assetChannel)
  const proof = c.encode(c.any, {
    index: 0,
    byteLength: ASSET_BLOCK_SIZE,
    proof: {
      fork: 0,
      block: { index: 0, nodes: [], value: null },
      hash: null,
      seek: null,
      upgrade: null,
      manifest: null,
    },
  })
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 1,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId,
      startBlock: 0,
      endBlock: 1,
      blockIndex: 0,
      kind: 'proof',
      offset: 0,
      totalBytes: proof.byteLength,
      chunk: proof,
    }),
  }))
  await until(() => assetChannel.channel.closed)
  const error = await rejected
  t.ok(error)
  t.is(error.code, 'INVALID_PROOF')
  t.is(error.peerId, peerId)
  t.is(applied, 0)
})

test('conflicting proof state quarantines before request rejection and blocks concurrent bytes', async (t) => {
  let applied = 0
  let closeStarted = false
  let closeCompleted = false
  let releaseClose
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const { assetChannel, core, descriptor, peerId, runtime } = await scopedAssetHarness(t, {
    async has() { return false },
    async applyProof() { applied++; return true },
    async close() {
      closeStarted = true
      await closeGate
      closeCompleted = true
    },
  }, {
    blockLength: 2,
    byteLength: ASSET_BLOCK_SIZE + 7,
  })
  const pending = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
  })
  const concurrent = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
  })
  const concurrentObserved = concurrent.then(
    value => ({ value, error: null }),
    error => ({ value: null, error }),
  )
  let settled = false
  const observed = pending.then(
    value => { settled = true; return { value, error: null } },
    error => { settled = true; return { value: null, error } },
  )
  await until(() => sentAssetRequests(assetChannel).length === 2)
  const [{ transferId }] = sentAssetRequests(assetChannel)
  core.length = 1
  core.byteLength = ASSET_BLOCK_SIZE
  const proof = c.encode(c.any, {
    index: 0,
    byteLength: ASSET_BLOCK_SIZE,
    proof: {
      fork: 0,
      block: { index: 0, nodes: [], value: null },
      hash: null,
      seek: null,
      upgrade: { start: 0, length: descriptor.length, nodes: [], additionalNodes: [] },
      manifest: null,
    },
  })
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 1,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId,
      startBlock: 0,
      endBlock: 1,
      blockIndex: 0,
      kind: 'proof',
      offset: 0,
      totalBytes: proof.byteLength,
      chunk: proof,
    }),
  }))
  await until(() => closeStarted)
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 2,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId,
      startBlock: 0,
      endBlock: 1,
      blockIndex: 0,
      kind: 'block',
      offset: 0,
      totalBytes: ASSET_BLOCK_SIZE,
      chunk: b4a.from([1]),
    }),
  }))
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(settled, false, 'the request remains pending until quarantine close and callback complete')
  t.is(applied, 0)
  releaseClose()
  const outcome = await observed
  t.is(outcome.error.code, 'INVALID_PROOF')
  t.is(outcome.error.peerId, peerId)
  const concurrentOutcome = await concurrentObserved
  t.is(concurrentOutcome.error.code, 'QUARANTINED')
  t.is(concurrentOutcome.error.peerId, peerId)
  t.ok(outcome.error.message.length <= 256)
  t.ok(concurrentOutcome.error.message.length <= 256)
  t.ok(closeCompleted)
  await until(() => assetChannel.channel.closed)
  t.is(applied, 0, 'concurrent block bytes never reach proof application')
})

test('delayed transfer frames and errors cannot mutate a reused range request', async (t) => {
  let applied = 0
  const { assetChannel, descriptor, runtime } = await scopedAssetHarness(t, {
    async applyProof() { applied++; return true },
  })
  const firstController = new AbortController()
  const first = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    signal: firstController.signal,
  })
  await until(() => sentAssetRequests(assetChannel).length === 1)
  const firstTransferId = sentAssetRequests(assetChannel)[0].transferId
  firstController.abort()
  await t.exception(first, /aborted/)

  const secondController = new AbortController()
  let secondSettled = false
  const second = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    signal: secondController.signal,
  }).finally(() => { secondSettled = true })
  await until(() => sentAssetRequests(assetChannel).length === 2)
  const secondTransferId = sentAssetRequests(assetChannel)[1].transferId
  t.ok(secondTransferId > firstTransferId)

  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-error',
    requestId: 1,
    payload: encodeAssetBlockError({
      assetId: descriptor.assetId,
      transferId: firstTransferId,
      startBlock: 0,
      endBlock: 1,
      code: ASSET_BLOCK_ERROR_CODES.UNAVAILABLE,
    }),
  }))
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-block-response',
    requestId: 2,
    payload: encodeAssetBlockResponse({
      assetId: descriptor.assetId,
      transferId: firstTransferId,
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
  t.is(secondSettled, false)
  t.is(applied, 0)
  secondController.abort()
  await t.exception(second, /aborted/)
})

test('abort during cached possession scan cannot return success or send a request', async (t) => {
  let releaseHas
  let applied = 0
  let hasStarted = false
  const { assetChannel, descriptor, runtime } = await scopedAssetHarness(t, {
    async has() {
      hasStarted = true
      return new Promise(resolve => { releaseHas = resolve })
    },
    async applyProof() { applied++; return true },
  })
  const controller = new AbortController()
  const pending = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    signal: controller.signal,
  })
  const rejected = t.exception(pending, /aborted/)
  await until(() => hasStarted)
  controller.abort()
  releaseHas(true)
  await rejected
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(sentAssetRequests(assetChannel).length, 0, 'no request is sent after the blocked probe is released')
  t.is(applied, 0)
})

test('asset inventory allows one live scan per peer and teardown suppresses its page', async (t) => {
  let releaseHas
  let hasStarted = false
  const { assetChannel, descriptor } = await scopedAssetHarness(t, {
    async has() {
      hasStarted = true
      return new Promise(resolve => { releaseHas = resolve })
    },
  })
  const request = encodeAssetRangeSummaryRequest({
    assetId: descriptor.assetId,
    cursor: null,
    limit: 1,
  })
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-range-summary-request',
    requestId: 1,
    payload: request,
  }))
  await until(() => hasStarted)
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-range-summary-request',
    requestId: 2,
    payload: request,
  }))
  await until(() => assetChannel.channel.closed)
  releaseHas(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  const pages = assetChannel.outbound
    .map(frame => decodePeerFrame(frame, { typeCodes: PEER_FRAME_TYPE_NAMES }))
    .filter(frame => frame.type === 'asset-range-summary-page')
  t.is(pages.length, 0)
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
    payload: encodeAssetBlockRequest({ assetId: descriptor.assetId, transferId: 1n, startBlock: 0, endBlock: 1 }),
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


test('peer inventory is exact, bounded, single-flight, and correlated to its active session', async (t) => {
  const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t)
  t.alike(runtime.getActiveAssetPeerIds({ assetId: descriptor.assetId }), [peerId])

  const pending = runtime.listPeerAssetRanges({
    assetId: descriptor.assetId,
    peerId,
    cursor: null,
    limit: 1,
  })
  await until(() => sentAssetRangeRequests(assetChannel).length === 1)
  const duplicate = await runtime.listPeerAssetRanges({
    assetId: descriptor.assetId,
    peerId,
    cursor: null,
    limit: 1,
  }).then(() => null, error => error)
  t.ok(duplicate)
  t.is(duplicate.code, 'UNAVAILABLE')
  t.is(duplicate.peerId, peerId)

  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-range-summary-page',
    requestId: 1,
    payload: encodeAssetRangeSummaryPage({
      assetId: descriptor.assetId,
      ranges: [{ startBlock: 0, bitCount: 1, presentBitfield: b4a.from([1]) }],
      nextCursor: null,
      coreLength: descriptor.length,
      cursor: null,
      limit: 1,
    }),
  }))
  t.alike(await pending, {
    ranges: [{ startBlock: 0, bitCount: 1, presentBitfield: b4a.from([1]) }],
    nextCursor: null,
  })
})

test('peer inventory timeout rejects with peer identity and closes the late-frame session', async (t) => {
  const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(
    t,
    {},
    {},
    { assetTransferTimeoutMs: 5 },
  )
  const error = await runtime.listPeerAssetRanges({
    assetId: descriptor.assetId,
    peerId,
    cursor: null,
    limit: 1,
  }).then(() => null, reason => reason)
  t.ok(error)
  t.is(error.code, 'TIMEOUT')
  t.is(error.peerId, peerId)
  t.ok(assetChannel.channel.closed)
  assetChannel.spec.messages[0].onmessage(encodePeerFrame({
    purpose: 'asset',
    type: 'asset-range-summary-page',
    requestId: 1,
    payload: encodeAssetRangeSummaryPage({
      assetId: descriptor.assetId,
      ranges: [],
      nextCursor: null,
      coreLength: descriptor.length,
      cursor: null,
      limit: 1,
    }),
  }))
})

test('selected peers receive distinct concurrent transfers for the same range', async (t) => {
  const { assetChannel, descriptor, mux, peerId, runtime, swarm } = await scopedAssetHarness(t)
  const secondConnection = new EventEmitter()
  secondConnection.remotePublicKey = b4a.alloc(32, 74)
  swarm.emit('connection', secondConnection, { client: true })
  const secondChannel = await until(() =>
    mux.channels.find(entry =>
      entry !== assetChannel && entry.spec.protocol.endsWith('/asset')))
  const secondPeerId = b4a.toString(secondConnection.remotePublicKey, 'hex')
  await until(() => runtime.getActiveAssetPeerIds({ assetId: descriptor.assetId }).length === 2)

  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
    signal: firstController.signal,
  })
  const second = runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [peerId],
    signal: secondController.signal,
  })
  await until(() => sentAssetRequests(assetChannel).length === 2)
  t.is(sentAssetRequests(secondChannel).length, 0)
  const [firstRequest, secondRequest] = sentAssetRequests(assetChannel)
  t.ok(secondRequest.transferId > firstRequest.transferId)
  firstController.abort()
  secondController.abort()
  await t.exception(first, /aborted/)
  await t.exception(second, /aborted/)
  await t.exception(runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: [],
  }), /peerIds are out of bounds/)
  await t.exception(runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: Array.from({ length: 17 }, (_, index) => `peer-${index}`),
  }), /peerIds are out of bounds/)

  const unavailable = await runtime.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 1,
    peerIds: ['missing-peer'],
  }).then(() => null, error => error)
  t.ok(unavailable)
  t.is(unavailable.code, 'UNAVAILABLE')
  t.is(unavailable.peerId, 'missing-peer')
  t.alike(runtime.getActiveAssetPeerIds({ assetId: descriptor.assetId }), [peerId, secondPeerId].sort())
})

test('block transport exposes stable unavailable, disconnected, and timeout peer errors', async (t) => {
  {
    const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t)
    const pending = runtime.requestAssetBlocks({
      assetId: descriptor.assetId,
      startBlock: 0,
      endBlock: 1,
      peerIds: [peerId],
    })
    const observed = pending.then(() => null, error => error)
    await until(() => sentAssetRequests(assetChannel).length === 1)
    const [request] = sentAssetRequests(assetChannel)
    assetChannel.spec.messages[0].onmessage(encodePeerFrame({
      purpose: 'asset',
      type: 'asset-block-error',
      requestId: 1,
      payload: encodeAssetBlockError({
        assetId: descriptor.assetId,
        transferId: request.transferId,
        startBlock: 0,
        endBlock: 1,
        code: ASSET_BLOCK_ERROR_CODES.UNAVAILABLE,
      }),
    }))
    const error = await observed
    t.ok(error)
    t.is(error.code, 'UNAVAILABLE')
    t.is(error.peerId, peerId)
    await runtime.close()
  }
  {
    const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t)
    const pending = runtime.requestAssetBlocks({
      assetId: descriptor.assetId,
      startBlock: 0,
      endBlock: 1,
      peerIds: [peerId],
    })
    const observed = pending.then(() => null, error => error)
    await until(() => sentAssetRequests(assetChannel).length === 1)
    assetChannel.channel.close()
    const error = await observed
    t.ok(error)
    t.is(error.code, 'DISCONNECTED')
    t.is(error.peerId, peerId)
    await runtime.close()
  }
  {
    const { descriptor, peerId, runtime } = await scopedAssetHarness(
      t,
      {},
      {},
      { assetTransferTimeoutMs: 5 },
    )
    const error = await runtime.requestAssetBlocks({
      assetId: descriptor.assetId,
      startBlock: 0,
      endBlock: 1,
      peerIds: [peerId],
    }).then(() => null, reason => reason)
    t.ok(error)
    t.is(error.code, 'TIMEOUT')
    t.is(error.peerId, peerId)
    await runtime.close()
  }
})

test('verified local possession and reads stay bound to the exact asset session', async (t) => {
  const value = b4a.alloc(ASSET_BLOCK_SIZE, 75)
  let reads = 0
  const { descriptor, runtime } = await scopedAssetHarness(t, {
    async has(index) { return index === 0 },
    async get(index, options) {
      t.is(index, 0)
      t.is(options.wait, false)
      reads++
      return value
    },
  })
  t.is(await runtime.hasVerifiedAssetBlock({
    assetId: descriptor.assetId,
    blockIndex: 0,
  }), true)
  const block = await runtime.readVerifiedAssetBlock({
    assetId: descriptor.assetId,
    blockIndex: 0,
  })
  t.is(block, value, 'verified reads do not copy block payloads')
  t.is(reads, 1)

  const controller = new AbortController()
  controller.abort()
  const aborted = await runtime.hasVerifiedAssetBlock({
    assetId: descriptor.assetId,
    blockIndex: 0,
    signal: controller.signal,
  }).then(() => null, error => error)
  t.ok(aborted)
  t.is(aborted.name, 'AbortError')
})

test('peer inventory abort and runtime teardown clear pending session state', async (t) => {
  {
    const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t)
    const controller = new AbortController()
    const pending = runtime.listPeerAssetRanges({
      assetId: descriptor.assetId,
      peerId,
      cursor: null,
      limit: 1,
      signal: controller.signal,
    })
    const observed = pending.then(() => null, error => error)
    await until(() => sentAssetRangeRequests(assetChannel).length === 1)
    controller.abort()
    const error = await observed
    t.ok(error)
    t.is(error.name, 'AbortError')
    t.is(error.peerId, peerId)
    t.ok(assetChannel.channel.closed)
    await runtime.close()
  }
  {
    const { assetChannel, descriptor, peerId, runtime } = await scopedAssetHarness(t)
    const pending = runtime.listPeerAssetRanges({
      assetId: descriptor.assetId,
      peerId,
      cursor: null,
      limit: 1,
    })
    const observed = pending.then(() => null, error => error)
    await until(() => sentAssetRangeRequests(assetChannel).length === 1)
    await runtime.close()
    const error = await observed
    t.ok(error)
    t.is(error.code, 'DISCONNECTED')
    t.is(error.peerId, peerId)
  }
})

test('runtime exposes only the exact active asset session identity internally', async (t) => {
  const { descriptor, manifest, rendition, runtime } = await scopedAssetHarness(t)
  const session = runtime.getActiveAssetSession({ assetId: descriptor.assetId })
  t.is(session.assetId, descriptor.assetId)
  t.is(session.coreRef.assetId, descriptor.assetId)
  t.absent(createScopedNetworkApi(runtime).getActiveAssetSession)

  t.exception(() => runtime.getActiveAssetSession({
    assetId: b4a.alloc(32, 99),
  }), /asset scope is not active/)

  await runtime.releaseAuthorizedRendition({
    renditionId: rendition.renditionId,
    ownerId: manifest.publicationId,
  })
  t.exception(() => runtime.getActiveAssetSession({
    assetId: descriptor.assetId,
  }), /asset scope is not active/)

  await runtime.close()
  t.exception(() => runtime.getActiveAssetSession({
    assetId: descriptor.assetId,
  }), /runtime is not active/)
})