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
  VIRTUAL_LIMIT: 'Virtual endpoint limit was reached'
})

export class PrivateRouteError extends Error {
  constructor(code) {
    if (!ERROR_CODES.includes(code)) {
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
}
