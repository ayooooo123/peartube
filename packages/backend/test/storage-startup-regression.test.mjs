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

test('storage can require Hyperswarm instead of falling back after the optional startup race', () => {
  assert.match(
    storageSource,
    /requireNetwork\s*=\s*false/,
    'initializeStorage should expose an opt-in required-network mode'
  )
  assert.match(
    storageSource,
    /requireNetwork[\s\S]*?await hyperswarmModuleReady/,
    'required-network startup should await Hyperswarm instead of using the optional 100ms race'
  )
  assert.match(
    storageSource,
    /requireNetwork[\s\S]*?throw new Error\(`Hyperswarm unavailable/,
    'required-network startup should fail loudly if Hyperswarm cannot load'
  )
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
  assert.match(
    storageSource,
    /if \(!swarm\._peartubeOffline\) \{[\s\S]*?swarm\.join\(PEARTUBE_NETWORK_TOPIC/,
    'real swarm should still join the peer pool topic'
  )
  assert.match(
    storageSource,
    /Skipping peer pool discovery; P2P networking is offline/,
    'offline swarm should skip peer pool discovery'
  )
})

test('storage exposes public bee content discovery retention for cached serving cores', () => {
  assert.match(storageSource, /export async function retainPublicBeeContentDiscovery\(ctx, publicBeeKeyHex/)
  assert.match(storageSource, /await loadPublicBee\(ctx, publicBeeKeyHex\)/)
  assert.match(storageSource, /video\?\.blobsCoreKey/)
  assert.match(storageSource, /video\?\.thumbnailBlobsCoreKey/)
  assert.match(storageSource, /retainSwarmDiscovery\(ctx, core\.discoveryKey/)
})

test('storage does not monkey-patch Hyperswarm peer discovery into app-level dialing events', () => {
  assert.doesNotMatch(
    storageSource,
    /function installSwarmPeerDiscoveryEmitter\(swarm\)/,
    'storage should not install a private _handlePeer wrapper'
  )
  assert.doesNotMatch(
    storageSource,
    /swarm\.emit\('peer', peer, topic\)/,
    'discovered peers should stay under Hyperswarm queue ownership'
  )
})

test('storage plumbs explicit Hyperswarm network options into swarm construction', () => {
  assert.match(
    storageSource,
    /function createHyperswarmOptions\(/,
    'storage should build a whitelisted Hyperswarm option object'
  )
  assert.match(
    storageSource,
    /network\s*=\s*\{\}/,
    'initializeStorage should accept network options'
  )
  assert.match(
    storageSource,
    /new LoadedHyperswarm\(createHyperswarmOptions\(\{ keyPair, network, swarmOptions \}\)\)/,
    'Hyperswarm should receive configured bootstrap and relay options'
  )
})

test('network suspend is guarded by backend playback activity, not only cast state', () => {
  assert.match(storageSource, /export function setPlaybackActive\(/)
  assert.match(storageSource, /export function isPlaybackActive\(/)
  assert.match(
    storageSource,
    /if \(isPlaybackActive\(\)\) \{[\s\S]*?Skipping suspend/,
    'suspendNetworking should skip destructive swarm suspend while backend playback is active'
  )
  assert.match(
    storageSource,
    /await globalSwarm\.suspend\(\)/,
    'suspendNetworking still uses Hyperswarm suspend when no playback or cast guard is active'
  )
})

test('storage captures Hyperswarm connection lifecycle diagnostics', () => {
  assert.match(storageSource, /function createSwarmDiagnostics\(swarm\)/)
  assert.match(storageSource, /globalSwarmDiagnostics = createSwarmDiagnostics\(swarm\)/)
  assert.match(storageSource, /globalSwarmDiagnostics\?\.recordConnection\?\.\(conn, info\)/)
  assert.match(storageSource, /hyperswarm: diagnostics/)
})

test('retained content discovery direct-dials configured or cached peers for blob topics', () => {
  assert.match(storageSource, /getDialableKnownPeers\(ctx\)/)
  assert.match(storageSource, /dialKnownPeers\(ctx\.swarm, known\)/)
  assert.match(storageSource, /network,/)
  assert.match(storageSource, /swarmOptions,/)
})

test('storage captures pre-open DHT connect close diagnostics', () => {
  assert.match(storageSource, /function installSwarmConnectDiagnostics\(swarm, diagnostics\)/)
  assert.match(storageSource, /installSwarmConnectDiagnostics\(swarm, globalSwarmDiagnostics\)/)
  assert.match(storageSource, /recordClientConnect\(conn, peerInfo\)/)
  assert.match(storageSource, /type: 'client-attempt'/)
  assert.match(storageSource, /typeof this\._allConnections\[Symbol\.iterator\] === 'function'/)
  assert.match(storageSource, /for \(const conn of this\._allConnections\) latest = conn/)
  assert.match(storageSource, /rawStream: rawStream \? \{/)
  assert.match(storageSource, /remoteHost: rawStream\.remoteHost/)
  assert.match(storageSource, /event, \.\.\.detail/)
})


test('blob URL generation uses a physical-device friendly blobs core update timeout', () => {
  const storageSource = fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8')
  assert.match(storageSource, /DEFAULT_BLOBS_CORE_UPDATE_TIMEOUT_MS\s*=\s*15000/)
  assert.match(storageSource, /options\.blobsCoreUpdateTimeoutMs\s*\?\?\s*DEFAULT_BLOBS_CORE_UPDATE_TIMEOUT_MS/)
  assert.doesNotMatch(storageSource, /blobs core update timeout'\)\), 5000\)/)
})
