// Archive custody with real bytes.
//
// The sibling `two-relay-p2p-replication.test.mjs` proves the discovery wire:
// request -> pledge -> challenge -> proof -> evidence, over fake swarms whose
// cores are mocks. That proves the protocol is wired, and nothing about whether
// a byte ever moved. This file uses real Corestores, real Hypercores holding
// real content, real replication, and real Merkle proofs, because "the relay
// mirrored it" is a claim about bytes on a disk, not about frames on a wire.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

const BLOCK_COUNT = 8
const BLOCK_BYTES = 1024

function bytes (length, fill) {
  return b4a.alloc(length, fill)
}

// Discovery is not what this file is about: these runtimes are driven directly,
// so the swarm only has to be inert and supply a stable transport key.
function inertSwarm (publicKey) {
  const swarm = new EventEmitter()
  swarm.keyPair = { publicKey, secretKey: bytes(32, 9) }
  swarm.connections = new Set()
  swarm.join = (topic, options) => ({
    topic: b4a.from(topic),
    options,
    async flushed () {},
    destroy () {},
  })
  return swarm
}

function blockAt (index) {
  return bytes(BLOCK_BYTES, index + 1)
}

async function heldBlocks (core) {
  let held = 0
  for (let index = 0; index < BLOCK_COUNT; index++) {
    if (await core.has(index)) held++
  }
  return held
}

// One publisher, plus however many peers the case needs, each on its own real
// Corestore, each replicating with the publisher over a real duplex pair.
async function createFixture (t, peerNames) {
  const dirs = new Map()
  const stores = new Map()
  const streams = []
  const runtimes = new Map()

  const publisherDir = mkdtempSync(join(tmpdir(), 'peartube-archive-publisher-'))
  dirs.set('publisher', publisherDir)
  const publisherStore = new Corestore(publisherDir)
  await publisherStore.ready()
  stores.set('publisher', publisherStore)

  const source = publisherStore.get({ name: 'rendition' })
  await source.ready()
  await source.append(Array.from({ length: BLOCK_COUNT }, (_, index) => blockAt(index)))

  for (const [offset, name] of peerNames.entries()) {
    const dir = mkdtempSync(join(tmpdir(), `peartube-archive-${name}-`))
    dirs.set(name, dir)
    const store = new Corestore(dir)
    await store.ready()
    stores.set(name, store)

    const initiator = publisherStore.replicate(true, { live: true })
    const responder = store.replicate(false, { live: true })
    initiator.pipe(responder).pipe(initiator)
    streams.push(initiator, responder)

    const runtime = createScopedNetworkRuntime({
      swarm: inertSwarm(bytes(32, 200 + offset)),
      store,
      initialNetworkPolicy: {
        networkEnabled: true,
        uploadPermission: 'enabled',
        uploadCeilingBytes: 1024 * 1024,
        archiveBudgetBytes: 1024 * 1024,
        diskCeilingBytes: 16 * 1024 * 1024,
        permissions: { archive: true },
        publicServingAllowed: true,
      },
    })
    await runtime.start()
    runtimes.set(name, runtime)
  }

  t.teardown(async () => {
    for (const runtime of runtimes.values()) await runtime.close().catch(() => {})
    for (const stream of streams) stream.destroy()
    for (const store of stores.values()) await store.close().catch(() => {})
    for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true })
  })

  return {
    source,
    coreKey: b4a.toString(source.key, 'hex'),
    runtime: name => runtimes.get(name),
    async core (name) {
      const core = stores.get(name).get({ key: source.key })
      await core.ready()
      return core
    },
  }
}

function pledgeFor (coreKey, { fill = 20, start = 0, end = BLOCK_COUNT } = {}) {
  const archivist = crypto.keyPair(bytes(32, fill))
  return createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: 'a'.repeat(64),
    renditionId: 'b'.repeat(64),
    ranges: [{ coreKey, start, end }],
    retentionUntil: Date.now() + 3_600_000,
    uploadCeilingBytes: 1024 * 1024,
    issuedAt: Date.now(),
    nonce: 'f'.repeat(64),
    keyPair: archivist,
  })
}

test('retaining an archive pledge actually moves the bytes onto the archivist', async (t) => {
  const fixture = await createFixture(t, ['archivist'])
  const pledge = pledgeFor(fixture.coreKey)

  const before = await fixture.core('archivist')
  t.is(await heldBlocks(before), 0, 'the archivist starts holding nothing')

  const retained = await fixture.runtime('archivist').retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
  })
  t.is(retained.status, 'retained')

  const core = await fixture.core('archivist')
  await core.download({ start: 0, end: BLOCK_COUNT }).done()
  t.is(await heldBlocks(core), BLOCK_COUNT, 'every pledged block is now on the archivist')

  // Held is not the same as correct. Compare the bytes themselves.
  for (const index of [0, 3, BLOCK_COUNT - 1]) {
    t.ok(b4a.equals(await core.get(index), blockAt(index)), `block ${index} is byte-identical to the source`)
  }
})

test('an auditor holding none of the content can still prove an archivist holds it', async (t) => {
  // This is the property that makes evidence-gated offload safe rather than
  // wishful: a relay that has deleted its own copy must still be able to tell
  // whether anyone else really has one. If this ever fails, "durability
  // evidence" means only that a peer once said yes.
  const fixture = await createFixture(t, ['archivist', 'auditor'])
  const pledge = pledgeFor(fixture.coreKey)

  await fixture.runtime('archivist').retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
  })
  // Exactly what ingestPledge does on the requesting side: register the
  // resource so proofs can be checked, without pulling a single block.
  await fixture.runtime('auditor').retainAuthorizedArchive({
    pledge,
    coreKey: fixture.coreKey,
    start: 0,
    end: BLOCK_COUNT,
    download: false,
  })

  const archivistCore = await fixture.core('archivist')
  await archivistCore.download({ start: 0, end: BLOCK_COUNT }).done()

  const auditorCore = await fixture.core('auditor')
  await auditorCore.update({ wait: true }).catch(() => {})

  t.is(await heldBlocks(archivistCore), BLOCK_COUNT, 'the archivist holds the content')
  t.is(await heldBlocks(auditorCore), 0, 'the auditor holds none of it')
  t.is(auditorCore.length, BLOCK_COUNT, 'but it does know the signed tree')

  const index = 5
  const proofBytes = await fixture.runtime('archivist').createAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey: fixture.coreKey,
    index,
  })
  t.ok(proofBytes.byteLength > 0, 'the archivist produced a real Merkle proof')

  t.is(
    await fixture.runtime('auditor').verifyAuthorizedArchiveChallengeProof({
      archiveId: pledge.pledgeId,
      coreKey: fixture.coreKey,
      index,
      proofBytes,
    }),
    true,
    'an auditor with no blocks verifies possession against the signed tree',
  )
})

test('a tampered or substituted possession proof is refused', async (t) => {
  const fixture = await createFixture(t, ['archivist', 'auditor'])
  const pledge = pledgeFor(fixture.coreKey)

  await fixture.runtime('archivist').retainAuthorizedArchive({ pledge, coreKey: fixture.coreKey, start: 0, end: BLOCK_COUNT })
  await fixture.runtime('auditor').retainAuthorizedArchive({ pledge, coreKey: fixture.coreKey, start: 0, end: BLOCK_COUNT, download: false })

  const archivistCore = await fixture.core('archivist')
  await archivistCore.download({ start: 0, end: BLOCK_COUNT }).done()

  const index = 5
  const auditor = fixture.runtime('auditor')
  const proofBytes = await fixture.runtime('archivist').createAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey: fixture.coreKey,
    index,
  })

  const flipped = b4a.from(proofBytes)
  flipped[flipped.byteLength - 1] ^= 0xff
  t.is(
    await auditor.verifyAuthorizedArchiveChallengeProof({ archiveId: pledge.pledgeId, coreKey: fixture.coreKey, index, proofBytes: flipped }),
    false,
    'a corrupted proof is refused',
  )

  // A proof of the wrong block is a real, valid proof — it just answers a
  // question nobody asked. Accepting it would let an archivist keep one block
  // and pass every challenge.
  const otherIndex = 2
  const otherProof = await fixture.runtime('archivist').createAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey: fixture.coreKey,
    index: otherIndex,
  })
  t.is(
    await auditor.verifyAuthorizedArchiveChallengeProof({ archiveId: pledge.pledgeId, coreKey: fixture.coreKey, index, proofBytes: otherProof }),
    false,
    'a valid proof of a different block does not answer this challenge',
  )

  t.is(
    await auditor.verifyAuthorizedArchiveChallengeProof({ archiveId: pledge.pledgeId, coreKey: fixture.coreKey, index, proofBytes: b4a.alloc(0) }),
    false,
    'an empty proof is refused',
  )
})

test('an archivist cannot prove or retain a block outside its pledged range', async (t) => {
  const fixture = await createFixture(t, ['archivist'])
  // Pledged only the first half of the rendition.
  const pledge = pledgeFor(fixture.coreKey, { start: 0, end: 4 })
  const archivist = fixture.runtime('archivist')

  await archivist.retainAuthorizedArchive({ pledge, coreKey: fixture.coreKey, start: 0, end: 4 })
  const core = await fixture.core('archivist')
  await core.download({ start: 0, end: 4 }).done()

  await t.exception(
    archivist.createAuthorizedArchiveChallengeProof({ archiveId: pledge.pledgeId, coreKey: fixture.coreKey, index: 6 }),
    /outside the retained pledge range/,
    'a block it never promised cannot be challenged out of it',
  )

  await t.exception(
    archivist.retainAuthorizedArchive({ pledge, coreKey: fixture.coreKey, start: 4, end: 8 }),
    /not pledge-authorized/,
    'and it cannot widen its own custody past the signed pledge',
  )
})
