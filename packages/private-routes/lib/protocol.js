import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { PrivateRouteError } from './errors.js'

export const PROTOCOL_VERSION = 0
export const M3_PROTOCOL_VERSION = 1

export const BRANCH_CLASS = Object.freeze({ LOOKUP: 0, ANNOUNCE: 1 })

export const M3_LINK_ROLE = Object.freeze({ CLIENT: 0, SAFETY_RELAY: 1, DHT_EXIT: 2 })

export const RELAY_CAPABILITY = Object.freeze({
  CIRCUIT_RELAY_V1: 1,
  DHT_EXIT_V1: 2,
  PRIVATE_RECORDS_V1: 4
})

export const CAPACITY_CLASS = Object.freeze({ SMALL: 0, MEDIUM: 1, LARGE: 2 })

export const MUTATION_FLAG = Object.freeze({ READ_ONLY: 0, MUTATING: 1 })

export const DESTINATION_VALIDATION_CLASS = Object.freeze({
  EXIT_LOCAL: 0,
  DHT_NODE_HANDLE: 1,
  SIGNED_CAPABILITY_HANDLE: 2
})

export const CONTEXT_CLASS = Object.freeze({
  TAIL_CONTROL_ORDERED: 0,
  TAIL_FINALIZE_DATAGRAM: 1,
  FINAL_EXIT_FINALIZE_DATAGRAM: 2,
  ROUTE_PAYLOAD: 3,
  TERMINAL_CONTROL_ORDERED: 4
})

export const M3_MESSAGE_ID = Object.freeze({
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
})

export const ROUTED_ERROR = Object.freeze({
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
})

export const M3_ID_REGISTRY = Object.freeze(
  [...Object.values(M3_MESSAGE_ID), ...Object.values(ROUTED_ERROR)].sort(
    (left, right) => left - right
  )
)

export const ROLE = Object.freeze({
  SAFETY: 0,
  PRIVATE: 1
})

export const TOPOLOGY_ROLE = Object.freeze({
  SOURCE: 0,
  SAFETY_GUARD: 1,
  SAFETY_FINAL: 2,
  PRIVATE_ENTRY: 3,
  PRIVATE_MIDDLE: 4,
  PRIVATE_FINAL: 5,
  DESTINATION: 6
})

export const LINK_OPERATION = Object.freeze({
  INITIATE: 1,
  ACCEPT: 2,
  KNOWN: 3
})

export const CELL_CLASS = Object.freeze({
  CONTROL: 0,
  STREAM: 1,
  DATAGRAM: 2
})

export const BOOTSTRAP_TYPE = Object.freeze({
  LINK_CREATE: 0,
  LINK_CREATED: 1,
  LINK_REJECT: 2,
  LINK_CANCEL: 3
})

export const BOOTSTRAP_REJECT_CODE = Object.freeze({
  UNAUTHORIZED: 0,
  CIRCUIT_LIMIT: 1,
  ROUTE_UNAVAILABLE: 2
})

export const DIRECTION = Object.freeze({
  FORWARD: 0,
  REVERSE: 1
})

export const CIRCUIT_STATE = Object.freeze({
  CREATE: 0,
  CREATED: 1,
  OPEN: 2,
  DRAINING: 3,
  DESTROYED: 4
})

export const CAPABILITY = Object.freeze({
  FORWARD: 1,
  DATAGRAM: 2,
  STREAM: 4,
  KNOWN: 7
})

const DOMAIN_VALUES = Object.freeze({
  ROLE: b4a.from('hyperdht-private-routes/role/v0'),
  UDX_BOOTSTRAP: b4a.from('hyperdht-private-routes/udx-bootstrap/v0'),
  TOPOLOGY_GRANT: b4a.from('hyperdht-private-routes/topology-grant/v0'),
  RELAY_ADVERTISEMENT: b4a.from('hyperdht-private-routes/relay-advertisement/v0'),
  DESCRIPTOR_DIRECT: b4a.from('hyperdht-private-routes/descriptor/direct/v0'),
  DELEGATION: b4a.from('hyperdht-private-routes/delegation/v0'),
  DESCRIPTOR_DELEGATED: b4a.from('hyperdht-private-routes/descriptor/delegated/v0'),
  KDF_FORWARD_KEY: b4a.from('hyperdht-private-routes/kdf/v0/forward-key'),
  KDF_REVERSE_KEY: b4a.from('hyperdht-private-routes/kdf/v0/reverse-key'),
  KDF_FORWARD_NONCE: b4a.from('hyperdht-private-routes/kdf/v0/forward-nonce'),
  KDF_REVERSE_NONCE: b4a.from('hyperdht-private-routes/kdf/v0/reverse-nonce'),
  LINK_CREATE: b4a.from('hyperdht-private-routes/link/create/v0'),
  LINK_CREATED: b4a.from('hyperdht-private-routes/link/created/v0'),
  TEMPLATE_REGISTER: b4a.from('hyperdht-private-routes/template/register/v0'),
  TEMPLATE_REGISTERED: b4a.from('hyperdht-private-routes/template/registered/v0'),
  ACTIVATE_CREATE: b4a.from('hyperdht-private-routes/activate/create/v0'),
  ACTIVATE_ENTRY_PROOF: b4a.from('hyperdht-private-routes/activate/entry-proof/v0'),
  ACTIVATE_DESTINATION_PROOF: b4a.from('hyperdht-private-routes/activate/destination-proof/v0'),
  ACTIVATE_CHALLENGE: b4a.from('hyperdht-private-routes/activate/challenge/v0'),
  ACTIVATE_PARAMETERS: b4a.from('hyperdht-private-routes/activate/parameters/v0'),
  CELL_HEADER: b4a.from('hyperdht-private-routes/cell/header/v0'),
  ROUTE_PAYLOAD: b4a.from('hyperdht-private-routes/route-payload/v0')
})

const domainProperties = {}
for (const [name, value] of Object.entries(DOMAIN_VALUES)) {
  domainProperties[name] = {
    enumerable: true,
    get() {
      return b4a.from(value)
    }
  }
}

export const DOMAIN = Object.freeze(Object.defineProperties({}, domainProperties))

export function roleForIdentity(publicKey) {
  if (!b4a.isBuffer(publicKey) || publicKey.byteLength !== 32) {
    throw PrivateRouteError.INVALID_IDENTITY()
  }

  return crypto.hash([DOMAIN_VALUES.ROLE, publicKey])[0] & 1
}

const M3_OBJECT_LAYOUT = new Map([
  [0x0001, [188, 476, 64]],
  [0x0002, [110, 110, 0]],
  [0x0003, [335, 4473, 64]],
  [0x0004, [176, 176, 0]],
  [0x0005, [272, 272, 64]],
  [0x0006, [69, 69, 0]],
  [0x0007, [41, 4441, 0]],
  [0x0008, [48, 1192, 0]],
  [0x0009, [72, 72, 0]],
  [0x0020, [302, 302, 64]],
  [0x0021, [213, 213, 64]],
  [0x0022, [306, 306, 64]],
  [0x0023, [486, 486, 0]],
  [0x0024, [210, 210, 64]],
  [0x0025, [458, 746, 0]],
  [0x0040, [96, 96, 0]],
  [0x0041, [233, 233, 64]],
  [0x0042, [105, 105, 0]],
  [0x0043, [169, 169, 0]],
  [0x0044, [905, 4265, 64]],
  [0x0050, [578, 738, 64]],
  [0x0051, [124, 124, 16]],
  [0x0052, [27, 1176, 16]],
  [0x0053, [30, 1191, 0]],
  [0x0054, [20, 8082, 0]],
  [0x0100, [164, 164, 0]],
  [0x0101, [221, 1382, 0]],
  [0x0102, [200, 8262, 0]],
  [0x0201, [141, 2891, 64]],
  [0x0280, [132, 899, 64]],
  [0x0281, [131, 131, 64]],
  [0x0282, [206, 7990, 64]],
  [0x0283, [72, 72, 0]],
  [0x0284, [301, 301, 64]]
])

const bufferByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const bufferSet = Uint8Array.prototype.set
const bufferSubarray = Uint8Array.prototype.subarray

function invalidM3Object() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function m3BufferLength(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function m3Set(target, source, offset = 0) {
  try {
    bufferSet.call(target, source, offset)
  } catch {
    invalidM3Object()
  }
}

function m3Subarray(value, start, end) {
  try {
    return bufferSubarray.call(value, start, end)
  } catch {
    invalidM3Object()
  }
}

function m3Copy(value) {
  const length = m3BufferLength(value)
  if (length < 0) invalidM3Object()
  const output = b4a.allocUnsafeSlow(length)
  m3Set(output, value)
  return output
}

function m3ObjectOptions(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidM3Object()
    return {
      messageId: value.messageId,
      body: value.body,
      authSuffix: value.authSuffix === undefined ? b4a.alloc(0) : value.authSuffix
    }
  } catch {
    invalidM3Object()
  }
}

function m3ObjectLayout(messageId) {
  if (!Number.isSafeInteger(messageId)) invalidM3Object()
  const layout = M3_OBJECT_LAYOUT.get(messageId)
  if (layout === undefined) invalidM3Object()
  return layout
}

function writeM3Uint16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeM3Uint32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function readM3Uint16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1]
}

function readM3Uint32(buffer, offset) {
  return (
    buffer[offset] * 0x1000000 +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
  )
}

export function encodeM3Object(value) {
  const { messageId, body, authSuffix } = m3ObjectOptions(value)
  const [minimumBodyBytes, maximumBodyBytes, authBytes] = m3ObjectLayout(messageId)
  const bodyBytes = m3BufferLength(body)
  const actualAuthBytes = m3BufferLength(authSuffix)

  if (
    bodyBytes < minimumBodyBytes ||
    bodyBytes > maximumBodyBytes ||
    bodyBytes > 0xffff ||
    actualAuthBytes !== authBytes
  ) {
    invalidM3Object()
  }

  const output = b4a.allocUnsafe(8 + bodyBytes + authBytes)
  writeM3Uint32(output, M3_PROTOCOL_VERSION, 0)
  writeM3Uint16(output, messageId, 4)
  writeM3Uint16(output, bodyBytes, 6)
  m3Set(output, body, 8)
  m3Set(output, authSuffix, 8 + bodyBytes)
  return output
}

export function decodeM3Object(encoded) {
  try {
    const encodedBytes = m3BufferLength(encoded)
    if (encodedBytes < 8) invalidM3Object()
    if (readM3Uint32(encoded, 0) !== M3_PROTOCOL_VERSION) invalidM3Object()

    const messageId = readM3Uint16(encoded, 4)
    const bodyBytes = readM3Uint16(encoded, 6)
    const [minimumBodyBytes, maximumBodyBytes, authBytes] = m3ObjectLayout(messageId)

    if (
      bodyBytes < minimumBodyBytes ||
      bodyBytes > maximumBodyBytes ||
      encodedBytes !== 8 + bodyBytes + authBytes
    ) {
      invalidM3Object()
    }

    return {
      protocolVersion: M3_PROTOCOL_VERSION,
      messageId,
      body: m3Copy(m3Subarray(encoded, 8, 8 + bodyBytes)),
      authSuffix: m3Copy(m3Subarray(encoded, 8 + bodyBytes, encodedBytes))
    }
  } catch (err) {
    if (err instanceof PrivateRouteError && err.code === 'INVALID_ROUTE') throw err
    invalidM3Object()
  }
}
