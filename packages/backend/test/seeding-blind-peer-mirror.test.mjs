import test from 'node:test'
import assert from 'node:assert/strict'

import { SeedingManager } from '../src/seeding.js'

function makeFakeBlindPeering(mirrorKeys = ['aa'.repeat(32)]) {
  const added = []
  return {
    enabled: mirrorKeys.length >= 0,
    _mirrors: [...mirrorKeys],
    added,
    getActiveMirrorKeys() { return this._mirrors },
    addCore(core) { added.push(core); return true },
  }
}

function makeFakeStore() {
  const gets = []
  return {
    gets,
    get(key) {
      const core = { key, peers: [], on() {} }
      gets.push(core)
      return core
    },
  }
}

function makeMetaDb() {
  // Minimal Hyperbee-ish stub: get returns null, put is a noop.
  return { async get() { return null }, async put() {}, async del() {} }
}

test('pinned seed is delegated to blind peers; transient watched seed is not', async () => {
  const blindPeering = makeFakeBlindPeering()
  const store = makeFakeStore()
  const mgr = new SeedingManager(store, makeMetaDb(), { blindPeering })

  // pinned -> mirrored (blob + thumbnail cores)
  assert.equal(
    mgr.mirrorSeedToBlindPeers({ reason: 'pinned', blobsCoreKey: 'ab'.repeat(32), thumbnailBlobsCoreKey: 'cd'.repeat(32) }),
    true
  )
  assert.equal(blindPeering.added.length, 2)

  // watched -> skipped
  assert.equal(
    mgr.mirrorSeedToBlindPeers({ reason: 'watched', blobsCoreKey: 'ef'.repeat(32) }),
    false
  )
  assert.equal(blindPeering.added.length, 2)
})

test('mirroring is idempotent per blobsCoreKey', async () => {
  const blindPeering = makeFakeBlindPeering()
  const store = makeFakeStore()
  const mgr = new SeedingManager(store, makeMetaDb(), { blindPeering })

  const seed = { reason: 'subscribed', blobsCoreKey: 'ab'.repeat(32) }
  assert.equal(mgr.mirrorSeedToBlindPeers(seed), true)
  assert.equal(mgr.mirrorSeedToBlindPeers(seed), false) // already mirrored
  assert.equal(blindPeering.added.length, 1)
  assert.equal(store.gets.length, 1)
})

test('no mirrors yet => no delegation, and remirrorAllSeeds picks it up later', async () => {
  const blindPeering = makeFakeBlindPeering([]) // no mirrors initially
  const store = makeFakeStore()
  const mgr = new SeedingManager(store, makeMetaDb(), { blindPeering })

  mgr.activeSeeds.set('d:v', { reason: 'pinned', blobsCoreKey: 'ab'.repeat(32) })

  // No mirrors -> nothing delegated, and the core was NOT opened (so it isn't
  // wrongly marked as mirrored).
  assert.equal(mgr.mirrorSeedToBlindPeers(mgr.activeSeeds.get('d:v')), false)
  assert.equal(store.gets.length, 0)

  // Mirror discovered later -> remirror sweep delegates it.
  blindPeering._mirrors.push('aa'.repeat(32))
  assert.equal(mgr.remirrorAllSeeds(), 1)
  assert.equal(blindPeering.added.length, 1)
})

test('no blindPeering client => mirror is a silent no-op', async () => {
  const store = makeFakeStore()
  const mgr = new SeedingManager(store, makeMetaDb(), {})
  assert.equal(mgr.mirrorSeedToBlindPeers({ reason: 'pinned', blobsCoreKey: 'ab'.repeat(32) }), false)
  assert.equal(store.gets.length, 0)
})
