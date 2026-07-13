import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { PrivateRouteError } from './errors.js'

export const PROTOCOL_VERSION = 0

export const ROLE = Object.freeze({
  SAFETY: 0,
  PRIVATE: 1
})

export const CELL_CLASS = Object.freeze({
  CONTROL: 0,
  STREAM: 1,
  DATAGRAM: 2
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

export const DOMAIN = Object.freeze({
  ROLE: b4a.from('hyperdht-private-routes/role/v0'),
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

export function roleForIdentity(publicKey) {
  if (!b4a.isBuffer(publicKey) || publicKey.byteLength !== 32) {
    throw PrivateRouteError.INVALID_IDENTITY()
  }

  return crypto.hash([DOMAIN.ROLE, publicKey])[0] & 1
}
