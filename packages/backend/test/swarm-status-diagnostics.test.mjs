import assert from 'node:assert/strict'
import test from 'node:test'

import { createApi } from '../src/api.js'
import { buildSharedSystemHandlers } from '../src/runtime.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'
import { PROTOCOL_VERSION } from '../../host/src/contracts.js'

const FULL_SWARM_STATUS = {
  swarmConnections: 0,
  swarmPeers: 5,
  channelsLoaded: 2,
  swarmOffline: false,
  swarmOfflineReason: null,
  swarmListenResolved: true,
  peerPoolJoined: true,
  recommendedBoundary: 'transport-socket',
  network: {
    hyperswarm: {
      recentConnections: [{ type: 'client-attempt' }],
      allConnections: [{ key: 'peer' }],
    },
  },
  startupTiming: { storage: { elapsedMs: 123 } },
  doctor: {
    recommendedBoundary: 'transport-socket',
    discovery: { discoveredPeers: 5 },
  },
}

test('shared runtime GetSwarmStatus forwards scoped transport diagnostics', async () => {
  const handlers = buildSharedSystemHandlers(
    { api: { getSwarmStatus: () => FULL_SWARM_STATUS } },
    { protocolVersion: PROTOCOL_VERSION }
  )
  const result = await handlers.GetSwarmStatus()

  assert.equal(result.recommendedBoundary, 'transport-socket')
  assert.deepEqual(result.network, FULL_SWARM_STATUS.network)
  assert.deepEqual(result.startupTiming, FULL_SWARM_STATUS.startupTiming)
  assert.deepEqual(result.doctor, FULL_SWARM_STATUS.doctor)
})

test('mobile GetSwarmStatus forwards scoped transport diagnostics', async () => {
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
})

test('backend swarm status reports scoped discovery and locally opened channels', () => {
  const api = createApi({
    ctx: {
      channels: new Map([['first', {}], ['second', {}]]),
      swarm: {
        connections: new Set([{}]),
        peers: new Map(),
        keyPair: { publicKey: Buffer.alloc(32, 1) },
      },
    },
  })

  const status = api.getSwarmStatus()

  assert.equal('feedEntries' in status, false)
  assert.equal(status.channelsLoaded, 2)
  assert.equal(status.doctor.recommendedBoundary, 'content-playback-or-ui')
  assert.deepEqual(status.scopedTopics.map(topic => topic.role), ['bootstrap'])
  assert.equal(typeof status.scopedTopics[0].topicHex, 'string')
  assert.equal(status.scopedTopics[0].descriptorDigest, undefined)
})
