import test from 'brittle'
import b4a from 'b4a'

import {
  MAX_BUFFERED_BYTES,
  MAX_COMPLETED_IDS,
  MAX_FRAGMENT_DATA,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES,
  MESSAGE_TIMEOUT,
  Reassembler,
  fragment
} from '../index.js'
import { TEST_ONLY_FRAGMENT_OBSERVER } from '../lib/fragments.js'
import { expectCode } from './helpers.js'

function id(value) {
  return b4a.alloc(16, value)
}

function frame(messageId, index, total, data = b4a.alloc(0)) {
  const value = b4a.alloc(20 + data.byteLength)
  value.set(messageId, 0)
  value[16] = index >>> 8
  value[17] = index
  value[18] = total >>> 8
  value[19] = total
  value.set(data, 20)
  return value
}

function reassembler(overrides = {}) {
  return new Reassembler({
    now: () => 0,
    epochExpiresAt: 100_000,
    ...overrides
  })
}

test('fragment constants lock exact experimental bounds', (t) => {
  t.is(MAX_FRAGMENT_DATA, 1053)
  t.is(MAX_MESSAGE_BYTES, 16 * 1024 * 1024)
  t.is(MAX_MESSAGES, 64)
  t.is(MAX_BUFFERED_BYTES, 32 * 1024 * 1024)
  t.is(MAX_COMPLETED_IDS, 4096)
  t.is(MESSAGE_TIMEOUT, 30_000)
})

test('fragment accepts exactly 16 MiB and rejects one-byte overflow before ID work', (t) => {
  const message = b4a.alloc(MAX_MESSAGE_BYTES, 0x5c)
  const frames = fragment(message, { messageId: id(36) })
  const expectedTotal = Math.ceil(MAX_MESSAGE_BYTES / MAX_FRAGMENT_DATA)
  const finalBytes = MAX_MESSAGE_BYTES - (expectedTotal - 1) * MAX_FRAGMENT_DATA

  t.is(frames.length, expectedTotal)
  t.is(frames[0].byteLength, 20 + MAX_FRAGMENT_DATA)
  t.is(frames[frames.length - 1].byteLength, 20 + finalBytes)
  t.is((frames[frames.length - 1][18] << 8) | frames[frames.length - 1][19], expectedTotal)

  let idCalls = 0
  expectCode(
    t,
    () =>
      fragment(b4a.alloc(MAX_MESSAGE_BYTES + 1), {
        randomBytes() {
          idCalls++
          return id(37)
        }
      }),
    'INVALID_ROUTE'
  )
  t.is(idCalls, 0)
})

test('four authenticated fragments reassemble only after every index arrives', (t) => {
  const message = b4a.alloc(3 * MAX_FRAGMENT_DATA + 7, 0x5a)
  const frames = fragment(message, { messageId: id(1) })
  const receiver = reassembler()

  t.is(frames.length, 4)
  t.is(frames[0].byteLength, 20 + MAX_FRAGMENT_DATA)
  t.is(receiver.pushAuthenticated(frames[2]), null)
  t.is(receiver.pushAuthenticated(frames[0]), null)
  t.is(receiver.pushAuthenticated(frames[3]), null)
  t.alike(receiver.pushAuthenticated(frames[1]), message)
  t.alike(receiver.stats, {
    destroyed: false,
    messages: 0,
    bufferedBytes: 0,
    completedIds: 1
  })
})

test('fragment copies message and identifier and supports the empty message', (t) => {
  const message = b4a.from('copy me')
  const messageId = id(2)
  const frames = fragment(message, { messageId })
  message.fill(0)
  messageId.fill(0)

  t.alike(reassembler().pushAuthenticated(frames[0]), b4a.from('copy me'))
  const empty = fragment(b4a.alloc(0), { messageId: id(3) })
  t.is(empty.length, 1)
  t.is(empty[0].byteLength, 20)
  t.alike(reassembler().pushAuthenticated(empty[0]), b4a.alloc(0))
})

test('fragment slicing never dispatches through buffer instance methods', (t) => {
  let instanceSlices = 0
  const hostileSlice = () => {
    instanceSlices++
    throw new Error('instance subarray must not run')
  }
  const message = b4a.alloc(MAX_FRAGMENT_DATA + 1, 0x4a)
  Object.defineProperty(message, 'subarray', { value: hostileSlice })
  const frames = fragment(message, { messageId: id(39) })
  for (const value of frames) Object.defineProperty(value, 'subarray', { value: hostileSlice })

  const receiver = reassembler()
  t.is(receiver.pushAuthenticated(frames[0]), null)
  t.alike(receiver.pushAuthenticated(frames[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 0x4a))
  t.is(instanceSlices, 0)
})

test('fragment ignores a shadowed byteLength and never emits allocator tail bytes', (t) => {
  const message = b4a.from([0x6a])
  Object.defineProperty(message, 'byteLength', { value: MAX_FRAGMENT_DATA })
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = originalAlloc(size)
    value.fill(0xd7)
    return value
  }
  let frames
  try {
    frames = fragment(message, { messageId: id(44) })
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.is(frames.length, 1)
  t.is(frames[0].byteLength, 21)
  t.is(frames[0][20], 0x6a)
  t.alike(reassembler().pushAuthenticated(frames[0]), b4a.from([0x6a]))
})

test('fragment failure clears earlier frames and the current partial allocation', (t) => {
  const message = b4a.alloc(MAX_FRAGMENT_DATA + 1, 0x5a)
  const originalAlloc = b4a.allocUnsafeSlow
  const allocations = []
  let calls = 0
  b4a.allocUnsafeSlow = (size) => {
    calls++
    if (calls === 2) throw new Error('second frame allocation failed')
    const value = originalAlloc(size)
    value.fill(0xaa)
    allocations.push(value)
    return value
  }
  try {
    expectCode(t, () => fragment(message, { messageId: id(40) }), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
  t.is(allocations.length, 1)
  t.alike(allocations[0], b4a.alloc(allocations[0].byteLength))

  calls = 0
  allocations.length = 0
  b4a.allocUnsafeSlow = (size) => {
    calls++
    const value = originalAlloc(calls === 2 ? size - 1 : size)
    value.fill(0xbb)
    allocations.push(value)
    return value
  }
  try {
    expectCode(t, () => fragment(message, { messageId: id(41) }), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
  t.is(allocations.length, 2)
  for (const value of allocations) t.alike(value, b4a.alloc(value.byteLength))

  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  b4a.allocUnsafeSlow = () => {
    throw revoked.proxy
  }
  try {
    expectCode(t, () => fragment(message, { messageId: id(43) }), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }
})

test('malformed fragment arithmetic is rejected before allocation', (t) => {
  let allocations = 0
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER]() {
      allocations++
    }
  })
  const tooMany = Math.ceil(MAX_MESSAGE_BYTES / MAX_FRAGMENT_DATA) + 1
  const cases = [
    b4a.alloc(19),
    frame(id(4), 0, 0),
    frame(id(5), 2, 2),
    frame(id(6), 0, tooMany, b4a.alloc(MAX_FRAGMENT_DATA)),
    frame(id(7), 0, 2, b4a.alloc(MAX_FRAGMENT_DATA - 1)),
    b4a.alloc(20 + MAX_FRAGMENT_DATA + 1)
  ]

  for (const value of cases) expectCode(t, () => receiver.pushAuthenticated(value), 'INVALID_ROUTE')
  t.is(allocations, 0)
  t.is(receiver.stats.messages, 0)
})

test('oversized and noncanonical empty-last fragments clean only their message', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  receiver.pushAuthenticated(frame(id(30), 0, 2, b4a.alloc(MAX_FRAGMENT_DATA, 1)))
  const oversized = frame(id(30), 1, 2, b4a.alloc(MAX_FRAGMENT_DATA + 1, 2))
  expectCode(t, () => receiver.pushAuthenticated(oversized), 'INVALID_ROUTE')
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)

  receiver.pushAuthenticated(frame(id(31), 0, 2, b4a.alloc(MAX_FRAGMENT_DATA, 3)))
  expectCode(t, () => receiver.pushAuthenticated(frame(id(31), 1, 2)), 'INVALID_ROUTE')
  t.alike(owned[1], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
})

test('an inconsistent total destroys and zeroes only the affected message', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const good = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 1), { messageId: id(8) })
  const other = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 2), { messageId: id(9) })
  receiver.pushAuthenticated(good[0])
  receiver.pushAuthenticated(other[0])

  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(id(8), 1, 3, b4a.from('x'))),
    'INVALID_ROUTE'
  )
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 1)
  t.alike(receiver.pushAuthenticated(other[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 2))
})

test('inconsistent total cleanup precedes configured per-message limits', (t) => {
  const owned = []
  const receiver = reassembler({
    maxMessageBytes: MAX_FRAGMENT_DATA + 1,
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  receiver.pushAuthenticated(frame(id(26), 0, 2, b4a.alloc(MAX_FRAGMENT_DATA, 1)))

  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(id(26), 1, 3, b4a.alloc(MAX_FRAGMENT_DATA, 2))),
    'INVALID_ROUTE'
  )
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
})

test('identical in-progress duplicates are replay without damaging state', (t) => {
  const message = b4a.alloc(MAX_FRAGMENT_DATA + 1, 3)
  const frames = fragment(message, { messageId: id(10) })
  const receiver = reassembler()
  receiver.pushAuthenticated(frames[0])

  expectCode(t, () => receiver.pushAuthenticated(b4a.from(frames[0])), 'REPLAY')
  t.is(receiver.stats.messages, 1)
  t.alike(receiver.pushAuthenticated(frames[1]), message)
})

test('a conflicting duplicate destroys that message and zeroes its fragments', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const frames = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 4), { messageId: id(11) })
  receiver.pushAuthenticated(frames[0])
  const conflicting = b4a.from(frames[0])
  conflicting[20] ^= 1

  expectCode(t, () => receiver.pushAuthenticated(conflicting), 'INVALID_ROUTE')
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
})

test('completed identifiers are sticky and every fresh-counter reuse is replay', (t) => {
  const receiver = reassembler()
  const complete = fragment(b4a.from('done'), { messageId: id(12) })[0]
  t.alike(receiver.pushAuthenticated(complete), b4a.from('done'))

  expectCode(t, () => receiver.pushAuthenticated(b4a.from(complete)), 'REPLAY')
  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(id(12), 0, 1, b4a.from('different'))),
    'REPLAY'
  )
  t.alike(receiver.stats, {
    destroyed: false,
    messages: 0,
    bufferedBytes: 0,
    completedIds: 1
  })
})

test('short fragment headers clean active IDs without erasing completed tombstones', (t) => {
  for (let length = 16; length < 20; length++) {
    const activeId = id(50 + length)
    const completedId = id(60 + length)
    const otherId = id(70 + length)
    const owned = []
    const receiver = reassembler({
      [TEST_ONLY_FRAGMENT_OBSERVER](value) {
        owned.push(value)
      }
    })
    const active = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 1), { messageId: activeId })
    const other = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 2), { messageId: otherId })
    const completed = fragment(b4a.from('done'), { messageId: completedId })[0]
    receiver.pushAuthenticated(active[0])
    receiver.pushAuthenticated(other[0])
    t.alike(receiver.pushAuthenticated(completed), b4a.from('done'))

    const malformedActive = b4a.alloc(length)
    malformedActive.set(activeId)
    expectCode(t, () => receiver.pushAuthenticated(malformedActive), 'INVALID_ROUTE')
    t.alike(owned[0], b4a.alloc(owned[0].byteLength))
    t.is(receiver.stats.messages, 1)
    t.is(receiver.stats.completedIds, 1)

    const malformedCompleted = b4a.alloc(length)
    malformedCompleted.set(completedId)
    expectCode(t, () => receiver.pushAuthenticated(malformedCompleted), 'INVALID_ROUTE')
    t.is(receiver.stats.completedIds, 1)
    expectCode(t, () => receiver.pushAuthenticated(completed), 'REPLAY')
    t.alike(receiver.pushAuthenticated(other[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 2))
  }
})

test('concurrent limit rejects a new message and preserves existing messages', (t) => {
  const receiver = reassembler({ maxMessages: 2 })
  const a = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 1), { messageId: id(13) })
  const b = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 2), { messageId: id(14) })
  const c = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 3), { messageId: id(15) })
  receiver.pushAuthenticated(a[0])
  receiver.pushAuthenticated(b[0])

  expectCode(t, () => receiver.pushAuthenticated(c[0]), 'CIRCUIT_LIMIT')
  t.is(receiver.stats.messages, 2)
  t.alike(receiver.pushAuthenticated(a[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 1))
  t.alike(receiver.pushAuthenticated(b[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 2))
})

test('global byte limit rejects new data and preserves existing fragments', (t) => {
  const receiver = reassembler({ maxBufferedBytes: MAX_FRAGMENT_DATA + 1 })
  const a = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 5), { messageId: id(16) })
  const b = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 6), { messageId: id(17) })
  receiver.pushAuthenticated(a[0])

  expectCode(t, () => receiver.pushAuthenticated(b[0]), 'CIRCUIT_LIMIT')
  t.is(receiver.stats.messages, 1)
  t.is(receiver.stats.bufferedBytes, MAX_FRAGMENT_DATA)
  t.alike(receiver.pushAuthenticated(a[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 5))
})

test('per-message overflow zeroes only the affected message', (t) => {
  const owned = []
  const receiver = reassembler({
    maxMessageBytes: MAX_FRAGMENT_DATA + 1,
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const first = frame(id(18), 0, 2, b4a.alloc(MAX_FRAGMENT_DATA, 7))
  const other = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 8), { messageId: id(38) })
  receiver.pushAuthenticated(first)
  receiver.pushAuthenticated(other[0])

  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(id(18), 1, 2, b4a.alloc(2, 7))),
    'CIRCUIT_LIMIT'
  )
  t.is(receiver.stats.messages, 1)
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.alike(receiver.pushAuthenticated(other[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 8))
})

test('completed-ID capacity never evicts early and rejects new IDs', (t) => {
  const receiver = reassembler()
  for (let i = 0; i < MAX_COMPLETED_IDS; i++) {
    const messageId = b4a.alloc(16)
    messageId[14] = i >>> 8
    messageId[15] = i
    receiver.pushAuthenticated(frame(messageId, 0, 1, b4a.from('x')))
  }

  t.is(receiver.stats.completedIds, MAX_COMPLETED_IDS)
  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(b4a.alloc(16, 0xff), 0, 1, b4a.from('y'))),
    'CIRCUIT_LIMIT'
  )
  t.is(receiver.stats.completedIds, MAX_COMPLETED_IDS)
  expectCode(t, () => receiver.pushAuthenticated(frame(b4a.alloc(16), 0, 1)), 'REPLAY')
})

test('concurrent completions cannot exceed completed-ID capacity', (t) => {
  const receiver = reassembler({ maxCompletedIds: 2 })
  receiver.pushAuthenticated(fragment(b4a.from('tombstone'), { messageId: id(27) })[0])
  const a = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 3), { messageId: id(28) })
  const b = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 4), { messageId: id(29) })
  receiver.pushAuthenticated(a[0])
  receiver.pushAuthenticated(b[0])
  t.alike(receiver.pushAuthenticated(a[1]), b4a.alloc(MAX_FRAGMENT_DATA + 1, 3))

  expectCode(t, () => receiver.pushAuthenticated(b[1]), 'CIRCUIT_LIMIT')
  t.is(receiver.stats.completedIds, 2)
  t.is(receiver.stats.messages, 0)
  expectCode(
    t,
    () => receiver.pushAuthenticated(fragment(b4a.from('tombstone'), { messageId: id(27) })[0]),
    'REPLAY'
  )
  expectCode(t, () => receiver.pushAuthenticated(a[1]), 'REPLAY')
})

test('timeout removes and zeroes only expired in-progress messages', (t) => {
  let now = 10
  const owned = []
  const receiver = reassembler({
    now: () => now,
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const a = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 8), { messageId: id(20) })
  receiver.pushAuthenticated(a[0])
  now += MESSAGE_TIMEOUT - 1
  t.is(receiver.expire(), 0)
  now++
  t.is(receiver.expire(), 1)
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
})

test('epoch expiry clears state and tombstones then closes reassembly', (t) => {
  let now = 0
  const owned = []
  const receiver = reassembler({
    now: () => now,
    epochExpiresAt: 100,
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  receiver.pushAuthenticated(fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1), { messageId: id(21) })[0])
  receiver.pushAuthenticated(fragment(b4a.from('done'), { messageId: id(22) })[0])
  now = 100

  expectCode(t, () => receiver.expire(), 'CIRCUIT_STATE')
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.alike(receiver.stats, {
    destroyed: true,
    messages: 0,
    bufferedBytes: 0,
    completedIds: 0
  })
  expectCode(
    t,
    () => receiver.pushAuthenticated(fragment(b4a.from('later'), { messageId: id(23) })[0]),
    'CIRCUIT_STATE'
  )
})

test('destroy is idempotent and zeroes every owned fragment', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  receiver.pushAuthenticated(
    fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 9), { messageId: id(24) })[0]
  )
  receiver.destroy()
  receiver.destroy()

  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.destroyed, true)
  expectCode(t, () => receiver.pushAuthenticated(frame(id(24), 1, 2)), 'CIRCUIT_STATE')
})

test('reentrant destroy from an observer fails closed without resurrecting state', (t) => {
  let receiver = null
  receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER]() {
      receiver.destroy()
    }
  })

  expectCode(
    t,
    () =>
      receiver.pushAuthenticated(
        fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1), { messageId: id(32) })[0]
      ),
    'INVALID_ROUTE'
  )
  t.alike(receiver.stats, {
    destroyed: true,
    messages: 0,
    bufferedBytes: 0,
    completedIds: 0
  })
})

test('reentrant destroy from the clock fails closed before parsing input', (t) => {
  let receiver = null
  receiver = reassembler({
    now() {
      receiver.destroy()
      return 0
    }
  })

  expectCode(
    t,
    () => receiver.pushAuthenticated(frame(id(33), 0, 1, b4a.from('never parsed'))),
    'INVALID_ROUTE'
  )
  t.is(receiver.stats.destroyed, true)
  t.is(receiver.stats.messages, 0)
})

test('copy failure zeroes all prior parts of only the affected message', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const frames = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 6), { messageId: id(34) })
  receiver.pushAuthenticated(frames[0])
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    if (size === 1) throw new Error('copy failed')
    return originalAlloc(size)
  }
  try {
    expectCode(t, () => receiver.pushAuthenticated(frames[1]), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
  t.is(receiver.stats.bufferedBytes, 0)
})

test('partial fragment copy allocation is cleared before the message is removed', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const frames = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 2, 8), { messageId: id(42) })
  receiver.pushAuthenticated(frames[0])
  const originalAlloc = b4a.allocUnsafeSlow
  let partial = null
  b4a.allocUnsafeSlow = (size) => {
    if (size === 2) {
      partial = originalAlloc(1)
      partial.fill(0xcc)
      return partial
    }
    return originalAlloc(size)
  }
  try {
    expectCode(t, () => receiver.pushAuthenticated(frames[1]), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.ok(partial)
  t.alike(partial, b4a.alloc(1))
  t.alike(owned[0], b4a.alloc(MAX_FRAGMENT_DATA))
  t.is(receiver.stats.messages, 0)
  t.is(receiver.stats.bufferedBytes, 0)
})

test('completion allocation failure zeroes every accepted part', (t) => {
  const owned = []
  const receiver = reassembler({
    [TEST_ONLY_FRAGMENT_OBSERVER](value) {
      owned.push(value)
    }
  })
  const frames = fragment(b4a.alloc(MAX_FRAGMENT_DATA + 1, 7), { messageId: id(35) })
  receiver.pushAuthenticated(frames[0])
  const originalAlloc = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    if (size === MAX_FRAGMENT_DATA + 1) throw new Error('assembly failed')
    return originalAlloc(size)
  }
  try {
    expectCode(t, () => receiver.pushAuthenticated(frames[1]), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = originalAlloc
  }

  t.is(owned.length, 2)
  for (const value of owned) t.alike(value, b4a.alloc(value.byteLength))
  t.is(receiver.stats.messages, 0)
  t.is(receiver.stats.bufferedBytes, 0)
})

test('hostile fragment and option inputs normalize to stable errors', (t) => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const value of [null, [], revoked.proxy]) {
    expectCode(t, () => fragment(value, { messageId: id(25) }), 'INVALID_ROUTE')
    expectCode(t, () => new Reassembler(value), 'INVALID_ROUTE')
  }
  expectCode(t, () => fragment(b4a.from('x'), revoked.proxy), 'INVALID_ROUTE')
  expectCode(t, () => reassembler().pushAuthenticated(revoked.proxy), 'INVALID_ROUTE')
})
