// A guard's routes and rendezvous slots belong to the session that registered them: another endpoint session cannot
// take over a live route token or overwrite or remove a live slot. And every spelling of one IPv6 address lands in
// one /48 diversity bucket. Writes desktop/target/e2e/private-guard-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { createPrivateGuard, diversityBucketForAddress } from '../src/private-overlay.js'

const root = new URL('..', import.meta.url).pathname
const artifact = join(root, 'desktop/target/e2e/private-guard-result.json')
const OP = { HELLO: 1, REGISTER: 2, GET_MUTABLE: 6, RV_REGISTER: 8, RV_UNREGISTER: 10, RV_LOOKUP: 11 }
const frameEnc = {
  preencode (s, m) { c.uint.preencode(s, m.op); c.uint.preencode(s, m.id); c.buffer.preencode(s, m.payload) },
  encode (s, m) { c.uint.encode(s, m.op); c.uint.encode(s, m.id); c.buffer.encode(s, m.payload) },
  decode (s) { return { op: c.uint.decode(s), id: c.uint.decode(s), payload: c.buffer.decode(s) } }
}
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const cards = payload => {
  const state = { start: 0, end: payload.byteLength, buffer: payload }
  const n = c.uint.decode(state)
  return Array.from({ length: n }, () => Buffer.from(c.buffer.decode(state)).toString('hex'))
}

// One endpoint session on the guard, speaking its control protocol directly.
async function endpoint (dht, guardKey) {
  const conn = dht.connect(guardKey, { keyPair: HyperDHT.keyPair(randomBytes(32)) })
  conn.on('error', () => {})
  assert.ok(await conn.opened, 'endpoint connected to the guard')
  const mux = Protomux.from(conn)
  const pending = new Map()
  let nextId = 1
  const ch = mux.createChannel({ protocol: 'peartube/private-guard/v1' })
  const msg = ch.addMessage({ encoding: frameEnc, onmessage (f) { pending.get(f.id)?.(f.payload); pending.delete(f.id) } })
  ch.open()
  const call = (op, payload) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`op ${op} timed out`)) }, 10_000)
    pending.set(id, p => { clearTimeout(timer); resolve(Buffer.from(p)) })
    msg.send({ op, id, payload })
  })
  const send = (op, payload) => msg.send({ op, id: nextId++, payload })
  await call(OP.HELLO, Buffer.from('endpoint'))
  return { call, send, close: () => conn.destroy() }
}

test('IPv6 diversity buckets do not depend on how an address is written', () => {
  const bucket = 'ipv6:2001:0000:0000/48'
  for (const spelling of ['2001::1', '2001:0:0:0:0:0:0:1', '2001:0000:0000:0000:0000:0000:0000:0001', '[2001::1]', '2001:0::abcd']) {
    assert.equal(diversityBucketForAddress(spelling, 4001), bucket, spelling)
  }
  assert.equal(diversityBucketForAddress('2001:db8:abcd:12::1', 1), diversityBucketForAddress('2001:DB8:ABCD::ffff', 2))
  assert.notEqual(diversityBucketForAddress('2001:db8:abcd::1', 1), diversityBucketForAddress('2001:db8:abce::1', 1))
  assert.equal(diversityBucketForAddress('::ffff:198.51.100.7', 1), diversityBucketForAddress('198.51.100.200', 1), 'IPv4-mapped is its IPv4 /24')
  assert.equal(diversityBucketForAddress('::ffff:c633:6407', 1), diversityBucketForAddress('198.51.100.7', 1), 'hex-mapped too')
  assert.equal(diversityBucketForAddress('::1', 4001, false), null)
  assert.equal(diversityBucketForAddress('::ffff:127.0.0.1', 4001, false), null)
  assert.equal(diversityBucketForAddress('not:an:address::x', 1), null)
})

test('a guard keeps live routes and rendezvous slots with the session that registered them', { timeout: 90_000 }, async t => {
  const testnet = await createTestnet(3)
  const guard = await createPrivateGuard({ host: '127.0.0.1', bootstrap: testnet.bootstrap })
  const dht = new HyperDHT({ host: '127.0.0.1', bootstrap: testnet.bootstrap, port: [0, 0] })
  await dht.ready()
  const sessions = []
  t.after(async () => {
    for (const s of sessions) s.close()
    await dht.destroy({ force: true })
    await guard.close()
    await testnet.destroy()
  })
  const owner = await endpoint(dht, guard.publicKey)
  const thief = await endpoint(dht, guard.publicKey)
  sessions.push(owner, thief)

  const token = randomBytes(32)
  const register = s => s.call(OP.REGISTER, Buffer.concat([token, u32(600_000)])).then(r => r[0])
  assert.equal(await register(owner), 1, 'owner registers its route token')
  assert.equal(await register(thief), 0, 'another session cannot take over a live route token')
  assert.equal(await register(owner), 1, 'the owner may refresh its own token')
  assert.equal(guard.stats().registeredRoutes, 1)

  const topic = randomBytes(32)
  const slot = randomBytes(16)
  const cardA = randomBytes(64)
  const cardB = randomBytes(64)
  const rvRegister = (s, slotId, card) => s.call(OP.RV_REGISTER, Buffer.concat([topic, slotId, u32(600_000), card])).then(r => r[0])
  assert.equal(await rvRegister(owner, slot, cardA), 1, 'owner registers its rendezvous slot')
  assert.equal(await rvRegister(thief, slot, cardB), 0, 'another session cannot overwrite a live slot')
  assert.equal(await rvRegister(thief, randomBytes(16), cardB), 1, 'it may register a slot of its own')
  thief.send(OP.RV_UNREGISTER, Buffer.concat([topic, slot]))

  const listed = cards(await owner.call(OP.RV_LOOKUP, topic))
  assert.ok(listed.includes(cardA.toString('hex')), 'the owner\'s card survives the overwrite and the unregister')
  assert.ok(listed.includes(cardB.toString('hex')), 'the other session\'s own slot is listed')
  assert.equal(listed.length, 2)

  // Oversized frames (>64 KiB) are dropped cleanly without crashing the session, and DHT-driving ops are rate-limited per session.
  // Store a real mutable record so `OP_GET_MUTABLE` returns `rep[0] === 1` until the per-session rate limit kicks in and flips it to `0`.
  const mKey = HyperDHT.keyPair(randomBytes(32))
  await dht.mutablePut(mKey, Buffer.from('live-card'))
  assert.equal((await owner.call(OP.GET_MUTABLE, mKey.publicKey))[0], 1, 'guard sees the mutable record before rate-limit burst')
  thief.send(OP.REGISTER, randomBytes(70 * 1024))
  const hits = await Promise.all(Array.from({ length: 262 }, () => thief.call(OP.GET_MUTABLE, mKey.publicKey).then(r => r[0])))
  const okCount = hits.filter(x => x === 1).length
  const refusedCount = hits.filter(x => x === 0).length
  assert.ok(okCount >= 240 && okCount <= 256, `session gets up to 256 DHT ops per 10 s (got ${okCount})`)
  assert.ok(refusedCount >= 6, `session DHT ops past 256 per 10 s are refused (got ${refusedCount})`)
  // Meanwhile `owner` has its own independent quota and still lists cards cleanly.
  assert.equal(cards(await owner.call(OP.RV_LOOKUP, topic)).length, 2, 'other sessions are unaffected by a noisy endpoint')

  writeResult({ routeTakeoverRefused: true, slotOverwriteRefused: true, foreignUnregisterIgnored: true, oversizedFrameDropped: true, dhtRateLimited: true, cardsListed: listed.length })
})

function writeResult (checks) {
  mkdirSync(join(root, 'desktop/target/e2e'), { recursive: true })
  writeFileSync(artifact, JSON.stringify({ at: new Date().toISOString(), passed: true, checks }, null, 2) + '\n')
}
