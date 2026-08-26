import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ASSET_BLOCK_SIZE, createStaticAssetManifest, writeStaticAsset } from '../src/assets/static-core.js'
import { createAssetSession } from '../src/assets/asset-session.js'
import { createMultiPeerScheduler } from '../src/playback/multi-peer-scheduler.js'

function tempStore(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { directory, store: new Corestore(directory) }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function inventory(assetId, indexes) {
  if (indexes.length === 0) return { assetId, ranges: [], nextCursor: null }
  const startBlock = Math.min(...indexes)
  const endBlock = Math.max(...indexes) + 1
  const presentBitfield = b4a.alloc(Math.ceil((endBlock - startBlock) / 8))
  for (const index of indexes) {
    const bit = index - startBlock
    presentBitfield[bit >> 3] |= 1 << (bit & 7)
  }
  return { assetId, ranges: [{ startBlock, bitCount: endBlock - startBlock, presentBitfield }], nextCursor: null }
}

async function proofFixture(t, blockCount = 2) {
  const source = tempStore('peartube-playback-source-')
  const reader = tempStore('peartube-playback-reader-')
  await source.store.ready()
  await reader.store.ready()
  const sourceBytes = b4a.alloc(blockCount * ASSET_BLOCK_SIZE)
  for (let index = 0; index < blockCount; index++) sourceBytes.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  const asset = await writeStaticAsset({ store: source.store, source: [sourceBytes] })
  const session = createAssetSession({ coreRef: asset.descriptor, store: reader.store })
  await session.ready()

  async function applyBlock(index, { corrupt = false } = {}) {
    const proof = await asset.core.proof({ block: { index, nodes: 0 }, upgrade: { start: 0, length: asset.descriptor.length } })
    const value = b4a.from(proof.block.value)
    if (corrupt) value[0] ^= 0xff
    await session.verifyBlock({ index, proof: { ...proof, block: { ...proof.block, value: null } }, value })
  }

  t.teardown(async () => {
    await session.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await source.store.close().catch(() => {})
    await reader.store.close().catch(() => {})
    fs.rmSync(source.directory, { recursive: true, force: true })
    fs.rmSync(reader.directory, { recursive: true, force: true })
  })
  return { asset, session, sourceBytes, applyBlock }
}

function verifiedTransport({ assetId, session, ownership, applyBlock, onRequest = null }) {
  const calls = []
  return {
    calls,
    getActiveAssetPeerIds() { return [...ownership.keys()].sort() },
    listPeerAssetRanges({ peerId }) { return inventory(assetId, ownership.get(peerId) || []) },
    hasVerifiedAssetBlock({ blockIndex }) { return session.hasVerifiedBlock(blockIndex) },
    readVerifiedAssetBlock({ blockIndex }) { return session.readVerifiedBlock(blockIndex) },
    async requestAssetBlocks(request) {
      calls.push({ ...request, peerIds: [...request.peerIds] })
      if (onRequest) return onRequest(request, { applyBlock, calls })
      const peerId = request.peerIds[0]
      const owned = new Set(ownership.get(peerId) || [])
      for (let index = request.startBlock; index < request.endBlock; index++) {
        if (!owned.has(index)) {
          const error = new Error('selected peer disconnected')
          error.code = 'PEER_DISCONNECTED'
          error.peerId = peerId
          throw error
        }
        await applyBlock(index)
      }
      return {
        verifiedBlockIndexes: Array.from({ length: request.endBlock - request.startBlock }, (_, offset) => request.startBlock + offset),
        peerIds: [peerId],
      }
    },
  }
}

test('scheduler maps half-open bytes to verified blocks and trims a complete local hit exactly', async (t) => {
  const fixture = await proofFixture(t, 2)
  await fixture.applyBlock(0)
  await fixture.applyBlock(1)
  let inventoryCalls = 0
  const transport = verifiedTransport({ assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership: new Map(), applyBlock: fixture.applyBlock })
  transport.getActiveAssetPeerIds = () => { inventoryCalls++; return ['unused'] }
  transport.listPeerAssetRanges = () => { t.fail('local hit must not query inventory') }
  transport.requestAssetBlocks = () => { t.fail('local hit must not request peers') }
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 17, byteEnd: ASSET_BLOCK_SIZE + 31, deadlineMs: 1000 })
  t.is(result.status, 'ok')
  t.is(result.verified, true)
  t.alike(result.peerIds, [])
  t.alike(result.bytes, fixture.sourceBytes.subarray(17, ASSET_BLOCK_SIZE + 31))
  t.is(inventoryCalls, 0)
})

test('scheduler verifies and joins disjoint peer runs into exact requested bytes', async (t) => {
  const fixture = await proofFixture(t, 2)
  const ownership = new Map([['peer-a', [0]], ['peer-b', [1]]])
  const transport = verifiedTransport({ assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership, applyBlock: fixture.applyBlock })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 524288, deadlineMs: 5000 })
  t.is(result.status, 'ok')
  t.is(result.verified, true)
  t.alike(result.peerIds, ['peer-a', 'peer-b'])
  t.alike(result.bytes, fixture.sourceBytes.subarray(0, 524288))
  t.alike(transport.calls.map(call => [call.startBlock, call.endBlock, call.peerIds]), [[0, 1, ['peer-a']], [1, 2, ['peer-b']]])
})

test('scheduler reserves before dispatch and deterministically spreads equally scored runs', async (t) => {
  const fixture = await proofFixture(t, 4)
  const ownership = new Map([['peer-a', [0, 1, 2, 3]], ['peer-b', [0, 1, 2, 3]]])
  const gates = [deferred(), deferred()]
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership, applyBlock: fixture.applyBlock,
    async onRequest(request, { applyBlock, calls }) {
      await gates[Math.min(calls.length - 1, 1)].promise
      for (let index = request.startBlock; index < request.endBlock; index++) await applyBlock(index)
      return { verifiedBlockIndexes: Array.from({ length: request.endBlock - request.startBlock }, (_, offset) => request.startBlock + offset), peerIds: request.peerIds }
    },
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const request = scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 4 * ASSET_BLOCK_SIZE, deadlineMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.alike(transport.calls.slice(0, 2).map(call => call.peerIds[0]), ['peer-a', 'peer-b'])
  gates[0].resolve(); gates[1].resolve()
  await request
})

test('playhead sends exactly one delayed hedge to a different peer and aborts the loser', async (t) => {
  const fixture = await proofFixture(t, 1)
  const ownership = new Map([['peer-a', [0]], ['peer-b', [0]]])
  const primary = deferred()
  let primaryAborted = 0
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership, applyBlock: fixture.applyBlock,
    async onRequest(request, { applyBlock }) {
      if (request.peerIds[0] === 'peer-a') {
        request.signal.addEventListener('abort', () => {
          primaryAborted++
          primary.reject(request.signal.reason)
        }, { once: true })
        return primary.promise
      }
      await applyBlock(0)
      return { verifiedBlockIndexes: [0], peerIds: ['peer-b'] }
    },
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 90 })
  t.is(result.status, 'ok')
  t.alike(transport.calls.map(call => call.peerIds), [['peer-a'], ['peer-b']])
  t.is(primaryAborted, 1)
})

test('invalid proof is classified, cooled down, and retried from another verified peer', async (t) => {
  const fixture = await proofFixture(t, 1)
  const ownership = new Map([['peer-a', [0]], ['peer-b', [0]]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership, applyBlock: fixture.applyBlock,
    async onRequest(request, { applyBlock }) {
      const peerId = request.peerIds[0]
      if (peerId === 'peer-a') {
        try { await applyBlock(0, { corrupt: true }) } catch (cause) {
          const error = new Error('peer supplied an invalid proof', { cause }); error.code = 'INVALID_PROOF'; error.peerId = peerId; throw error
        }
      }
      await applyBlock(0)
      return { verifiedBlockIndexes: [0], peerIds: [peerId] }
    },
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 1000 })
  t.is(result.status, 'ok')
  t.alike(result.peerIds, ['peer-b'])
  const peerA = scheduler.metrics().peers.find(peer => peer.peerId === 'peer-a')
  t.is(peerA.invalidProofFailures, 1)
  t.ok(peerA.cooldownUntil > 0)
})

test('peer disconnect retries another owner and never reports an origin attempt', async (t) => {
  const fixture = await proofFixture(t, 1)
  const ownership = new Map([['peer-a', [0]], ['peer-b', [0]]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership, applyBlock: fixture.applyBlock,
    async onRequest(request, { applyBlock }) {
      const peerId = request.peerIds[0]
      if (peerId === 'peer-a') { const error = new Error('selected peer disconnected'); error.code = 'PEER_DISCONNECTED'; error.peerId = peerId; throw error }
      await applyBlock(0)
      return { verifiedBlockIndexes: [0], peerIds: [peerId] }
    },
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const result = await scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 1000 })
  t.is(result.status, 'ok')
  t.alike(result.peerIds, ['peer-b'])
  t.is(result.originAttempted, false)
})

test('scheduler returns bounded no-source, budget, and deadline results and throws caller AbortError', async (t) => {
  const fixture = await proofFixture(t, 1)
  const empty = verifiedTransport({ assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership: new Map(), applyBlock: fixture.applyBlock })
  const noSource = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport: empty })
  t.alike(await noSource.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: 1, deadlineMs: 100 }), { status: 'unavailable', errorCode: 'NO_VERIFIED_SOURCE', originAttempted: false })
  const budget = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport: empty, maxInFlightBytes: ASSET_BLOCK_SIZE - 1 })
  t.alike(await budget.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 100 }), { status: 'unavailable', errorCode: 'BUDGET_EXHAUSTED', originAttempted: false })

  const hanging = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership: new Map([['peer-a', [0]]]), applyBlock: fixture.applyBlock,
    onRequest(request) { return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })) },
  })
  const deadline = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport: hanging })
  const expiredOutcome = await deadline.requestRange({
    assetId: fixture.asset.descriptor.assetId,
    byteStart: 0,
    byteEnd: ASSET_BLOCK_SIZE,
    deadlineMs: 10,
  }).then(value => ({ value }), error => ({ error }))
  t.absent(expiredOutcome.error, 'playhead deadline must not enter stale-prefetch AbortError handling')
  t.is(expiredOutcome.value.status, 'unavailable')
  t.is(expiredOutcome.value.errorCode, 'DEADLINE_EXCEEDED')
  t.is(expiredOutcome.value.originAttempted, false)
  const controller = new AbortController()
  const aborted = deadline.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 1000, signal: controller.signal })
  const observedAbort = aborted.then(() => null, error => error)
  controller.abort()
  t.is((await observedAbort)?.name, 'AbortError')
})

test('seek cancels only obsolete prefetch and leaves an exact playhead request active', async (t) => {
  const fixture = await proofFixture(t, 2)
  const pending = new Map()
  let playheadAborted = 0
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId, session: fixture.session, ownership: new Map([['peer-a', [0, 1]]]), applyBlock: fixture.applyBlock,
    onRequest(request) {
      const gate = deferred()
      request.signal.addEventListener('abort', () => { if (request.startBlock === 1) playheadAborted++; gate.reject(request.signal.reason) }, { once: true })
      pending.set(request.startBlock, gate)
      return gate.promise
    },
  })
  const scheduler = createMultiPeerScheduler({ coreRef: fixture.asset.descriptor, session: fixture.session, transport })
  const prefetch = scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: 0, byteEnd: ASSET_BLOCK_SIZE, deadlineMs: 1000, priority: 'prefetch', materialize: false })
  const playhead = scheduler.requestRange({ assetId: fixture.asset.descriptor.assetId, byteStart: ASSET_BLOCK_SIZE, byteEnd: ASSET_BLOCK_SIZE * 2, deadlineMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const observedPrefetchAbort = prefetch.then(() => null, error => error)
  scheduler.seek({ byteStart: ASSET_BLOCK_SIZE })
  t.is((await observedPrefetchAbort)?.name, 'AbortError')
  t.is(playheadAborted, 0)
  await fixture.applyBlock(1)
  pending.get(1).resolve({ verifiedBlockIndexes: [1], peerIds: ['peer-a'] })
  t.is((await playhead).status, 'ok')

  await fixture.session.core.clear(1, 2)
  const backwardPrefetch = scheduler.requestRange({
    assetId: fixture.asset.descriptor.assetId,
    byteStart: ASSET_BLOCK_SIZE,
    byteEnd: ASSET_BLOCK_SIZE * 2,
    deadlineMs: 1000,
    priority: 'prefetch',
    materialize: false,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const observedBackwardAbort = backwardPrefetch.then(() => null, error => error)
  scheduler.seek({ byteStart: 0 })
  t.is((await observedBackwardAbort)?.name, 'AbortError')
})

test('scheduler rejects asset identity mismatch before inventory or allocation', async (t) => {
  const fixture = await proofFixture(t, 1)
  let touched = 0
  const scheduler = createMultiPeerScheduler({
    coreRef: fixture.asset.descriptor, session: fixture.session,
    transport: {
      hasVerifiedAssetBlock() { touched++; return false }, readVerifiedAssetBlock() { touched++ },
      getActiveAssetPeerIds() { touched++; return [] }, listPeerAssetRanges() { touched++ }, requestAssetBlocks() { touched++ },
    },
  })
  await t.exception(scheduler.requestRange({ assetId: 'ff'.repeat(32), byteStart: 0, byteEnd: 1, deadlineMs: 100 }), /assetId|identity/)
  t.is(touched, 0)
  t.is(scheduler.metrics().inFlightBytes, 0)
})

test('partial peer failure replans only the still-missing verified suffix', async (t) => {
  const fixture = await proofFixture(t, 2)
  const calls = []
  let firstAttempt = true
  const transport = {
    getActiveAssetPeerIds() { return firstAttempt ? ['peer-a'] : ['peer-b'] },
    listPeerAssetRanges({ peerId }) {
      return inventory(fixture.asset.descriptor.assetId, peerId === 'peer-a' ? [0, 1] : [1])
    },
    hasVerifiedAssetBlock({ blockIndex }) { return fixture.session.hasVerifiedBlock(blockIndex) },
    readVerifiedAssetBlock({ blockIndex }) { return fixture.session.readVerifiedBlock(blockIndex) },
    async requestAssetBlocks(request) {
      calls.push([request.startBlock, request.endBlock, request.peerIds])
      if (request.peerIds[0] === 'peer-a') {
        await fixture.applyBlock(0)
        firstAttempt = false
        const error = new Error('peer a disconnected after its verified prefix')
        error.code = 'DISCONNECTED'
        error.peerId = 'peer-a'
        throw error
      }
      t.is(request.startBlock, 1)
      await fixture.applyBlock(1)
      return { verifiedBlockIndexes: [1], peerIds: ['peer-b'] }
    },
  }
  const scheduler = createMultiPeerScheduler({
    coreRef: fixture.asset.descriptor,
    session: fixture.session,
    transport,
  })

  const result = await scheduler.requestRange({
    assetId: fixture.asset.descriptor.assetId,
    byteStart: 0,
    byteEnd: ASSET_BLOCK_SIZE * 2,
    deadlineMs: 1000,
  })

  t.is(result.status, 'ok')
  t.alike(result.bytes, fixture.sourceBytes)
  t.alike(result.peerIds, ['peer-a', 'peer-b'])
  t.alike(calls, [
    [0, 2, ['peer-a']],
    [1, 2, ['peer-b']],
  ])
  t.is(scheduler.metrics().inFlightBytes, 0)
})

test('definitive sibling failure aborts hanging runs and preserves its terminal code', async (t) => {
  const fixture = await proofFixture(t, 2)
  let hangingAborted = 0
  const ownership = new Map([['peer-a', [0]], ['peer-b', [1]]])
  const transport = verifiedTransport({
    assetId: fixture.asset.descriptor.assetId,
    session: fixture.session,
    ownership,
    applyBlock: fixture.applyBlock,
    async onRequest(request) {
      if (request.peerIds[0] === 'peer-a') {
        request.signal.addEventListener('abort', () => { hangingAborted++ }, { once: true })
        return new Promise(() => {})
      }
      const error = new Error('peer b has no verified source')
      error.code = 'UNAVAILABLE'
      error.peerId = 'peer-b'
      throw error
    },
  })
  const scheduler = createMultiPeerScheduler({
    coreRef: fixture.asset.descriptor,
    session: fixture.session,
    transport,
  })

  const outcome = await Promise.race([
    scheduler.requestRange({
      assetId: fixture.asset.descriptor.assetId,
      byteStart: 0,
      byteEnd: ASSET_BLOCK_SIZE * 2,
      deadlineMs: 1000,
      materialize: false,
    }),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 50)),
  ])

  t.is(outcome.timedOut, undefined)
  t.is(outcome.status, 'unavailable')
  t.is(outcome.errorCode, 'NO_VERIFIED_SOURCE')
  t.is(hangingAborted, 1)
  t.is(scheduler.metrics().inFlightBytes, 0)
})

test('inactive zero-load peer history is pruned before admitting new active owners', async (t) => {
  const fixture = await proofFixture(t, 1)
  let activePeerId = null
  let verified = false
  const transport = {
    getActiveAssetPeerIds() { return [activePeerId] },
    listPeerAssetRanges() { return inventory(fixture.asset.descriptor.assetId, [0]) },
    async hasVerifiedAssetBlock() { return verified },
    async readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks(request) {
      verified = true
      return { verifiedBlockIndexes: [0], peerIds: request.peerIds }
    },
  }
  const scheduler = createMultiPeerScheduler({
    coreRef: fixture.asset.descriptor,
    session: fixture.session,
    transport,
  })

  for (let index = 0; index < 70; index++) {
    activePeerId = `peer-${String(index).padStart(3, '0')}`
    verified = false
    const result = await scheduler.requestRange({
      assetId: fixture.asset.descriptor.assetId,
      byteStart: 0,
      byteEnd: ASSET_BLOCK_SIZE,
      deadlineMs: 1000,
      materialize: false,
    })
    t.is(result.status, 'ok')
    t.ok(scheduler.metrics().peers.length <= 64)
  }
  t.ok(scheduler.metrics().peers.some(peer => peer.peerId === activePeerId))
})

test('scheduler rejects a session whose full normalized core identity mismatches before transport', async (t) => {
  const fixture = await proofFixture(t, 2)
  let touched = 0
  const mismatchedSession = {
    ...fixture.session,
    assetId: fixture.asset.descriptor.assetId,
    coreRef: {
      ...fixture.session.coreRef,
      assetId: fixture.asset.descriptor.assetId,
      byteLength: fixture.asset.descriptor.byteLength - 1,
    },
  }
  t.exception(() => createMultiPeerScheduler({
    coreRef: fixture.asset.descriptor,
    session: mismatchedSession,
    transport: {
      getActiveAssetPeerIds() { touched++; return [] },
      listPeerAssetRanges() { touched++; return { ranges: [], nextCursor: null } },
      hasVerifiedAssetBlock() { touched++; return false },
      readVerifiedAssetBlock() { touched++; return null },
      requestAssetBlocks() { touched++; return null },
    },
  }), /session identity/)
  t.is(touched, 0)
})

test('scheduler caps alternating and concurrent transport runs globally at sixteen', async (t) => {
  const coreRef = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 91),
    blockLength: 64,
    byteLength: 64 * ASSET_BLOCK_SIZE,
  })
  const session = { assetId: coreRef.assetId, coreRef }
  const verified = new Set()
  let active = 0
  let maxActive = 0
  let resolveSaturated
  let releaseRuns
  const saturated = new Promise(resolve => { resolveSaturated = resolve })
  const gate = new Promise(resolve => { releaseRuns = resolve })
  const calls = []
  const transport = {
    getActiveAssetPeerIds() { return ['peer-a', 'peer-b'] },
    listPeerAssetRanges() {
      return inventory(coreRef.assetId, Array.from({ length: coreRef.length }, (_, index) => index))
    },
    hasVerifiedAssetBlock({ blockIndex }) { return verified.has(blockIndex) },
    readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks(request) {
      calls.push(request)
      active++
      maxActive = Math.max(maxActive, active)
      if (active === 16) resolveSaturated()
      try {
        await gate
        for (let index = request.startBlock; index < request.endBlock; index++) verified.add(index)
        return {
          verifiedBlockIndexes: Array.from(
            { length: request.endBlock - request.startBlock },
            (_, offset) => request.startBlock + offset,
          ),
          peerIds: request.peerIds,
        }
      } finally {
        active--
      }
    },
  }
  const scheduler = createMultiPeerScheduler({ coreRef, session, transport })
  const first = scheduler.requestRange({
    assetId: coreRef.assetId,
    byteStart: 0,
    priority: 'prefetch',
    byteEnd: 32 * ASSET_BLOCK_SIZE,
    deadlineMs: 1000,
    materialize: false,
  })
  const second = scheduler.requestRange({
    assetId: coreRef.assetId,
    byteStart: 32 * ASSET_BLOCK_SIZE,
    priority: 'prefetch',
    byteEnd: 64 * ASSET_BLOCK_SIZE,
    deadlineMs: 1000,
    materialize: false,
  })

  await saturated
  t.is(maxActive, 16)
  t.is(scheduler.metrics().activeTransportRuns, 16)
  t.ok(scheduler.metrics().waitingTransportRuns > 0)
  releaseRuns()
  const outcomes = await Promise.all([first, second])

  t.alike(outcomes.map(outcome => outcome.status), ['ok', 'ok'])
  t.is(calls.length, 64, 'alternating owners form sixty-four one-block runs')
  t.ok(calls.every(call => call.endBlock - call.startBlock === 1))
  t.ok(maxActive <= 16)
  t.is(scheduler.metrics().activeTransportRuns, 0)
  t.is(scheduler.metrics().waitingTransportRuns, 0)
})

test('terminal run aborts active and FIFO-waiting slots without changing its stable code', async (t) => {
  const coreRef = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 92),
    blockLength: 32,
    byteLength: 32 * ASSET_BLOCK_SIZE,
  })
  const session = { assetId: coreRef.assetId, coreRef }
  let maxActive = 0
  let active = 0
  let aborted = 0
  const transport = {
    getActiveAssetPeerIds() { return ['peer-a', 'peer-b'] },
    listPeerAssetRanges() {
      return inventory(coreRef.assetId, Array.from({ length: coreRef.length }, (_, index) => index))
    },
    hasVerifiedAssetBlock() { return false },
    readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks(request) {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (request.startBlock === 0) {
          const error = new Error('definitive missing source')
          error.code = 'UNAVAILABLE'
          error.peerId = request.peerIds[0]
          throw error
        }
        return await new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted++
            const error = new Error('run cancelled')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      } finally {
        active--
      }
    },
  }
  const scheduler = createMultiPeerScheduler({ coreRef, session, transport })

  const outcome = await scheduler.requestRange({
    assetId: coreRef.assetId,
    byteStart: 0,
    priority: 'prefetch',
    byteEnd: coreRef.byteLength,
    deadlineMs: 1000,
    materialize: false,
  })

  t.is(outcome.status, 'unavailable')
  t.is(outcome.errorCode, 'NO_VERIFIED_SOURCE')
  t.ok(maxActive <= 16)
  t.ok(aborted > 0)
  t.is(active, 0)
  t.is(scheduler.metrics().activeTransportRuns, 0)
  t.is(scheduler.metrics().waitingTransportRuns, 0)
  t.is(scheduler.metrics().inFlightBytes, 0)
})

test('aborted transports keep global slots until late settlement', async (t) => {
  const coreRef = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 93),
    blockLength: 32,
    byteLength: 32 * ASSET_BLOCK_SIZE,
  })
  const session = { assetId: coreRef.assetId, coreRef }
  const lateAbort = deferred()
  const successful = deferred()
  const queuedRunsStarted = deferred()
  const verified = new Set()
  let phase = 'terminal'
  let physicalActive = 0
  let maxPhysicalActive = 0
  let newRuns = 0
  const successfulRanges = []
  const transport = {
    getActiveAssetPeerIds() { return ['peer-a', 'peer-b'] },
    listPeerAssetRanges() {
      return inventory(coreRef.assetId, Array.from({ length: coreRef.length }, (_, index) => index))
    },
    hasVerifiedAssetBlock({ blockIndex }) { return verified.has(blockIndex) },
    readVerifiedAssetBlock() { throw new Error('not materialized') },
    async requestAssetBlocks(request) {
      const requestPhase = phase
      physicalActive++
      maxPhysicalActive = Math.max(maxPhysicalActive, physicalActive)
      try {
        if (requestPhase === 'terminal' && request.startBlock === 0) {
          const error = new Error('definitive missing source')
          error.code = 'UNAVAILABLE'
          error.peerId = request.peerIds[0]
          throw error
        }
        if (requestPhase === 'terminal') {
          await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
          await lateAbort.promise
          const error = new Error('late cancelled transport')
          error.name = 'AbortError'
          throw error
        }
        newRuns++
        successfulRanges.push([request.startBlock, request.endBlock])
        if (newRuns === 1) queuedRunsStarted.resolve()
        await successful.promise
        for (let index = request.startBlock; index < request.endBlock; index++) verified.add(index)
        return {
          verifiedBlockIndexes: Array.from(
            { length: request.endBlock - request.startBlock },
            (_, offset) => request.startBlock + offset,
          ),
          peerIds: request.peerIds,
        }
      } finally {
        physicalActive--
      }
    },
  }
  const scheduler = createMultiPeerScheduler({ coreRef, session, transport })
  const terminal = await scheduler.requestRange({
    assetId: coreRef.assetId,
    byteStart: 0,
    byteEnd: coreRef.byteLength,
    priority: 'prefetch',
    deadlineMs: 1000,
    materialize: false,
  })

  t.is(terminal.errorCode, 'NO_VERIFIED_SOURCE')
  t.is(scheduler.metrics().activeTransportRuns, 16)
  phase = 'success'
  const next = scheduler.requestRange({
    assetId: coreRef.assetId,
    byteStart: 16 * ASSET_BLOCK_SIZE,
    byteEnd: 18 * ASSET_BLOCK_SIZE,
    priority: 'prefetch',
    deadlineMs: 1000,
    materialize: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  t.is(physicalActive, 16)
  t.is(newRuns, 0)
  t.ok(scheduler.metrics().waitingTransportRuns > 0)
  lateAbort.resolve()
  await queuedRunsStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  const coveredBlocks = successfulRanges
    .flatMap(([start, end]) => Array.from({ length: end - start }, (_, offset) => start + offset))
    .sort((left, right) => left - right)
  t.alike(coveredBlocks, [16, 17])
  t.is(physicalActive, newRuns)
  t.is(scheduler.metrics().activeTransportRuns, newRuns)
  t.is(scheduler.metrics().waitingTransportRuns, 0)
  successful.resolve()
  const outcome = await next

  t.is(outcome.status, 'ok')
  t.ok(maxPhysicalActive <= 16)
  t.is(physicalActive, 0)
  t.is(scheduler.metrics().activeTransportRuns, 0)
  t.is(scheduler.metrics().waitingTransportRuns, 0)
})
