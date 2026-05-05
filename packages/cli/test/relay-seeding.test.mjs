import test from 'brittle'
import { createRelaySeeder } from '../src/seeding.js'
import { buildRelayStatus, formatRelayStatus } from '../src/status.js'

function createCore(keyHex, discoveryKey = `discovery:${keyHex}`) {
  return {
    key: Buffer.from(keyHex.padEnd(64, '0').slice(0, 64), 'hex'),
    discoveryKey,
    readyCalls: 0,
    async ready() {
      this.readyCalls += 1
    }
  }
}

function createSwarm() {
  return {
    joins: [],
    join(discoveryKey, opts) {
      this.joins.push({ discoveryKey, opts })
      return {
        discoveryKey,
        opts,
        flushed() {
          return Promise.resolve()
        },
        destroy() {}
      }
    }
  }
}

test('relay seeder retains PublicBee and blob-core discovery handles for mirrored channels', async (t) => {
  const publicBeeCore = createCore('11')
  const videoCore = createCore('22')
  const thumbnailCore = createCore('33')
  const swarm = createSwarm()
  const store = {
    getCalls: [],
    get(key) {
      const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
      this.getCalls.push(keyHex)
      if (keyHex.startsWith('22')) return videoCore
      if (keyHex.startsWith('33')) return thumbnailCore
      throw new Error(`unexpected core key ${keyHex}`)
    }
  }
  const ctx = { swarm, store }
  const publicBee = {
    core: publicBeeCore,
    async listVideos() {
      return [
        {
          id: 'video-1',
          blobsCoreKey: '22'.padEnd(64, '0'),
          thumbnailBlobsCoreKey: '33'.padEnd(64, '0'),
          blobId: '0:1:0:10',
          thumbnailBlobId: '1:1:0:5'
        }
      ]
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => publicBee,
    logger: { info() {}, warn() {}, debug() {} }
  })

  const stats = await seeder.seedChannel({
    driveKey: 'aa'.padEnd(64, '0'),
    publicBeeKey: 'bb'.padEnd(64, '0')
  })

  t.is(stats.channels, 1)
  t.is(stats.videos, 1)
  t.is(stats.publicBeeCores, 1)
  t.is(stats.blobCores, 2)
  t.alike(swarm.joins.map((join) => join.discoveryKey), [
    publicBeeCore.discoveryKey,
    videoCore.discoveryKey,
    thumbnailCore.discoveryKey
  ])
  t.alike(swarm.joins.map((join) => join.opts), [
    { server: true, client: true },
    { server: true, client: true },
    { server: true, client: true }
  ])

  const snapshot = seeder.getStats()
  t.is(snapshot.channels, 1)
  t.is(snapshot.videos, 1)
  t.is(snapshot.publicBeeCores, 1)
  t.is(snapshot.blobCores, 2)
  t.is(snapshot.discoveryHandles, 3)
})

test('relay seeder refreshes all cached channels and deduplicates retained joins', async (t) => {
  const publicBeeCore = createCore('44')
  const blobCore = createCore('55')
  const swarm = createSwarm()
  const ctx = {
    swarm,
    store: {
      get() { return blobCore }
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => ({
      core: publicBeeCore,
      async listVideos() {
        return [{ id: 'video-1', blobsCoreKey: '55'.padEnd(64, '0'), blobId: '0:1:0:10' }]
      }
    }),
    logger: { info() {}, warn() {}, debug() {} }
  })
  const cacheManager = {
    getChannels() {
      return [
        { driveKey: 'aa'.padEnd(64, '0'), publicBeeKey: 'bb'.padEnd(64, '0') },
        { driveKey: 'aa'.padEnd(64, '0'), publicBeeKey: 'bb'.padEnd(64, '0') }
      ]
    }
  }

  const stats = await seeder.seedCachedChannels(cacheManager)

  t.is(stats.channels, 1)
  t.is(stats.videos, 1)
  t.is(stats.discoveryHandles, 2)
  t.is(swarm.joins.length, 2)
})

test('relay status surfaces DHT and seeding stats for phone connectivity diagnostics', async (t) => {
  const status = buildRelayStatus({
    config: {
      mode: 'public',
      policy: 'discovery',
      storage: { path: '/tmp/relay', maxBytes: 1000 }
    },
    catalog: {
      getChannels() { return [] },
      getSummary() { return { totalChannels: 0, protectedChannels: 0, usedBytes: 0 } }
    },
    runtimeStats: {
      peers: 2,
      connections: 1,
      feedPeers: 1,
      feedConnections: 1,
      feedEntries: 3,
      dht: { bootstrapped: true, firewalled: false, online: true },
      seeding: { channels: 2, videos: 5, publicBeeCores: 2, blobCores: 8, discoveryHandles: 10 }
    }
  })

  t.alike(status.runtime.dht, { bootstrapped: true, firewalled: false, online: true })
  t.alike(status.runtime.seeding, {
    channels: 2,
    videos: 5,
    publicBeeCores: 2,
    blobCores: 8,
    discoveryHandles: 10,
    lastSeededAt: null,
    lastError: null
  })

  const formatted = formatRelayStatus(status)
  t.ok(formatted.includes('dht: bootstrapped=true firewalled=false online=true'))
  t.ok(formatted.includes('seeding: channels=2 videos=5 publicBeeCores=2 blobCores=8 discoveryHandles=10'))
})
