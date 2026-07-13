import test from 'brittle'
import b4a from 'b4a'

import {
  CELL_CLASS,
  CellCodec,
  DIRECTION,
  DatagramReplayWindow,
  DOMAIN,
  OrderedReceiver,
  SenderCounter,
  cryptoSuite
} from '../index.js'
import {
  AEAD_TAG_BYTES,
  CELL_BODY_SIZE,
  CELL_HEADER_SIZE,
  CELL_SIZE,
  MAX_CELL_PAYLOAD
} from '../lib/cell-codec.js'
import { expectCode, seed } from './helpers.js'

const KEY = b4a.from('3976601ef753f92f19e4d544d6a80526635bd8af0dd09efd18e224493d44fb04', 'hex')
const NONCE_PREFIX = b4a.from('a4300237c95a17d6b7b5c1eb5d0bf837', 'hex')
const CIRCUIT_ID = b4a.alloc(16, 0x11)

function zeroPadding(size) {
  return b4a.alloc(size)
}

function codec(overrides = {}) {
  return new CellCodec({
    crypto: cryptoSuite,
    cellSize: CELL_SIZE,
    padding: zeroPadding,
    ...overrides
  })
}

function sealOptions(overrides = {}) {
  return {
    key: KEY,
    noncePrefix: NONCE_PREFIX,
    senderCounter: new SenderCounter({ initial: 3n }),
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.FORWARD,
    epoch: 8n,
    circuitId: CIRCUIT_ID,
    payload: b4a.from('hello'),
    ...overrides
  }
}

function orderedSpy() {
  return {
    calls: [],
    pushAuthenticated(counter, payload) {
      this.calls.push({ counter, payload })
      return payload
    }
  }
}

function datagramSpy() {
  return {
    calls: [],
    acceptAuthenticated(counter) {
      this.calls.push(counter)
      return true
    }
  }
}

function openOptions(receiver, overrides = {}) {
  return {
    key: KEY,
    noncePrefix: NONCE_PREFIX,
    receiver,
    expectedClass: CELL_CLASS.STREAM,
    expectedDirection: DIRECTION.FORWARD,
    expectedEpoch: 8n,
    expectedCircuitId: CIRCUIT_ID,
    ...overrides
  }
}

test('cell layout constants lock the 1200-byte experimental format', (t) => {
  t.is(CELL_SIZE, 1200)
  t.is(CELL_HEADER_SIZE, 36)
  t.is(CELL_BODY_SIZE, 1148)
  t.is(MAX_CELL_PAYLOAD, 1146)
  t.is(AEAD_TAG_BYTES, 16)
  t.is(CELL_HEADER_SIZE + CELL_BODY_SIZE + AEAD_TAG_BYTES, CELL_SIZE)
})

test('cell round trip preserves payload and hides its length on wire', (t) => {
  const cell = codec()
  const receiver = orderedSpy()
  const sealed = cell.seal(sealOptions())
  const opened = cell.open(openOptions(receiver), sealed)

  t.is(sealed.byteLength, 1200)
  t.alike(opened, b4a.from('hello'))
  t.is(sealed.indexOf(b4a.from('hello')), -1)
  t.is(receiver.calls.length, 1)
  t.is(receiver.calls[0].counter, 3n)
})

test('cell header and known-answer hash match the normative vector', (t) => {
  const sealed = codec().seal(sealOptions())

  t.is(
    b4a.toString(sealed.subarray(0, CELL_HEADER_SIZE), 'hex'),
    '000100000000000000000008111111111111111111111111111111110000000000000003'
  )
  t.is(
    b4a.toString(cryptoSuite.hash(sealed), 'hex'),
    '85cef0e1ccb809ab4a305568aa6a7ee9cd570289353be0a6f554de4287857e27'
  )
})

test('seal obtains and advances its counter only through senderCounter.next', (t) => {
  const senderCounter = new SenderCounter({ initial: 9n })
  const sealed = codec().seal(sealOptions({ senderCounter, counter: 99n }))

  t.is(b4a.toString(sealed.subarray(28, 36), 'hex'), '0000000000000009')
  t.is(senderCounter.value, 10n)

  const receiver = orderedSpy()
  codec().open(openOptions(receiver), sealed)
  t.is(receiver.calls[0].counter, 9n)
})

test('ordered and datagram cells consult only their post-authentication receiver method', (t) => {
  const cell = codec()
  const ordered = orderedSpy()
  const stream = cell.seal(sealOptions())
  t.alike(cell.open(openOptions(ordered), stream), b4a.from('hello'))
  t.is(ordered.calls.length, 1)

  const datagram = datagramSpy()
  const packet = cell.seal(
    sealOptions({
      senderCounter: new SenderCounter(),
      class: CELL_CLASS.DATAGRAM,
      payload: b4a.from('unreliable')
    })
  )
  t.alike(
    cell.open(
      openOptions(datagram, {
        expectedClass: CELL_CLASS.DATAGRAM
      }),
      packet
    ),
    b4a.from('unreliable')
  )
  t.alike(datagram.calls, [0n])
})

test('ordered receiver delivery results preserve bounded reordering semantics', (t) => {
  const cell = codec()
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  const later = cell.seal(
    sealOptions({ senderCounter: new SenderCounter({ initial: 1n }), payload: b4a.from('b') })
  )
  const first = cell.seal(
    sealOptions({ senderCounter: new SenderCounter({ initial: 0n }), payload: b4a.from('a') })
  )

  t.alike(cell.open(openOptions(receiver), later), [])
  t.alike(cell.open(openOptions(receiver), first), [b4a.from('a'), b4a.from('b')])
})

test('ordered buffering clears the codec-owned payload after receiver ownership transfer', (t) => {
  let codecPayload = null
  const receiver = {
    pushAuthenticated(counter, payload) {
      t.is(counter, 3n)
      codecPayload = payload
      return []
    }
  }
  const result = codec().open(openOptions(receiver), codec().seal(sealOptions()))

  t.alike(result, [])
  t.alike(codecPayload, b4a.alloc(5))
})

test('datagram receiver enforces replay only after successful authentication', (t) => {
  const cell = codec()
  const receiver = new DatagramReplayWindow({ window: 8 })
  const packet = cell.seal(
    sealOptions({ senderCounter: new SenderCounter(), class: CELL_CLASS.DATAGRAM })
  )
  const options = openOptions(receiver, { expectedClass: CELL_CLASS.DATAGRAM })

  t.alike(cell.open(options, packet), b4a.from('hello'))
  expectCode(t, () => cell.open(options, packet), 'REPLAY')
})

test('maximum payload round trips and one-byte overflow does not advance sender', (t) => {
  const cell = codec()
  const payload = b4a.alloc(MAX_CELL_PAYLOAD, 0x5a)
  const senderCounter = new SenderCounter()
  const packet = cell.seal(
    sealOptions({
      senderCounter,
      class: CELL_CLASS.DATAGRAM,
      payload
    })
  )
  const receiver = datagramSpy()

  t.alike(cell.open(openOptions(receiver, { expectedClass: CELL_CLASS.DATAGRAM }), packet), payload)
  t.is(senderCounter.value, 1n)

  const unchanged = new SenderCounter()
  expectCode(
    t,
    () => cell.seal(sealOptions({ senderCounter: unchanged, payload: b4a.alloc(1147) })),
    'CELL_INVALID'
  )
  t.is(unchanged.value, 0n)
})

test('deterministic padding injection fills only the hidden body tail', (t) => {
  const calls = []
  const cell = codec({
    padding(size) {
      calls.push(size)
      return b4a.alloc(size, 0xa5)
    }
  })
  const packet = cell.seal(sealOptions({ payload: b4a.from('pad') }))
  const header = packet.subarray(0, CELL_HEADER_SIZE)
  const plaintext = cryptoSuite.open({
    key: KEY,
    noncePrefix: NONCE_PREFIX,
    counter: 3n,
    associatedData: b4a.concat([DOMAIN.CELL_HEADER, header]),
    ciphertext: packet.subarray(CELL_HEADER_SIZE)
  })

  t.alike(calls, [MAX_CELL_PAYLOAD - 3])
  t.is(plaintext[0], 0)
  t.is(plaintext[1], 3)
  t.alike(plaintext.subarray(2, 5), b4a.from('pad'))
  t.alike(plaintext.subarray(5), b4a.alloc(MAX_CELL_PAYLOAD - 3, 0xa5))
  plaintext.fill(0)
})

test('every public header field is validated or authenticated', (t) => {
  const cell = codec()
  const packet = cell.seal(sealOptions())
  const cases = [
    { offset: 0, value: 1, options: {} },
    { offset: 1, value: CELL_CLASS.DATAGRAM, options: { expectedClass: CELL_CLASS.DATAGRAM } },
    { offset: 2, value: DIRECTION.REVERSE, options: { expectedDirection: DIRECTION.REVERSE } },
    { offset: 3, value: 1, options: {} },
    { offset: 11, value: 9, options: { expectedEpoch: 9n } },
    {
      offset: 12,
      value: 0x22,
      options: { expectedCircuitId: b4a.concat([b4a.from([0x22]), CIRCUIT_ID.subarray(1)]) }
    },
    { offset: 35, value: 2, options: {} }
  ]

  for (const { offset, value, options } of cases) {
    const mutated = b4a.from(packet)
    mutated[offset] = value
    const receiver = options.expectedClass === CELL_CLASS.DATAGRAM ? datagramSpy() : orderedSpy()
    expectCode(t, () => cell.open(openOptions(receiver, options), mutated), 'CELL_INVALID')
    t.is(receiver.calls.length, 0)
  }
})

test('wrong key, nonce, class, direction, epoch, and circuit fail before receiver state', (t) => {
  const cell = codec()
  const packet = cell.seal(sealOptions())
  const cases = [
    { key: seed(4) },
    { noncePrefix: b4a.alloc(16, 0x44) },
    { expectedClass: CELL_CLASS.CONTROL },
    { expectedDirection: DIRECTION.REVERSE },
    { expectedEpoch: 9n },
    { expectedCircuitId: b4a.alloc(16, 0x22) }
  ]

  for (const overrides of cases) {
    const receiver = orderedSpy()
    expectCode(t, () => cell.open(openOptions(receiver, overrides), packet), 'CELL_INVALID')
    t.is(receiver.calls.length, 0)
  }
})

test('mutated ciphertext and header never advance a real receiver', (t) => {
  const cell = codec()
  const packet = cell.seal(
    sealOptions({ senderCounter: new SenderCounter(), class: CELL_CLASS.DATAGRAM })
  )
  const receiver = new DatagramReplayWindow({ window: 8 })
  const options = openOptions(receiver, { expectedClass: CELL_CLASS.DATAGRAM })

  const headerMutation = b4a.from(packet)
  headerMutation[28] ^= 1
  expectCode(t, () => cell.open(options, headerMutation), 'CELL_INVALID')
  t.is(receiver.highest, null)
  t.is(receiver.buffered, 0)

  const cipherMutation = b4a.from(packet)
  cipherMutation[CELL_HEADER_SIZE + 10] ^= 1
  expectCode(t, () => cell.open(options, cipherMutation), 'CELL_INVALID')
  t.is(receiver.highest, null)
  t.is(receiver.buffered, 0)

  t.alike(cell.open(options, packet), b4a.from('hello'))
  t.is(receiver.highest, 0n)
})

test('packet size and public structure reject cheaply before crypto or allocation', (t) => {
  let opens = 0
  const crypto = {
    ...cryptoSuite,
    open() {
      opens++
      throw new Error('must not decrypt')
    }
  }
  const cell = codec({ crypto })
  const valid = codec().seal(sealOptions())
  const malformed = [valid.subarray(0, 1199), b4a.concat([valid, b4a.from([0])])]

  for (const packet of malformed) {
    expectCode(t, () => cell.open(openOptions(orderedSpy()), packet), 'CELL_INVALID')
  }

  for (const [offset, value] of [
    [0, 1],
    [1, 3],
    [2, 2],
    [3, 1]
  ]) {
    const packet = b4a.from(valid)
    packet[offset] = value
    expectCode(t, () => cell.open(openOptions(orderedSpy()), packet), 'CELL_INVALID')
  }

  t.is(opens, 0)
})

test('malformed authenticated bodies are rejected before receiver calls and cleared', (t) => {
  let scratch = null
  const crypto = {
    ...cryptoSuite,
    open() {
      scratch = b4a.alloc(CELL_BODY_SIZE, 0x7a)
      scratch[0] = 0x04
      scratch[1] = 0x7b
      return scratch
    }
  }
  const receiver = orderedSpy()
  const packet = codec().seal(sealOptions())

  expectCode(t, () => codec({ crypto }).open(openOptions(receiver), packet), 'CELL_INVALID')
  t.is(receiver.calls.length, 0)
  t.alike(scratch, b4a.alloc(CELL_BODY_SIZE))
})

test('open returns caller-owned payload and clears temporary authenticated plaintext', (t) => {
  let scratch = null
  const crypto = {
    ...cryptoSuite,
    open(options) {
      scratch = cryptoSuite.open(options)
      return scratch
    }
  }
  const cell = codec({ crypto })
  const receiver = orderedSpy()
  const packet = codec().seal(sealOptions())
  const payload = cell.open(openOptions(receiver), packet)

  t.alike(payload, b4a.from('hello'))
  t.alike(scratch, b4a.alloc(CELL_BODY_SIZE))
  t.ok(payload.buffer !== scratch.buffer)
  payload.fill(0)
  t.alike(receiver.calls[0].payload, b4a.alloc(5))
})

test('constructor, seal, and open reject malformed inputs with stable cell errors', (t) => {
  for (const options of [
    null,
    {},
    { crypto: cryptoSuite, cellSize: 1199 },
    { crypto: {}, cellSize: 1200 }
  ]) {
    expectCode(t, () => new CellCodec(options), 'CELL_INVALID')
  }

  const cell = codec()
  const valid = sealOptions()
  const invalidSeal = [
    null,
    { ...valid, key: b4a.alloc(31) },
    { ...valid, noncePrefix: b4a.alloc(15) },
    { ...valid, senderCounter: null },
    { ...valid, class: 3 },
    { ...valid, direction: 2 },
    { ...valid, epoch: 8 },
    { ...valid, epoch: -1n },
    { ...valid, circuitId: b4a.alloc(15) },
    { ...valid, payload: 'hello' }
  ]
  for (const options of invalidSeal) {
    expectCode(t, () => cell.seal(options), 'CELL_INVALID')
  }

  const invalidCounter = { next: () => 3 }
  expectCode(t, () => cell.seal(sealOptions({ senderCounter: invalidCounter })), 'CELL_INVALID')

  const packet = cell.seal(sealOptions())
  const invalidOpen = [
    null,
    { ...openOptions(orderedSpy()), key: b4a.alloc(31) },
    { ...openOptions(orderedSpy()), noncePrefix: b4a.alloc(15) },
    { ...openOptions(null) },
    { ...openOptions(orderedSpy()), expectedClass: 3 },
    { ...openOptions(orderedSpy()), expectedDirection: 2 },
    { ...openOptions(orderedSpy()), expectedEpoch: 8 },
    { ...openOptions(orderedSpy()), expectedEpoch: -1n },
    { ...openOptions(orderedSpy()), expectedCircuitId: b4a.alloc(15) }
  ]
  for (const options of invalidOpen) {
    expectCode(t, () => cell.open(options, packet), 'CELL_INVALID')
  }
  expectCode(t, () => cell.open(openOptions(orderedSpy()), 'packet'), 'CELL_INVALID')
})

test('crypto and padding failures are normalized without leaking implementation errors', (t) => {
  const sentinel = new TypeError('secret crypto detail')
  const throwingCrypto = {
    ...cryptoSuite,
    seal() {
      throw sentinel
    },
    open() {
      throw sentinel
    }
  }
  const failingPadding = codec({
    padding() {
      throw sentinel
    }
  })

  expectCode(t, () => codec({ crypto: throwingCrypto }).seal(sealOptions()), 'CELL_INVALID')
  expectCode(
    t,
    () => codec({ crypto: throwingCrypto }).open(openOptions(orderedSpy()), b4a.alloc(1200)),
    'CELL_INVALID'
  )
  expectCode(t, () => failingPadding.seal(sealOptions()), 'CELL_INVALID')

  const wrongPadding = codec({ padding: () => b4a.alloc(1) })
  expectCode(t, () => wrongPadding.seal(sealOptions()), 'CELL_INVALID')
})

test('padding failure preserves sender while post-reservation crypto failure consumes it', (t) => {
  const sentinel = new Error('failure')
  const paddingSender = new SenderCounter()
  const badPaddingSender = new SenderCounter()
  const cryptoSender = new SenderCounter()

  expectCode(
    t,
    () =>
      codec({
        padding() {
          throw sentinel
        }
      }).seal(sealOptions({ senderCounter: paddingSender })),
    'CELL_INVALID'
  )
  expectCode(
    t,
    () =>
      codec({ padding: () => b4a.alloc(1) }).seal(sealOptions({ senderCounter: badPaddingSender })),
    'CELL_INVALID'
  )
  expectCode(
    t,
    () =>
      codec({
        crypto: {
          ...cryptoSuite,
          seal() {
            throw sentinel
          }
        }
      }).seal(sealOptions({ senderCounter: cryptoSender })),
    'CELL_INVALID'
  )

  t.is(paddingSender.value, 0n)
  t.is(badPaddingSender.value, 0n)
  t.is(cryptoSender.value, 1n)
})

test('hostile and revoked inputs cannot escape stable cell errors', (t) => {
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
  const cell = codec()
  const packet = cell.seal(sealOptions())

  for (const value of [hostile, revocable.proxy]) {
    expectCode(t, () => new CellCodec(value), 'CELL_INVALID')
    expectCode(t, () => cell.seal(value), 'CELL_INVALID')
    expectCode(t, () => cell.open(value, packet), 'CELL_INVALID')
    expectCode(t, () => cell.seal(sealOptions({ payload: value })), 'CELL_INVALID')
  }

  const hostileCryptoOutput = codec({
    crypto: {
      ...cryptoSuite,
      seal: () => hostile,
      open: () => hostile
    }
  })
  expectCode(t, () => hostileCryptoOutput.seal(sealOptions()), 'CELL_INVALID')
  expectCode(t, () => hostileCryptoOutput.open(openOptions(orderedSpy()), packet), 'CELL_INVALID')
  expectCode(t, () => codec({ padding: () => hostile }).seal(sealOptions()), 'CELL_INVALID')
})
