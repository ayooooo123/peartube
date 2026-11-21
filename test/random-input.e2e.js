// Random input on every Protomux decoder PearTube registers: 100,000 messages into each v2 channel (search served by
// the real `createGlobalSearch`, cast and the private guard by the envelope with their real op lists) and into each
// guarded foreign decoder (100,000 into each of the four `hiverelay-seed` messages of the real seeder, counted where
// they reach their decoder, and 100,000 into the `peartube/bulk-busy` flag of the real traffic gate). Half the
// messages are random bytes, half are well-formed frames with a random kind, op, id and value, so the generated struct
// decoders see random values too. A v2 channel closes itself after eight bad frames; the sender reopens it and goes
// on. Afterwards, on the same connection, a valid exchange on each protocol and a block download succeed and the
// process is alive. Fails before v2: the v2 channels did not exist and the foreign decoders threw.
// Run: node --test --test-force-exit test/random-input.e2e.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Corestore from 'corestore'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { getEncoding } from '../spec/hyperschema/index.js'
import { CAST, GUARD, SEARCH } from '../spec/protocols.js'
import { openChannel, serveChannel } from '../src/control-channel.js'
import { createGlobalSearch } from '../src/search.js'
import { createHiverelaySeeder, seedAcceptEncoding, seedDenyEncoding, seedRequestEncoding, unseedRequestEncoding } from '../src/hiverelay.js'
import { createTrafficGate } from '../src/traffic.js'

const COUNT = 100_000
const FRAME = getEncoding('@peartube/frame')
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-random-${label}-`))
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until (fn, ms, label) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const faults = []
process.on('uncaughtException', err => faults.push(err))
process.on('unhandledRejection', err => faults.push(err))

async function setup (t) {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  a.on('error', () => {})
  b.on('error', () => {})
  const storeA = new Corestore(tmp('a'))
  const storeB = new Corestore(tmp('b'))
  storeA.replicate(a)
  storeB.replicate(b)
  const core = storeA.get({ name: 'blocks' })
  await core.ready()
  const remote = storeB.get({ key: core.key })
  await remote.ready()
  await Promise.all([a.opened, b.opened])
  t.after(async () => {
    a.destroy()
    b.destroy()
    await storeA.close()
    await storeB.close()
  })
  let block = 0
  return {
    a,
    b,
    async download () {
      const i = block++
      await core.append(b4a.from(`block ${i}`))
      assert.equal(b4a.toString(await remote.get(i, { timeout: 15_000 })), `block ${i}`, 'a block downloads on the same connection')
      assert.equal(a.destroyed || b.destroyed, false, 'the connection is open')
    }
  }
}

function randomMessage (ops) {
  if (randomInt(2) === 0) return randomBytes(randomInt(0, 96))
  return c.encode(FRAME, { kind: randomInt(0, 4), op: randomInt(0, ops + 1), id: randomInt(0, 16), value: randomBytes(randomInt(0, 64)) })
}

// Sends `count` messages built by `make(slot)` to each of the raw `slots` of `protocol` (in turn), reopening the
// channel whenever the other side closes it. Returns how many times it had to reopen.
// `batch` messages go out before the sender looks for a close: 8 for a v2 channel, which closes after eight bad
// frames, so nearly every message is read by an open channel rather than dropped after a close.
async function flood (conn, protocol, { slots = 1, handshake = null, count = COUNT, batch = 64, make }) {
  let channel = null
  let msgs = null
  let reopens = -1
  const open = () => new Promise(resolve => {
    reopens++
    channel = Protomux.from(conn).createChannel({ protocol, id: null, handshake: handshake ? c.raw : undefined, onopen: () => resolve(true), onclose: () => resolve(false) })
    msgs = Array.from({ length: slots }, () => channel.addMessage({ encoding: c.raw }))
    channel.open(handshake || undefined)
  })
  assert.equal(await open(), true, `${protocol} opens`)
  for (let sent = 0; sent < count * slots;) {
    for (let i = 0; i < batch && sent < count * slots; i++, sent++) {
      const slot = sent % slots
      msgs[slot].send(make(slot))
    }
    for (let i = 0; i < 5 && !channel.closed; i++) await tick()
    if (channel.closed) {
      while (!(await open())) await tick()
    }
  }
  channel.close()
  return reopens
}

test('100,000 random messages into each v2 channel leave the channel answering and the connection downloading', { timeout: 600_000 }, async t => {
  const env = await setup(t)
  const entries = [{ id: 'imdb:tt0079944', title: 'Stalker (1979)', blobs: 'a'.repeat(64), blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 10 }, sha256: 'b'.repeat(64), size: 10, key: 'k' }]
  const listeners = new Set()
  const search = createGlobalSearch({
    swarm: { join: () => ({ destroy: async () => {} }), on () {}, off () {} },
    peerConnections: () => [env.a],
    connListeners: listeners,
    isPrivate: () => false,
    isLan: () => false,
    isSourcePeer: () => false,
    publicEntries: async () => entries
  })
  t.after(() => search.close())
  search.serve({ isMedia: () => true })

  // Cast and guard: the envelope with their real op lists, and handlers that answer with valid structs.
  const castHandlers = {
    pair: () => ({ deviceId: 'd', name: 'n', publicKey: b4a.alloc(32), token: '' }),
    subscribe: () => ({ tracks: [], status: 'idle', mode: '', entry: null, positionMs: 0, durationMs: 0, playing: false, buffering: false, ended: false, p2pPeers: 0, cachedBytes: 0, seeding: false, volume: 1, muted: false, audio: -2, subtitle: -2, error: '', updatedAt: 0, videoDecoder: '', droppedFrames: -1 })
  }
  castHandlers.command = castHandlers.subscribe
  serveChannel(env.a, { spec: CAST, label: 'Sender', handlers: castHandlers, events: { state () {} } })
  serveChannel(env.a, { spec: GUARD, label: 'Guard', handlers: { hello: () => ({ status: 1 }), rvFetch: () => ({ cards: [] }) }, events: { rvUnregister () {}, circuitDead () {} } })

  for (const spec of [SEARCH, CAST, GUARD]) {
    const started = Date.now()
    const reopens = await flood(env.b, spec.protocol, { batch: 8, make: () => randomMessage(spec.ops.length) })
    t.diagnostic(`${spec.protocol}: ${COUNT} messages in ${Date.now() - started} ms, channel reopened ${reopens} times`)
    const control = await openChannel(env.b, { spec, label: 'Peer', refused: 'refused', duplicate: 'duplicate', timedOut: 'timed out' })
    if (spec === SEARCH) {
      // Random frames that happened to be valid queries used up the relay's rate window: wait it out.
      const ask = () => control.call('query', { q: 'stalker', mid: '', limit: 20 })
      const res = await ask().catch(async err => {
        assert.equal(err.message, 'busy', 'the relay answered, rate-limited')
        await new Promise(resolve => setTimeout(resolve, 10_500))
        return ask()
      })
      assert.equal(res.hits.length, 1, 'search still answers')
    }
    if (spec === CAST) assert.equal((await control.call('pair', { code: '' })).deviceId, 'd', 'cast still answers')
    if (spec === GUARD) assert.equal((await control.call('hello', { role: 'endpoint' })).status, 1, 'the guard channel still answers')
    control.close()
    await env.download()
  }
  assert.deepEqual(faults, [], 'nothing reached the process as an error')
})

test('100,000 random messages into each guarded foreign decoder change nothing and keep the connection', { timeout: 600_000 }, async t => {
  const env = await setup(t)
  const unmarked = []
  const seeder = createHiverelaySeeder({
    node: {
      privateRouting: false,
      channel: { local: { keyPair: { secretKey: b4a.alloc(64, 1) } } },
      store: { primaryKey: b4a.alloc(32, 1) },
      swarm: { join: () => ({ destroy: async () => {} }), leavePeer () {} },
      onConnection: () => () => {},
      peerConnections: () => [env.a],
      seedableCores: () => []
    },
    discover: true,
    traffic: { markBulk () {}, unmarkBulk: conn => unmarked.push(conn), info: () => ({}) }
  })
  t.after(() => seeder.stop())
  await seeder.run({ discover: true })
  const gate = createTrafficGate({ node: { privateRouting: false, peerConnections: () => [env.a], onConnection: () => () => {}, isSourcePeer: () => true } })
  t.after(() => gate.stop())

  // Random bytes, and random bytes behind a valid relay key so the accept and deny handlers get past their first check.
  // Each of the four seed messages gets COUNT of its own, and each one the guard lets through reaches its decoder:
  // all of them, but for an unseed request over 137 bytes.
  const relayKey = env.b.publicKey
  const encodings = [seedRequestEncoding, seedAcceptEncoding, unseedRequestEncoding, seedDenyEncoding]
  const decoders = encodings.map(e => e.decode)
  const decoded = [0, 0, 0, 0]
  encodings.forEach((e, i) => { e.decode = s => { decoded[i]++; return decoders[i](s) } })
  t.after(() => encodings.forEach((e, i) => { e.decode = decoders[i] }))
  let unseedsWithin = 0
  const seedMessage = slot => {
    const msg = randomInt(2) === 0 || slot === 0 || slot === 2
      ? randomBytes(randomInt(0, 200))
      : b4a.concat([randomBytes(32), relayKey, randomBytes(randomInt(0, 120))])
    if (slot === 2 && msg.byteLength <= 137) unseedsWithin++
    return msg
  }
  let started = Date.now()
  let reopens = await flood(env.b, 'hiverelay-seed', { slots: 4, handshake: b4a.from('{"major":1,"minor":0}'), make: seedMessage })
  t.diagnostic(`hiverelay-seed: ${COUNT} messages to each of 4 decoders in ${Date.now() - started} ms, channel reopened ${reopens} times, decoded ${decoded.join('/')}`)
  assert.equal(reopens, 0, 'the seed channel stays open')
  assert.deepEqual(decoded, [COUNT, COUNT, unseedsWithin, COUNT], 'each message reached its own decoder')
  assert.deepEqual(seeder.info().p2pAcceptedRelays, [], 'no random accept was taken')

  // Then a valid seed request and a valid accept on a new seed channel are taken.
  const seedOpen = Protomux.from(env.b).createChannel({ protocol: 'hiverelay-seed', handshake: c.raw })
  const [request, accept] = [0, 1, 2, 3].map(() => seedOpen.addMessage({ encoding: c.raw }))
  seedOpen.open(b4a.from('{"major":1,"minor":0}'))
  const unmarkedBefore = unmarked.length
  request.send(c.encode(seedRequestEncoding, { appKey: b4a.alloc(32, 3), discoveryKeys: [], replicationFactor: 1, geoPreference: '', maxStorageBytes: 0, bountyRate: 0, ttlSeconds: 0, publisherPubkey: b4a.alloc(32), publisherSignature: b4a.alloc(64), revocable: 1, unseedFreezeMs: 0, durability: 0 }))
  accept.send(c.encode(seedAcceptEncoding, { appKey: b4a.alloc(32, 2), relayPubkey: relayKey, region: 'eu', availableStorageBytes: 1024, relaySignature: b4a.alloc(64) }))
  await until(() => unmarked.length === unmarkedBefore + 1, 5000, 'a valid seed request')
  await until(() => seeder.info().p2pAcceptedRelays.length === 1, 5000, 'a valid seed accept')
  seedOpen.close()
  await env.download()

  started = Date.now()
  reopens = await flood(env.b, 'peartube/bulk-busy', { make: () => randomBytes(randomInt(0, 12)) })
  t.diagnostic(`peartube/bulk-busy: ${COUNT} messages in ${Date.now() - started} ms, channel reopened ${reopens} times`)
  assert.equal(reopens, 0, 'the busy channel stays open')
  // Then valid flags on a new busy channel count.
  const busyOpen = Protomux.from(env.b).createChannel({ protocol: 'peartube/bulk-busy', id: null })
  const busy = busyOpen.addMessage({ encoding: c.raw })
  busyOpen.open()
  busy.send(c.encode(c.uint, 1))
  await until(() => gate.peersBusy(), 5000, 'a valid busy claim')
  busy.send(c.encode(c.uint, 0))
  await until(() => !gate.peersBusy(), 5000, 'a valid idle claim')
  busyOpen.close()
  await env.download()
  assert.deepEqual(faults, [], 'nothing reached the process as an error')
})
