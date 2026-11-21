// The typed request/reply envelope (src/control-channel.js) against a hostile peer, on a real Noise connection that
// also replicates a Hypercore. A raw Protomux channel under the same protocol name stands in for the peer, so it can
// send any bytes. Every case ends with a valid request answered on that channel and a fresh block downloaded on the
// same connection: nothing a peer sends may close the connection or end the process.
// These fail on the envelope before v2: it spoke JSON objects and had no op list, kinds, ids, error codes or counts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
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
import { MAX_FRAME, openChannel, serveChannel } from '../src/control-channel.js'
import { commandToWire, stateToWire } from '../src/cast-control.js'

const FRAME = getEncoding('@peartube/frame')
const QUERY = getEncoding('@peartube/search-query')
const HITS = getEncoding('@peartube/search-hits')
const HIT = getEncoding('@peartube/search-hit')
const REMOTE_ERROR = getEncoding('@peartube/remote-error')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-envelope-${label}-`))
const opened = { refused: 'refused', duplicate: 'duplicate', timedOut: 'timed out' }

// A protocol made of real structs: `echo` answers, `note` is an event, `unserved` has no handler on either side.
const SPEC = {
  protocol: 'peartube/test-envelope/v2',
  ops: [
    { name: 'echo', kind: 'request', request: '@peartube/search-query', response: '@peartube/search-hits', maxItems: 20, flags: false },
    { name: 'note', kind: 'event', event: '@peartube/search-hit' },
    { name: 'unserved', kind: 'request', request: '@peartube/cast-pair', response: '@peartube/cast-pair' }
  ]
}

function echo (query) {
  if (query.q === 'throw') null.boom() // a TypeError inside the handler
  if (query.q === 'string') throw 'plain words' // not an Error: its text is the message
  if (query.q === 'unencodable') return { hits: null }
  if (query.q === 'huge') return { hits: [{ uri: 'x'.repeat(MAX_FRAME) }] }
  if (query.q === 'many') return { hits: Array.from({ length: 21 }, () => ({ uri: 'x' })) }
  return { hits: [{ uri: query.q }] }
}

// Two nodes' worth of connection: Noise, Corestore replication, and the envelope serving SPEC on `a`.
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
  const notes = []
  serveChannel(a, { spec: SPEC, label: 'Peer', handlers: { echo }, events: { note: hit => notes.push(hit.uri) } })
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
    notes,
    // A new block appended on one side and read on the other, over the same connection.
    async download () {
      const i = block++
      await core.append(b4a.from(`block ${i}`))
      const got = await remote.get(i, { timeout: 10_000 })
      assert.equal(b4a.toString(got), `block ${i}`, 'a block downloads on the same connection')
    }
  }
}

// A raw channel: `send` writes any bytes as one message, `frames` collects what the other side sent.
function rawPeer (conn, protocol = SPEC.protocol) {
  const frames = []
  let closed = false
  let wake = null
  let onopen = null
  const isOpen = new Promise(resolve => { onopen = resolve })
  const channel = Protomux.from(conn).createChannel({ protocol, onopen: () => onopen(), onclose: () => { closed = true } })
  const msg = channel.addMessage({
    encoding: c.raw,
    onmessage (buf) {
      frames.push(c.decode(FRAME, buf))
      wake?.()
    }
  })
  channel.open()
  return {
    frames,
    get closed () { return closed },
    opened: isOpen,
    send: buf => msg.send(buf),
    // Between cork and uncork, sends leave as one batch, which the other side reads in one go.
    cork: () => channel.cork(),
    uncork: () => channel.uncork(),
    close: () => channel.close(),
    async next (match, ms = 5000) {
      const end = Date.now() + ms
      for (;;) {
        const found = frames.find(match)
        if (found) return found
        if (Date.now() > end) return null
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 50) })
      }
    }
  }
}

const frame = (kind, op, id, value) => c.encode(FRAME, { kind, op, id, value })
const ask = (id, q) => frame(0, 0, id, c.encode(QUERY, { q, mid: '', limit: 1 }))
const errorOf = f => c.decode(REMOTE_ERROR, f.value)
const replyTo = (peer, id, ms) => peer.next(f => f.id === id, ms)
// A varint at 2^53: 0xff then eight little-endian bytes.
const varint53 = b4a.from([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0])
// A valid request frame of exactly `bytes` bytes (64 KiB and around it): kind, op and id take one byte each, the
// value's length three; the value is a query, then bytes its decoder ignores (fields of a later schema version).
function sized (id, bytes) {
  const query = c.encode(QUERY, { q: `sized ${id}`, mid: '', limit: 1 })
  const buf = frame(0, 0, id, b4a.concat([query, b4a.alloc(bytes - 6 - query.byteLength)]))
  assert.equal(buf.byteLength, bytes)
  return buf
}

async function stillWorks (peer, env, id) {
  peer.send(ask(id, `alive ${id}`))
  const res = await replyTo(peer, id)
  assert.ok(res, 'a valid request on the same channel is answered')
  assert.equal(res.kind, 1)
  assert.deepEqual(c.decode(HITS, res.value), { hits: [{ uri: `alive ${id}` }] })
  assert.equal(env.a.destroyed || env.b.destroyed, false, 'the connection is open')
  await env.download()
}

test('envelope: hostile frames are dropped or answered; the channel and the connection keep working', { timeout: 60_000 }, async t => {
  const env = await setup(t)

  await t.test('a frame of 65,536 bytes is taken and one of 65,537 is dropped', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(sized(1, 65_536))
    const taken = await replyTo(peer, 1)
    assert.equal(taken?.kind, 1, 'a frame at the cap is answered')
    assert.deepEqual(c.decode(HITS, taken.value), { hits: [{ uri: 'sized 1' }] })
    peer.send(sized(2, 65_537))
    assert.equal(await replyTo(peer, 2, 500), null, 'no answer to a frame one byte over')
    await stillWorks(peer, env, 3)
    peer.close()
  })

  await t.test('kind, op or id at or above 2^53 is dropped', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(b4a.concat([varint53, b4a.from([0, 1, 0])])) // kind
    peer.send(b4a.concat([b4a.from([0]), varint53, b4a.from([1, 0])])) // op
    peer.send(b4a.concat([b4a.from([0, 0]), varint53, b4a.from([0])])) // id
    await sleep(300)
    assert.equal(peer.frames.length, 0, 'none of them is answered')
    await stillWorks(peer, env, 3)
    peer.close()
  })

  await t.test('a kind above 3 is dropped', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(frame(4, 0, 1, b4a.alloc(0)))
    assert.equal(await replyTo(peer, 1, 300), null)
    await stillWorks(peer, env, 4)
    peer.close()
  })

  await t.test('a value that does not decode is answered DECODE_ERROR', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(frame(0, 0, 5, b4a.from([0xff])))
    const res = await replyTo(peer, 5)
    assert.equal(res.kind, 2)
    assert.equal(errorOf(res).code, 'DECODE_ERROR')
    await stillWorks(peer, env, 6)
    peer.close()
  })

  await t.test('an unknown op is answered UNKNOWN_OP at once', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    const started = Date.now()
    peer.send(frame(0, 2, 7, c.encode(getEncoding('@peartube/cast-pair'), { code: 'x' }))) // no handler here
    peer.send(frame(0, 1, 8, b4a.alloc(0))) // an event op
    peer.send(frame(0, 99, 9, b4a.alloc(0))) // beyond the list
    for (const id of [7, 8, 9]) assert.equal(errorOf(await replyTo(peer, id)).code, 'UNKNOWN_OP')
    assert.ok(Date.now() - started < 1000, 'answered in under 1 s')
    await stillWorks(peer, env, 10)
    peer.close()
  })

  await t.test('a handler that throws a TypeError is answered HANDLER_ERROR with its message', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(ask(11, 'throw'))
    const err = errorOf(await replyTo(peer, 11))
    assert.equal(err.code, 'HANDLER_ERROR')
    assert.match(err.message, /null/)
    await stillWorks(peer, env, 12)
    peer.close()
  })

  await t.test('a handler that throws a string is answered HANDLER_ERROR with that string', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(ask(1, 'string'))
    assert.deepEqual(errorOf(await replyTo(peer, 1)), { code: 'HANDLER_ERROR', message: 'plain words' })
    await stillWorks(peer, env, 2)
    peer.close()
  })

  await t.test('a result that cannot be encoded, is too large, or has too many items is answered ENCODE_ERROR', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(ask(13, 'unencodable'))
    peer.send(ask(14, 'huge'))
    peer.send(ask(15, 'many'))
    for (const id of [13, 14, 15]) assert.equal(errorOf(await replyTo(peer, id)).code, 'ENCODE_ERROR')
    await stillWorks(peer, env, 16)
    peer.close()
  })

  await t.test('a request with id 0 and an event with a nonzero id are dropped', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    peer.send(ask(0, 'zero'))
    peer.send(frame(3, 1, 5, c.encode(HIT, { uri: 'numbered' })))
    peer.send(frame(3, 1, 0, c.encode(HIT, { uri: 'proper' })))
    await sleep(300)
    assert.equal(peer.frames.length, 0, 'no answer to id 0')
    assert.deepEqual(env.notes, ['proper'], 'only the event with id 0 reaches the handler')
    await stillWorks(peer, env, 17)
    peer.close()
  })

  await t.test('eight bad frames close the channel, not the connection', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    for (let i = 0; i < 8; i++) peer.send(b4a.from([0xff]))
    const end = Date.now() + 5000
    while (!peer.closed && Date.now() < end) await sleep(50)
    assert.equal(peer.closed, true, 'the channel closed')
    const again = rawPeer(env.b)
    await again.opened
    await stillWorks(again, env, 1)
    again.close()
  })

  await t.test('the eighth request that does not decode is still answered before the channel closes', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    for (let id = 1; id <= 8; id++) peer.send(frame(0, 0, id, b4a.from([0xff])))
    const end = Date.now() + 5000
    while (!peer.closed && Date.now() < end) await sleep(50)
    assert.equal(peer.closed, true, 'the channel closed')
    assert.deepEqual(peer.frames.map(f => [f.kind, f.op, f.id, errorOf(f).code]), [1, 2, 3, 4, 5, 6, 7, 8].map(id => [2, 0, id, 'DECODE_ERROR']))
  })

  await t.test('a bad frame older than 10 s no longer counts toward the eight', async () => {
    const peer = rawPeer(env.b)
    await peer.opened
    const now = Date.now
    let skew = 0
    Date.now = () => now() + skew
    try {
      for (let i = 0; i < 7; i++) peer.send(b4a.from([0xff]))
      await stillWorks(peer, env, 1)
      skew = 10_001
      for (let i = 0; i < 7; i++) peer.send(b4a.from([0xff]))
      await stillWorks(peer, env, 2)
      assert.equal(peer.closed, false, 'seven strikes from over 10 s ago and seven new ones leave the channel open')
      peer.send(b4a.from([0xff]))
      const end = Date.now() + 5000
      while (!peer.closed && Date.now() < end) await sleep(50)
      assert.equal(peer.closed, true, 'the eighth new strike closes it')
    } finally {
      Date.now = now
    }
  })
})

// emit has three outcomes: sent (true), sent but wait for 'drain' before the next (false), and nothing sent (null: a
// closed channel, or a value that cannot be sent). A sender waits for 'drain' only after false, so it never waits
// for one that will not come, and a false is never a reason to send the same event again.
test('envelope: emit says sent, sent and wait for drain, or not sent', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const spec = { protocol: 'peartube/test-emit/v2', ops: SPEC.ops }
  let served = null
  const servedHalf = new Promise(resolve => { served = resolve })
  serveChannel(env.a, { spec, label: 'B', handlers: {}, onOpen: served })
  const notes = []
  await openChannel(env.b, { spec, label: 'A', events: { note: hit => notes.push(hit.uri) }, ...opened })
  const control = await servedHalf
  assert.equal(control.emit('note', { uri: null }), null, 'a value that cannot be encoded sends nothing')
  assert.equal(control.emit('note', { uri: 'x'.repeat(MAX_FRAME) }), null, 'a frame over the cap sends nothing')
  assert.equal(control.emit('nothing', {}), null, 'no such event sends nothing')
  await sleep(200) // the stream has written everything the open and replication queued
  assert.equal(control.emit('note', { uri: 'small' }), true, 'a small event on an idle stream is sent')
  assert.equal(control.emit('note', { uri: 'y'.repeat(60_000) }), false, 'one beyond the stream\'s buffer is sent, and says wait for drain')
  await once(env.a, 'drain')
  for (let i = 0; i < 100 && notes.length < 2; i++) await sleep(20)
  assert.deepEqual(notes.map(uri => uri.length), [5, 60_000], 'each sent event arrives once')
  control.close()
  assert.equal(control.emit('note', { uri: 'late' }), null, 'a closed channel sends nothing')
  await sleep(200)
  assert.equal(notes.length, 2)
})

test('envelope: both sides ask on one channel with the same ids, and each gets its own answer', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const spec = { protocol: 'peartube/test-two-way/v2', ops: SPEC.ops }
  const answer = side => query => ({ hits: [{ uri: `${side}:${query.q}` }] })
  let servedHalf = null
  const served = new Promise(resolve => { servedHalf = resolve })
  serveChannel(env.a, { spec, label: 'B', handlers: { echo: answer('a') }, onOpen: servedHalf })
  const fromB = await openChannel(env.b, { spec, label: 'A', handlers: { echo: answer('b') }, ...opened })
  const fromA = await served
  // Both first calls carry id 1, at the same time, in opposite directions.
  const [toA, toB] = await Promise.all([
    fromB.call('echo', { q: 'one', mid: '', limit: 1 }),
    fromA.call('echo', { q: 'one', mid: '', limit: 1 })
  ])
  assert.deepEqual(toA.hits, [{ uri: 'a:one' }], 'b asked and a answered')
  assert.deepEqual(toB.hits, [{ uri: 'b:one' }], 'a asked and b answered')
  await env.download()
})

// A value that declares 2^20 items and holds none: the count is read before the generated decoder runs, so that
// decoder (which would allocate for the declared count first) is never called, and the value counts as bad.
test('envelope: an array count above its op limit is refused before the decoder runs', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const COUNT = b4a.from([0xfe, 0x00, 0x00, 0x10, 0x00]) // uint 1,048,576
  const cases = [
    { spec: SEARCH, ask: 'query', value: { q: 'x', mid: '', limit: 1 }, struct: '@peartube/search-hits', body: COUNT },
    { spec: GUARD, ask: 'rvLookup', value: { key: b4a.alloc(32) }, struct: '@peartube/guard-cards', body: COUNT },
    { spec: CAST, ask: 'subscribe', value: { token: 't' }, struct: '@peartube/cast-state', body: b4a.concat([b4a.from([0]), COUNT]) }
  ]
  for (const { spec, ask: name, value, struct, body } of cases) {
    const decoder = getEncoding(struct)
    const decode = decoder.decode
    let calls = 0
    decoder.decode = state => { calls++; return decode(state) }
    try {
      const peer = rawPeer(env.b, spec.protocol)
      const stateEvents = []
      const opening = openChannel(env.a, { spec, label: 'Peer', events: { state: s => stateEvents.push(s) }, ...opened })
      await peer.opened
      const control = await opening
      // Seven refused answers in a row, then (for cast) one refused event: eight bad values close the channel.
      const op = spec.ops.findIndex(o => o.name === name)
      for (let i = 1; i <= 7; i++) {
        const pending = control.call(name, value)
        const req = await peer.next(f => f.kind === 0 && f.id === i)
        assert.ok(req, 'the request reaches the peer')
        peer.send(frame(1, op, i, body))
        await assert.rejects(pending, err => err.code === 'DECODE_ERROR', `${struct}: the answer is refused`)
      }
      assert.equal(calls, 0, `${struct}: the generated decoder never ran`)
      if (spec === CAST) {
        peer.send(frame(3, spec.ops.findIndex(o => o.name === 'state'), 0, body))
        const end = Date.now() + 5000
        while (!peer.closed && Date.now() < end) await sleep(50)
        assert.equal(peer.closed, true, 'the eighth bad value closed the channel')
        assert.equal(stateEvents.length, 0)
        assert.equal(calls, 0, 'the state event was refused before the decoder too')
      } else {
        peer.close()
        await sleep(100)
      }
    } finally {
      decoder.decode = decode
    }
  }
  assert.equal(env.a.destroyed || env.b.destroyed, false, 'the connection is open')
  await env.download()
})

const QUERY_VALUE = { q: 'x', mid: '', limit: 1 }

// This side's channel (openChannel on a) against a raw peer on b, under `spec`.
async function againstRaw (env, spec, options = {}) {
  const peer = rawPeer(env.b, spec.protocol)
  const opening = openChannel(env.a, { spec, label: 'Peer', ...options, ...opened })
  await peer.opened
  return { peer, control: await opening }
}

test('envelope: the first two requests on each side carry ids 1 and 2', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const asked = async (peer, control) => {
    control.call('echo', QUERY_VALUE).catch(() => {})
    control.call('echo', QUERY_VALUE).catch(() => {})
    await peer.next(() => peer.frames.length >= 2)
    return peer.frames.map(f => [f.kind, f.id])
  }
  const opener = await againstRaw(env, { protocol: 'peartube/test-ids-open/v2', ops: SPEC.ops })
  assert.deepEqual(await asked(opener.peer, opener.control), [[0, 1], [0, 2]], 'the side that opened')
  const spec = { protocol: 'peartube/test-ids-serve/v2', ops: SPEC.ops }
  let served = null
  const servedHalf = new Promise(resolve => { served = resolve })
  serveChannel(env.a, { spec, label: 'Peer', handlers: {}, onOpen: served })
  const peer = rawPeer(env.b, spec.protocol)
  assert.deepEqual(await asked(peer, await servedHalf), [[0, 1], [0, 2]], 'the side that served')
})

test('envelope: a pending call is rejected when eight bad frames close its channel', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const { peer, control } = await againstRaw(env, { protocol: 'peartube/test-budget/v2', ops: SPEC.ops })
  const call = control.call('echo', QUERY_VALUE, 30_000)
  assert.ok(await peer.next(f => f.kind === 0), 'the request reached the peer')
  for (let i = 0; i < 8; i++) peer.send(b4a.from([0xff]))
  const outcome = await Promise.race([call.then(() => 'answered', err => err.message), sleep(3000).then(() => 'still pending')])
  assert.equal(outcome, 'Peer connection closed')
  assert.equal(control.closed, true)
  assert.equal(env.a.destroyed || env.b.destroyed, false, 'the connection is open')
  await env.download()
})

// A reply matches a call by op and id. One with the call's id under another op, whose value would decode as the
// call's answer, settles nothing and is never decoded.
test('envelope: a reply with the right id and another op leaves the call pending and is not decoded', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const { peer, control } = await againstRaw(env, { protocol: 'peartube/test-wrong-op/v2', ops: SPEC.ops })
  const spied = [HITS, REMOTE_ERROR, getEncoding('@peartube/cast-pair')]
  const decoders = spied.map(e => e.decode)
  let decodes = 0
  for (const [i, e] of spied.entries()) e.decode = state => { decodes++; return decoders[i](state) }
  try {
    let settled = null
    const call = control.call('echo', QUERY_VALUE)
    call.then(value => { settled = value }, err => { settled = err })
    const req = await peer.next(f => f.kind === 0)
    peer.send(frame(1, 2, req.id, c.encode(HITS, { hits: [{ uri: 'WRONG OP' }] })))
    peer.send(frame(2, 2, req.id, c.encode(REMOTE_ERROR, { code: 'HANDLER_ERROR', message: 'WRONG OP' })))
    await sleep(300)
    assert.equal(settled, null, 'a reply under another op settles nothing')
    assert.equal(decodes, 0, 'and is never decoded')
    peer.send(frame(1, 0, req.id, c.encode(HITS, { hits: [{ uri: 'right op' }] })))
    assert.deepEqual(await call, { hits: [{ uri: 'right op' }] })
    assert.equal(decodes, 1)
  } finally {
    for (const [i, e] of spied.entries()) e.decode = decoders[i]
  }
})

// Frames of one channel are handled in wire order: a request's handler starts before the event after it is handled.
test('envelope: an event sent right after a request reaches the handlers after the request', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const spec = { protocol: 'peartube/test-order/v2', ops: SPEC.ops }
  const order = []
  serveChannel(env.a, {
    spec,
    label: 'Peer',
    handlers: {
      async echo (query) {
        order.push(`request ${query.q}`)
        await sleep(10)
        return { hits: [] }
      }
    },
    events: { note: hit => order.push(`event ${hit.uri}`) }
  })
  const peer = rawPeer(env.b, spec.protocol)
  await peer.opened
  peer.cork()
  peer.send(ask(1, 'first'))
  peer.send(frame(3, 1, 0, c.encode(HIT, { uri: 'second' })))
  peer.uncork()
  assert.ok(await replyTo(peer, 1))
  assert.deepEqual(order, ['request first', 'event second'])
})

test('envelope: an error code that is not the envelope\'s arrives as HANDLER_ERROR with its message', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const { peer, control } = await againstRaw(env, { protocol: 'peartube/test-codes/v2', ops: SPEC.ops })
  const forged = control.call('echo', QUERY_VALUE)
  const real = control.call('echo', QUERY_VALUE)
  await peer.next(() => peer.frames.length >= 2)
  peer.send(frame(2, 0, 1, c.encode(REMOTE_ERROR, { code: 'ETIMEDOUT', message: 'forged' })))
  peer.send(frame(2, 0, 2, c.encode(REMOTE_ERROR, { code: 'DECODE_ERROR', message: 'real' })))
  await assert.rejects(forged, err => err.code === 'HANDLER_ERROR' && err.message === 'forged')
  await assert.rejects(real, err => err.code === 'DECODE_ERROR' && err.message === 'real')
})

test('envelope: an event handler whose promise rejects leaves no unhandled rejection', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  let unhandled = 0
  const count = () => { unhandled++ }
  process.on('unhandledRejection', count)
  t.after(() => process.off('unhandledRejection', count))
  const spec = { protocol: 'peartube/test-async-event/v2', ops: SPEC.ops }
  let ran = 0
  serveChannel(env.a, { spec, label: 'Peer', handlers: { echo }, events: { note: async () => { ran++; throw new Error('the handler failed later') } } })
  const peer = rawPeer(env.b, spec.protocol)
  await peer.opened
  peer.send(frame(3, 1, 0, c.encode(HIT, { uri: 'note' })))
  await stillWorks(peer, env, 1)
  await sleep(100)
  assert.equal(ran, 1)
  assert.equal(unhandled, 0)
})

// The other side pairs the protocol and never opens its half: the open times out, which is not a refusal.
test('envelope: an open that is never answered rejects with the timeout, not the refusal', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const spec = { protocol: 'peartube/test-unanswered/v2', ops: SPEC.ops }
  Protomux.from(env.a).pair({ protocol: spec.protocol }, () => new Promise(() => {}))
  await assert.rejects(openChannel(env.b, { spec, label: 'Peer', ...opened }, 300), { message: 'timed out' })
})

// Every float on the wire is finite. cast-command.volume and cast-state.volume, both ways: what holds NaN or an
// infinity is not sent, and what arrives holding one is a value that does not decode.
test('envelope: a number that is not finite is neither sent nor taken', { timeout: 30_000 }, async t => {
  const env = await setup(t)
  const STATE = getEncoding('@peartube/cast-state')
  const COMMAND = getEncoding('@peartube/cast-command')
  const idle = stateToWire({ status: 'idle' })
  const command = commandToWire({ action: 'volume', volume: 0.5 }, 't')
  const op = name => CAST.ops.findIndex(o => o.name === name)
  for (const bad of [NaN, Infinity]) {
    const commands = []
    const states = []
    const { peer, control } = await againstRaw(env, { protocol: `peartube/test-finite-${bad}/v2`, ops: CAST.ops }, {
      handlers: { command: wire => { commands.push(wire); return { ...idle, volume: bad } } },
      events: { state: s => states.push(s.volume) }
    })
    // Not sent: a request, an event, an answer.
    await assert.rejects(control.call('command', { ...command, volume: bad }), { code: 'ENCODE_ERROR' })
    assert.equal(control.emit('state', { ...idle, volume: bad }), null)
    peer.send(frame(0, op('command'), 1, c.encode(COMMAND, command)))
    assert.equal(errorOf(await replyTo(peer, 1)).code, 'ENCODE_ERROR', `${bad} in an answer is not sent`)
    // Not taken: a request, an event, an answer.
    peer.send(frame(0, op('command'), 2, c.encode(COMMAND, { ...command, volume: bad })))
    assert.equal(errorOf(await replyTo(peer, 2)).code, 'DECODE_ERROR', `${bad} in a request is not taken`)
    assert.deepEqual(commands.map(w => w.volume), [0.5], 'only the finite command reached the handler')
    peer.send(frame(3, op('state'), 0, c.encode(STATE, { ...idle, volume: bad })))
    peer.send(frame(3, op('state'), 0, c.encode(STATE, idle)))
    const subscribing = control.call('subscribe', { token: 't' })
    const req = await peer.next(f => f.kind === 0)
    assert.equal(req.op, op('subscribe'), 'the request with a bad number never reached the peer')
    peer.send(frame(1, op('subscribe'), req.id, c.encode(STATE, { ...idle, volume: bad })))
    await assert.rejects(subscribing, { code: 'DECODE_ERROR' })
    assert.deepEqual(states, [1], `${bad} in an event is not taken`)
    peer.close()
  }
  await env.download()
})
