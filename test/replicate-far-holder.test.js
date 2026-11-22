// The holder publishes a film and announces its content topic.
// The pointer owns a different channel that lists the film but holds none of its bytes.
// The follower joins that channel, but its channel connection cannot supply the film.
// The follower and holder share no channel, so replication must discover the content topic.
// After the pass and holder shutdown, the follower's disk is read without fetching.
// The pass gives the film 120 s: the follower must first find the holder and connect to it, which can take several dials on a loopback testnet.
// The result is written to desktop/target/e2e/replicate-far-holder-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'

const STALL_MS = 120_000
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-far-holder-${label}-`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const connected = (a, b) => [...a.peerConnections()].some(c => c.remotePublicKey && Buffer.from(c.remotePublicKey).toString('hex') === b.peerKey)

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await sleep(200)
  }
}

async function readLocal (node, op) {
  const core = node.store.get({ key: Buffer.from(op.blobs, 'hex'), active: false })
  try {
    await core.ready()
    const parts = []
    for (let i = op.blob.blockOffset; i < op.blob.blockOffset + op.blob.blockLength; i++) {
      const block = await core.get(i, { wait: false })
      if (!block) return { missingBlock: i, bytes: null }
      parts.push(block)
    }
    return { missingBlock: -1, bytes: Buffer.concat(parts) }
  } finally {
    await core.close().catch(() => {})
  }
}

test('a relay copies a followed film from a holder it shares no channel with', { timeout: 540_000 }, async t => {
  const testnet = await createTestnet(3)
  let holder, pointer, follower, mirror
  t.after(async () => {
    if (mirror) await mirror.close().catch(() => {})
    if (follower) await follower.close().catch(() => {})
    if (pointer) await pointer.close().catch(() => {})
    if (holder) await holder.close().catch(() => {})
    await testnet.destroy()
  })

  holder = await createNode({ storage: tmp('holder'), bootstrap: testnet.bootstrap })
  const bytes = randomBytes(700 * 1024 + 13)
  const op = await holder.publish({ id: 'imdb:tt0002001', title: 'Held far away' }, Readable.from([bytes]))
  assert.equal(op.blob.blockLength, 2, 'premise: the published film spans two blocks')
  await holder.swarm.flush()
  assert.deepEqual((await readLocal(holder, op)).bytes, bytes, 'premise: the local reader returns what publish stored')

  pointer = await createNode({ storage: tmp('pointer'), bootstrap: testnet.bootstrap })
  await pointer.publishChannel({ id: op.id, title: op.title, blobs: op.blobs, blob: op.blob, size: op.size, sha256: op.sha256 })
  assert.match(pointer.status().tracker, /^[0-9a-f]{64}$/, 'premise: the pointer has a tracker key')

  const followerDir = tmp('follower')
  follower = await createNode({ storage: followerDir, bootstrap: testnet.bootstrap, tracker: pointer.status().tracker })
  await until(async () => (await follower.search()).some(item => item.id === op.id), 120_000, 'the follower to list the film')
  await until(() => connected(follower, pointer), 60_000, 'the follower to connect to the pointer')
  assert.equal(connected(follower, holder), false, 'premise: the follower is not connected to the holder')
  assert.equal(connected(holder, follower), false, 'premise: the holder is not connected to the follower')

  const startedAt = Date.now()
  mirror = await createMirrorHost({ node: follower, storage: followerDir, acquirer: null, replicate: true, replicateMinFreeBytes: 0, replicateStallMs: STALL_MS, pollIntervalMs: 0 })
  const info = await until(() => {
    const state = mirror.list().find(p => p.name === 'p2p-replicate')
    return state && state.replicating === false && state.totalEntries === 1 && state
  }, 300_000, 'the replicate pass to end')
  const report = { ...info }
  const passMs = Date.now() - startedAt
  const reachedHolder = connected(follower, holder)

  await holder.close()
  const local = await readLocal(follower, op)
  const result = {
    ok: local.missingBlock === -1 && local.bytes !== null && local.bytes.equals(bytes),
    size: bytes.length,
    blocks: op.blob.blockLength,
    stallMs: STALL_MS,
    passMs,
    report: {
      totalEntries: report.totalEntries,
      replicatedEntries: report.replicatedEntries,
      replicatedBytes: report.replicatedBytes,
      targetBytes: report.targetBytes,
      skippedUnavailable: report.skippedUnavailable
    },
    followerReachedHolder: reachedHolder,
    missingBlock: local.missingBlock
  }
  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'replicate-far-holder-result.json'), JSON.stringify(result, null, 2))

  assert.equal(local.missingBlock, -1, `block ${local.missingBlock} of the film is not stored on the follower's disk after the pass ended and the holder closed; the follower had a connection to the holder when the pass ended: ${reachedHolder}; pass report: ${JSON.stringify(report)}`)
  assert.ok(local.bytes.equals(bytes), "the follower's local bytes equal the published bytes")
  assert.equal(report.replicatedEntries, 1, 'the pass reports the film it copied')
  assert.equal((await readLocal(pointer, op)).missingBlock, op.blob.blockOffset, "premise: the tracker's owner never held a byte of the film")
})
