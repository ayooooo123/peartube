import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isCorestoreLockError,
  isRecoverableCorestoreSeedMismatch,
  shouldRetryCorestoreSeedFallback
} from '../src/corestore-error-utils.js'

test('treats the string seed-mismatch error as recoverable', () => {
  assert.equal(
    isRecoverableCorestoreSeedMismatch(new Error('Another corestore is stored here')),
    true
  )
})

test('treats embedded raw numeric seed-mismatch errors as recoverable', () => {
  assert.equal(isRecoverableCorestoreSeedMismatch(3), true)
  assert.equal(isRecoverableCorestoreSeedMismatch({ code: 3 }), true)
  assert.equal(isRecoverableCorestoreSeedMismatch({ errno: 3 }), true)
  assert.equal(isRecoverableCorestoreSeedMismatch('number:3'), true)
})

test('only retries the seed fallback when an identity key file exists', () => {
  assert.equal(
    shouldRetryCorestoreSeedFallback(3, { hasIdentityKeyFile: true }),
    true
  )
  assert.equal(
    shouldRetryCorestoreSeedFallback(3, { hasIdentityKeyFile: false }),
    false
  )
  assert.equal(
    shouldRetryCorestoreSeedFallback(new Error('Another corestore is stored here'), { hasIdentityKeyFile: false }),
    false
  )
})

test('does not treat unrelated storage errors as seed mismatches', () => {
  assert.equal(
    isRecoverableCorestoreSeedMismatch(new Error('file descriptor could not be locked')),
    false
  )
  assert.equal(isRecoverableCorestoreSeedMismatch(5), false)
})

test('treats current-process and rocks lock messages as corestore lock errors', () => {
  assert.equal(
    isCorestoreLockError(new Error('lock hold by current process, acquire time 1774572721: /tmp/db/LOCK: No locks available')),
    true
  )
  assert.equal(
    isCorestoreLockError(new Error('file descriptor could not be locked')),
    true
  )
  assert.equal(
    isCorestoreLockError(new Error('Another corestore is stored here')),
    false
  )
})
