import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'

import { assessDurableManifest } from '../../src/api.js'
import { createContentPublication } from '../../src/content-publication.js'
import { createContentReplication } from '../../src/content-replication.js'
import { createIdentityManager } from '../../src/identity.js'
import { PublicFeed } from '../../src/public-feed.js'
import {
  addRelayLink,
  loadRelayLinks,
  mergeTrustedRelayKeys,
} from '../../src/relay-links.js'
import {
  PinStore,
  PinWorker,
  registerSeedPinProtocol,
  resolveSeedPinClientAuth,
} from '../../src/seed-pin/index.js'

const IPC_LIMIT = 64 * 1024
const DEFAULT_TIMEOUT = 60_000
const SHUTDOWN_TIMEOUT = 10_000
const HEX_KEY = /^[0-9a-f]{64}$/
const FIXTURE_PATH = fileURLToPath(import.meta.url)
const ROW_ID = 'seed-pin-smoke-video'

const PARENT_MESSAGE_FIELDS = Object.freeze({
  'start-relay': ['type', 'requestId', 'uploaderSwarmKey', 'uploaderIdentityKey', 'channelKey'],
  'begin-replication': ['type', 'requestId'],
  'resume-publication': ['type', 'requestId'],
  'restart-orchestration': ['type', 'requestId'],
  'assess-now': ['type', 'requestId'],
  inspect: ['type', 'requestId'],
  'await-complete': ['type', 'requestId'],
  shutdown: ['type'],
})

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactFields (value, expected, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} has unexpected fields`)
  }
}

function boundedJson (value, name) {
  const json = JSON.stringify(value)
  if (json === undefined || Buffer.byteLength(json) > IPC_LIMIT) {
    throw new RangeError(`${name} exceeds the IPC limit`)
  }
  return json
}

function validateParentMessage (message) {
  boundedJson(message, 'parent message')
  const fields = PARENT_MESSAGE_FIELDS[message?.type]
  if (!fields) throw new TypeError('unknown parent message type')
  exactFields(message, fields, `parent message ${message.type}`)
  if (message.type !== 'shutdown' && (!Number.isSafeInteger(message.requestId) || message.requestId <= 0)) {
    throw new TypeError('requestId must be a positive safe integer')
  }
  return message
}

function sendIpc (message) {
  boundedJson(message, 'child message')
  if (typeof process.send !== 'function' || process.connected !== true) return
  process.send(message)
}

function errorMessage (error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2048)
}

function hexKey (value, name) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (!HEX_KEY.test(normalized)) throw new TypeError(`${name} must be a 32-byte lowercase hex key`)
  return normalized
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil (predicate, {
  timeout = DEFAULT_TIMEOUT,
  interval = 20,
  message = 'operation timed out',
} = {}) {
  const deadline = Date.now() + Math.min(DEFAULT_TIMEOUT, timeout)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(interval)
  }
  throw new Error(lastError ? `${message}: ${errorMessage(lastError)}` : message)
}

async function openStorage (storageDir) {
  mkdirSync(storageDir, { recursive: true })
  const store = new Corestore(storageDir)
  await store.ready()
  const metadataCore = store.get({ name: 'seed-pin-smoke-metadata' })
  const metaDb = new Hyperbee(metadataCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await metaDb.ready()
  return { store, metaDb }
}

function loadRelayKeyPair (storageDir) {
  mkdirSync(storageDir, { recursive: true })
  const seedPath = join(storageDir, 'swarm-seed')
  let seed
  try {
    seed = readFileSync(seedPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    seed = randomBytes(32)
    writeFileSync(seedPath, seed, { flag: 'wx', mode: 0o600 })
  }
  if (seed.byteLength !== 32) throw new Error('persisted relay swarm seed must be exactly 32 bytes')
  return DHT.keyPair(seed)
}

function deterministicBlocks (kind, count) {
  return Array.from({ length: count }, (_, index) => {
    const serial = String(index).padStart(2, '0')
    return b4a.from(`${kind}-block-${serial}:${kind[0].repeat(48 + index)}`)
  })
}

function encodeBlocks (blocks) {
  return blocks.map(block => b4a.toString(block, 'base64'))
}

async function readRangeBytes (store, refs) {
  const bytes = { media: [], thumbnail: [] }
  const session = store.session()
  try {
    for (const ref of refs) {
      const core = session.get({ key: b4a.from(ref.coreKey, 'hex') })
      await core.ready()
      const values = []
      for (let index = ref.start; index < ref.end; index++) {
        const block = await core.get(index, { wait: false })
        if (!(block instanceof Uint8Array)) throw new Error(`missing local ${ref.kind} block ${index}`)
        values.push(b4a.toString(block, 'base64'))
      }
      bytes[ref.kind] = values
    }
    return bytes
  } finally {
    await session.close().catch(() => {})
  }
}

async function inspectLocalRanges (store, refs) {
  const ranges = []
  const session = store.session()
  try {
    for (const ref of refs) {
      const core = session.get({ key: b4a.from(ref.coreKey, 'hex') })
      await core.ready()
      const local = await core.has(ref.start, ref.end)
      ranges.push({ ...ref, local: local === true })
    }
  } finally {
    await session.close().catch(() => {})
  }
  return ranges
}

function makeDownloadGate (store, closed) {
  let released = !closed
  let releaseGate = null
  const gate = released
    ? Promise.resolve()
    : new Promise(resolve => { releaseGate = resolve })

  return {
    release () {
      if (released) return
      released = true
      releaseGate()
    },
    corestore: {
      session () {
        const session = store.session()
        return {
          get (options) {
            const core = session.get(options)
            return new Proxy(core, {
              get (target, property) {
                if (property === 'ready') {
                  return async () => {
                    await gate
                    return target.ready()
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
          close: () => session.close(),
        }
      },
    },
  }
}

function attachCorestoreReplication (swarm, store) {
  const onConnection = connection => {
    connection.on('error', () => {})
    try {
      store.replicate(connection)
    } catch (error) {
      sendIpc({ type: 'fatal', error: `Corestore replication failed: ${errorMessage(error)}` })
    }
  }
  swarm.on('connection', onConnection)
  return () => swarm.off('connection', onConnection)
}

async function closeDiscovery (discovery) {
  try { await discovery?.destroy?.() } catch {}
}

async function runRelay (config) {
  const { store, metaDb } = await openStorage(config.storageDir)
  const keyPair = loadRelayKeyPair(config.storageDir)
  const swarmKey = b4a.toString(keyPair.publicKey, 'hex')
  const pinStore = new PinStore({ db: metaDb })
  const gate = makeDownloadGate(store, config.gateDownloads === true)
  const worker = new PinWorker({
    corestore: gate.corestore,
    pinStore,
    concurrency: 1,
    rangeTimeout: 30_000,
    downloadTimeout: 30_000,
  })
  const originalWorkerStart = worker.start.bind(worker)
  let registration = null
  let swarm = null
  let discovery = null
  let detachReplication = null
  let shuttingDown = false
  let expected = null
  let acceptedRequestId = null
  const announcedAcceptances = new Set()

  worker.start = async requestId => {
    const record = await pinStore.getByRequestId(requestId)
    if (record && !announcedAcceptances.has(requestId)) {
      announcedAcceptances.add(requestId)
      acceptedRequestId = requestId
      sendIpc({
        type: 'pin-accepted',
        requestId,
        ownerIdentityKey: record.owner.identityPublicKey,
        ownerDeviceKey: record.owner.devicePublicKey,
      })
    }
    return originalWorkerStart(requestId)
  }

  const inspect = async () => {
    if (!acceptedRequestId) {
      const active = await pinStore.listActive({ limit: 1 })
      acceptedRequestId = active.records?.[0]?.requestId || active[0]?.requestId || null
    }
    if (!acceptedRequestId) throw new Error('relay has no accepted pin')
    const record = await pinStore.getByRequestId(acceptedRequestId)
    if (!record) throw new Error('accepted relay pin is missing')
    const ranges = await inspectLocalRanges(store, record.manifest.refs)
    const complete = record.status.state === 'complete' && ranges.every(range => range.local)
    return {
      status: record.status.state,
      errorCode: record.status.errorCode,
      error: record.status.error,
      progress: record.progress,
      complete,
      ranges,
      bytes: complete ? await readRangeBytes(store, record.manifest.refs) : { media: [], thumbnail: [] },
    }
  }

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await registration?.unregister?.().catch(() => {})
    await worker.stop().catch(() => {})
    gate.release()
    await closeDiscovery(discovery)
    detachReplication?.()
    await swarm?.destroy?.().catch(() => {})
    await metaDb.close().catch(() => {})
    await store.close().catch(() => {})
  }

  sendIpc({ type: 'relay-ready', swarmKey })

  return {
    async handle (message) {
      if (message.type === 'start-relay') {
        if (registration) throw new Error('relay is already started')
        expected = {
          uploaderSwarmKey: hexKey(message.uploaderSwarmKey, 'uploaderSwarmKey'),
          uploaderIdentityKey: hexKey(message.uploaderIdentityKey, 'uploaderIdentityKey'),
          channelKey: hexKey(message.channelKey, 'channelKey'),
        }
        const uploaderPublicKey = b4a.from(expected.uploaderSwarmKey, 'hex')
        swarm = new Hyperswarm({
          bootstrap: [config.bootstrap],
          keyPair,
          firewall: remotePublicKey => !b4a.equals(remotePublicKey, uploaderPublicKey),
        })
        detachReplication = attachCorestoreReplication(swarm, store)
        swarm.on('connection', connection => {
          sendIpc({ type: 'peer-connected', remoteKey: b4a.toString(connection.remotePublicKey, 'hex') })
        })
        const ctx = { store, metaDb, swarm, seedPinClients: new Map() }
        registration = registerSeedPinProtocol(ctx, {
          store: pinStore,
          worker,
          admission: async ({ owner, verified }) => {
            return owner.identityPublicKey === expected.uploaderIdentityKey &&
              owner.devicePublicKey === expected.uploaderSwarmKey &&
              verified.manifest.channelKey === expected.channelKey
          },
          capacity: async () => true,
          onError: error => sendIpc({ type: 'fatal', error: `relay registration failed: ${errorMessage(error)}` }),
        })
        await registration.ready
        await swarm.listen()
        discovery = swarm.join(b4a.from(config.topic, 'hex'), { server: true, client: true })
        swarm.joinPeer(uploaderPublicKey)
        await discovery.flushed()
        sendIpc({ type: 'relay-started', replyTo: message.requestId })
        return
      }
      if (message.type === 'inspect') {
        sendIpc({ type: 'relay-inspection', replyTo: message.requestId, ...(await inspect()) })
        return
      }
      if (message.type === 'await-complete') {
        let lastState = null
        try {
          const state = await waitUntil(async () => {
            lastState = await inspect()
            return lastState.complete ? lastState : null
          }, { timeout: 20_000, message: 'relay pin did not complete' })
          sendIpc({ type: 'relay-inspection', replyTo: message.requestId, ...state })
        } catch (error) {
          throw new Error(`${errorMessage(error)}; state=${JSON.stringify(lastState)}`)
        }
        return
      }
      throw new Error(`unsupported relay command ${message.type}`)
    },
    shutdown,
  }
}

async function collectAssessmentEvidence (refs, relayKey, cores) {
  const observations = []
  let intersection = null
  for (const ref of refs) {
    const core = cores.get(ref.coreKey)
    if (!core) throw new Error(`uploader core unavailable for ${ref.kind}`)
    await core.ready()
    const holders = []
    const peers = []
    for (const peer of core.peers || []) {
      const firstUnset = peer?.remoteBitfield?.firstUnset
      const remoteKey = peer?.remotePublicKey instanceof Uint8Array && peer.remotePublicKey.byteLength === 32
        ? b4a.toString(peer.remotePublicKey, 'hex')
        : null
      peers.push({
        remoteKey,
        firstUnset: typeof firstUnset === 'function'
          ? firstUnset.call(peer.remoteBitfield, ref.start)
          : null,
        remoteContiguousLength: Number.isSafeInteger(peer?.remoteContiguousLength)
          ? peer.remoteContiguousLength
          : null,
      })
      const remotePublicKey = peer?.remotePublicKey
      if (!(remotePublicKey instanceof Uint8Array) || remotePublicKey.byteLength !== 32) continue
      if (typeof firstUnset !== 'function') continue
      const missing = firstUnset.call(peer.remoteBitfield, ref.start)
      if (Number.isSafeInteger(missing) && missing >= ref.end) {
        holders.push(b4a.toString(remotePublicKey, 'hex'))
      }
    }
    holders.sort()
    observations.push({ ...ref, holders, peers })
    const current = new Set(holders)
    if (intersection === null) intersection = current
    else for (const key of intersection) if (!current.has(key)) intersection.delete(key)
  }
  const fullCopyHolders = [...(intersection || new Set())].sort()
  return {
    livePeerKey: fullCopyHolders.includes(relayKey) ? relayKey : null,
    fullCopyHolders,
    refs: observations,
  }
}

async function runUploader (config) {
  const relayKey = hexKey(config.relayKey, 'relayKey')
  const { store, metaDb } = await openStorage(config.storageDir)
  const swarm = new Hyperswarm({
    bootstrap: [config.bootstrap],
    keyPair: DHT.keyPair(),
    firewall: remotePublicKey => b4a.toString(remotePublicKey, 'hex') !== relayKey,
  })
  const ctx = {
    store,
    metaDb,
    swarm,
    channels: new Map(),
    seedPinClients: new Map(),
    metaSubspaces: {
      channelKinds: { async put () {} },
      publicProjectionStates: metaDb,
    },
  }
  let registration = null
  let discovery = null
  let detachReplication = null
  let feed = null
  let channel = null
  let mediaCore = null
  let thumbnailCore = null
  let replication = null
  let replicationInput = null
  let initialRun = null
  let shuttingDown = false
  let finalizeCalls = 0
  let lastAssessment = null

  await addRelayLink(metaDb, { mirrorKey: relayKey, label: 'integration relay' })
  const persistedLinks = await loadRelayLinks(metaDb)
  const trustedRelayKeys = mergeTrustedRelayKeys([], persistedLinks)
  ctx.trustedRelayKeys = new Set(trustedRelayKeys)

  detachReplication = attachCorestoreReplication(swarm, store)
  swarm.on('connection', connection => {
    sendIpc({ type: 'peer-connected', remoteKey: b4a.toString(connection.remotePublicKey, 'hex') })
  })

  const identityManager = createIdentityManager({ ctx })
  const created = await identityManager.createIdentity('Seed Pin Smoke', false, { deferPublicProjection: true })
  channel = ctx.channels.get(created.driveKey)
  if (!channel) throw new Error('created private channel is unavailable')

  mediaCore = store.get({ name: 'seed-pin-smoke-media' })
  thumbnailCore = store.get({ name: 'seed-pin-smoke-thumbnail' })
  await Promise.all([mediaCore.ready(), thumbnailCore.ready()])
  const mediaBlocks = deterministicBlocks('media', 8)
  const thumbnailBlocks = deterministicBlocks('thumbnail', 3)
  if (mediaCore.length === 0) await mediaCore.append(mediaBlocks)
  if (thumbnailCore.length === 0) await thumbnailCore.append(thumbnailBlocks)
  const refs = [
    {
      coreKey: b4a.toString(mediaCore.key, 'hex'),
      start: 2,
      end: mediaBlocks.length,
      kind: 'media',
    },
    {
      coreKey: b4a.toString(thumbnailCore.key, 'hex'),
      start: 1,
      end: thumbnailBlocks.length,
      kind: 'thumbnail',
    },
  ]
  const coreByKey = new Map([
    [refs[0].coreKey, mediaCore],
    [refs[1].coreKey, thumbnailCore],
  ])
  const bytes = {
    media: encodeBlocks(mediaBlocks.slice(refs[0].start, refs[0].end)),
    thumbnail: encodeBlocks(thumbnailBlocks.slice(refs[1].start, refs[1].end)),
  }

  await channel.addVideo({
    id: ROW_ID,
    title: 'Deterministic seed pin smoke',
    uploadedAt: 1,
    publicationState: 'replicationPending',
    blobsCoreKey: refs[0].coreKey,
    thumbnailBlobsCoreKey: refs[1].coreKey,
  })

  feed = new PublicFeed(swarm, metaDb)
  const realPublication = createContentPublication({ channel, publicFeed: feed })
  const publication = {
    markDurabilityVerified: (...args) => realPublication.markDurabilityVerified(...args),
    project: (...args) => realPublication.project(...args),
    announce: (...args) => realPublication.announce(...args),
    async finalize (...args) {
      finalizeCalls++
      return realPublication.finalize(...args)
    },
  }

  registration = registerSeedPinProtocol(ctx, {
    admission: async () => false,
    resolveClientAuth: () => resolveSeedPinClientAuth({ ctx, identityManager }),
    onError: error => sendIpc({ type: 'fatal', error: `uploader registration failed: ${errorMessage(error)}` }),
    pinWorkerOptions: {
      concurrency: 1,
      rangeTimeout: 30_000,
      downloadTimeout: 30_000,
    },
  })
  await registration.ready

  const clientAuth = await resolveSeedPinClientAuth({ ctx, identityManager })
  const deviceProof = clientAuth?.deviceProof
  if (!(deviceProof instanceof Uint8Array)) throw new Error('validated active identity device proof is unavailable')
  replicationInput = {
    channelKey: channel.keyHex,
    rowId: ROW_ID,
    refs,
    assets: {
      media: [0],
      thumbnail: 1,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
    totalBytes: [
      ...mediaBlocks.slice(refs[0].start, refs[0].end),
      ...thumbnailBlocks.slice(refs[1].start, refs[1].end),
    ].reduce((sum, block) => sum + block.byteLength, 0),
    expiresAt: Date.now() + 45_000,
    deviceKeyPair: swarm.keyPair,
    deviceProof,
    signedDescriptor: created.signedDescriptor,
    idempotencyKey: 'seed-pin-smoke-publication',
    stagedDescriptor: created.signedDescriptor,
  }

  const checkpointKey = `seed-pin-smoke/checkpoint/${channel.keyHex}/${ROW_ID}`
  const runAssessment = async (assessmentRefs = refs, trust = {
    trustedRelayKeys: [...ctx.trustedRelayKeys],
    pairedDeviceKeys: [],
    ordinaryRequired: 2,
  }, deps = { store }) => {
    const assessment = await assessDurableManifest(assessmentRefs, trust, deps)
    const evidence = await collectAssessmentEvidence(assessmentRefs, relayKey, coreByKey)
    lastAssessment = { ...evidence, ...assessment }
    return assessment
  }
  const createReplication = () => createContentReplication({
    publication,
    clients: ctx.seedPinClients,
    assessDurability: runAssessment,
    assessmentDeps: { store },
    getTrustedRelayKeys: () => [...ctx.trustedRelayKeys],
    getPairedDeviceKeys: () => [],
    async readCheckpoint () {
      return (await metaDb.get(checkpointKey))?.value || null
    },
    async writeCheckpoint (next, { expectedRevision }) {
      const current = (await metaDb.get(checkpointKey))?.value || null
      const currentRevision = current?.revision ?? null
      if (currentRevision !== expectedRevision) return false
      await metaDb.put(checkpointKey, next)
      return next
    },
    ordinaryRequired: 2,
    maxClients: 4,
    maxStatusAttempts: 1,
    maxPeerConcurrency: 1,
    maxConcurrentRows: 1,
    pollIntervalMs: 20,
    requestTimeoutMs: 5_000,
    operationTimeoutMs: 15_000,
  })
  replication = createReplication()

  await swarm.listen()
  discovery = swarm.join(b4a.from(config.topic, 'hex'), { server: true, client: true })
  for (const key of trustedRelayKeys) swarm.joinPeer(b4a.from(key, 'hex'))
  await discovery.flushed()

  const inspect = async () => {
    const privateVideo = await channel.getVideo(ROW_ID)
    const publicVideos = await channel.publicBee.listVideos()
    return {
      privateState: privateVideo?.publicationState || null,
      publicVideoCount: publicVideos.length,
      publicFeedCount: feed.getFeed().length,
      finalizeCalls,
      bytes: await readRangeBytes(store, refs),
    }
  }

  const runUntilPublished = async () => waitUntil(async () => {
    const result = await replication.replicate(replicationInput)
    return result.status === 'published' ? result : null
  }, { timeout: 20_000, interval: 30, message: `content did not publish; assessment=${JSON.stringify(lastAssessment)}` })

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await Promise.resolve(initialRun).catch(() => {})
    await registration?.unregister?.().catch(() => {})
    await closeDiscovery(discovery)
    detachReplication?.()
    await swarm.destroy().catch(() => {})
    feed?.stop?.()
    for (const cachedChannel of new Set(ctx.channels.values())) {
      await cachedChannel.close().catch(() => {})
    }
    await mediaCore?.close?.().catch(() => {})
    await thumbnailCore?.close?.().catch(() => {})
    await metaDb.close().catch(() => {})
    await store.close().catch(() => {})
  }

  const initial = await inspect()
  sendIpc({
    type: 'uploader-ready',
    swarmKey: b4a.toString(swarm.keyPair.publicKey, 'hex'),
    identityKey: created.publicKey,
    channelKey: channel.keyHex,
    trustedRelayKeys,
    dialedRelayKeys: [...trustedRelayKeys],
    refs,
    bytes,
    ...initial,
  })

  return {
    async handle (message) {
      if (message.type === 'begin-replication') {
        if (initialRun) throw new Error('initial replication already started')
        sendIpc({ type: 'replication-started', replyTo: message.requestId })
        initialRun = replication.replicate(replicationInput)
        void initialRun.then(
          result => sendIpc({ type: 'replication-result', result }),
          error => sendIpc({ type: 'fatal', error: `initial replication failed: ${errorMessage(error)}` }),
        )
        return
      }
      if (message.type === 'inspect') {
        sendIpc({ type: 'uploader-inspection', replyTo: message.requestId, ...(await inspect()) })
        return
      }
      if (message.type === 'assess-now') {
        await runAssessment()
        sendIpc({ type: 'assessment-observed', replyTo: message.requestId, assessment: lastAssessment })
        return
      }
      if (message.type === 'resume-publication') {
        if (initialRun) await initialRun
        const result = await runUntilPublished()
        sendIpc({
          type: 'publication-result',
          replyTo: message.requestId,
          result,
          assessment: lastAssessment,
        })
        return
      }
      if (message.type === 'restart-orchestration') {
        replication = createReplication()
        const result = await runUntilPublished()
        sendIpc({
          type: 'publication-result',
          replyTo: message.requestId,
          result,
          assessment: lastAssessment,
        })
        return
      }
      throw new Error(`unsupported uploader command ${message.type}`)
    },
    shutdown,
  }
}

async function runChild () {
  const role = process.argv[2]
  const config = JSON.parse(process.argv[3] || '{}')
  exactFields(config, role === 'relay'
    ? ['storageDir', 'bootstrap', 'topic', 'gateDownloads']
    : ['storageDir', 'bootstrap', 'topic', 'relayKey'], 'child config')
  if (!['relay', 'uploader'].includes(role)) throw new Error('unknown seed-pin smoke child role')
  if (typeof config.storageDir !== 'string' || config.storageDir.length === 0) throw new TypeError('storageDir is required')
  if (typeof config.bootstrap !== 'string' || config.bootstrap.length === 0) throw new TypeError('bootstrap is required')
  hexKey(config.topic, 'topic')

  let runtime = null
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await runtime?.shutdown?.()
  }
  const fatal = async error => {
    try { sendIpc({ type: 'fatal', error: errorMessage(error) }) } catch {}
    await shutdown().catch(() => {})
    setImmediate(() => {
      process.exitCode = 1
      process.disconnect?.()
    })
  }

  process.on('unhandledRejection', fatal)
  process.on('uncaughtException', fatal)
  runtime = role === 'relay' ? await runRelay(config) : await runUploader(config)

  let commandTail = Promise.resolve()
  process.on('message', rawMessage => {
    commandTail = commandTail.then(async () => {
      const message = validateParentMessage(rawMessage)
      if (message.type === 'shutdown') {
        await shutdown()
        sendIpc({ type: 'closed' })
        setImmediate(() => process.disconnect?.())
        return
      }
      try {
        await runtime.handle(message)
      } catch (error) {
        sendIpc({ type: 'command-error', replyTo: message.requestId, error: errorMessage(error) })
      }
    }).catch(fatal)
  })
}

class SmokeChild {
  constructor (child, { role, timeout }) {
    this.child = child
    this.role = role
    this.timeout = Math.min(DEFAULT_TIMEOUT, timeout)
    this.stderr = ''
    this.messages = []
    this.waiters = new Set()
    this.nextRequestId = 1
    this.exited = false
    this.exitError = null

    child.stderr?.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-IPC_LIMIT)
    })
    child.on('message', message => this._onMessage(message))
    child.once('error', error => this._onExit(new Error(`${role} child error: ${errorMessage(error)}`)))
    child.once('exit', (code, signal) => {
      const suffix = this.stderr ? `\n${role} stderr:\n${this.stderr}` : ''
      const error = code === 0 || code === null && signal === null
        ? null
        : new Error(`${role} child exited code=${code} signal=${signal}${suffix}`)
      this._onExit(error)
    })
  }

  _onMessage (message) {
    try { boundedJson(message, `${this.role} child message`) } catch (error) {
      this._onExit(error)
      this.child.kill('SIGKILL')
      return
    }
    if (message?.type === 'fatal') {
      const suffix = this.stderr ? `\n${this.role} stderr:\n${this.stderr}` : ''
      this._onExit(new Error(`${this.role} fatal: ${message.error}${suffix}`))
      return
    }
    for (const waiter of this.waiters) {
      if ((waiter.type !== '*' && waiter.type !== message?.type) || !waiter.predicate(message)) continue
      this.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
      return
    }
    this.messages.push(message)
  }

  _onExit (error) {
    if (this.exited) return
    this.exited = true
    this.exitError = error
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error || new Error(`${this.role} child exited before ${waiter.type}`))
    }
    this.waiters.clear()
  }

  waitFor (type, predicate = () => true, timeout = this.timeout) {
    if (typeof predicate !== 'function') throw new TypeError('message predicate must be a function')
    const index = this.messages.findIndex(message =>
      (type === '*' || message?.type === type) && predicate(message))
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0])
    if (this.exitError) return Promise.reject(this.exitError)
    if (this.exited) return Promise.reject(new Error(`${this.role} child already exited`))
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        const suffix = this.stderr ? `\n${this.role} stderr:\n${this.stderr}` : ''
        reject(new Error(`timed out waiting for ${roleLabel(this.role, type)}${suffix}`))
      }, Math.min(DEFAULT_TIMEOUT, timeout))
      this.waiters.add(waiter)
    })
  }

  send (type, payload = {}) {
    if (this.exited || !this.child.connected) throw this.exitError || new Error(`${this.role} child is not connected`)
    const message = { type, ...payload }
    boundedJson(message, 'parent request')
    this.child.send(message)
  }

  async request (type, payload, responseType, timeout = this.timeout) {
    const requestId = this.nextRequestId++
    const response = this.waitFor(
      '*',
      message => message.replyTo === requestId &&
        (message.type === responseType || message.type === 'command-error'),
      timeout,
    )
    this.send(type, { requestId, ...payload })
    const message = await response
    if (message.type === 'command-error') {
      throw new Error(`${this.role} command ${type} failed: ${message.error}`)
    }
    return message
  }

  async close () {
    if (this.exited) {
      if (this.exitError) throw this.exitError
      return
    }
    if (this.child.connected) this.send('shutdown')
    try {
      await this.waitFor('closed', () => true, SHUTDOWN_TIMEOUT)
    } catch (error) {
      this.child.kill('SIGKILL')
      throw error
    }
    await new Promise((resolve, reject) => {
      if (this.exited) return this.exitError ? reject(this.exitError) : resolve()
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        reject(new Error(`${this.role} child did not exit after shutdown`))
      }, SHUTDOWN_TIMEOUT)
      this.child.once('exit', () => {
        clearTimeout(timer)
        this.exitError ? reject(this.exitError) : resolve()
      })
    })
  }
}

function roleLabel (role, type) {
  return `${role} ${type}`
}

export function randomTopic () {
  return randomBytes(32).toString('hex')
}

async function reserveUdpPort () {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

export async function startLocalDhtBootstrap ({
  timeout = DEFAULT_TIMEOUT,
  bootstrapper = DHT.bootstrapper,
} = {}) {
  if (typeof bootstrapper !== 'function') throw new TypeError('bootstrapper must be a function')
  const port = await reserveUdpPort()
  const node = bootstrapper.call(DHT, port, '127.0.0.1', { host: '127.0.0.1' })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('local DHT bootstrap timed out')),
        Math.min(DEFAULT_TIMEOUT, timeout),
      )
      node.ready().then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  } catch (error) {
    await node.destroy?.({ force: true }).catch(() => {})
    throw error
  }
  let closed = false
  return {
    address: `127.0.0.1:${port}`,
    async close () {
      if (closed) return
      closed = true
      await node.destroy({ force: true })
    },
  }
}

export async function spawnSeedPinSmokeChild ({
  role,
  storageDir,
  bootstrap,
  topic,
  relayKey,
  gateDownloads = false,
  timeout = DEFAULT_TIMEOUT,
} = {}) {
  if (!['relay', 'uploader'].includes(role)) throw new TypeError('role must be relay or uploader')
  if (typeof storageDir !== 'string' || storageDir.length === 0) throw new TypeError('storageDir is required')
  if (typeof bootstrap !== 'string' || bootstrap.length === 0) throw new TypeError('bootstrap is required')
  hexKey(topic, 'topic')
  const config = role === 'relay'
    ? { storageDir, bootstrap, topic, gateDownloads: gateDownloads === true }
    : { storageDir, bootstrap, topic, relayKey: hexKey(relayKey, 'relayKey') }
  boundedJson(config, 'child config')
  const child = fork(FIXTURE_PATH, [role, JSON.stringify(config)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
  })
  return new SmokeChild(child, { role, timeout })
}

if (process.argv[1] === FIXTURE_PATH && ['relay', 'uploader'].includes(process.argv[2])) {
  runChild().catch(async error => {
    try { sendIpc({ type: 'fatal', error: errorMessage(error) }) } catch {}
    process.exitCode = 1
    setImmediate(() => process.disconnect?.())
  })
}
