import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import Corestore from 'corestore'
import ConnectionSet from 'hyperswarm/lib/connection-set.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
const runNode = promisify(execFile)

// Expose the actual storage boundaries only in this isolated module instance;
// production keeps its private API and the tests execute, rather than parse,
// the same implementations used by initializeStorage.
async function loadStorageBoundaries(run = url => import(url.href)) {
  // Keep relative imports beside the original module. The unique temporary
  // sibling works on every supported Node version and is removed after import.
  const url = new URL(`../src/.storage-boundary-${randomUUID()}.mjs`, import.meta.url)
  fs.writeFileSync(url, `${storageSource}\nexport {
    setupStorageBlobServer, startBlobServerListening, createBlobServerRequestHandler,
    wrapStoreForBlobServerStreaming, ownContextResource,
    scheduleWarmReconnect, createSwarmDiagnostics,
    installSwarmConnectDiagnostics
  }\n`, { flag: 'wx' })
  try {
    return await run(url)
  } finally {
    fs.unlinkSync(url)
  }
}

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

test('blob server readiness is asynchronous and preserves a failed listen result', async () => {
  const { startBlobServerListening } = await loadStorageBoundaries()
  let rejectListen
  const listening = new Promise((resolve, reject) => { rejectListen = reject })
  let ready = null
  const server = { listen: () => listening, port: 0 }
  startBlobServerListening(server, result => { ready = result })
  assert.equal(ready, null, 'startup does not wait for the listener')
  const failure = new Error('listener unavailable')
  rejectListen(failure)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready.error, failure)
  assert.equal(ready.port, 0)
})

test('storage does not consume same-shaped nonblob cancellations while a blob request is active', async () => {
  await loadStorageBoundaries(async url => {
    // Isolate Node's real unhandled-rejection policy from node:test's listener.
    const script = `
      import assert from 'node:assert/strict'
      import { get } from 'node:http'
      import { setupStorageBlobServer, createBackendLifecycle } from ${JSON.stringify(url.href)}

      const lifecycle = createBackendLifecycle()
      let request
      let releaseCore
      try {
        const { blobServer, blobServerReady } = await setupStorageBlobServer({
          store: {}, blobStore: { close: async () => {} }, lifecycle,
          blobServerBindHost: '127.0.0.1',
          getStorageContext: () => null,
          staticAssetPlaybackEntries: new Map()
        })
        assert.ifError((await blobServerReady).error)
        let requestStarted
        const started = new Promise(resolve => { requestStarted = resolve })
        blobServer._getCore = () => {
          requestStarted()
          return new Promise(resolve => { releaseCore = resolve })
        }
        request = get(blobServer.getLink(Buffer.alloc(32, 9), {
          blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 8 },
          type: 'audio/mpeg'
        }))
        request.on('error', () => {})
        await started

        const reason = process.argv[1] === 'code-only'
          ? { code: 'REQUEST_CANCELLED' }
          : Object.assign(new Error('Request was cancelled'), { code: 'REQUEST_CANCELLED' })
        Promise.reject(reason)
        await new Promise(resolve => setTimeout(resolve, 30))
        console.log('nonblob-cancellation-was-silenced')
      } finally {
        request?.destroy()
        releaseCore?.(null)
        await lifecycle.shutdown()
      }
    `
    for (const mode of ['with-message', 'code-only']) {
      await assert.rejects(runNode(process.execPath, ['--input-type=module', '--eval', script, mode], {
        cwd: path.join(__dirname, '..'),
        timeout: 10000,
      }), error => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, /REQUEST_CANCELLED|ERR_UNHANDLED_REJECTION/)
        return true
      })
    }
  })
})

function requestBlobResponse(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('storage-owned blob streams preserve full, ranged and HEAD responses without closing the publisher core', async () => {
  const { setupStorageBlobServer, wrapStoreForBlobServerStreaming } = await loadStorageBoundaries()
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'peartube-owned-blob-'))
  const store = new Corestore(directory)
  const lifecycle = createBackendLifecycle()
  try {
    const core = store.get({ name: 'blob-http' })
    await core.ready()
    const prefix = Buffer.from('prefix')
    const payload = Buffer.from('0123456789')
    await core.append([prefix, payload])
    const blob = { blockOffset: 1, blockLength: 1, byteOffset: prefix.length, byteLength: payload.length }
    const { blobServer, blobServerReady } = await setupStorageBlobServer({
      store, blobStore: wrapStoreForBlobServerStreaming(store), lifecycle,
      blobServerBindHost: '127.0.0.1', getStorageContext: () => null,
      staticAssetPlaybackEntries: new Map(),
    })
    assert.ifError((await blobServerReady).error)
    const url = blobServer.getLink(core.key, { blob, type: 'audio/mpeg' })

    const full = await requestBlobResponse(url)
    assert.equal(full.status, 200)
    assert.deepEqual(full.body, payload)
    const partial = await requestBlobResponse(url, { headers: { Range: 'bytes=2-5' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers['content-range'], 'bytes 2-5/10')
    assert.equal(partial.headers['content-length'], '4')
    assert.deepEqual(partial.body, payload.subarray(2, 6))
    const head = await requestBlobResponse(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } })
    assert.equal(head.status, 206)
    assert.equal(head.headers['content-length'], '4')
    assert.equal(head.body.length, 0)
    assert.equal(core.closed, false, 'HTTP response cleanup must not close the publisher session')
  } finally {
    await lifecycle.shutdown()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('storage closes its stream session and observes pending seek cancellation after client disconnect', { timeout: 5000 }, async () => {
  const { setupStorageBlobServer, wrapStoreForBlobServerStreaming } = await loadStorageBoundaries()
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'peartube-blob-abort-'))
  const store = new Corestore(directory)
  const lifecycle = createBackendLifecycle()
  const getCore = store.get.bind(store)
  const observed = new WeakSet()
  const seeks = []
  let seekCore
  const observeCore = core => {
    if (observed.has(core)) return core
    observed.add(core)
    const session = core.session.bind(core)
    const seek = core.seek.bind(core)
    core.session = options => observeCore(session(options))
    core.seek = (...args) => {
      seekCore = core
      const pending = seek(...args)
      seeks.push(pending)
      return pending
    }
    return core
  }
  store.get = options => observeCore(getCore(options))
  let client
  try {
    const { blobServer, blobServerReady } = await setupStorageBlobServer({
      store, blobStore: wrapStoreForBlobServerStreaming(store), lifecycle,
      blobServerBindHost: '127.0.0.1', getStorageContext: () => null,
      staticAssetPlaybackEntries: new Map(),
    })
    assert.ifError((await blobServerReady).error)
    let markResponseClosed
    const responseClosed = new Promise(resolve => { markResponseClosed = resolve })
    const onBlob = blobServer._onblob
    blobServer._onblob = (info, res) => {
      const pending = onBlob.call(blobServer, info, res)
      res.once('close', markResponseClosed)
      return pending
    }
    const url = blobServer.getLink(Buffer.alloc(32, 247), {
      blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 16 },
      type: 'audio/mpeg',
    })
    client = request(url, { headers: { Range: 'bytes=1-7' } }, res => res.resume())
    client.on('error', () => {})
    client.end()
    const admissionDeadline = performance.now() + 2000
    // Invocation can still be awaiting metadata. Cancel only after Hypercore
    // has admitted a real request, so this exercises REQUEST_CANCELLED.
    while (!seekCore?.activeRequests.length && !seekCore?.closing) {
      assert.ok(performance.now() < admissionDeadline, 'Hypercore seek admission did not occur within 2000 ms')
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.ok(seekCore.activeRequests.length > 0, 'seek must be pending before client disconnect')
    client.destroy()
    await responseClosed
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(seekCore.closing || seekCore.closed, 'response teardown must close its pending reader session')
    await seekCore.closing
    assert.equal(seekCore.closed, true)
    const outcomes = await Promise.allSettled(seeks)
    assert.ok(outcomes.some(result => result.status === 'rejected' && result.reason.code === 'REQUEST_CANCELLED'))
  } finally {
    client?.destroy()
    await lifecycle.shutdown()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('blob server answers real browser range preflights without acquiring media', async () => {
  const { createBlobServerRequestHandler } = await loadStorageBoundaries()
  let mediaRequests = 0
  const server = createServer(createBlobServerRequestHandler({
    store: {}, blobServer: {}, getStorageContext: () => null,
    origOnRequest() { mediaRequests++ },
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: server.address().port, method: 'OPTIONS', path: '/video',
        headers: { Origin: 'http://localhost', 'Access-Control-Request-Headers': 'Range' },
      }, res => {
        res.resume()
        res.on('end', () => resolve(res))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(response.statusCode, 204)
    assert.equal(response.headers['access-control-allow-origin'], '*')
    assert.ok(response.headers['access-control-allow-methods'].split(', ').includes('GET'))
    assert.ok(response.headers['access-control-allow-headers'].split(', ').includes('Range'))
    assert.ok(response.headers['access-control-expose-headers'].split(', ').includes('Content-Range'))
    assert.equal(mediaRequests, 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('blob HTTP streaming waits for delayed blocks beyond the shared store timeout', { timeout: 5000 }, async t => {
  const { setupStorageBlobServer, wrapStoreForBlobServerStreaming } = await loadStorageBoundaries()
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'peartube-blob-timeout-'))
  const store = new Corestore(directory)
  const lifecycle = createBackendLifecycle()
  try {
    const writer = store.get({ name: 'delayed-video', timeout: 5 })
    await writer.ready()
    const payload = Buffer.from('delayed video')
    const { blobServer, blobServerReady } = await setupStorageBlobServer({
      store, blobStore: wrapStoreForBlobServerStreaming(store), lifecycle,
      blobServerBindHost: '127.0.0.1', getStorageContext: () => null,
      staticAssetPlaybackEntries: new Map(),
    })
    assert.ifError((await blobServerReady).error)
    let markAcquired
    let acquiredCore
    const acquired = new Promise(resolve => { markAcquired = resolve })
    const getCore = blobServer._getCore.bind(blobServer)
    blobServer._getCore = async (...args) => {
      acquiredCore = await getCore(...args)
      markAcquired()
      return acquiredCore
    }
    const url = blobServer.getLink(writer.key, {
      blob: { blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: payload.length },
      type: 'audio/mpeg',
    })
    let settled = false
    const delivery = requestBlobResponse(url).then(
      response => { settled = true; return { response } },
      error => { settled = true; return { error } },
    )
    await acquired
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(settled, false, 'HTTP response must remain pending while the block is unavailable')
    t.diagnostic(`setup session closed while HTTP body remains pending: ${acquiredCore.closed}`)
    await writer.append(payload)
    const { response, error } = await delivery
    assert.ifError(error)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, payload)
    assert.equal(writer.closed, false)
  } finally {
    await lifecycle.shutdown()
    await store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('storage does not join legacy global peer pool topic', () => {
  assert.doesNotMatch(storageSource, /function isSwarmDiscoveryReady/)
  assert.doesNotMatch(storageSource, /waitForSwarmDiscoveryReady\(swarm\)/)
  assert.doesNotMatch(storageSource, /PEARTUBE_NETWORK_TOPIC/)
})

test('storage creates Hyperswarm and starts DHT bootstrap before Corestore warmup', () => {
  // The DHT bootstrap is the long pole for topic discovery on mobile, so the
  // swarm must be created (and dht.ready() kicked) before local disk warmup —
  // while the topic join itself still happens only after storage is ready.
  assert.match(storageSource, /creating hyperswarm early[\s\S]*?creating corestore/)
  assert.match(storageSource, /swarm\.dht\.ready\(\)/)
  assert.doesNotMatch(storageSource, /await swarm\.dht\.ready\(\)/)
  assert.match(storageSource, /creating corestore/)
})

test('storage tears down the early swarm on every storage init failure path', () => {
  assert.match(storageSource, /const destroySwarmAfterInitFailure = async/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\('corestore create'\)/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\('corestore ready'\)/)
  assert.match(storageSource, /destroySwarmAfterInitFailure\(label\)/)
})
test('context resource registration closes repeated ownership exactly once', async () => {
  const { ownContextResource } = await loadStorageBoundaries()
  const lifecycle = createBackendLifecycle()
  const ctx = { lifecycle }
  const released = []
  const channel = { async close() { released.push('channel') } }
  ownContextResource(ctx, 'channel before ready', channel)
  ownContextResource(ctx, 'channel after ready', channel)
  ownContextResource(ctx, 'metadata', { async close() { released.push('metadata') } })
  await lifecycle.shutdown()
  await lifecycle.shutdown()
  assert.deepEqual(released, ['metadata', 'channel'])
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




test('warm reconnect dials only the newest bounded peers and stops on shutdown', async () => {
  const { scheduleWarmReconnect } = await loadStorageBoundaries()
  const known = Array.from({ length: 24 }, (_, index) => ({
    key: index.toString(16).padStart(64, '0'), lastSeen: index,
  }))
  const callbacks = []
  const lifecycle = createBackendLifecycle({
    scheduleDeferred: callback => { callbacks.push(callback); return callback },
    cancelDeferred: callback => { callbacks.splice(callbacks.indexOf(callback), 1) },
  })
  const dials = []
  const swarm = { joinPeer: key => { dials.push(key.toString('hex')) } }
  const metaDb = { get: async () => ({ value: known }) }
  scheduleWarmReconnect(swarm, metaDb, lifecycle)
  callbacks.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(dials, known.slice(-16).reverse().map(peer => peer.key))
  scheduleWarmReconnect(swarm, metaDb, lifecycle)
  await lifecycle.shutdown()
  assert.equal(callbacks.length, 0, 'queued reconnect is cancelled before metadata closes')
  assert.equal(dials.length, 16)
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

test('offline swarm fallback skips network discovery at startup', () => {
  assert.match(storageSource, /function createOfflineSwarm/)
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


test('pre-open connection failure remains visible in scoped diagnostic history', async () => {
  const { createSwarmDiagnostics, installSwarmConnectDiagnostics } = await loadStorageBoundaries()
  const raw = new EventEmitter()
  raw.remoteHost = '127.0.0.1'
  raw.remotePort = 49737
  const connection = new EventEmitter()
  connection.rawStream = raw
  connection.remotePublicKey = Buffer.alloc(32, 1)
  const swarm = {
    _allConnections: new ConnectionSet(),
    _connect() {
      this._allConnections.add(connection)
    },
  }
  const diagnostics = createSwarmDiagnostics(swarm)
  installSwarmConnectDiagnostics(swarm, diagnostics)
  installSwarmConnectDiagnostics(swarm, diagnostics)
  swarm._connect({ publicKey: connection.remotePublicKey })
  raw.emit('connect')
  connection.emit('error', Object.assign(new Error('Holepunch aborted'), { code: 'HOLEPUNCH_ABORTED' }))
  raw.destroyed = true
  raw.emit('close')
  connection.destroyed = true
  connection.emit('close')
  const recent = diagnostics.snapshot().recentConnections
  assert.equal(recent.length, 1, 'reinstalling diagnostics does not double-observe a connection')
  assert.equal(recent[0].type, 'client-attempt')
  assert.deepEqual(recent[0].events.map(event => event.event), ['raw-connect', 'error', 'raw-close', 'close'])
  assert.equal(recent[0].events[1].error.code, 'HOLEPUNCH_ABORTED')
  assert.equal(recent[0].stream.rawStream.remoteHost, '127.0.0.1')
  assert.equal(recent[0].stream.rawStream.destroyed, true)
})
