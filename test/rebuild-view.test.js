import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import Autobee from 'autobee'
import Corestore from 'corestore'
import CoreStorage from 'hypercore-storage'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { makeApply } from '../src/apply.js'
import { deriveIdentity } from '../src/mnemonic.js'
import { rebuildView } from '../src/rebuild-view.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-test-'))
const zero = '0'.repeat(64)
const announce = (id, title) => ({ type: 'announce', id, title, size: 1, sha256: zero, blobs: zero, blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 } })

async function until (fn, ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

// The relays' historical apply: grants take effect for the batch at hand, but no `writer/` record is ever
// written, so a granted writer's later announces are ignored and the view diverges from a fresh replay.
function withoutWriterRecords (apply) {
  return (nodes, view, host) => apply(nodes, {
    get: key => view.get(key),
    createReadStream: opts => view.createReadStream(opts),
    write: () => {
      const w = view.write()
      const tryPut = w.tryPut.bind(w)
      w.tryPut = (k, v) => { if (!b4a.toString(k).startsWith('writer/')) tryPut(k, v) }
      return w
    }
  }, host)
}

async function dump (bee) {
  const out = new Map()
  for await (const node of bee.view.createReadStream()) out.set(b4a.toString(node.key), createHash('sha256').update(node.value).digest('hex'))
  return out
}

async function blockHashes (core) {
  const out = []
  for (let i = 0; i < core.length; i++) out.push(createHash('sha256').update(await core.get(i)).digest('hex'))
  return out
}

function openStore (dir) {
  return new Corestore(new CoreStorage(join(dir, 'corestore')))
}

test('rebuild-view replays the owner\'s oplog with the current apply, keeps the oplog, and restamps the rebuilt view', async t => {
  const testnet = await createTestnet(3)
  const dirA = tmp()
  const closers = []
  t.after(async () => { for (const fn of closers.reverse()) await fn().catch(() => {}); await testnet.destroy() })

  // 1. found the channel with the current code, then rebuild its view with the old apply: a relay whose view predates writer/ records
  let a = await createNode({ storage: dirA, bootstrap: testnet.bootstrap })
  const tracker = a.status().tracker
  await a.close()
  const identity = JSON.parse(readFileSync(join(dirA, 'identity.json'), 'utf8'))
  const vault = deriveIdentity(identity.mnemonic)
  assert.equal(vault.channelKey, tracker)

  const storeOld = openStore(dirA)
  await storeOld.ready()
  const chan = storeOld.namespace('tracker').get({ key: b4a.from(tracker, 'hex'), active: false })
  await chan.ready()
  await chan.setUserData('autobee/head', null)
  await chan.close()
  const aOld = new Autobee(storeOld.namespace('tracker'), null, { keyPair: vault.genesisKeyPair, apply: withoutWriterRecords(makeApply(() => tracker)), optimistic: true, fastForward: false })
  await aOld.ready()
  const swarmOld = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarmOld.on('connection', conn => aOld.replicate(conn))
  swarmOld.join(aOld.discoveryKey)
  closers.push(() => swarmOld.destroy(), () => aOld.close(), () => storeOld.close())

  // a granted writer publishes; the old apply drops its announce because it never recorded the grant
  const b = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  closers.push(() => b.close())
  await aOld.append(b4a.from(JSON.stringify({ type: 'grant', writer: b.status().writer, role: 'writer' })))
  await until(() => b.status().writable)
  await b.append(announce('imdb:tt0000002', 'From B'))
  for (let i = 0; i < 20; i++) await aOld.append(b4a.from(JSON.stringify(announce(`imdb:tt${1000000 + i}`, 'Owner'))))
  await until(async () => { await aOld.update(); return aOld.flushes >= aOld.local.length + 1 && (await aOld.view.get(b4a.from(`imdb:tt0000002/${b.status().writer}/${zero}:0`))) === null })
  const oldView = await dump(aOld)
  assert.ok(![...oldView.keys()].some(k => k.startsWith('writer/')), 'the old view must have no writer/ records')
  assert.ok(!oldView.has(`imdb:tt0000002/${b.status().writer}/${zero}:0`), 'the old view must lack the granted writer\'s announce')
  const oldSystem = aOld.views()[0]
  const oplogBefore = await blockHashes(aOld.local)
  const oplogLength = aOld.local.length
  t.diagnostic(`old view: oplog ${oplogLength} nodes, flushes ${aOld.flushes}, keys ${oldView.size}, system ${b4a.toString(oldSystem.key, 'hex').slice(0, 6)}@${oldSystem.length}`)

  // 2. what a fresh replay with the current apply produces
  const storeR = openStore(tmp())
  const r = new Autobee(storeR.namespace('tracker'), b4a.from(tracker, 'hex'), { apply: makeApply(() => tracker), optimistic: true, fastForward: false })
  await r.ready()
  const swarmR = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarmR.on('connection', conn => r.replicate(conn))
  swarmR.join(r.discoveryKey)
  await until(async () => { await r.update(); return r.flushes === aOld.flushes })
  const reference = await dump(r)
  await swarmR.destroy(); await r.close(); await storeR.close()
  assert.ok([...reference.keys()].some(k => k.startsWith('writer/')), 'the fresh replay has writer/ records')
  assert.ok(reference.has(`imdb:tt0000002/${b.status().writer}/${zero}:0`))

  // 3. the production step, run exactly as on the relay: bin/rebuild-view.js under bare, relay stopped
  await swarmOld.destroy(); await aOld.close(); await storeOld.close()
  closers.splice(0, 3)
  const backupDir = tmp()
  cpSync(dirA, backupDir, { recursive: true })
  const check = spawnSync('node_modules/.bin/bare', ['bin/rebuild-view.js', dirA, '--check'], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  const checked = JSON.parse(check.stdout.trim().split('\n').pop())
  assert.equal(checked.writers, 0)
  assert.equal(checked.announces, 20)
  const run = spawnSync('node_modules/.bin/bare', ['bin/rebuild-view.js', dirA], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const done = JSON.parse(run.stdout.trim().split('\n').pop())
  t.diagnostic(run.stdout.trim().split('\n').map(l => l.slice(0, 160)).join(' | '))
  assert.equal(done.owner, true)
  assert.equal(done.oplogLength, oplogLength)
  assert.equal(done.oplogLengthAfter, oplogLength + 1)
  assert.equal(done.announces, 21)
  assert.ok(done.writers >= 2)
  assert.equal(done.views[0].key, b4a.toString(oldSystem.key, 'hex'), 'the rebuilt tree lives on the same system core')
  assert.ok(done.views[0].length > oldSystem.length)
  assert.ok(JSON.parse(readFileSync(join(dirA, 'rebuild-view.backup.json'), 'utf8')).head)

  // 4. the rebuilt view equals the fresh replay byte for byte, and the oplog's old blocks are untouched
  const storeA = openStore(dirA)
  const aCheck = new Autobee(storeA.namespace('tracker'), null, { keyPair: vault.genesisKeyPair, apply: makeApply(() => tracker), optimistic: true, fastForward: false })
  await aCheck.ready()
  await aCheck.update()
  assert.deepEqual(await dump(aCheck), reference)
  assert.equal(aCheck.local.length, oplogLength + 1)
  assert.deepEqual((await blockHashes(aCheck.local)).slice(0, oplogLength), oplogBefore)
  await aCheck.close(); await storeA.close()

  // 5. the owner runs again, can append, and a fresh follower lands on the rebuilt view with writer/ records
  a = await createNode({ storage: dirA, bootstrap: testnet.bootstrap })
  closers.push(() => a.close())
  await a.append(announce('imdb:tt0000050', 'After rebuild'))
  const c = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker })
  closers.push(() => c.close())
  const landed = []
  c.channel.on('move-to', to => landed.push({ key: b4a.toString(to.key, 'hex'), length: to.length }))
  await until(async () => (await c.search(null, { limit: 1000 })).length === 22)
  assert.equal(c.channel.stats.fastForwards, 1, 'the follower did not fast-forward')
  assert.equal(landed[0].key, b4a.toString(oldSystem.key, 'hex'))
  assert.ok(landed[0].length > oldSystem.length, `landed on the old tree: ${JSON.stringify(landed)} vs old length ${oldSystem.length}`)
  const cView = await dump(c.channel)
  assert.ok(cView.has(`writer/${b.status().writer}`))
  assert.deepEqual(cView, await dump(a.channel))
  assert.equal((await a.search('imdb:tt0000002')).length, 1, 'the owner now lists the granted writer\'s announce')

  // 6a. rollback after going online: the boot record goes back to the old tree, the oplog (stamp op and the
  // announce peers may already hold) stays, and those nodes apply on top of the old view
  await a.close(); closers.pop()
  const back = spawnSync('node_modules/.bin/bare', ['bin/rebuild-view.js', dirA, '--rollback'], { encoding: 'utf8' })
  assert.equal(back.status, 0, back.stderr)
  const storeB = openStore(dirA)
  const aBack = new Autobee(storeB.namespace('tracker'), null, { keyPair: vault.genesisKeyPair, apply: makeApply(() => tracker), optimistic: true, fastForward: false })
  await aBack.ready()
  await aBack.update()
  const rolledBack = await dump(aBack)
  assert.equal(aBack.local.length, oplogLength + 2)
  assert.ok(![...rolledBack.keys()].some(k => k.startsWith('writer/')))
  for (const [k, v] of oldView) assert.equal(rolledBack.get(k), v)
  assert.equal(rolledBack.size, oldView.size + 1, 'only the post-rebuild announce is new')
  await aBack.close(); await storeB.close()

  // 6b. rollback before going online: restoring the pre-rebuild copy. The store's device file flags a copied
  // directory; createNode drops it on open (src/index.js), so a raw open does the same here.
  rmSync(dirA, { recursive: true, force: true })
  cpSync(backupDir, dirA, { recursive: true })
  rmSync(join(dirA, 'corestore', 'CORESTORE'), { force: true })
  const storeC = openStore(dirA)
  const aCopy = new Autobee(storeC.namespace('tracker'), null, { keyPair: vault.genesisKeyPair, apply: makeApply(() => tracker), optimistic: true, fastForward: false })
  await aCopy.ready()
  assert.deepEqual(await dump(aCopy), oldView)
  assert.equal(aCopy.local.length, oplogLength)
  await aCopy.close(); await storeC.close()
})
