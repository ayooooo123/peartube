import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Autobee from 'autobee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { createNode } from '../src/index.js'
import { makeApply } from '../src/apply.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-test-'))

async function until (fn, ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const zero = '0'.repeat(64)
const blob = { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 }
const announce = (id, title) => ({ type: 'announce', id, title, size: 1, sha256: zero, blobs: zero, blob })

// A forger M far past Autobee's fast-forward distance, whose apply plants an entry under A's key.
// `role` is the role A grants M first ('writer' or 'mod'; none for a stranger); M is never an owner.
// `ownerOffline` takes A down before the new relay joins, so M is the only peer and the only stamp on offer.
async function forgerScenario (t, { role = null, ownerOffline = false }) {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  await a.publish({ id: 'imdb:tt0000001', title: 'Honest' }, Readable.from([randomBytes(100)]))

  const forgedKey = `imdb:tt6666666/${a.status().writer}/${zero}:0`
  const forged = JSON.stringify(announce('imdb:tt6666666', 'Forged'))
  async function forgingApply (nodes, view, host) {
    for (const node of nodes) {
      await host.addWriter(node.key, { isIndexer: false })
      const w = view.write()
      w.tryPut(Buffer.from(forgedKey), Buffer.from(forged))
      await w.flush()
    }
  }
  const mStore = new Corestore(tmp())
  const m = new Autobee(mStore.namespace('tracker'), Buffer.from(tracker, 'hex'), { apply: forgingApply, optimistic: true })
  await m.ready()
  if (role) await a.grantWriter(m.local.key.toString('hex'), { role })
  const mSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  mSwarm.on('connection', conn => m.replicate(conn))
  mSwarm.join(m.discoveryKey)
  let c = null
  let aClosed = false
  t.after(async () => { await c?.close(); if (!aClosed) await a.close(); await mSwarm.destroy(); await m.close(); await mStore.close(); await testnet.destroy() })

  // Well past the 16-flush fast-forward distance, each write durable and stamped with M's views.
  for (let i = 0; i <= 40; i++) {
    const before = m.local.length
    await m.append(Buffer.from(JSON.stringify(announce(`imdb:tt${5000000 + i}`, 'M'))), { optimistic: !m.writable })
    while (m.local.length <= before) { await new Promise(resolve => setTimeout(resolve, 300)); await m.update() }
  }
  assert.ok(await m.view.get(Buffer.from(forgedKey)), 'the forging peer built the forged view')
  assert.ok(m.system.flushes > 40, 'M is far ahead')
  const ownerSystem = a.channel.views()[0].key.toString('hex')
  if (ownerOffline) {
    // M holds A's oplog, so the new relay can still replay the honest history from M alone
    await until(() => m.system.flushes >= 44 && a.channel.flushes >= 44)
    aClosed = true
    await a.close()
  }

  c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  // A applies M's optimistic nodes too, so A's own stamp runs far ahead and C may legitimately
  // land on A's view; it must never land on M's.
  const landed = []
  c.channel.on('move-to', to => landed.push(to.key.toString('hex')))
  const forgedOn = async node => (await node.search('imdb:tt6666666')).length
  await until(async () => (await c.search('imdb:tt0000001')).length || await forgedOn(c), 120000)
  assert.equal(await forgedOn(c), 0, 'the new relay adopted a view with a forged entry')
  if (role) {
    await until(async () => (await c.search('imdb:tt5000040')).length, 120000)
  } else {
    // an ungranted stranger's announces never reach the catalog either
    await new Promise(resolve => setTimeout(resolve, 5000))
    assert.equal((await c.search('imdb:tt5000040')).length, 0)
  }
  assert.equal(await forgedOn(c), 0)
  const forgerSystem = m.views()[0].key.toString('hex')
  assert.notEqual(ownerSystem, forgerSystem)
  for (const key of landed) assert.equal(key, ownerSystem, 'the new relay fast-forwarded onto a view that is not the owner\'s')
  assert.ok(!landed.includes(forgerSystem))
  if (ownerOffline) assert.equal(c.channel.stats.fastForwards, 0, 'with the owner offline the only stamp on offer is the forger\'s')
  t.diagnostic(`fastForwards=${c.channel.stats.fastForwards} applies=${c.channel.stats.applies} landed=${landed.map(k => k.slice(0, 6)).join(',') || 'none'} owner=${ownerSystem.slice(0, 6)} forger=${forgerSystem.slice(0, 6)}`)
}

test('an ungranted optimistic stranger far ahead with a forging apply cannot hand its view to a new relay', async t => {
  await forgerScenario(t, {})
})

test('a granted non-owner writer far ahead with a forging apply cannot hand its view to a new relay', async t => {
  await forgerScenario(t, { role: 'writer' })
})

test('a moderator far ahead with a forging apply cannot hand its view to a new relay', async t => {
  await forgerScenario(t, { role: 'mod' })
})

test('with the owner offline, an ungranted stranger\'s stamped view is not adopted', async t => {
  await forgerScenario(t, { ownerOffline: true })
})

test('with the owner offline, a granted non-owner writer\'s stamped view is not adopted', async t => {
  await forgerScenario(t, { role: 'writer', ownerOffline: true })
})

// D is linked as an owner device and the follower C trusts it; A then revokes D. A revoked device that
// goes offline, forges far ahead and comes back must not hand C its view, even though C trusted it before.
test('a revoked owner device cannot hand its forged view to a follower that trusted it before', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  await a.publish({ id: 'imdb:tt0000001', title: 'Honest' }, Readable.from([randomBytes(100)]))

  const forgedKey = `imdb:tt6666666/${a.status().writer}/${zero}:0`
  const forged = JSON.stringify(announce('imdb:tt6666666', 'Forged'))
  const honest = makeApply(() => tracker)
  let forging = false
  async function deviceApply (nodes, view, host) {
    if (!forging) return honest(nodes, view, host)
    for (const node of nodes) {
      await host.addWriter(node.key, { isIndexer: false })
      const w = view.write()
      w.tryPut(Buffer.from(forgedKey), Buffer.from(forged))
      await w.flush()
    }
  }
  const dStore = new Corestore(tmp())
  const d = new Autobee(dStore.namespace('tracker'), Buffer.from(tracker, 'hex'), { apply: deviceApply, optimistic: true })
  await d.ready()
  const dHex = d.local.key.toString('hex')
  await a.grantWriter(dHex, { role: 'owner' })
  let dSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  dSwarm.on('connection', conn => d.replicate(conn))
  dSwarm.join(d.discoveryKey)
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  t.after(async () => { await c.close(); await a.close(); await dSwarm.destroy(); await d.close(); await dStore.close(); await testnet.destroy() })

  await until(async () => (await c.search('imdb:tt0000001')).length)
  await until(() => d.writable)
  // C judges D while D is a granted owner device, so its answer is cached
  await until(() => c.channel.trusted.isTrusted(d.local.key, c.channel.view))

  await a.revokeWriter(dHex)
  await until(async () => Boolean(await c.channel.view.get(Buffer.from(`revoked/${dHex}`))))

  await dSwarm.destroy()
  forging = true
  for (let i = 0; i <= 40; i++) {
    const before = d.local.length
    await d.append(Buffer.from(JSON.stringify(announce(`imdb:tt${5100000 + i}`, 'D'))), { optimistic: !d.writable })
    while (d.local.length <= before) { await new Promise(resolve => setTimeout(resolve, 300)); await d.update() }
  }
  assert.ok(await d.view.get(Buffer.from(forgedKey)), 'the revoked device built the forged view')
  const deviceSystem = d.views()[0].key.toString('hex')
  const landed = []
  c.channel.on('move-to', to => landed.push(to.key.toString('hex')))
  // record every verdict C's hook gives D from here on: proof that C considered D's forged heads
  const hooks = c.channel.trusted.hooks
  const judge = hooks.isTrusted
  const verdicts = []
  hooks.isTrusted = async (key, reference) => {
    const verdict = await judge(key, reference)
    if (key.equals(d.local.key)) verdicts.push(verdict)
    return verdict
  }
  dSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  dSwarm.on('connection', conn => d.replicate(conn))
  dSwarm.join(d.discoveryKey)

  // either C asks about D again (the fix) or lands on D's view from its stale cache (the bug)
  await until(() => verdicts.length || landed.includes(deviceSystem), 120000)
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.ok(verdicts.every(v => !v), 'C trusted the revoked device again')
  t.diagnostic(`fastForwards=${c.channel.stats.fastForwards} landed=${landed.map(k => k.slice(0, 6)).join(',') || 'none'} device=${deviceSystem.slice(0, 6)}`)
  assert.ok(!landed.includes(deviceSystem), 'the follower fast-forwarded onto the revoked device\'s view')
  assert.equal((await c.search('imdb:tt6666666')).length, 0, 'a forged entry reached the follower')
})

test('a new relay fast-forwards onto the channel owner\'s view instead of replaying it', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  let c = null
  t.after(async () => { await c?.close(); await a.close(); await testnet.destroy() })
  // past the 16-flush fast-forward distance
  for (let i = 0; i < 30; i++) await a.append(announce(`imdb:tt${7000000 + i}`, 'Owner'))
  assert.ok(a.channel.flushes >= 30)

  c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  await until(async () => (await c.search('imdb:tt7000029')).length, 120000)
  assert.equal((await c.search(null, { limit: 1000 })).length, 30)
  assert.equal(c.channel.stats.fastForwards, 1, 'the new relay did not fast-forward onto the owner\'s view')
  assert.ok(c.channel.stats.applies < 30, `the new relay replayed ${c.channel.stats.applies} batches instead of landing`)
})

test('a relay that landed on the owner\'s view hands the landing on while the owner is offline', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  let aClosed = false
  let b = null
  let c = null
  t.after(async () => { await c?.close(); await b?.close(); if (!aClosed) await a.close(); await testnet.destroy() })
  for (let i = 0; i < 30; i++) await a.append(announce(`imdb:tt${8000000 + i}`, 'Owner'))

  b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  await until(async () => (await b.search(null, { limit: 1000 })).length === 30, 120000)
  assert.equal(b.channel.stats.fastForwards, 1)
  const ownerSystem = a.channel.views()[0].key.toString('hex')
  aClosed = true
  await a.close()

  c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  const landed = []
  c.channel.on('move-to', to => landed.push(to.key.toString('hex')))
  await until(async () => (await c.search(null, { limit: 1000 })).length === 30, 120000)
  t.diagnostic(`fastForwards=${c.channel.stats.fastForwards} applies=${c.channel.stats.applies} landed=${landed.map(k => k.slice(0, 6)).join(',') || 'none'} owner=${ownerSystem.slice(0, 6)}`)
  assert.equal(c.channel.stats.fastForwards, 1, 'the second relay did not land via the first one')
  assert.deepEqual(landed, [ownerSystem])
})

test('a relay keeps the owner\'s landed cores whole and hands the newest stamp on while the owner is offline', async t => {
  const testnet = await createTestnet(3)
  const a = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  let aClosed = false
  let b = null
  let c = null
  const sessions = []
  t.after(async () => { for (const s of sessions) await s.close(); await c?.close(); await b?.close(); if (!aClosed) await a.close(); await testnet.destroy() })
  for (let i = 0; i < 30; i++) await a.append(announce(`imdb:tt${9000000 + i}`, 'Owner'))

  b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  await until(async () => (await b.search(null, { limit: 1000 })).length === 30, 120000)
  assert.equal(b.channel.stats.fastForwards, 1)
  const [sys, view] = a.channel.views()
  const bSys = b.store.get({ key: sys.key })
  const bView = b.store.get({ key: view.key })
  sessions.push(bSys, bView)
  await bSys.ready(); await bView.ready()
  await until(() => bSys.contiguousLength >= sys.length && bView.contiguousLength >= view.length, 60000)

  // the owner moves on by less than the 16-flush fast-forward distance: B applies, it does not re-land
  for (let i = 30; i < 35; i++) await a.append(announce(`imdb:tt${9000000 + i}`, 'Owner'))
  await until(async () => (await b.search(null, { limit: 1000 })).length === 35, 120000)
  assert.equal(b.channel.stats.fastForwards, 1)
  const [sys2, view2] = a.channel.views()
  assert.ok(sys2.length > sys.length && view2.length > view.length)
  await until(() => bSys.contiguousLength >= sys2.length && bView.contiguousLength >= view2.length, 60000)
  aClosed = true
  await a.close()

  c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  const landed = []
  c.channel.on('move-to', to => landed.push(to.key.toString('hex')))
  await until(async () => (await c.search(null, { limit: 1000 })).length === 35, 120000)
  t.diagnostic(`fastForwards=${c.channel.stats.fastForwards} applies=${c.channel.stats.applies} landed=${landed.map(k => k.slice(0, 6)).join(',') || 'none'}`)
  assert.equal(c.channel.stats.fastForwards, 1, 'the new relay did not land on the newest stamp via the mirroring relay')
  assert.deepEqual(landed, [sys2.key.toString('hex')])
  assert.ok(c.channel.stats.applies < 10, `replayed ${c.channel.stats.applies} batches`)
})
