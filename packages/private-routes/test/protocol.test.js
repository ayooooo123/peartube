import test from 'brittle'
import b4a from 'b4a'

import {
  BOOTSTRAP_REJECT_CODE,
  BOOTSTRAP_TYPE,
  CAPABILITY,
  CELL_CLASS,
  CIRCUIT_STATE,
  DIRECTION,
  DOMAIN,
  ERROR_CODES,
  PrivateRouteError,
  PROTOCOL_VERSION,
  ROLE,
  roleForIdentity
} from '../index.js'

test('roleForIdentity deterministically assigns a binary role', (t) => {
  const identity = b4a.alloc(32, 7)

  t.is(roleForIdentity(identity), ROLE.PRIVATE)
  t.is(roleForIdentity(identity), roleForIdentity(identity))
  t.ok([ROLE.SAFETY, ROLE.PRIVATE].includes(roleForIdentity(identity)))

  let error = null
  try {
    roleForIdentity(b4a.alloc(31))
  } catch (err) {
    error = err
  }

  t.ok(error instanceof PrivateRouteError)
  t.is(error.code, 'INVALID_IDENTITY')
})

test('roleForIdentity rejects every invalid identity shape', (t) => {
  const invalid = [null, 'identity', b4a.alloc(0), b4a.alloc(31), b4a.alloc(33)]

  for (const identity of invalid) {
    let error = null
    try {
      roleForIdentity(identity)
    } catch (err) {
      error = err
    }

    t.ok(error instanceof PrivateRouteError)
    t.is(error.code, 'INVALID_IDENTITY')
  }
})

test('protocol enumerations are exact and frozen', (t) => {
  const expected = [
    [BOOTSTRAP_TYPE, { LINK_CREATE: 0, LINK_CREATED: 1, LINK_REJECT: 2, LINK_CANCEL: 3 }],
    [BOOTSTRAP_REJECT_CODE, { UNAUTHORIZED: 0, CIRCUIT_LIMIT: 1, ROUTE_UNAVAILABLE: 2 }],
    [ROLE, { SAFETY: 0, PRIVATE: 1 }],
    [CELL_CLASS, { CONTROL: 0, STREAM: 1, DATAGRAM: 2 }],
    [DIRECTION, { FORWARD: 0, REVERSE: 1 }],
    [CIRCUIT_STATE, { CREATE: 0, CREATED: 1, OPEN: 2, DRAINING: 3, DESTROYED: 4 }],
    [CAPABILITY, { FORWARD: 1, DATAGRAM: 2, STREAM: 4, KNOWN: 7 }]
  ]

  for (const [actual, value] of expected) {
    t.alike(actual, value)
    t.ok(Object.isFrozen(actual))
  }
})

test('protocol domains are exact buffers in a frozen map', (t) => {
  const expected = {
    ROLE: 'hyperdht-private-routes/role/v0',
    UDX_BOOTSTRAP: 'hyperdht-private-routes/udx-bootstrap/v0',
    TOPOLOGY_GRANT: 'hyperdht-private-routes/topology-grant/v0',
    RELAY_ADVERTISEMENT: 'hyperdht-private-routes/relay-advertisement/v0',
    DESCRIPTOR_DIRECT: 'hyperdht-private-routes/descriptor/direct/v0',
    DELEGATION: 'hyperdht-private-routes/delegation/v0',
    DESCRIPTOR_DELEGATED: 'hyperdht-private-routes/descriptor/delegated/v0',
    KDF_FORWARD_KEY: 'hyperdht-private-routes/kdf/v0/forward-key',
    KDF_REVERSE_KEY: 'hyperdht-private-routes/kdf/v0/reverse-key',
    KDF_FORWARD_NONCE: 'hyperdht-private-routes/kdf/v0/forward-nonce',
    KDF_REVERSE_NONCE: 'hyperdht-private-routes/kdf/v0/reverse-nonce',
    LINK_CREATE: 'hyperdht-private-routes/link/create/v0',
    LINK_CREATED: 'hyperdht-private-routes/link/created/v0',
    TEMPLATE_REGISTER: 'hyperdht-private-routes/template/register/v0',
    TEMPLATE_REGISTERED: 'hyperdht-private-routes/template/registered/v0',
    ACTIVATE_CREATE: 'hyperdht-private-routes/activate/create/v0',
    ACTIVATE_ENTRY_PROOF: 'hyperdht-private-routes/activate/entry-proof/v0',
    ACTIVATE_DESTINATION_PROOF: 'hyperdht-private-routes/activate/destination-proof/v0',
    ACTIVATE_CHALLENGE: 'hyperdht-private-routes/activate/challenge/v0',
    ACTIVATE_PARAMETERS: 'hyperdht-private-routes/activate/parameters/v0',
    CELL_HEADER: 'hyperdht-private-routes/cell/header/v0',
    ROUTE_PAYLOAD: 'hyperdht-private-routes/route-payload/v0'
  }

  t.alike(Object.keys(DOMAIN), Object.keys(expected))
  t.ok(Object.isFrozen(DOMAIN))

  for (const [name, value] of Object.entries(expected)) {
    t.ok(b4a.isBuffer(DOMAIN[name]))
    t.is(b4a.toString(DOMAIN[name]), value)
  }
})

test('protocol domains return defensive copies', (t) => {
  const role = DOMAIN.ROLE
  role.fill(0)

  t.is(b4a.toString(DOMAIN.ROLE), 'hyperdht-private-routes/role/v0')
  t.is(roleForIdentity(b4a.alloc(32, 7)), ROLE.PRIVATE)

  const cellHeader = DOMAIN.CELL_HEADER
  cellHeader.fill(0xff)

  t.is(b4a.toString(DOMAIN.CELL_HEADER), 'hyperdht-private-routes/cell/header/v0')
})

test('private route error codes and constructors are exact and sanitized', (t) => {
  const expected = [
    'INVALID_IDENTITY',
    'INVALID_KEY',
    'INVALID_ROLE',
    'INVALID_ROUTE',
    'INVALID_DESCRIPTOR',
    'UNAUTHORIZED',
    'REPLAY',
    'COUNTER_INVALID',
    'COUNTER_GAP',
    'COUNTER_EXHAUSTED',
    'CELL_INVALID',
    'CIRCUIT_LIMIT',
    'CIRCUIT_STATE',
    'ROUTE_UNAVAILABLE',
    'VIRTUAL_LIMIT'
  ]

  t.alike(ERROR_CODES, expected)
  t.ok(Object.isFrozen(ERROR_CODES))

  for (const code of expected) {
    t.is(typeof PrivateRouteError[code], 'function')

    const error = PrivateRouteError[code]()
    t.ok(error instanceof PrivateRouteError)
    t.is(error.name, 'PrivateRouteError')
    t.is(error.code, code)
    t.ok(error.message.length > 0)
    t.absent(/[a-f0-9]{32,}/i.test(error.message))
    t.absent(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(error.message))
  }
})

test('private route error constructor rejects unknown codes and ignores messages', (t) => {
  const sensitive = 'secret 0123456789abcdef0123456789abcdef at 192.168.100.200'

  let unknownCodeError = null
  try {
    new PrivateRouteError('BOGUS', sensitive)
  } catch (err) {
    unknownCodeError = err
  }

  t.ok(unknownCodeError instanceof TypeError)

  const error = new PrivateRouteError('INVALID_KEY', sensitive)
  t.is(error.code, 'INVALID_KEY')
  t.is(error.message, PrivateRouteError.INVALID_KEY().message)
  t.absent(error.message.includes(sensitive))
  t.absent(/[a-f0-9]{32,}/i.test(error.message))
  t.absent(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(error.message))
})

test('protocol version is version zero', (t) => {
  t.is(PROTOCOL_VERSION, 0)
})
