import test from 'brittle'
import b4a from 'b4a'

import {
  MAX_ROUTED_OBJECT_BYTES,
  RoutedCoreReassembler,
  encodeRoutedCoreObjects
} from '../lib/core-fragment.js'
import { CONTEXT_CLASS, M3_MESSAGE_ID, decodeM3Object, encodeM3Object } from '../lib/protocol.js'

function object(byte, bodyBytes = 3_000) {
  return encodeM3Object({
    messageId: M3_MESSAGE_ID.ROUTED_REPLY_V1,
    body: b4a.alloc(bodyBytes, byte)
  })
}

function expectCode(t, operation, code) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code)
}

test('routed core fragments accept identical duplicates without extending semantics', (t) => {
  const encoded = object(0x11)
  const fragments = encodeRoutedCoreObjects(encoded)
  const reassembler = new RoutedCoreReassembler({ now: () => 1_000n })
  t.is(reassembler.accept(fragments[0], CONTEXT_CLASS.ROUTE_PAYLOAD), null)
  t.is(reassembler.accept(fragments[0], CONTEXT_CLASS.ROUTE_PAYLOAD), null)
  let complete = null
  for (let index = 1; index < fragments.length; index++) {
    complete = reassembler.accept(fragments[index], CONTEXT_CLASS.ROUTE_PAYLOAD)
  }
  t.alike(complete, encoded)
  t.ok(reassembler.destroy())
  t.absent(reassembler.destroy())
})

test('routed core fragments reject sparse, conflicting, nested, and cross-context input', (t) => {
  const fragments = encodeRoutedCoreObjects(object(0x21))
  const sparse = new RoutedCoreReassembler({ now: () => 1_000n })
  expectCode(t, () => sparse.accept(fragments[1], CONTEXT_CLASS.ROUTE_PAYLOAD), 'INVALID_ROUTE')
  sparse.destroy()

  const conflict = new RoutedCoreReassembler({ now: () => 1_000n })
  t.is(conflict.accept(fragments[0], CONTEXT_CLASS.ROUTE_PAYLOAD), null)
  const decoded = decodeM3Object(fragments[0])
  decoded.body[decoded.body.byteLength - 1] ^= 1
  const conflicting = encodeM3Object({
    messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1,
    body: decoded.body
  })
  expectCode(t, () => conflict.accept(conflicting, CONTEXT_CLASS.ROUTE_PAYLOAD), 'INVALID_ROUTE')
  conflict.destroy()

  const crossed = new RoutedCoreReassembler({ now: () => 1_000n })
  t.is(crossed.accept(fragments[0], CONTEXT_CLASS.ROUTE_PAYLOAD), null)
  expectCode(
    t,
    () => crossed.accept(fragments[1], CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED),
    'INVALID_ROUTE'
  )
  crossed.destroy()

  const nested = encodeM3Object({
    messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1,
    body: b4a.alloc(100)
  })
  expectCode(t, () => encodeRoutedCoreObjects(nested), 'INVALID_ROUTE')
})

test('routed fragment reservations cap at four concurrent objects', (t) => {
  const reassembler = new RoutedCoreReassembler({ now: () => 1_000n })
  for (let index = 0; index < 4; index++) {
    const fragments = encodeRoutedCoreObjects(object(0x30 + index, 8_000))
    t.is(reassembler.accept(fragments[0], CONTEXT_CLASS.ROUTE_PAYLOAD), null)
  }
  const fifth = encodeRoutedCoreObjects(object(0x40, 8_000))
  expectCode(t, () => reassembler.accept(fifth[0], CONTEXT_CLASS.ROUTE_PAYLOAD), 'INVALID_ROUTE')
  reassembler.destroy()
})

test('routed fragment encoder preserves registered object bounds below its global cap', (t) => {
  t.is(MAX_ROUTED_OBJECT_BYTES, 12_288)
  const maximumReply = object(0x51, 8_262)
  t.is(maximumReply.byteLength, 8_270)
  t.is(encodeRoutedCoreObjects(maximumReply).length, 9)
  expectCode(t, () => object(0x52, 8_263), 'INVALID_ROUTE')
})
