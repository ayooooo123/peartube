import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRelayStatus, formatRelayStatus } from '../src/status.js'

const catalog = {
  getChannels: () => [{}, {}, {}],
  getSummary: () => ({ totalChannels: 3, protectedChannels: 1, usedBytes: 999 })
}

test('relay status exposes the bounded policy-v2 contract without protected runtime material', () => {
  const protectedValues = {
    publisherId: 'publisher-secret-id',
    indexerId: 'indexer-secret-alpha',
    key: 'secret-public-key-material',
    path: '/private/relay/storage',
    url: 'https://secret.example/media',
    callbackOrigin: 'https://callback.secret.example'
  }
  const runtimeStats = {
    network: {
      status: 'active',
      peers: 2,
      connections: 1,
      offline: false,
      lastErrors: ['network_timeout', protectedValues.url],
      sourceUrl: protectedValues.url
    },
    publisher: {
      catalogs: 3,
      lastErrorCode: 'PUBLISH_FAILED',
      publisherId: protectedValues.publisherId,
      publicKey: protectedValues.key
    },
    assets: {
      activeUploads: 1,
      uploadedBytes: 512,
      localPath: protectedValues.path,
      capability: protectedValues.key
    },
    archive: {
      activePledgeCount: 2,
      archiveKey: protectedValues.key
    },
    seedRetention: {
      retention: {
        contributionUsedBytes: 123,
        archiveUsedBytes: 456,
        storagePath: protectedValues.path
      }
    },
    policy: {
      policyVersion: 2,
      consentVersion: 7,
      migrationRequired: false,
      effectiveRole: 'archive-enabled',
      permissions: { contribute: true, archive: true },
      contributionBudgetBytes: 4096,
      archiveBudgetBytes: 8192,
      selectedIndexers: [
        protectedValues.indexerId,
        'indexer-secret-beta',
        'indexer-secret-gamma',
        'indexer-secret-delta',
        'indexer-secret-epsilon',
        'indexer-secret-zeta',
        'indexer-secret-eta',
        'indexer-secret-theta',
        'indexer-secret-overflow'
      ],
      callbackOrigin: protectedValues.callbackOrigin
    }
  }
  const ingestStatus = {
    activeAcquisitions: 2,
    jobsByState: {
      queued: 2,
      acquiring: 1,
      verifying: 0,
      publishing: 1,
      completed: 9,
      failed: 1,
      cancelled: 1
    },
    lastErrors: ['source_failed', protectedValues.callbackOrigin]
  }

  const status = buildRelayStatus({
    config: {
      mode: 'public',
      policy: 'open',
      storage: { path: protectedValues.path, maxBytes: 16_384 },
      callbackOrigin: protectedValues.callbackOrigin
    },
    catalog,
    runtimeStats,
    ingestStatus,
    creators: [{
      videosArchived: 4,
      videosUnseeded: 2,
      classification: { movie: 1, tv: 3 },
      publisherId: protectedValues.publisherId
    }],
    trustedClientsCount: 2
  })

  assert.deepEqual(status.effectivePolicy, {
    policyVersion: 2,
    consentVersion: 7,
    migrationRequired: false,
    effectiveRole: 'archive-enabled',
    permissions: { contribute: true, archive: true }
  })
  assert.deepEqual(status.budgets, {
    contribution: { configuredBytes: 4096, usedBytes: 123 },
    archive: { configuredBytes: 8192, usedBytes: 456 }
  })
  assert.deepEqual(status.publicWork, {
    activeAnnouncements: 5,
    activeUploads: 1,
    uploadedBytes: 512,
    activeAcquisitions: 2,
    jobsByState: {
      queued: 2,
      acquiring: 1,
      verifying: 0,
      publishing: 1,
      completed: 9,
      failed: 1,
      cancelled: 1
    }
  })
  assert.deepEqual(status.selectedIndexers, [
    'selected-1',
    'selected-2',
    'selected-3',
    'selected-4',
    'selected-5',
    'selected-6',
    'selected-7',
    'selected-8'
  ])
  assert.deepEqual(status.lastErrors, ['SOURCE_FAILED', 'NETWORK_TIMEOUT', 'PUBLISH_FAILED'])
  assert.deepEqual(status.network, {
    status: 'active',
    peers: 2,
    connections: 1,
    offline: false
  })
  assert.deepEqual(status.summary, {
    totalChannels: 3,
    protectedChannels: 1,
    evictableChannels: 2,
    usedBytes: 999
  })
  assert.deepEqual(status.creators, {
    totalCreators: 1,
    videosArchived: 4,
    videosUnseeded: 2,
    classifiedMovies: 1,
    classifiedTv: 3
  })
  assert.equal(status.authorizedClients, 2)
  assert.equal(Object.hasOwn(status, 'runtime'), false)

  const serialized = JSON.stringify(status)
  for (const value of Object.values(protectedValues)) assert.equal(serialized.includes(value), false)
  assert.equal(serialized.includes('indexer-secret-beta'), false)
  assert.equal(serialized.includes('indexer-secret-overflow'), false)

  assert.equal(formatRelayStatus(status), [
    'mode: public',
    'role: archive-enabled migrationRequired=false consentVersion=7',
    'permissions: contribute=true archive=true',
    'contributionBudget: 123/4096 bytes',
    'archiveBudget: 456/8192 bytes',
    'publicWork: announcements=5 uploads=1 uploadedBytes=512 acquisitions=2',
    'jobs: queued=2 acquiring=1 verifying=0 publishing=1 completed=9 failed=1 cancelled=1',
    'network: status=active peers=2 connections=1 offline=false',
    'channels: total=3 protected=1 evictable=2',
    'selectedIndexers: selected-1,selected-2,selected-3,selected-4,selected-5,selected-6,selected-7,selected-8',
    'lastErrors: SOURCE_FAILED,NETWORK_TIMEOUT,PUBLISH_FAILED',
    'authorizedClients: 2',
    'creators: total=1 archived=4 unseeded=2'
  ].join('\n'))
})
