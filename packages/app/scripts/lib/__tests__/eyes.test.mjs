import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EYES_PROMPT, resolveBackend } from '../eyes.mjs'

test('explicit look wins', () => {
  assert.equal(resolveBackend('look'), 'look')
})

test('omp default', () => {
  assert.equal(resolveBackend('omp'), 'omp')
})

test('prompt asks for screens/text/layout/glitches', () => {
  assert.match(EYES_PROMPT, /on-screen text/i)
  assert.match(EYES_PROMPT, /layout|glitch/i)
})
