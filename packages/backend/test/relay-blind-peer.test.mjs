import test from 'node:test'
import assert from 'node:assert/strict'
import b4a from 'b4a'

import { createRelayBlindPeer } from '../src/relay-blind-peer.js'

function createCtx() {
  return {
    store: {},
    wakeup: {},
    swarm: {
      keyPair: { publicKey: b4a.alloc(32, 9) },
      _peartubeOffline: false,
    }
  }
}

test('createRelayBlindPeer starts a native blind peer on the relay swarm/store', async (t) => {
  const calls = []
  class FakeBlindPeer {
    constructor(path, opts) {
      calls.push({ path, opts })
      this.publicKey = b4a.alloc(32, 7)
      this.readyCalls = 0
      this.listenCalls = 0
      this.closeCalls = 0
    }
    async ready() { this.readyCalls++ }
    async listen() { this.listenCalls++ }
    async close() { this.closeCalls++ }
    _announceCore() { return Promise.resolve() }
  }
  const ctx = createCtx()
  const relay = await createRelayBlindPeer({
    ctx,
    storagePath: '/tmp/relay',
    trustedPeerKeys: ['aa'.repeat(32)],
    BlindPeerCtor: FakeBlindPeer,
    logger: { info() {}, warn() {} },
  })

  assert.equal(relay.enabled, true)
  assert.equal(relay.publicKey, '07'.repeat(32))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/tmp/relay/corestore/blind-peer')
  assert.equal(calls[0].opts.store, ctx.store)
  assert.equal(calls[0].opts.swarm, ctx.swarm)
  assert.equal(calls[0].opts.wakeup, ctx.wakeup)
  assert.deepEqual(calls[0].opts.trustedPubKeys, ['aa'.repeat(32)])
  assert.equal(calls[0].opts.enableGc, false)
})

test('relay blind peer is disabled when P2P swarm is offline', async (t) => {
  const ctx = createCtx()
  ctx.swarm._peartubeOffline = true
  ctx.swarm._peartubeOfflineReason = 'module-unavailable'

  const relay = await createRelayBlindPeer({ ctx, storagePath: '/tmp/relay' })

  assert.equal(relay.enabled, false)
  assert.equal(relay.getStats().error, 'module-unavailable')
})

test('relay blind peer tracks announced mirrored cores', async (t) => {
  const announced = []
  class FakeBlindPeer {
    constructor() { this.publicKey = b4a.alloc(32, 3) }
    async ready() {}
    async listen() {}
    _announceCore(key) { announced.push(b4a.toString(key, 'hex')); return Promise.resolve() }
  }
  const ctx = createCtx()
  const relay = await createRelayBlindPeer({ ctx, storagePath: '/tmp/relay', BlindPeerCtor: FakeBlindPeer })
  const core = {
    key: b4a.alloc(32, 4),
    downloadCalls: [],
    download(range) { this.downloadCalls.push(range) }
  }

  assert.equal(relay.addCore(core, { announce: true }), true)
  assert.deepEqual(announced, ['04'.repeat(32)])
  assert.deepEqual(core.downloadCalls, [{ start: 0, end: -1 }])
  assert.equal(relay.getStats().mirroredCores, 1)
})
