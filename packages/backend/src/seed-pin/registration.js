import b4a from 'b4a'
import Protomux from 'protomux'

import { verifySignedChannelRootDescriptor } from '../channel-descriptor.js'
import { SeedPinClient } from './client.js'
import { PinStore } from './pin-store.js'
import { PinWorker } from './pin-worker.js'
import { SeedPinVerificationLimiter } from './protocol.js'
import { SeedPinServer } from './server.js'

const HEX_32 = /^[0-9a-f]{64}$/
const INITIATOR_CHANNEL_ID = b4a.from('peartube.seed-pin/initiator')
const RESPONDER_CHANNEL_ID = b4a.from('peartube.seed-pin/responder')

function isValidKeyPair(keyPair) {
  const publicKey = keyPair?.publicKey
  const secretKey = keyPair?.secretKey
  const validPub = (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array) && publicKey.byteLength === 32
  const validSec = (b4a.isBuffer(secretKey) || secretKey instanceof Uint8Array) && secretKey.byteLength === 64
  return validPub && validSec
}

function isValidDeviceProof(deviceProof) {
  return (b4a.isBuffer(deviceProof) || deviceProof instanceof Uint8Array) && deviceProof.byteLength > 0
}

function matchesDescriptorVerification(verification, candidate, devicePublicKey) {
  if (verification?.valid !== true) return false
  if (verification.identityPublicKey !== candidate.identityPublicKey) return false
  if (verification.devicePublicKey !== devicePublicKey) return false
  if (verification.descriptor?.identityPublicKey !== candidate.identityPublicKey) return false
  if (verification.descriptor?.channelId !== candidate.channelKey) return false
  return true
}

function validateSeedPinFactories(options) {
  const protomuxFrom = options.protomuxFrom || Protomux.from
  const serverFactory = options.serverFactory || ((mux, serverOptions) => new SeedPinServer(mux, serverOptions))
  const clientFactory = options.clientFactory || ((mux, clientOptions) => new SeedPinClient(mux, clientOptions))
  if (typeof protomuxFrom !== 'function') throw new TypeError('protomuxFrom must be a function')
  if (typeof serverFactory !== 'function') throw new TypeError('serverFactory must be a function')
  if (typeof clientFactory !== 'function') throw new TypeError('clientFactory must be a function')
  return { protomuxFrom, serverFactory, clientFactory }
}

function initSeedPinStoresAndWorker(ctx, options) {
  const ownsStore = options.store === undefined
  const pinStoreFactory = options.pinStoreFactory || (storeOptions => new PinStore(storeOptions))
  const pinStore = ownsStore
    ? pinStoreFactory({ db: ctx.metaDb, ...(options.pinStoreOptions || {}) })
    : options.store
  if (!pinStore) throw new TypeError('seed pin store is required')

  const pinWorkerOptions = typeof options.pinWorkerOptions === 'function'
    ? options.pinWorkerOptions(pinStore)
    : (options.pinWorkerOptions || {})
  if (!pinWorkerOptions || typeof pinWorkerOptions !== 'object' || Array.isArray(pinWorkerOptions)) {
    throw new TypeError('pinWorkerOptions must resolve to an object')
  }

  const ownsWorker = options.worker === undefined
  const pinWorkerFactory = options.pinWorkerFactory || (workerOptions => new PinWorker(workerOptions))
  const worker = ownsWorker
    ? pinWorkerFactory({
        corestore: ctx.store,
        pinStore,
        ...pinWorkerOptions,
      })
    : options.worker
  if (!worker || typeof worker.resume !== 'function') throw new TypeError('seed pin worker must provide resume()')

  return { pinStore, ownsStore, worker, ownsWorker }
}

export async function resolveSeedPinClientAuth ({
  ctx,
  identityManager,
  verifySignedDescriptor = verifySignedChannelRootDescriptor,
} = {}) {
  try {
    if (typeof identityManager?.getActiveSeedPinCandidate !== 'function' ||
        typeof verifySignedDescriptor !== 'function') return null
    const candidate = identityManager.getActiveSeedPinCandidate()
    if (!candidate) return null
    const keyPair = ctx?.swarm?.keyPair
    if (!isValidKeyPair(keyPair)) return null
    if (!isValidDeviceProof(candidate.deviceProof)) return null

    const verification = await verifySignedDescriptor(candidate.signedDescriptor)
    const devicePublicKey = b4a.toString(keyPair.publicKey, 'hex')
    if (!matchesDescriptorVerification(verification, candidate, devicePublicKey)) {
      return null
    }
    const storedProof = b4a.from(candidate.signedDescriptor.proof, 'hex')
    if (!b4a.equals(storedProof, candidate.deviceProof)) return null
    return {
      identityPublicKey: candidate.identityPublicKey,
      deviceKeyPair: keyPair,
      deviceProof: candidate.deviceProof,
      signedDescriptor: candidate.signedDescriptor,
    }
  } catch {
    return null
  }
}

/**
 * Attach the seed-pin receiver and, when local signing credentials are present,
 * a sender to every authenticated swarm stream. Corestore replication already
 * owns the stream; this registration only opens a sibling Protomux channel.
 */
export function registerSeedPinProtocol (ctx, options = {}) {
  if (options.enabled === false) return disabledRegistration()
  if (!ctx?.swarm || typeof ctx.swarm.on !== 'function') {
    throw new TypeError('ctx.swarm must be an event emitter')
  }

  const { protomuxFrom, serverFactory, clientFactory } = validateSeedPinFactories(options)
  const { pinStore, ownsStore, worker, ownsWorker } = initSeedPinStoresAndWorker(ctx, options)

  const verificationLimiter = options.verificationLimiter || new SeedPinVerificationLimiter(
    options.verificationLimiterOptions,
  )
  const clientAuthResolver = options.resolveClientAuth || null
  if (clientAuthResolver !== null && typeof clientAuthResolver !== 'function') {
    throw new TypeError('resolveClientAuth must be a function')
  }
  let currentClientAuth = normalizeClientAuth(options.clientAuth)
  let currentClientAuthFingerprint = fingerprintClientAuth(currentClientAuth)
  const clients = ctx.seedPinClients instanceof Map ? ctx.seedPinClients : new Map()
  ctx.seedPinClients = clients
  let closed = false
  const records = new Set()
  const pendingConnections = new Map()
  const connectionRecords = new WeakMap()
  const muxRecords = new WeakMap()
  const clientRecordsByRemote = new Map()
  let resumeError = null
  let refreshTail = Promise.resolve()

  const reportError = error => {
    resumeError = error
    if (typeof options.onError === 'function') {
      try { options.onError(error) } catch (callbackError) { resumeError = callbackError }
    }
  }

  const removeListener = (emitter, event, listener) => {
    if (typeof emitter?.off === 'function') emitter.off(event, listener)
    else emitter?.removeListener?.(event, listener)
  }

  const clearPending = connection => {
    const pending = pendingConnections.get(connection)
    if (!pending) return
    pendingConnections.delete(connection)
    removeListener(connection, 'open', pending.onOpen)
    removeListener(connection, 'close', pending.onClose)
    removeListener(connection, 'end', pending.onClose)
  }

  const refreshExposedClient = remoteKeyHex => {
    const remoteRecords = clientRecordsByRemote.get(remoteKeyHex)
    if (!remoteRecords || remoteRecords.size === 0) {
      clientRecordsByRemote.delete(remoteKeyHex)
      clients.delete(remoteKeyHex)
      return
    }
    let selected = null
    for (const record of remoteRecords) selected = record.client
    if (selected) clients.set(remoteKeyHex, selected)
    else clients.delete(remoteKeyHex)
  }

  const closeClient = record => {
    if (!record?.client) return
    const remoteRecords = clientRecordsByRemote.get(record.remoteKeyHex)
    if (remoteRecords) remoteRecords.delete(record)
    const client = record.client
    record.client = null
    try { client.close?.() } catch (error) { reportError(error) }
    refreshExposedClient(record.remoteKeyHex)
  }

  const openClient = (record, auth) => {
    if (closed || record.closed || record.client || auth === null) return
    try {
      const client = clientFactory(record.mux, {
        ...auth,
        ...(options.clientOptions || {}),
        channelId: record.clientChannelId,
      })
      if (!client) throw new Error('seed pin client factory returned no client')
      record.client = client
      let remoteRecords = clientRecordsByRemote.get(record.remoteKeyHex)
      if (!remoteRecords) {
        remoteRecords = new Set()
        clientRecordsByRemote.set(record.remoteKeyHex, remoteRecords)
      }
      remoteRecords.add(record)
      refreshExposedClient(record.remoteKeyHex)
    } catch (error) {
      reportError(error)
    }
  }

  const updateClient = (record, auth) => {
    if (!record.client) {
      if (auth !== null) openClient(record, auth)
      return
    }
    const remoteRecords = clientRecordsByRemote.get(record.remoteKeyHex)
    if (auth === null) {
      if (remoteRecords) remoteRecords.delete(record)
    } else {
      let activeRecords = remoteRecords
      if (!activeRecords) {
        activeRecords = new Set()
        clientRecordsByRemote.set(record.remoteKeyHex, activeRecords)
      }
      activeRecords.add(record)
    }
    try {
      record.client.updateAuth(auth)
    } catch (error) {
      reportError(error)
      try {
        record.client.updateAuth(null)
      } catch {
        // Best-effort auth revert: the update above already failed, and there
        // is no safer state to force the client into.
      }
      clientRecordsByRemote.get(record.remoteKeyHex)?.delete(record)
    }
    refreshExposedClient(record.remoteKeyHex)
  }

  const closeRecord = record => {
    if (!record || record.closed) return
    record.closed = true
    records.delete(record)
    connectionRecords.delete(record.connection)
    record.muxRecordMap.delete(record.remoteKeyHex)
    removeListener(record.connection, 'close', record.onClose)
    removeListener(record.connection, 'end', record.onClose)
    closeClient(record)
    try { record.server?.close?.() } catch (error) { reportError(error) }
  }

  const refreshClientAuth = ({ failClosed = false } = {}) => {
    if (closed) return Promise.resolve(null)
    const refresh = refreshTail.then(async () => {
      let nextAuth = currentClientAuth
      if (failClosed === true) nextAuth = null
      else if (clientAuthResolver !== null) {
        try {
          nextAuth = normalizeClientAuth(await clientAuthResolver())
        } catch (error) {
          reportError(error)
          nextAuth = null
        }
      }
      if (closed) return null
      const nextFingerprint = fingerprintClientAuth(nextAuth)
      if (nextFingerprint !== currentClientAuthFingerprint) {
        currentClientAuth = nextAuth
        currentClientAuthFingerprint = nextFingerprint
        for (const record of records) updateClient(record, currentClientAuth)
      } else if (currentClientAuth !== null) {
        for (const record of records) {
          if (!record.client) openClient(record, currentClientAuth)
        }
      }
      return currentClientAuth
    }).catch(error => {
      reportError(error)
      if (!closed) {
        for (const record of records) updateClient(record, null)
        currentClientAuth = null
        currentClientAuthFingerprint = null
      }
      return null
    })
    refreshTail = refresh
    return refresh
  }

  const deferPendingConnection = connection => {
    if (pendingConnections.has(connection) || typeof connection?.on !== 'function') return
    const onOpen = () => {
      clearPending(connection)
      try { attach(connection) } catch (error) { reportError(error) }
    }
    const onClose = () => clearPending(connection)
    pendingConnections.set(connection, { onOpen, onClose })
    connection.once?.('open', onOpen)
    connection.once?.('close', onClose)
    connection.once?.('end', onClose)
  }

  const createRecord = (connection, mux, muxRecordMap, remoteKeyHex, remotePublicKey) => {
    const record = {
      connection,
      mux,
      muxRecordMap,
      remoteKeyHex,
      remotePublicKey,
      server: null,
      client: null,
      closed: false,
      clientChannelId: connection.isInitiator === true ? INITIATOR_CHANNEL_ID : RESPONDER_CHANNEL_ID,
    }
    record.onClose = () => closeRecord(record)
    records.add(record)
    connectionRecords.set(connection, record)
    muxRecordMap.set(remoteKeyHex, record)
    connection.once?.('close', record.onClose)
    connection.once?.('end', record.onClose)
    return record
  }

  const startRecordServer = record => {
    const localInitiator = record.connection.isInitiator === true
    const serverChannelId = localInitiator ? RESPONDER_CHANNEL_ID : INITIATOR_CHANNEL_ID
    try {
      record.server = serverFactory(record.mux, {
        remotePublicKey: record.remotePublicKey,
        store: pinStore,
        worker,
        admission: options.admission,
        capacity: options.capacity,
        verificationLimiter,
        ...(options.serverOptions || {}),
        channelId: serverChannelId,
      })
      if (!record.server) throw new Error('seed pin server factory returned no server')
      if (clientAuthResolver === null) openClient(record, currentClientAuth)
      else void refreshClientAuth()
      return record
    } catch (error) {
      closeRecord(record)
      throw error
    }
  }

  const attach = connection => {
    if (closed || !connection || connection.destroyed) return null
    const existingForConnection = connectionRecords.get(connection)
    if (existingForConnection) return existingForConnection
    const remotePublicKey = exactRemotePublicKey(connection.remotePublicKey)
    if (remotePublicKey === null) {
      deferPendingConnection(connection)
      return null
    }
    clearPending(connection)

    const remoteKeyHex = b4a.toString(remotePublicKey, 'hex')
    const mux = protomuxFrom(connection)
    if (!mux) throw new Error('Protomux is unavailable for seed pin connection')
    let muxRecordMap = muxRecords.get(mux)
    if (!muxRecordMap) {
      muxRecordMap = new Map()
      muxRecords.set(mux, muxRecordMap)
    }
    const existingForMux = muxRecordMap.get(remoteKeyHex)
    if (existingForMux) {
      connectionRecords.set(connection, existingForMux)
      if (clientAuthResolver !== null) void refreshClientAuth()
      return existingForMux
    }

    const record = createRecord(connection, mux, muxRecordMap, remoteKeyHex, remotePublicKey)
    return startRecordServer(record)
  }

  const onConnection = connection => {
    try { attach(connection) } catch (error) { reportError(error) }
  }
  ctx.swarm.on('connection', onConnection)

  const cleanupAll = (stopAsync = false) => {
    removeListener(ctx.swarm, 'connection', onConnection)
    for (const record of [...records]) closeRecord(record)
    for (const connection of [...pendingConnections.keys()]) clearPending(connection)
    if (stopAsync) {
      return (async () => {
        if (ownsWorker && typeof worker.stop === 'function') await worker.stop()
        if (ownsStore && typeof pinStore.close === 'function') await pinStore.close()
      })()
    }
    if (ownsWorker) void Promise.resolve(worker.stop?.()).catch(reportError)
    if (ownsStore) void Promise.resolve(pinStore.close?.()).catch(reportError)
  }

  try {
    for (const connection of ctx.swarm.connections || []) attach(connection)
  } catch (error) {
    cleanupAll(false)
    throw error
  }

  const registration = {
    enabled: true,
    store: pinStore,
    worker,
    verificationLimiter,
    get clientAuth () { return currentClientAuth },
    clients,
    get error () { return resumeError },
    refreshClientAuth,
    async unregister () {
      if (closed) return
      closed = true
      await cleanupAll(true)
    },
  }
  registration.ready = Promise.resolve().then(async () => {
    await worker.capacityPolicy?.ready
    await worker.resume()
    return registration
  }).catch(async error => {
    reportError(error)
    await registration.unregister().catch(reportError)
    throw error
  })
  return registration
}

const IDENTITY_MUTATIONS = Object.freeze([
  Object.freeze({ method: 'setActiveIdentity', label: 'Active identity', reconcile: false }),
  Object.freeze({ method: 'createIdentity', label: 'New identity', reconcile: true }),
  Object.freeze({ method: 'createSourceIdentity', label: 'Source identity', reconcile: true }),
  Object.freeze({ method: 'recoverIdentity', label: 'Recovered identity', reconcile: true }),
  Object.freeze({ method: 'addPairedChannelIdentity', label: 'Paired identity', reconcile: false }),
  Object.freeze({ method: 'bootstrapDevice', label: 'Device proof', reconcile: false }),
  Object.freeze({ method: 'ensureSignedChannelDescriptors', label: 'Channel descriptors', reconcile: false }),
])

async function captureIdentityState(identityManager) {
  const previousState = typeof identityManager.createQueuedStateSnapshot === 'function'
    ? await identityManager.createQueuedStateSnapshot()
    : (identityManager.createStateSnapshot?.() || null)
  const previousPublicKey = previousState?.activeIdentity ??
    identityManager.getActivePublicKey?.() ??
    null
  return { previousState, previousPublicKey }
}

async function rollbackFailedMutation({
  identityManager,
  mutation,
  previousState,
  previousPublicKey,
  postMutationState,
  currentPublicKey,
  restoreActiveIdentity,
  onRollback,
  error,
  firstArg
}) {
  const rollbackErrors = []
  try {
    if (previousState && typeof identityManager.restoreState === 'function') {
      await identityManager.restoreState(previousState, { postMutationState })
    } else if (
      previousPublicKey &&
      currentPublicKey !== previousPublicKey &&
      typeof restoreActiveIdentity === 'function'
    ) {
      await restoreActiveIdentity.call(identityManager, previousPublicKey)
    }
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError)
  }
  try {
    await onRollback({
      mutation,
      previousPublicKey,
      failedPublicKey: currentPublicKey || firstArg,
      error,
    })
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError)
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [error, ...rollbackErrors],
      'Identity mutation and compensation both failed',
    )
  }
}

export function installSeedPinIdentityMutationHooks ({
  identityManager,
  onMutation,
  onRollback = async () => {},
} = {}) {
  if (!identityManager || typeof identityManager !== 'object') {
    throw new TypeError('identityManager is required')
  }
  if (typeof onMutation !== 'function') throw new TypeError('onMutation must be a function')
  if (typeof onRollback !== 'function') throw new TypeError('onRollback must be a function')
  const installed = []
  const restoreActiveIdentity = identityManager.setActiveIdentity
  let identityMutations = Promise.resolve()
  const enqueueMutation = operation => {
    const next = identityMutations.then(operation, operation)
    identityMutations = next.catch(() => {})
    return next
  }
  for (const mutation of IDENTITY_MUTATIONS) {
    const original = identityManager[mutation.method]
    if (typeof original !== 'function') continue
    const wrapped = async (...args) => {
      return enqueueMutation(async () => {
        const { previousState, previousPublicKey } = await captureIdentityState(identityManager)
        let postMutationState = null
        let mutationCompleted = false
        try {
          const result = await original.apply(identityManager, args)
          postMutationState = identityManager.createStateSnapshot?.() || null
          mutationCompleted = true
          await onMutation(mutation)
          return result
        } catch (error) {
          if (mutationCompleted) {
            const currentPublicKey = identityManager.getActivePublicKey?.() || null
            await rollbackFailedMutation({
              identityManager,
              mutation,
              previousState,
              previousPublicKey,
              postMutationState,
              currentPublicKey,
              restoreActiveIdentity,
              onRollback,
              error,
              firstArg: args[0]
            })
          }
          throw error
        }
      })
    }
    identityManager[mutation.method] = wrapped
    installed.push({ method: mutation.method, original, wrapped })
  }
  return () => {
    for (const { method, original, wrapped } of installed) {
      if (identityManager[method] === wrapped) identityManager[method] = original
    }
  }
}

function exactRemotePublicKey (value) {
  if (!(b4a.isBuffer(value) || value instanceof Uint8Array) || value.byteLength !== 32) return null
  return value
}

function normalizeClientAuth (value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object') throw new TypeError('clientAuth must be an object')
  const identityPublicKey = typeof value.identityPublicKey === 'string'
    ? value.identityPublicKey.toLowerCase()
    : ''
  if (!HEX_32.test(identityPublicKey)) throw new TypeError('clientAuth.identityPublicKey must be a 32-byte hex key')
  const publicKey = value.deviceKeyPair?.publicKey
  const secretKey = value.deviceKeyPair?.secretKey
  if (!(b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) {
    throw new TypeError('clientAuth.deviceKeyPair.publicKey must be 32 bytes')
  }
  if (!(b4a.isBuffer(secretKey) || secretKey instanceof Uint8Array) || secretKey.byteLength !== 64) {
    throw new TypeError('clientAuth.deviceKeyPair.secretKey must be 64 bytes')
  }
  const deviceProof = value.deviceProof
  if (!(b4a.isBuffer(deviceProof) || deviceProof instanceof Uint8Array) || deviceProof.byteLength === 0) {
    throw new TypeError('clientAuth.deviceProof must be bytes')
  }
  if (!value.signedDescriptor || typeof value.signedDescriptor !== 'object') {
    throw new TypeError('clientAuth.signedDescriptor is required')
  }
  return Object.freeze({
    identityPublicKey,
    deviceKeyPair: Object.freeze({ publicKey, secretKey }),
    deviceProof,
    signedDescriptor: value.signedDescriptor,
  })
}

function fingerprintClientAuth (auth) {
  if (auth === null) return null
  const descriptor = auth.signedDescriptor?.descriptor || {}
  return [
    auth.identityPublicKey,
    b4a.toString(auth.deviceKeyPair.publicKey, 'hex'),
    b4a.toString(auth.deviceProof, 'hex'),
    auth.signedDescriptor?.proof || '',
    auth.signedDescriptor?.attestation || '',
    descriptor.channelId || '',
    descriptor.seq ?? '',
    descriptor.updatedAt ?? '',
  ].join(':')
}

function disabledRegistration () {
  return Object.freeze({
    enabled: false,
    store: null,
    worker: null,
    verificationLimiter: null,
    clientAuth: null,
    clients: null,
    async refreshClientAuth () { return null },
    async unregister () {},
  })
}
