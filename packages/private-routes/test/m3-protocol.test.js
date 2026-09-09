import test from 'brittle'
import b4a from 'b4a'

import {
  BRANCH_CLASS,
  CAPACITY_CLASS,
  CONTEXT_CLASS,
  DESTINATION_VALIDATION_CLASS,
  M3_ID_REGISTRY,
  M3_LINK_ROLE,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  MUTATION_FLAG,
  RELAY_CAPABILITY,
  ROUTED_ERROR,
  decodeM3Object,
  encodeM3Object
} from '../index.js'
import { expectCode } from './helpers.js'

function forgedByteLength(value, byteLength) {
  Object.defineProperty(value, 'byteLength', { value: byteLength })
  return value
}

function overriddenSubarray(value) {
  value.subarray = () => b4a.alloc(0)
  return value
}

test('M3 protocol version and owner-approved core enums are exact and frozen', (t) => {
  t.is(M3_PROTOCOL_VERSION, 1)
  t.alike(BRANCH_CLASS, { LOOKUP: 0, ANNOUNCE: 1 })
  t.alike(CONTEXT_CLASS, {
    TAIL_CONTROL_ORDERED: 0,
    TAIL_FINALIZE_DATAGRAM: 1,
    FINAL_EXIT_FINALIZE_DATAGRAM: 2,
    ROUTE_PAYLOAD: 3,
    TERMINAL_CONTROL_ORDERED: 4
  })
  t.alike(RELAY_CAPABILITY, {
    CIRCUIT_RELAY_V1: 1,
    DHT_EXIT_V1: 2,
    PRIVATE_RECORDS_V1: 4
  })

  t.ok(Object.isFrozen(BRANCH_CLASS))
  t.ok(Object.isFrozen(CONTEXT_CLASS))
  t.ok(Object.isFrozen(RELAY_CAPABILITY))
})

test('all M3 enums are exact, closed, and frozen', (t) => {
  const expected = [
    [M3_LINK_ROLE, { CLIENT: 0, SAFETY_RELAY: 1, DHT_EXIT: 2 }],
    [CAPACITY_CLASS, { SMALL: 0, MEDIUM: 1, LARGE: 2 }],
    [MUTATION_FLAG, { READ_ONLY: 0, MUTATING: 1 }],
    [
      DESTINATION_VALIDATION_CLASS,
      { EXIT_LOCAL: 0, DHT_NODE_HANDLE: 1, SIGNED_CAPABILITY_HANDLE: 2 }
    ]
  ]

  for (const [actual, value] of expected) {
    t.alike(actual, value)
    t.ok(Object.isFrozen(actual))
  }
})

test('M3 message, command, and routed-error IDs form the exact 58-ID registry', (t) => {
  const messages = {
    CAPABILITY_ADVERTISEMENT_V1: 0x0001,
    CAPS_QUERY_V1: 0x0002,
    CAPS_RESPONSE_V1: 0x0003,
    ACTIVE_CHALLENGE_V1: 0x0004,
    ACTIVE_CHALLENGE_RESPONSE_V1: 0x0005,
    RELAY_DISCOVER_V1: 0x0006,
    RELAY_DISCOVER_RESPONSE_V1: 0x0007,
    CORE_FRAGMENT_V1: 0x0008,
    CAPS_COOKIE_CHALLENGE_V1: 0x0009,
    LINK_OFFER_V1: 0x0020,
    LINK_ACCEPT_V1: 0x0021,
    REDACTED_RESPONDER_PROOF_V1: 0x0022,
    EXTENDED_V1: 0x0023,
    TAIL_READY_V1: 0x0024,
    EXTEND_REQUEST_V1: 0x0025,
    DHT_EXIT_ACTIVATE_V1: 0x0040,
    DHT_EXIT_READY_V1: 0x0041,
    DHT_EXIT_READY_ACK_V1: 0x0042,
    DHT_EXIT_OPEN_V1: 0x0043,
    DHT_EXIT_SEEDS_V1: 0x0044,
    EXIT_RPC_OPEN_V1: 0x0050,
    EXIT_RPC_ACCEPT_V1: 0x0051,
    EXIT_RPC_FRAGMENT_V1: 0x0052,
    EXIT_RPC_REQUEST_V1: 0x0053,
    EXIT_RPC_RESPONSE_V1: 0x0054,
    DESTINATION_REF_V1: 0x0100,
    ROUTED_REQUEST_V1: 0x0101,
    ROUTED_REPLY_V1: 0x0102,
    IMMUTABLE_GET_V1: 0x0120,
    IMMUTABLE_PUT_V1: 0x0121,
    MUTABLE_GET_V1: 0x0122,
    MUTABLE_PUT_V1: 0x0123,
    PRIVATE_FIND_NODE_V1: 0x0200,
    PRIVATE_FIND_NODE_RESPONSE_V1: 0x0201,
    PRIVATE_PRESENCE_RECORD_V1: 0x0280,
    PRIVATE_TOMBSTONE_V1: 0x0281,
    PRIVATE_LOOKUP_RESPONSE_V1: 0x0282,
    PRIVATE_WRITE_TOKEN_V1: 0x0283,
    PRIVATE_WRITE_RECEIPT_V1: 0x0284,
    PRIVATE_LOOKUP_V1: 0x02a0,
    PRIVATE_PREPARE_V1: 0x02a1,
    PRIVATE_ANNOUNCE_V1: 0x02a2,
    PRIVATE_UNANNOUNCE_V1: 0x02a3
  }
  const errors = {
    MALFORMED: 0x0180,
    UNSUPPORTED_COMMAND: 0x0181,
    POLICY_MISMATCH: 0x0182,
    DESTINATION_INVALID: 0x0183,
    DESTINATION_EXPIRED: 0x0184,
    DEADLINE_EXPIRED: 0x0185,
    BUSY: 0x0186,
    RESPONSE_TOO_LARGE: 0x0187,
    AMPLIFICATION_EXCEEDED: 0x0188,
    UPSTREAM_TIMEOUT: 0x0189,
    UPSTREAM_REJECTED: 0x018a,
    TOKEN_INVALID: 0x018b,
    STORAGE_UNAVAILABLE: 0x018c,
    RECORD_CONFLICT: 0x018d,
    QUOTA_EXCEEDED: 0x018e
  }

  t.alike(M3_MESSAGE_ID, messages)
  t.alike(ROUTED_ERROR, errors)
  t.ok(Object.isFrozen(M3_MESSAGE_ID))
  t.ok(Object.isFrozen(ROUTED_ERROR))

  const assigned = [...Object.values(M3_MESSAGE_ID), ...Object.values(ROUTED_ERROR)]
  t.is(assigned.length, 58)
  t.is(new Set(assigned).size, 58)
  t.alike(
    M3_ID_REGISTRY,
    assigned.slice().sort((left, right) => left - right)
  )
  t.ok(Object.isFrozen(M3_ID_REGISTRY))
})

test('canonical M3 object envelope round trips unsigned and signed objects without aliases', (t) => {
  const body = b4a.alloc(105, 0x42)
  const unsigned = encodeM3Object({ messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1, body })
  const expectedHeader = b4a.from('0000000100420069', 'hex')

  t.alike(unsigned.subarray(0, 8), expectedHeader)
  t.is(unsigned.byteLength, 113)

  const decodedUnsigned = decodeM3Object(unsigned)
  t.is(decodedUnsigned.protocolVersion, 1)
  t.is(decodedUnsigned.messageId, M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1)
  t.alike(decodedUnsigned.body, body)
  t.is(decodedUnsigned.authSuffix.byteLength, 0)

  const signedBody = b4a.alloc(233, 0x51)
  const signature = b4a.alloc(64, 0x52)
  const signed = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
    body: signedBody,
    authSuffix: signature
  })
  const decodedSigned = decodeM3Object(signed)
  t.alike(decodedSigned.body, signedBody)
  t.alike(decodedSigned.authSuffix, signature)

  unsigned.fill(0)
  signed.fill(0)
  body.fill(0)
  signedBody.fill(0)
  signature.fill(0)
  t.alike(decodedUnsigned.body, b4a.alloc(105, 0x42))
  t.alike(decodedSigned.body, b4a.alloc(233, 0x51))
  t.alike(decodedSigned.authSuffix, b4a.alloc(64, 0x52))
})

test('canonical M3 object envelope recognizes every standalone ID with exact minimum auth', (t) => {
  const fixtures = [
    [0x0001, 188, 64],
    [0x0002, 110, 0],
    [0x0003, 335, 64],
    [0x0004, 176, 0],
    [0x0005, 272, 64],
    [0x0006, 69, 0],
    [0x0007, 41, 0],
    [0x0008, 48, 0],
    [0x0009, 72, 0],
    [0x0020, 302, 64],
    [0x0021, 213, 64],
    [0x0022, 306, 64],
    [0x0023, 486, 0],
    [0x0024, 210, 64],
    [0x0025, 458, 0],
    [0x0040, 96, 0],
    [0x0041, 233, 64],
    [0x0042, 105, 0],
    [0x0043, 169, 0],
    [0x0044, 905, 64],
    [0x0050, 578, 64],
    [0x0051, 124, 16],
    [0x0052, 27, 16],
    [0x0053, 30, 0],
    [0x0054, 20, 0],
    [0x0100, 164, 0],
    [0x0101, 221, 0],
    [0x0102, 200, 0],
    [0x0201, 141, 64],
    [0x0280, 132, 64],
    [0x0281, 131, 64],
    [0x0282, 206, 64],
    [0x0283, 72, 0],
    [0x0284, 301, 64]
  ]

  for (const [messageId, bodyBytes, authBytes] of fixtures) {
    const encoded = encodeM3Object({
      messageId,
      body: b4a.alloc(bodyBytes),
      authSuffix: b4a.alloc(authBytes)
    })
    const decoded = decodeM3Object(encoded)
    t.is(decoded.messageId, messageId)
    t.is(decoded.body.byteLength, bodyBytes)
    t.is(decoded.authSuffix.byteLength, authBytes)
  }
})

test('canonical M3 object envelope rejects IDs, auth, body lengths, overflow, and trailing bytes', (t) => {
  expectCode(t, () => encodeM3Object({ messageId: 0, body: b4a.alloc(0) }), 'INVALID_ROUTE')
  expectCode(t, () => encodeM3Object({ messageId: 0x0060, body: b4a.alloc(0) }), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.IMMUTABLE_GET_V1,
        body: b4a.alloc(32)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
        body: forgedByteLength(b4a.alloc(104), 105)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => encodeM3Object({ messageId: ROUTED_ERROR.BUSY, body: b4a.alloc(0) }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
        body: b4a.alloc(233),
        authSuffix: b4a.alloc(63)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
        body: b4a.alloc(104)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1,
        body: b4a.alloc(65_536)
      }),
    'INVALID_ROUTE'
  )

  const valid = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
    body: b4a.alloc(105)
  })
  const wrongVersion = b4a.from(valid)
  wrongVersion[3] = 2
  expectCode(t, () => decodeM3Object(wrongVersion), 'INVALID_ROUTE')

  const wrongBodyLength = b4a.from(valid)
  wrongBodyLength[7] = 104
  expectCode(t, () => decodeM3Object(wrongBodyLength), 'INVALID_ROUTE')
  expectCode(t, () => decodeM3Object(valid.subarray(0, valid.byteLength - 1)), 'INVALID_ROUTE')
  expectCode(t, () => decodeM3Object(b4a.concat([valid, b4a.from([0])])), 'INVALID_ROUTE')
})

test('canonical M3 object envelope rejects hostile objects and non-buffer views', (t) => {
  const sentinel = new Error('hostile getter')
  const hostile = {}
  Object.defineProperty(hostile, 'messageId', {
    get() {
      throw sentinel
    }
  })

  expectCode(t, () => encodeM3Object(hostile), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
        body: new Uint16Array(105)
      }),
    'INVALID_ROUTE'
  )
  expectCode(t, () => decodeM3Object(new Uint16Array(113)), 'INVALID_ROUTE')
})

test('canonical M3 object envelope uses intrinsic buffer extents', (t) => {
  const valid = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
    body: b4a.alloc(105)
  })

  expectCode(
    t,
    () => decodeM3Object(forgedByteLength(b4a.concat([valid, b4a.alloc(1)]), valid.byteLength)),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () => decodeM3Object(forgedByteLength(b4a.from(valid.subarray(0, -1)), valid.byteLength)),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
        body: forgedByteLength(b4a.alloc(106), 105)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
        body: b4a.alloc(233),
        authSuffix: forgedByteLength(b4a.alloc(63), 64)
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      encodeM3Object({
        messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
        body: b4a.alloc(233),
        authSuffix: forgedByteLength(b4a.alloc(65), 64)
      }),
    'INVALID_ROUTE'
  )
  t.alike(decodeM3Object(overriddenSubarray(b4a.from(valid))).body, b4a.alloc(105))
})
