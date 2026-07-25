import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createJsonFrameParser, encodeJsonFrame } from '../src/ipc-json-framing.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rpcSharedSource = () => readFileSync(join(__dirname, '../src/rpc.shared.ts'), 'utf8')

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

test('shared platform RPC preserves init error fidelity and transcode progress events', () => {
  const source = rpcSharedSource()

  assert.match(source, /const errorCode = errorField\(error, 'code'\)/, 'init failures should preserve error code')
  assert.match(source, /retryable: Boolean\(retryable\)/, 'init failures should preserve retryability')
  assert.match(source, /PROTOCOL_EVENTS\.TRANSCODE_PROGRESS/, 'transcode progress should be bound through protocol events')
  assert.match(source, /onTranscodeProgress/, 'platform consumers should be able to subscribe to transcode progress')
})
