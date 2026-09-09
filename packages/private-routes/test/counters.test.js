import test from 'brittle'
import b4a from 'b4a'

import * as publicRoutes from '../index.js'
import {
  DatagramReplayWindow,
  MAX_CELL_PAYLOAD,
  MAX_COUNTER,
  OrderedReceiver,
  ROTATE_AT,
  SenderCounter
} from '../index.js'
import * as counterInternals from '../lib/counters.js'
import { expectCode } from './helpers.js'

const TEST_ONLY_BUFFER_OBSERVER = counterInternals.TEST_ONLY_BUFFER_OBSERVER

test('counter zeroization test hook is a non-public symbol', (t) => {
  t.is(typeof TEST_ONLY_BUFFER_OBSERVER, 'symbol')
  t.is('TEST_ONLY_BUFFER_OBSERVER' in publicRoutes, false)
})

function observedOrdered(overrides = {}) {
  const owned = []
  const receiver = new OrderedReceiver({
    window: 4,
    gapTimeout: 50,
    now: () => 0,
    ...overrides,
    [TEST_ONLY_BUFFER_OBSERVER](payload) {
      owned.push(payload)
    }
  })

  return { owned, receiver }
}

test('ordered receiver buffers a bounded authenticated gap then drains', (t) => {
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })

  t.alike(receiver.pushAuthenticated(1n, 'b'), [])
  t.alike(receiver.pushAuthenticated(0n, 'a'), ['a', 'b'])
  expectCode(t, () => receiver.pushAuthenticated(1n, 'again'), 'REPLAY')
})

test('datagram window includes its exact floor and rejects below it', (t) => {
  const receiver = new DatagramReplayWindow({ window: 8 })

  t.is(receiver.acceptAuthenticated(7n), true)
  t.is(receiver.floor, 0n)
  t.is(receiver.acceptAuthenticated(0n), true)
  expectCode(t, () => receiver.acceptAuthenticated(0n), 'REPLAY')
  t.is(receiver.acceptAuthenticated(8n), true)
  t.is(receiver.floor, 1n)
  t.is(receiver.acceptAuthenticated(1n), true)
  expectCode(t, () => receiver.acceptAuthenticated(0n), 'REPLAY')
})

test('sender never wraps after emitting uint64 max', (t) => {
  const sender = new SenderCounter({ initial: MAX_COUNTER })

  t.is(sender.next(), MAX_COUNTER)
  t.is(sender.closed, true)
  expectCode(t, () => sender.next(), 'COUNTER_EXHAUSTED')
})

test('all counter inputs are BigInt uint64 values', (t) => {
  const invalid = [null, 0, -1n, MAX_COUNTER + 1n]

  for (const counter of invalid) {
    expectCode(t, () => new SenderCounter({ initial: counter }), 'COUNTER_INVALID')
    expectCode(
      t,
      () =>
        new OrderedReceiver({
          window: 4,
          gapTimeout: 50,
          now: () => 0,
          initial: counter
        }),
      'COUNTER_INVALID'
    )

    const ordered = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
    const datagram = new DatagramReplayWindow({ window: 8 })
    expectCode(t, () => ordered.pushAuthenticated(counter, 'payload'), 'COUNTER_INVALID')
    expectCode(t, () => datagram.acceptAuthenticated(counter), 'COUNTER_INVALID')
  }
})

test('counter constructors reject unbounded windows and invalid clocks', (t) => {
  const invalidWindows = [null, 0, -1, 1.5, 4097, 8n]

  for (const window of invalidWindows) {
    expectCode(t, () => new DatagramReplayWindow({ window }), 'COUNTER_INVALID')
    expectCode(
      t,
      () => new OrderedReceiver({ window, gapTimeout: 50, now: () => 0 }),
      'COUNTER_INVALID'
    )
  }

  const invalidTimes = [null, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
  for (const gapTimeout of invalidTimes) {
    expectCode(
      t,
      () => new OrderedReceiver({ window: 4, gapTimeout, now: () => 0 }),
      'COUNTER_INVALID'
    )
  }

  expectCode(t, () => new OrderedReceiver({ window: 4, gapTimeout: 50, now: 0 }), 'COUNTER_INVALID')
  expectCode(t, () => new SenderCounter(null), 'COUNTER_INVALID')
  expectCode(t, () => new DatagramReplayWindow(null), 'COUNTER_INVALID')

  const invalidNow = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => -1 })
  expectCode(t, () => invalidNow.pushAuthenticated(1n, 'future'), 'COUNTER_INVALID')
  t.is(invalidNow.next, 0n)
  t.is(invalidNow.buffered, 0)
})

test('ordered gap expires exactly at the configured timeout', (t) => {
  let current = 0
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => current })

  t.alike(receiver.pushAuthenticated(1n, 'future'), [])
  current = 49
  t.is(receiver.expire(), false)
  t.is(receiver.closed, false)
  t.is(receiver.buffered, 1)
  current = 50
  expectCode(t, () => receiver.expire(), 'COUNTER_GAP')
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  expectCode(t, () => receiver.pushAuthenticated(0n, 'late'), 'COUNTER_EXHAUSTED')
})

test('ordered receiver closes and discards owned buffers on a too-far gap', (t) => {
  const { owned, receiver } = observedOrdered()
  const source = b4a.from('secret')

  receiver.pushAuthenticated(1n, source)
  t.is(owned.length, 1)
  t.ok(owned[0] !== source)
  expectCode(t, () => receiver.pushAuthenticated(4n, 'too-far'), 'COUNTER_GAP')
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
  t.is(b4a.toString(source), 'secret')
})

test('ordered buffered payloads are copied, delivered independently, and cleared', (t) => {
  const { owned, receiver } = observedOrdered()
  const source = b4a.from('b')

  receiver.pushAuthenticated(1n, source)
  source[0] = 'x'.charCodeAt(0)
  const delivered = receiver.pushAuthenticated(0n, b4a.from('a'))

  t.is(owned.length, 1)
  t.is(b4a.toString(delivered[0]), 'a')
  t.is(b4a.toString(delivered[1]), 'b')
  t.ok(delivered[1] !== owned[0])
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
  t.is(receiver.buffered, 0)
})

test('ordered buffering accounts for intrinsic buffer length despite own shadows', (t) => {
  const small = b4a.from([0x61])
  Object.defineProperty(small, 'byteLength', { value: MAX_CELL_PAYLOAD + 1 })
  const acceptsSmall = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  let smallResult = null
  let smallError = null
  try {
    smallResult = acceptsSmall.pushAuthenticated(1n, small)
  } catch (err) {
    smallError = err
  }
  t.is(smallError, null)
  t.alike(smallResult, [])
  const delivered = acceptsSmall.pushAuthenticated(0n, b4a.from([0x60]))
  t.alike(delivered[1], b4a.from([0x61]))

  const oversized = b4a.alloc(MAX_CELL_PAYLOAD + 1, 0x62)
  Object.defineProperty(oversized, 'byteLength', { value: 1 })
  const rejectsLarge = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  expectCode(t, () => rejectsLarge.pushAuthenticated(1n, oversized), 'COUNTER_INVALID')
  t.is(rejectsLarge.closed, true)
  t.is(rejectsLarge.buffered, 0)
})

test('rotation signals use the next, expected, and highest counters exactly', (t) => {
  const sender = new SenderCounter({ initial: ROTATE_AT - 1n })
  t.is(sender.needsRotation, false)
  t.is(sender.value, ROTATE_AT - 1n)
  t.is(sender.next(), ROTATE_AT - 1n)
  t.is(sender.value, ROTATE_AT)
  t.is(sender.needsRotation, true)

  const ordered = new OrderedReceiver({
    window: 4,
    gapTimeout: 50,
    now: () => 0,
    initial: ROTATE_AT - 1n
  })
  t.is(ordered.needsRotation, false)
  t.alike(ordered.pushAuthenticated(ROTATE_AT - 1n, 'payload'), ['payload'])
  t.is(ordered.next, ROTATE_AT)
  t.is(ordered.needsRotation, true)

  const datagram = new DatagramReplayWindow({ window: 8 })
  datagram.acceptAuthenticated(ROTATE_AT - 1n)
  t.is(datagram.needsRotation, false)
  datagram.acceptAuthenticated(ROTATE_AT)
  t.is(datagram.highest, ROTATE_AT)
  t.is(datagram.needsRotation, true)
})

test('ordered receiver delivers uint64 max once then fails closed', (t) => {
  const receiver = new OrderedReceiver({
    window: 4,
    gapTimeout: 50,
    now: () => 0,
    initial: MAX_COUNTER
  })

  t.alike(receiver.pushAuthenticated(MAX_COUNTER, 'last'), ['last'])
  t.is(receiver.next, MAX_COUNTER)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  expectCode(t, () => receiver.pushAuthenticated(MAX_COUNTER, 'again'), 'COUNTER_EXHAUSTED')
})

test('datagram receiver closes after uint64 max and rejects every later counter', (t) => {
  const receiver = new DatagramReplayWindow({ window: 8 })

  t.is(receiver.acceptAuthenticated(MAX_COUNTER), true)
  t.is(receiver.highest, MAX_COUNTER)
  t.is(receiver.floor, MAX_COUNTER - 7n)
  t.is(receiver.needsRotation, true)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 1)
  expectCode(t, () => receiver.acceptAuthenticated(MAX_COUNTER - 1n), 'COUNTER_EXHAUSTED')
  expectCode(t, () => receiver.acceptAuthenticated(MAX_COUNTER), 'COUNTER_EXHAUSTED')
})

test('public counter state is exposed through getter-only properties', (t) => {
  const properties = [
    [SenderCounter.prototype, ['value', 'needsRotation', 'closed']],
    [OrderedReceiver.prototype, ['next', 'needsRotation', 'closed', 'buffered']],
    [DatagramReplayWindow.prototype, ['floor', 'highest', 'needsRotation', 'closed', 'buffered']]
  ]

  for (const [prototype, names] of properties) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      t.is(typeof descriptor.get, 'function')
      t.is(descriptor.set, undefined)
    }
  }
})

test('ordered receiver rejects reentrant state mutation from its clock', (t) => {
  let receiver = null
  let reentrantError = null
  receiver = new OrderedReceiver({
    window: 4,
    gapTimeout: 50,
    now() {
      try {
        receiver.pushAuthenticated(0n, 'reentrant')
      } catch (err) {
        reentrantError = err
      }
      return 0
    }
  })

  t.alike(receiver.pushAuthenticated(1n, 'future'), [])
  t.is(reentrantError.code, 'COUNTER_INVALID')
  t.is(receiver.next, 0n)
  t.is(receiver.buffered, 1)
})

test('ordered receiver reentrant destroy zeroes newly buffered authenticated payload', (t) => {
  const owned = []
  let receiver = null
  receiver = new OrderedReceiver({
    window: 4,
    gapTimeout: 50,
    now() {
      receiver.destroy()
      return 0
    },
    [TEST_ONLY_BUFFER_OBSERVER](payload) {
      owned.push(payload)
    }
  })

  t.alike(receiver.pushAuthenticated(1n, b4a.from('authenticated secret')), [])
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  t.is(owned.length, 1)
  t.alike(owned[0], b4a.alloc(owned[0].byteLength))
  expectCode(t, () => receiver.pushAuthenticated(0n, b4a.from('later')), 'COUNTER_EXHAUSTED')
})

test('window one accepts only the exact ordered counter and latest datagram', (t) => {
  const ordered = new OrderedReceiver({ window: 1, gapTimeout: 50, now: () => 0 })
  t.alike(ordered.pushAuthenticated(0n, 'exact'), ['exact'])
  expectCode(t, () => ordered.pushAuthenticated(2n, 'gap'), 'COUNTER_GAP')
  t.is(ordered.closed, true)

  const datagram = new DatagramReplayWindow({ window: 1 })
  t.is(datagram.acceptAuthenticated(7n), true)
  t.is(datagram.floor, 7n)
  expectCode(t, () => datagram.acceptAuthenticated(6n), 'REPLAY')
  t.is(datagram.acceptAuthenticated(8n), true)
  t.is(datagram.floor, 8n)
  t.is(datagram.buffered, 1)
})

test('ordered window accepts window minus one and rejects an exact window jump', (t) => {
  const allowed = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  t.alike(allowed.pushAuthenticated(3n, 'inside'), [])
  t.is(allowed.buffered, 1)

  const rejected = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  expectCode(t, () => rejected.pushAuthenticated(4n, 'outside'), 'COUNTER_GAP')
  t.is(rejected.closed, true)
  t.is(rejected.buffered, 0)
})

test('datagram replay window handles a huge jump without a huge shift', (t) => {
  const receiver = new DatagramReplayWindow({ window: 8 })

  receiver.acceptAuthenticated(0n)
  t.is(receiver.acceptAuthenticated(MAX_COUNTER - 1n), true)
  t.is(receiver.highest, MAX_COUNTER - 1n)
  t.is(receiver.floor, MAX_COUNTER - 8n)
  t.is(receiver.buffered, 1)
})

test('zero gap timeout fails closed without reading the clock', (t) => {
  let calls = 0
  const receiver = new OrderedReceiver({
    window: 4,
    gapTimeout: 0,
    now() {
      calls++
      throw new Error('clock must not run')
    }
  })

  expectCode(t, () => receiver.pushAuthenticated(1n, 'future'), 'COUNTER_GAP')
  t.is(calls, 0)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
})

test('a regressing clock closes and clears an established ordered gap', (t) => {
  let current = 100
  const { owned, receiver } = observedOrdered({ now: () => current })

  receiver.pushAuthenticated(1n, b4a.from('secret'))
  current = 99
  expectCode(t, () => receiver.expire(), 'COUNTER_INVALID')
  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('ordered gap rejects regression from its last accepted explicit reading', (t) => {
  const { owned, receiver } = observedOrdered({ gapTimeout: 100, now: () => 100 })

  receiver.pushAuthenticated(1n, b4a.from('secret'))
  t.is(receiver.expire(150), false)
  expectCode(t, () => receiver.expire(149), 'COUNTER_INVALID')
  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('draining an ordered gap resets its monotonic clock baseline', (t) => {
  let current = 100
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 100, now: () => current })

  receiver.pushAuthenticated(1n, 'one')
  current = 150
  t.is(receiver.expire(), false)
  t.alike(receiver.pushAuthenticated(0n, 'zero'), ['zero', 'one'])

  current = 10
  t.alike(receiver.pushAuthenticated(3n, 'three'), [])
  t.is(receiver.closed, false)
  t.is(receiver.buffered, 1)
})

test('a throwing clock closes and clears an established ordered gap', (t) => {
  let broken = false
  const { owned, receiver } = observedOrdered({
    now() {
      if (broken) throw new Error('clock failed')
      return 0
    }
  })

  receiver.pushAuthenticated(1n, b4a.from('secret'))
  broken = true
  expectCode(t, () => receiver.expire(), 'COUNTER_INVALID')
  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('an invalid clock closes and clears an established ordered gap', (t) => {
  let current = 0
  const { owned, receiver } = observedOrdered({ now: () => current })

  receiver.pushAuthenticated(1n, b4a.from('secret'))
  current = Number.NaN
  expectCode(t, () => receiver.expire(), 'COUNTER_INVALID')
  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('ordered receiver bounds byte payloads before buffering', (t) => {
  const accepted = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  t.alike(accepted.pushAuthenticated(1n, b4a.alloc(1146)), [])
  t.is(accepted.buffered, 1)

  const rejected = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  expectCode(t, () => rejected.pushAuthenticated(1n, b4a.alloc(1147)), 'COUNTER_INVALID')
  t.is(rejected.closed, true)
  t.is(rejected.buffered, 0)
})

test('copy failure while buffering closes and zeroes prior owned payloads', (t) => {
  const { owned, receiver } = observedOrdered()
  const failing = b4a.from('second')
  receiver.pushAuthenticated(1n, b4a.from('first'))

  const originalAllocUnsafeSlow = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = () => {
    throw new Error('copy failed')
  }
  try {
    expectCode(t, () => receiver.pushAuthenticated(2n, failing), 'COUNTER_INVALID')
  } finally {
    b4a.allocUnsafeSlow = originalAllocUnsafeSlow
  }

  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('copy failure while draining closes and zeroes the undelivered payload', (t) => {
  const { owned, receiver } = observedOrdered()
  receiver.pushAuthenticated(1n, b4a.from('buffered'))

  const originalAllocUnsafeSlow = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = () => {
    throw new Error('copy failed')
  }
  try {
    expectCode(t, () => receiver.pushAuthenticated(0n, 'first'), 'COUNTER_INVALID')
  } finally {
    b4a.allocUnsafeSlow = originalAllocUnsafeSlow
  }

  t.is(owned.length, 1)
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  if (owned[0]) t.alike(owned[0], b4a.alloc(owned[0].byteLength))
})

test('ordered receiver destroy closes and zeroes every buffered payload', (t) => {
  const { owned, receiver } = observedOrdered()
  receiver.pushAuthenticated(1n, b4a.from('buffered secret'))

  receiver.destroy()
  receiver.destroy()

  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  t.alike(owned[0], b4a.alloc(owned[0].byteLength))
  expectCode(t, () => receiver.pushAuthenticated(0n, b4a.from('later')), 'COUNTER_EXHAUSTED')
})

test('hostile and revoked constructor options use stable counter errors', (t) => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile getter')
      }
    }
  )
  const revocable = Proxy.revocable({}, {})
  revocable.revoke()

  for (const options of [hostile, revocable.proxy]) {
    expectCode(t, () => new SenderCounter(options), 'COUNTER_INVALID')
    expectCode(t, () => new OrderedReceiver(options), 'COUNTER_INVALID')
    expectCode(t, () => new DatagramReplayWindow(options), 'COUNTER_INVALID')
  }
})

test('counter instances expose no externally mutable implementation state', (t) => {
  const instances = [
    new SenderCounter(),
    new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 }),
    new DatagramReplayWindow({ window: 8 })
  ]

  for (const instance of instances) t.alike(Reflect.ownKeys(instance), [])
})
