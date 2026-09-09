import test from 'brittle'

import { M3_ERROR_CODES, PrivateRouteError } from '../index.js'

const M3_ERRORS = Object.freeze([
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

test('M3 errors have stable codes, constructors, and redacted messages', (t) => {
  for (const code of M3_ERRORS) {
    t.ok(M3_ERROR_CODES.includes(code))
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

test('M3 error registry is exact and frozen without changing the M2 registry', (t) => {
  t.alike(M3_ERROR_CODES, M3_ERRORS)
  t.ok(Object.isFrozen(M3_ERROR_CODES))
})

test('M3 errors do not retain caller diagnostics', (t) => {
  const sensitive = 'relay 0123456789abcdef0123456789abcdef at 198.51.100.9'

  for (const code of M3_ERRORS) {
    const error = new PrivateRouteError(code, sensitive)
    t.is(error.message, PrivateRouteError[code]().message)
    t.absent(error.message.includes(sensitive))
  }
})
