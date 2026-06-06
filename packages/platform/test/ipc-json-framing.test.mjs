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

  assert.match(source, /code: \(error as any\)\?\.code/, 'init failures should preserve error code')
  assert.match(source, /retryable: Boolean\(\(error as any\)\?\.retryable\)/, 'init failures should preserve retryability')
  assert.match(source, /PROTOCOL_EVENTS\.TRANSCODE_PROGRESS/, 'transcode progress should be bound through protocol events')
  assert.match(source, /onTranscodeProgress/, 'platform consumers should be able to subscribe to transcode progress')
})


test('shared platform RPC facade resolves methods through protocol namespaces before raw HRPC', () => {
  const source = rpcSharedSource()
  assert.match(source, /function createProtocolRpcFacade/, 'shared bridge should build an app-facing protocol facade')
  assert.match(source, /PROTOCOL_RPC_NAMESPACES/, 'facade should scan protocol namespaces')
  assert.match(source, /namespaceObject\?\.\[methodName\]/, 'facade should call namespace methods without raw rpc')
  assert.match(source, /RUNTIME_ONLY_METHODS/, 'facade should keep runtime-only lifecycle methods reachable')
})


test('shared platform RPC facade calls fake protocol namespace methods and does not require raw rpc methods', async () => {
  const source = rpcSharedSource()
  const namespaces = source.match(/const PROTOCOL_RPC_NAMESPACES = (\[[^\n]+\]) as const/)?.[1]
  const functionSource = source.match(/export function createProtocolRpcFacade[\s\S]*?\n}\n\ntype ReadyCallback/)?.[0]
    ?.replace(/\n\ntype ReadyCallback[\s\S]*/, '')
    ?.replace('export function createProtocolRpcFacade(client: ProtocolClientLike | null): any', 'function createProtocolRpcFacade(client)')
    ?.replace(/\(client as any\)/g, 'client')
    ?.replace(/request: any = \{\}/g, 'request = {}')
  assert.ok(namespaces, 'expected namespace list')
  assert.ok(functionSource, 'expected facade function source')
  const createProtocolRpcFacade = Function(`const PROTOCOL_RPC_NAMESPACES = ${namespaces}; const RUNTIME_ONLY_METHOD_SET = new Set(['suspendNetwork', 'resumeNetwork', 'setPlaybackActive']); ${functionSource}; return createProtocolRpcFacade`)()
  const calls = []
  const rawCalls = []
  const facade = createProtocolRpcFacade({
    rpc: {
      async suspendNetwork(request) { rawCalls.push(['suspendNetwork', request]); return { success: true } }
    },
    events: { on() { return () => {} } },
    ready: async () => ({ blobServerPort: null, protocolVersion: 2 }),
    video: {
      async preparePlayback(request) { calls.push(['preparePlayback', request]); return { url: 'p2p://video' } }
    }
  })

  assert.deepEqual(await facade.preparePlayback({ channelKey: 'channel', videoId: 'video' }), { url: 'p2p://video' })
  assert.deepEqual(await facade.suspendNetwork({}), { success: true })
  assert.deepEqual(calls, [['preparePlayback', { channelKey: 'channel', videoId: 'video' }]])
  assert.deepEqual(rawCalls, [['suspendNetwork', {}]])
})
