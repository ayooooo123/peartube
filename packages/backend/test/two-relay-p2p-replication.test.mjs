// The relay-to-relay archive discovery wire, end to end across two runtimes:
// request -> pledge -> challenge -> proof -> offload evidence.
//
// The cores here are mocks and the swarms are fakes, so this proves the
// protocol is wired correctly and NOTHING about whether a byte moved. Real
// byte custody and real Merkle proofs are covered separately, against real
// Corestores, in `archive-real-byte-custody.test.mjs` — keep the two honest
// about which question each one answers.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'

import {
  createPermissionlessArchiveNetwork,
  createArchivePolicy,
  createArchiveRequest,
} from '../src/archive/index.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { evaluateParticipation } from '../src/playback/resource-policy.js'

function bytes (length, fill) {
  const buf = b4a.alloc(length)
  if (fill !== undefined) buf.fill(fill)
  return buf
}

const transportIdA = bytes(32, 201)
const transportIdB = bytes(32, 202)

function connectionPair () {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = transportIdB
  b.remotePublicKey = transportIdA
  return { a, b }
}

function fakeSwarm (keyPair) {
  const swarm = new EventEmitter()
  swarm.keyPair = keyPair
  swarm.connections = new Set()
  swarm.joins = []
  swarm.join = (topic, options) => {
    const handle = {
      topic: b4a.from(topic),
      options,
      async flushed () {},
      destroy () { handle.destroyed = (handle.destroyed || 0) + 1 },
    }
    swarm.joins.push(handle)
    return handle
  }
  return swarm
}

function mockCore () {
  return {
    ready: async () => {},
    length: 8,
    has: async () => true,
    proof: async ({ block }) => ({ block: { index: block.index, value: bytes(64, 9) } }),
    verifyFullyRemote: async () => true,
    download: () => {},
  }
}

test('two relays carry a pledge from request to verified offload evidence over the discovery wire', async (t) => {
  const keyPairA = crypto.keyPair(bytes(32, 10))
  const keyPairB = crypto.keyPair(bytes(32, 20))
  const publicationId = 'a'.repeat(64)
  const renditionId = 'b'.repeat(64)
  const coreKey = 'c'.repeat(64)

  const swarmA = fakeSwarm({ publicKey: transportIdA, secretKey: bytes(32, 1) })
  const swarmB = fakeSwarm({ publicKey: transportIdB, secretKey: bytes(32, 2) })

  const scopedA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => mockCore() },
  })
  const scopedB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => mockCore() },
  })

  await scopedA.start()
  await scopedB.start()

  const decision = evaluateParticipation({
    hostKind: 'server',
    mode: 'balanced',
    userAllowsP2P: true,
    freeDiskBytes: 100 * 1024 * 1024 * 1024,
    totalDiskBytes: 500 * 1024 * 1024 * 1024,
    archiveOptIn: true,
  })

  const archivePolicyA = createArchivePolicy({ capacityBytes: 10 * 1024 * 1024 * 1024, participation: () => decision })
  const archivePolicyB = createArchivePolicy({ capacityBytes: 10 * 1024 * 1024 * 1024, participation: () => decision })

  const networkA = createPermissionlessArchiveNetwork({
    keyPair: keyPairA,
    scopedNetwork: scopedA,
    archivePolicy: archivePolicyA,
    enabled: true,
    capacityBytes: 10 * 1024 * 1024 * 1024,
    maxRequestBytes: 10 * 1024 * 1024 * 1024,
    acceptanceProbability: 1,
    authorizeRequest: async (req) => ({ accepted: true, requestedBytes: req.body.requestedBytes, ranges: req.body.ranges }),
    authorizeConsumerVisibility: async () => true,
  })

  const networkB = createPermissionlessArchiveNetwork({
    keyPair: keyPairB,
    scopedNetwork: scopedB,
    archivePolicy: archivePolicyB,
    enabled: true,
    capacityBytes: 10 * 1024 * 1024 * 1024,
    maxRequestBytes: 10 * 1024 * 1024 * 1024,
    acceptanceProbability: 1,
    authorizeRequest: async (req) => ({ accepted: true, requestedBytes: req.body.requestedBytes, ranges: req.body.ranges }),
    authorizeConsumerVisibility: async () => true,
  })

  await networkA.ready
  await networkB.ready

  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: false })
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: true })

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 20))
  }

  const reqResult = await networkA.requestArchive({
    publicationId,
    renditionId,
    ranges: [{ coreKey, start: 0, end: 8 }],
    requestedBytes: 4096,
  })

  t.is(reqResult.status, 'published')

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 50))
  }

  t.is(networkA.getStatus().receivedPledges, 1, 'Relay A received pledge from Relay B')
  t.is(networkB.getStatus().acceptedRequests, 1, 'Relay B accepted request from Relay A')
  t.is(networkB.getStatus().reservedBytes, 4096, 'Relay B reserved bytes for pledged storage')

  const challengeCycleResult = await networkA.runChallengeCycle()
  t.is(challengeCycleResult.status, 'published', 'Relay A issued possession challenge')

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 50))
  }

  const evidence = networkA.getOffloadEvidence(publicationId, [{ coreKey, start: 0, end: 8 }])
  t.is(evidence.length, 1, 'Relay A verified offload evidence')
  t.is(evidence[0].passed, true, 'Possession proof passed')
  t.is(evidence[0].connected, true, 'Relay B is connected as a peer')
  t.is(evidence[0].recent, true, 'Evidence timestamp is fresh')

  await networkA.close()
  await networkB.close()
  await scopedA.close()
  await scopedB.close()
})
