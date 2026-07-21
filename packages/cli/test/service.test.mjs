import test from 'brittle'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayService } from '../src/service.js'
import { createArchivePublisher as createRelayArchivePublisher } from '../src/archive-manager.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createFakeRuntime() {
  let candidateHandler = null
  const metaDbMap = new Map()

  return {
    async start() {},
    requestFeedSync() {
      return 0
    },
    setCandidateHandler(handler) {
      candidateHandler = handler
    },
    async emit(candidate) {
      if (!candidateHandler) throw new Error('candidate handler not set')
      await candidateHandler(candidate)
    },
    async resolveCandidate(candidate) {
      return {
        publicBeeKey: `bee-${candidate.channelKey}`,
        ownerKey: candidate.ownerKey || `owner-${candidate.channelKey}`,
        ...candidate
      }
    },
    getNetworkStats() {
      return {
        peers: 3,
        connections: 2,
        dht: {
          bootstrapped: true,
          firewalled: false,
          online: true,
          ephemeral: null
        }
      }
    },
    async close() {},
    ctx: {
      metaDb: {
        async get(key) { return metaDbMap.has(key) ? { value: metaDbMap.get(key) } : null },
        async put(key, value) { metaDbMap.set(key, value) }
      }
    },
    identityManager: {
      getActiveIdentity() { return { driveKey: 'drive-key' } },
      getActiveChannel() { return { blobs: true, publicBeeKey: 'public-bee' } }
    },
    uploadManager: {
      async uploadFromPath() { return { success: true, videoId: 'video-1' } }
    },
    api: {
      async submitToFeed() { return { success: true } }
    }
  }
}


async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function createFakeLogger() {
  const entries = []
  const levels = ['debug', 'info', 'warn', 'error']
  const components = ['relay', 'runtime', 'admission', 'status', 'mirror', 'peer', 'cache', 'feed', 'download', 'archive']
  const logger = { entries }

  for (const component of components) {
    logger[component] = {}
    for (const level of levels) {
      logger[component][level] = (msg, data = {}) => {
        entries.push({ component, level, msg, data })
      }
    }
  }

  return logger
}

test('createRelayService mirrors configured channels on start', async (t) => {
  const dir = makeTempDir('peartube-relay-service-start-')
  const runtime = createFakeRuntime()
  const mirrored = []
  let lastStatus = null

  try {
    const service = await createRelayService({
      config: {
        mode: 'private',
        policy: 'allowlist',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: ['chan-1'],
          owners: []
        },
        discovery: {
          enabled: false,
          maxChannels: 0,
          maxChannelsPerOwner: 0
        }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 2048, videosFound: 1, videosDownloaded: 1 }
      },
      writeStatusFile: async (_path, status) => {
        lastStatus = status
      }
    })

    await service.start()

    const status = service.getStatus()
    const channel = service.catalog.getChannel('chan-1')

    t.alike(mirrored, ['chan-1'])
    t.ok(channel)
    t.is(channel.retentionClass, 'private')
    t.is(channel.bytes, 2048)
    t.is(status.summary.totalChannels, 1)
    t.is(lastStatus.runtime.peers, 3)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService accepts discovered channels in public discovery mode', async (t) => {
  const dir = makeTempDir('peartube-relay-service-discovery-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-2', source: 'discovered' })

    const channel = service.catalog.getChannel('chan-2')

    t.ok(channel)
    t.is(channel.retentionClass, 'discovery')
    t.is(channel.bytes, 4096)
    t.is(service.getStatus().summary.totalChannels, 1)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('createRelayService publishes discovered relay inventory as relay catalog feed entries', async (t) => {
  const dir = makeTempDir('peartube-relay-service-catalog-feed-')
  const runtime = createFakeRuntime()
  const submitChannelCalls = []
  const relayCatalogCalls = []
  const seedCalls = []
  const previewVideos = [{ id: 'video-1', blobId: 'blob-1', blobsCoreKey: 'cc'.repeat(32) }]

  runtime.cacheManager = {
    async addChannel(driveKey, publicBeeKey, source) {
      t.is(driveKey, 'chan-relay')
      t.is(publicBeeKey, 'bee-chan-relay')
      t.is(source, 'discovered')
    }
  }
  runtime.publicFeed = {
    async submitChannel(...args) {
      submitChannelCalls.push(args)
    }
  }
  runtime.publishRelayCatalogEntry = async (entry) => {
    relayCatalogCalls.push(entry)
  }
  runtime.seeder = {
    async seedChannel(channel) {
      seedCalls.push(channel)
      return {
        catalogEntry: {
          schema: 'peartube.relayCatalog',
          catalogVersion: 1,
          driveKey: channel.driveKey,
          publicBeeKey: channel.publicBeeKey,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          previewVideos
        }
      }
    }
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({
        bytesDownloaded: 4096,
        videosFound: 1,
        videosDownloaded: 1,
        previewVideos,
        videoCount: 1
      }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-relay', source: 'discovered' })

    t.is(seedCalls.length, 1, 'accepted relay candidate should be seeded')
    t.is(submitChannelCalls.length, 0, 'relay-cache candidates should not be submitted as local published channels')
    t.is(relayCatalogCalls.length, 1, 'relay-cache candidate should be published through relay catalog feed path')
    t.is(relayCatalogCalls[0].source, 'relay-cache')
    t.is(relayCatalogCalls[0].relayRole, 'cache')
    t.is(relayCatalogCalls[0].relayServing, true)
    t.alike(relayCatalogCalls[0].previewVideos, previewVideos)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('createRelayService accepts discovered channels by default without discovery caps', async (t) => {
  const dir = makeTempDir('peartube-relay-service-default-discovery-')
  const runtime = createFakeRuntime()
  const mirrored = []

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: {
          enabled: true,
          seedDiscovered: true,
          maxChannels: 0,
          maxChannelsPerOwner: 0
        }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 1024, videosFound: 1, videosDownloaded: 1 }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-open-default', publicBeeKey: 'bee-open-default' })

    t.alike(mirrored, ['chan-open-default'])
    t.is(service.catalog.getChannel('chan-open-default').retentionClass, 'discovery')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService starts without forcing an eager feed sync', async (t) => {
  const dir = makeTempDir('peartube-relay-service-logs-')
  const runtime = createFakeRuntime()
  const logger = createFakeLogger()
  let feedSyncCalls = 0

  runtime.requestFeedSync = () => {
    feedSyncCalls += 1
    return 4
  }

  runtime.getNetworkStats = () => ({
    peers: 5,
    connections: 3,
    feedPeers: 4,
    feedConnections: 4,
    feedEntries: 2
  })

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {}
    })

    await service.start()

    t.is(feedSyncCalls, 0)
    t.ok(logger.entries.some((entry) => entry.component === 'relay' && entry.level === 'info' && entry.msg === 'Relay starting'))
    t.ok(logger.entries.some((entry) => entry.component === 'relay' && entry.level === 'info' && entry.msg === 'Relay started' && entry.data.feedPeers === 4))
    t.absent(logger.entries.some((entry) => entry.component === 'feed' && entry.level === 'info' && entry.msg === 'Requested feed sync from peers'))
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService installs and clears a heartbeat interval', async (t) => {
  const dir = makeTempDir('peartube-relay-service-heartbeat-')
  const runtime = createFakeRuntime()
  const logger = createFakeLogger()
  let scheduled = null
  const cleared = []
  let unrefCalled = false

  function setIntervalFn(fn, ms) {
    scheduled = {
      fn,
      ms,
      timer: {
        unref() {
          unrefCalled = true
        }
      }
    }
    return scheduled.timer
  }

  function clearIntervalFn(timer) {
    cleared.push(timer)
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      setIntervalFn,
      clearIntervalFn
    })

    await service.start()

    t.ok(scheduled)
    t.is(typeof scheduled.fn, 'function')
    t.is(scheduled.ms, 30000)
    t.is(unrefCalled, false)

    await scheduled.fn()
    t.ok(logger.entries.some((entry) => entry.component === 'status' && entry.level === 'info' && entry.msg === 'Relay heartbeat'))

    await service.close()
    t.alike(cleared, [scheduled.timer])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relay heartbeat logs Hyperswarm dial diagnostics when peers have no sockets', async (t) => {
  const dir = makeTempDir('peartube-relay-service-dial-diagnostics-')
  const runtime = createFakeRuntime()
  runtime.getNetworkStats = () => ({
    peers: 2,
    connections: 0,
    hyperswarm: {
      recentPeers: [{ key: 'peer-a', relayAddresses: 0 }],
      allConnections: [{ key: 'peer-a', opened: false, destroyed: false }]
    },
    directPeerDial: {
      discoveredPeers: 2,
      queued: 0,
      skipped: 1,
      failed: 0,
      lastReason: 'observed',
      swarmConnecting: 1,
      swarmAllConnections: 1,
      swarmExplicitPeers: 2,
      swarmQueueSize: 1,
      peers: [{ key: 'peer-a', swarm: { attempts: 2, relayAddresses: 1 } }]
    }
  })
  const logger = createFakeLogger()
  let scheduled = null

  function setIntervalFn(fn, ms) {
    scheduled = { fn, ms, timer: {} }
    return scheduled.timer
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      setIntervalFn
    })

    await service.start()
    await scheduled.fn()

    const warning = logger.entries.find((entry) => (
      entry.component === 'status' &&
      entry.level === 'warn' &&
      entry.msg === 'Relay discovered peers without sockets'
    ))
    t.ok(warning)
    t.is(warning.data.swarmConnecting, 1)
    t.is(warning.data.swarmAllConnections, 1)
    t.is(warning.data.swarmExplicitPeers, 2)
    t.is(warning.data.swarmQueueSize, 1)
    t.alike(warning.data.dialPeers, [{ key: 'peer-a', swarm: { attempts: 2, relayAddresses: 1 } }])
    t.alike(warning.data.hyperswarm, {
      recentPeers: [{ key: 'peer-a', relayAddresses: 0 }],
      allConnections: [{ key: 'peer-a', opened: false, destroyed: false }]
    })

    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relay heartbeat logs DHT bootstrap diagnostics when no peers are discovered', async (t) => {
  const dir = makeTempDir('peartube-relay-service-dht-bootstrap-')
  const runtime = createFakeRuntime()
  runtime.getNetworkStats = () => ({
    peers: 0,
    connections: 0,
    dht: {
      bootstrapped: false,
      firewalled: true,
      online: true,
      ephemeral: true
    },
    publicFeedDiscoveryJoined: true,
    peerPoolJoined: true,
    swarmListenResolved: true,
    swarmOffline: false,
    hyperswarm: {
      recentPeers: [],
      recentUpdates: [],
      recentConnections: [],
      peerStates: [],
      allConnections: []
    },
    directPeerDial: {
      discoveredPeers: 0,
      queued: 0,
      skipped: 0,
      failed: 0
    }
  })
  const logger = createFakeLogger()
  let scheduled = null

  function setIntervalFn(fn, ms) {
    scheduled = { fn, ms, timer: {} }
    return scheduled.timer
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      setIntervalFn
    })

    await service.start()
    await scheduled.fn()

    const warning = logger.entries.find((entry) => (
      entry.component === 'status' &&
      entry.level === 'warn' &&
      entry.msg === 'Relay DHT has no discovered peers and is not bootstrapped'
    ))
    t.ok(warning)
    t.is(warning.data.peers, 0)
    t.is(warning.data.bootstrapped, false)
    t.is(warning.data.firewalled, true)
    t.is(warning.data.online, true)
    t.is(warning.data.ephemeral, null)
    t.is(warning.data.publicFeedDiscoveryJoined, true)
    t.is(warning.data.peerPoolJoined, true)
    t.is(warning.data.swarmListenResolved, true)
    t.alike(warning.data.hyperswarm, {
      recentPeers: [],
      recentUpdates: [],
      recentConnections: [],
      peerStates: [],
      allConnections: []
    })

    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archive job uses configured yt-dlp binary when started from the WebUI relay service', async (t) => {
  const dir = makeTempDir('peartube-relay-service-archive-bin-')
  const runtime = createFakeRuntime()
  const logger = createFakeLogger()
  const videoPath = join(dir, 'downloaded.mp4')
  const spawned = []

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: {
          channels: [],
          owners: []
        },
        discovery: {
          enabled: true,
          maxChannels: 5,
          maxChannelsPerOwner: 2
        },
        archive: {
          uiEnabled: false,
          ytDlpPath: '/usr/local/bin/yt-dlp',
          tmpPath: join(dir, 'archive-tmp')
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      fsModule: {
        mkdirSync() {},
        rmSync() {},
        existsSync(path) { return path === videoPath }
      },
      pathModule: {
        join(...parts) { return join(...parts) }
      },
      spawnFn(binary, args) {
        spawned.push({ binary, args })
        return {
          stdout: { on(event, cb) { if (event === 'data') cb(`filepath\n${videoPath}\n`) } },
          stderr: { on() {} },
          on(event, cb) { if (event === 'close') cb(0) }
        }
      }
    })

    await service.start()
    const result = await service.enqueueArchiveJob({ url: 'https://youtu.be/archive-test', channelName: 'Archive Test' }, { runNow: true })

    t.is(result.status, 'completed')
    t.is(spawned[0]?.binary, '/usr/local/bin/yt-dlp')
    t.ok(spawned[0]?.args.includes('--print'), 'archive job invokes yt-dlp through the real downloader wrapper')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('createRelayService watches configured local mirror directory', async (t) => {
  const dir = makeTempDir('peartube-relay-service-local-mirror-')
  const runtime = createFakeRuntime()
  const logger = createFakeLogger()
  const sizes = { '/videos/one.mp4': 100 }
  const intervals = []
  const cleared = []
  const imports = []
  let submitCalls = 0

  runtime.identityManager = {
    getActiveIdentity() { return { driveKey: 'drive-key' } },
    getActiveChannel() { return { blobs: true, publicBeeKey: 'public-bee' } }
  }
  let releaseUpload = null
  let uploadGate = new Promise((resolve) => {
    releaseUpload = resolve
  })

  runtime.uploadManager = {
    async uploadFromPath(_channel, filePath) {
      imports.push(filePath)
      await uploadGate
      return {
        success: true,
        videoId: `video-${imports.length}`,
        metadata: {
          size: sizes[filePath],
          blobId: `blob-${imports.length}`,
          blobsCoreKey: 'cc'.repeat(32),
          mimeType: 'video/mp4'
        }
      }
    }
  }
  runtime.api = {
    async submitToFeed() {
      submitCalls += 1
      return { success: true }
    }
  }
  runtime.cacheManager = { async pinChannel() {} }
  runtime.publicFeed = { async submitChannel() {} }
  runtime.publishRelayCatalogEntry = async () => {}
  runtime.seeder = { async seedChannel() {} }

  const fsModule = {
    readdirSync() {
      return [{ name: 'one.mp4', isDirectory: () => false, isFile: () => true }]
    },
    statSync(path) {
      return { size: sizes[path], mtimeMs: sizes[path] }
    }
  }
  const pathModule = {
    join(...parts) {
      return parts.join('/').replace(/\/+/g, '/')
    }
  }
  function setIntervalFn(fn, ms) {
    const timer = { ms, unref() {} }
    intervals.push({ fn, ms, timer })
    return timer
  }
  function clearIntervalFn(timer) {
    cleared.push(timer)
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 },
        archive: {
          localMirror: {
            enabled: true,
            path: '/videos',
            poll: 5,
            channelName: 'Camera Roll',
            description: '',
            recursive: true,
            maxFiles: 50
          }
        }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      setIntervalFn,
      clearIntervalFn,
      fsModule,
      pathModule
    })

    await service.start()
    t.ok(logger.entries.some((entry) => entry.component === 'relay' && entry.msg === 'Relay started'))
    t.ok(logger.entries.some((entry) => entry.component === 'archive' && entry.msg === 'Local directory mirror started'))
    t.ok(intervals.some((entry) => entry.ms === 5000))

    await waitFor(() => imports.length === 1)
    t.is(imports.length, 1, 'initial local mirror scan starts in the background')
    t.is(submitCalls, 0, 'startup does not wait for initial local mirror publish')

    releaseUpload()
    await waitFor(() => submitCalls === 1)
    t.is(submitCalls, 1)

    const localMirrorInterval = intervals.find((entry) => entry.ms === 5000)
    await localMirrorInterval.fn()
    t.is(imports.length, 1, 'unchanged file is not re-imported')

    sizes['/videos/one.mp4'] = 101
    uploadGate = Promise.resolve()
    await localMirrorInterval.fn()
    t.is(imports.length, 2, 'changed fingerprint is imported again')

    await service.close()
    t.ok(cleared.includes(localMirrorInterval.timer))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService refreshes already accepted channels when feed preview refs appear', async (t) => {
  const dir = makeTempDir('peartube-relay-service-preview-refresh-')
  const runtime = createFakeRuntime()
  const mirrored = []
  const previewVideos = [{
    id: 'preview-1',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32),
    thumbnailBlobId: '2:1:20:5',
    thumbnailBlobsCoreKey: 'bb'.repeat(32)
  }]

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push({ channelKey: candidate.channelKey, previews: candidate.previewVideos?.length || 0 })
        return {
          bytesDownloaded: candidate.previewVideos?.length ? 20 : 0,
          videosFound: 0,
          videosDownloaded: candidate.previewVideos?.length ? 1 : 0,
          previewVideos: candidate.previewVideos || [],
          videoCount: candidate.previewVideos?.length || 0
        }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-preview-refresh', publicBeeKey: 'bee-preview-refresh', source: 'discovered' })
    await runtime.emit({ channelKey: 'chan-preview-refresh', publicBeeKey: 'bee-preview-refresh', source: 'discovered', previewVideos })

    const channel = service.catalog.getChannel('chan-preview-refresh')

    t.alike(mirrored, [
      { channelKey: 'chan-preview-refresh', previews: 0 },
      { channelKey: 'chan-preview-refresh', previews: 1 }
    ])
    t.is(channel.videosDownloaded, 1)
    t.is(channel.bytes, 20)
    t.alike(channel.previewVideos, previewVideos)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService backs off unavailable preview refresh attempts', async (t) => {
  const dir = makeTempDir('peartube-relay-service-preview-backoff-')
  const runtime = createFakeRuntime()
  const mirrored = []
  const previewVideos = [{
    id: 'preview-timeout',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32)
  }]
  let now = 10_000

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push({ channelKey: candidate.channelKey, previews: candidate.previewVideos?.length || 0 })
        return {
          bytesDownloaded: 0,
          videosFound: candidate.previewVideos?.length || 0,
          videosDownloaded: 0,
          blobsFailed: candidate.previewVideos?.length || 0,
          previewVideos: [],
          videoCount: candidate.previewVideos?.length || 0,
          lastError: 'Blob download timeout (60000ms)'
        }
      },
      writeStatusFile: async () => {},
      nowFn: () => now
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-preview-backoff', publicBeeKey: 'bee-preview-backoff', source: 'discovered', previewVideos })
    await runtime.emit({ channelKey: 'chan-preview-backoff', publicBeeKey: 'bee-preview-backoff', source: 'discovered', previewVideos })

    let channel = service.catalog.getChannel('chan-preview-backoff')
    t.alike(mirrored, [{ channelKey: 'chan-preview-backoff', previews: 1 }])
    t.is(channel.lastError, 'Blob download timeout (60000ms)')
    t.ok(channel.lastMirrorPreviewSignature)

    now += 5 * 60_000 + 1
    await runtime.emit({ channelKey: 'chan-preview-backoff', publicBeeKey: 'bee-preview-backoff', source: 'discovered', previewVideos })

    channel = service.catalog.getChannel('chan-preview-backoff')
    t.is(mirrored.length, 2)
    t.is(channel.lastError, 'Blob download timeout (60000ms)')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('createRelayService removes playable previews when refresh downloads no videos', async (t) => {
  const dir = makeTempDir('peartube-relay-service-preview-remove-hollow-')
  const runtime = createFakeRuntime()
  const published = []
  const cachedAdds = []
  const seeded = []
  runtime.publishRelayCatalogEntry = async (entry) => { published.push(entry); return entry }
  runtime.cacheManager = {
    async addChannel(channelKey, publicBeeKey, source, options) {
      cachedAdds.push({ channelKey, publicBeeKey, source, previewVideos: options?.previewVideos || [] })
    }
  }
  runtime.seeder = {
    async seedChannel(channel) {
      seeded.push(channel)
      return null
    },
    getStats() { return {} }
  }
  const previewVideos = [{
    id: 'preview-1',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32)
  }]

  try {
    let service
    service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        const firstRefresh = !service?.catalog?.getChannel?.(candidate.channelKey)?.mirroredAt
        return {
          bytesDownloaded: firstRefresh ? 20 : 0,
          videosFound: candidate.previewVideos?.length || 0,
          videosDownloaded: firstRefresh ? 1 : 0,
          previewVideos: firstRefresh ? candidate.previewVideos : [],
          videoCount: candidate.previewVideos?.length || 0
        }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-preview-remove', publicBeeKey: 'bee-preview-remove', source: 'discovered', previewVideos })
    await runtime.emit({ channelKey: 'chan-preview-remove', publicBeeKey: 'bee-preview-remove', source: 'discovered', previewVideos })

    const channel = service.catalog.getChannel('chan-preview-remove')
    t.alike(channel.previewVideos, [])
    t.is(channel.videosDownloaded, 0)
    t.is(channel.bytes, 0)
    t.alike(cachedAdds.at(-1).previewVideos, [])
    t.alike(seeded.at(-1).previewVideos, [])
    t.alike(published.at(-1).previewVideos, [])
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('createRelayService clears playable previews when accepted refresh mirror throws', async (t) => {
  const dir = makeTempDir('peartube-relay-service-preview-error-clear-')
  const runtime = createFakeRuntime()
  const previewVideos = [{
    id: 'preview-error',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32)
  }]

  try {
    let calls = 0
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        calls += 1
        if (calls > 1) throw new Error('mirror unavailable')
        return {
          bytesDownloaded: 20,
          videosFound: candidate.previewVideos?.length || 0,
          videosDownloaded: 1,
          previewVideos: candidate.previewVideos,
          videoCount: candidate.previewVideos?.length || 0
        }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-preview-error', publicBeeKey: 'bee-preview-error', source: 'discovered', previewVideos })
    await runtime.emit({ channelKey: 'chan-preview-error', publicBeeKey: 'bee-preview-error', source: 'discovered', previewVideos })

    const channel = service.catalog.getChannel('chan-preview-error')
    t.alike(channel.previewVideos, [])
    t.is(channel.videosDownloaded, 0)
    t.is(channel.bytes, 0)
    t.is(channel.lastError, 'mirror unavailable')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('createRelayService marks timed-out preview refs unavailable instead of preserving them', async (t) => {
  const dir = makeTempDir('peartube-relay-service-unavailable-refresh-')
  const runtime = createFakeRuntime()
  const previewVideos = [{
    id: 'preview-timeout',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32),
    availability: 'playable'
  }]
  const unavailableVideos = [{
    id: 'preview-timeout',
    blobId: '0:2:0:20',
    blobsCoreKey: 'aa'.repeat(32),
    availability: 'unavailable',
    byteAvailability: 'unavailable',
    unavailableReason: 'Blob download timeout (60000ms)'
  }]
  const published = []

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({
        bytesDownloaded: 0,
        videosFound: 1,
        videosDownloaded: 0,
        previewVideos: [],
        unavailableVideos,
        videoCount: 1
      }),
      writeStatusFile: async () => {}
    })
    runtime.publishRelayCatalogEntry = async (entry) => { published.push(entry) }

    await service.start()
    await runtime.emit({ channelKey: 'chan-unavailable-refresh', publicBeeKey: 'bee-unavailable-refresh', source: 'discovered', previewVideos })

    const channel = service.catalog.getChannel('chan-unavailable-refresh')
    t.alike(channel.previewVideos, [])
    t.is(channel.unavailableVideos.length, 1)
    t.is(channel.unavailableVideos[0].availability, 'unavailable')
    t.is(channel.videosDownloaded, 0)
    t.is(published[published.length - 1].previewVideos.length, 0)
    t.is(published[published.length - 1].unavailableVideos.length, 1)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService persists catalog and status under resolved runtime db path', async (t) => {
  const dir = makeTempDir('peartube-relay-service-status-db-')
  const runtime = createFakeRuntime()

  try {
    const config = resolveRelayConfig({
      storage: { path: dir, maxBytes: 10_000 },
      admission: { channels: ['configured-channel'] }
    })
    const service = await createRelayService({
      config,
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 1024, videosFound: 1, videosDownloaded: 1 })
    })

    await service.start()

    t.ok(existsSync(join(dir, 'db', 'relay-catalog.json')))
    t.ok(existsSync(join(dir, 'db', 'relay-status.json')))
    const catalog = JSON.parse(readFileSync(join(dir, 'db', 'relay-catalog.json'), 'utf8'))
    const status = JSON.parse(readFileSync(join(dir, 'db', 'relay-status.json'), 'utf8'))
    t.ok(catalog.channels['configured-channel'])
    t.is(status.storage.path, dir)
    t.is(status.summary.totalChannels, 1)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService preserves archive-job catalog source after completed archive publish', async (t) => {
  const dir = makeTempDir('peartube-relay-service-archive-catalog-')
  const runtime = createFakeRuntime()
  const published = []
  const statuses = []
  runtime.publishRelayCatalogEntry = async (entry) => {
    published.push(entry)
    return {
      schema: 'peartube.relayCatalog',
      catalogVersion: 1,
      source: 'relay-cache',
      relayRole: 'cache',
      relayServing: true,
      ...entry
    }
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async (_path, status) => { statuses.push(status) },
      nowFn: () => 12345
    })

    await service.start()
    const result = await service.publishArchiveJobToFeed({
      status: 'completed',
      channelKey: 'archive-channel',
      publicBeeKey: 'archive-public-bee',
      completedAt: 67890,
      previewVideo: {
        id: 'archive-video',
        title: 'Archived Video',
        blobId: '0:1:0:10',
        blobsCoreKey: 'aa'.repeat(32),
        mimeType: 'video/webm',
        availability: 'playable'
      }
    })

    t.is(result.published, true)
    t.is(published.length, 1)
    t.is(published[0].source, 'archive-job')
    t.is(published[0].retentionClass, 'private')
    const channel = service.catalog.getChannel('archive-channel')
    t.is(channel.publicBeeKey, 'archive-public-bee')
    t.is(channel.source, 'archive-job')
    t.is(channel.retentionClass, 'private')
    t.is(channel.previewVideos[0].mimeType, 'video/webm')
    t.is(channel.videoCount, 1)

    await runtime.emit({
      channelKey: 'archive-channel',
      publicBeeKey: 'archive-public-bee',
      source: 'discovered',
      previewVideos: [{
        id: 'archive-video',
        blobId: '0:1:0:10',
        blobsCoreKey: 'aa'.repeat(32)
      }]
    })
    const refreshedChannel = service.catalog.getChannel('archive-channel')
    t.is(refreshedChannel.source, 'archive-job')
    t.is(refreshedChannel.retentionClass, 'private')
    t.is(published.at(-1).source, 'archive-job')
    t.is(published.at(-1).retentionClass, 'private')
    t.is(statuses.at(-1).summary.totalChannels, 1)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService repairs completed grouped archive projections before republishing them', async (t) => {
  const dir = makeTempDir('peartube-relay-service-archive-projection-repair-')
  const runtime = createFakeRuntime()
  const projectionRepairs = []
  const publishedEntries = []
  runtime.publishRelayCatalogEntry = async (entry) => {
    publishedEntries.push(entry)
    return entry
  }
  let visibleProjectionVideos = []
  runtime.api.submitToFeed = async (channelKey, loadOptions) => {
    projectionRepairs.push({ channelKey, loadOptions })
    if (
      channelKey === 'archive-show-channel' &&
      loadOptions?.preferWritable === true &&
      loadOptions?.writerKeyName === 'peartube-archive-writer:tmdb:tv:456'
    ) {
      visibleProjectionVideos = [{ id: 'archive-show-episode' }]
      return { success: true }
    }
    return { success: false, error: 'archive channel was not reopened with its writer key' }
  }
  const startupEvents = []
  runtime.start = async () => { startupEvents.push('runtime:start') }
  runtime.cacheManager = {
    async init() { startupEvents.push('cache:init') },
    async removeChannel(channelKey) { startupEvents.push(`cache:remove:${channelKey}`) },
    async addChannel() {}
  }
  runtime.publicFeed = {
    hideChannel(channelKey) { startupEvents.push(`feed:hide:${channelKey}`) },
    async unpublishChannel(channelKey) { startupEvents.push(`feed:unpublish:${channelKey}`) },
    async submitChannel() {}
  }

  await runtime.ctx.metaDb.put('relay-archive-jobs', [{
    id: 'failed-repair-job',
    status: 'completed',
    publish: true,
    channelKey: 'failed-repair-channel',
    publicBeeKey: 'failed-repair-public-bee',
    completedAt: 67888,
    previewVideo: {
      id: 'failed-repair-video',
      title: 'Stale archive',
      blobId: '0:1:0:10',
      blobsCoreKey: 'cc'.repeat(32),
      availability: 'playable'
    }
  }, {
    id: 'unpublished-archive-job',
    status: 'completed',
    publish: false,
    channelKey: 'blocked-show-channel',
    publicBeeKey: 'blocked-show-public-bee',
    completedAt: 67889,
    previewVideo: {
      id: 'unpublished-archive-video',
      title: 'Private archive',
      blobId: '0:1:0:10',
      blobsCoreKey: 'bb'.repeat(32),
      availability: 'playable'
    }
  }, {
    id: 'blocked-show-job',
    status: 'completed',
    publish: true,
    channelKey: 'blocked-show-channel',
    publicBeeKey: 'blocked-show-public-bee',
    completedAt: 67889,
    previewVideo: {
      id: 'blocked-show-episode',
      title: 'Public sibling',
      blobId: '0:1:0:10',
      blobsCoreKey: 'dd'.repeat(32),
      availability: 'playable'
    }
  }, {
    id: 'archive-show-job',
    status: 'completed',
    publish: true,
    channelKey: 'archive-show-channel',
    publicBeeKey: 'archive-show-public-bee',
    completedAt: 67890,
    previewVideo: {
      id: 'archive-show-episode',
      title: 'Episode 1',
      blobId: '0:1:0:10',
      blobsCoreKey: 'aa'.repeat(32),
      availability: 'playable'
    }
  }])
  await runtime.ctx.metaDb.put('relay-archive-job-inputs', {
    'failed-repair-job': {
      anonymous: false,
      publish: true,
      tmdbType: 'tv',
      tmdbId: '999',
      tmdbTitle: 'Stale Show'
    },
    'blocked-show-job': {
      anonymous: false,
      publish: true,
      tmdbType: 'tv',
      tmdbId: '777',
      tmdbTitle: 'Blocked Show'
    },
    'archive-show-job': {
      anonymous: false,
      publish: true,
      tmdbType: 'tv',
      tmdbId: '456',
      tmdbTitle: 'Archived Show'
    }
  })

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json')
        },
        admission: { channels: [], owners: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {}
    })
    await service.catalog.upsertChannel({
      channelKey: 'blocked-show-channel',
      publicBeeKey: 'blocked-show-public-bee',
      source: 'archive-job',
      retentionClass: 'private',
      previewVideos: [{ id: 'unpublished-archive-video' }],
      videoCount: 1
    })

    await service.start()
    await waitFor(() =>
      projectionRepairs.length === 2 &&
      publishedEntries.some((entry) => entry.driveKey === 'archive-show-channel'))

    t.alike(projectionRepairs, [{
      channelKey: 'failed-repair-channel',
      loadOptions: {
        preferWritable: true,
        writerKeyName: 'peartube-archive-writer:tmdb:tv:999'
      }
    }, {
      channelKey: 'archive-show-channel',
      loadOptions: {
        preferWritable: true,
        writerKeyName: 'peartube-archive-writer:tmdb:tv:456'
      }
    }])
    t.alike(visibleProjectionVideos, [{ id: 'archive-show-episode' }])
    t.alike(publishedEntries.map((entry) => ({
      channelKey: entry.driveKey,
      videoIds: entry.previewVideos.map((video) => video.id),
    })), [{
      channelKey: 'archive-show-channel',
      videoIds: ['archive-show-episode'],
    }])
    const runtimeStartedAt = startupEvents.indexOf('runtime:start')
    const hiddenBeforeStartAt = startupEvents.indexOf('feed:hide:blocked-show-channel')
    const cacheRemovedBeforeStartAt = startupEvents.indexOf('cache:remove:blocked-show-channel')
    const unpublishedAfterStartAt = startupEvents.indexOf('feed:unpublish:blocked-show-channel')
    t.ok(
      hiddenBeforeStartAt >= 0 && hiddenBeforeStartAt < runtimeStartedAt,
      'mixed unpublished channels are hidden before the runtime restores feed entries'
    )
    t.ok(
      cacheRemovedBeforeStartAt >= 0 && cacheRemovedBeforeStartAt < runtimeStartedAt,
      'mixed unpublished channels are removed from the cache before startup seeding'
    )
    t.ok(
      unpublishedAfterStartAt > runtimeStartedAt,
      'persisted published-channel state is removed after feed startup'
    )
    t.absent(service.catalog.getChannel('blocked-show-channel'))
    const blockedDirectPublish = await service.publishArchiveJobToFeed({
      id: 'blocked-show-job',
      status: 'completed',
      publish: true,
      channelKey: 'blocked-show-channel',
      publicBeeKey: 'blocked-show-public-bee',
      previewVideo: {
        id: 'blocked-show-episode',
        availability: 'playable'
      }
    })
    t.alike(blockedDirectPublish, {
      published: false,
      reason: 'channel-contains-unpublished-archive'
    })
    t.is(publishedEntries.length, 1)
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relay archive publisher keeps unpublished imports out of public projection', async (t) => {
  let uploadedOptions = null
  const publisher = createRelayArchivePublisher({
    identityManager: {},
    uploadManager: {
      async uploadFromPath(_channel, _filePath, options) {
        uploadedOptions = options
        return { success: true, videoId: 'private-archive-video' }
      }
    },
    api: {},
    runtime: {},
    fs: {}
  })

  await publisher.importVideo({
    channel: {},
    filePath: '/tmp/private.mp4',
    title: 'Private archive',
    description: '',
    publish: false
  })

  t.is(uploadedOptions.publicationState, 'replicationPending')
})
