import test from 'brittle'
import { createRelaySeeder } from '../src/seeding.js'
import { buildRelayStatus, formatRelayStatus } from '../src/status.js'
import { CacheManager } from '../src/cache-manager.js'

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

function createMetaDb(initial = new Map()) {
  const writes = []
  return {
    writes,
    async get(key) {
      return initial.has(key) ? { value: initial.get(key) } : null
    },
    async put(key, value) {
      writes.push({ key, value })
      initial.set(key, value)
    }
  }
}

test('cache manager preserves refreshed preview refs for relay restart seeding', async (t) => {
  const metaDb = createMetaDb(new Map([
    ['cache-channels', [{
      driveKey: 'aa'.padEnd(64, '0'),
      publicBeeKey: 'bb'.padEnd(64, '0'),
      source: 'discovered',
      addedAt: 1,
      bytes: 0,
      pinned: false
    }]]
  ]))
  const manager = new CacheManager({}, metaDb, 1024)
  await manager.init()

  const changed = await manager.addChannel('aa'.padEnd(64, '0'), 'bb'.padEnd(64, '0'), 'discovered', {
    previewVideos: [{
      id: 'video-1',
      blobId: '0:1:0:10',
      blobsCoreKey: 'cc'.padEnd(64, '0')
    }]
  })

  t.is(changed, true)
  t.is(manager.getChannels()[0].previewVideos.length, 1)
  t.is(manager.getChannels()[0].previewVideos[0].blobsCoreKey, 'cc'.padEnd(64, '0'))
  t.is(metaDb.writes.length, 1)
  t.is(metaDb.writes[0].value[0].previewVideos[0].id, 'video-1')
})

test('cache manager clears refreshed preview refs when relay download has no playable videos', async (t) => {
  const metaDb = createMetaDb()
  const manager = new CacheManager({}, metaDb, 1024)

  await manager.addChannel('aa'.padEnd(64, '0'), 'bb'.padEnd(64, '0'), 'discovered', {
    previewVideos: [{
      id: 'video-1',
      blobId: '0:1:0:10',
      blobsCoreKey: 'cc'.padEnd(64, '0')
    }]
  })

  const changed = await manager.addChannel('aa'.padEnd(64, '0'), 'bb'.padEnd(64, '0'), 'discovered', {
    previewVideos: []
  })

  t.is(changed, true)
  t.alike(manager.getChannels()[0].previewVideos, [])
  t.alike(metaDb.writes.at(-1).value[0].previewVideos, [])
})

test('relay seeder retains PublicBee and blob-core discovery handles for mirrored channels', async (t) => {
  const publicBeeCore = createCore('11')
  const videoCore = {
    ...createCore('22'),
    async has(start, end) {
      return start === 0 && end === 1
    }
  }
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
  const blobCore = {
    ...createCore('55'),
    async has(start, end) {
      return start === 0 && end === 1
    }
  }
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

test('relay seeder exposes per-video local blob availability diagnostics', async (t) => {
  const publicBeeCore = createCore('21')
  const availableVideoCore = {
    ...createCore('31'),
    async has(start, end) {
      return start === 10 && end === 14
    }
  }
  const missingVideoCore = {
    ...createCore('32'),
    async has() {
      return false
    }
  }
  const swarm = createSwarm()
  const ctx = {
    swarm,
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('31')) return availableVideoCore
        if (keyHex.startsWith('32')) return missingVideoCore
        throw new Error(`unexpected core key ${keyHex}`)
      }
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => ({
      core: publicBeeCore,
      async listVideos() {
        return []
      }
    }),
    logger: { info() {}, warn() {}, debug() {} }
  })

  const seedStats = await seeder.seedChannel({
    driveKey: 'aa'.padEnd(64, '0'),
    publicBeeKey: 'bb'.padEnd(64, '0'),
    previewVideos: [
      { id: 'available', blobId: '10:4:0:100', blobsCoreKey: '31'.padEnd(64, '0') },
      { id: 'missing', blobId: '20:4:0:100', blobsCoreKey: '32'.padEnd(64, '0') }
    ]
  })

  const stats = seeder.getStats()
  t.is(stats.videos, 2)
  t.is(stats.blobAvailability.available, 1)
  t.is(stats.blobAvailability.missing, 1)
  t.alike(stats.blobAvailability.videos.map((video) => ({ id: video.id, availability: video.availability, contiguousBlocks: video.contiguousBlocks, hasHeadBlock: video.hasHeadBlock })), [
    { id: 'available', availability: 'playable', contiguousBlocks: 4, hasHeadBlock: true },
    { id: 'missing', availability: 'unavailable', contiguousBlocks: 0, hasHeadBlock: false }
  ])
  t.alike(seedStats.catalogEntry.previewVideos.map((video) => video.id), ['available'])
})

test('relay seeder does not advertise partially cached preview ranges as playable', async (t) => {
  const publicBeeCore = createCore('23')
  const partialVideoCore = {
    ...createCore('34'),
    async has(start, end) {
      return start === 10 && end <= 32
    }
  }
  const swarm = createSwarm()
  const ctx = {
    swarm,
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('34')) return partialVideoCore
        throw new Error(`unexpected core key ${keyHex}`)
      }
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => ({
      core: publicBeeCore,
      async listVideos() {
        return []
      }
    }),
    logger: { info() {}, warn() {}, debug() {} }
  })

  const seedStats = await seeder.seedChannel({
    driveKey: 'aa'.padEnd(64, '0'),
    publicBeeKey: 'bb'.padEnd(64, '0'),
    previewVideos: [
      { id: 'partial', blobId: '10:40:0:100', blobsCoreKey: '34'.padEnd(64, '0') }
    ]
  })

  const detail = seeder.getStats().blobAvailability.videos[0]
  t.is(detail.availability, 'unavailable')
  t.is(detail.hasHeadBlock, false)
  t.is(detail.contiguousBlocks, 0)
  t.alike(seedStats.catalogEntry.previewVideos, [])
})


test('relay seeder also seeds preview/catalog blob refs when PublicBee is sparse', async (t) => {
  const publicBeeCore = createCore('99')
  const previewVideoCore = {
    ...createCore('aa'),
    async has(start, end) {
      return start === 0 && end === 1
    }
  }
  const previewThumbnailCore = createCore('ab')
  const catalogVideoCore = createCore('ac')
  const swarm = createSwarm()
  const ctx = {
    swarm,
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('aa')) return previewVideoCore
        if (keyHex.startsWith('ab')) return previewThumbnailCore
        if (keyHex.startsWith('ac')) return catalogVideoCore
        throw new Error(`unexpected core key ${keyHex}`)
      }
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => ({
      core: publicBeeCore,
      async listVideos() {
        return []
      }
    }),
    logger: { info() {}, warn() {}, debug() {} }
  })

  const stats = await seeder.seedChannel({
    driveKey: 'aa'.padEnd(64, '0'),
    publicBeeKey: 'bb'.padEnd(64, '0'),
    previewVideos: [{
      id: 'preview-video',
      blobId: '0:1:0:10',
      blobsCoreKey: 'aa'.padEnd(64, '0'),
      thumbnailBlobId: '1:1:0:5',
      thumbnailBlobsCoreKey: 'ab'.padEnd(64, '0')
    }],
    catalogEntry: {
      previewVideos: [{
        id: 'catalog-video',
        blobId: '2:1:0:10',
        blobsCoreKey: 'ac'.padEnd(64, '0')
      }]
    }
  })

  t.is(stats.channels, 1)
  t.is(stats.publicBeeCores, 1)
  t.is(stats.blobCores, 3)
  t.is(stats.discoveryHandles, 4)
  t.is(stats.catalogEntry.previewVideos.length, 1)
  t.is(stats.catalogEntry.previewVideos[0].id, 'preview-video')
  t.alike(swarm.joins.map((join) => join.discoveryKey), [
    publicBeeCore.discoveryKey,
    previewVideoCore.discoveryKey,
    previewThumbnailCore.discoveryKey,
    catalogVideoCore.discoveryKey
  ])
})

test('relay seeder registers mirrored cores with relay blind peer', async (t) => {
  const publicBeeCore = createCore('66')
  const videoCore = createCore('77')
  const thumbnailCore = createCore('88')
  const swarm = createSwarm()
  const blindPeerCalls = []
  const ctx = {
    swarm,
    store: {
      get(key) {
        const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : String(key)
        if (keyHex.startsWith('77')) return videoCore
        if (keyHex.startsWith('88')) return thumbnailCore
        throw new Error(`unexpected core key ${keyHex}`)
      }
    }
  }
  const seeder = createRelaySeeder({
    ctx,
    loadPublicBee: async () => ({
      core: publicBeeCore,
      async listVideos() {
        return [{
          id: 'video-1',
          blobsCoreKey: '77'.padEnd(64, '0'),
          thumbnailBlobsCoreKey: '88'.padEnd(64, '0'),
        }]
      }
    }),
    blindPeer: {
      addCore(core, opts) { blindPeerCalls.push({ core, opts }) },
      getStats() { return { enabled: true, publicKey: 'relay-key', mirroredCores: blindPeerCalls.length, mirroredAutobases: 0, error: null } }
    },
    logger: { info() {}, warn() {}, debug() {} }
  })

  await seeder.seedChannel({ driveKey: 'aa'.padEnd(64, '0'), publicBeeKey: 'bb'.padEnd(64, '0') })

  t.is(blindPeerCalls.length, 3)
  t.alike(blindPeerCalls.map((call) => call.core), [publicBeeCore, videoCore, thumbnailCore])
  t.ok(blindPeerCalls.every((call) => call.opts?.announce === true))
  t.is(seeder.getStats().blindPeer.mirroredCores, 3)
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
      publicFeedDiscoveryJoined: true,
      peerPoolJoined: true,
      swarmOffline: false,
      swarmOfflineReason: null,
      swarmListenResolved: true,
      blindPeer: { enabled: true, publicKey: 'abcd', mirroredCores: 4, mirroredAutobases: 0, error: null },
      seeding: {
        channels: 2,
        videos: 5,
        publicBeeCores: 2,
        blobCores: 8,
        discoveryHandles: 10,
        blobAvailability: { playable: 4, unavailable: 1, unknown: 0, videos: [] }
      },
      directPeerDial: {
        discoveredPeers: 2,
        pending: 1,
        queued: 3,
        skipped: 1,
        failed: 0,
        connected: 1,
        lastReason: 'queued',
        peers: [{ key: 'peer-a', lastError: 'Maximum call stack size exceeded' }]
      }
    }
  })

  t.alike(status.runtime.dht, { bootstrapped: true, firewalled: false, online: true })
  t.alike(status.runtime.seeding, {
    channels: 2,
    videos: 5,
    publicBeeCores: 2,
    blobCores: 8,
    discoveryHandles: 10,
    blobAvailability: { playable: 4, unavailable: 1, unknown: 0, videos: [] },
    lastSeededAt: null,
    lastError: null
  })

  const formatted = formatRelayStatus(status)
  t.ok(formatted.includes('dht: bootstrapped=true firewalled=false online=true'))
  t.ok(formatted.includes('network: offline=false reason=none listenResolved=true peerPoolJoined=true publicFeedDiscoveryJoined=true'))
  t.ok(formatted.includes('directPeerDial: discovered=2 pending=1 queued=3 skipped=1 failed=0 connected=1 lastReason=queued'))
  t.ok(formatted.includes('lastError=Maximum call stack size exceeded'))
  t.ok(formatted.includes('blindPeer: enabled=true key=abcd mirroredCores=4 mirroredAutobases=0'))
  t.ok(formatted.includes('seeding: channels=2 videos=5 publicBeeCores=2 blobCores=8 discoveryHandles=10'))
  t.ok(formatted.includes('blobAvailability: playable=4 unavailable=1 unknown=0'))
})
