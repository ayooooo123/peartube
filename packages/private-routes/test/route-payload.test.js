import test from 'brittle'
import b4a from 'b4a'

import {
  CELL_CLASS,
  CELL_SIZE,
  CellCodec,
  DIRECTION,
  DatagramReplayWindow,
  OrderedReceiver,
  PrivateRouteError,
  Reassembler,
  ROUTE_COUNTER_SIZE,
  ROUTE_FRAME_SIZE,
  ROUTE_PLAINTEXT_SIZE,
  RoutePayloadCodec,
  SenderCounter,
  cryptoSuite,
  fragment
} from '../index.js'
import { expectCode, seed } from './helpers.js'
import { TEST_ONLY_BUFFER_OBSERVER } from '../lib/counters.js'
import {
  ROUTE_ENDPOINT,
  TEST_ONLY_RECEIVERS,
  destroyCreatedRoutePayloadContext,
  mintCreatedRoutePayloadContext
} from '../lib/route-payload.js'
import * as publicRoutes from '../index.js'

const DESCRIPTOR_ID = b4a.alloc(32, 0x31)
const CIRCUIT_ID = b4a.alloc(16, 0x41)
const ROUTE_KEYS = cryptoSuite.deriveKeys(seed(7), b4a.from('authenticated-created'))
let routeSequence = 0

function zeroPadding(size) {
  return b4a.alloc(size)
}

function routeKeys() {
  routeSequence++
  return cryptoSuite.deriveKeys(seed(70), b4a.from(`route-payload-test-${routeSequence}`))
}

function route(overrides = {}) {
  const {
    receivers,
    context,
    endpointRole = ROUTE_ENDPOINT.SOURCE,
    keys = routeKeys(),
    descriptorId = DESCRIPTOR_ID,
    circuitId = CIRCUIT_ID,
    forwardKey = keys.forwardKey,
    forwardNoncePrefix = keys.forwardNoncePrefix,
    reverseKey = keys.reverseKey,
    reverseNoncePrefix = keys.reverseNoncePrefix,
    ...rest
  } = overrides
  const createdContext =
    context === undefined
      ? mintCreatedRoutePayloadContext({
          endpointRole,
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

function routePair(sourceOverrides = {}, destinationOverrides = {}) {
  const keys = routeKeys()
  return {
    source: route({ ...sourceOverrides, keys, endpointRole: ROUTE_ENDPOINT.SOURCE }),
    destination: route({
      ...destinationOverrides,
      keys,
      endpointRole: ROUTE_ENDPOINT.DESTINATION
    }),
    keys
  }
}

function receivingRoute(keys, overrides = {}) {
  const outbound = routeKeys()
  return route({
    endpointRole: ROUTE_ENDPOINT.DESTINATION,
    forwardKey: keys.forwardKey,
    forwardNoncePrefix: keys.forwardNoncePrefix,
    reverseKey: outbound.reverseKey,
    reverseNoncePrefix: outbound.reverseNoncePrefix,
    ...overrides
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
    endpointRole: ROUTE_ENDPOINT.SOURCE,
    descriptorId: DESCRIPTOR_ID,
    circuitId: CIRCUIT_ID,
    ...routeKeys()
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
  const keys = routeKeys()
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    allocations.push(value)
    return value
  }
  let context
  try {
    context = mintCreatedRoutePayloadContext({
      endpointRole: ROUTE_ENDPOINT.SOURCE,
      descriptorId: DESCRIPTOR_ID,
      circuitId: CIRCUIT_ID,
      ...keys
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

test('nonce-domain claims are unique, disposable before use, and spent after activation', (t) => {
  const keys = routeKeys()
  const raw = {
    endpointRole: ROUTE_ENDPOINT.SOURCE,
    descriptorId: DESCRIPTOR_ID,
    circuitId: CIRCUIT_ID,
    ...keys
  }

  const disposable = mintCreatedRoutePayloadContext(raw)
  expectCode(t, () => mintCreatedRoutePayloadContext(raw), 'INVALID_ROUTE')
  destroyCreatedRoutePayloadContext(disposable)

  const failed = mintCreatedRoutePayloadContext(raw)
  expectCode(t, () => route({ context: failed, receivers: {} }), 'INVALID_ROUTE')
  const activated = mintCreatedRoutePayloadContext(raw)
  const codec = route({ context: activated })
  expectCode(t, () => mintCreatedRoutePayloadContext(raw), 'INVALID_ROUTE')
  codec.destroy()
  expectCode(t, () => mintCreatedRoutePayloadContext(raw), 'INVALID_ROUTE')
})

test('nonce claims collide on key and prefix even across endpoint roles and fields', (t) => {
  const sourceKeys = routeKeys()
  const destinationKeys = routeKeys()
  const source = mintCreatedRoutePayloadContext({
    endpointRole: ROUTE_ENDPOINT.SOURCE,
    descriptorId: DESCRIPTOR_ID,
    circuitId: CIRCUIT_ID,
    ...sourceKeys
  })

  expectCode(
    t,
    () =>
      mintCreatedRoutePayloadContext({
        endpointRole: ROUTE_ENDPOINT.DESTINATION,
        descriptorId: DESCRIPTOR_ID,
        circuitId: CIRCUIT_ID,
        forwardKey: destinationKeys.forwardKey,
        forwardNoncePrefix: destinationKeys.forwardNoncePrefix,
        reverseKey: sourceKeys.forwardKey,
        reverseNoncePrefix: sourceKeys.forwardNoncePrefix
      }),
    'INVALID_ROUTE'
  )
  destroyCreatedRoutePayloadContext(source)
})

test('complementary endpoint roles own opposite send domains and reject wrong directions', (t) => {
  const { source, destination } = routePair()
  const forward = seal(source, { payload: b4a.from('forward only') })
  const reverse = seal(destination, {
    direction: DIRECTION.REVERSE,
    payload: b4a.from('reverse only')
  })

  t.alike(open(destination, forward)[0].payload, b4a.from('forward only'))
  t.alike(
    open(source, reverse, { direction: DIRECTION.REVERSE })[0].payload,
    b4a.from('reverse only')
  )
  expectCode(t, () => seal(source, { direction: DIRECTION.REVERSE }), 'INVALID_ROUTE')
  expectCode(t, () => seal(destination, { direction: DIRECTION.FORWARD }), 'INVALID_ROUTE')
  expectCode(t, () => open(source, forward), 'INVALID_ROUTE')
  expectCode(t, () => open(destination, reverse, { direction: DIRECTION.REVERSE }), 'INVALID_ROUTE')
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
  const { source, destination } = routePair()
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
  const { source, destination } = routePair()
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
  const { source, destination } = routePair()
  const frame = seal(source, {
    class: CELL_CLASS.DATAGRAM,
    payload: b4a.from('datagram')
  })

  const opened = open(destination, frame)
  t.is(opened.class, CELL_CLASS.DATAGRAM)
  t.alike(opened.payload, b4a.from('datagram'))
  expectCode(t, () => open(destination, frame), 'REPLAY')
})

test('dropped and reordered datagrams never create an ordered stream gap', (t) => {
  const { source, destination } = routePair()
  const streamZero = seal(source, { payload: b4a.from('stream zero') })
  const droppedDatagram = seal(source, {
    class: CELL_CLASS.DATAGRAM,
    payload: b4a.from('dropped')
  })
  const streamOne = seal(source, { payload: b4a.from('stream one') })
  const datagramOne = seal(source, {
    class: CELL_CLASS.DATAGRAM,
    payload: b4a.from('datagram one')
  })

  t.is(b4a.toString(streamZero.subarray(0, 8), 'hex'), '0000000000000000')
  t.is(b4a.toString(droppedDatagram.subarray(0, 8), 'hex'), '0000000000000001')
  t.is(b4a.toString(streamOne.subarray(0, 8), 'hex'), '0000000000000002')
  t.is(b4a.toString(datagramOne.subarray(0, 8), 'hex'), '0000000000000003')

  t.alike(open(destination, streamZero)[0].payload, b4a.from('stream zero'))
  t.alike(open(destination, datagramOne).payload, b4a.from('datagram one'))
  t.alike(open(destination, streamOne)[0].payload, b4a.from('stream one'))
  t.alike(open(destination, droppedDatagram).payload, b4a.from('dropped'))
  t.is(destination.stats.forward.orderedNext, 2n)
  t.is(destination.stats.forward.datagramHighest, 1n)
})

test('class namespaces prevent the XOR signature of AEAD nonce reuse', (t) => {
  const counters = []
  const plaintexts = []
  const keys = routeKeys()
  const source = route({
    keys,
    crypto: {
      ...cryptoSuite,
      seal(options) {
        counters.push(options.counter)
        plaintexts.push(b4a.from(options.plaintext))
        return cryptoSuite.seal(options)
      }
    }
  })
  const stream = seal(source, { payload: b4a.from('same body') })
  const datagram = seal(source, {
    class: CELL_CLASS.DATAGRAM,
    payload: b4a.from('same body')
  })
  const plaintextXor = b4a.alloc(ROUTE_PLAINTEXT_SIZE)
  const ciphertextXor = b4a.alloc(ROUTE_PLAINTEXT_SIZE)

  for (let i = 0; i < ROUTE_PLAINTEXT_SIZE; i++) {
    plaintextXor[i] = plaintexts[0][i] ^ plaintexts[1][i]
    ciphertextXor[i] = stream[ROUTE_COUNTER_SIZE + i] ^ datagram[ROUTE_COUNTER_SIZE + i]
  }

  t.alike(counters, [0n, 1n])
  t.unlike(ciphertextXor, plaintextXor)
})

test('authenticated class must match the public counter namespace bit', (t) => {
  let receiverCalls = 0
  let plaintext = null
  const destination = route({
    endpointRole: ROUTE_ENDPOINT.DESTINATION,
    crypto: {
      ...cryptoSuite,
      open() {
        plaintext = b4a.alloc(ROUTE_PLAINTEXT_SIZE)
        plaintext[0] = CELL_CLASS.DATAGRAM
        return plaintext
      }
    },
    receivers: {
      forwardOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      forwardDatagram: {
        acceptAuthenticated() {
          receiverCalls++
          return true
        }
      },
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })

  expectCode(t, () => open(destination, b4a.alloc(ROUTE_FRAME_SIZE)), 'INVALID_ROUTE')
  t.is(receiverCalls, 0)
  t.alike(plaintext, b4a.alloc(ROUTE_PLAINTEXT_SIZE))
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
  const keys = routeKeys()
  const source = route({ keys })
  const destination = receivingRoute(keys, { receivers })
  const frame = seal(source)
  const cases = [
    receivingRoute(keys, { forwardKey: seed(99) }),
    receivingRoute(keys, { descriptorId: b4a.alloc(32, 1) }),
    receivingRoute(keys, { circuitId: b4a.alloc(16, 2) })
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
  const keys = routeKeys()
  const frame = seal(route({ keys }))

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
    const codec = receivingRoute(keys, {
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
  const keys = routeKeys()
  const destination = receivingRoute(keys, {
    receivers: {
      forwardOrdered: receiver,
      forwardDatagram: new DatagramReplayWindow({ window: 8 }),
      reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
      reverseDatagram: new DatagramReplayWindow({ window: 8 })
    }
  })
  const frame = seal(route({ keys }))
  frame[7] ^= 1

  expectCode(t, () => open(destination, frame), 'INVALID_ROUTE')
  t.is(calls, 0)
})

test('ordered route payloads preserve bounded out-of-order delivery', (t) => {
  const { source, destination } = routePair()
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
  const { source, destination } = routePair(
    {},
    {
      receivers: {
        forwardOrdered: receiver,
        forwardDatagram: new DatagramReplayWindow({ window: 8 }),
        reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        reverseDatagram: new DatagramReplayWindow({ window: 8 })
      }
    }
  )

  const opened = open(destination, seal(source))
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
  const { source, destination } = routePair(
    {},
    {
      receivers: {
        forwardOrdered: ordered,
        forwardDatagram: new DatagramReplayWindow({ window: 8 }),
        reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        reverseDatagram: new DatagramReplayWindow({ window: 8 })
      }
    }
  )
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

test('destroy requested by padding or seal crypto aborts the active operation', (t) => {
  for (const trigger of ['padding', 'crypto']) {
    let codec = null
    const overrides =
      trigger === 'padding'
        ? {
            padding(size) {
              codec.destroy()
              return b4a.alloc(size)
            }
          }
        : {
            crypto: {
              ...cryptoSuite,
              seal(options) {
                codec.destroy()
                return cryptoSuite.seal(options)
              }
            }
          }
    codec = route(overrides)

    expectCode(t, () => seal(codec), 'CIRCUIT_STATE')
    t.is(codec.stats.destroyed, true)
    t.is(codec.stats.forward.senderNext, 0n)
    t.is(codec.stats.forward.datagramSenderNext, 0n)
  }
})

test('destroy requested by clock, open crypto, or receiver clears buffered work', (t) => {
  for (const trigger of ['clock', 'crypto', 'receiver']) {
    const owned = []
    let destination = null
    let pair
    const destinationOverrides = {}
    if (trigger === 'clock') {
      destinationOverrides.now = () => {
        destination.destroy()
        return 0
      }
      destinationOverrides.receivers = undefined
    } else if (trigger === 'crypto') {
      destinationOverrides.crypto = {
        ...cryptoSuite,
        open(options) {
          const plaintext = cryptoSuite.open(options)
          destination.destroy()
          return plaintext
        }
      }
    } else {
      destinationOverrides.receivers = {
        forwardOrdered: {
          next: 0n,
          buffered: 0,
          needsRotation: false,
          pushAuthenticated(counter, value) {
            destination.destroy()
            owned.push(value)
            return [value]
          },
          destroy() {
            this.buffered = 0
          }
        },
        forwardDatagram: new DatagramReplayWindow({ window: 8 }),
        reverseOrdered: new OrderedReceiver({ window: 8, gapTimeout: 100, now: () => 0 }),
        reverseDatagram: new DatagramReplayWindow({ window: 8 })
      }
    }
    pair = routePair({}, destinationOverrides)
    destination = pair.destination
    if (trigger === 'clock') seal(pair.source)
    const frame = seal(pair.source, { payload: b4a.from(`destroy from ${trigger}`) })

    expectCode(t, () => open(destination, frame), 'CIRCUIT_STATE')
    t.is(destination.stats.destroyed, true)
    t.is(destination.stats.forward.orderedBuffered, 0)
    for (const value of owned) t.alike(value, b4a.alloc(value.byteLength))
  }
})

test('reentrant seal and open fail closed even when the callback catches the nested error', (t) => {
  let sealing = false
  let sealNested = null
  let source = null
  source = route({
    padding(size) {
      if (!sealing) {
        sealing = true
        try {
          seal(source)
        } catch (err) {
          sealNested = err
        }
      }
      return b4a.alloc(size)
    }
  })
  expectCode(t, () => seal(source), 'CIRCUIT_STATE')
  t.is(sealNested.code, 'INVALID_ROUTE')
  t.is(source.stats.destroyed, true)

  let opening = false
  let openNested = null
  let destination = null
  let frame = null
  const pair = routePair(
    {},
    {
      crypto: {
        ...cryptoSuite,
        open(options) {
          if (!opening) {
            opening = true
            try {
              open(destination, frame)
            } catch (err) {
              openNested = err
            }
          }
          return cryptoSuite.open(options)
        }
      }
    }
  )
  destination = pair.destination
  frame = seal(pair.source)
  expectCode(t, () => open(destination, frame), 'CIRCUIT_STATE')
  t.is(openNested.code, 'INVALID_ROUTE')
  t.is(destination.stats.destroyed, true)
})

test('destroy resets every sender and replay state and tears receivers down once', (t) => {
  let destroys = 0
  function ordered() {
    return {
      next: 7n,
      buffered: 1,
      needsRotation: false,
      pushAuthenticated: () => [],
      destroy() {
        destroys++
        this.next = 0n
        this.buffered = 0
      }
    }
  }
  function datagram() {
    return {
      highest: 4n,
      needsRotation: false,
      acceptAuthenticated: () => true,
      destroy() {
        destroys++
        this.highest = null
      }
    }
  }
  const codec = route({
    receivers: {
      forwardOrdered: ordered(),
      forwardDatagram: datagram(),
      reverseOrdered: ordered(),
      reverseDatagram: datagram()
    }
  })
  seal(codec)
  seal(codec, { class: CELL_CLASS.DATAGRAM })

  codec.destroy()
  codec.destroy()

  t.is(destroys, 4)
  t.is(codec.stats.forward.senderNext, 0n)
  t.is(codec.stats.forward.senderClosed, true)
  t.is(codec.stats.forward.datagramSenderNext, 0n)
  t.is(codec.stats.forward.datagramSenderClosed, true)
  t.is(codec.stats.forward.orderedNext, 0n)
  t.is(codec.stats.forward.orderedBuffered, 0)
  t.is(codec.stats.forward.datagramHighest, null)
})

test('constructor failure zeroes every key and identifier copy it allocated', (t) => {
  const allocations = []
  const keys = routeKeys()
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    if (size === 16 || size === 32) allocations.push(value)
    return value
  }

  try {
    expectCode(t, () => route({ keys, receivers: {} }), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.is(allocations.length, 6)
  for (const value of allocations) t.alike(value, b4a.alloc(value.byteLength))
})

test('constructor rejects overlapping forward and reverse cryptographic contexts', (t) => {
  const keyOverlap = routeKeys()
  expectCode(
    t,
    () =>
      route({
        keys: keyOverlap,
        reverseKey: keyOverlap.forwardKey
      }),
    'INVALID_ROUTE'
  )
  const nonceOverlap = routeKeys()
  expectCode(
    t,
    () =>
      route({
        keys: nonceOverlap,
        reverseNoncePrefix: nonceOverlap.forwardNoncePrefix
      }),
    'INVALID_ROUTE'
  )
})

test('authenticated body validation precedes receiver calls and clears plaintext', (t) => {
  let calls = 0
  let plaintext = null
  const destination = route({
    endpointRole: ROUTE_ENDPOINT.DESTINATION,
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
  const keys = routeKeys()
  const frame = seal(route({ keys }))
  const cases = [
    [PrivateRouteError.REPLAY(), 'REPLAY'],
    [PrivateRouteError.COUNTER_INVALID(), 'COUNTER_INVALID'],
    [PrivateRouteError.COUNTER_GAP(), 'COUNTER_GAP'],
    [PrivateRouteError.COUNTER_EXHAUSTED(), 'COUNTER_EXHAUSTED'],
    [PrivateRouteError.UNAUTHORIZED(), 'INVALID_ROUTE'],
    [new TypeError('receiver detail'), 'INVALID_ROUTE']
  ]

  for (const [error, code] of cases) {
    const destination = receivingRoute(keys, {
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
  const keys = routeKeys()
  const frame = seal(route({ keys }), { class: CELL_CLASS.DATAGRAM })
  for (const result of [false, undefined, 1, 'true']) {
    const destination = receivingRoute(keys, {
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
  const { source, destination } = routePair()
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
  expectCode(
    t,
    () => open(route({ endpointRole: ROUTE_ENDPOINT.DESTINATION }), frame.subarray(1)),
    'INVALID_ROUTE'
  )
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
  const maximum = (1n << 63n) - 1n
  const { source, destination } = routePair(
    { senderInitial: maximum },
    { receiverInitial: maximum }
  )
  const frame = seal(source)

  t.alike(open(destination, frame)[0].payload, b4a.from('private payload'))
  expectCode(t, () => seal(source), 'COUNTER_EXHAUSTED')
  expectCode(t, () => open(destination, frame), 'COUNTER_EXHAUSTED')
})

test('each route class emits uint63 max once in its disjoint wire namespace', (t) => {
  const maximum = (1n << 63n) - 1n
  const { source, destination } = routePair(
    { senderInitial: maximum },
    { receiverInitial: maximum }
  )
  const stream = seal(source)
  const datagram = seal(source, { class: CELL_CLASS.DATAGRAM })

  t.is(b4a.toString(stream.subarray(0, 8), 'hex'), 'fffffffffffffffe')
  t.is(b4a.toString(datagram.subarray(0, 8), 'hex'), 'ffffffffffffffff')
  t.alike(open(destination, stream)[0].payload, b4a.from('private payload'))
  t.alike(open(destination, datagram).payload, b4a.from('private payload'))
  expectCode(t, () => seal(source), 'COUNTER_EXHAUSTED')
  expectCode(t, () => seal(source, { class: CELL_CLASS.DATAGRAM }), 'COUNTER_EXHAUSTED')
})

test('route class rotation signals use the logical uint63 boundary', (t) => {
  const rotateAt = (1n << 63n) - 1n - 1024n
  const { source, destination } = routePair(
    { senderInitial: rotateAt - 1n },
    { receiverInitial: rotateAt - 1n }
  )

  t.is(source.stats.forward.senderNeedsRotation, false)
  t.is(source.stats.forward.datagramSenderNeedsRotation, false)
  t.is(destination.stats.forward.orderedNeedsRotation, false)
  t.is(destination.stats.forward.datagramNeedsRotation, false)

  const stream = seal(source)
  const datagram = seal(source, { class: CELL_CLASS.DATAGRAM })
  open(destination, stream)
  open(destination, datagram)

  t.is(source.stats.forward.senderNeedsRotation, true)
  t.is(source.stats.forward.datagramSenderNeedsRotation, true)
  t.is(destination.stats.forward.orderedNeedsRotation, true)
  t.is(destination.stats.forward.datagramNeedsRotation, false)

  const nextDatagram = seal(source, { class: CELL_CLASS.DATAGRAM })
  open(destination, nextDatagram)
  t.is(destination.stats.forward.datagramNeedsRotation, true)
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
