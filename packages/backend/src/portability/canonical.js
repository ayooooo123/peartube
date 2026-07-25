import b4a from 'b4a'
import sodium from 'sodium-universal'

import {
  MAX_PORTABLE_MANIFEST_BYTES,
  MAX_PORTABLE_STRING_BYTES,
  PORTABLE_STATE_ERROR_CODES
} from './constants.js'
import { failPortableState } from './errors.js'

const HEX_32 = /^[0-9a-f]{64}$/

export function isPlainObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertPlainObject (value, name) {
  if (!isPlainObject(value)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be an object`)
  return value
}

export function assertExactFields (value, expected, name) {
  assertPlainObject(value, name)
  const allowed = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failPortableState(PORTABLE_STATE_ERROR_CODES.UNKNOWN_FIELD, `${name} has unknown field ${key}`)
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name}.${key} is required`)
  }
}

export function readOwnDataField (value, key) {
  if (!isPlainObject(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

export function boundedString (value, name, maximum = MAX_PORTABLE_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > maximum) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} is out of bounds`)
  }
  return value
}

export function hex32 (value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== 32) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be 32 bytes`)
    return b4a.toString(value, 'hex')
  }
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be canonical lowercase 32-byte hex`)
  }
  return value
}

export function boundedUint (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be a nonnegative safe integer`)
  return value
}

export function denseArray (value, name, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.ITEM_LIMIT, `${name} exceeds its item limit`)
  }
  const keys = Object.keys(value)
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `${name} must be a dense array`)
  }
  return value
}

function canonicalize (value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'canonical numbers must be safe integers')
    return value
  }
  if (typeof value !== 'object') failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'canonical value contains an unsupported type')
  if (seen.has(value)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'canonical value contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'canonical arrays must be dense')
      }
      return value.map(entry => canonicalize(entry, seen))
    }
    if (!isPlainObject(value)) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, 'canonical objects must be plain')
    const output = {}
    for (const key of Object.keys(value).sort()) {
      const next = value[key]
      if (next === undefined) failPortableState(PORTABLE_STATE_ERROR_CODES.INVALID_FIELD, `canonical field ${key} must not be undefined`)
      output[key] = canonicalize(next, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function encodeCanonicalPortableJson (value) {
  const output = b4a.from(JSON.stringify(canonicalize(value, new Set())))
  if (output.byteLength === 0 || output.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    failPortableState(PORTABLE_STATE_ERROR_CODES.TOO_LARGE, 'portable-state manifest exceeds its byte limit')
  }
  return output
}

export function sha256Hex (value) {
  const bytes = b4a.isBuffer(value) ? value : b4a.from(value)
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, bytes)
  return b4a.toString(digest, 'hex')
}

export function equalBytes (left, right) {
  return left.byteLength === right.byteLength && b4a.equals(left, right)
}
