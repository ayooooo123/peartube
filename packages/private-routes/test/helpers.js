import b4a from 'b4a'

import { PrivateRouteError } from '../index.js'

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
