import { PORTABLE_STATE_ERROR_CODES, PORTABLE_STATE_VERSION } from './constants.js'

export class PortableStateError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'PortableStateError'
    this.code = code
  }
}

export function failPortableState (code, message) {
  throw new PortableStateError(code, message)
}

export function portableStateErrorResult (error, fallbackCode = PORTABLE_STATE_ERROR_CODES.INVALID_FIELD) {
  return {
    success: false,
    schemaVersion: PORTABLE_STATE_VERSION,
    errorCode: error instanceof PortableStateError ? error.code : fallbackCode,
    error: error?.message || String(error)
  }
}
