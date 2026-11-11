// Backfill yields to viewers over LAN links.
// A seeder (with the HiveRelay bulk cap on), a replica relay running p2p-replicate against it at 64 Mbps (a bulk peer:
// it opens `hiverelay-seed` but never requests), and a plain viewer, all joined over LAN discovery. Backfill runs with
// no viewer and is never paused by the cap (the replica speaks `peartube/bulk-busy`), stops while the viewer streams,
// and resumes after; the viewer gets exact bytes.
// Writes a repeatable artifact to `desktop/target/e2e/bulk-yield-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { createTrafficGate } from '../src/traffic.js'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'
import { createLan } from '../src/lan.js'
import { mdnsBus } from './mdns.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-yield-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const BULK_MBPS = 16
const REPLICATE_MBPS = 64

async function until (fn, ms, label) {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await sleep(200)
  }
}

test('replica backfill over LAN stops while a viewer streams, then resumes', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const bus = mdnsBus()
  const lan = keyPair => createLan({ host: '127.0.0.1', keyPair, adapter: bus(s => s), dialAfter: 200 })
  const nodes = []
  const mirrors = []
  t.after(async () => {
    for (const m of mirrors) await m.close().catch(() => {})
    for (const n of nodes) await n.close().catch(() => {})
    await testnet.destroy()
  })

  const seederDir = tmp('seeder')
  const seeder = await createNode({ storage: seederDir, bootstrap: testnet.bootstrap, lan })
  nodes.push(seeder)
  const seederMirror = await createMirrorHost({ node: seeder, storage: seederDir, hiverelay: { uploadMbps: BULK_MBPS } })
  mirrors.push(seederMirror)

  const viewBytes = randomBytes(24 * 1024 * 1024)
  await seeder.publish({ id: 'imdb:tt0000101', title: 'Backfilled' }, Readable.from([randomBytes(256 * 1024 * 1024)]))
  const viewEntry = await seeder.publish({ id: 'imdb:tt0000102', title: 'Watched' }, Readable.from([viewBytes]))
  const tracker = seeder.status().tracker

  const replicaDir = tmp('replica')
  const replica = await createNode({ storage: replicaDir, bootstrap: testnet.bootstrap, tracker, lan })
  nodes.push(replica)
  const viewer = await createNode({ storage: tmp('viewer'), bootstrap: testnet.bootstrap, tracker, lan })
  nodes.push(viewer)

  const seedInfo = () => seederMirror.list().find(p => p.name === 'hiverelay-seed')
  await until(() => seeder.status().lanPeers >= 2, 60_000, 'replica and viewer on LAN links to the seeder')
  await until(async () => (await replica.search()).length >= 2, 60_000, 'replica synced the tracker')

  const replicaMirror = await createMirrorHost({
    node: replica,
    storage: replicaDir,
    replicate: true,
    replicateMinFreeBytes: 0,
    replicateMbps: REPLICATE_MBPS,
    hiverelay: { uploadMbps: BULK_MBPS }
  })
  mirrors.push(replicaMirror)
  await until(() => seedInfo()?.bulkPeers >= 1, 30_000, 'replica marked bulk over its LAN link')
  assert.equal(seedInfo().bulkPeers, 1, 'only the replica is bulk; the viewer is not')

  const replicated = () => replicaMirror.list().find(p => p.name === 'p2p-replicate')?.replicatedBytes || 0
  replicaMirror.run('p2p-replicate').catch(() => {})
  await until(() => replicated() > 0, 60_000, 'backfill started')
  const mbpsOver = async ms => {
    const before = replicated()
    await sleep(ms)
    return Math.round(((replicated() - before) * 8) / (ms * 1000) * 10) / 10
  }

  const idleMbps = await mbpsOver(6000)

  // Viewer: sequential 1 MiB Range requests, about 32 Mbps, for 9 s.
  let viewing = true
  const ranges = []
  const viewed = (async () => {
    const url = viewer.streamUrl(viewEntry)
    for (let off = 0; viewing && off < viewBytes.length; off += 1048576) {
      const last = Math.min(viewBytes.length, off + 1048576) - 1
      const res = await fetch(url, { headers: { Range: `bytes=${off}-${last}` } })
      const body = Buffer.from(await res.arrayBuffer())
      ranges.push({ status: res.status, ok: sha256(body) === sha256(viewBytes.subarray(off, last + 1)) })
      await sleep(250)
    }
  })()
  await sleep(1500)
  const viewingMbps = await mbpsOver(7000)
  viewing = false
  await viewed

  await sleep(4000)
  const resumedMbps = await mbpsOver(6000)

  const result = {
    bulkCapMbps: BULK_MBPS,
    idleMbps,
    viewingMbps,
    resumedMbps,
    viewerRanges: ranges.length,
    viewerExact: ranges.every(r => r.status === 206 && r.ok),
    seederLanPeers: seeder.status().lanPeers,
    bulkPeers: seedInfo().bulkPeers
  }
  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'bulk-yield-result.json'), JSON.stringify(result, null, 2))

  assert.ok(ranges.length >= 20, `viewer streamed throughout (${ranges.length} ranges)`)
  assert.ok(result.viewerExact, 'every viewer range is a 206 with exact bytes')
  assert.ok(idleMbps >= BULK_MBPS, `backfill runs above the HiveRelay cap with no viewer (${idleMbps} Mbps)`)
  assert.ok(viewingMbps <= 2, `backfill stops while the viewer streams (${viewingMbps} Mbps)`)
  assert.ok(resumedMbps >= BULK_MBPS, `backfill resumes after viewing stops (${resumedMbps} Mbps)`)
})

test('a busy claim holds backfill only when it comes from a peer that serves this node', { timeout: 60_000 }, async t => {
  const testnet = await createTestnet(3)
  const relay = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const peer = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const conns = new Set()
  const listeners = new Set()
  const sources = new Set()
  relay.on('connection', conn => {
    conn.on('error', () => {})
    conns.add(conn)
    conn.once('close', () => conns.delete(conn))
    for (const fn of listeners) fn(conn)
  })
  const gate = createTrafficGate({
    node: {
      privateRouting: false,
      peerConnections: () => conns,
      onConnection: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      isSourcePeer: hex => sources.has(hex)
    }
  })
  t.after(async () => {
    gate.stop()
    await peer.destroy({ force: true })
    await relay.destroy({ force: true })
    await testnet.destroy()
  })
  peer.on('connection', conn => {
    conn.on('error', () => {})
    const channel = Protomux.from(conn).createChannel({ protocol: 'peartube/bulk-busy', id: null })
    const busy = channel.addMessage({ encoding: c.uint })
    channel.open()
    busy.send(1)
  })
  await relay.listen()
  peer.joinPeer(relay.keyPair.publicKey)

  const peerKey = peer.keyPair.publicKey.toString('hex')
  sources.add(peerKey)
  await until(() => gate.peersBusy(), 20_000, 'the claim of a peer that serves this node holds backfill')
  sources.delete(peerKey)
  assert.equal(gate.peersBusy(), false, 'the same claim from a peer that serves nothing is ignored')
})
