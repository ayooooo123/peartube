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
  ROUTE_FRAME_SIZE,
  RoutePayloadCodec,
  SenderCounter,
  cryptoSuite
} from '../index.js'
import { expectCode, seed } from './helpers.js'
import { TEST_ONLY_BUFFER_OBSERVER } from '../lib/counters.js'
import { TEST_ONLY_RECEIVERS } from '../lib/route-payload.js'
import * as publicRoutes from '../index.js'

const DESCRIPTOR_ID = b4a.alloc(32, 0x31)
const CIRCUIT_ID = b4a.alloc(16, 0x41)
const ROUTE_KEYS = cryptoSuite.deriveKeys(seed(7), b4a.from('authenticated-created'))

function zeroPadding(size) {
  return b4a.alloc(size)
}

function route(overrides = {}) {
  const { receivers, ...rest } = overrides
  return new RoutePayloadCodec({
    crypto: cryptoSuite,
    descriptorId: DESCRIPTOR_ID,
    circuitId: CIRCUIT_ID,
    forwardKey: ROUTE_KEYS.forwardKey,
    forwardNoncePrefix: ROUTE_KEYS.forwardNoncePrefix,
    reverseKey: ROUTE_KEYS.reverseKey,
    reverseNoncePrefix: ROUTE_KEYS.reverseNoncePrefix,
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
