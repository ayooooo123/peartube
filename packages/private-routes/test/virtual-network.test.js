import test from 'brittle'
import b4a from 'b4a'

import * as publicRoutes from '../index.js'
import { PrivateRouteError, VirtualNetwork } from '../index.js'
import {
  MAX_FAULT_OUTPUTS,
  MAX_PENDING_PACKETS,
  MAX_VIRTUAL_DELAY,
  TEST_ONLY_PACKET_OBSERVER
} from '../lib/virtual-network.js'
import { expectCode } from './helpers.js'

function text(packet) {
  return b4a.toString(packet)
}

test('virtual network is supported without exposing its internal limits', (t) => {
  t.is(typeof VirtualNetwork, 'function')
  t.is('MAX_FAULT_OUTPUTS' in publicRoutes, false)
  t.is('MAX_PENDING_PACKETS' in publicRoutes, false)
  t.is('MAX_VIRTUAL_DELAY' in publicRoutes, false)
  t.is('TEST_ONLY_PACKET_OBSERVER' in publicRoutes, false)
})

test('virtual link exposes only sender and receiver for each delivery', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('source', () => {})
  network.register('guard', (packet) => network.send('guard', 'relay', packet))
  network.register('relay', () => {})

  network.send('source', 'guard', b4a.from('cell'))
  network.flush()

  t.alike(network.edges(), [
    ['source', 'guard'],
    ['guard', 'relay']
  ])
  t.alike(
    network.view('guard').map((event) => event.peer),
    ['source', 'relay']
  )
  t.alike(
    network.view('relay').map((event) => event.peer),
    ['guard']
  )

  for (const observer of ['source', 'guard', 'relay']) {
    for (const event of network.view(observer)) {
      t.alike(Object.keys(event), ['peer', 'direction', 'byteLength', 'time', 'packetId'])
      t.is('packet' in event, false)
      t.is('from' in event, false)
      t.is('to' in event, false)
      t.is(typeof event.packetId, 'string')
      t.ok(Object.isFrozen(event))
    }
  }
})

test('send copies intrinsic packet bytes and ignores shadowed lengths', (t) => {
  const received = []
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  network.register('b', (packet) => received.push(b4a.from(packet)))

  const small = b4a.from('cell')
  Object.defineProperty(small, 'byteLength', { value: 999999 })
  Object.defineProperty(small, 'length', { value: 1 })
  network.send('a', 'b', small)
  small.fill(0)
  network.flush()

  t.alike(received, [b4a.from('cell')])
  t.is(network.view('a')[0].byteLength, 4)

  const large = b4a.alloc(32, 0x61)
  Object.defineProperty(large, 'byteLength', { value: 1 })
  network.send('a', 'b', large)
  network.flush()
  t.is(received[1].byteLength, 32)
  t.is(network.view('b')[1].byteLength, 32)
})

test('same-time packets and edges are stable by insertion sequence', (t) => {
  const received = []
  const network = new VirtualNetwork({ now: 7 })
  for (const name of ['a', 'b', 'c'])
    network.register(name, (packet) => received.push(text(packet)))

  network.send('a', 'b', b4a.from('one'))
  network.send('c', 'b', b4a.from('two'))
  network.send('a', 'b', b4a.from('three'))
  t.is(network.flush(), 3)

  t.alike(received, ['one', 'two', 'three'])
  t.alike(network.edges(), [
    ['a', 'b'],
    ['c', 'b']
  ])
  t.alike(network.directPeers('b'), ['a', 'c'])
  t.alike(network.directPeers('a'), ['b'])
  t.is(network.now, 7)
})

test('edge identity pairs cannot collide through embedded separators', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  for (const name of ['a', 'b\u0000c', 'a\u0000b', 'c']) network.register(name, () => {})
  network.send('a', 'b\u0000c', b4a.from('one'))
  network.send('a\u0000b', 'c', b4a.from('two'))
  network.flush()

  t.alike(network.edges(), [
    ['a', 'b\u0000c'],
    ['a\u0000b', 'c']
  ])
  t.alike(network.directPeers('b\u0000c'), ['a'])
  t.alike(network.directPeers('a\u0000b'), ['c'])
})

test('delays, duplication, drop, and array order are deterministic', (t) => {
  const received = []
  const network = new VirtualNetwork({
    now: 10,
    fault({ packet }) {
      switch (text(packet)) {
        case 'drop':
          return 'drop'
        case 'duplicate':
          return [{ packet }, { packet }]
        case 'reorder':
          return [
            { packet: b4a.from('late'), delay: 5 },
            { packet: b4a.from('early'), delay: 0 }
          ]
        default:
          return { packet, delay: 3 }
      }
    }
  })
  network.register('a', () => {})
  network.register('b', (packet) => received.push(text(packet)))

  network.send('a', 'b', b4a.from('drop'))
  network.send('a', 'b', b4a.from('duplicate'))
  network.send('a', 'b', b4a.from('reorder'))
  network.send('a', 'b', b4a.from('delayed'))
  t.is(network.flush(), 3)
  t.alike(received, ['duplicate', 'duplicate', 'early'])
  t.is(network.advance(3), 13)
  t.is(network.flush(), 1)
  t.alike(received, ['duplicate', 'duplicate', 'early', 'delayed'])
  network.advance(2)
  t.is(network.flush(), 1)
  t.alike(received, ['duplicate', 'duplicate', 'early', 'delayed', 'late'])
  t.is(network.view('a').length, 5, 'dropped packet is not a delivery event')
})

test('fault hooks receive an isolated copy and fixed local metadata', (t) => {
  let event = null
  const received = []
  const network = new VirtualNetwork({
    now: 4,
    fault(value) {
      event = value
      value.packet[0] = 0x78
      return undefined
    }
  })
  network.register('a', () => {})
  network.register('b', (packet) => received.push(text(packet)))
  const input = b4a.from('a')
  network.send('a', 'b', input)
  t.is(text(input), 'a')
  network.flush()

  t.alike(received, ['x'])
  t.alike(Object.keys(event), ['from', 'to', 'packet', 'time', 'packetId'])
  t.is(event.from, 'a')
  t.is(event.to, 'b')
  t.is(event.time, 4)
  t.ok(Object.isFrozen(event))
})

test('fault output and delay bounds fail closed without queued packets', (t) => {
  t.is(MAX_FAULT_OUTPUTS, 64)
  t.is(MAX_VIRTUAL_DELAY, 24 * 60 * 60 * 1000)

  const outputs = new Array(MAX_FAULT_OUTPUTS + 1).fill({ delay: 0 })
  const tooMany = new VirtualNetwork({ now: 0, fault: () => outputs })
  tooMany.register('a', () => {})
  tooMany.register('b', () => {})
  expectCode(t, () => tooMany.send('a', 'b', b4a.from('x')), 'VIRTUAL_LIMIT')
  t.is(tooMany.flush(), 0)

  const delayed = new VirtualNetwork({ now: 0, fault: () => ({ delay: MAX_VIRTUAL_DELAY + 1 }) })
  delayed.register('a', () => {})
  delayed.register('b', () => {})
  expectCode(t, () => delayed.send('a', 'b', b4a.from('x')), 'VIRTUAL_LIMIT')
  t.is(delayed.flush(), 0)

  const exact = []
  const accepted = new VirtualNetwork({ now: 0, fault: () => ({ delay: MAX_VIRTUAL_DELAY }) })
  accepted.register('a', () => {})
  accepted.register('b', (packet) => exact.push(text(packet)))
  accepted.send('a', 'b', b4a.from('x'))
  accepted.advance(MAX_VIRTUAL_DELAY)
  t.is(accepted.flush(), 1)
  t.alike(exact, ['x'])
})

test('malformed, throwing, and revoked fault hooks use stable errors', (t) => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const revokedHook = Proxy.revocable(() => {}, {})
  revokedHook.revoke()
  const invalid = [
    () => null,
    () => [],
    () => 1,
    () => ({ drop: false }),
    () => ({ delay: -1 }),
    () => ({ delay: 1.5 }),
    () => ({ delay: 0, packet: 'not bytes' }),
    () => revoked.proxy,
    revokedHook.proxy,
    () => {
      throw new Error('hostile hook')
    }
  ]

  for (const fault of invalid) {
    const network = new VirtualNetwork({ now: 0, fault })
    network.register('a', () => {})
    network.register('b', () => {})
    expectCode(t, () => network.send('a', 'b', b4a.from('x')), 'VIRTUAL_LIMIT')
    t.is(network.flush(), 0)
  }
})

test('unknown, duplicate, malformed, and self nodes are rejected', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  expectCode(t, () => network.register('a', () => {}), 'INVALID_ROUTE')
  expectCode(t, () => network.register('', () => {}), 'INVALID_ROUTE')
  expectCode(t, () => network.register('b', null), 'INVALID_ROUTE')
  expectCode(t, () => network.send('a', 'missing', b4a.from('x')), 'INVALID_ROUTE')
  expectCode(t, () => network.send('missing', 'a', b4a.from('x')), 'INVALID_ROUTE')
  expectCode(t, () => network.send('a', 'a', b4a.from('x')), 'INVALID_ROUTE')
  expectCode(t, () => network.send('a', 'missing', 'x'), 'INVALID_ROUTE')
  expectCode(t, () => network.view('missing'), 'INVALID_ROUTE')
  expectCode(t, () => network.directPeers('missing'), 'INVALID_ROUTE')
})

test('virtual time is monotonic safe-integer arithmetic', (t) => {
  for (const now of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expectCode(t, () => new VirtualNetwork({ now }), 'VIRTUAL_LIMIT')
  }

  const network = new VirtualNetwork({ now: Number.MAX_SAFE_INTEGER })
  expectCode(t, () => network.advance(1), 'VIRTUAL_LIMIT')
  t.is(network.now, Number.MAX_SAFE_INTEGER)
  for (const ms of [-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expectCode(t, () => network.advance(ms), 'VIRTUAL_LIMIT')
  }

  const overflow = new VirtualNetwork({
    now: Number.MAX_SAFE_INTEGER,
    fault: () => ({ delay: 1 })
  })
  overflow.register('a', () => {})
  overflow.register('b', () => {})
  expectCode(t, () => overflow.send('a', 'b', b4a.from('x')), 'VIRTUAL_LIMIT')
  t.is(overflow.flush(), 0)
})

test('constructor and flush options reject hostile values without raw exceptions', (t) => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const options of [null, [], revoked.proxy]) {
    expectCode(t, () => new VirtualNetwork(options), 'VIRTUAL_LIMIT')
  }

  for (const fault of [null, 1, {}]) {
    expectCode(t, () => new VirtualNetwork({ now: 0, fault }), 'VIRTUAL_LIMIT')
  }

  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  for (const options of [null, [], revoked.proxy]) {
    expectCode(t, () => network.flush(options), 'VIRTUAL_LIMIT')
  }
  for (const maxDeliveries of [0, -1, 1.5, 100001]) {
    expectCode(t, () => network.flush({ maxDeliveries }), 'VIRTUAL_LIMIT')
  }
})

test('handler errors propagate unchanged and later queued delivery remains resumable', (t) => {
  const marker = new Error('handler failed')
  const received = []
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  network.register('b', () => {
    throw marker
  })
  network.register('c', (packet) => received.push(text(packet)))
  network.send('a', 'b', b4a.from('first'))
  network.send('a', 'c', b4a.from('second'))

  let error = null
  try {
    network.flush()
  } catch (cause) {
    error = cause
  }
  t.is(error, marker)
  t.is(network.flush(), 1)
  t.alike(received, ['second'])
})

test('handler packets are borrowed and cleared after return or throw', (t) => {
  const borrowed = []
  const received = []
  const marker = new Error('after forward')
  const network = new VirtualNetwork({
    now: 0,
    [TEST_ONLY_PACKET_OBSERVER](packet) {
      borrowed.push(packet)
    }
  })
  network.register('a', () => {})
  network.register('b', (packet) => {
    network.send('b', 'c', packet)
    throw marker
  })
  network.register('c', (packet) => received.push(b4a.from(packet)))
  network.send('a', 'b', b4a.from('secret'))

  let error = null
  try {
    network.flush()
  } catch (cause) {
    error = cause
  }
  t.is(error, marker)
  t.is(borrowed.length, 1)
  t.alike(borrowed[0], b4a.alloc(6))
  t.is(network.flush(), 1)
  t.alike(received, [b4a.from('secret')])
  t.is(borrowed.length, 2)
  t.alike(borrowed[1], b4a.alloc(6))
})

test('nested flush is a sticky fail-closed violation even when caught by a handler', (t) => {
  let nested = null
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  network.register('b', () => {
    try {
      network.flush({ maxDeliveries: 1 })
    } catch (error) {
      nested = error
    }
  })
  network.register('c', () => {})
  network.send('a', 'b', b4a.from('first'))
  network.send('a', 'c', b4a.from('must clear'))

  expectCode(t, () => network.flush(), 'VIRTUAL_LIMIT')
  t.ok(nested instanceof PrivateRouteError)
  t.is(nested.code, 'VIRTUAL_LIMIT')
  t.is(network.flush(), 0)
})

test('fault hooks cannot recursively mutate the virtual network', (t) => {
  for (const operation of ['send', 'flush', 'advance', 'register']) {
    let nested = null
    let network = null
    network = new VirtualNetwork({
      now: 0,
      fault() {
        try {
          if (operation === 'send') network.send('a', 'b', b4a.from('nested'))
          else if (operation === 'flush') network.flush()
          else if (operation === 'advance') network.advance(1)
          else network.register('c', () => {})
        } catch (error) {
          nested = error
        }
        return undefined
      }
    })
    network.register('a', () => {})
    network.register('b', () => {})

    expectCode(t, () => network.send('a', 'b', b4a.from('outer')), 'VIRTUAL_LIMIT')
    t.ok(nested instanceof PrivateRouteError)
    t.is(nested.code, 'VIRTUAL_LIMIT')
    t.is(network.flush(), 0)
  }
})

test('reentrant cycles hit the delivery guard and clear the adversarial batch', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', (packet) => network.send('a', 'b', packet))
  network.register('b', (packet) => network.send('b', 'a', packet))
  network.send('a', 'b', b4a.from('cycle'))

  expectCode(t, () => network.flush({ maxDeliveries: 5 }), 'VIRTUAL_LIMIT')
  t.is(network.flush(), 0)
  t.is(network.view('a').length, 5)
  t.is(network.view('b').length, 5)
})

test('pending queue bound rejects amplification and clears every queued packet', (t) => {
  t.is(MAX_PENDING_PACKETS, 100_000)
  const fanout = new Array(MAX_FAULT_OUTPUTS).fill({ delay: MAX_VIRTUAL_DELAY })
  const network = new VirtualNetwork({ now: 0, fault: () => fanout })
  network.register('a', () => {})
  network.register('b', () => {})

  for (let i = 0; i < Math.floor(MAX_PENDING_PACKETS / MAX_FAULT_OUTPUTS); i++) {
    network.send('a', 'b', b4a.from('x'))
  }
  expectCode(t, () => network.send('a', 'b', b4a.from('x')), 'VIRTUAL_LIMIT')
  network.advance(MAX_VIRTUAL_DELAY)
  t.is(network.flush(), 0)
})

test('allocation failures zero partial packet copies and leave no delivery', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  network.register('b', () => {})
  const originalAlloc = b4a.allocUnsafeSlow
  const allocations = []
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(Math.max(0, size - 1))
    value.fill(0xa5)
    allocations.push(value)
    return value
  }
  try {
    expectCode(t, () => network.send('a', 'b', b4a.from('secret')), 'VIRTUAL_LIMIT')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
  t.is(allocations.length, 1)
  t.alike(allocations[0], b4a.alloc(allocations[0].byteLength))
  t.is(network.flush(), 0)

  const partial = new VirtualNetwork({
    now: 0,
    fault: ({ packet }) => [{ packet }, { packet }]
  })
  partial.register('a', () => {})
  partial.register('b', () => {})
  allocations.length = 0
  let calls = 0
  b4a.allocUnsafeSlow = (size) => {
    calls++
    const value = originalAlloc(calls === 3 ? size - 1 : size)
    value.fill(0xb6)
    allocations.push(value)
    return value
  }
  try {
    expectCode(t, () => partial.send('a', 'b', b4a.from('secret')), 'VIRTUAL_LIMIT')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
  t.is(allocations.length, 3)
  for (const value of allocations) t.alike(value, b4a.alloc(value.byteLength))
  t.is(partial.flush(), 0)
})

test('observer snapshots and topology helpers are immutable copies', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('a', () => {})
  network.register('b', () => {})
  network.send('a', 'b', b4a.from('x'))
  network.flush()

  const view = network.view('a')
  const edges = network.edges()
  const peers = network.directPeers('a')
  t.ok(Object.isFrozen(view))
  t.ok(Object.isFrozen(edges))
  t.ok(Object.isFrozen(edges[0]))
  t.ok(Object.isFrozen(peers))
  t.exception.all(() => view.push({}))
  t.exception.all(() => edges[0].push('c'))
  t.exception.all(() => peers.push('c'))
  t.alike(network.edges(), [['a', 'b']])
  t.alike(network.directPeers('a'), ['b'])
  t.exception.all(() => {
    network.now = 100
  })
  t.is(network.now, 0)
})
