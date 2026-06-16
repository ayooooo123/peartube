import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayCatalog } from '../src/catalog.js'
import { buildRelayStatus, formatRelayStatus, readRelayStatus, withRelayAlerts, writeRelayStatus } from '../src/status.js'

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('RelayCatalog persists accepted channels to disk', async (t) => {
  const dir = makeTempDir('peartube-relay-catalog-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })

    await catalog.upsertChannel({
      channelKey: 'chan-1',
      ownerKey: 'owner-1',
      source: 'config',
      retentionClass: 'private',
      bytes: 2048,
      mirroredAt: 123
    })

    const reloaded = await RelayCatalog.open({ storagePath: dir })
    const channel = reloaded.getChannel('chan-1')

    t.ok(channel)
    t.is(channel.ownerKey, 'owner-1')
    t.is(channel.retentionClass, 'private')
    t.is(channel.bytes, 2048)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus orders eviction candidates by retention class', async (t) => {
  const dir = makeTempDir('peartube-relay-status-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })

    await catalog.upsertChannel({
      channelKey: 'private-1',
      ownerKey: 'owner-private',
      source: 'config',
      retentionClass: 'private',
      bytes: 1024,
      mirroredAt: 100
    })

    await catalog.upsertChannel({
      channelKey: 'allow-1',
      ownerKey: 'owner-allow',
      source: 'config',
      retentionClass: 'allowlist',
      bytes: 2048,
      mirroredAt: 200
    })

    await catalog.upsertChannel({
      channelKey: 'discover-1',
      ownerKey: 'owner-discover',
      source: 'discovered',
      retentionClass: 'discovery',
      bytes: 4096,
      mirroredAt: 50
    })

    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { maxBytes: 16_384 }
      },
      catalog,
      runtimeStats: {
        peers: 2,
        connections: 1,
        feedPeers: 2,
        feedConnections: 2,
        feedEntries: 3
      }
    })

    t.is(status.summary.totalChannels, 3)
    t.is(status.summary.protectedChannels, 2)
    t.is(status.summary.usedBytes, 7168)
    t.is(status.runtime.peers, 2)
    t.is(status.runtime.feedPeers, 2)
    t.is(status.runtime.feedConnections, 2)
    t.is(status.runtime.feedChannelCandidates, 2)
    t.is(status.runtime.candidateConnections, 2)
    t.is(status.runtime.feedEntries, 3)
    t.is(status.evictionCandidates[0].channelKey, 'discover-1')
    t.is(status.evictionCandidates[1].channelKey, 'allow-1')
    t.is(status.evictionCandidates[2].channelKey, 'private-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus includes node roles and honest posture', async (t) => {
  const dir = makeTempDir('peartube-relay-status-posture-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })
    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache', 'archiver'],
        storage: { path: dir, maxBytes: 16_384 }
      },
      catalog,
      runtimeStats: {}
    })

    t.alike(status.roles, ['public-index', 'relay-cache', 'archiver'])
    t.alike(status.posture, {
      storesPublicMetadata: true,
      storesMediaCache: true,
      storesArchivePublisherContent: true,
      storesDecryptionKeys: false,
      nonKnowledgeRelay: false
    })

    const formatted = formatRelayStatus(status)
    t.ok(formatted.startsWith('roles: public-index,relay-cache,archiver\nposture: stores public metadata; stores public media cache; stores archive publisher content; stores no keys'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus includes moderation rule and quarantine summary', async (t) => {
  const dir = makeTempDir('peartube-relay-status-moderation-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })
    await catalog.upsertChannel({
      channelKey: 'chan-q',
      ownerKey: 'owner-q',
      source: 'discovered',
      retentionClass: 'discovery',
      moderation: {
        action: 'quarantine',
        state: 'quarantined',
        targetType: 'channelKey',
        target: 'chan-q'
      }
    })

    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 16_384 },
        moderation: {
          rules: [
            { targetType: 'channelKey', target: 'chan-block', action: 'block', source: 'local' },
            { targetType: 'ownerKey', target: 'owner-watch', action: 'watch', source: 'local' }
          ]
        }
      },
      catalog,
      runtimeStats: {}
    })

    t.alike(status.moderation, {
      rules: { allow: 0, block: 1, quarantine: 0, watch: 1 },
      quarantinedChannels: 1
    })

    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('moderation: blocked=1 quarantined=1 watched=1 allowed=0'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus includes active alert summary and latest alerts', async (t) => {
  const dir = makeTempDir('peartube-relay-status-alerts-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })
    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        roles: ['public-index', 'relay-cache'],
        storage: { path: dir, maxBytes: 16_384 }
      },
      catalog,
      alerts: [
        {
          id: 'alert-critical',
          severity: 'critical',
          category: 'moderation',
          targetType: 'channelKey',
          target: 'chan-q',
          summary: 'Quarantine applied to channelKey:chan-q',
          createdAt: 2000,
          suggestedActions: ['review', 'block']
        },
        {
          id: 'alert-info-acked',
          severity: 'info',
          category: 'posture',
          targetType: 'role',
          target: 'public-index',
          summary: 'Public index stores public metadata for discovery',
          createdAt: 1000,
          acknowledgedAt: 1500
        }
      ]
    })

    t.alike(status.alerts, {
      info: 0,
      warning: 0,
      critical: 1,
      unacknowledged: 1,
      latest: [
        {
          id: 'alert-critical',
          severity: 'critical',
          category: 'moderation',
          targetType: 'channelKey',
          target: 'chan-q',
          summary: 'Quarantine applied to channelKey:chan-q',
          createdAt: 2000,
          suggestedActions: ['review', 'block']
        }
      ]
    })

    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('alerts: critical=1 warning=0 info=0'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('withRelayAlerts refreshes alert counts on persisted status snapshots', async (t) => {
  const status = withRelayAlerts({
    mode: 'public',
    alerts: {
      info: 1,
      warning: 0,
      critical: 0,
      unacknowledged: 1,
      latest: [{ id: 'stale' }]
    }
  }, [
    {
      id: 'active-warning',
      severity: 'warning',
      category: 'moderation',
      targetType: 'channelKey',
      target: 'chan-watch',
      summary: 'Watched channelKey:chan-watch appeared in public feed gossip',
      createdAt: 2000
    },
    {
      id: 'acked-info',
      severity: 'info',
      category: 'posture',
      targetType: 'role',
      target: 'public-index',
      summary: 'Public index stores public metadata for discovery',
      createdAt: 1000,
      acknowledgedAt: 1500
    }
  ])

  t.is(status.mode, 'public')
  t.alike(status.alerts, {
    info: 0,
    warning: 1,
    critical: 0,
    unacknowledged: 1,
    latest: [
      {
        id: 'active-warning',
        severity: 'warning',
        category: 'moderation',
        targetType: 'channelKey',
        target: 'chan-watch',
        summary: 'Watched channelKey:chan-watch appeared in public feed gossip',
        createdAt: 2000
      }
    ]
  })
})

test('readRelayStatus returns persisted runtime stats when present', async (t) => {
  const dir = makeTempDir('peartube-relay-status-file-')
  const statusPath = join(dir, 'relay-status.json')

  try {
    const status = {
      runtime: {
        peers: 7,
        connections: 5,
        feedPeers: 4,
        feedConnections: 4,
        feedEntries: 12
      }
    }

    writeRelayStatus(statusPath, status)

    const loaded = readRelayStatus(statusPath)

    t.is(loaded.runtime.peers, 7)
    t.is(loaded.runtime.connections, 5)
    t.is(loaded.runtime.feedPeers, 4)
    t.is(loaded.runtime.feedConnections, 4)
    t.is(loaded.runtime.feedEntries, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus distinguishes feed candidates from open feed connections', async (t) => {
  const dir = makeTempDir('peartube-relay-status-feed-semantics-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })
    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 16_384 }
      },
      catalog,
      runtimeStats: {
        peers: 3,
        connections: 1,
        feedPeers: 4,
        feedConnections: 1,
        feedChannelCandidates: 4,
        candidateConnections: 4,
        rememberedPeerCandidates: 6,
        feedEntries: 5
      }
    })

    t.is(status.runtime.feedPeers, 4, 'legacy feedPeers field remains available')
    t.is(status.runtime.feedChannelCandidates, 4)
    t.is(status.runtime.candidateConnections, 4)
    t.is(status.runtime.feedConnections, 1)
    t.is(status.runtime.rememberedPeerCandidates, 6)

    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('feedPeerCandidates: 4'))
    t.ok(formatted.includes('feedConnections: 1'))
    t.ok(formatted.includes('rememberedPeerCandidates: 6'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('buildRelayStatus surfaces network doctor boundary diagnostics', async (t) => {
  const dir = makeTempDir('peartube-relay-status-doctor-')

  try {
    const catalog = await RelayCatalog.open({ storagePath: dir })
    const status = buildRelayStatus({
      config: {
        mode: 'public',
        policy: 'discovery',
        storage: { path: dir, maxBytes: 16_384 }
      },
      catalog,
      runtimeStats: {
        peers: 2,
        connections: 0,
        feedConnections: 0,
        doctor: {
          recommendedBoundary: 'transport-socket',
          discovery: { discoveredPeers: 2 },
          socket: { swarmConnections: 0 },
          feed: { feedConnections: 0 }
        }
      }
    })

    t.is(status.runtime.doctor.recommendedBoundary, 'transport-socket')
    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('doctor: boundary=transport-socket discovered=2 sockets=0 feedConnections=0'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
