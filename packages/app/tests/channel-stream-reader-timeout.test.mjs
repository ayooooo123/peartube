import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createReaderAbortError,
  createReaderTimeoutError,
  isReadWaitExhausted,
  normalizeReadWaitOptions
} from '../backend/channel-stream-reader-guard.mjs'

test('reader wait guard reports timeout only after deadline or attempt budget', () => {
  assert.equal(isReadWaitExhausted({ now: 99, deadline: 100, attempts: 1, maxReadAttempts: 2 }), false)
  assert.equal(isReadWaitExhausted({ now: 101, deadline: 100, attempts: 1, maxReadAttempts: 2 }), true)
  assert.equal(isReadWaitExhausted({ now: 99, deadline: 100, attempts: 2, maxReadAttempts: 2 }), true)
})

test('reader wait guard normalizes timeout, attempt, delay, and signal options', () => {
  const signal = new AbortController().signal
  assert.deepEqual(normalizeReadWaitOptions({}), {
    readTimeoutMs: 30000,
    maxReadAttempts: 1000,
    readAttemptDelayMs: 1,
    signal: null
  })
  assert.deepEqual(normalizeReadWaitOptions({ readTimeoutMs: 12, maxReadAttempts: 3, readAttemptDelayMs: 0, signal }), {
    readTimeoutMs: 12,
    maxReadAttempts: 3,
    readAttemptDelayMs: 0,
    signal
  })
})

test('reader wait guard creates explicit timeout and abort errors', () => {
  assert.match(createReaderTimeoutError(5, 16).message, /timed out waiting for 16 bytes at offset 5/)
  assert.match(createReaderAbortError('destroyed').message, /aborted: destroyed/)
  const original = new Error('original')
  assert.equal(createReaderAbortError(original), original)
})
