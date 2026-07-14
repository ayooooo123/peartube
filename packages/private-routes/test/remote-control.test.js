import test from 'brittle'
import b4a from 'b4a'

import {
  ACTOR_CONTROL_BODY_MAX,
  ACTOR_CONTROL_HEADER_SIZE,
  ACTOR_CONTROL_KIND,
  ACTOR_ERROR_CODE,
  CIRCUIT_DESTROY_REASON,
  CONTROL_NAMESPACE,
  LINK_CONTROL_BODY_SIZE,
  LINK_CONTROL_KIND,
  MAX_ACTIVATION_FRAGMENT_DATA,
  MAX_COMPLETED_REMOTE_CONTROL_IDS,
  MAX_REMOTE_CONTROL_FRAGMENT_DATA,
  MAX_REMOTE_CONTROL_FRAGMENTS,
  MAX_REMOTE_CONTROL_OBJECT,
  REMOTE_CONTROL_FRAGMENT_HEADER_SIZE,
  REMOTE_CONTROL_FRAGMENT_TIMEOUT,
  ActorControlCodec,
  LinkControlCodec,
  RemoteControlFragmentCodec,
  RemoteControlMux,
  validateActorReply
} from '../index.js'
import { CELL_CLASS, DIRECTION } from '../lib/protocol.js'
import { expectCode } from './helpers.js'

function bytes(size, value) {
  return b4a.alloc(size, value)
}

function outer(direction = DIRECTION.FORWARD, circuitId = bytes(16, 0x31)) {
  return { class: CELL_CLASS.CONTROL, direction, circuitId }
}

function actor(kind, overrides = {}) {
  const registration =
    kind >= ACTOR_CONTROL_KIND.REGISTER_STAGE && kind <= ACTOR_CONTROL_KIND.REGISTER_ABORTED
  return {
    version: 0,
    kind,
    flags: 0,
    requestId: 7n,
    actorId: bytes(16, 0x41),
    circuitId: registration ? bytes(16) : bytes(16, 0x42),
    generation: registration ? 0n : 9n,
    body: bytes(3, 0x43),
    ...overrides
  }
}

function frame(messageId, index, total, objectLength, data = b4a.alloc(0)) {
  const output = b4a.alloc(REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + data.byteLength)
  output.set(messageId, 0)
  output[16] = index >>> 8
  output[17] = index
  output[18] = total >>> 8
  output[19] = total
  output[20] = objectLength >>> 8
  output[21] = objectLength
  output.set(data, REMOTE_CONTROL_FRAGMENT_HEADER_SIZE)
  return output
}

test('remote control constants lock the transport-specific wire bounds', (t) => {
  t.is(CONTROL_NAMESPACE.LINK, 0x00)
  t.is(CONTROL_NAMESPACE.ACTOR, 0x01)
  t.is(LINK_CONTROL_BODY_SIZE, 44)
  t.is(REMOTE_CONTROL_FRAGMENT_HEADER_SIZE, 22)
  t.is(MAX_REMOTE_CONTROL_FRAGMENT_DATA, 1123)
  t.is(MAX_REMOTE_CONTROL_OBJECT, 8192)
  t.is(MAX_REMOTE_CONTROL_FRAGMENTS, 8)
  t.is(REMOTE_CONTROL_FRAGMENT_TIMEOUT, 5_000)
  t.is(MAX_COMPLETED_REMOTE_CONTROL_IDS, 64)
  t.is(ACTOR_CONTROL_HEADER_SIZE, 54)
  t.is(ACTOR_CONTROL_BODY_MAX, 8138)
  t.is(MAX_ACTIVATION_FRAGMENT_DATA, 1124, 'the virtual activation format is unchanged')
})

test('link control codec locks ping, pong, and opposite-direction stream ACKs', (t) => {
  const codec = new LinkControlCodec()
  const circuitId = bytes(16, 0x11)
  const challenge = bytes(16, 0x12)

  for (const kind of [LINK_CONTROL_KIND.LINK_PING, LINK_CONTROL_KIND.LINK_PONG]) {
    const value = {
      version: 0,
      kind,
      flags: 0,
      direction: DIRECTION.FORWARD,
      circuitId,
      generation: 0n,
      challenge
    }
    const encoded = codec.encode(value, outer(DIRECTION.FORWARD, circuitId))
    t.is(encoded.byteLength, LINK_CONTROL_BODY_SIZE)
    t.alike(codec.decode(encoded, outer(DIRECTION.FORWARD, circuitId)), value)
  }

  const ack = {
    version: 0,
    kind: LINK_CONTROL_KIND.STREAM_ACK,
    flags: 0,
    direction: DIRECTION.REVERSE,
    circuitId,
    generation: 17n,
    acknowledgedDirection: DIRECTION.FORWARD,
    counter: 0x0102_0304_0506_0708n
  }
  const encoded = codec.encode(ack, outer(DIRECTION.REVERSE, circuitId))
  t.alike(encoded.subarray(28, 36), b4a.from('0102030405060708', 'hex'))
  t.alike(encoded.subarray(36, 44), b4a.alloc(8))
  t.alike(codec.decode(encoded, outer(DIRECTION.REVERSE, circuitId)), ack)
  t.alike(
    codec.decode(encoded, {
      ...outer(DIRECTION.REVERSE, circuitId),
      acknowledgedDirection: DIRECTION.REVERSE
    }),
    ack,
    'unauthenticated extra metadata cannot alter the wire-derived direction'
  )
})

test('link control rejects every malformed field and outer-header mismatch', (t) => {
  const codec = new LinkControlCodec()
  const circuitId = bytes(16, 0x21)
  const ping = codec.encode(
    {
      version: 0,
      kind: LINK_CONTROL_KIND.LINK_PING,
      flags: 0,
      direction: DIRECTION.FORWARD,
      circuitId,
      generation: 0n,
      challenge: bytes(16, 0x22)
    },
    outer(DIRECTION.FORWARD, circuitId)
  )
  const mutations = [
    ['version', 0, 1],
    ['kind', 1, 0xff],
    ['flags', 2, 1],
    ['direction', 3, DIRECTION.REVERSE],
    ['circuit', 4, ping[4] ^ 1],
    ['generation', 27, 1]
  ]
  for (const [name, offset, value] of mutations) {
    const malformed = b4a.from(ping)
    malformed[offset] = value
    expectCode(
      t,
      () => codec.decode(malformed, outer(DIRECTION.FORWARD, circuitId)),
      'INVALID_ROUTE'
    )
    t.pass(name)
  }
  expectCode(
    t,
    () => codec.decode(ping.subarray(0, 43), outer(DIRECTION.FORWARD, circuitId)),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => codec.decode(b4a.concat([ping, b4a.from([0])]), outer(DIRECTION.FORWARD, circuitId)),
    'INVALID_ROUTE'
  )
  expectCode(t, () => codec.decode(ping, outer(DIRECTION.REVERSE, circuitId)), 'INVALID_ROUTE')
  expectCode(
    t,
    () => codec.decode(ping, outer(DIRECTION.FORWARD, bytes(16, 0x23))),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => codec.decode(ping, { ...outer(DIRECTION.FORWARD, circuitId), class: CELL_CLASS.STREAM }),
    'INVALID_ROUTE'
  )

  const ack = codec.encode(
    {
      version: 0,
      kind: LINK_CONTROL_KIND.STREAM_ACK,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId,
      generation: 1n,
      acknowledgedDirection: DIRECTION.FORWARD,
      counter: 1n
    },
    outer(DIRECTION.REVERSE, circuitId)
  )
  const nonzeroReserved = b4a.from(ack)
  nonzeroReserved[43] = 1
  expectCode(
    t,
    () => codec.decode(nonzeroReserved, outer(DIRECTION.REVERSE, circuitId)),
    'INVALID_ROUTE'
  )
})

test('control mux separates exact link bodies from actor fragments', (t) => {
  const mux = new RemoteControlMux()
  const circuitId = bytes(16, 0x31)
  const link = {
    version: 0,
    kind: LINK_CONTROL_KIND.LINK_PING,
    flags: 0,
    direction: DIRECTION.FORWARD,
    circuitId,
    generation: 0n,
    challenge: bytes(16, 0x32)
  }
  const linkPayload = mux.encodeLink(link, outer(DIRECTION.FORWARD, circuitId))
  t.is(linkPayload.byteLength, 1 + LINK_CONTROL_BODY_SIZE)
  t.is(linkPayload[0], CONTROL_NAMESPACE.LINK)
  t.alike(mux.decode(linkPayload, outer(DIRECTION.FORWARD, circuitId)), {
    namespace: CONTROL_NAMESPACE.LINK,
    message: link
  })

  const fragment = frame(bytes(16, 0x33), 0, 1, 1, b4a.from([0x34]))
  const actorPayload = mux.encodeActorFragment(fragment)
  t.is(actorPayload[0], CONTROL_NAMESPACE.ACTOR)
  t.alike(mux.decode(actorPayload, outer()), {
    namespace: CONTROL_NAMESPACE.ACTOR,
    fragment
  })
  fragment.fill(0)
  t.is(actorPayload[1], 0x33)

  for (const payload of [
    b4a.alloc(0),
    b4a.from([2]),
    b4a.from([CONTROL_NAMESPACE.LINK]),
    b4a.concat([linkPayload, b4a.from([0])]),
    b4a.from([CONTROL_NAMESPACE.ACTOR]),
    b4a.concat([
      b4a.from([CONTROL_NAMESPACE.ACTOR]),
      b4a.alloc(REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + MAX_REMOTE_CONTROL_FRAGMENT_DATA + 1)
    ])
  ]) {
    expectCode(t, () => mux.decode(payload, outer(DIRECTION.FORWARD, circuitId)), 'INVALID_ROUTE')
  }

  const reassembler = new RemoteControlFragmentCodec({ now: () => 0 })
  expectCode(t, () => reassembler.pushAuthenticated(linkPayload.subarray(1)), 'INVALID_ROUTE')
  t.is(reassembler.bufferedBytes, 0)
})

test('transport fragments use 1,123-byte data without changing virtual framing', (t) => {
  const codec = new RemoteControlFragmentCodec({ now: () => 0 })
  const message = bytes(MAX_REMOTE_CONTROL_OBJECT, 0x51)
  const messageId = bytes(16, 0x52)
  const frames = codec.fragment(message, { messageId })
  t.is(frames.length, 8)
  t.is(frames[0].byteLength, REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + MAX_REMOTE_CONTROL_FRAGMENT_DATA)
  t.is(frames.at(-1).byteLength, REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + 331)
  message.fill(0)
  messageId.fill(0)
  let result = null
  for (const value of frames) result = codec.pushAuthenticated(value)
  t.alike(result, bytes(MAX_REMOTE_CONTROL_OBJECT, 0x51))
  t.is(codec.bufferedBytes, 0)
  t.alike(codec.stats, {
    destroyed: false,
    bufferedBytes: 0,
    active: 0,
    completedIds: 1,
    timers: 0
  })

  expectCode(
    t,
    () => codec.fragment(bytes(MAX_REMOTE_CONTROL_OBJECT + 1), { messageId: bytes(16, 1) }),
    'INVALID_ROUTE'
  )
})

test('transport fragment structure, order, splice, replay, and bound failures clear state', (t) => {
  const make = () => new RemoteControlFragmentCodec({ now: () => 0 })
  const malformed = [
    b4a.alloc(21),
    frame(bytes(16, 1), 0, 0, 0),
    frame(bytes(16, 2), 1, 1, 0),
    frame(bytes(16, 3), 0, 9, 8192, bytes(1123)),
    frame(bytes(16, 4), 0, 2, 1, bytes(1)),
    frame(bytes(16, 5), 0, 1, 8193),
    b4a.alloc(REMOTE_CONTROL_FRAGMENT_HEADER_SIZE + MAX_REMOTE_CONTROL_FRAGMENT_DATA + 1)
  ]
  for (const value of malformed) {
    const codec = make()
    expectCode(t, () => codec.pushAuthenticated(value), 'INVALID_ROUTE')
    t.is(codec.bufferedBytes, 0)
  }

  const codec = make()
  const first = codec.fragment(bytes(1200, 6), { messageId: bytes(16, 6) })
  const other = codec.fragment(bytes(1200, 7), { messageId: bytes(16, 7) })
  t.is(codec.pushAuthenticated(first[0]), null)
  expectCode(t, () => codec.pushAuthenticated(other[1]), 'INVALID_ROUTE')
  t.is(codec.bufferedBytes, 0)

  const completed = codec.fragment(b4a.from('done'), { messageId: bytes(16, 8) })[0]
  t.alike(codec.pushAuthenticated(completed), b4a.from('done'))
  expectCode(t, () => codec.pushAuthenticated(completed), 'REPLAY')
  t.is(codec.bufferedBytes, 0)
})

test('fragment expiry is monotonic, scheduled once, and deeply cleaned', (t) => {
  let now = 100
  const scheduled = []
  const cancelled = []
  const codec = new RemoteControlFragmentCodec({
    now: () => now,
    schedule(delay, callback) {
      const handle = { delay, callback }
      scheduled.push(handle)
      return handle
    },
    cancel(handle) {
      cancelled.push(handle)
    }
  })
  const frames = codec.fragment(bytes(1200, 9), { messageId: bytes(16, 9) })
  t.is(codec.pushAuthenticated(frames[0]), null)
  t.is(scheduled.length, 1)
  t.is(scheduled[0].delay, REMOTE_CONTROL_FRAGMENT_TIMEOUT)
  now = 5_099
  scheduled[0].callback()
  t.ok(codec.bufferedBytes > 0)
  t.is(scheduled.length, 2)
  t.is(scheduled[1].delay, 1)
  now = 5_100
  scheduled[0].callback()
  t.ok(codec.bufferedBytes > 0, 'a duplicate stale callback cannot cancel the live timer')
  scheduled[1].callback()
  t.is(codec.bufferedBytes, 0)
  t.is(codec.stats.timers, 0)

  const completed = codec.fragment(b4a.from('ok'), { messageId: bytes(16, 10) })[0]
  t.alike(codec.pushAuthenticated(completed), b4a.from('ok'))
  t.is(cancelled.length, 1)
  codec.destroy()
  t.alike(codec.stats, { destroyed: true, bufferedBytes: 0, active: 0, completedIds: 0, timers: 0 })
})

test('fragment clock, scheduler, cancel, and reentrancy faults fail closed', (t) => {
  const partial = new RemoteControlFragmentCodec({ now: () => Number.MAX_SAFE_INTEGER })
  const frames = partial.fragment(bytes(1200, 11), { messageId: bytes(16, 11) })
  expectCode(t, () => partial.pushAuthenticated(frames[0]), 'INVALID_ROUTE')
  t.is(partial.bufferedBytes, 0)

  let now = 20
  const regression = new RemoteControlFragmentCodec({ now: () => now })
  const regressedFrames = regression.fragment(bytes(1200, 12), { messageId: bytes(16, 12) })
  t.is(regression.pushAuthenticated(regressedFrames[0]), null)
  now = 19
  expectCode(t, () => regression.pushAuthenticated(regressedFrames[1]), 'INVALID_ROUTE')
  t.is(regression.stats.destroyed, true)

  const scheduleThrow = new RemoteControlFragmentCodec({
    now: () => 0,
    schedule() {
      throw new Error('schedule')
    },
    cancel() {}
  })
  const scheduleFrames = scheduleThrow.fragment(bytes(1200, 13), { messageId: bytes(16, 13) })
  expectCode(t, () => scheduleThrow.pushAuthenticated(scheduleFrames[0]), 'INVALID_ROUTE')
  t.is(scheduleThrow.stats.destroyed, true)

  let sync = null
  const syncLive = new Set()
  const syncCancelled = []
  sync = new RemoteControlFragmentCodec({
    now: () => 0,
    schedule(_delay, callback) {
      const handle = { id: 1 }
      callback()
      syncLive.add(handle)
      return handle
    },
    cancel(handle) {
      syncCancelled.push(handle)
      syncLive.delete(handle)
    }
  })
  const syncFrames = sync.fragment(bytes(1200, 14), { messageId: bytes(16, 14) })
  expectCode(t, () => sync.pushAuthenticated(syncFrames[0]), 'INVALID_ROUTE')
  t.is(sync.bufferedBytes, 0)
  t.is(syncLive.size, 0)
  t.is(syncCancelled.length, 1)

  let scheduleDestroy = null
  const destroyLive = new Set()
  const destroyCancelled = []
  scheduleDestroy = new RemoteControlFragmentCodec({
    now: () => 0,
    schedule() {
      const handle = { id: 2 }
      scheduleDestroy.destroy()
      destroyLive.add(handle)
      return handle
    },
    cancel(handle) {
      destroyCancelled.push(handle)
      destroyLive.delete(handle)
    }
  })
  const destroyFrame = scheduleDestroy.fragment(b4a.from('x'), {
    messageId: bytes(16, 18)
  })[0]
  expectCode(t, () => scheduleDestroy.pushAuthenticated(destroyFrame), 'CIRCUIT_STATE')
  t.is(destroyLive.size, 0)
  t.is(destroyCancelled.length, 1)
  t.is(destroyCancelled[0].id, 2)

  const cancelThrow = new RemoteControlFragmentCodec({
    now: () => 0,
    schedule() {
      return 1
    },
    cancel() {
      throw new Error('cancel')
    }
  })
  const one = cancelThrow.fragment(b4a.from('x'), { messageId: bytes(16, 15) })[0]
  expectCode(t, () => cancelThrow.pushAuthenticated(one), 'INVALID_ROUTE')
  t.is(cancelThrow.stats.destroyed, true)

  let clockDestroy = null
  clockDestroy = new RemoteControlFragmentCodec({
    now() {
      clockDestroy.destroy()
      return 0
    }
  })
  const clockFrame = clockDestroy.fragment(b4a.from('x'), { messageId: bytes(16, 16) })[0]
  expectCode(t, () => clockDestroy.pushAuthenticated(clockFrame), 'CIRCUIT_STATE')
  t.alike(clockDestroy.stats, {
    destroyed: true,
    bufferedBytes: 0,
    active: 0,
    completedIds: 0,
    timers: 0
  })

  let cancelDestroy = null
  cancelDestroy = new RemoteControlFragmentCodec({
    now: () => 0,
    schedule() {
      return 1
    },
    cancel() {
      cancelDestroy.destroy()
    }
  })
  const cancelFrame = cancelDestroy.fragment(b4a.from('x'), {
    messageId: bytes(16, 17)
  })[0]
  expectCode(t, () => cancelDestroy.pushAuthenticated(cancelFrame), 'CIRCUIT_STATE')
  t.is(cancelDestroy.stats.destroyed, true)

  let expireNow = 0
  let expireDestroy = null
  expireDestroy = new RemoteControlFragmentCodec({
    now() {
      if (expireNow === 1) expireDestroy.destroy()
      return expireNow
    }
  })
  const expireFrames = expireDestroy.fragment(bytes(1200, 19), {
    messageId: bytes(16, 19)
  })
  t.is(expireDestroy.pushAuthenticated(expireFrames[0]), null)
  expireNow = 1
  expectCode(t, () => expireDestroy.expire(), 'CIRCUIT_STATE')
  t.alike(expireDestroy.stats, {
    destroyed: true,
    bufferedBytes: 0,
    active: 0,
    completedIds: 0,
    timers: 0
  })
})

test('completed fragment IDs are bounded without replay eviction', (t) => {
  const codec = new RemoteControlFragmentCodec({ now: () => 0 })
  const completed = []
  for (let index = 0; index < MAX_COMPLETED_REMOTE_CONTROL_IDS; index++) {
    const messageId = b4a.alloc(16)
    messageId[15] = index
    const value = codec.fragment(b4a.from([index]), { messageId })[0]
    completed.push(value)
    t.alike(codec.pushAuthenticated(value), b4a.from([index]))
  }
  const overflow = codec.fragment(b4a.from([64]), { messageId: bytes(16, 0x80) })[0]
  expectCode(t, () => codec.pushAuthenticated(overflow), 'CIRCUIT_LIMIT')
  expectCode(t, () => codec.pushAuthenticated(completed[0]), 'REPLAY')
  t.is(codec.bufferedBytes, 0)
})

test('actor control codec locks every exact request/reply pair', (t) => {
  const codec = new ActorControlCodec()
  const pairs = [
    [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_STAGED],
    [ACTOR_CONTROL_KIND.REGISTER_PREPARE, ACTOR_CONTROL_KIND.REGISTER_PREPARED],
    [ACTOR_CONTROL_KIND.REGISTER_FINALIZE, ACTOR_CONTROL_KIND.REGISTER_FINALIZED],
    [ACTOR_CONTROL_KIND.REGISTER_ABORT, ACTOR_CONTROL_KIND.REGISTER_ABORTED],
    [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.ACTIVATE_CREATED],
    [ACTOR_CONTROL_KIND.CIRCUIT_DESTROY, ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED]
  ]
  for (const [requestKind, replyKind] of pairs) {
    const requestBody =
      requestKind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
        ? b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])
        : bytes(3, requestKind)
    const replyBody =
      replyKind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED ? b4a.alloc(0) : bytes(2, replyKind)
    const request = actor(requestKind, { body: requestBody })
    const reply = actor(replyKind, { body: replyBody })
    const encoded = codec.encode(request)
    t.is(encoded.byteLength, ACTOR_CONTROL_HEADER_SIZE + requestBody.byteLength)
    t.alike(codec.decode(encoded), request)
    const decodedReply = codec.decode(codec.encode(reply))
    t.alike(validateActorReply(request, decodedReply, bytes(32, 0x61)), decodedReply)
  }
})

test('actor codec enforces exact header/body/correlation and canonical error replies', (t) => {
  const codec = new ActorControlCodec()
  const maximum = actor(ACTOR_CONTROL_KIND.ACTIVATE_CREATE, {
    body: bytes(ACTOR_CONTROL_BODY_MAX, 0x71)
  })
  t.is(codec.encode(maximum).byteLength, MAX_REMOTE_CONTROL_OBJECT)
  expectCode(
    t,
    () => codec.encode({ ...maximum, body: bytes(ACTOR_CONTROL_BODY_MAX + 1) }),
    'INVALID_ROUTE'
  )

  const request = actor(ACTOR_CONTROL_KIND.ACTIVATE_CREATE)
  const digest = bytes(32, 0x72)
  const error = actor(ACTOR_CONTROL_KIND.ERROR, {
    body: b4a.concat([b4a.from([ACTOR_ERROR_CODE.UNAUTHORIZED]), digest])
  })
  t.alike(validateActorReply(request, codec.decode(codec.encode(error)), digest), error)
  expectCode(
    t,
    () => codec.encode(actor(ACTOR_CONTROL_KIND.ERROR, { body: bytes(32) })),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      codec.encode(
        actor(ACTOR_CONTROL_KIND.ERROR, { body: b4a.concat([b4a.from([0xff]), digest]) })
      ),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => codec.encode(actor(ACTOR_CONTROL_KIND.CIRCUIT_DESTROY, { body: b4a.from([0xff]) })),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => codec.encode(actor(ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED, { body: b4a.from([0]) })),
    'INVALID_ROUTE'
  )

  const valid = codec.encode(request)
  const mutations = [
    [0, 1],
    [1, 0xff],
    [2, 1],
    [3, 1],
    [11, 0],
    [53, valid[53] + 1]
  ]
  for (const [offset, value] of mutations) {
    const malformed = b4a.from(valid)
    malformed[offset] = value
    expectCode(t, () => codec.decode(malformed), 'INVALID_ROUTE')
  }
  expectCode(t, () => codec.decode(valid.subarray(0, valid.byteLength - 1)), 'INVALID_ROUTE')
  expectCode(t, () => codec.decode(b4a.concat([valid, b4a.from([0])])), 'INVALID_ROUTE')

  const reply = actor(ACTOR_CONTROL_KIND.ACTIVATE_CREATED, { body: bytes(2, 1) })
  const mismatches = [
    { requestId: 8n },
    { actorId: bytes(16, 2) },
    { circuitId: bytes(16, 3) },
    { generation: 10n },
    { kind: ACTOR_CONTROL_KIND.REGISTER_STAGED }
  ]
  for (const change of mismatches) {
    expectCode(
      t,
      () => validateActorReply(request, { ...reply, ...change }, digest),
      'INVALID_ROUTE'
    )
  }
  const wrongDigest = {
    ...error,
    body: b4a.concat([b4a.from([ACTOR_ERROR_CODE.UNAUTHORIZED]), bytes(32, 9)])
  }
  expectCode(t, () => validateActorReply(request, wrongDigest, digest), 'INVALID_ROUTE')
})

test('actor registration uses only zero circuit/generation and recipient-local IDs', (t) => {
  const codec = new ActorControlCodec()
  const register = actor(ACTOR_CONTROL_KIND.REGISTER_STAGE)
  t.alike(codec.decode(codec.encode(register)), register)
  expectCode(t, () => codec.encode({ ...register, actorId: bytes(16) }), 'INVALID_ROUTE')
  expectCode(t, () => codec.encode({ ...register, circuitId: bytes(16, 1) }), 'INVALID_ROUTE')
  expectCode(t, () => codec.encode({ ...register, generation: 1n }), 'INVALID_ROUTE')
  const activation = actor(ACTOR_CONTROL_KIND.ACTIVATE_CREATE)
  expectCode(t, () => codec.encode({ ...activation, circuitId: bytes(16) }), 'INVALID_ROUTE')
  expectCode(t, () => codec.encode({ ...activation, generation: 0n }), 'INVALID_ROUTE')
})
