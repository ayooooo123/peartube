import b4a from 'b4a'

import { PrivateRouteError, ROLE, cryptoSuite, roleForIdentity } from '../index.js'

export function seed(value) {
  return b4a.alloc(32, value)
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
