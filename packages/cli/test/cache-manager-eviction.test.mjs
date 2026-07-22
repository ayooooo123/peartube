import test from 'brittle'
import b4a from 'b4a'

import { CacheManager } from '../src/cache-manager.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const CORE_A = '1'.repeat(64)
const CORE_B = '2'.repeat(64)

function fakeStore () {
  const cleared = []
  const gc = { flush: 0, compact: 0 }
  return {
    cleared,
    gc,
    get (keyBuf) {
      const keyHex = b4a.toString(keyBuf, 'hex')
      return {
        async ready () {},
        async clear (start, end) { cleared.push({ keyHex, start, end }) },
        async close () {}
      }
    },
    storage: {
      async flush () { gc.flush += 1 },
      async compact () { gc.compact += 1 }
    }
  }
}

function fakeMetaDb () {
  const map = new Map()
  return {
    async get (key) { return map.has(key) ? { value: map.get(key) } : null },
    async put (key, value) { map.set(key, value) }
  }
}

function preview (coreKey, blockLength) {
  return { id: `v-${coreKey.slice(0, 4)}`, blobId: `0:${blockLength}:0:${blockLength * 1024}`, blobsCoreKey: coreKey }
}

test('enforceQuota clears discovery blob ranges and protects private uploads', async (t) => {
  const store = fakeStore()
  const cache = new CacheManager(store, fakeMetaDb(), 100)

  await cache.addChannel(KEY_A, 'pa'.repeat(32), 'discovered', { previewVideos: [preview(CORE_A, 5)] })
  await cache.addChannel(KEY_B, 'pb'.repeat(32), 'discovered', { previewVideos: [preview(CORE_B, 7)] })
  await cache.updateChannelSize(KEY_A, 200)
  await cache.updateChannelSize(KEY_B, 500)

  const evictedCalls = []
  const result = await cache.enforceQuota({
    // KEY_B is a deliberate upload; KEY_A is discovery cache.
    retentionClassOf: (driveKey) => (driveKey === KEY_B ? 'private' : 'discovery'),
    onEvicted: (driveKey) => { evictedCalls.push(driveKey) },
    collectGarbage: async () => { await store.storage.flush(); await store.storage.compact() }
  })

  t.alike(result.evicted, [KEY_A], 'only the discovery channel is evicted')
  t.is(result.clearedRanges, 1)
  t.is(result.freedBytes, 200)
  t.alike(store.cleared, [{ keyHex: CORE_A, start: 0, end: 5 }], 'the discovery blob range is cleared')
  t.alike(evictedCalls, [KEY_A])
  t.absent(cache.channels.has(KEY_A), 'evicted channel is dropped from tracking')
  t.ok(cache.channels.has(KEY_B), 'protected upload stays tracked')
  t.is(store.gc.compact, 1, 'corestore garbage is collected after eviction')
})

test('enforceQuota skips a channel with an active (protected) core and never overstates freed bytes', async (t) => {
  const store = fakeStore()
  const cache = new CacheManager(store, fakeMetaDb(), 100)

  await cache.addChannel(KEY_A, 'pa'.repeat(32), 'discovered', { previewVideos: [preview(CORE_A, 5)] })
  await cache.updateChannelSize(KEY_A, 900)

  const result = await cache.enforceQuota({
    protectedCoreKeys: new Set([CORE_A])
  })

  t.alike(result.evicted, [], 'a channel with a protected core is not evicted')
  t.is(result.freedBytes, 0, 'no freed bytes are claimed when nothing is cleared')
  t.alike(store.cleared, [], 'protected ranges are never cleared')
  t.ok(cache.channels.has(KEY_A), 'the channel stays tracked')
})

test('enforceQuota is a no-op under budget and never evicts pinned channels', async (t) => {
  const store = fakeStore()
  const cache = new CacheManager(store, fakeMetaDb(), 10_000)
  await cache.addChannel(KEY_A, 'pa'.repeat(32), 'discovered', { previewVideos: [preview(CORE_A, 5)] })
  await cache.updateChannelSize(KEY_A, 200)

  const under = await cache.enforceQuota({})
  t.alike(under.evicted, [])
  t.alike(store.cleared, [])

  // Now over budget, but the only channel is pinned -> protected.
  cache.maxBytes = 100
  await cache.pinChannel(KEY_A, 'pa'.repeat(32))
  const over = await cache.enforceQuota({})
  t.alike(over.evicted, [], 'pinned channels are never evicted')
  t.alike(store.cleared, [])
})

test('enforceQuota leaves a channel tracked when any of its ranges fails to clear', async (t) => {
  const cleared = []
  const gc = { compact: 0 }
  const store = {
    get (keyBuf) {
      const keyHex = b4a.toString(keyBuf, 'hex')
      return {
        async ready () {},
        async clear (start, end) {
          if (keyHex === CORE_B) throw new Error('clear failed')
          cleared.push({ keyHex, start, end })
        },
        async close () {}
      }
    },
    storage: { async flush () {}, async compact () { gc.compact += 1 } }
  }
  const cache = new CacheManager(store, fakeMetaDb(), 100)
  await cache.addChannel(KEY_A, 'pa'.repeat(32), 'discovered', {
    previewVideos: [{ id: 'v', blobId: '0:5:0:5120', blobsCoreKey: CORE_A, thumbnailBlobId: '0:1:0:1024', thumbnailBlobsCoreKey: CORE_B }]
  })
  await cache.updateChannelSize(KEY_A, 900)

  const result = await cache.enforceQuota({ collectGarbage: async () => { await store.storage.compact() } })

  t.alike(result.evicted, [], 'a partial clear does not evict the channel')
  t.is(result.freedBytes, 0, 'no freed bytes are claimed on a partial clear')
  t.ok(cache.channels.has(KEY_A), 'the channel stays tracked for a later retry')
  t.is(gc.compact, 0, 'garbage collection only runs after a real eviction')
})
