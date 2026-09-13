import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSET_BLOCK_SIZE, writeStaticAsset } from '../src/assets/static-core.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { deriveRenditionId, normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'
import { createAcquisitionNetwork } from '../src/network/scoped-acquisition-runtime.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import {
  CLOSED_ACQUISITION_POLICY,
  normalizeAcquisitionPolicy,
} from '../src/acquisition/index.js'

function id (keyPair) {
  return b4a.toString(keyPair.publicKey, 'hex')
}

function hex (byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

function openPolicy (overrides = {}) {
  const current = normalizeAcquisitionPolicy({
    ...CLOSED_ACQUISITION_POLICY,
    migrationRequired: false,
    enabled: true,
    acceptPublicRequests: true,
    requesterMode: 'public',
    allowedPublisherIds: [],
    allowedAdapterIds: ['local-adapter'],
    maxQueuedJobs: 8,
    maxConcurrentJobs: 8,
    maxConcurrentPerRequester: 4,
    maxRequestBytes: 16 * 1024 * 1024,
    maxAcquireBytesPer24h: 64 * 1024 * 1024,
    maxAcquireBytesPerSecond: 10 * 1024 * 1024,
    maxStagingBytes: 16 * 1024 * 1024,
    minFreeDiskBytes: 1,
    maxJobRuntimeMs: 60_000,
    sourceGrantTtlMs: 30_000,
    publicRequestsPerMinute: 8,
    ...overrides,
  })
  return { ...current, generation: 1, remainingAcquireBytes24h: current.maxAcquireBytesPer24h }
}
function participationPolicy () {
  return {
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4 * 1024 * 1024,
    diskCeilingBytes: 4 * 1024 * 1024,
    permissions: { contribute: true, archive: false },
    publicServingAllowed: true,
    contributionBudgetBytes: 4 * 1024 * 1024,
    archiveBudgetBytes: 0,
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


function linkedScopedPair (leftKeyPair, rightKeyPair) {
  const pending = []
  function endpoint (keyPair) {
    return {
      peer: null,
      discovery: null,
      assignments: new Map(),
      getLocalTransportPeerId () { return id(keyPair) },
      async retainAcquisitionDiscovery (options) { this.discovery = options },
      async releaseAcquisitionDiscovery () { this.discovery = null },
      async retainAcquisitionAssignment (options) { this.assignments.set(options.assignmentId, options) },
      async releaseAcquisitionAssignment ({ assignmentId }) { this.assignments.delete(assignmentId) },
      publishAcquisitionFrame (input) {
        const dest = this.peer
        if (!dest) return { sent: 0 }
        const assignment = dest.assignments.get(input.assignmentId)
        if (!assignment?.onFrame) return { sent: 0 }
        pending.push(async () => {
          await assignment.onFrame({
            purpose: input.purpose,
            type: input.type,
            assignmentId: input.assignmentId,
            payload: input.payload,
          }, {
            peerId: id(keyPair),
            purpose: input.purpose,
            assignmentId: input.assignmentId,
          })
        })
        return { sent: 1 }
      },
    }
  }

  const left = endpoint(leftKeyPair)
  const right = endpoint(rightKeyPair)
  left.peer = right
  right.peer = left

  return {
    left,
    right,
    async flush () {
      while (pending.length) {
        const op = pending.shift()
        await op().catch(() => {})
      }
    },
  }
}

async function createFixture (t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-hold-lifecycle-'))
  const store = new Corestore(dir)
  await store.ready()
  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  const sourceBytes = options.sourceBytes || b4a.from('exact verified payload bytes for acquisition hold tests')
  const written = await writeStaticAsset({ store, reader: createBufferSourceReader(sourceBytes) })
  const descriptor = normalizeAssetCoreRefV2(written.descriptor)

  const requesterKeyPair = crypto.keyPair(b4a.alloc(32, options.requesterSeed || 1))
  const workerKeyPair = crypto.keyPair(b4a.alloc(32, options.workerSeed || 2))
  const transport = linkedScopedPair(requesterKeyPair, workerKeyPair)

  let current = 1_000_000
  const activeTimers = []
  const worker = createAcquisitionNetwork({
    scopedNetwork: transport.right,
    keyPair: workerKeyPair,
    policy: { networkTerms: () => openPolicy() },
    manager: {
      async onRequest () {},
      async onOffer () {},
      async onAssignment () {},
      async onProgress () {},
      async onResult () {},
      async onCancellation () {},
    },
    now: () => current,
    setTimeout: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref () {} }
      activeTimers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      timer.cleared = true
    },
  })
  if (options.store !== null) worker.setAssetStore(options.customStore || store)
  await worker.start()

  const assignmentId = hex(options.assignmentSeed || 0x11)
  const requestId = hex(options.requestSeed || 0x22)
  const offerId = hex(options.offerSeed || 0x33)
  const publisherId = hex(options.publisherSeed || 0x44)
  const requesterId = id(requesterKeyPair)
  const acquirerId = id(workerKeyPair)
  const deadline = current + 20_000
  const resultHoldUntil = current + 60_000
  const holdUntil = current + 40_000

  async function restore (overrides = {}) {
    return worker.restoreAssignment({
      assignmentId,
      peerId: requesterId,
      role: 'worker',
      requesterId,
      acquirerId,
      budget: { maxSourceBytes: 10_000, maxOutputBytes: 10_000, maxNetworkBytes: 20_000, maxWallClockMs: 60_000 },
      requestId,
      offerId,
      publisherId,
      publicationIntentDigest: hex(0x55),
      deadline,
      resultHoldUntil,
      policyEpoch: 1,
      ...overrides,
    })
  }

  return {
    dir,
    store,
    sourceBytes,
    written,
    descriptor,
    requesterKeyPair,
    workerKeyPair,
    transport,
    worker,
    activeTimers,
    assignmentId,
    requestId,
    offerId,
    publisherId,
    requesterId,
    acquirerId,
    deadline,
    resultHoldUntil,
    holdUntil,
    current: () => current,
    advance: (ms) => { current += ms },
    restore,
  }
}

test('session-backed retries reuse one live handle and release it on cancellation', async t => {
  const f = await createFixture(t)
  await f.restore()
  const opened = []
  f.worker.setAssetStore({ get(options) { const core = f.store.get(options); opened.push(core); return core } })
  const asset = { purpose: 'original', format: 'application/octet-stream', core: f.descriptor }
  asset.renditionId = deriveRenditionId(asset)
  const result = {
    assignmentId: f.assignmentId,
    sourceIdentity: { kind: 'sha256', value: createHash('sha256').update(f.sourceBytes).digest('hex') },
    assets: [asset],
    acquiredBytes: f.sourceBytes.byteLength,
    completedAt: f.current(),
    availabilityUntil: f.holdUntil,
  }
  f.transport.right.peer = null
  let original
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.restore({ result })
    const hold = await f.worker.holdVerifiedAsset({
      assignmentId: f.assignmentId, asset: f.descriptor, availabilityUntil: f.holdUntil,
    })
    original ||= hold
    t.is(hold, original, 'retry shares the original held resource')
    t.is((await f.worker.result(result)).delivery.sent, 0)
  }
  t.is(opened.length, 1, 'retries open only one actual Corestore handle')
  t.alike(await original.session.readVerifiedBlock(0), f.sourceBytes)
  t.is(f.activeTimers.filter(timer => !timer.cleared).length, 2, 'one assignment timer and one hold timer remain')
  await f.worker.cancel({ assignmentId: f.assignmentId, requestId: f.requestId, reasonCode: 'worker-cancelled' })
  t.is(opened[0].closed, true, 'cancellation closes the owned physical handle')
  await f.worker.close()
})

test('concurrent identical holdVerifiedAsset calls share a single session and timer', async (t) => {
  const f = await createFixture(t, { assignmentSeed: 0x12, requestSeed: 0x23 })
  await f.restore()

  const [h1, h2, h3, h4] = await Promise.all([
    f.worker.holdVerifiedAsset({ assignmentId: f.assignmentId, asset: f.descriptor, availabilityUntil: f.holdUntil }),
    f.worker.holdVerifiedAsset({ assignmentId: f.assignmentId, asset: f.descriptor, availabilityUntil: f.holdUntil }),
    f.worker.holdVerifiedAsset({ assignmentId: f.assignmentId, asset: f.descriptor, availabilityUntil: f.holdUntil }),
    f.worker.holdVerifiedAsset({ assignmentId: f.assignmentId, asset: f.descriptor, availabilityUntil: f.holdUntil }),
  ])

  t.is(h1, h2, 'call 1 and 2 return identical hold')
  t.is(h2, h3, 'call 2 and 3 return identical hold')
  t.is(h3, h4, 'call 3 and 4 return identical hold')

  const holdTimers = f.activeTimers.filter(timer => !timer.cleared && timer.delay === (f.holdUntil - f.current()))
  t.is(holdTimers.length, 1, 'only one timer scheduled for 4 concurrent calls')
  t.alike(await h1.session.readVerifiedBlock(0), f.sourceBytes, 'bytes verified')

  await f.worker.close()
})

test('real concurrent different-replacement cancels and drains predecessor before opening', async (t) => {
  const f = await createFixture(t, { assignmentSeed: 0x13, requestSeed: 0x24 })
  await f.restore()

  const secondSource = b4a.from('second distinct verified payload for replacement test')
  const written2 = await writeStaticAsset({ store: f.store, reader: createBufferSourceReader(secondSource) })
  const descriptor2 = normalizeAssetCoreRefV2(written2.descriptor)

  // Call A and Call B executed concurrently with different assets
  const callA = f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: f.descriptor,
    availabilityUntil: f.holdUntil,
  })
  const callB = f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: descriptor2,
    availabilityUntil: f.holdUntil + 5_000,
  })

  const [resA, resB] = await Promise.allSettled([callA, callB])

  // Call B was the replacement: must be fulfilled with descriptor2
  t.is(resB.status, 'fulfilled', 'replacement hold succeeds')
  t.alike(await resB.value.session.readVerifiedBlock(0), secondSource, 'replacement session has second source bytes')

  // If callA was superseded before ready, it rejects; if it finished before B, its session is closed
  if (resA.status === 'fulfilled') {
    await t.exception(resA.value.session.readVerifiedBlock(0), 'superseded hold session was closed')
  } else {
    t.ok(resA.reason, 'superseded hold rejected cleanly')
  }

  await f.worker.close()
})

test('close cancels stalled readiness before its gate opens and prevents resurrection', async (t) => {
  let gateRelease = null
  const gatePromise = new Promise(resolve => { gateRelease = resolve })
  t.teardown(() => gateRelease())
  let readyEntered
  const entered = new Promise(resolve => { readyEntered = resolve })
  let openedCore

  const dir = mkdtempSync(join(tmpdir(), 'peartube-hold-gated-'))
  const realStore = new Corestore(dir)
  await realStore.ready()
  t.teardown(async () => {
    await realStore.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  const sourceBytes = b4a.from('close-during-ready test payload')
  const written = await writeStaticAsset({ store: realStore, reader: createBufferSourceReader(sourceBytes) })
  const descriptor = normalizeAssetCoreRefV2(written.descriptor)

  const gatedStore = {
    get (options) {
      const core = realStore.get(options)
      openedCore = core
      const origReady = core.ready.bind(core)
      core.ready = async () => {
        await origReady()
        readyEntered()
        await gatePromise
      }
      return core
    },
  }

  const f = await createFixture(t, { assignmentSeed: 0x14, requestSeed: 0x25, customStore: gatedStore })
  await f.restore()

  // Start holdVerifiedAsset — pauses in ready()
  const holdPromise = f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: descriptor,
    availabilityUntil: f.holdUntil,
  })

  await entered
  const rejected = t.exception(holdPromise, /worker assignment is not retained|closed/)
  await f.worker.close()
  await rejected
  t.is(openedCore.closed, true, 'shutdown closes the actual handle without waiting for the readiness gate')
  gateRelease()
  await Promise.resolve()
  t.is(openedCore.closed, true, 'late readiness cannot revive the released handle')
})

test('createAssetSession ownership: external core remains caller-owned on hold release; internal core handle closes', async (t) => {
  const f = await createFixture(t, { assignmentSeed: 0x15, requestSeed: 0x26 })
  await f.restore()

  // Caller opens its own external core
  const externalCore = f.store.get({
    key: b4a.from(f.descriptor.key, 'hex'),
    manifest: f.descriptor.hypercoreManifest,
    writable: false,
  })
  await externalCore.ready()
  t.is(externalCore.closed, false)

  const hold = await f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: f.descriptor,
    availabilityUntil: f.holdUntil,
    core: externalCore,
  })
  t.alike(await hold.session.readVerifiedBlock(0), f.sourceBytes, 'hold serves the caller-supplied asset')

  // Release hold via cancellation
  await f.worker.cancel({
    assignmentId: f.assignmentId,
    requestId: f.requestId,
    reasonCode: 'worker-cancelled',
  })

  // Hold session is closed
  await t.exception(hold.session.readVerifiedBlock(0), 'hold session closed')

  // External core remains open and readable by caller!
  t.is(externalCore.closed, false, 'external core remains open')
  const byte = await externalCore.get(0)
  t.alike(byte, f.sourceBytes, 'external core bytes remain readable by caller')

  await externalCore.close()
  t.is(externalCore.closed, true, 'caller closes its own core')

  await f.worker.close()
})

test('half-open expiration and resultHoldUntil boundary validation', async (t) => {
  const f = await createFixture(t, { assignmentSeed: 0x16, requestSeed: 0x27 })
  await f.restore()

  // Past
  await t.exception(
    f.worker.holdVerifiedAsset({
      assignmentId: f.assignmentId,
      asset: f.descriptor,
      availabilityUntil: f.current() - 1,
    }),
    /hold availability has already expired/
  )

  // Half-open boundary: current === availabilityUntil is expired
  await t.exception(
    f.worker.holdVerifiedAsset({
      assignmentId: f.assignmentId,
      asset: f.descriptor,
      availabilityUntil: f.current(),
    }),
    /hold availability has already expired/
  )

  // Exceeds assignment resultHoldUntil
  await t.exception(
    f.worker.holdVerifiedAsset({
      assignmentId: f.assignmentId,
      asset: f.descriptor,
      availabilityUntil: f.resultHoldUntil + 1,
    }),
    /hold availability exceeds assignment resultHoldUntil/
  )

  await f.worker.close()
})

test('failed hold initialization quarantines the exact injected handle', async t => {
  const f = await createFixture(t)
  await f.restore()
  const other = await writeStaticAsset({ store: f.store, reader: createBufferSourceReader(b4a.from('different asset')) })
  await t.exception(f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: normalizeAssetCoreRefV2(other.descriptor),
    availabilityUntil: f.holdUntil,
    core: f.written.core,
  }), /key does not match/)
  t.is(f.written.core.closed, true, 'identity quarantine closes the exact injected handle')
  await t.exception(f.written.core.get(0), /closed/i)
  await f.worker.close()
})

test('cancelling stalled borrowed readiness preserves the caller handle', async t => {
  const f = await createFixture(t)
  await f.restore()
  const core = f.written.core
  const originalReady = core.ready.bind(core)
  let release
  let entered
  const stopped = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  t.teardown(() => { release(); core.ready = originalReady })
  core.ready = async () => {
    await originalReady()
    entered()
    await stopped
  }
  const rejected = t.exception(f.worker.holdVerifiedAsset({
    assignmentId: f.assignmentId,
    asset: f.descriptor,
    availabilityUntil: f.holdUntil,
    core,
  }), /worker assignment is not retained|closed/)
  await started
  await f.worker.close()
  await rejected
  t.is(core.closed, false, 'cancellation does not quarantine stalled readiness')
  release()
  core.ready = originalReady
  t.alike(await core.get(0), f.sourceBytes, 'the original caller can still read its asset')
})

test('repeated supplied-core holds release native ownership without closing the writer or Noise stream', async t => {
  const root = mkdtempSync(join(tmpdir(), 'peartube-borrowed-hold-'))
  const workerStore = new Corestore(join(root, 'worker'))
  const requesterStore = new Corestore(join(root, 'requester'))
  const workerSwarm = new Hyperswarm({ bootstrap: [] })
  const requesterSwarm = new Hyperswarm({ bootstrap: [] })
  let workerRuntime, requesterRuntime, receiverCore, written
  const workers = []
  t.teardown(async () => {
    for (const worker of workers) await worker.close().catch(() => {})
    await receiverCore?.close().catch(() => {})
    await workerRuntime?.close().catch(() => {})
    await requesterRuntime?.close().catch(() => {})
    await Promise.all([workerSwarm.destroy(), requesterSwarm.destroy()])
    await written?.core.close().catch(() => {})
    await Promise.all([workerStore.close(), requesterStore.close()])
    rmSync(root, { recursive: true, force: true })
  })
  await Promise.all([
    workerStore.ready(),
    requesterStore.ready(),
    workerSwarm.listen(),
    requesterSwarm.listen(),
  ])
  const sourceBytes = b4a.alloc(3 * ASSET_BLOCK_SIZE + 17, 73)
  written = await writeStaticAsset({ store: workerStore, reader: createBufferSourceReader(sourceBytes) })
  const descriptor = normalizeAssetCoreRefV2(written.descriptor)
  receiverCore = requesterStore.get({
    key: b4a.from(descriptor.key, 'hex'),
    manifest: written.descriptor.hypercoreManifest,
    writable: false,
  })
  await receiverCore.ready()
  const workerAddress = workerSwarm.dht.io.serverSocket.address()
  workerRuntime = createScopedNetworkRuntime({
    swarm: workerSwarm,
    store: workerStore,
    bootstrapEnabled: false,
    initialNetworkPolicy: participationPolicy(),
  })
  requesterRuntime = createScopedNetworkRuntime({
    swarm: requesterSwarm,
    store: requesterStore,
    bootstrapEnabled: false,
    peerAddresses: [{
      publicKey: id(workerSwarm.keyPair),
      host: '127.0.0.1',
      port: workerAddress.port,
    }],
    initialNetworkPolicy: participationPolicy(),
  })
  await Promise.all([workerRuntime.start(), requesterRuntime.start()])

  const workerCoreState = written.core.core
  let workerPeerAdds = 0
  let uploads = 0
  written.core.on('peer-add', () => { workerPeerAdds++ })
  written.core.on('upload', () => { uploads++ })
  const baselineSessions = workerCoreState.sessionStates.length
  const baselineMonitors = workerCoreState.monitors.length
  const current = Date.now()
  const manager = {
    async onRequest () {},
    async onOffer () {},
    async onAssignment () {},
    async onProgress () {},
    async onResult () {},
    async onCancellation () {},
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const assignmentId = hex(0x70 + attempt)
    const requestId = hex(0x72 + attempt)
    const worker = createAcquisitionNetwork({
      scopedNetwork: workerRuntime,
      keyPair: workerSwarm.keyPair,
      policy: { networkTerms: () => openPolicy() },
      manager,
      now: () => current,
    })
    workers.push(worker)
    await worker.start()
    await worker.restoreAssignment({
      assignmentId,
      peerId: id(requesterSwarm.keyPair),
      role: 'worker',
      requesterId: id(requesterSwarm.keyPair),
      acquirerId: id(workerSwarm.keyPair),
      budget: {
        maxSourceBytes: sourceBytes.byteLength,
        maxOutputBytes: sourceBytes.byteLength,
        maxNetworkBytes: sourceBytes.byteLength * 2,
        maxWallClockMs: 60_000,
      },
      requestId,
      offerId: hex(0x74 + attempt),
      publisherId: hex(0x76 + attempt),
      publicationIntentDigest: hex(0x78 + attempt),
      deadline: current + 20_000,
      resultHoldUntil: current + 60_000,
      policyEpoch: 1,
    })
    await requesterRuntime.retainAcquisitionAssignment({
      assignmentId,
      peerId: id(workerSwarm.keyPair),
      server: false,
      client: true,
    })
    requesterRuntime.retainAcquisitionCore({
      assignmentId,
      peerId: id(workerSwarm.keyPair),
      key: descriptor.key,
      core: receiverCore,
      coreRef: descriptor,
      serve: false,
    })
    const peerAdded = new Promise(resolve => written.core.once('peer-add', resolve))
    await worker.holdVerifiedAsset({
      assignmentId,
      asset: descriptor,
      availabilityUntil: current + 40_000,
      core: written.core,
    })
    await within(peerAdded, 5_000, 'the supplied writer did not attach to the acquisition stream')
    t.ok(workerCoreState.monitors.length > baselineMonitors,
      `hold ${attempt + 1} adds its attachment monitor`)

    await worker.close()
    t.is(written.core.closed, false, `release ${attempt + 1} preserves the supplied writer`)
    t.is(workerCoreState.sessionStates.length, baselineSessions,
      `release ${attempt + 1} returns the writer session count to baseline`)
    t.is(workerCoreState.monitors.length, baselineMonitors,
      `release ${attempt + 1} returns the writer monitor count to baseline`)
    t.is(requesterSwarm.connections.size, 1,
      `release ${attempt + 1} leaves the original Noise stream alive`)
    const peerAddsAfterRelease = workerPeerAdds
    const denied = await receiverCore.get(attempt, { timeout: 2_000 })
      .then(value => ({ value }), error => ({ error }))
    t.ok(denied.error, `release ${attempt + 1} removes the stale upload authorizer`)
    t.is(await receiverCore.has(attempt), false, `release ${attempt + 1} sends no block`)
    t.is(workerPeerAdds, peerAddsAfterRelease,
      `release ${attempt + 1} does not reopen the detached writer`)

    requesterRuntime.releaseAcquisitionCore({
      assignmentId,
      peerId: id(workerSwarm.keyPair),
      key: descriptor.key,
    })
    await requesterRuntime.releaseAcquisitionAssignment({ assignmentId })
  }
  t.is(uploads, 0, 'released supplied-core holds upload no blocks')
})
