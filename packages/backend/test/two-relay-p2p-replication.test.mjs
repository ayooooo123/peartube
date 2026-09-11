// The relay-to-relay archive discovery wire, end to end across two runtimes:
// request -> pledge -> challenge -> proof -> offload evidence.
//
// The swarms are fakes, but both peers use real Corestores. The holder's bytes
// cross only the archive transport, and the receiving peer verifies the real
// Hypercore proof before publishing offload evidence.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPermissionlessArchiveNetwork,
  createArchivePolicy,
} from '../src/archive/index.js'
import { writeStaticAsset, ASSET_BLOCK_SIZE } from '../src/assets/static-core.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { evaluateParticipation } from '../src/playback/resource-policy.js'
import { createArchiveParticipationApi } from '../src/api/archive-participation.js'

const BLOCK_COUNT = 8

function bytes (length, fill) {
  const buf = b4a.alloc(length)
  if (fill !== undefined) buf.fill(fill)
  return buf
}

const transportIdA = bytes(32, 201)
const transportIdB = bytes(32, 202)

function connectionPair () {
  // Protomux channels are framed messages. Keep each frame as one stream
  // value so a same-tick channel open cannot be coalesced into a byte buffer.
  const streamOptions = { objectMode: true }
  const aToB = new PassThrough(streamOptions)
  const bToA = new PassThrough(streamOptions)
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = transportIdB
  b.remotePublicKey = transportIdA
  a.once('close', () => { if (!b.destroyed) b.destroy() })
  b.once('close', () => { if (!a.destroyed) a.destroy() })
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
      destroyed: 0,
      async flushed () {},
      destroy () { handle.destroyed = (handle.destroyed || 0) + 1 },
      async suspend () {},
      async resume () {},
    }
    swarm.joins.push(handle)
    return handle
  }
  return swarm
}

async function createFixture (t) {
  const holderDir = mkdtempSync(join(tmpdir(), 'peartube-two-relay-holder-'))
  const requesterDir = mkdtempSync(join(tmpdir(), 'peartube-two-relay-requester-'))
  const holderStore = new Corestore(holderDir)
  const requesterStore = new Corestore(requesterDir)
  await holderStore.ready()
  await requesterStore.ready()

  const sourceBytes = b4a.alloc(BLOCK_COUNT * ASSET_BLOCK_SIZE)
  for (let index = 0; index < BLOCK_COUNT; index++) {
    sourceBytes.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  }
  const asset = await writeStaticAsset({
    store: holderStore,
    reader: createBufferSourceReader(sourceBytes),
  })
  const holderCore = asset.core
  const coreRef = normalizeAssetCoreRefV2(asset.descriptor)
  const requesterCore = requesterStore.get({
    key: b4a.from(coreRef.key, 'hex'),
    manifest: coreRef.hypercoreManifest,
  })
  await requesterCore.ready()

  const swarmA = fakeSwarm({ publicKey: transportIdA, secretKey: bytes(32, 1) })
  const swarmB = fakeSwarm({ publicKey: transportIdB, secretKey: bytes(32, 2) })
  const serverPolicy = {
    networkEnabled: true,
    uploadPermission: 'enabled',
    publicServingAllowed: true,
    uploadCeilingBytes: 10 * 1024 * 1024 * 1024,
    archiveBudgetBytes: 10 * 1024 * 1024 * 1024,
    contributionBudgetBytes: 10 * 1024 * 1024 * 1024,
    permissions: { archive: true, contribute: true },
  }
  const scopedA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => requesterCore },
    initialNetworkPolicy: serverPolicy,
  })
  const scopedB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => holderCore },
    initialNetworkPolicy: serverPolicy,
  })
  await scopedA.start()
  await scopedB.start()

  t.teardown(async () => {
    await scopedA.close().catch(() => {})
    await scopedB.close().catch(() => {})
    await holderStore.close().catch(() => {})
    await requesterStore.close().catch(() => {})
    rmSync(holderDir, { recursive: true, force: true })
    rmSync(requesterDir, { recursive: true, force: true })
  })

  return { swarmA, swarmB, scopedA, scopedB, coreRef, coreKey: coreRef.key }
}

test('two relays carry a publication API request to verified offload evidence over the discovery wire', async (t) => {
  const keyPairA = crypto.keyPair(bytes(32, 10))
  const keyPairB = crypto.keyPair(bytes(32, 20))
  const publicationId = 'a'.repeat(64)
  const renditionId = 'b'.repeat(64)
  const { swarmA, swarmB, scopedA, scopedB, coreRef, coreKey } = await createFixture(t)

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
    authorizeRequest: async (req) => ({ accepted: true, requestedBytes: req.body.requestedBytes, ranges: req.body.ranges, coreRef }),
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
    authorizeRequest: async (req) => ({ accepted: true, requestedBytes: req.body.requestedBytes, ranges: req.body.ranges, coreRef }),
    authorizeConsumerVisibility: async () => true,
  })

  await networkA.ready
  await networkB.ready

  const pair = connectionPair()
  t.teardown(() => {
    pair.a.destroy()
    pair.b.destroy()
  })
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: false })
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: true })

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 20))
  }

  const archiveApi = createArchiveParticipationApi({
    archiveNetwork: networkA,
    manifestStore: {
      async getManifest(id) {
        return id === publicationId
          ? { body: { renditions: [{ renditionId, core: coreRef }] } }
          : null
      },
    },
  })
  const reqResult = await archiveApi.requestArchivePublication({ publicationId, renditionId })
  t.is(reqResult.success, true, 'the public API admits the manifest-backed immutable archive request')

  t.is(reqResult.status, 'published')

  for (let i = 0; i < 20; i++) {
    if (networkA.getStatus().receivedPledges >= 1) break
    await new Promise(r => setTimeout(r, 50))
  }

  const requesterStatus = await archiveApi.getArchiveParticipation({})
  const holderStatus = await createArchiveParticipationApi({ archiveNetwork: networkB }).getArchiveParticipation({})
  t.is(requesterStatus.knownRequests, 1, 'public status reports the registered publication request')
  t.is(requesterStatus.receivedPledges, 1, 'public status reports the received signed pledge')
  t.is(holderStatus.acceptedRequests, 1, 'public status reports the holder admission')
  t.is(holderStatus.reservedBytes, coreRef.byteLength, 'public status reports exact pledged bytes')

  const challengeCycleResult = await networkA.runChallengeCycle()
  t.is(challengeCycleResult.status, 'published', 'Relay A issued possession challenge')

  for (let i = 0; i < 20; i++) {
    if (networkA.getOffloadEvidence(publicationId, [{ coreKey, start: 0, end: coreRef.length }]).length >= 1) break
    await new Promise(r => setTimeout(r, 50))
  }

  const evidence = networkA.getOffloadEvidence(publicationId, [{ coreKey, start: 0, end: coreRef.length }])
  t.is(evidence.length, 1, 'Relay A verified offload evidence')
  if (evidence[0]) {
    t.is(evidence[0].passed, true, 'Possession proof passed')
    t.is(evidence[0].connected, true, 'Relay B is connected as a peer')
    t.is(evidence[0].recent, true, 'Evidence timestamp is fresh')
  }

  await networkA.close()
  await networkB.close()
})
