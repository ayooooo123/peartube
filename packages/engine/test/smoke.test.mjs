import test from 'node:test'
import assert from 'node:assert/strict'

import { ENGINE_PACKAGE_READY } from '../src/index.mjs'

test('engine package is wired for node:test', () => {
  assert.equal(ENGINE_PACKAGE_READY, true)
})
