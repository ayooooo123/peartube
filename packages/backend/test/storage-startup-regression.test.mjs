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
  assert.match(storageSource, /const HYPERSWARM_MODULE_TIMEOUT_MS = 5000/)
  assert.match(storageSource, /waitForHyperswarmModule\(\)/)
  assert.doesNotMatch(storageSource, /setTimeout\(\(\) => resolve\(null\), 100\)/)
})

test('blob server watchdog lazily loads HTTP only when cast probing is needed', () => {
  const watchdogBody =
    storageSource.match(/export function startBlobServerWatchdog\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(watchdogBody, 'startBlobServerWatchdog should exist')
  assert.match(storageSource, /async function ensureHttpModule\(\)/)
  assert.match(watchdogBody, /await ensureHttpModule\(\)/)
})

test('blob server startup does not await listen before storage init can finish', () => {
  // End anchor matches the outer try/catch (2-space indent) so the capture is
  // not cut short by the `catch (err)` inside the patched _onrequest handler.
  const blobServerBody = storageSource.match(
    /const desiredPort = blobServerPortOverride \|\| 0;([\s\S]*?)\n  \} catch \(err\) \{/
  )?.[1] ?? ''

  assert.ok(blobServerBody, 'blob server startup block should exist')
  assert.doesNotMatch(blobServerBody, /await blobServer\.listen\(\)/)
  assert.match(blobServerBody, /const blobServerListenPromise = blobServer\.listen\(\)/)
  assert.match(blobServerBody, /blobServerListenPromise\s*\.then\(/)
})

test('blob server serves direct browser range requests without an Electrobun media proxy', () => {
  const requestWrapper =
    storageSource.match(/blobServer\._onrequest = async function \(req, res\) \{([\s\S]*?)\n      return origOnRequest\(req, res\)/)?.[1] ?? ''

  assert.ok(requestWrapper, 'blob server request wrapper should exist')
  assert.match(requestWrapper, /Access-Control-Allow-Origin', '\*'/)
  assert.match(requestWrapper, /Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'/)
  assert.match(requestWrapper, /Access-Control-Allow-Headers', 'Range'/)
  assert.match(requestWrapper, /Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges'/)
  assert.match(requestWrapper, /if \(req\.method === 'OPTIONS'\) \{ res\.writeHead\(204\); res\.end\(\); return \}/)
  assert.match(requestWrapper, /serveVideoRangeHttpRequest\(\{ blobServer \}, req, res\)/)
})

test('blob server video streams use no-timeout core sessions', () => {
  assert.match(
    storageSource,
    /function wrapStoreForBlobServerStreaming\(store\)/,
    'storage should define a BlobServer-specific store facade',
  )
  assert.match(
    storageSource,
    /wrapStoreWithTimeout\(store, defaultTimeout\);[\s\S]*?const blobStore = wrapStoreForBlobServerStreaming\(store\);/,
    'shared backend store should keep finite timeouts while BlobServer gets its own facade',
  )
  assert.match(
    storageSource,
    /blobServer = new BlobServer\(blobStore,/,
    'BlobServer should use the no-timeout facade',
  )
  assert.match(
    storageSource,
    /timeout: 0/,
    'BlobServer core sessions should disable Hypercore request timeouts',
  )
})

test('storage joins the PearTube network topic immediately without DHT bootstrap gates', () => {
  assert.doesNotMatch(storageSource, /function isSwarmDiscoveryReady/)
  assert.doesNotMatch(storageSource, /waitForSwarmDiscoveryReady\(swarm\)/)
  assert.doesNotMatch(storageSource, /dht\?\.bootstrapped[\s\S]{0,240}swarm\.join\(PEARTUBE_NETWORK_TOPIC/)
  assert.match(storageSource, /joinPeerPoolDiscoveryImmediately\('startup'\)/)
  assert.match(storageSource, /swarm\.join\(PEARTUBE_NETWORK_TOPIC, \{ server: true, client: true \}\)/)
  assert.match(storageSource, /swarm\.peerPoolDiscovery = poolDiscovery/)
})

test('storage creates Hyperswarm and starts DHT bootstrap before Corestore warmup', () => {
  // The DHT bootstrap is the long pole for topic discovery on mobile, so the
  // swarm must be created (and dht.ready() kicked) before local disk warmup —
  // while the topic join itself still happens only after storage is ready.
  assert.match(storageSource, /creating hyperswarm early[\s\S]*?creating corestore/)
  assert.match(storageSource, /swarm\.dht\.ready\(\)/)
  assert.doesNotMatch(storageSource, /await swarm\.dht\.ready\(\)/)
  // Topic join must remain gated behind metadata storage readiness.
  assert.match(storageSource, /metaDb ready[\s\S]*?joinPeerPoolDiscoveryImmediately\('startup'\)/)
})

test('storage tears down the early swarm on every storage init failure path', () => {
  assert.match(storageSource, /const destroySwarmAfterInitFailure = async/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\('corestore create'\)/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\('corestore ready'\)/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\(label\)/)
})

test('storage persists and restores DHT routing table state around lifecycle events', () => {
  assert.match(storageSource, /DHT_ROUTING_TABLE_KEY/)
  assert.match(storageSource, /restorePersistedDhtRoutingTable\([\s\S]*?reason: 'startup'/)
  assert.match(storageSource, /persistDhtRoutingTable\(globalSwarm, globalMetaDb, \{ reason: 'suspend' \}\)/)
})



test('storage uses bounded warm reconnect and desktop discovery refreshes', () => {
  assert.match(storageSource, /import \{ createKnownPeerCache, loadKnownPeers \} from '\.\/known-peers\.js'/)
  assert.match(storageSource, /const KNOWN_PEER_REDIAL_LIMIT = 16/)
  assert.match(storageSource, /known\.slice\(0, KNOWN_PEER_REDIAL_LIMIT\)/)
  assert.match(storageSource, /swarm\.joinPeer\(b4a\.from\(key, 'hex'\)\)/)
  assert.match(storageSource, /function resolveHyperswarmOptions/)
  assert.match(storageSource, /new LoadedHyperswarm\(hyperswarmOptions\)/)
  assert.match(storageSource, /function schedulePeerPoolWarmupRefreshes/)
  assert.match(storageSource, /schedulePeerPoolWarmupRefreshes\(\{[\s\S]*?platform,[\s\S]*?discovery: poolDiscovery/)
  assert.match(storageSource, /peer-pool-warm-refresh/)
  assert.match(storageSource, /swarm\._peartubeSwarmOptions = summarizeSwarmOptions\(hyperswarmOptions\)/)
  assert.match(storageSource, /options: summarizeSwarmOptions\(swarm\?\._peartubeSwarmOptions\)/)
  assert.match(storageSource, /swarmOptions: globalSwarm\._peartubeSwarmOptions \|\| null/)
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
  assert.match(storageSource, /joinPeerPoolDiscoveryImmediately\('startup'\)/)
  assert.match(storageSource, /Skipping peer pool discovery; P2P networking is offline/)
})

test('storage exposes public bee content discovery retention for cached serving cores', () => {
  assert.match(storageSource, /export async function retainPublicBeeContentDiscovery\(ctx, publicBeeKeyHex/)
  assert.match(storageSource, /await loadPublicBee\(ctx, publicBeeKeyHex\)/)
  assert.match(storageSource, /video\?\.blobsCoreKey/)
  assert.match(storageSource, /video\?\.thumbnailBlobsCoreKey/)
  assert.match(storageSource, /retainSwarmDiscovery\(ctx, core\.discoveryKey/)
})

test('storage does not monkey-patch Hyperswarm peer discovery into app-level peer events', () => {
  assert.doesNotMatch(storageSource, /function installSwarmPeerDiscoveryEmitter\(swarm\)/)
  assert.doesNotMatch(storageSource, /installSwarmPeerDiscoveryEmitter\(swarm\)/)
  assert.doesNotMatch(storageSource, /swarm\.emit\('peer', peer, topic\)/)
})

test('storage captures Hyperswarm connection lifecycle diagnostics', () => {
  assert.match(storageSource, /function createSwarmDiagnostics\(swarm\)/)
  assert.match(storageSource, /globalSwarmDiagnostics = createSwarmDiagnostics\(swarm\)/)
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
