import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CacheManager } from '../src/cache-manager.js'
import { initPeer } from '../src/init.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Helpers ---

function createMockMetaDb () {
  const db = new Map()
  return {
    get: async (key) => db.has(key) ? { value: db.get(key) } : null,
    put: async (key, value) => { db.set(key, value) }
  }
}

// --- Test 1: CacheManager quota enforcement ---

test('CacheManager - enforceQuota evicts oldest discovered, keeps pinned', async (t) => {
  const metaDb = createMockMetaDb()
  const mgr = new CacheManager(null, metaDb, 1000)
  await mgr.init()

  // Add 3 channels: A pinned, B discovered, C discovered
  await mgr.addChannel('channelA', 'beeA', 'pinned')
  await mgr.addChannel('channelB', 'beeB', 'discovered')
  await mgr.addChannel('channelC', 'beeC', 'discovered')

  // Force distinct timestamps so B is definitively oldest
  mgr.channels.get('channelB').addedAt = 1000
  mgr.channels.get('channelC').addedAt = 2000

  await mgr.updateChannelSize('channelA', 500)
  await mgr.updateChannelSize('channelB', 300)
  await mgr.updateChannelSize('channelC', 400)

  // Total = 1200, max = 1000 → must evict
  t.is(mgr.getTotalBytes(), 1200)

  await mgr.enforceQuota()

  // A (pinned, 500) kept, B (oldest discovered, 300) evicted, C (400) kept
  t.ok(mgr.channels.has('channelA'), 'pinned channel A kept')
  t.ok(!mgr.channels.has('channelB'), 'oldest discovered channel B evicted')
  t.ok(mgr.channels.has('channelC'), 'newer discovered channel C kept')
  t.is(mgr.getTotalBytes(), 900)
  t.ok(mgr.getTotalBytes() <= 1000, 'total within quota')
})

// --- Test 2: CacheManager persistence across sessions ---

test('CacheManager - persists and restores channels across sessions', async (t) => {
  const metaDb = createMockMetaDb()

  // Session 1: add channels
  const mgr1 = new CacheManager(null, metaDb, 5000)
  await mgr1.init()
  await mgr1.addChannel('driveX', 'beeX', 'pinned')
  await mgr1.addChannel('driveY', 'beeY', 'discovered')
  await mgr1.updateChannelSize('driveX', 100)
  await mgr1.updateChannelSize('driveY', 200)

  t.is(mgr1.channels.size, 2)

  // Session 2: new CacheManager, same metaDb
  const mgr2 = new CacheManager(null, metaDb, 5000)
  await mgr2.init()

  t.is(mgr2.channels.size, 2, 'both channels restored')
  t.ok(mgr2.channels.has('driveX'), 'driveX restored')
  t.ok(mgr2.channels.has('driveY'), 'driveY restored')

  const x = mgr2.channels.get('driveX')
  const y = mgr2.channels.get('driveY')
  t.is(x.pinned, true, 'driveX pinned state preserved')
  t.is(x.source, 'pinned', 'driveX source preserved')
  t.is(y.pinned, false, 'driveY not pinned')
  t.is(y.source, 'discovered', 'driveY source preserved')
  t.is(x.bytes, 100, 'driveX bytes preserved')
  t.is(y.bytes, 200, 'driveY bytes preserved')
})

// --- Test 3: CacheManager pinning protects from eviction ---

test('CacheManager - pinned channels survive quota enforcement', async (t) => {
  const metaDb = createMockMetaDb()
  const mgr = new CacheManager(null, metaDb, 500)
  await mgr.init()

  await mgr.addChannel('pinnedA', 'beeA', 'pinned')
  await mgr.updateChannelSize('pinnedA', 400)

  await mgr.addChannel('discoveredB', 'beeB', 'discovered')
  await mgr.updateChannelSize('discoveredB', 300)

  // Total 700 > 500
  t.is(mgr.getTotalBytes(), 700)

  await mgr.enforceQuota()

  t.ok(mgr.channels.has('pinnedA'), 'pinned channel A survives')
  t.ok(!mgr.channels.has('discoveredB'), 'discovered channel B evicted')
  t.is(mgr.getTotalBytes(), 400)

  const stats = mgr.getStats()
  t.is(stats.totalChannels, 1)
  t.is(stats.pinnedChannels, 1)
})

// --- Test 4: CLI argument defaults ---

test('CLI bin.js - contains expected argument defaults and flags', async (t) => {
  const binPath = join(__dirname, '..', 'bin.js')
  const content = readFileSync(binPath, 'utf-8')

  t.ok(content.includes('./peartube-peer'), 'default storage path present')
  t.ok(content.includes('100000'), 'default max storage present')
  t.ok(content.includes('--channel'), '--channel flag present')
  t.ok(content.includes('--debug'), '--debug flag present')
})

// --- Test 5: initPeer creates peer components ---

test('initPeer - creates ctx, publicFeed, and cacheManager', { timeout: 20000 }, async (t) => {
  const storagePath = '/tmp/pt-test-' + Date.now()

  const { ctx, publicFeed, cacheManager } = await initPeer({
    storagePath,
    maxBytes: 1000000,
    pinnedChannels: []
  })

  t.ok(ctx, 'ctx returned')
  t.ok(publicFeed, 'publicFeed returned')
  t.ok(cacheManager, 'cacheManager returned')

  t.ok(ctx.swarm, 'ctx.swarm exists')
  t.ok(!ctx.swarm.destroyed, 'swarm is not destroyed')

  t.is(publicFeed.started, true, 'publicFeed is started')

  t.ok(cacheManager.channels instanceof Map, 'cacheManager.channels is a Map')

  // Cleanup
  publicFeed.stop()
  await ctx.swarm.destroy()
  if (ctx.blobServer) {
    try { ctx.blobServer.close() } catch (_) {}
  }
  await ctx.store.close()
})
