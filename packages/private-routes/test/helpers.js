import b4a from 'b4a'

import {
  PrivateRouteError,
  ROLE,
  cryptoSuite,
  isVerifiedDescriptor,
  readVerifiedDescriptor,
  roleForIdentity
} from '../index.js'

export function seed(value) {
  return b4a.alloc(32, value)
}

export function createXorshift32(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('Seed must be an unsigned 32-bit integer')
  }

  let state = seed === 0 ? 0x9e37_79b9 : seed >>> 0

  function nextUint32() {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }

  return Object.freeze({
    nextUint32,
    integer(maximum) {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x1_0000_0000) {
        throw new TypeError('Maximum must be between 1 and 2^32')
      }
      return nextUint32() % maximum
    },
    bytes(size) {
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Size must be non-negative')
      const value = b4a.allocUnsafe(size)
      for (let index = 0; index < size; index++) value[index] = nextUint32()
      return value
    },
    shuffle(values) {
      if (!Array.isArray(values)) throw new TypeError('Values must be an array')
      const shuffled = Array.from(values)
      for (let index = shuffled.length - 1; index > 0; index--) {
        const other = nextUint32() % (index + 1)
        const value = shuffled[index]
        shuffled[index] = shuffled[other]
        shuffled[other] = value
      }
      return shuffled
    }
  })
}

export function expectCode(t, fn, code) {
  let error = null

  try {
    fn()
  } catch (err) {
    error = err
  }

  t.ok(error instanceof PrivateRouteError)
  if (error) t.is(error.code, code)
}

export function privateRoleIdentity(start = 1) {
  for (let value = start; value < 256; value++) {
    const pair = cryptoSuite.keyPair(seed(value))
    if (roleForIdentity(pair.publicKey) === ROLE.PRIVATE) return pair
  }

  throw new Error('Unable to derive deterministic private-role identity')
}

export function safetyRoleIdentity(start = 1) {
  for (let value = start; value < 256; value++) {
    const pair = cryptoSuite.keyPair(seed(value))
    if (roleForIdentity(pair.publicKey) === ROLE.SAFETY) return pair
  }

  throw new Error('Unable to derive deterministic safety-role identity')
}

export function descriptorChecker() {
  return Object.freeze({
    isVerified: isVerifiedDescriptor,
    read: readVerifiedDescriptor
  })
}
