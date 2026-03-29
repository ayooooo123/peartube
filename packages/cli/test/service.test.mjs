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
      return { peers: 3, connections: 2 }
    },
    async close() {}
  }
}

function createFakeLogger() {
  const entries = []
  const levels = ['debug', 'info', 'warn', 'error']
  const components = ['relay', 'runtime', 'admission', 'status', 'mirror', 'peer', 'cache', 'feed', 'download']
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

test('createRelayService requests feed sync and logs startup summary', async (t) => {
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

    t.is(feedSyncCalls, 1)
    t.ok(logger.entries.some((entry) => entry.component === 'relay' && entry.level === 'info' && entry.msg === 'Relay starting'))
    t.ok(logger.entries.some((entry) => entry.component === 'relay' && entry.level === 'info' && entry.msg === 'Relay started' && entry.data.feedPeers === 4))
    t.ok(logger.entries.some((entry) => entry.component === 'feed' && entry.level === 'info' && entry.msg === 'Requested feed sync from peers' && entry.data.peersContacted === 4))
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
