import test from 'brittle'
import b4a from 'b4a'

import {
  DatagramReplayWindow,
  MAX_COUNTER,
  OrderedReceiver,
  ROTATE_AT,
  SenderCounter
} from '../index.js'
import { expectCode } from './helpers.js'

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
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  const source = b4a.from('secret')

  receiver.pushAuthenticated(1n, source)
  const owned = receiver._buffer.get(1n)
  t.ok(owned !== source)
  expectCode(t, () => receiver.pushAuthenticated(4n, 'too-far'), 'COUNTER_GAP')
  t.is(receiver.closed, true)
  t.is(receiver.buffered, 0)
  t.alike(owned, b4a.alloc(owned.byteLength))
  t.is(b4a.toString(source), 'secret')
})

test('ordered buffered payloads are copied, delivered independently, and cleared', (t) => {
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  const source = b4a.from('b')

  receiver.pushAuthenticated(1n, source)
  const owned = receiver._buffer.get(1n)
  source[0] = 'x'.charCodeAt(0)
  const delivered = receiver.pushAuthenticated(0n, b4a.from('a'))

  t.is(b4a.toString(delivered[0]), 'a')
  t.is(b4a.toString(delivered[1]), 'b')
  t.ok(delivered[1] !== owned)
  t.alike(owned, b4a.alloc(owned.byteLength))
  t.is(receiver.buffered, 0)
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
