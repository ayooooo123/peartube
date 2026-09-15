export const ERROR_CODES = Object.freeze([
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
])

export const M3_ERROR_CODES = Object.freeze([
  'ERR_PRIVACY_UNAVAILABLE',
  'ERR_PRIVATE_BRANCH_ROTATING',
  'ERR_INCOMPATIBLE_RELAY',
  'ERR_AUTHENTICATION',
  'ERR_REPLAY',
  'ERR_BUSY',
  'ERR_QUOTA_EXCEEDED',
  'ERR_PRIVATE_RECORDS_UNAVAILABLE',
  'ERR_DESTROYED'
])

const ALL_ERROR_CODES = new Set([...ERROR_CODES, ...M3_ERROR_CODES])

const MESSAGES = Object.freeze({
  INVALID_IDENTITY: 'Identity must be a 32-byte buffer',
  INVALID_KEY: 'Key is invalid',
  INVALID_ROLE: 'Role is invalid',
  INVALID_ROUTE: 'Route is invalid',
  INVALID_DESCRIPTOR: 'Descriptor is invalid',
  UNAUTHORIZED: 'Operation is unauthorized',
  REPLAY: 'Replay was detected',
  COUNTER_INVALID: 'Counter is invalid',
  COUNTER_GAP: 'Counter sequence contains a gap',
  COUNTER_EXHAUSTED: 'Counter is exhausted',
  CELL_INVALID: 'Cell is invalid',
  CIRCUIT_LIMIT: 'Circuit limit was reached',
  CIRCUIT_STATE: 'Circuit state is invalid',
  ROUTE_UNAVAILABLE: 'Route is unavailable',
  VIRTUAL_LIMIT: 'Virtual endpoint limit was reached',
  ERR_PRIVACY_UNAVAILABLE: 'Private routing is unavailable',
  ERR_PRIVATE_BRANCH_ROTATING: 'Private branch is rotating',
  ERR_INCOMPATIBLE_RELAY: 'Relay is incompatible',
  ERR_AUTHENTICATION: 'Authentication failed',
  ERR_REPLAY: 'Replay was detected',
  ERR_BUSY: 'Private routing is busy',
  ERR_QUOTA_EXCEEDED: 'Private routing quota was exceeded',
  ERR_PRIVATE_RECORDS_UNAVAILABLE: 'Private records are unavailable',
  ERR_DESTROYED: 'Private routing state is destroyed'
})

export class PrivateRouteError extends Error {
  constructor(code) {
    if (!ALL_ERROR_CODES.has(code)) {
      throw new TypeError('Unknown private route error code')
    }

    super(MESSAGES[code])
    this.name = 'PrivateRouteError'
    this.code = code
  }

  static INVALID_IDENTITY() {
    return new PrivateRouteError('INVALID_IDENTITY')
  }

  static INVALID_KEY() {
    return new PrivateRouteError('INVALID_KEY')
  }

  static INVALID_ROLE() {
    return new PrivateRouteError('INVALID_ROLE')
  }

  static INVALID_ROUTE() {
    return new PrivateRouteError('INVALID_ROUTE')
  }

  static INVALID_DESCRIPTOR() {
    return new PrivateRouteError('INVALID_DESCRIPTOR')
  }

  static UNAUTHORIZED() {
    return new PrivateRouteError('UNAUTHORIZED')
  }

  static REPLAY() {
    return new PrivateRouteError('REPLAY')
  }

  static COUNTER_INVALID() {
    return new PrivateRouteError('COUNTER_INVALID')
  }

  static COUNTER_GAP() {
    return new PrivateRouteError('COUNTER_GAP')
  }

  static COUNTER_EXHAUSTED() {
    return new PrivateRouteError('COUNTER_EXHAUSTED')
  }

  static CELL_INVALID() {
    return new PrivateRouteError('CELL_INVALID')
  }

  static CIRCUIT_LIMIT() {
    return new PrivateRouteError('CIRCUIT_LIMIT')
  }

  static CIRCUIT_STATE() {
    return new PrivateRouteError('CIRCUIT_STATE')
  }

  static ROUTE_UNAVAILABLE() {
    return new PrivateRouteError('ROUTE_UNAVAILABLE')
  }

  static VIRTUAL_LIMIT() {
    return new PrivateRouteError('VIRTUAL_LIMIT')
  }

  static ERR_PRIVACY_UNAVAILABLE() {
    return new PrivateRouteError('ERR_PRIVACY_UNAVAILABLE')
  }

  static ERR_PRIVATE_BRANCH_ROTATING() {
    return new PrivateRouteError('ERR_PRIVATE_BRANCH_ROTATING')
  }

  static ERR_INCOMPATIBLE_RELAY() {
    return new PrivateRouteError('ERR_INCOMPATIBLE_RELAY')
  }

  static ERR_AUTHENTICATION() {
    return new PrivateRouteError('ERR_AUTHENTICATION')
  }

  static ERR_REPLAY() {
    return new PrivateRouteError('ERR_REPLAY')
  }

  static ERR_BUSY() {
    return new PrivateRouteError('ERR_BUSY')
  }

  static ERR_QUOTA_EXCEEDED() {
    return new PrivateRouteError('ERR_QUOTA_EXCEEDED')
  }

  static ERR_PRIVATE_RECORDS_UNAVAILABLE() {
    return new PrivateRouteError('ERR_PRIVATE_RECORDS_UNAVAILABLE')
  }

  static ERR_DESTROYED() {
    return new PrivateRouteError('ERR_DESTROYED')
  }
}
