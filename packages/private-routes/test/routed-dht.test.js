import test from 'brittle'
import b4a from 'b4a'

import {
  DESTINATION_REF_SIZE,
  clearRoutedRequest,
  decodeDestinationRef,
  decodeRoutedRequest,
  encodeDestinationRef,
  encodeRoutedRequest,
  validateRoutedRequestForExit
} from '../lib/routed-dht.js'
import { BRANCH_CLASS, M3_MESSAGE_ID } from '../lib/protocol.js'

function seed(byte, size) {
  return b4a.alloc(size, byte)
}

function destination() {
  return { id: seed(0x11, 32), handle: seed(0x12, 130) }
}

function request(overrides = {}) {
  return encodeRoutedRequest({
    requestId: seed(0x21, 16),
    operationClass: BRANCH_CLASS.LOOKUP,
    commandId: M3_MESSAGE_ID.IMMUTABLE_GET_V1,
    absoluteDeadlineMs: 4_000n,
    destination: destination(),
    encodedBody: seed(0x22, 32),
    ...overrides
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

test('DESTINATION_REF_V1 is an exact opaque 172-byte object', (t) => {
  const value = destination()
  const encoded = encodeDestinationRef(value)
  t.is(encoded.byteLength, DESTINATION_REF_SIZE)
  t.alike(decodeDestinationRef(encoded), value)
  t.is(encoded.readUInt16BE(8 + 32), 130)
  expectCode(
    t,
    () => encodeDestinationRef({ id: value.id, handle: seed(0x13, 129) }),
    'INVALID_ROUTE'
  )
})

test('ROUTED_REQUEST_V1 binds the immutable exit policy and destination bytes', (t) => {
  const encoded = request()
  const decoded = decodeRoutedRequest(encoded)
  t.is(encoded.byteLength, 261)
  t.alike(decoded.requestId, seed(0x21, 16))
  t.is(decoded.commandId, M3_MESSAGE_ID.IMMUTABLE_GET_V1)
  t.is(decoded.commandVersion, 1)
  t.is(decoded.maxResponseBytes, 4706)
  t.is(decoded.maxAmplificationBytes, 4445)
  t.is(decoded.requestCost, 1)
  t.is(decoded.responseCost, 2)
  t.alike(decoded.destination, destination())
  t.alike(decoded.destinationEncoded, encodeDestinationRef(destination()))
  t.alike(decoded.encodedBody, seed(0x22, 32))
  clearRoutedRequest(decoded)

  const tampered = b4a.from(encoded)
  tampered[8 + 23] ^= 1
  expectCode(t, () => decodeRoutedRequest(tampered), 'ERR_AUTHENTICATION')
})

test('exit request validation enforces branch, deadline, and handle authority before IO', (t) => {
  const encoded = request()
  let verified = 0
  const decoded = validateRoutedRequestForExit(encoded, {
    now: () => 1_000n,
    branchClass: BRANCH_CLASS.LOOKUP,
    verifyDestination({ destination: ref, commandId }) {
      verified++
      t.alike(ref, destination())
      t.is(commandId, M3_MESSAGE_ID.IMMUTABLE_GET_V1)
      return true
    }
  })
  t.is(verified, 1)
  clearRoutedRequest(decoded)

  expectCode(
    t,
    () =>
      validateRoutedRequestForExit(encoded, {
        now: () => 1_000n,
        branchClass: BRANCH_CLASS.ANNOUNCE,
        verifyDestination: () => t.fail('must reject before handle verification')
      }),
    'ERR_AUTHENTICATION'
  )
  expectCode(
    t,
    () =>
      validateRoutedRequestForExit(encoded, {
        now: () => 4_001n,
        branchClass: BRANCH_CLASS.LOOKUP,
        verifyDestination: () => t.fail('must reject an expired deadline first')
      }),
    'ERR_AUTHENTICATION'
  )
})

test('command body and operation class cannot negotiate beyond policy', (t) => {
  expectCode(
    t,
    () =>
      request({
        commandId: M3_MESSAGE_ID.IMMUTABLE_PUT_V1,
        encodedBody: seed(0x31, 67)
      }),
    'ERR_AUTHENTICATION'
  )
  expectCode(t, () => request({ encodedBody: seed(0x32, 31) }), 'INVALID_ROUTE')
  expectCode(t, () => request({ encodedBody: seed(0x33, 33) }), 'INVALID_ROUTE')
})
