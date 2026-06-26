import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'

import { createBlindPeeringClient } from '../src/blind-peering-client.js'

// Fake hyperdht-address: tag the raw key so we can assert encode happened and
// recover the raw key from the "encoded" form.
function fakeEncode(key) {
  return b4a.concat([b4a.from('ADDR'), key])
}
function decodeFake(encoded) {
  return b4a.toString(encoded.subarray(4), 'hex')
}

function createCtx(overrides = {}) {
  return {
    store: {},
    wakeup: {},
    swarm: { dht: { on() {}, off() {} }, _peartubeOffline: false },
    ...overrides,
  }
}

function makeFakeBlindPeering() {
  const calls = { construct: [], addCore: [], addAutobase: [], setKeys: [], suspend: 0, resume: 0, close: 0 }
  class FakeBlindPeering {
    constructor(dht, store, opts) {
      calls.construct.push({ dht, store, opts })
      this.stats = { addCore: 0, addAutobase: 0 }
      this._keys = opts.keys
    }
    addCoreBackground(core, opts) { this.stats.addCore++; calls.addCore.push({ core, opts }) }
    addAutobaseBackground(base, opts) { this.stats.addAutobase++; calls.addAutobase.push({ base, opts }) }
    setKeys(keys) { this._keys = keys; calls.setKeys.push(keys) }
    async suspend() { calls.suspend++ }
    async resume() { calls.resume++ }
    async close() { calls.close++ }
  }
  return { FakeBlindPeering, calls }
}

test('encodes raw mirror keys via hyperdht-address before constructing BlindPeering', async () => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeering()
  const ctx = createCtx()
  const relayKey = 'aa'.repeat(32)

  const client = await createBlindPeeringClient({
    ctx,
    mirrorKeys: [relayKey],
    BlindPeeringCtor: FakeBlindPeering,
    encodeAddress: fakeEncode,
  })

  assert.equal(client.enabled, true)
  assert.equal(calls.construct.length, 1)
  const { dht, store, opts } = calls.construct[0]
  assert.equal(dht, ctx.swarm.dht)
  assert.equal(store, ctx.store)
  assert.equal(opts.wakeup, ctx.wakeup)
  // The single key passed to BlindPeering is the *encoded* form, and decodes
  // back to the raw relay key.
  assert.equal(opts.keys.length, 1)
  assert.equal(decodeFake(opts.keys[0]), relayKey)
  // The public API still reports the raw hex key.
  assert.deepEqual(client.getActiveMirrorKeys(), [relayKey])
})

test('addMirrorKeys dedups and re-keys the instance, returning newly added count', async () => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeering()
  const client = await createBlindPeeringClient({
    ctx: createCtx(),
    mirrorKeys: ['aa'.repeat(32)],
    BlindPeeringCtor: FakeBlindPeering,
    encodeAddress: fakeEncode,
  })

  // Re-adding a known key plus a new one => only 1 added.
  const added = client.addMirrorKeys(['AA'.repeat(32), 'bb'.repeat(32)])
  assert.equal(added, 1)
  assert.deepEqual(client.getActiveMirrorKeys().sort(), ['aa'.repeat(32), 'bb'.repeat(32)])
  assert.equal(calls.setKeys.length, 1)
  assert.deepEqual(calls.setKeys[0].map(decodeFake).sort(), ['aa'.repeat(32), 'bb'.repeat(32)])

  // No new keys => no setKeys call.
  assert.equal(client.addMirrorKeys('aa'.repeat(32)), 0)
  assert.equal(calls.setKeys.length, 1)
})

test('addCore/addAutobase delegate in the background with announce=true when mirrors exist', async () => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeering()
  const client = await createBlindPeeringClient({
    ctx: createCtx(),
    mirrorKeys: ['aa'.repeat(32)],
    BlindPeeringCtor: FakeBlindPeering,
    encodeAddress: fakeEncode,
  })

  const core = { key: b4a.alloc(32, 4) }
  const base = { key: b4a.alloc(32, 5) }
  assert.equal(client.addCore(core), true)
  assert.equal(client.addAutobase(base), true)
  assert.equal(calls.addCore.length, 1)
  assert.equal(calls.addCore[0].opts.announce, true)
  assert.equal(calls.addCore[0].core, core)
  assert.equal(calls.addAutobase.length, 1)
  assert.equal(calls.addAutobase[0].opts.announce, true)

  const stats = client.getStats()
  assert.equal(stats.mirrors, 1)
  assert.equal(stats.addCore, 1)
})

test('addCore is a no-op when there are no mirrors yet', async () => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeering()
  const client = await createBlindPeeringClient({
    ctx: createCtx(),
    mirrorKeys: [],
    BlindPeeringCtor: FakeBlindPeering,
    encodeAddress: fakeEncode,
  })
  assert.equal(client.addCore({ key: b4a.alloc(32, 4) }), false)
  assert.equal(calls.addCore.length, 0)
})

test('returns a disabled noop client when the swarm is offline', async () => {
  const ctx = createCtx()
  ctx.swarm._peartubeOffline = true
  ctx.swarm._peartubeOfflineReason = 'module-unavailable'

  const client = await createBlindPeeringClient({ ctx })
  assert.equal(client.enabled, false)
  assert.equal(client.getStats().error, 'module-unavailable')
  assert.equal(client.addCore({ key: b4a.alloc(32, 1) }), false)
  assert.deepEqual(client.getActiveMirrorKeys(), [])
})

test('returns a disabled noop client when there is no DHT', async () => {
  const client = await createBlindPeeringClient({ ctx: { store: {}, swarm: {} } })
  assert.equal(client.enabled, false)
})

test('suspend/resume/close forward to the instance', async () => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeering()
  const client = await createBlindPeeringClient({
    ctx: createCtx(),
    mirrorKeys: ['aa'.repeat(32)],
    BlindPeeringCtor: FakeBlindPeering,
    encodeAddress: fakeEncode,
  })
  await client.suspend()
  await client.resume()
  await client.close()
  assert.equal(calls.suspend, 1)
  assert.equal(calls.resume, 1)
  assert.equal(calls.close, 1)
})
