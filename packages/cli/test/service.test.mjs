import test from 'brittle'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRelayConfig } from '../src/config.js'
import { ModerationRuleStore } from '../src/moderation-store.js'
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

test('createRelayService quarantines moderated candidates before mirroring', async (t) => {
  const dir = makeTempDir('peartube-relay-service-moderation-quarantine-')
  const runtime = createFakeRuntime()
  const mirrored = []
  const logger = createFakeLogger()

  runtime.cacheManager = { async addChannel() { throw new Error('cache should not run') } }
  runtime.seeder = { async seedChannel() { throw new Error('seed should not run') } }
  runtime.publishRelayCatalogEntry = async () => { throw new Error('publish should not run') }

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
        moderation: {
          rules: [{ targetType: 'channelKey', target: 'chan-q', action: 'quarantine', source: 'local' }]
        },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    const result = await service.processCandidate({ channelKey: 'chan-q', ownerKey: 'owner-q', publicBeeKey: 'bee-q' })
    const channel = service.catalog.getChannel('chan-q')

    t.is(result.accepted, false)
    t.is(result.reason, 'moderation-quarantined')
    t.alike(mirrored, [])
    t.ok(channel)
    t.is(channel.moderation.state, 'quarantined')
    t.is(service.getStatus().moderation.quarantinedChannels, 1)
    t.ok(logger.entries.some((entry) => entry.component === 'admission' && entry.msg === 'Candidate rejected' && entry.data.reason === 'moderation-quarantined'))
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService applies persisted moderation rules at startup', async (t) => {
  const dir = makeTempDir('peartube-relay-service-persisted-moderation-')
  const runtime = createFakeRuntime()
  const mirrored = []
  const logger = createFakeLogger()
  const moderationPath = join(dir, 'relay-moderation.json')

  try {
    const store = await ModerationRuleStore.open({
      storagePath: dir,
      moderationPath,
      nowFn: () => 3000
    })
    await store.addRule({
      targetType: 'owner',
      target: 'owner-blocked',
      action: 'block',
      reason: 'operator block'
    })

    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          moderation: moderationPath
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger,
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    const result = await service.processCandidate({
      channelKey: 'chan-blocked',
      ownerKey: 'owner-blocked',
      publicBeeKey: 'bee-blocked'
    })

    t.is(result.accepted, false)
    t.is(result.reason, 'moderation-blocked')
    t.alike(mirrored, [])
    t.is(service.getStatus().moderation.rules.block, 1)
    t.ok(logger.entries.some((entry) => entry.component === 'admission' && entry.msg === 'Candidate rejected' && entry.data.reason === 'moderation-blocked'))
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService records posture and moderation alerts in relay status', async (t) => {
  const dir = makeTempDir('peartube-relay-service-alerts-')
  const runtime = createFakeRuntime()
  const mirrored = []
  let now = 10_000

  runtime.cacheManager = { async addChannel() { throw new Error('cache should not run for rejected candidates') } }
  runtime.seeder = { async seedChannel() { throw new Error('seed should not run for rejected candidates') } }
  runtime.publishRelayCatalogEntry = async () => { throw new Error('publish should not run for rejected candidates') }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache', 'archiver'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json')
        },
        admission: { channels: [], owners: [] },
        moderation: {
          mode: 'report-and-alert',
          rules: [
            { targetType: 'channelKey', target: 'chan-block', action: 'block', source: 'local' },
            { targetType: 'channelKey', target: 'chan-q', action: 'quarantine', source: 'local' }
          ]
        },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }
      },
      writeStatusFile: async () => {},
      nowFn: () => now
    })

    await service.start()
    now = 11_000
    await service.processCandidate({ channelKey: 'chan-block', ownerKey: 'owner-block', publicBeeKey: 'bee-block' })
    now = 12_000
    await service.processCandidate({ channelKey: 'chan-q', ownerKey: 'owner-q', publicBeeKey: 'bee-q' })

    const status = service.getStatus()
    const summaries = status.alerts.latest.map((alert) => alert.summary)

    t.alike(mirrored, [])
    t.is(status.alerts.info, 1)
    t.is(status.alerts.warning, 2)
    t.is(status.alerts.critical, 1)
    t.is(status.alerts.unacknowledged, 4)
    t.ok(summaries.includes('Public index stores public channel and video metadata for discovery'), 'public-index posture is explicit')
    t.ok(summaries.includes('Archive role publishes operator-selected content'), 'archiver posture is explicit')
    t.ok(summaries.includes('Blocklisted channelKey:chan-block appeared in public feed gossip'), 'blocked gossip produces an alert')
    t.ok(summaries.includes('Quarantine applied to channelKey:chan-q'), 'quarantine produces an alert')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService alerts watched targets without blocking mirroring', async (t) => {
  const dir = makeTempDir('peartube-relay-service-watch-alerts-')
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
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json')
        },
        admission: { channels: [], owners: [] },
        moderation: {
          mode: 'report-and-alert',
          rules: [
            { targetType: 'channelKey', target: 'chan-watch', action: 'watch', source: 'local' }
          ]
        },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async (candidate) => {
        mirrored.push(candidate.channelKey)
        return { bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }
      },
      writeStatusFile: async () => {}
    })

    await service.start()
    const result = await service.processCandidate({ channelKey: 'chan-watch', ownerKey: 'owner-watch', publicBeeKey: 'bee-watch' })

    t.is(result.accepted, true)
    t.alike(mirrored, ['chan-watch'])
    t.is(service.getStatus().alerts.warning, 1)
    t.ok(service.getStatus().alerts.latest.some((alert) => alert.summary === 'Watched channelKey:chan-watch appeared in public feed gossip'))
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService applies operator moderation actions immediately', async (t) => {
  const dir = makeTempDir('peartube-relay-service-moderation-action-')
  const runtime = createFakeRuntime()
  const moderationPath = join(dir, 'relay-moderation.json')

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          moderation: moderationPath
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 4096, videosFound: 2, videosDownloaded: 2 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-review', ownerKey: 'owner-review', publicBeeKey: 'bee-review' })
    const rule = await service.addModerationRule({
      action: 'block',
      targetType: 'channelKey',
      target: 'chan-review',
      reason: 'operator-review'
    })

    const storedRules = (await ModerationRuleStore.open({ storagePath: dir, moderationPath })).getRules()
    const channel = service.catalog.getChannel('chan-review')

    t.is(rule.action, 'block')
    t.is(storedRules.length, 1)
    t.is(storedRules[0].target, 'chan-review')
    t.is(service.config.moderation.rules.length, 1)
    t.is(channel.moderation.state, 'blocked')
    t.is(channel.lastDecisionReason, 'operator-block')
    t.alike(service.getStatus().reviewQueue, [])
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService exposes moderation target detail with cache refs', async (t) => {
  const dir = makeTempDir('peartube-relay-service-target-detail-')
  const runtime = createFakeRuntime()
  const previewVideos = [{
    id: 'video-1',
    title: 'Preview Detail',
    blobId: '0:4:0:2048',
    blobsCoreKey: 'aa'.repeat(32),
    thumbnailBlobId: '4:1:2048:512',
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
      mirrorChannel: async () => ({
        bytesDownloaded: 2048,
        videosFound: 1,
        videosDownloaded: 1,
        previewVideos,
        unavailableVideos: [{
          id: 'video-2',
          blobId: '0:2:0:1024',
          blobsCoreKey: 'cc'.repeat(32),
          reason: 'timeout'
        }],
        videoCount: 2
      }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-detail', ownerKey: 'owner-detail', publicBeeKey: 'bee-detail' })
    await service.addModerationRule({
      action: 'quarantine',
      targetType: 'channelKey',
      target: 'chan-detail',
      reason: 'operator-review'
    })

    const detail = service.getModerationTargetDetail({ targetType: 'channelKey', target: 'chan-detail' })

    t.is(detail.targetType, 'channelKey')
    t.is(detail.target, 'chan-detail')
    t.is(detail.cacheStatus.bytes, 2048)
    t.is(detail.cacheStatus.videoCount, 2)
    t.alike(detail.cacheStatus.retentionClasses, ['discovery'])
    t.is(detail.channels[0].publicBeeKey, 'bee-detail')
    t.is(detail.channels[0].previewVideos[0].blobsCoreKey, 'aa'.repeat(32))
    t.is(detail.channels[0].unavailableVideos[0].reason, 'timeout')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService exports moderation audit state', async (t) => {
  const dir = makeTempDir('peartube-relay-service-audit-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json'),
          moderation: join(dir, 'relay-moderation.json')
        },
        admission: { channels: [], owners: [] },
        moderation: {
          mode: 'report-and-alert',
          rules: [{ targetType: 'channelKey', target: 'chan-watch', action: 'watch', source: 'local' }]
        },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 1024, videosFound: 1, videosDownloaded: 1 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-watch', ownerKey: 'owner-watch', publicBeeKey: 'bee-watch' })

    const audit = service.getModerationAudit()

    t.is(audit.schema, 'peartube.relayModerationAudit')
    t.is(audit.version, 1)
    t.ok(audit.generatedAt)
    t.is(audit.roles[0], 'public-index')
    t.is(audit.rules.length, 1)
    t.is(audit.alerts.length, 2, 'posture and watch alerts are included')
    t.is(audit.reviewQueue.length, 1)
    t.is(audit.reviewQueue[0].target, 'chan-watch')
    t.is(audit.targets[0].target, 'chan-watch')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService submits local reports into review queue and audit', async (t) => {
  const dir = makeTempDir('peartube-relay-service-reports-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json'),
          moderation: join(dir, 'relay-moderation.json'),
          reports: join(dir, 'relay-reports.json')
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 512, videosFound: 1, videosDownloaded: 1 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-report', ownerKey: 'owner-report', publicBeeKey: 'bee-report' })

    const report = await service.submitModerationReport({
      targetType: 'channel',
      target: 'chan-report',
      reason: 'spam',
      comment: 'unexpected preview',
      reporter: 'local'
    })
    const status = service.getStatus()
    const reviewItem = status.reviewQueue.find((item) => item.target === 'chan-report')
    const audit = service.getModerationAudit()

    t.is(report.targetType, 'channelKey')
    t.is(report.reason, 'spam')
    t.is(status.alerts.warning, 1)
    t.is(reviewItem.state, 'reported')
    t.is(reviewItem.source, 'report')
    t.is(reviewItem.reportCount, 1)
    t.is(reviewItem.bytes, 512)
    t.is(audit.reports.length, 1)
    t.is(audit.reports[0].comment, 'unexpected preview')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService raises report threshold alerts', async (t) => {
  const dir = makeTempDir('peartube-relay-service-report-threshold-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json'),
          reports: join(dir, 'relay-reports.json')
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [], reportThreshold: 3 },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await service.submitModerationReport({ targetType: 'owner', target: 'owner-r', reason: 'spam' })
    await service.submitModerationReport({ targetType: 'owner', target: 'owner-r', reason: 'spam' })
    await service.submitModerationReport({ targetType: 'owner', target: 'owner-r', reason: 'spam' })

    const status = service.getStatus()
    const reviewItem = status.reviewQueue.find((item) => item.target === 'owner-r')
    const summaries = status.alerts.latest.map((alert) => alert.summary)

    t.is(reviewItem.reportCount, 3)
    t.is(status.alerts.critical, 1)
    t.ok(summaries.includes('Report threshold exceeded for ownerKey:owner-r'))
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService records storage concentration alerts', async (t) => {
  const dir = makeTempDir('peartube-relay-service-storage-alerts-')
  const runtime = createFakeRuntime()

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 1_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json')
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 600, videosFound: 1, videosDownloaded: 1 }),
      writeStatusFile: async () => {}
    })

    await service.start()
    await runtime.emit({ channelKey: 'chan-large', ownerKey: 'owner-large', publicBeeKey: 'bee-large' })

    const summaries = service.getStatus().alerts.latest.map((alert) => alert.summary)

    t.ok(summaries.includes('Channel channelKey:chan-large is using 60% of relay cache budget'))
    t.ok(summaries.includes('Owner ownerKey:owner-large is using 60% of relay cache budget'))
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

test('createRelayService records archive job and publish alerts', async (t) => {
  const dir = makeTempDir('peartube-relay-service-archive-alerts-')
  const runtime = createFakeRuntime()
  const published = []
  runtime.publishRelayCatalogEntry = async (entry) => {
    published.push(entry)
    return entry
  }

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache', 'archiver'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json')
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 },
        archive: {
          uiEnabled: false,
          ytDlpPath: '/usr/local/bin/yt-dlp',
          tmpPath: join(dir, 'archive-tmp')
        }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {},
      nowFn: () => 2222
    })

    await service.start()
    await service.enqueueArchiveJob({
      url: 'https://video.example/watch?v=archive-alert',
      channelName: 'Archive Alerts'
    })
    await service.publishArchiveJobToFeed({
      status: 'completed',
      channelKey: 'archive-alert-channel',
      publicBeeKey: 'archive-alert-public-bee',
      completedAt: 3333,
      previewVideo: {
        id: 'archive-alert-video',
        title: 'Archive Alert Video',
        blobId: '0:1:0:10',
        blobsCoreKey: 'aa'.repeat(32),
        mimeType: 'video/mp4',
        availability: 'playable'
      }
    })

    const summaries = service.getStatus().alerts.latest.map((alert) => alert.summary)

    t.ok(summaries.includes('Archive job queued from public source video.example'))
    t.ok(summaries.includes('Archive published video archive-alert-video into channelKey:archive-alert-channel'))
    t.is(published[0].source, 'archive-job')
    await service.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createRelayService records network empty-state alerts', async (t) => {
  const dir = makeTempDir('peartube-relay-service-network-alerts-')
  const runtime = createFakeRuntime()
  runtime.getNetworkStats = () => ({
    peers: 2,
    connections: 1,
    feedPeers: 2,
    feedConnections: 1,
    feedEntries: 0,
    publicFeedDiscoveryJoined: true,
    seeding: {
      channels: 0,
      videos: 0
    }
  })

  try {
    const service = await createRelayService({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 10_000 },
        paths: {
          catalog: join(dir, 'relay-catalog.json'),
          status: join(dir, 'relay-status.json'),
          alerts: join(dir, 'relay-alerts.json')
        },
        admission: { channels: [], owners: [] },
        moderation: { mode: 'report-and-alert', rules: [] },
        discovery: { enabled: true, maxChannels: 5, maxChannelsPerOwner: 2 }
      },
      logger: createFakeLogger(),
      runtimeFactory: async () => runtime,
      mirrorChannel: async () => ({ bytesDownloaded: 0, videosFound: 0, videosDownloaded: 0 }),
      writeStatusFile: async () => {}
    })

    await service.start()

    const summaries = service.getStatus().alerts.latest.map((alert) => alert.summary)

    t.ok(summaries.includes('Public feed has peers but no accepted entries'))
    t.ok(summaries.includes('Relay cache is serving no content while discovery is enabled'))
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

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
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
