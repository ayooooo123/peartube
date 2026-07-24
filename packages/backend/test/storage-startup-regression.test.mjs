import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createBackendLifecycle,
  getVideoUrlFromBlob,
  getVideoUrlInstant,
  resolveHyperswarmOptions,
} from '../src/storage.js'
import { createKnownPeerCache } from '../src/known-peers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const storageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage.js'), 'utf8')
const pairerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'channel', 'pairer.js'), 'utf8')

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
    /const desiredPort = blobServerPortOverride \|\| 0;([\s\S]*?)\n {2}\} catch \(err\) \{/
  )?.[1] ?? ''

  assert.ok(blobServerBody, 'blob server startup block should exist')
  assert.doesNotMatch(blobServerBody, /await blobServer\.listen\(\)/)
  assert.match(blobServerBody, /const blobServerListenPromise = blobServer\.listen\(\)/)
  assert.match(blobServerBody, /blobServerListenPromise\s*\.then\(/)
})

test('blob server serves direct browser range requests without an Electrobun media proxy', () => {
  const requestWrapper =
    storageSource.match(/blobServer\._onrequest = async function \(req, res\) \{([\s\S]*?)\n {6}return origOnRequest\(req, res\)/)?.[1] ?? ''

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
test('storage registers long-lived resources with the instance lifecycle as they are created', () => {
  assert.match(storageSource, /swarm = new LoadedHyperswarm\(hyperswarmOptions\);[\s\S]{0,500}lifecycle\.ownResource\('Hyperswarm', swarm/)
  assert.match(storageSource, /store = await createCorestoreInstance\(storagePath, corestoreOptions\)[\s\S]{0,160}lifecycle\.ownResource\('Corestore', store/)
  assert.match(storageSource, /metaCore = await openDeterministicNamedCore\(store, 'peartube-meta'\);[\s\S]{0,160}lifecycle\.ownResource\('metadata core', metaCore/)
  assert.match(storageSource, /metaDb = new Hyperbee\(metaCore,[\s\S]{0,180}lifecycle\.ownResource\('metadata database', metaDb/)
  assert.match(storageSource, /blobServer = new BlobServer\(blobStore,[\s\S]{0,240}lifecycle\.own\('blob server'/)
  assert.match(storageSource, /const pairer = new ChannelPairer\([\s\S]{0,800}ownContextResource\(ctx, 'channel pairer', pairer/)
  assert.match(storageSource, /onChannel: \(channel\) => \{[\s\S]{0,400}ownContextResource\(ctx, `paired channel[\s\S]{0,800}channel = await pairer\.finished\(\)/)
  const pairDeviceBody = storageSource.match(/export async function pairDevice\(ctx, inviteCode, options = \{\}\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(pairDeviceBody.indexOf('ownContextResource(ctx, `paired channel') < pairDeviceBody.indexOf('ctx.channels.set(channelKeyHex, channel)'))
})
test('pairer exposes a newly created channel to lifecycle ownership before readiness', () => {
  assert.match(pairerSource, /this\.channel = new MultiWriterChannel\([\s\S]{0,240}this\.opts\.onChannel\?\.\(this\.channel\)[\s\S]{0,80}await this\.channel\.ready\(\)/)
  assert.match(storageSource, /new ChannelPairer\(ctx\.store, inviteCode,[\s\S]{0,300}onChannel: \(channel\) => \{[\s\S]{0,240}ownContextResource\(ctx, `paired channel/)
})
test('pairer retains transient discovery without duplicating the channel-owned join', () => {
  assert.match(pairerSource, /this\.discovery = this\.swarm\.join\(this\.channel\.discoveryKey\)[\s\S]{0,120}await this\.discovery\.flushed\(\)/)
  const pairDeviceBody = storageSource.match(/export async function pairDevice\(ctx, inviteCode, options = \{\}\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.doesNotMatch(pairDeviceBody, /retainSwarmDiscovery\(ctx, channel\.discoveryKey/)
  assert.match(pairDeviceBody, /await channel\.setupPairing\(ctx\.swarm\)/)
})


test('known-peer cache cancels its debounce before metadata shutdown', async () => {
  let scheduled = null
  let cleared = null
  let puts = 0
  const metaDb = {
    closed: false,
    async put() {
      assert.equal(this.closed, false, 'known-peer flush must not target a closed metadata database')
      puts += 1
    },
  }
  const cache = createKnownPeerCache(metaDb, {
    setTimer(fn) {
      scheduled = fn
      return 42
    },
    clearTimer(id) {
      cleared = id
    },
  })

  cache.record(Buffer.alloc(32, 9))
  await cache.close({ flush: false })
  metaDb.closed = true
  scheduled?.()
  await Promise.resolve()

  assert.equal(cleared, 42)
  assert.equal(puts, 0)
})
test('known-peer cache close waits for an in-flight metadata write', async () => {
  let releasePut = null
  const putGate = new Promise((resolve) => {
    releasePut = resolve
  })
  const metaDb = {
    closed: false,
    async put() {
      assert.equal(this.closed, false)
      await putGate
      assert.equal(this.closed, false)
    },
  }
  const cache = createKnownPeerCache(metaDb, {
    setTimer() {
      return 42
    },
    clearTimer() {},
  })
  cache.record(Buffer.alloc(32, 10))
  const flush = cache.flush()
  let closeSettled = false
  const close = cache.close({ flush: false }).finally(() => {
    closeSettled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeSettled, false)
  releasePut()
  await Promise.all([flush, close])
  metaDb.closed = true
})




test('storage persists and restores DHT routing table state around lifecycle events', () => {
  assert.match(storageSource, /DHT_ROUTING_TABLE_KEY/)
  assert.match(storageSource, /restorePersistedDhtRoutingTable\([\s\S]*?reason: 'startup'/)
  assert.match(storageSource, /persistDhtRoutingTable\(globalSwarm, globalMetaDb, \{ reason: 'suspend' \}\)/)
})
test('instant blob core background work closes on shutdown and does not update after abort', async () => {
  const lifecycle = createBackendLifecycle()
  let releaseReady = null
  const readyGate = new Promise((resolve) => {
    releaseReady = resolve
  })
  let closeCalls = 0
  let updateCalls = 0
  const core = {
    discoveryKey: Buffer.alloc(32, 1),
    ready() {
      return readyGate
    },
    async update() {
      updateCalls += 1
    },
    async close() {
      closeCalls += 1
    },
  }
  const ctx = {
    lifecycle,
    store: { get: () => core },
    blobServer: {
      port: 1234,
      getLink: () => 'http://127.0.0.1:1234/blob',
    },
    swarm: {},
  }
  getVideoUrlInstant(ctx, '11'.repeat(32), {
    blockOffset: 0,
    blockLength: 1,
    byteOffset: 0,
    byteLength: 1,
  })
  await lifecycle.shutdown()
  assert.equal(closeCalls, 1)
  releaseReady()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updateCalls, 0)
})

test('awaited blob core closes when shutdown interrupts readiness', async () => {
  const lifecycle = createBackendLifecycle()
  let releaseReady = null
  const readyGate = new Promise((resolve) => {
    releaseReady = resolve
  })
  let closeCalls = 0
  const core = {
    key: Buffer.alloc(32, 2),
    ready() {
      return readyGate
    },
    async close() {
      closeCalls += 1
    },
  }
  const ctx = {
    lifecycle,
    store: { get: () => core },
    blobServer: {
      port: 1234,
      getLink: () => 'http://127.0.0.1:1234/blob',
    },
  }
  const request = getVideoUrlFromBlob(ctx, '22'.repeat(32), {
    blockOffset: 0,
    blockLength: 1,
    byteOffset: 0,
    byteLength: 1,
  })
  await lifecycle.shutdown()
  assert.equal(closeCalls, 1)
  releaseReady()
  await assert.rejects(request, /shutting down/)
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

test('storage applies platform-specific swarm defaults without blocking explicit overrides', () => {
  const keyPair = {
    publicKey: Buffer.alloc(32, 1),
    secretKey: Buffer.alloc(64, 2),
  }

  const desktopOptions = resolveHyperswarmOptions({ keyPair, platform: 'desktop' })
  assert.equal(desktopOptions.maxParallel, 12)
  assert.equal(desktopOptions.maxPeers, 96)

  const mobileOptions = resolveHyperswarmOptions({ keyPair, platform: 'mobile' })
  assert.equal(mobileOptions.maxParallel, undefined)
  assert.equal(mobileOptions.maxPeers, undefined)

  const explicitOptions = resolveHyperswarmOptions({
    keyPair,
    platform: 'mobile',
    network: { bootstrap: ['relay-a'], port: 0 },
    swarmOptions: { maxParallel: 3, maxPeers: 8, keyPair: { publicKey: Buffer.alloc(32, 9) } },
  })

  assert.deepEqual(explicitOptions.bootstrap, ['relay-a'])
  assert.equal(explicitOptions.port, 0)
  assert.equal(explicitOptions.maxParallel, 3)
  assert.equal(explicitOptions.maxPeers, 8)
  assert.equal(explicitOptions.keyPair, keyPair)
})

test('explicit network and swarm options override platform defaults', () => {
  const keyPair = { publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2) }
  const bootstrap = ['bootstrap.example:49737']
  const options = resolveHyperswarmOptions({
    keyPair,
    platform: 'desktop',
    network: { bootstrap, port: 12345 },
    swarmOptions: { maxPeers: 17, maxParallel: 3, port: 23456 },
  })

  assert.equal(options.maxPeers, 17)
  assert.equal(options.maxParallel, 3)
  assert.equal(options.port, 23456)
  assert.equal(options.bootstrap, bootstrap)
  assert.equal(options.keyPair, keyPair)
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
  assert.match(storageSource, /await loadPublicBeeImpl\(ctx, publicBeeKeyHex\)/)
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
