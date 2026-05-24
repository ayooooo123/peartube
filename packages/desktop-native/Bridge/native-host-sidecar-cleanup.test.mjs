import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const sidecarPath = path.resolve(import.meta.dirname, 'native-host-sidecar.mjs')
const source = fs.readFileSync(sidecarPath, 'utf8')

test('native sidecar uses lazy transcoder adapter instead of dead unavailable stub', () => {
  assert.doesNotMatch(source, /Transcoding is not wired in the native sidecar yet\./)
  assert.match(source, /async startTranscode\(\.\.\.args\)/)
  assert.match(source, /ensureTranscoderModule\(\)/)
})

test('native sidecar clears keepalive timer through idempotent shutdown cleanup', () => {
  assert.match(source, /function createKeepAliveCleanup\(\)/)
  assert.match(source, /let keepAliveCleanup = createKeepAliveCleanup\(\)/)
  assert.match(source, /await shutdownBridge\(state, cleanupKeepAlive\)/)
  assert.match(source, /void shutdownBridge\(state, cleanup\)/)
  assert.match(source, /cleanupKeepAlive\?\.\(\)/)
})
