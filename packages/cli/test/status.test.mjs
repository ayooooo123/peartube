import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayCatalog } from '../src/catalog.js'
import { buildRelayStatus, formatRelayStatus, readRelayStatus, writeRelayStatus } from '../src/status.js'

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
        network: { peers: 2, connections: 1, offline: false },
        publisher: { catalogs: 2, followed: 1 },
        assets: { retainedRenditions: 3 }
      }
    })

    t.is(status.summary.totalChannels, 3)
    t.is(status.summary.protectedChannels, 2)
    t.is(status.summary.usedBytes, 7168)
    t.is(status.runtime.network.peers, 2)
    t.is(status.runtime.network.connections, 1)
    t.is(status.runtime.publisher.catalogs, 2)
    t.is(status.runtime.publisher.followed, 1)
    t.is(status.runtime.assets.retainedRenditions, 3)
    t.is(status.evictionCandidates[0].channelKey, 'discover-1')
    t.is(status.evictionCandidates[1].channelKey, 'allow-1')
    t.is(status.evictionCandidates[2].channelKey, 'private-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readRelayStatus returns persisted runtime stats when present', async (t) => {
  const dir = makeTempDir('peartube-relay-status-file-')
  const statusPath = join(dir, 'relay-status.json')

  try {
    const status = {
      runtime: {
        network: { peers: 7, connections: 5 },
        publisher: { catalogs: 4 },
        assets: { retainedRenditions: 12 }
      }
    }

    writeRelayStatus(statusPath, status)

    const loaded = readRelayStatus(statusPath)

    t.is(loaded.runtime.network.peers, 7)
    t.is(loaded.runtime.network.connections, 5)
    t.is(loaded.runtime.publisher.catalogs, 4)
    t.is(loaded.runtime.assets.retainedRenditions, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildRelayStatus preserves scoped network and publisher diagnostics', async (t) => {
  const dir = makeTempDir('peartube-relay-status-scoped-semantics-')

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
        network: { peers: 3, connections: 1, offline: false },
        publisher: { catalogs: 4, followed: 2, lastErrorCode: null },
        bootstrap: { joined: true, locators: 6, rejected: 1, maxLocators: 32 },
        assets: { retainedRenditions: 5, activeSessions: 2, maxSessions: 8 }
      }
    })

    t.is(status.runtime.network.peers, 3)
    t.is(status.runtime.publisher.catalogs, 4)
    t.is(status.runtime.bootstrap.locators, 6)
    t.is(status.runtime.assets.activeSessions, 2)

    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('network: peers=3 connections=1 offline=false'))
    t.ok(formatted.includes('publisher: catalogs=4 followed=2 lastError=none'))
    t.ok(formatted.includes('bootstrap: joined=true locators=6 rejected=1 limit=32'))
    t.ok(formatted.includes('assets: retainedRenditions=5 activeSessions=2 limit=8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('buildRelayStatus surfaces scoped DHT boundary diagnostics', async (t) => {
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
        network: {
          peers: 2,
          connections: 0,
          offline: true,
          offlineReason: 'transport-unreachable',
          listenResolved: true,
          dht: { bootstrapped: true, firewalled: true, online: false }
        }
      }
    })

    t.is(status.runtime.network.offlineReason, 'transport-unreachable')
    const formatted = formatRelayStatus(status)
    t.ok(formatted.includes('network: peers=2 connections=0 offline=true reason=transport-unreachable listenResolved=true'))
    t.ok(formatted.includes('dht: bootstrapped=true firewalled=true online=false'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
