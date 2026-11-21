// The foreign Protomux decoders PearTube registers (HiveRelay `hiverelay-seed`, `peartube/bulk-busy`) against a
// message they cannot decode (a varint at 2^53). Protomux closes the whole connection on a decoder that throws; with
// src/guarded-frame.js the message is dropped: the state it would have changed is unchanged, the connection stays
// open and a valid message still works.
import test from 'node:test'
import assert from 'node:assert/strict'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { createHiverelaySeeder, unseedRequestEncoding } from '../src/hiverelay.js'
import { createTrafficGate } from '../src/traffic.js'
import { guardedFrame } from '../src/guarded-frame.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const varint53 = b4a.from([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0])

async function pair (t) {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  a.on('error', () => {})
  b.on('error', () => {})
  t.after(() => { a.destroy(); b.destroy() })
  await Promise.all([a.opened, b.opened])
  return { a, b }
}

async function until (fn, ms, label) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

test('guardedFrame: oversized or undecodable input is null, and the cursor ends at the message end', () => {
  const enc = guardedFrame(c.uint, 9)
  const state = { start: 0, end: 9, buffer: varint53 }
  assert.equal(enc.decode(state), null)
  assert.equal(state.start, 9)
  assert.equal(state.end, 9)
  const long = { start: 0, end: 10, buffer: b4a.alloc(10) }
  assert.equal(enc.decode(long), null)
  assert.equal(long.start, 10)
  assert.equal(enc.decode({ start: 0, end: 1, buffer: b4a.from([7]) }), 7)
  // An inner decoder that narrows the end before it throws: the guard puts back the end the message had.
  const narrowing = guardedFrame({ decode (s) { s.end = s.start + 1; throw new Error('bad') } }, 64)
  const narrowed = { start: 0, end: 10, buffer: b4a.alloc(10) }
  assert.equal(narrowing.decode(narrowed), null)
  assert.deepEqual([narrowed.start, narrowed.end], [10, 10])
})

test('HiveRelay seed accept and seed request with a varint at 2^53 change nothing and keep the connection', { timeout: 30_000 }, async t => {
  const { a, b } = await pair(t)
  const unmarked = []
  const seeder = createHiverelaySeeder({
    node: {
      privateRouting: false,
      channel: { local: { keyPair: { secretKey: b4a.alloc(64, 1) } } },
      store: { primaryKey: b4a.alloc(32, 1) },
      swarm: { join: () => ({ destroy: async () => {} }), leavePeer () {} },
      onConnection: () => () => {},
      peerConnections: () => [a],
      seedableCores: () => []
    },
    discover: true,
    traffic: { markBulk () {}, unmarkBulk: conn => unmarked.push(conn), info: () => ({}) }
  })
  t.after(() => seeder.stop())

  // The HiveRelay's side of `hiverelay-seed`: request, accept, unseed, deny, as raw bytes.
  let open = false
  const channel = Protomux.from(b).createChannel({ protocol: 'hiverelay-seed', handshake: c.raw, onopen: () => { open = true } })
  const [request, accept, unseed] = [0, 1, 2, 3].map(() => channel.addMessage({ encoding: c.raw }))
  channel.open(b4a.from('{"major":1,"minor":0}'))
  await seeder.run({ discover: true })
  await until(() => open, 5000, 'the seed channel')

  const relayKey = b.publicKey
  const acceptBody = storage => b4a.concat([b4a.alloc(32, 2), relayKey, c.encode(c.string, 'eu'), storage, b4a.alloc(64)])
  accept.send(acceptBody(varint53))
  request.send(b4a.concat([b4a.alloc(32, 3), varint53]))
  await sleep(300)
  assert.deepEqual(seeder.info().p2pAcceptedRelays, [], 'the accept that does not decode is ignored')
  assert.equal(unmarked.length, 0, 'the request that does not decode does not unmark the connection')
  assert.equal(a.destroyed || b.destroyed, false, 'the connection is open')

  accept.send(acceptBody(c.encode(c.uint, 1024)))
  await until(() => seeder.info().p2pAcceptedRelays.length === 1, 5000, 'a valid accept')
  assert.equal(seeder.info().p2pAcceptedRelays[0].pubkey, b4a.toString(relayKey, 'hex'))

  // An unseed request's fields allow at most 137 bytes (two keys, a signature, a varint of at most 9 bytes): one of
  // 137 reaches its decoder, one byte more never does.
  const decode = unseedRequestEncoding.decode
  let decoded = 0
  unseedRequestEncoding.decode = s => { decoded++; return decode(s) }
  t.after(() => { unseedRequestEncoding.decode = decode })
  const largest = b4a.concat([b4a.alloc(32, 4), c.encode(c.uint, Number.MAX_SAFE_INTEGER), b4a.alloc(32, 5), b4a.alloc(64, 6)])
  assert.equal(largest.byteLength, 137)
  unseed.send(largest)
  unseed.send(b4a.concat([largest, b4a.from([0])]))
  await sleep(300)
  assert.equal(decoded, 1, 'only the unseed request within its size is decoded')
  assert.equal(a.destroyed || b.destroyed, false, 'the connection is open')
})

test('a bulk-busy flag with a varint at 2^53 keeps the last claim and the connection', { timeout: 30_000 }, async t => {
  const { a, b } = await pair(t)
  const gate = createTrafficGate({
    node: {
      privateRouting: false,
      peerConnections: () => [a],
      onConnection: () => () => {},
      isSourcePeer: () => true
    }
  })
  t.after(() => gate.stop())
  const channel = Protomux.from(b).createChannel({ protocol: 'peartube/bulk-busy', id: null })
  const busy = channel.addMessage({ encoding: c.raw })
  channel.open()
  busy.send(c.encode(c.uint, 1))
  await until(() => gate.peersBusy(), 5000, 'the busy claim')
  busy.send(varint53)
  await sleep(300)
  assert.equal(gate.peersBusy(), true, 'the claim is unchanged')
  assert.equal(a.destroyed || b.destroyed, false, 'the connection is open')
  busy.send(c.encode(c.uint, 0))
  await until(() => !gate.peersBusy(), 5000, 'a valid flag still counts')
})
