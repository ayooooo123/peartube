// A relay copies a library of more than 24 film cores, also when one listed title has no holder.
// A seeder publishes 25 films, each in its own core, and lists one more title whose core nobody holds.
// The pass takes the cores that it knows no length and no peer for in key order, and that title's key
// is the smallest, so the pass waits 45 s on it before the films that come after it. The node keeps 24
// film cores open and closes the oldest, and Hypercore keeps the peer of a core with no open session
// for only 20-40 s: a pass that goes on using a session the node closed copies nothing of that film.
// After the pass ends and the seeder closes, every film is read from the follower's own disk with a
// read that cannot fetch, and compared byte for byte.
// Writes desktop/target/e2e/replicate-many-films-result.json, also when blocks are missing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'

const FILMS = 25
const STALL_MS = 45_000
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-replicate-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

test('a relay copies every film of a library with more than 24 cores, past a title that no peer holds', { timeout: 480_000 }, async t => {
  const testnet = await createTestnet(3)
  let seeder
  let follower
  let mirror
  t.after(async () => {
    if (mirror) await mirror.close().catch(() => {})
    if (follower) await follower.close().catch(() => {})
    if (seeder) await seeder.close().catch(() => {})
    await testnet.destroy()
  })

  seeder = await createNode({ storage: tmp('seeder'), bootstrap: testnet.bootstrap })
  const films = []
  for (let i = 1; i <= FILMS; i++) {
    const number = String(i).padStart(2, '0')
    const bytes = randomBytes(2048 + i)
    const op = await seeder.publish({ id: `imdb:tt00010${number}`, title: `Film ${number}` }, Readable.from([bytes]))
    films.push({ op, bytes })
  }
  assert.equal(new Set(films.map(({ op }) => op.blobs)).size, FILMS, 'premise: each film has a distinct core')
  assert.ok(films.every(({ op }) => op.blob.blockOffset === 0), 'premise: each film starts at block zero')
  assert.deepEqual((await readLocal(seeder, films[0].op)).bytes, films[0].bytes, 'premise: the local reader returns what publish stored')

  const deadKey = '00000000' + randomBytes(28).toString('hex')
  assert.ok(films.every(({ op }) => deadKey < op.blobs), 'premise: the title that nobody holds has the smallest core key, so the pass tries it first')
  await seeder.publishChannel({
    id: 'imdb:tt0001099',
    title: 'Listed, held by nobody',
    blobs: deadKey,
    blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 4096 },
    size: 4096,
    sha256: sha256(randomBytes(32))
  })

  const followerDir = tmp('follower')
  follower = await createNode({ storage: followerDir, bootstrap: testnet.bootstrap, tracker: seeder.status().tracker })
  const ids = [...films.map(({ op }) => op.id), 'imdb:tt0001099']
  await until(async () => {
    const listed = new Set((await follower.search()).map(item => item.id))
    return ids.every(id => listed.has(id))
  }, 120_000, 'the follower to list all titles')

  const handed = new Map()
  const blobCore = follower.blobCore
  follower.blobCore = async hex => {
    const sessions = handed.get(hex) || []
    handed.set(hex, sessions)
    try {
      const core = await blobCore(hex)
      sessions.push(core)
      return core
    } catch (err) {
      sessions.push({ closed: true, openError: err.message })
      throw err
    }
  }

  const startedAt = Date.now()
  mirror = await createMirrorHost({
    node: follower,
    storage: followerDir,
    acquirer: null,
    replicate: true,
    replicateMinFreeBytes: 0,
    replicateStallMs: STALL_MS,
    pollIntervalMs: 0
  })
  const info = await until(() => {
    const state = mirror.list().find(p => p.name === 'p2p-replicate')
    return state && !state.replicating && state.totalEntries === FILMS + 1 && state
  }, 300_000, 'the replicate pass to end')
  const report = { ...info }
  const passMs = Date.now() - startedAt
  const closedSessions = new Map(films.map(({ op }) => [op.blobs, (handed.get(op.blobs) || []).some(c => c.closed)]))

  await seeder.close()
  const problems = []
  for (const { op, bytes } of films) {
    const local = await readLocal(follower, op)
    const prefix = `${op.id} (core ${op.blobs.slice(0, 8)})`
    if (local.bytes === null) {
      problems.push(`${prefix}: block ${local.missingBlock} is not stored locally; the session that the pass used on this core was closed: ${closedSessions.get(op.blobs)}`)
    } else if (!local.bytes.equals(bytes)) {
      problems.push(`${prefix}: the local bytes differ from the published bytes`)
    }
  }
  const result = {
    ok: problems.length === 0,
    films: FILMS,
    listedTitles: FILMS + 1,
    stallMs: STALL_MS,
    passMs,
    report: {
      totalEntries: report.totalEntries,
      replicatedEntries: report.replicatedEntries,
      replicatedBytes: report.replicatedBytes,
      targetBytes: report.targetBytes,
      skippedUnavailable: report.skippedUnavailable
    },
    sessionsClosedBeforePassEnd: [...closedSessions.values()].filter(Boolean).length,
    problems
  }
  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'replicate-many-films-result.json'), JSON.stringify(result, null, 2))

  assert.equal(problems.length, 0, `${problems.length} of ${FILMS} films are not whole on the follower's disk after the pass ended and the seeder closed:\n${problems.join('\n')}\npass report: ${JSON.stringify(report)}`)
  assert.equal(report.skippedUnavailable, 1, 'premise: the pass waited for the one title that no peer holds')
  assert.equal(report.replicatedEntries, FILMS, 'the pass reports every film it copied')
  assert.ok(passMs >= STALL_MS, 'premise: the pass lasted longer than Hypercore keeps the peer of a closed core')
})
