import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(appRoot, '..', '..')

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8')
}

test('top-level developer docs describe the current universal backend architecture', () => {
  const readme = readWorkspaceFile('README.md')
  const agents = readWorkspaceFile('AGENTS.md')

  for (const source of [readme, agents]) {
    assert.match(source, /universal backend/i)
    assert.match(source, /@peartube\/host/)
    assert.match(source, /@peartube\/protocol/)
    assert.match(source, /desktop-native/)
    assert.match(source, /Electrobun/)
    assert.doesNotMatch(source, /pear-src/)
    assert.doesNotMatch(source, /pear:dev/)
    assert.doesNotMatch(source, /Pear Runtime/)
  }
})

test('root scripts cover universal backend packages and native desktop dependencies', () => {
  const pkg = JSON.parse(readWorkspaceFile('package.json'))

  assert.match(pkg.scripts.test, /packages\/host/)
  assert.match(pkg.scripts.test, /packages\/protocol/)
  assert.match(pkg.scripts.test, /packages\/spec/)
  assert.match(pkg.scripts['install:all'], /packages\/protocol/)
  assert.match(pkg.scripts['install:all'], /packages\/desktop-native/)
})

test('native desktop validates protocol version and exposes network-aware empty state copy', () => {
  const hostBridge = readWorkspaceFile('packages/desktop-native/Sources/Services/HostBridgeService.swift')
  const emptyState = readWorkspaceFile('packages/desktop-native/Sources/Views/SectionEmptyStateView.swift')

  assert.match(hostBridge, /supportedProtocolVersion = NativeHostProtocolVersion/)
  assert.match(hostBridge, /validateProtocolVersion/)
  assert.match(hostBridge, /try Self\.validateProtocolVersion\(response\.protocolVersion\)/)
  assert.match(hostBridge, /NativeNetworkStatus/)
  assert.match(hostBridge, /refreshNetworkStatus/)
  assert.match(emptyState, /networkEmptyDescription/)
  assert.match(emptyState, /Connected to the DHT/)
})

test('shared protocol exposes network status for universal clients', () => {
  const events = readWorkspaceFile('packages/protocol/src/event-map.js')
  const protocol = readWorkspaceFile('packages/protocol/src/create-client.js')
  const platformBridge = readWorkspaceFile('packages/platform/src/rpc.shared.ts')
  const backendRuntime = readWorkspaceFile('packages/backend/src/runtime.js')
  const schema = readWorkspaceFile('packages/spec/schema.cjs')

  assert.match(events, /NETWORK_STATUS: 'network.status'/)
  assert.match(protocol, /PROTOCOL_EVENTS\.NETWORK_STATUS/)
  assert.match(platformBridge, /networkStatus/)
  assert.match(backendRuntime, /swarmListenResolved/)
  assert.match(schema, /swarmListenResolved/)
  assert.match(schema, /feedEntries/)
})
