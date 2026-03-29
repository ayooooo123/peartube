import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayCatalog } from '../src/catalog.js'
import { buildRelayStatus, readRelayStatus, writeRelayStatus } from '../src/status.js'

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
    t.is(status.runtime.feedEntries, 3)
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
