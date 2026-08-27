import test from 'brittle'
import b4a from 'b4a'

import { createVerifiedBlockEngine } from '../src/network/verified-block-engine.js'

function sourceFixture(overrides = {}) {
  return {
    resourceId: 'resource-a',
    coreRef: { length: 2, byteLength: 6, blockSize: 3 },
    manifest: null,
    async has() { return true },
    async proof(index) {
      return { block: { index, value: b4a.from('abc') }, upgrade: { start: 0, length: 2 } }
    },
    async apply() {},
    ...overrides,
  }
}

test('verified block engine assembles contiguous proof and block chunks for one exact resource range', async (t) => {
  let applied = null
  const engine = createVerifiedBlockEngine()
  const source = sourceFixture({ async apply(input) { applied = input } })
  const handle = engine.attach({ source, allowedRange: { start: 0, end: 2 } })
  const transfer = engine.createTransfer({
    handle,
    resourceId: source.resourceId,
    start: 0,
    end: 1,
    index: 0,
    peerId: 'peer-a',
    transferId: 1n,
  })

  t.is(engine.receiveProofPart({
    handle,
    transfer,
    part: { resourceId: source.resourceId, start: 0, end: 1, index: 0, offset: 0, totalBytes: 4, chunk: b4a.from('pr') },
  }).status, 'accepted')
  t.is(engine.receiveProofPart({
    handle,
    transfer,
    part: { resourceId: source.resourceId, start: 0, end: 1, index: 0, offset: 2, totalBytes: 4, chunk: b4a.from('of') },
  }).status, 'complete')
  t.is(engine.receiveBlockPart({
    handle,
    transfer,
    part: { resourceId: source.resourceId, start: 0, end: 1, index: 0, offset: 0, totalBytes: 3, chunk: b4a.from('abc') },
  }).status, 'complete')
  t.alike(await engine.finish({ handle, transfer, proof: { block: { index: 0, value: null } } }), { status: 'complete', index: 0 })
  t.is(applied.peerId, 'peer-a')
  t.alike(applied.value, b4a.from('abc'))

  t.exception(() => engine.createTransfer({ handle, resourceId: 'resource-b', start: 0, end: 1, index: 0 }), /resource/)
  t.exception(() => engine.createTransfer({ handle, resourceId: source.resourceId, start: 1, end: 3, index: 1 }), /range/)
  await engine.close()
})

test('verified block engine settles timeout and cancel once and ignores late chunks', async (t) => {
  const timers = []
  const engine = createVerifiedBlockEngine({
    setTimeout(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer },
    clearTimeout(timer) { timer.cleared = true },
  })
  const source = sourceFixture()
  const handle = engine.attach({ source, allowedRange: { start: 0, end: 2 } })
  let timeouts = 0
  const timed = engine.createTransfer({
    handle, resourceId: source.resourceId, start: 0, end: 1, index: 0, timeoutMs: 10,
    onTimeout() { timeouts++ },
  })
  timers[0].fn()
  timers[0].fn()
  t.is(timeouts, 1)
  t.is(engine.receiveProofPart({ handle, transfer: timed, part: {} }).status, 'ignored')

  const controller = new AbortController()
  let cancellations = 0
  const cancelled = engine.createTransfer({
    handle, resourceId: source.resourceId, start: 0, end: 1, index: 0, signal: controller.signal,
    onCancel() { cancellations++ },
  })
  controller.abort()
  controller.abort()
  t.is(cancellations, 1)
  t.is(engine.receiveBlockPart({ handle, transfer: cancelled, part: {} }).status, 'ignored')
  await engine.close()
})

test('verified block engine quarantines an exact core after invalid proof application', async (t) => {
  const key = b4a.alloc(32, 7)
  let closed = 0
  let quarantined = 0
  const core = {
    key,
    length: 0,
    byteLength: 0,
    async ready() {},
    async applyProof() { return false },
    async close() { closed++ },
  }
  const engine = createVerifiedBlockEngine()
  const source = engine.createSource({
    resourceId: 'resource-a',
    coreRef: { length: 1, byteLength: 3, blockSize: 3 },
    descriptor: { key, hypercoreManifest: {} },
    core,
    onQuarantine() { quarantined++ },
  })
  await source.ready()
  await t.exception(source.apply({
    index: 0,
    proof: { block: { index: 0, value: null }, upgrade: { start: 0, length: 1 } },
    value: b4a.from('abc'),
  }), /verification/)
  t.is(closed, 1)
  t.is(quarantined, 1)
  t.ok(source.poisoned)
  await source.close()
  await engine.close()
})

test('verified block engine releases admission and stops sends across a policy epoch change', async (t) => {
  let policyEpoch = 1
  let committed = 0
  let released = 0
  let blockParts = 0
  const engine = createVerifiedBlockEngine()
  const source = sourceFixture()
  const handle = engine.attach({
    source,
    allowedRange: { start: 0, end: 2 },
    policyEpoch: () => policyEpoch,
  })
  const result = await engine.serve({
    handle,
    request: { resourceId: source.resourceId, start: 0, end: 1, index: 0 },
    encodeProof: () => b4a.from('proof'),
    reserve: async () => ({ commit() { committed++ }, release() { released++ } }),
    sendProofPart() { policyEpoch++; return true },
    sendBlockPart() { blockParts++; return true },
  })
  t.is(result.status, 'cancelled')
  t.is(committed, 0)
  t.is(released, 1)
  t.is(blockParts, 0)
  await engine.close()
})
