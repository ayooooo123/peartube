import assert from 'node:assert/strict'
import test from 'node:test'
import { Duplex, PassThrough } from 'node:stream'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import HRPC from '../../spec/spec/hrpc/index.js'
import { createProtocolClient } from '../../host/src/create-client.js'
import { PROTOCOL_VERSION } from '../../host/src/contracts.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-session-runtime.js'
import { buildSharedSystemHandlers } from '../src/runtime.js'
import { attachMobileHandlers } from '../src/mobile-handlers.js'

import { createStatusApi } from '../src/api/status.js'

async function createWireFixture(t, adapter) {
  const swarm = new Hyperswarm({ bootstrap: [] })
  let scopedNetwork
  let streams
  t.after(async () => {
    for (const stream of streams || []) stream.destroy()
    await scopedNetwork?.close()
    await swarm.destroy()
  })
  if (swarm.dht.bootstrapNodes.length !== 0) throw new Error('External bootstrap is forbidden in this fixture')
  scopedNetwork = createScopedNetworkRuntime({
    swarm,
    store: { get() { throw new Error('Diagnostics must not open content') } },
    networkId: 'peartube-status-wire-test',
  })
  const ctx = { swarm, scopedNetwork }
  const api = createStatusApi({ ctx })
  let getSwarmStatus
  if (adapter === 'shared') {
    getSwarmStatus = buildSharedSystemHandlers({ api }, { protocolVersion: PROTOCOL_VERSION }).GetSwarmStatus
  } else {
    const backend = {}
    attachMobileHandlers(backend, { api, ctx })
    getSwarmStatus = backend.getSwarmStatus
  }
  const aToB = new PassThrough({ objectMode: true })
  const bToA = new PassThrough({ objectMode: true })
  streams = [
    Duplex.from({ readable: bToA, writable: aToB }),
    Duplex.from({ readable: aToB, writable: bToA }),
  ]
  const server = new HRPC(streams[1])
  server.onGetStatus(() => ({ status: { ready: true, protocolVersion: PROTOCOL_VERSION } }))
  server.onGetSwarmStatus(getSwarmStatus)
  const client = createProtocolClient({ stream: streams[0] })
  await client.ready()
  return { scopedNetwork, client }
}

for (const adapter of ['shared', 'mobile']) {
  test(`${adapter} wire status tracks real scoped discovery lifecycle`, { timeout: 10000 }, async t => {
    const { scopedNetwork, client } = await createWireFixture(t, adapter)
    const purposes = async () => (await client.system.getSwarmStatus()).network.topics.map(topic => topic.purpose)

    assert.deepEqual(await purposes(), [])
    await scopedNetwork.start()
    assert.deepEqual(await purposes(), ['bootstrap'])
    await scopedNetwork.close()
    assert.deepEqual(await purposes(), [])
  })
}

test('status fallback exposes bootstrap discovery, not private channel descriptors', () => {
  const marker = 'private-status-descriptor'
  const api = createStatusApi({
    ctx: { channels: new Map([['private-channel', { descriptorDigest: marker }]]) },
  })
  const status = api.getSwarmStatus()

  assert.equal('feedEntries' in status, false)
  assert.deepEqual(status.scopedTopics.map(topic => topic.role), ['bootstrap'])
  assert.equal(status.scopedTopics[0].descriptorDigest, undefined)
  assert.equal(JSON.stringify(status).includes(marker), false)
})

test('diagnostics follows connection stages without relying on legacy peer history', () => {
  const swarm = {
    dht: { bootstrapped: false },
    peers: new Map(),
    connections: new Set(),
  }
  const api = createStatusApi({ ctx: { swarm } })
  const boundary = () => api.getSwarmStatus().doctor.recommendedBoundary

  assert.equal(boundary(), 'dht-bootstrap')

  swarm.dht.bootstrapped = true
  assert.equal(boundary(), 'peer-discovery')

  swarm.peers.set('discovered-peer', {})
  assert.equal(boundary(), 'transport-socket')

  swarm.connections.add({})
  assert.equal(boundary(), 'content-playback-or-ui')
})

test('diagnostics retains transport failures while the peer list is empty during backoff', async () => {
  // Execute the private boundary without adding a test-only production export.
  const url = new URL(`../src/api/.status-boundary-${randomUUID()}.mjs`, import.meta.url)
  const source = fs.readFileSync(new URL('../src/api/status.js', import.meta.url), 'utf8')
  fs.writeFileSync(url, `${source}\nexport { calculateRecommendedBoundary }\n`, { flag: 'wx' })
  try {
    const { calculateRecommendedBoundary } = await import(url.href)
    const socket = { swarmConnections: 0, swarmPeers: 0, recentConnections: [] }
    const boundary = () => calculateRecommendedBoundary({ discoveredPeers: 0 }, { bootstrapped: true }, socket)
    assert.equal(boundary(), 'peer-discovery')

    socket.recentConnections.push({
      type: 'client-attempt',
      events: [{ event: 'error', error: { code: 'HOLEPUNCH_ABORTED' } }],
    })
    assert.equal(boundary(), 'transport-socket')
  } finally {
    fs.unlinkSync(url)
  }
})
