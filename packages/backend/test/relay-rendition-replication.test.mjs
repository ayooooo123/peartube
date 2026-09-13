import test from 'brittle'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { ASSET_BLOCK_SIZE, writeStaticAsset, createPublicationManifest, createRenditionDescriptor } from '../src/assets/index.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'

function participationPolicy (overrides = {}) {
  return {
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024,
    permissions: { contribute: true, archive: false },
    publicServingAllowed: true,
    contributionBudgetBytes: 1024 * 1024,
    archiveBudgetBytes: 0,
    ...overrides,
  }
}
function delayNextNativeBlockRead (core) {
  const storage = core.core.storage
  const read = storage.read
  let markStarted
  let resume
  let delayed = false
  let released = false
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  storage.read = function delayedStorageRead () {
    const batch = read.call(this)
    if (delayed) return batch
    const getBlock = batch.getBlock.bind(batch)
    batch.getBlock = async index => {
      const block = getBlock(index)
      delayed = true
      markStarted()
      await gate
      return block
    }
    return batch
  }
  return {
    started,
    release () {
      if (released) return
      released = true
      resume()
    },
    restore () {
      storage.read = read
    },
  }
}

async function within (promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function createManualRateSchedule () {
  let current = 0
  const timers = []
  const waiters = []
  return {
    now: () => current,
    setTimer (fn, delay) {
      timers.push({ at: current + delay, fn })
      while (waiters.length > 0) waiters.shift()()
      return { unref () { return this } }
    },
    waitForTimer () {
      if (timers.length > 0) return Promise.resolve()
      return new Promise(resolve => waiters.push(resolve))
    },
    async advance (milliseconds) {
      current += milliseconds
      const due = timers.splice(0).filter(timer => timer.at <= current)
      for (const timer of due) timer.fn()
      await Promise.resolve()
    },
  }
}




for (const sourceCanUpload of [true, false]) {
test(sourceCanUpload ? 'a relay reads a cold rendition over its existing peer stream' : 'a watch-only relay does not serve its retained media over that stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'peartube-relay-read-'))
  const sourceStore = new Corestore(join(root, 'source'))
  const readerStore = new Corestore(join(root, 'reader'))
  const sourceSwarm = new Hyperswarm({ bootstrap: [] })
  const readerSwarm = new Hyperswarm({ bootstrap: [] })
  let sourceRuntime, readerRuntime, reader, asset
  t.teardown(async () => {
    await reader?.close()
    await sourceRuntime?.close()
    await readerRuntime?.close()
    await Promise.all([sourceSwarm.destroy(), readerSwarm.destroy()])
    await asset?.core.close()
    await Promise.all([sourceStore.close(), readerStore.close()])
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([sourceStore.ready(), readerStore.ready(), sourceSwarm.listen()])
  const bytes = b4a.alloc(ASSET_BLOCK_SIZE * 2 + 31)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  asset = await writeStaticAsset({ store: sourceStore, reader: createBufferSourceReader(bytes) })
  const publisher = crypto.keyPair()
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Remote range',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: asset.descriptor })],
    keyPair: publisher,
    signedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const rendition = manifest.body.renditions[0]
  const policy = participationPolicy()
  sourceRuntime = createScopedNetworkRuntime({
    swarm: sourceSwarm, store: sourceStore, bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: sourceCanUpload ? policy : { ...policy, uploadPermission: 'disabled', publicServingAllowed: false },
  })
  readerRuntime = createScopedNetworkRuntime({
    swarm: readerSwarm, store: readerStore, bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    peerAddresses: [{ publicKey: sourceSwarm.keyPair.publicKey.toString('hex'), host: '127.0.0.1', port: sourceSwarm.dht.io.serverSocket.address().port }],
    initialNetworkPolicy: policy,
  })
  await sourceRuntime.start()
  await sourceRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
  const coldCore = readerStore.get({ key: asset.descriptor.key, manifest: asset.descriptor.hypercoreManifest, writable: false })
  await coldCore.ready()
  t.is(await coldCore.has(0), false, 'the receiving relay has no media block')
  await coldCore.close()
  await readerRuntime.start()
  if (sourceCanUpload) {
    const nativeController = globalThis.AbortController
    globalThis.AbortController = undefined
    t.teardown(() => { globalThis.AbortController = nativeController })
  }
  const api = createMediaGraphApi({
    store: readerStore, scopedNetwork: readerRuntime,
    verifiedQueryView: {
      getRendition: async () => ({ manifest, rendition }),
      getPublication: async () => ({ workEntityId: null }),
      authorizeRendition: async () => true,
    },
  })
  reader = await api.openMediaRendition({ publicationId: manifest.publicationId, renditionId: rendition.renditionId })
  t.is(reader.success, true)
  const start = ASSET_BLOCK_SIZE - 7
  const length = ASSET_BLOCK_SIZE + 19
  const chunks = []
  // No peer-ready delay: a cold read itself must wait for replication.
  const read = (async () => { for await (const chunk of reader.read({ start, length })) chunks.push(chunk) })()
    .then(() => null, error => error)
  let timer
  try {
    const failure = await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('relay read did not settle')), 5000) })])
    if (sourceCanUpload && failure) throw failure
    if (!sourceCanUpload) t.is(failure?.code, 'NO_VERIFIED_SOURCE', 'the peer refuses to serve without upload permission')
  } finally { clearTimeout(timer) }
  if (sourceCanUpload) {
    t.alike(b4a.concat(chunks), bytes.subarray(start, start + length), 'the requested cross-block bytes arrive intact')
    t.is(sourceRuntime.getDiagnostics().policy.uploadedBytes, bytes.byteLength,
      'the native upload path charges every full Hypercore block it sent')
  } else {
    t.is(chunks.length, 0, 'uploads remain disabled on the watch-only relay')
  }
})
}

for (const scenario of [
  {
    name: 'a watch-only dialer holding media never uploads it',
    policy: participationPolicy({ uploadPermission: 'disabled', publicServingAllowed: false }),
    reason: 'consent',
  },
  {
    name: 'a zero-rate dialer holding media never uploads it',
    policy: participationPolicy({ outboundBytesPerSecond: 0 }),
    reason: 'rate',
  },
  {
    name: 'a dialer cannot upload a block larger than its remaining byte budget',
    policy: participationPolicy({
      uploadCeilingBytes: ASSET_BLOCK_SIZE - 1,
      contributionBudgetBytes: ASSET_BLOCK_SIZE - 1,
    }),
    reason: 'bytes',
  },
  {
    name: 'consent revoked during a native block read stops the final send',
    policy: participationPolicy(),
    reason: 'revoked consent',
    revokeDuringRead: true,
  },
  {
    name: 'a positive byte-budget reduction invalidates a native rate wait',
    policy: participationPolicy({ outboundBytesPerSecond: ASSET_BLOCK_SIZE }),
    reason: 'reduced byte budget',
    reduceBudgetDuringRateWait: true,
  },
]) {
test(scenario.name, async t => {
  const root = await mkdtemp(join(tmpdir(), 'peartube-relay-dialer-policy-'))
  const holderStore = new Corestore(join(root, 'holder'))
  const receiverStore = new Corestore(join(root, 'receiver'))
  const holderSwarm = new Hyperswarm({ bootstrap: [] })
  const receiverSwarm = new Hyperswarm({ bootstrap: [] })
  let holderRuntime, receiverRuntime, asset, blockDelay
  t.teardown(async () => {
    blockDelay?.release()
    blockDelay?.restore()
    await holderRuntime?.close()
    await receiverRuntime?.close()
    await Promise.all([holderSwarm.destroy(), receiverSwarm.destroy()])
    await asset?.core.close()
    await Promise.all([holderStore.close(), receiverStore.close()])
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([holderStore.ready(), receiverStore.ready(), receiverSwarm.listen()])
  const bytes = b4a.alloc(ASSET_BLOCK_SIZE * 2 + 7, 41)
  asset = await writeStaticAsset({ store: holderStore, reader: createBufferSourceReader(bytes) })
  const publisher = crypto.keyPair()
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Dialer policy',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: asset.descriptor })],
    keyPair: publisher,
    signedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const rendition = manifest.body.renditions[0]
  const receiverAddress = receiverSwarm.dht.io.serverSocket.address()
  let holderDialed = false
  let holderConnections = 0
  let holderAssetPeerAdds = 0
  let receiverMux = null
  holderSwarm.on('connection', (_connection, info) => {
    holderConnections++
    if (info.client === true) holderDialed = true
  })
  asset.core.on('peer-add', () => { holderAssetPeerAdds++ })
  let uploads = 0
  asset.core.on('upload', () => { uploads++ })
  const holderCoreState = asset.core.core
  const baselineHolderSessions = holderCoreState.sessionStates.length
  const baselineHolderMonitors = holderCoreState.monitors.length
  const rateSchedule = scenario.reduceBudgetDuringRateWait ? createManualRateSchedule() : null
  receiverRuntime = createScopedNetworkRuntime({
    swarm: receiverSwarm,
    store: receiverStore,
    bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: participationPolicy(),
  })
  holderRuntime = createScopedNetworkRuntime({
    swarm: holderSwarm,
    store: holderStore,
    bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    peerAddresses: [{
      publicKey: receiverSwarm.keyPair.publicKey.toString('hex'),
      host: '127.0.0.1',
      port: receiverAddress.port,
    }],
    initialNetworkPolicy: scenario.policy,
    ...(rateSchedule
      ? {
          now: rateSchedule.now,
          setOutboundRateTimer: rateSchedule.setTimer,
        }
      : {}),
  })
  await receiverRuntime.start()
  await receiverRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
  const receiverSession = receiverRuntime.getActiveAssetSession({ assetId: rendition.core.assetId })
  receiverSession.core.on('peer-add', peer => { receiverMux = peer.protomux })
  await holderRuntime.start()
  await holderRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
  if (rateSchedule) {
    const first = await receiverSession.core.get(0, { timeout: 3_000 })
    t.alike(first, bytes.subarray(0, ASSET_BLOCK_SIZE), 'the first block spends the initial rate allowance')
    const pendingSecond = receiverSession.core.get(1, { timeout: 3_000 })
      .then(value => ({ value }), error => ({ error }))
    await within(rateSchedule.waitForTimer(), 3_000, 'the second block did not enter the rate wait')
    await holderRuntime.applyNetworkPolicy(participationPolicy({
      outboundBytesPerSecond: ASSET_BLOCK_SIZE,
      uploadCeilingBytes: ASSET_BLOCK_SIZE,
      contributionBudgetBytes: ASSET_BLOCK_SIZE,
    }))
    await rateSchedule.advance(1_000)
    const second = await within(pendingSecond, 3_000, 'the second block did not settle after the budget changed')
    t.ok(holderDialed, 'the media holder initiated this connection')
    t.ok(second.error, 'the old rate reservation cannot cross a newer positive byte budget')
    t.is(await receiverSession.core.has(1), false, 'the block denied after the rate wait did not arrive')
    const diagnostics = holderRuntime.getDiagnostics()
    t.is(diagnostics.policy.uploadedBytes, ASSET_BLOCK_SIZE, 'the denied reservation returned its byte charge')
    t.ok(diagnostics.counters.rejectedNativeUploads > 0, 'the native upload gate recorded the stale reservation')
    return
  }

  if (scenario.revokeDuringRead) blockDelay = delayNextNativeBlockRead(asset.core)
  const pendingResult = receiverSession.core.get(0, { timeout: 3_000 })
    .then(value => ({ value }), error => ({ error }))
  if (blockDelay) {
    await within(blockDelay.started, 3_000, 'native block read did not start')
    await holderRuntime.applyNetworkPolicy(participationPolicy({
      uploadPermission: 'disabled',
      publicServingAllowed: false,
    }))
    blockDelay.release()
    blockDelay.restore()
  }
  const result = await pendingResult
  t.ok(holderDialed, 'the media holder initiated this connection')
  t.ok(result.error, `the remote block request is refused by the ${scenario.reason} gate`)
  t.is(await receiverSession.core.has(0), false, 'the requesting peer received no block')
  if (!scenario.revokeDuringRead) t.is(uploads, 0, 'the dialer emitted no Hypercore upload')
  if (scenario.reason === 'consent') {
    const peerAddsBeforeReopen = holderAssetPeerAdds
    if ((receiverSession.core.peers?.length || 0) === 0) {
      t.ok(receiverMux, 'the first Hypercore peer exposed its existing Protomux')
      t.ok(receiverSession.core.core.replicator._makePeer(receiverMux),
        'the requester reopened the Hypercore channel on that same stream')
    }
    const reopened = await receiverSession.core.get(1, { timeout: 3_000 })
      .then(value => ({ value }), error => ({ error }))
    t.ok(reopened.error, 'the reopened channel is guarded before its second block request')
    t.is(await receiverSession.core.has(1), false, 'the reopened channel received no block')
    t.is(holderConnections, 1, 'the second request reused the original Noise connection')
    t.ok(holderAssetPeerAdds > peerAddsBeforeReopen, 'the holder installed a guard on the fresh Hypercore peer')
    await holderRuntime.releaseAuthorizedRendition({ renditionId: rendition.renditionId })
    t.is(holderCoreState.sessionStates.length, baselineHolderSessions,
      'last-owner release returns the source core to its baseline session count')
    t.is(holderCoreState.monitors.length, baselineHolderMonitors,
      'last-owner release returns the source core to its baseline monitor count')
    await holderRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
    await holderRuntime.releaseAuthorizedRendition({ renditionId: rendition.renditionId })
    t.is(holderCoreState.sessionStates.length, baselineHolderSessions,
      'a repeated retain and release leaves no source-core session behind')
    t.is(holderCoreState.monitors.length, baselineHolderMonitors,
      'a repeated retain and release leaves no source-core monitor behind')
    await holderRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
    const peerAddsBeforeShutdown = holderAssetPeerAdds
    await holderRuntime.close()
    t.is(holderCoreState.sessionStates.length, baselineHolderSessions,
      'runtime close returns the source core to its baseline session count')
    t.is(holderCoreState.monitors.length, baselineHolderMonitors,
      'runtime close returns the source core to its baseline monitor count')
    t.is(holderSwarm.connections.size, 1, 'runtime close leaves the existing Noise connection alive')
    if ((receiverSession.core.peers?.length || 0) === 0) {
      t.ok(receiverSession.core.core.replicator._makePeer(receiverMux),
        'the requester attempted to reopen the Hypercore channel after runtime close')
    }
    const afterShutdown = await receiverSession.core.get(2, { timeout: 3_000 })
      .then(value => ({ value }), error => ({ error }))
    t.ok(afterShutdown.error, 'a live writer session cannot serve after its network runtime closes')
    t.is(await receiverSession.core.has(2), false, 'the shutdown reopen received no block')
    t.is(holderConnections, 1, 'the shutdown reopen reused the original Noise connection')
    t.is(holderAssetPeerAdds, peerAddsBeforeShutdown, 'the detached source core did not accept the shutdown reopen')
  }
  const diagnostics = holderRuntime.getDiagnostics()
  t.is(diagnostics.policy.uploadedBytes, 0, 'the device charged no bytes that did not leave')
  t.ok(diagnostics.counters.rejectedNativeUploads > 0, 'the native upload gate recorded the refusal')
})
}
