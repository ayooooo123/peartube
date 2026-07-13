import test from 'brittle'
import b4a from 'b4a'

import {
  CELL_CLASS,
  CELL_SIZE,
  CellCodec,
  DIRECTION,
  DatagramReplayWindow,
  MAX_COUNTER,
  OrderedReceiver,
  PrivateRouteError,
  Reassembler,
  ROUTE_FRAME_SIZE,
  RoutePayloadCodec,
  SenderCounter,
  cryptoSuite,
  fragment
} from '../index.js'
import { expectCode, seed } from './helpers.js'
import { TEST_ONLY_BUFFER_OBSERVER } from '../lib/counters.js'
import {
  TEST_ONLY_RECEIVERS,
  destroyCreatedRoutePayloadContext,
  mintCreatedRoutePayloadContext
} from '../lib/route-payload.js'
import * as publicRoutes from '../index.js'

const DESCRIPTOR_ID = b4a.alloc(32, 0x31)
const CIRCUIT_ID = b4a.alloc(16, 0x41)
const ROUTE_KEYS = cryptoSuite.deriveKeys(seed(7), b4a.from('authenticated-created'))

function zeroPadding(size) {
  return b4a.alloc(size)
}

function route(overrides = {}) {
  const {
    receivers,
    context,
    descriptorId = DESCRIPTOR_ID,
    circuitId = CIRCUIT_ID,
    forwardKey = ROUTE_KEYS.forwardKey,
    forwardNoncePrefix = ROUTE_KEYS.forwardNoncePrefix,
    reverseKey = ROUTE_KEYS.reverseKey,
    reverseNoncePrefix = ROUTE_KEYS.reverseNoncePrefix,
    ...rest
  } = overrides
  const createdContext =
    context === undefined
      ? mintCreatedRoutePayloadContext({
          descriptorId,
          circuitId,
          forwardKey,
          forwardNoncePrefix,
          reverseKey,
          reverseNoncePrefix
        })
      : context
  return new RoutePayloadCodec({
    crypto: cryptoSuite,
    context: createdContext,
    window: 8,
    gapTimeout: 100,
    now: () => 0,
    padding: zeroPadding,
    ...(receivers === undefined ? {} : { [TEST_ONLY_RECEIVERS]: receivers }),
    ...rest
  })
}

test('route receiver injection hook is test-only and non-public', (t) => {
  t.is(typeof TEST_ONLY_RECEIVERS, 'symbol')
  t.is('TEST_ONLY_RECEIVERS' in publicRoutes, false)
})

test('only a one-use authenticated-CREATED context can construct a route codec', (t) => {
  const options = {
    crypto: cryptoSuite,
    window: 8,
    gapTimeout: 100,
    now: () => 0,
    padding: zeroPadding
  }
  const rawKeys = {
    descriptorId: DESCRIPTOR_ID,
    circuitId: CIRCUIT_ID,
    forwardKey: ROUTE_KEYS.forwardKey,
    forwardNoncePrefix: ROUTE_KEYS.forwardNoncePrefix,
    reverseKey: ROUTE_KEYS.reverseKey,
    reverseNoncePrefix: ROUTE_KEYS.reverseNoncePrefix
  }

  expectCode(t, () => new RoutePayloadCodec({ ...options, ...rawKeys }), 'INVALID_ROUTE')
  expectCode(t, () => new RoutePayloadCodec({ ...options, context: {} }), 'INVALID_ROUTE')
  const context = mintCreatedRoutePayloadContext(rawKeys)
  t.alike(Reflect.ownKeys(context), [])
  t.is(Object.isFrozen(context), true)
  const codec = new RoutePayloadCodec({ ...options, context })
  t.is(codec.stats.destroyed, false)
  expectCode(t, () => new RoutePayloadCodec({ ...options, context }), 'INVALID_ROUTE')
  t.is('mintCreatedRoutePayloadContext' in publicRoutes, false)
})

test('an unconsumed authenticated-CREATED context can be disposed and zeroed', (t) => {
  const allocations = []
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    allocations.push(value)
    return value
  }
  let context
  try {
    context = mintCreatedRoutePayloadContext({
      descriptorId: DESCRIPTOR_ID,
      circuitId: CIRCUIT_ID,
      forwardKey: ROUTE_KEYS.forwardKey,
      forwardNoncePrefix: ROUTE_KEYS.forwardNoncePrefix,
      reverseKey: ROUTE_KEYS.reverseKey,
      reverseNoncePrefix: ROUTE_KEYS.reverseNoncePrefix
    })
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.is(allocations.length, 6)
  destroyCreatedRoutePayloadContext(context)
  destroyCreatedRoutePayloadContext(context)
  for (const value of allocations) t.alike(value, b4a.alloc(value.byteLength))
  expectCode(t, () => route({ context }), 'INVALID_ROUTE')
  t.is('destroyCreatedRoutePayloadContext' in publicRoutes, false)
})

function seal(codec, overrides = {}) {
  return codec.seal({
    direction: DIRECTION.FORWARD,
    class: CELL_CLASS.STREAM,
    payload: b4a.from('private payload'),
    ...overrides
  })
}

function open(codec, frame, overrides = {}) {
  return codec.open({ direction: DIRECTION.FORWARD, ...overrides }, frame)
}

function relayCell(frame) {
  const key = seed(91)
  const noncePrefix = b4a.alloc(16, 92)
  const senderCounter = new SenderCounter()
  const cell = new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: zeroPadding
  })
  const packet = cell.seal({
    key,
    noncePrefix,
    senderCounter,
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.FORWARD,
    epoch: 1n,
    circuitId: CIRCUIT_ID,
    payload: frame
  })
  const receiver = new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 })
  return cell.open(
    {
      key,
      noncePrefix,
      receiver,
      expectedClass: CELL_CLASS.STREAM,
      expectedDirection: DIRECTION.FORWARD,
      expectedEpoch: 1n,
      expectedCircuitId: CIRCUIT_ID
    },
    packet
  )[0]
}

test('route frame is opaque to relays and opens only at the destination', (t) => {
  const source = route()
  const destination = route()
  const plaintext = b4a.from('private payload')
  const frame = seal(source, { payload: plaintext })
  const relayed = relayCell(frame)

  t.is(frame.byteLength, ROUTE_FRAME_SIZE)
  t.alike(relayed, frame)
  t.is(relayed.indexOf(plaintext), -1)
  t.is(
    cryptoSuite.open({
      key: seed(88),
      noncePrefix: b4a.alloc(16, 89),
      counter: 0n,
      associatedData: b4a.alloc(57),
      ciphertext: relayed.subarray(8)
    }),
    null
  )

  const deliveries = open(destination, relayed)
  t.is(deliveries.length, 1)
  t.is(deliveries[0].class, CELL_CLASS.STREAM)
  t.alike(deliveries[0].payload, plaintext)
})

test('route payload keeps direction senders and receivers independent', (t) => {
  const source = route()
  const destination = route()
  const forward = seal(source, { payload: b4a.from('forward') })
  const reverse = seal(destination, {
    direction: DIRECTION.REVERSE,
    payload: b4a.from('reverse')
  })

  t.is(b4a.toString(forward.subarray(0, 8), 'hex'), '0000000000000000')
  t.is(b4a.toString(reverse.subarray(0, 8), 'hex'), '0000000000000000')
  t.alike(open(destination, forward)[0].payload, b4a.from('forward'))
  t.alike(open(source, reverse, { direction: DIRECTION.REVERSE })[0].payload, b4a.from('reverse'))
})

test('datagram route payloads use the replay window and return exact payloads', (t) => {
  const source = route()
  const destination = route()
  const frame = seal(source, {
    class: CELL_CLASS.DATAGRAM,
    payload: b4a.from('datagram')
  })

  const opened = open(destination, frame)
  t.is(opened.class, CELL_CLASS.DATAGRAM)
  t.alike(opened.payload, b4a.from('datagram'))
  expectCode(t, () => open(destination, frame), 'REPLAY')
})

test('authentication and body checks precede every receiver call', (t) => {
  const calls = []
  const receivers = {
    forwardOrdered: {
      pushAuthenticated(counter, value) {
        calls.push({ kind: 'ordered', counter, value })
        return [value]
      }
    },
    forwardDatagram: {
      acceptAuthenticated(counter) {
        calls.push({ kind: 'datagram', counter })
        return true
      }
    },
    reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
    reverseDatagram: new DatagramReplayWindow({ window: 8 })
  }
  const destination = route({ receivers })
  const frame = seal(route())
  const cases = [
    route({ forwardKey: seed(99) }),
    route({ descriptorId: b4a.alloc(32, 1) }),
    route({ circuitId: b4a.alloc(16, 2) })
  ]

  for (const codec of cases) expectCode(t, () => open(codec, frame), 'INVALID_ROUTE')
  expectCode(t, () => open(destination, frame, { direction: DIRECTION.REVERSE }), 'INVALID_ROUTE')
  const mutated = b4a.from(frame)
  mutated[mutated.byteLength - 1] ^= 1
  expectCode(t, () => open(destination, mutated), 'INVALID_ROUTE')
  t.is(calls.length, 0)

  const opened = open(destination, frame)
  t.is(calls.length, 1)
  t.alike(opened[0].payload, b4a.from('private payload'))
})

test('every forged route input leaves observed receivers and counter stats untouched', (t) => {
  const frame = seal(route())

  function observed(overrides = {}) {
    let traffic = 0
    let calls = 0
    function receiver(datagram) {
      return new Proxy(
        {},
        {
          get(target, property) {
            traffic++
            if (property === 'pushAuthenticated') {
              return () => {
                calls++
                return []
              }
            }
            if (property === 'acceptAuthenticated') {
              return () => {
                calls++
                return true
              }
            }
            if (property === 'next') return 0n
            if (property === 'buffered') return 0
            if (property === 'highest') return datagram ? null : undefined
            return undefined
          }
        }
      )
    }
    const codec = route({
      ...overrides,
      receivers: {
        forwardOrdered: receiver(false),
        forwardDatagram: receiver(true),
        reverseOrdered: receiver(false),
        reverseDatagram: receiver(true)
      }
    })
    return {
      codec,
      reset() {
        traffic = 0
        calls = 0
      },
      observations() {
        return { traffic, calls }
      }
    }
  }

  const cases = [
    { overrides: { forwardKey: seed(99) }, frame, direction: DIRECTION.FORWARD },
    {
      overrides: { descriptorId: b4a.alloc(32, 0xa1) },
      frame,
      direction: DIRECTION.FORWARD
    },
    {
      overrides: { circuitId: b4a.alloc(16, 0xa2) },
      frame,
      direction: DIRECTION.FORWARD
    },
    { overrides: {}, frame, direction: DIRECTION.REVERSE },
    {
      overrides: {},
      frame: (() => {
        const changed = b4a.from(frame)
        changed[7] ^= 1
        return changed
      })(),
      direction: DIRECTION.FORWARD
    },
    {
      overrides: {},
      frame: (() => {
        const changed = b4a.from(frame)
        changed[changed.byteLength - 1] ^= 1
        return changed
      })(),
      direction: DIRECTION.FORWARD
    }
  ]

  for (const forged of cases) {
    const spy = observed(forged.overrides)
    const before = spy.codec.stats
    spy.reset()
    expectCode(
      t,
      () => spy.codec.open({ direction: forged.direction }, forged.frame),
      'INVALID_ROUTE'
    )
    t.alike(spy.observations(), { traffic: 0, calls: 0 })
    t.alike(spy.codec.stats, before)
  }
})

test('counter mutation cannot be authenticated or touch the receiver', (t) => {
  let calls = 0
  const receiver = {
    pushAuthenticated() {
      calls++
      return []
    }
  }
  const destination = route({
    receivers: {
      forwardOrdered: receiver,
      forwardDatagram: new DatagramReplayWindow({ window: 8 }),
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })
  const frame = seal(route())
  frame[7] ^= 1

  expectCode(t, () => open(destination, frame), 'INVALID_ROUTE')
  t.is(calls, 0)
})

test('ordered route payloads preserve bounded out-of-order delivery', (t) => {
  const source = route()
  const destination = route()
  const first = seal(source, { payload: b4a.from('first') })
  const second = seal(source, { payload: b4a.from('second') })

  t.alike(open(destination, second), [])
  const delivered = open(destination, first)
  t.alike(
    delivered.map((value) => value.payload),
    [b4a.from('first'), b4a.from('second')]
  )
})

test('route open clears immediate encoded delivery after copying its result', (t) => {
  let encoded = null
  const receiver = {
    pushAuthenticated(counter, value) {
      t.is(counter, 0n)
      encoded = value
      return [value]
    }
  }
  const destination = route({
    receivers: {
      forwardOrdered: receiver,
      forwardDatagram: new DatagramReplayWindow({ window: 8 }),
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })

  const opened = open(destination, seal(route()))
  t.alike(opened[0].payload, b4a.from('private payload'))
  t.alike(encoded, b4a.alloc(encoded.byteLength))
})

test('route destroy clears buffered ordered payloads and rejects later operations', (t) => {
  const owned = []
  const ordered = new OrderedReceiver({
    window: 8,
    gapTimeout: 100,
    now: () => 0,
    [TEST_ONLY_BUFFER_OBSERVER](value) {
      owned.push(value)
    }
  })
  const destination = route({
    receivers: {
      forwardOrdered: ordered,
      forwardDatagram: new DatagramReplayWindow({ window: 8 }),
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })
  const source = route()
  seal(source)
  const later = seal(source, { payload: b4a.from('buffered route secret') })
  t.alike(open(destination, later), [])
  t.is(owned.length, 1)

  destination.destroy()
  destination.destroy()
  t.alike(owned[0], b4a.alloc(owned[0].byteLength))
  t.is(destination.stats.destroyed, true)
  expectCode(t, () => seal(destination), 'CIRCUIT_STATE')
  expectCode(t, () => open(destination, later), 'CIRCUIT_STATE')
})

test('constructor failure zeroes every key and identifier copy it allocated', (t) => {
  const allocations = []
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    if (size === 16 || size === 32) allocations.push(value)
    return value
  }

  try {
    expectCode(t, () => route({ receivers: {} }), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.is(allocations.length, 6)
  for (const value of allocations) t.alike(value, b4a.alloc(value.byteLength))
})

test('constructor rejects overlapping forward and reverse cryptographic contexts', (t) => {
  expectCode(
    t,
    () =>
      route({
        reverseKey: ROUTE_KEYS.forwardKey
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      route({
        reverseNoncePrefix: ROUTE_KEYS.forwardNoncePrefix
      }),
    'INVALID_ROUTE'
  )
})

test('authenticated body validation precedes receiver calls and clears plaintext', (t) => {
  let calls = 0
  let plaintext = null
  const destination = route({
    crypto: {
      ...cryptoSuite,
      open() {
        plaintext = b4a.alloc(1076)
        plaintext[0] = CELL_CLASS.CONTROL
        return plaintext
      }
    },
    receivers: {
      forwardOrdered: {
        pushAuthenticated() {
          calls++
          return []
        }
      },
      forwardDatagram: new DatagramReplayWindow({ window: 8 }),
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })

  expectCode(t, () => open(destination, b4a.alloc(ROUTE_FRAME_SIZE)), 'INVALID_ROUTE')
  t.is(calls, 0)
  t.alike(plaintext, b4a.alloc(1076))
})

test('receiver failures expose only intended counter codes', (t) => {
  const frame = seal(route())
  const cases = [
    [PrivateRouteError.REPLAY(), 'REPLAY'],
    [PrivateRouteError.COUNTER_INVALID(), 'COUNTER_INVALID'],
    [PrivateRouteError.COUNTER_GAP(), 'COUNTER_GAP'],
    [PrivateRouteError.COUNTER_EXHAUSTED(), 'COUNTER_EXHAUSTED'],
    [PrivateRouteError.UNAUTHORIZED(), 'INVALID_ROUTE'],
    [new TypeError('receiver detail'), 'INVALID_ROUTE']
  ]

  for (const [error, code] of cases) {
    const destination = route({
      receivers: {
        forwardOrdered: {
          pushAuthenticated() {
            throw error
          }
        },
        forwardDatagram: new DatagramReplayWindow({ window: 8 }),
        reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        reverseDatagram: new DatagramReplayWindow({ window: 8 })
      }
    })
    expectCode(t, () => open(destination, frame), code)
  }
})

test('datagram receivers must return exactly true', (t) => {
  const frame = seal(route(), { class: CELL_CLASS.DATAGRAM })
  for (const result of [false, undefined, 1, 'true']) {
    const destination = route({
      receivers: {
        forwardOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        forwardDatagram: { acceptAuthenticated: () => result },
        reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        reverseDatagram: new DatagramReplayWindow({ window: 8 })
      }
    })
    expectCode(t, () => open(destination, frame), 'INVALID_ROUTE')
  }
})

test('fresh route counters may carry completed-fragment replay without closing the route', (t) => {
  const source = route()
  const destination = route()
  const reassembler = new Reassembler({ now: () => 0, epochExpiresAt: 1000 })
  let reassemblerCalls = 0
  function receive(frame) {
    const deliveries = open(destination, frame)
    let result = null
    for (const delivery of deliveries) {
      reassemblerCalls++
      result = reassembler.pushAuthenticated(delivery.payload)
    }
    return result
  }

  const completed = fragment(b4a.from('first message'), { messageId: b4a.alloc(16, 0xb1) })[0]
  const firstFrame = seal(source, { payload: completed })
  t.alike(receive(firstFrame), b4a.from('first message'))

  const freshCounterReplay = seal(source, { payload: completed })
  expectCode(t, () => receive(freshCounterReplay), 'REPLAY')
  t.is(destination.stats.forward.orderedNext, 2n)

  const another = fragment(b4a.from('second message'), { messageId: b4a.alloc(16, 0xb2) })[0]
  const usableFrame = seal(source, { payload: another })
  t.alike(receive(usableFrame), b4a.from('second message'))
  t.is(destination.stats.forward.orderedNext, 3n)

  const callsBeforeRouteReplay = reassemblerCalls
  expectCode(t, () => receive(usableFrame), 'REPLAY')
  t.is(reassemblerCalls, callsBeforeRouteReplay)
  t.is(destination.stats.forward.orderedNext, 3n)
})

test('route payload validates exact public and authenticated bounds before reserving counters', (t) => {
  const codec = route()
  const before = codec.stats

  for (const value of [null, {}, b4a.alloc(1074)]) {
    expectCode(t, () => seal(codec, { payload: value, class: CELL_CLASS.STREAM }), 'INVALID_ROUTE')
  }
  expectCode(t, () => seal(codec, { class: CELL_CLASS.CONTROL }), 'INVALID_ROUTE')
  t.alike(codec.stats, before)

  const frame = seal(codec, { payload: b4a.alloc(1073) })
  t.is(frame.byteLength, ROUTE_FRAME_SIZE)
  expectCode(t, () => open(route(), frame.subarray(1)), 'INVALID_ROUTE')
})

test('seal reserves a counter exactly once and burns it after crypto failure', (t) => {
  let calls = 0
  const codec = route({
    crypto: {
      ...cryptoSuite,
      seal() {
        calls++
        throw new Error('adapter details')
      }
    }
  })

  expectCode(t, () => seal(codec), 'INVALID_ROUTE')
  t.is(calls, 1)
  t.is(codec.stats.forward.senderNext, 1n)
})

test('route counter exhaustion emits MAX once then remains exhausted', (t) => {
  const source = route({ senderInitial: MAX_COUNTER })
  const destination = route({ receiverInitial: MAX_COUNTER })
  const frame = seal(source)

  t.alike(open(destination, frame)[0].payload, b4a.from('private payload'))
  expectCode(t, () => seal(source), 'COUNTER_EXHAUSTED')
  expectCode(t, () => open(destination, frame), 'COUNTER_EXHAUSTED')
})

test('hostile construction and call inputs normalize to stable route errors', (t) => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()

  for (const value of [null, [], revoked.proxy]) {
    expectCode(t, () => new RoutePayloadCodec(value), 'INVALID_ROUTE')
  }

  const codec = route()
  expectCode(t, () => codec.seal(revoked.proxy), 'INVALID_ROUTE')
  expectCode(t, () => codec.open(revoked.proxy, b4a.alloc(1100)), 'INVALID_ROUTE')
})
