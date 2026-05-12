import test from 'node:test'
import assert from 'node:assert/strict'

import { createJsonFrameParser, encodeJsonFrame } from '../src/ipc-json-framing.js'

test('JSON IPC parser assembles split messages', () => {
  const parser = createJsonFrameParser()

  assert.deepEqual(parser.push('{"type":"shutdown'), [])
  assert.deepEqual(parser.push('-complete"}'), [{ type: 'shutdown-complete' }])
})

test('JSON IPC parser extracts coalesced messages', () => {
  const parser = createJsonFrameParser()

  assert.deepEqual(
    parser.push('{"type":"shutdown"}{"type":"shutdown-complete"}'),
    [{ type: 'shutdown' }, { type: 'shutdown-complete' }]
  )
})

test('JSON IPC parser ignores non-JSON prefixes and preserves nested braces in strings', () => {
  const parser = createJsonFrameParser()

  assert.deepEqual(
    parser.push('log line\n{"type":"shutdown-complete","message":"kept {literal}"}'),
    [{ type: 'shutdown-complete', message: 'kept {literal}' }]
  )
})

test('encodeJsonFrame emits parseable object JSON', () => {
  assert.deepEqual(JSON.parse(encodeJsonFrame({ type: 'shutdown' })), { type: 'shutdown' })
})
