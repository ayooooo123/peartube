import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRelayStatus, formatRelayStatus } from '../src/status.js'

const catalog = {
  getChannels: () => [],
  getSummary: () => ({ totalChannels: 0, protectedChannels: 0, usedBytes: 0 })
}

test('relay status exposes bounded universal publisher, bootstrap, asset, seed, and archive diagnostics', () => {
  const runtimeStats = {
    network: {
      peers: 2,
      connections: 1,
      dht: { bootstrapped: true, firewalled: false, online: true },
      offline: false,
      offlineReason: null,
      listenResolved: true
    },
    publisher: { catalogs: 3, followed: 2, lastErrorCode: null },
    bootstrap: { joined: true, locators: 4, rejected: 1, maxLocators: 64 },
    assets: { retainedRenditions: 5, activeSessions: 1, maxSessions: 8 },
    seedRetention: { activeSeeds: 6, pinnedChannels: 2, storageUsedBytes: 1024 },
    archive: { success: true, activePledgeCount: 2, healthyPledgeCount: 2, failedPledgeCount: 0 },
    storage: { success: true, totalCategorizedBytes: 2048, protectedBytes: 1024 }
  }

  const status = buildRelayStatus({
    config: { mode: 'public', policy: 'open', storage: { path: '/relay', maxBytes: 4096 } },
    catalog,
    runtimeStats,
    trustedClientsCount: 2
  })

  assert.deepEqual(status.runtime, {
    network: runtimeStats.network,
    publisher: runtimeStats.publisher,
    bootstrap: runtimeStats.bootstrap,
    assets: runtimeStats.assets,
    seedRetention: runtimeStats.seedRetention,
    archive: runtimeStats.archive,
    storage: runtimeStats.storage,
    // Re-seeding reports both directions; a relay with no diagnostics for
    // either says so with empty values rather than omitting the fields.
    archiveRequests: [],
    archiveParticipation: {},
    archiveHostDisk: {},
    authorizedClients: 2
  })
  assert.equal(Object.hasOwn(status.runtime, 'feedEntries'), false)
  assert.equal(Object.hasOwn(status.runtime, 'blindPeer'), false)

  const formatted = formatRelayStatus(status)
  assert.match(formatted, /publisher: catalogs=3 followed=2 lastError=none/)
  assert.match(formatted, /bootstrap: joined=true locators=4 rejected=1 limit=64/)
  assert.match(formatted, /assets: retainedRenditions=5 activeSessions=1 limit=8/)
  assert.match(formatted, /archive: active=2 healthy=2 failed=0/)
  assert.match(formatted, /seedRetention: activeSeeds=6 pinnedChannels=2 storageUsedBytes=1024/)
  assert.doesNotMatch(formatted, /feed|blind/i)
})
