import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import Autobee from 'autobee'
import Corestore from 'corestore'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { makeApply } from '../src/apply.js'
import { decodeOp, isSystemViewKey } from '../src/protocol.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-acl-'))
const zero = '0'.repeat(64)
const blob = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
const announce = (id, title) => ({ type: 'announce', id, title, size: 1, sha256: zero, blobs: zero, blob })

async function until (fn, ms = 120_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

function makeMockView (initialEntries = []) {
  const map = new Map(initialEntries.map(([k, v]) => [k, b4a.isBuffer(v) ? v : b4a.from(String(v))]))
  const scanCalls = []
  return {
    map,
    scanCalls,
    async get (key) {
      const k = b4a.toString(key)
      return map.has(k) ? { key: b4a.from(k), value: map.get(k) } : null
    },
    write () {
      const pending = []
      return {
        tryPut (k, v) { pending.push(['put', b4a.toString(k), v]) },
        tryDelete (k) { pending.push(['del', b4a.toString(k)]) },
        async flush () {
          for (const [kind, k, v] of pending) {
            if (kind === 'put') map.set(k, v)
            else map.delete(k)
          }
        }
      }
    },
    createReadStream (opts) {
      scanCalls.push(opts || null)
      const gte = opts?.gte ? b4a.toString(opts.gte) : null
      const lt = opts?.lt ? b4a.toString(opts.lt) : null
      const entries = [...map.entries()]
        .filter(([k]) => (gte === null || k >= gte) && (lt === null || k < lt))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => ({ key: b4a.from(k), value: v }))
      return (async function * () {
        for (const entry of entries) yield entry
      })()
    }
  }
}

test('ungranted stranger is blocked on an ownerless channel while the founder can still publish', async t => {
  // Direct apply-gate proof on an ownerless view (no meta/owner): founder succeeds, stranger is rejected without addWriter.
  const chHex = '1'.repeat(64)
  const strangerUnitHex = '2'.repeat(64)
  const unitApply = makeApply(() => chHex)
  const unitAdded = []
  const unitView = makeMockView([])
  await unitApply([
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify(announce('imdb:tt0000100', 'Founder Unit'))) },
    { key: b4a.from(strangerUnitHex, 'hex'), value: b4a.from(JSON.stringify(announce('imdb:tt0000998', 'Stranger Unit Hijack'))) }
  ], unitView, {
    async addWriter (key) { unitAdded.push(b4a.toString(key, 'hex')) },
    async removeWriter () {}
  })
  assert.deepEqual(unitAdded, [], 'ungranted stranger must never be auto-granted on an ownerless channel')
  assert.equal(unitView.map.has(`imdb:tt0000100/${chHex}/${zero}:0`), true, 'founder can still publish without meta/owner')
  assert.equal(unitView.map.has(`imdb:tt0000998/${strangerUnitHex}/${zero}:0`), false, 'stranger announce rejected on ownerless channel')
  assert.equal(unitView.map.has(`writer/${strangerUnitHex}`), false, 'stranger gets no writer record on ownerless channel')

  const founderStore = new Corestore(tmp())
  const strangerStore = new Corestore(tmp())
  let founder = null
  let stranger = null
  t.after(async () => {
    await stranger?.close()
    await founder?.close()
    await strangerStore.close()
    await founderStore.close()
  })

  // Raw Autobee channel with no `meta/owner` record (legacy pre-vault channel).
  founder = new Autobee(founderStore.namespace('tracker'), null, {
    apply: makeApply(() => b4a.toString(founder.key, 'hex')),
    optimistic: true,
    fastForward: false
  })
  await founder.ready()
  const founderHex = b4a.toString(founder.key, 'hex')

  // Founder can publish even without `meta/owner`.
  await founder.append(b4a.from(JSON.stringify(announce('imdb:tt0000101', 'Founder First'))))
  await founder.updated()
  assert.equal(await founder.view.get(b4a.from('meta/owner')), null, 'channel has no meta/owner')
  assert.ok(await founder.view.get(b4a.from(`imdb:tt0000101/${founderHex}/${zero}:0`)), 'founder entry accepted')

  stranger = new Autobee(strangerStore.namespace('tracker'), founder.key, {
    apply: makeApply(() => founderHex),
    optimistic: true,
    fastForward: false
  })
  await stranger.ready()
  const strangerHex = b4a.toString(stranger.local.key, 'hex')

  const s1 = founderStore.replicate(true)
  const s2 = strangerStore.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.after(() => { s1.destroy(); s2.destroy() })

  await until(async () => {
    await stranger.update()
    return Boolean(await stranger.view.get(b4a.from(`imdb:tt0000101/${founderHex}/${zero}:0`)))
  }, 30_000, 'stranger syncs founder entry')

  // Ungranted stranger appends an optimistic announce to the ownerless channel.
  await stranger.append(b4a.from(JSON.stringify(announce('imdb:tt0000999', 'Stranger Hijack'))), { optimistic: true })
  await founder.append(b4a.from(JSON.stringify(announce('imdb:tt0000102', 'Founder Second'))))
  await founder.updated()

  await until(async () => {
    await stranger.update()
    await founder.update()
    return Boolean(await stranger.view.get(b4a.from(`imdb:tt0000102/${founderHex}/${zero}:0`)))
  }, 30_000, 'both peers converge after stranger optimistic append')

  assert.equal(await founder.view.get(b4a.from('meta/owner')), null, 'channel remains ownerless')
  assert.equal(await founder.view.get(b4a.from(`imdb:tt0000999/${strangerHex}/${zero}:0`)), null, 'stranger announce rejected on founder')
  assert.equal(await stranger.view.get(b4a.from(`imdb:tt0000999/${strangerHex}/${zero}:0`)), null, 'stranger announce rejected on stranger')
  assert.equal(await founder.view.get(b4a.from(`writer/${strangerHex}`)), null, 'stranger was never auto-granted writer role')
  assert.equal(stranger.writable, false, 'stranger remains non-writable')
  assert.ok(await founder.view.get(b4a.from(`imdb:tt0000102/${founderHex}/${zero}:0`)), 'founder keeps publishing cleanly')
})

test('v0.5.0-compatible revoke purge + epoch rotation and opt-in weighted owner indexer', async t => {
  // Protocol invariants: grant.indexer validated; view keyspace remains v0.5.0-compatible (no byWriter/ divergence).
  assert.equal(isSystemViewKey('writer/abc'), true)
  assert.equal(decodeOp(JSON.stringify({ type: 'grant', writer: zero, role: 'owner', indexer: true }))?.indexer, true)
  assert.equal(decodeOp(JSON.stringify({ type: 'grant', writer: zero, role: 'owner', indexer: 1 })), null)

  // Unit proof of weighted multi-indexer gating and complete revoke purge without extra view keys in apply.js.
  const chHex = 'a'.repeat(64)
  const wHex = 'b'.repeat(64)
  const modHex = 'c'.repeat(64)
  const owner2Hex = 'd'.repeat(64)
  const srcKey = 'e'.repeat(64)
  const apply = makeApply(() => chHex)

  const added = []
  const removed = []
  const host = {
    async addWriter (key, opts) { added.push({ key: b4a.toString(key, 'hex'), isIndexer: Boolean(opts?.isIndexer) }) },
    async removeWriter (key) { removed.push(b4a.toString(key, 'hex')) }
  }

  // Seed a pre-upgrade legacy entry for wHex alongside newly applied entries to prove mixed-age revoke purges all.
  const legacyAnnKey = `imdb:tt0000299/${wHex}/${zero}:0`
  const view = makeMockView([
    ['meta/epoch', '1'],
    [legacyAnnKey, JSON.stringify(announce('imdb:tt0000299', 'Legacy Writer Entry'))]
  ])
  await apply([
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify({ type: 'grant', writer: wHex, role: 'writer', indexer: true })) },
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify({ type: 'grant', writer: modHex, role: 'mod', indexer: true })) },
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify({ type: 'grant', writer: owner2Hex, role: 'owner', indexer: true })) },
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify(announce('imdb:tt0000300', 'Owner Kept'))) },
    { key: b4a.from(wHex, 'hex'), value: b4a.from(JSON.stringify(announce('imdb:tt0000301', 'Writer One'))) },
    { key: b4a.from(wHex, 'hex'), value: b4a.from(JSON.stringify({ type: 'source', sourceKey: srcKey, kind: 'channel', title: 'Writer Source' })) }
  ], view, host)

  assert.deepEqual(added, [
    { key: wHex, isIndexer: false },
    { key: modHex, isIndexer: false },
    { key: owner2Hex, isIndexer: true }
  ], 'only role=owner with indexer=true is promoted as Autobase indexer')

  const wAnnKey = `imdb:tt0000301/${wHex}/${zero}:0`
  const wSrcKey = `source/${wHex}/${srcKey}`
  assert.equal([...view.map.keys()].some(k => k.startsWith('byWriter/')), false, 'view stays byte-compatible with v0.5.0 peers')

  // Revoke wHex with purgeEntries: purges BOTH legacy pre-upgrade and newly applied entries while preserving owner entries.
  await apply([
    { key: b4a.from(chHex, 'hex'), value: b4a.from(JSON.stringify({ type: 'revoke', writer: wHex, purgeEntries: true })) }
  ], view, host)

  assert.equal(view.map.has(legacyAnnKey), false, 'pre-upgrade legacy entry purged')
  assert.equal(view.map.has(wAnnKey), false, 'new writer announce purged')
  assert.equal(view.map.has(wSrcKey), false, 'writer source purged')
  assert.equal(view.map.has(`imdb:tt0000300/${chHex}/${zero}:0`), true, 'founder entry untouched')
  assert.deepEqual(removed, [wHex])

  // End-to-end node verification of revokeWriter(b, { purgeEntries: true, rotateEpoch: true }) and grantWriter({ role: 'owner', indexer: true })
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  const b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  t.after(async () => { await c.close(); await b.close(); await a.close(); await testnet.destroy() })

  const bHex = b.status().writer
  const cHex = c.status().writer
  const grantB = await a.grantWriter(bHex, { role: 'writer', alias: 'guest', indexer: true })
  assert.equal(grantB.indexer, false, 'non-owner writer cannot be promoted to indexer')
  const grantC = await a.grantWriter(cHex, { role: 'owner', alias: 'backup-relay', indexer: true })
  assert.equal(grantC.indexer, true, 'owner relay promoted with indexer=true')

  await until(() => b.channel.writable && c.channel.writable, 60_000, 'b and c become writable')
  await until(() => c.channel.isIndexer === true, 60_000, 'c becomes an Autobase indexer')
  assert.equal(b.channel.isIndexer, false, 'b stays a non-indexer writer')

  await a.publish({ id: 'imdb:tt0000500', title: 'Owner Film' }, Readable.from([randomBytes(512)]))
  const bRemoved = await b.publish({ id: 'imdb:tt0000501', title: 'B Self Deleted' }, Readable.from([randomBytes(512)]))
  await b.publish({ id: 'imdb:tt0000502', title: 'B Revoked Purged' }, Readable.from([randomBytes(512)]))
  await until(async () => (await a.search('imdb:tt0000501')).length === 1 && (await a.search('imdb:tt0000502')).length === 1, 60_000, 'owner sees b publishes')

  await b.remove(bRemoved.key)
  await until(async () => (await a.search('imdb:tt0000501')).length === 0, 60_000, 'b remove synced')

  assert.equal((await a.identity()).epoch, 1)
  const rev = await a.revokeWriter(bHex, { purgeEntries: true, rotateEpoch: true })
  assert.equal(rev.revoked, true)
  assert.equal(rev.purgeEntries, true)
  assert.equal(rev.rotateEpoch, true)
  assert.equal(rev.epoch, 2)
  assert.ok(rev.accessUri?.startsWith(`peartube://access/${tracker}:2:`), 'returns rotated epoch access URI')

  assert.equal((await a.identity()).epoch, 2, 'channel epoch advanced from 1 -> 2 via standard epoch op')
  await until(async () => (await c.identity()).epoch === 2, 60_000, 'co-owner c converges on rotated epoch 2')
  assert.equal((await a.search('imdb:tt0000502')).length, 0, 'B entry purged on revoke')
  assert.equal((await a.search('imdb:tt0000500')).length, 1, 'owner entry preserved')
})

test('worklet follower fast-forwards sparsely without eagerly downloading full landed cores', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  let w = null
  const probes = []
  t.after(async () => {
    for (const p of probes) await p.close().catch(() => {})
    await w?.close()
    await a.close()
    await testnet.destroy()
  })

  // Past Autobee's 16-flush fast-forward threshold with superseded historical blocks in both system and view cores.
  for (let i = 0; i < 30; i++) {
    await a.append(announce(`imdb:tt${7500000 + i}`, `Sparse Title ${i}`))
  }
  for (let i = 0; i < 15; i++) {
    await a.remove(`imdb:tt${7500000 + i}/${tracker}/${zero}:0`)
  }
  assert.ok(a.channel.flushes >= 45)
  const [ownerSys, ownerView] = a.channel.views()
  assert.ok(ownerSys.length >= 40 && ownerView.length >= 40, 'owner system and view cores have substantial history')

  w = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, worklet: true })
  const landedKeys = []
  w.channel.on('move-to', to => landedKeys.push(b4a.toString(to.key, 'hex')))

  await until(() => w.channel.stats.fastForwards >= 1, 120_000, 'worklet fast-forward landing')
  assert.deepEqual(landedKeys, [b4a.toString(ownerSys.key, 'hex')], 'worklet landed on owner system view')

  // Normal search API reads live channel entries cleanly on the worklet.
  const hits = await until(async () => {
    const res = await w.search('imdb:tt7500029')
    return res.length === 1 ? res : null
  }, 60_000, 'worklet search reads entry cleanly')
  assert.equal(hits[0].title, 'Sparse Title 29')
  assert.equal((await w.search(null, { limit: 100 })).length, 15, 'worklet sees all 15 live entries')

  // Give any hypothetical background download(0, -1) time to complete over local loopback.
  await new Promise(resolve => setTimeout(resolve, 1500))

  const wSys = w.store.get({ key: ownerSys.key, active: false })
  const wView = w.store.get({ key: ownerView.key, active: false })
  probes.push(wSys, wView)
  await wSys.ready()
  await wView.ready()

  assert.ok(
    wSys.contiguousLength < ownerSys.length,
    `expected sparse landed system core on worklet, got contiguous ${wSys.contiguousLength}/${ownerSys.length}`
  )
  assert.ok(
    wView.contiguousLength < ownerView.length,
    `expected sparse landed view core on worklet, got contiguous ${wView.contiguousLength}/${ownerView.length}`
  )
})
