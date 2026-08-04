import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAppTestArgs } from '../args.mjs'

test('defaults: eyes=omp, platform required', () => {
  const a = parseAppTestArgs(['--platform', 'android'])
  assert.equal(a.platform, 'android')
  assert.equal(a.eyes, 'omp')
  assert.equal(a.seed, false)
  assert.equal(a.recordOnly, false)
})

test('rejects unknown platform', () => {
  assert.throws(() => parseAppTestArgs(['--platform', 'watch']), /platform/)
})

test('rejects missing platform', () => {
  assert.throws(() => parseAppTestArgs([]), /platform/)
})

test('eyes=look and flags parse', () => {
  const a = parseAppTestArgs(['--platform', 'all', '--eyes', 'look', '--seed', '--record-only'])
  assert.equal(a.eyes, 'look')
  assert.equal(a.seed, true)
  assert.equal(a.recordOnly, true)
  assert.deepEqual(a.platforms, ['android', 'ios', 'desktop'])
})

test('rejects unknown eyes backend', () => {
  assert.throws(() => parseAppTestArgs(['--platform', 'ios', '--eyes', 'psychic']), /eyes/)
})
