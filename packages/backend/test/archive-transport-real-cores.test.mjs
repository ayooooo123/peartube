// The archive transport carrying real Hypercore blocks.
//
// `archive-real-byte-custody.test.mjs` pipes `store.replicate()` between the
// peers, so hypercore's own replicator moves the bytes and this transport never
// runs. `scoped-network-runtime.test.mjs` does run the transport, but against
// mock cores whose `applyProof` just records what it was handed. Between them a
// served proof was never verified by a real Hypercore, and for a long time none
// of them could be: a peer that opens a core from its key alone has no manifest
// and rejects every proof with INVALID_SIGNATURE.
//
// So this file connects two runtimes over a duplex pair, gives each a real
// Corestore, and lets nothing but the archive frames move the content.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

const BLOCK_COUNT = 4
const BLOCK_BYTES = 512

function bytes (size, fill) {
  return b4a.alloc(size, fill)
}

function blockAt (index) {
  return bytes(BLOCK_BYTES, index + 1)
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function connectionPair () {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, 201)
  b.remotePublicKey = bytes(32, 202)
  return { a, b }
}

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.join = () => ({
    destroyed: 0,
    flushed: async () => {},
    destroy () { this.destroyed++ },
    async suspend () {},
    async resume () {},
  })
  return swarm
}

const policy = {
  networkEnabled: true,
  uploadPermission: 'enabled',
  uploadCeilingBytes: 1024 * 1024,
  archiveBudgetBytes: 1024 * 1024,
  diskCeilingBytes: 16 * 1024 * 1024,
  permissions: { archive: true },
  publicServingAllowed: true,
}

// Two real Corestores that never replicate with each other. The holder has the
// content; the archivist only ever learns the core key.
async function createFixture (t) {
  const holderDir = mkdtempSync(join(tmpdir(), 'peartube-archive-holder-'))
  const archivistDir = mkdtempSync(join(tmpdir(), 'peartube-archive-peer-'))
  const holderStore = new Corestore(holderDir)
  const archivistStore = new Corestore(archivistDir)
  await holderStore.ready()
  await archivistStore.ready()

  const source = holderStore.get({ name: 'rendition' })
  await source.ready()
  await source.append(Array.from({ length: BLOCK_COUNT }, (_, index) => blockAt(index)))

  const archivistCore = archivistStore.get({ key: source.key })
  await archivistCore.ready()

  const swarmHolder = fakeSwarm()
  const swarmArchivist = fakeSwarm()
  const holder = createScopedNetworkRuntime({
    swarm: swarmHolder,
    store: { get: () => source },
    initialNetworkPolicy: policy,
  })
  const archivist = createScopedNetworkRuntime({
    swarm: swarmArchivist,
    store: { get: () => archivistCore },
    initialNetworkPolicy: policy,
  })
  await holder.start()
  await archivist.start()

  const pair = connectionPair()
  swarmHolder.connections.add(pair.a)
  swarmArchivist.connections.add(pair.b)
  swarmHolder.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmArchivist.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()

  t.teardown(async () => {
    await holder.close().catch(() => {})
    await archivist.close().catch(() => {})
    pair.a.destroy()
    pair.b.destroy()
    await holderStore.close().catch(() => {})
    await archivistStore.close().catch(() => {})
    rmSync(holderDir, { recursive: true, force: true })
    rmSync(archivistDir, { recursive: true, force: true })
  })

  return { source, archivistCore, holder, archivist, coreKey: b4a.toString(source.key, 'hex') }
}

function pledgeFor (coreKey) {
  const keyPair = crypto.keyPair(bytes(32, 31))
  return createArchivePledge({
    archivistId: keyPair.publicKey,
    publicationId: 'a'.repeat(64),
    renditionId: 'b'.repeat(64),
    ranges: [{ coreKey, start: 0, end: BLOCK_COUNT }],
    retentionUntil: Date.now() + 3_600_000,
    uploadCeilingBytes: 1024 * 1024,
    issuedAt: Date.now(),
    nonce: 'f'.repeat(64),
    keyPair,
  })
}

async function heldBlocks (core) {
  let held = 0
  for (let index = 0; index < BLOCK_COUNT; index++) if (await core.has(index)) held++
  return held
}

test('archive blocks served over the transport verify on a peer that only knows the core key', async (t) => {
  const fixture = await createFixture(t)
  const pledge = pledgeFor(fixture.coreKey)

  t.is(await heldBlocks(fixture.archivistCore), 0, 'the archivist starts holding nothing')

  await fixture.holder.retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
    download: false,
  })
  await fixture.archivist.retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
  })

  for (let attempt = 0; attempt < 60 && await heldBlocks(fixture.archivistCore) < BLOCK_COUNT; attempt++) {
    await settle()
  }

  t.is(await heldBlocks(fixture.archivistCore), BLOCK_COUNT, 'every pledged block landed on the archivist')
  for (const index of [0, BLOCK_COUNT - 1]) {
    t.ok(
      b4a.equals(await fixture.archivistCore.get(index), blockAt(index)),
      `block ${index} is byte-identical to the source`
    )
  }
  t.is(fixture.archivistCore.length, BLOCK_COUNT, 'the served proof upgraded the archivist tree, not just its blocks')
})

test('the archivist can prove possession of a transported block to an auditor holding nothing', async (t) => {
  const fixture = await createFixture(t)
  const pledge = pledgeFor(fixture.coreKey)

  await fixture.holder.retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
    download: false,
  })
  await fixture.archivist.retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
  })
  for (let attempt = 0; attempt < 60 && await heldBlocks(fixture.archivistCore) < BLOCK_COUNT; attempt++) {
    await settle()
  }
  t.is(await heldBlocks(fixture.archivistCore), BLOCK_COUNT)

  // The proof is generated from bytes the archivist only ever received over the
  // archive transport, and checked by the holder acting as auditor.
  const proofBytes = await fixture.archivist.createAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey: fixture.coreKey,
    index: 1,
  })
  t.ok(await fixture.holder.verifyAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey: fixture.coreKey,
    index: 1,
    proofBytes,
  }), 'the auditor accepts a possession proof over transported bytes')
})
