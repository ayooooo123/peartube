import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayService } from '../src/service.js'

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

    await Promise.resolve()
    await Promise.resolve()
    t.is(imports.length, 1, 'initial local mirror scan starts in the background')
    t.is(submitCalls, 0, 'startup does not wait for initial local mirror publish')

    releaseUpload()
    await new Promise((resolve) => setImmediate(resolve))
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
