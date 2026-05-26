import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const storageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage.js'), 'utf8')

test('storage startup does not eagerly load HTTP before backend ready', () => {
  const initStorageModulesBody =
    storageSource.match(/async function initStorageModules\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(initStorageModulesBody, 'initStorageModules should exist')
  assert.doesNotMatch(initStorageModulesBody, /loadBareOrNodeHttpModule\(\)/)
})

test('storage startup does not await optional network dependencies before local readiness', () => {
  const initStorageModulesBody =
    storageSource.match(/async function initStorageModules\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(initStorageModulesBody, 'initStorageModules should exist')
  assert.doesNotMatch(initStorageModulesBody, /await initOptionalStorageDeps\(\)/)
  assert.doesNotMatch(initStorageModulesBody, /await loadHyperswarmModule\(\)/)
  assert.match(storageSource, /function warmOptionalStorageDeps\(\)/)
  assert.match(storageSource, /function warmHyperswarmModule\(\)/)
  assert.match(storageSource, /warmOptionalStorageDeps\(\)[\s\S]*?warmHyperswarmModule\(\)[\s\S]*?await initStorageModules\(\)/)
  assert.match(storageSource, /Promise\.race\(\[[\s\S]*?hyperswarmModuleReady[\s\S]*?setTimeout\(\(\) => resolve\(null\), 100\)/)
})

test('blob server watchdog lazily loads HTTP only when cast probing is needed', () => {
  const watchdogBody =
    storageSource.match(/export function startBlobServerWatchdog\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(watchdogBody, 'startBlobServerWatchdog should exist')
  assert.match(storageSource, /async function ensureHttpModule\(\)/)
  assert.match(watchdogBody, /await ensureHttpModule\(\)/)
})

test('blob server startup does not await listen before storage init can finish', () => {
  const blobServerBody = storageSource.match(
    /const desiredPort = blobServerPortOverride \|\| 0;([\s\S]*?)catch \(err\) \{/
  )?.[1] ?? ''

  assert.ok(blobServerBody, 'blob server startup block should exist')
  assert.doesNotMatch(blobServerBody, /await blobServer\.listen\(\)/)
  assert.match(blobServerBody, /const blobServerListenPromise = blobServer\.listen\(\)/)
  assert.match(blobServerBody, /blobServerListenPromise\s*\.then\(/)
})

test('storage startup waits for listen and bootstrapping before peer pool discovery', () => {
  assert.match(storageSource, /waitForSwarmDiscoveryReady\(swarm\)/)
  assert.match(storageSource, /maybeStartPeerPoolDiscovery\('bootstrapped-and-listen-resolved'\)/)
  assert.match(storageSource, /swarm\._peartubeListenPromise = listenPromise/)
  assert.doesNotMatch(storageSource, /dialPersistedPeers/)
})

test('storage persists and restores DHT routing table state around lifecycle events', () => {
  assert.match(storageSource, /DHT_ROUTING_TABLE_KEY/)
  assert.match(storageSource, /persistDhtRoutingTable\([\s\S]*?reason: 'startup'/)
  assert.match(storageSource, /restorePersistedDhtRoutingTable\([\s\S]*?reason: 'startup'/)
  assert.match(storageSource, /persistDhtRoutingTable\(globalSwarm, globalMetaDb, \{ reason: 'suspend' \}\)/)
})

test('storage creates an offline swarm fallback when Hyperswarm is unavailable', () => {
  assert.match(
    storageSource,
    /function createOfflineSwarm\(keyPair, reason = 'unavailable'\)/,
    'storage should define an offline swarm fallback'
  )
  assert.match(
    storageSource,
    /typeof LoadedHyperswarm !== 'function'[\s\S]*?createOfflineSwarm\(keyPair, 'module-unavailable'\)/,
    'storage init should continue with offline swarm when Hyperswarm module did not load'
  )
  assert.match(
    storageSource,
    /Hyperswarm creation failed; continuing with offline P2P networking[\s\S]*?createOfflineSwarm\(keyPair, err\?\.message \|\| 'create-failed'\)/,
    'storage init should continue with offline swarm when Hyperswarm constructor throws'
  )
})

test('offline swarm fallback exposes the swarm methods orchestrator and managers require', () => {
  const fallbackBody =
    storageSource.match(/function createOfflineSwarm\(keyPair, reason = 'unavailable'\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(fallbackBody, 'createOfflineSwarm should exist')
  for (const method of ['on', 'off', 'emit', 'join']) {
    assert.match(fallbackBody, new RegExp(`${method}\\(`), `offline swarm should implement ${method}`)
  }
  for (const method of ['listen', 'suspend', 'resume', 'destroy']) {
    assert.match(fallbackBody, new RegExp(`${method}: async`), `offline swarm should implement ${method}`)
  }
  assert.match(fallbackBody, /connections: new Set\(\)/)
  assert.match(fallbackBody, /peers: new Set\(\)/)
  assert.match(fallbackBody, /keyPair,/)
})

test('offline swarm fallback skips peer pool discovery instead of joining noop topics at startup', () => {
  assert.match(storageSource, /maybeStartPeerPoolDiscovery\('bootstrapped-and-listen-resolved'\)/)
  assert.match(storageSource, /Skipping peer pool discovery; P2P networking is offline/)
})

test('storage exposes public bee content discovery retention for cached serving cores', () => {
  assert.match(storageSource, /export async function retainPublicBeeContentDiscovery\(ctx, publicBeeKeyHex/)
  assert.match(storageSource, /await loadPublicBee\(ctx, publicBeeKeyHex\)/)
  assert.match(storageSource, /video\?\.blobsCoreKey/)
  assert.match(storageSource, /video\?\.thumbnailBlobsCoreKey/)
  assert.match(storageSource, /retainSwarmDiscovery\(ctx, core\.discoveryKey/)
})

test('storage exposes Hyperswarm peer discovery as a diagnostic peer event', () => {
  assert.match(
    storageSource,
    /function installSwarmPeerDiscoveryEmitter\(swarm\)/,
    'storage should install a peer discovery event adapter'
  )
  assert.match(
    storageSource,
    /installSwarmPeerDiscoveryEmitter\(swarm\)/,
    'real swarm startup should install the peer discovery event adapter'
  )
  assert.match(
    storageSource,
    /swarm\.emit\('peer', peer, topic\)/,
    'adapter should emit peer events with the discovered peer and topic'
  )
})

test('storage captures Hyperswarm connection lifecycle diagnostics', () => {
  assert.match(storageSource, /function createSwarmDiagnostics\(swarm\)/)
  assert.match(storageSource, /globalSwarmDiagnostics = createSwarmDiagnostics\(swarm\)/)
  assert.match(storageSource, /globalSwarmDiagnostics\?\.recordPeer\?\.\(peer, topic\)/)
  assert.match(storageSource, /globalSwarmDiagnostics\?\.recordConnection\?\.\(conn, info\)/)
  assert.match(storageSource, /hyperswarm: diagnostics/)
})

test('storage captures pre-open DHT connect close diagnostics', () => {
  assert.match(storageSource, /function installSwarmConnectDiagnostics\(swarm, diagnostics\)/)
  assert.match(storageSource, /installSwarmConnectDiagnostics\(swarm, globalSwarmDiagnostics\)/)
  assert.match(storageSource, /recordClientConnect\(conn, peerInfo\)/)
  assert.match(storageSource, /type: 'client-attempt'/)
  assert.match(storageSource, /rawStream: rawStream \? \{/)
  assert.match(storageSource, /remoteHost: rawStream\.remoteHost/)
  assert.match(storageSource, /event, \.\.\.detail/)
})
