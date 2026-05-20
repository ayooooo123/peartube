import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSharedSystemHandlers } from '../src/runtime.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'

const FULL_SWARM_STATUS = {
  swarmConnections: 0,
  swarmPeers: 5,
  feedConnections: 0,
  feedEntries: 0,
  channelsLoaded: 2,
  swarmOffline: false,
  swarmOfflineReason: null,
  swarmListenResolved: true,
  peerPoolJoined: true,
  publicFeedDiscoveryJoined: true,
  feedTopicHex: 'abcd',
  recommendedBoundary: 'transport-socket',
  network: {
    hyperswarm: {
      recentConnections: [{ type: 'client-attempt' }],
      allConnections: [{ key: 'peer' }],
    },
  },
  startupTiming: { storage: { elapsedMs: 123 }, publicFeed: { elapsedMs: 45 } },
  doctor: {
    recommendedBoundary: 'transport-socket',
    feed: {
      directPeerDial: {
        discoveredPeers: 5,
        swarmConnecting: 3,
      },
    },
  },
}

test('shared runtime GetSwarmStatus forwards full transport diagnostics', async () => {
  const handlers = buildSharedSystemHandlers({ api: { getSwarmStatus: () => FULL_SWARM_STATUS } })
  const result = await handlers.GetSwarmStatus()

  assert.equal(result.recommendedBoundary, 'transport-socket')
  assert.deepEqual(result.network, FULL_SWARM_STATUS.network)
  assert.deepEqual(result.startupTiming, FULL_SWARM_STATUS.startupTiming)
  assert.deepEqual(result.doctor, FULL_SWARM_STATUS.doctor)
  assert.deepEqual(result.directPeerDial, FULL_SWARM_STATUS.doctor.feed.directPeerDial)
})

test('mobile GetSwarmStatus forwards full transport diagnostics', async () => {
  const backend = {}
  const rpc = {}
  attachMobileHandlers(backend, {
    api: { getSwarmStatus: async () => FULL_SWARM_STATUS },
    identityManager: { getActiveIdentity: () => null },
    uploadManager: {},
    ctx: {},
    rpc,
    fs: null,
    path: null,
    storagePath: '/tmp/peartube-test',
    generateAndStoreThumbnail: async () => null,
  })

  const result = await backend.getSwarmStatus()

  assert.equal(result.recommendedBoundary, 'transport-socket')
  assert.deepEqual(result.network, FULL_SWARM_STATUS.network)
  assert.deepEqual(result.startupTiming, FULL_SWARM_STATUS.startupTiming)
  assert.deepEqual(result.doctor, FULL_SWARM_STATUS.doctor)
  assert.deepEqual(result.directPeerDial, FULL_SWARM_STATUS.doctor.feed.directPeerDial)
})
