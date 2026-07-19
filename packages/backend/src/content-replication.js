import b4a from 'b4a'

import { assessDurableManifest } from './api.js'
import { createSeedPinRequest } from './seed-pin/auth.js'
import { createDurableManifest } from './seed-pin/manifest.js'

export const CONTENT_REPLICATION_CHECKPOINT_VERSION = 1

const KEY_PATTERN = /^[0-9a-f]{64}$/
const MAX_TIMER_DELAY_MS = 0x7fffffff
const MAX_CHECKPOINT_PEERS = 1024
const MAX_INPUT_DEPTH = 32
const MAX_INPUT_NODES = 4096
const MAX_INPUT_ARRAY_ITEMS = 2048
const MAX_INPUT_TOTAL_ARRAY_ITEMS = 8192
const MAX_INPUT_OBJECT_FIELDS = 256
const MAX_INPUT_STRING_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 1024 * 1024
const DANGEROUS_DATA_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'toJSON'])
const BYTE_VIEW_PROTOTYPES = new Set([Uint8Array.prototype, Object.getPrototypeOf(b4a.alloc(0))])
const PUBLICATION_FIELD_MISSING = Symbol('publication field missing')
const PUBLICATION_FIELD_INVALID = Symbol('publication field invalid')
const PHASE_RANK = Object.freeze({
  replicationPending: 0,
  replicating: 1,
  durabilityVerified: 2,
  projected: 3,
  announcing: 4,
  announced: 5,
  published: 6,
})
const CHECKPOINT_FIELDS = new Set([
  'version',
  'revision',
  'phase',
  'channelKey',
  'rowId',
  'idempotencyKey',
  'requestId',
  'manifest',
  'acceptedPeerKeys',
  'peerResults',
  'projection',
  'announceError',
])
const PEER_OUTCOMES = new Set([
  'accepted',
  'rejected',
  'retryable',
  'transportError',
  'notFound',
  'forbidden',
])
const RETRYABLE_PIN_ERROR_CODES = new Set([
  'BUSY',
  'CAPACITY_EXCEEDED',
  'WORKER_UNAVAILABLE',
  'INTERNAL',
])
const ACCEPTED_PIN_STATES = new Set(['accepted', 'pinning', 'complete', 'retryable'])
const RETRYABLE_PIN_STATES = new Set(['retryable-admission'])
const REJECTED_PIN_STATES = new Set(['failed', 'cancelled', 'released', 'rejected'])
const TERMINAL_STATUS_STATES = new Set(['complete', 'failed', 'cancelled', 'released', 'rejected'])
const STAGED_FIELDS = Object.freeze([
  'stagedDescriptor',
  'stagedProfile',
  'stagedSources',
  'stagedArtwork',
])

class ContentReplicationCheckpointError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ContentReplicationCheckpointError'
  }
}

class ContentReplicationAbortError extends Error {
  constructor (message = 'Content replication was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

class ContentReplicationTimeoutError extends Error {
  constructor (message = 'Content replication operation timed out') {
    super(message)
    this.name = 'ContentReplicationTimeoutError'
  }
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactFields (value, fields, name) {
  if (!isPlainObject(value)) throw new ContentReplicationCheckpointError(`${name} must be a plain object`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.has(key)) {
      throw new ContentReplicationCheckpointError(`${name} contains an unsupported field`)
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new ContentReplicationCheckpointError(`${name}.${field} is required`)
    }
  }
}

function normalizePositiveInteger (value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function normalizeNonnegativeInteger (value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a nonnegative safe integer no greater than ${maximum}`)
  }
  return value
}

function normalizeRemoteKey (value, name = 'remote key') {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase 32-byte hexadecimal key`)
  }
  return value
}

function normalizeKeySnapshot (values, name) {
  if (!Array.isArray(values)) throw new TypeError(`${name} list must be an array`)
  const keys = new Set()
  for (const value of values) keys.add(normalizeRemoteKey(value, name))
  return Object.freeze([...keys].sort())
}

function deepFreeze (value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  if (value instanceof Uint8Array || b4a.isBuffer(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function snapshotData (
  value,
  name = 'value',
  seen = new Set(),
  state = { nodes: 0, fields: 0, arrayItems: 0, stringBytes: 0, bytes: 0 },
  depth = 0,
) {
  if (depth > MAX_INPUT_DEPTH) throw new RangeError(`${name} exceeds maximum depth`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} numbers must be finite`)
    return value
  }
  if (typeof value === 'string') {
    state.stringBytes += b4a.byteLength(value)
    if (state.stringBytes > MAX_INPUT_STRING_BYTES) throw new RangeError(`${name} strings are too large`)
    return value
  }
  if (typeof value !== 'object') throw new TypeError(`${name} contains an unsupported value`)
  if (++state.nodes > MAX_INPUT_NODES) throw new RangeError(`${name} has too many values`)
  if (value instanceof Uint8Array || b4a.isBuffer(value)) {
    const length = value.byteLength
    state.bytes += length
    if (!Number.isSafeInteger(length) || length < 0 || state.bytes > MAX_INPUT_BYTES) {
      throw new RangeError(`${name} byte arrays are too large`)
    }
    const keys = Reflect.ownKeys(value)
    if (!BYTE_VIEW_PROTOTYPES.has(Object.getPrototypeOf(value)) || keys.length !== length) {
      throw new TypeError(`${name} must be an unextended byte view`)
    }
    const copy = b4a.alloc(length)
    for (let index = 0; index < length; index++) {
      const key = String(index)
      if (keys[index] !== key) throw new TypeError(`${name} must be an unextended byte view`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
        throw new TypeError(`${name} byte values must be enumerable own data properties`)
      }
      copy[index] = descriptor.value
    }
    return copy
  }
  if (seen.has(value)) throw new TypeError(`${name} must not contain cyclic values`)

  const array = Array.isArray(value)
  if (!array && !isPlainObject(value)) {
    throw new TypeError(`${name} values must be plain objects, arrays, byte arrays, or primitives`)
  }
  const keys = Reflect.ownKeys(value)
  if (array) {
    if (keys.length > MAX_INPUT_ARRAY_ITEMS + 1) throw new RangeError(`${name} array is too large`)
  } else if (keys.length > MAX_INPUT_OBJECT_FIELDS) {
    throw new RangeError(`${name} object has too many fields`)
  }
  for (const key of keys) {
    if (typeof key !== 'string' || DANGEROUS_DATA_KEYS.has(key)) {
      throw new TypeError(`${name} contains an unsupported key`)
    }
  }

  seen.add(value)
  if (array) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_INPUT_ARRAY_ITEMS || keys.length !== lengthDescriptor.value + 1) {
      throw new TypeError(`${name} must be a dense bounded array`)
    }
    const length = lengthDescriptor.value
    const copy = new Array(length)
    state.arrayItems += length
    if (state.arrayItems > MAX_INPUT_TOTAL_ARRAY_ITEMS) {
      throw new RangeError(`${name} arrays contain too many items`)
    }
    for (let index = 0; index < length; index++) {
      const key = String(index)
      if (!keys.includes(key)) throw new TypeError(`${name} must be a dense bounded array`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`${name} array values must be enumerable own data properties`)
      }
      Object.defineProperty(copy, key, {
        value: snapshotData(descriptor.value, `${name}[${index}]`, seen, state, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      })
    }
    seen.delete(value)
    return Object.freeze(copy)
  }

  state.fields += keys.length
  if (state.fields > MAX_INPUT_NODES) throw new RangeError(`${name} objects contain too many fields`)
  const copy = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${name} values must be enumerable own data properties`)
    }
    Object.defineProperty(copy, key, {
      value: snapshotData(descriptor.value, `${name}.${key}`, seen, state, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  seen.delete(value)
  return Object.freeze(copy)
}

function manifestIdentity (manifest) {
  return JSON.stringify(manifest)
}

function snapshotReplicationInput (input, getTrustedRelayKeys, getPairedDeviceKeys) {
  input = snapshotData(input, 'Replication input')
  if (!isPlainObject(input)) throw new TypeError('Replication input must be a plain object')
  const totalBytes = normalizeNonnegativeInteger(input.totalBytes, 'totalBytes')
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
    throw new RangeError('idempotencyKey must be a nonempty string no longer than 256 characters')
  }
  const expiresAt = normalizePositiveInteger(input.expiresAt, 'expiresAt')
  const manifest = createDurableManifest({
    channelKey: input.channelKey,
    rowId: input.rowId,
    refs: input.refs,
    assets: input.assets,
  })

  if (!isPlainObject(input.deviceKeyPair)) throw new TypeError('deviceKeyPair must be an object')
  const publicKey = input.deviceKeyPair.publicKey
  const secretKey = input.deviceKeyPair.secretKey
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) {
    throw new TypeError('deviceKeyPair.publicKey must be exactly 32 bytes')
  }
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== 64) {
    throw new TypeError('deviceKeyPair.secretKey must be exactly 64 bytes')
  }
  if (!(input.deviceProof instanceof Uint8Array) || input.deviceProof.byteLength === 0 ||
      input.deviceProof.byteLength > MAX_INPUT_BYTES) {
    throw new TypeError('deviceProof must be a bounded nonempty byte array')
  }

  const staged = {}
  for (const field of STAGED_FIELDS) {
    if (input[field] !== undefined) staged[field] = input[field]
  }
  const trustedRelayKeys = normalizeKeySnapshot(
    snapshotData(getTrustedRelayKeys(manifest.channelKey), 'trusted relay key list'),
    'trusted relay key',
  )
  const pairedDeviceKeys = normalizeKeySnapshot(
    snapshotData(getPairedDeviceKeys(manifest.channelKey), 'paired device key list'),
    'paired device key',
  )
  return Object.freeze({
    manifest,
    totalBytes,
    expiresAt,
    idempotencyKey: input.idempotencyKey,
    deviceKeyPair: Object.freeze({
      publicKey: b4a.from(publicKey),
      secretKey: b4a.from(secretKey),
    }),
    deviceProof: b4a.from(input.deviceProof),
    signedDescriptor: input.signedDescriptor,
    staged: Object.freeze(staged),
    trustedRelayKeys,
    pairedDeviceKeys,
  })
}

async function buildCanonicalInput (
  snapshot,
  createManifest,
  { signal, deadlineAt, now },
) {
  const expected = snapshot.manifest
  const built = snapshotData(await boundedCall(
    () => createManifest({
      channelKey: expected.channelKey,
      rowId: expected.rowId,
      refs: snapshotData(expected.refs, 'manifest refs'),
      assets: snapshotData(expected.assets, 'manifest assets'),
    }),
    { signal, deadlineAt, timeout: MAX_TIMER_DELAY_MS, now },
  ), 'manifest builder result')
  if (!isPlainObject(built) || built.requestId !== expected.requestId) {
    throw new Error('Manifest builder returned a mismatched requestId')
  }
  const rebuilt = createDurableManifest({
    channelKey: built.channelKey,
    rowId: built.rowId,
    refs: built.refs,
    assets: built.assets,
  })
  if (rebuilt.requestId !== expected.requestId || manifestIdentity(rebuilt) !== manifestIdentity(expected)) {
    throw new Error('Manifest builder returned a mismatched manifest identity')
  }
  return Object.freeze({ ...snapshot, manifest: rebuilt })
}

function checkpointBase (operation) {
  return {
    version: CONTENT_REPLICATION_CHECKPOINT_VERSION,
    revision: 0,
    phase: 'replicationPending',
    channelKey: operation.manifest.channelKey,
    rowId: operation.manifest.rowId,
    idempotencyKey: operation.idempotencyKey,
    requestId: operation.manifest.requestId,
    manifest: operation.manifest,
    acceptedPeerKeys: [],
    peerResults: [],
    projection: null,
    announceError: null,
  }
}

function normalizeProjection (value, operation) {
  if (!isPlainObject(value)) throw new ContentReplicationCheckpointError('checkpoint projection must be an object')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || !keys.includes('channelKey') || !keys.includes('publicBeeKey') || !keys.includes('videoId')) {
    throw new ContentReplicationCheckpointError('checkpoint projection has invalid fields')
  }
  if (value.channelKey !== operation.manifest.channelKey || value.videoId !== operation.manifest.rowId) {
    throw new ContentReplicationCheckpointError('checkpoint projection identity mismatch')
  }
  normalizeRemoteKey(value.publicBeeKey, 'checkpoint publicBeeKey')
  return Object.freeze({
    channelKey: value.channelKey,
    publicBeeKey: value.publicBeeKey,
    videoId: value.videoId,
  })
}

function publicationScalar (value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return PUBLICATION_FIELD_MISSING
  if (descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return PUBLICATION_FIELD_INVALID
  }
  const field = descriptor.value
  return typeof field === 'string' ? field : PUBLICATION_FIELD_INVALID
}

function confirmsDurabilityVerified (value, rowId) {
  if (!isPlainObject(value)) return false
  const id = publicationScalar(value, 'id')
  const state = publicationScalar(value, 'publicationState')
  return id === rowId &&
    (state === 'durabilityVerified' || state === 'published')
}

function confirmedProjection (value, operation) {
  if (!isPlainObject(value)) return null
  const channelKey = publicationScalar(value, 'channelKey')
  const publicBeeKey = publicationScalar(value, 'publicBeeKey')
  const videoId = publicationScalar(value, 'videoId')
  if (channelKey !== operation.manifest.channelKey ||
      videoId !== operation.manifest.rowId ||
      publicBeeKey === PUBLICATION_FIELD_MISSING ||
      publicBeeKey === PUBLICATION_FIELD_INVALID) {
    return null
  }
  try {
    normalizeRemoteKey(publicBeeKey, 'projection publicBeeKey')
  } catch {
    return null
  }
  return Object.freeze({
    channelKey,
    publicBeeKey,
    videoId,
  })
}

function confirmsAnnouncement (value) {
  if (!isPlainObject(value)) return false
  const status = publicationScalar(value, 'status')
  return status === 'authoritative'
}

function confirmsPublished (value, operation) {
  if (!isPlainObject(value)) return false
  const id = publicationScalar(value, 'id')
  if (id !== operation.manifest.rowId) return false
  const channelKey = publicationScalar(value, 'channelKey')
  if (channelKey === PUBLICATION_FIELD_INVALID ||
      (channelKey !== PUBLICATION_FIELD_MISSING &&
        channelKey !== operation.manifest.channelKey)) {
    return false
  }
  const publicationState = publicationScalar(value, 'publicationState')
  if (publicationState === PUBLICATION_FIELD_INVALID) return false
  if (publicationState !== PUBLICATION_FIELD_MISSING) return publicationState === 'published'
  const status = publicationScalar(value, 'status')
  return status === 'published'
}

function normalizePeerResults (value, acceptedPeerKeys, maxClients, checkpointRevision) {
  if (!Array.isArray(value) || value.length > maxClients) {
    throw new ContentReplicationCheckpointError('checkpoint peerResults are out of bounds')
  }
  const results = []
  const seen = new Set()
  let previous = null
  for (const result of value) {
    if (!isPlainObject(result) || Reflect.ownKeys(result).length !== 3 ||
        !Object.prototype.hasOwnProperty.call(result, 'peerKey') ||
        !Object.prototype.hasOwnProperty.call(result, 'outcome') ||
        !Object.prototype.hasOwnProperty.call(result, 'lastInteractionRevision')) {
      throw new ContentReplicationCheckpointError('checkpoint peer result is invalid')
    }
    const peerKey = normalizeRemoteKey(result.peerKey, 'checkpoint peer key')
    if (!PEER_OUTCOMES.has(result.outcome) || !Number.isSafeInteger(result.lastInteractionRevision) ||
        result.lastInteractionRevision < 1 || result.lastInteractionRevision > checkpointRevision ||
        seen.has(peerKey) || (previous !== null && previous > peerKey)) {
      throw new ContentReplicationCheckpointError('checkpoint peer result is not canonical')
    }
    seen.add(peerKey)
    previous = peerKey
    results.push(Object.freeze({
      peerKey,
      outcome: result.outcome,
      lastInteractionRevision: result.lastInteractionRevision,
    }))
  }
  for (const peerKey of acceptedPeerKeys) {
    if (!results.some(result => result.peerKey === peerKey && result.outcome === 'accepted')) {
      throw new ContentReplicationCheckpointError('checkpoint accepted peer result is missing')
    }
  }
  return Object.freeze(results)
}

function normalizeAnnounceError (value, phase) {
  if (value === null) return null
  if (phase !== 'announcing' || !isPlainObject(value) || Reflect.ownKeys(value).length !== 2 ||
      value.code !== 'ANNOUNCE_FAILED' || !Number.isSafeInteger(value.attempts) ||
      value.attempts < 1 || value.attempts > Number.MAX_SAFE_INTEGER) {
    throw new ContentReplicationCheckpointError('checkpoint announceError is invalid')
  }
  return Object.freeze({ code: 'ANNOUNCE_FAILED', attempts: value.attempts })
}

function normalizeCheckpoint (value, operation, maxClients) {
  assertExactFields(value, CHECKPOINT_FIELDS, 'checkpoint')
  if (value.version !== CONTENT_REPLICATION_CHECKPOINT_VERSION) {
    throw new ContentReplicationCheckpointError('checkpoint version mismatch')
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ContentReplicationCheckpointError('checkpoint revision is invalid')
  }
  if (!Object.prototype.hasOwnProperty.call(PHASE_RANK, value.phase)) {
    throw new ContentReplicationCheckpointError('checkpoint phase is invalid')
  }
  if (
    value.channelKey !== operation.manifest.channelKey ||
    value.rowId !== operation.manifest.rowId ||
    value.idempotencyKey !== operation.idempotencyKey ||
    value.requestId !== operation.manifest.requestId
  ) {
    throw new ContentReplicationCheckpointError('checkpoint operation identity mismatch')
  }
  if (!isPlainObject(value.manifest) || value.manifest.requestId !== operation.manifest.requestId) {
    throw new ContentReplicationCheckpointError('checkpoint manifest identity mismatch')
  }
  let rebuilt
  try {
    rebuilt = createDurableManifest({
      channelKey: value.manifest.channelKey,
      rowId: value.manifest.rowId,
      refs: value.manifest.refs,
      assets: value.manifest.assets,
    })
  } catch {
    throw new ContentReplicationCheckpointError('checkpoint manifest is invalid')
  }
  if (manifestIdentity(rebuilt) !== manifestIdentity(operation.manifest)) {
    throw new ContentReplicationCheckpointError('checkpoint manifest identity mismatch')
  }

  if (!Array.isArray(value.acceptedPeerKeys) || value.acceptedPeerKeys.length > maxClients) {
    throw new ContentReplicationCheckpointError('checkpoint acceptedPeerKeys are out of bounds')
  }
  const acceptedPeerKeys = []
  let previous = null
  for (const candidate of value.acceptedPeerKeys) {
    const peerKey = normalizeRemoteKey(candidate, 'checkpoint accepted peer key')
    if (peerKey === previous || (previous !== null && previous > peerKey)) {
      throw new ContentReplicationCheckpointError('checkpoint acceptedPeerKeys are not canonical')
    }
    previous = peerKey
    acceptedPeerKeys.push(peerKey)
  }
  Object.freeze(acceptedPeerKeys)
  const peerResults = normalizePeerResults(value.peerResults, acceptedPeerKeys, maxClients, value.revision)

  const needsProjection = PHASE_RANK[value.phase] >= PHASE_RANK.projected
  if (needsProjection !== (value.projection !== null)) {
    throw new ContentReplicationCheckpointError('checkpoint projection does not match phase')
  }
  const projection = needsProjection ? normalizeProjection(value.projection, operation) : null
  const announceError = normalizeAnnounceError(value.announceError, value.phase)

  return deepFreeze({
    version: CONTENT_REPLICATION_CHECKPOINT_VERSION,
    revision: value.revision,
    phase: value.phase,
    channelKey: value.channelKey,
    rowId: value.rowId,
    idempotencyKey: value.idempotencyKey,
    requestId: value.requestId,
    manifest: operation.manifest,
    acceptedPeerKeys,
    peerResults,
    projection,
    announceError,
  })
}

function sameValue (left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function snapshotEligibleClients (
  clients,
  maxClients,
  trustedRelayKeys,
  pairedDeviceKeys,
  acceptedPeerKeys,
  peerResults,
) {
  if (!(clients instanceof Map)) throw new TypeError('clients must be a Map keyed by authenticated remote key')
  const trusted = new Set(trustedRelayKeys)
  const paired = new Set(pairedDeviceKeys)
  const eligible = []
  for (const [candidateKey, client] of clients) {
    if (typeof candidateKey !== 'string' || !KEY_PATTERN.test(candidateKey)) continue
    if (!client || client.authEnabled !== true || client.closed === true ||
        typeof client.pin !== 'function' || typeof client.status !== 'function') continue
    eligible.push(Object.freeze({ peerKey: candidateKey, client }))
  }
  const policyRank = peerKey => {
    if (trusted.has(peerKey)) return 0
    if (paired.has(peerKey)) return 1
    return 2
  }
  const compare = (left, right) => {
    const leftResult = peerResults.get(left.peerKey)
    const rightResult = peerResults.get(right.peerKey)
    if ((leftResult === undefined) !== (rightResult === undefined)) {
      return leftResult === undefined ? -1 : 1
    }
    if (leftResult === undefined) {
      return policyRank(left.peerKey) - policyRank(right.peerKey) ||
        left.peerKey.localeCompare(right.peerKey)
    }
    return leftResult.lastInteractionRevision - rightResult.lastInteractionRevision ||
      policyRank(left.peerKey) - policyRank(right.peerKey) ||
      Number(acceptedPeerKeys.has(right.peerKey)) - Number(acceptedPeerKeys.has(left.peerKey)) ||
      left.peerKey.localeCompare(right.peerKey)
  }
  eligible.sort(compare)
  return Object.freeze(eligible.slice(0, maxClients))
}

function prunePeerHistory ({
  acceptedPeerKeys,
  peerResults,
  trustedRelayKeys,
  pairedDeviceKeys,
  currentRunPeerKeys,
}) {
  const trusted = new Set(trustedRelayKeys)
  const paired = new Set(pairedDeviceKeys)
  const accepted = new Set(acceptedPeerKeys)
  const records = new Map(peerResults.map(result => [result.peerKey, result]))
  const policyRank = peerKey => {
    if (trusted.has(peerKey)) return 0
    if (paired.has(peerKey)) return 1
    return 2
  }
  const compare = (left, right) => {
    const leftCurrent = currentRunPeerKeys.has(left[0])
    const rightCurrent = currentRunPeerKeys.has(right[0])
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
    return left[1].lastInteractionRevision - right[1].lastInteractionRevision ||
      policyRank(left[0]) - policyRank(right[0]) ||
      Number(right[1].outcome === 'accepted') - Number(left[1].outcome === 'accepted') ||
      left[0].localeCompare(right[0])
  }
  const kept = [...records].sort(compare).slice(0, MAX_CHECKPOINT_PEERS)
  const keptSet = new Set(kept.map(([peerKey]) => peerKey))
  return Object.freeze({
    acceptedPeerKeys: Object.freeze([...accepted]
      .filter(peerKey => keptSet.has(peerKey) && records.get(peerKey)?.outcome === 'accepted')
      .sort()),
    peerResults: Object.freeze(kept
      .map(([, result]) => Object.freeze({ ...result }))
      .sort((left, right) => left.peerKey.localeCompare(right.peerKey))),
  })
}

function createSemaphore (maximum, now) {
  let active = 0
  const waiters = []

  const dispatch = () => {
    while (active < maximum && waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter.cancelled) continue
      waiter.granted = true
      waiter.cleanup()
      active++
      waiter.resolve(() => {
        if (waiter.released) return
        waiter.released = true
        active--
        dispatch()
      })
    }
  }

  return function acquire (signal, deadlineAt) {
    if (signal?.aborted) return Promise.reject(new ContentReplicationAbortError())
    const remaining = deadlineAt - now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.reject(new ContentReplicationTimeoutError())
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cancelled: false,
        granted: false,
        released: false,
        cleanup: () => {},
      }
      const cancel = error => {
        if (waiter.cancelled || waiter.granted) return
        waiter.cancelled = true
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        waiter.cleanup()
        reject(error)
        dispatch()
      }
      const onAbort = () => cancel(new ContentReplicationAbortError())
      const timer = setTimeout(
        () => cancel(new ContentReplicationTimeoutError()),
        Math.max(1, Math.min(remaining, MAX_TIMER_DELAY_MS)),
      )
      waiter.cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      waiters.push(waiter)
      dispatch()
    })
  }
}

function boundedCall (operation, { signal, deadlineAt, timeout, now }) {
  if (signal?.aborted) return Promise.reject(new ContentReplicationAbortError())
  const remaining = deadlineAt - now()
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(new ContentReplicationTimeoutError())
  }
  const boundedTimeout = Math.max(1, Math.min(timeout, remaining, MAX_TIMER_DELAY_MS))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, new ContentReplicationAbortError())
    const timer = setTimeout(
      () => finish(reject, new ContentReplicationTimeoutError()),
      boundedTimeout,
    )
    signal?.addEventListener?.('abort', onAbort, { once: true })
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
  })
}

function boundedDelay (delay, { signal, deadlineAt, now }) {
  if (signal?.aborted) return Promise.reject(new ContentReplicationAbortError())
  if (delay <= 0) return Promise.resolve()
  const remaining = deadlineAt - now()
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(new ContentReplicationTimeoutError())
  }
  const duration = Math.max(1, Math.min(delay, remaining, MAX_TIMER_DELAY_MS))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, new ContentReplicationAbortError())
    const timer = setTimeout(() => {
      if (duration < delay) finish(reject, new ContentReplicationTimeoutError())
      else finish(resolve)
    }, duration)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

async function mapLimit (entries, concurrency, operation) {
  if (entries.length === 0) return []
  const results = new Array(entries.length)
  let nextIndex = 0
  const workers = new Array(Math.min(concurrency, entries.length)).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++
      if (index >= entries.length) return
      results[index] = await operation(entries[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function pinOutcome (status, requestId) {
  if (!isPlainObject(status) || status.requestId !== requestId || typeof status.state !== 'string') {
    return 'transportError'
  }
  if (ACCEPTED_PIN_STATES.has(status.state)) return 'accepted'
  if (RETRYABLE_PIN_STATES.has(status.state)) return 'retryable'
  if (REJECTED_PIN_STATES.has(status.state)) return 'rejected'
  return 'transportError'
}

function protocolRejection (error) {
  if (error?.name !== 'SeedPinProtocolError') return 'transportError'
  return RETRYABLE_PIN_ERROR_CODES.has(error.code) ? 'retryable' : 'rejected'
}

function statusProgress (status, requestId, previous) {
  if (!isPlainObject(status) || status.requestId !== requestId || typeof status.state !== 'string' || !Array.isArray(status.refs)) {
    return null
  }
  let completedBytes = 0
  for (const ref of status.refs) {
    const bytes = ref?.bytesPinned
    if (Number.isSafeInteger(bytes) && bytes > 0) {
      completedBytes = Math.min(Number.MAX_SAFE_INTEGER, completedBytes + bytes)
    }
  }
  completedBytes = Math.max(previous.completedBytes, completedBytes)
  return Object.freeze({ state: status.state, completedBytes })
}

function assessmentCounts (assessment, ordinaryRequired) {
  const trusted = Array.isArray(assessment?.trusted) ? new Set(assessment.trusted).size : 0
  const paired = Array.isArray(assessment?.paired) ? new Set(assessment.paired).size : 0
  const ordinary = Array.isArray(assessment?.ordinary) ? new Set(assessment.ordinary).size : 0
  return Object.freeze({
    qualifyingHolders: trusted + paired + ordinary,
    requiredHolders: trusted > 0 || paired > 0 ? 1 : ordinaryRequired,
  })
}

function pendingResult (requestId) {
  return Object.freeze({ status: 'replicationPending', phase: 'replicationPending', requestId })
}

function retryableAnnounceResult (requestId) {
  return Object.freeze({ status: 'announceRetryable', phase: 'announcing', requestId, retryable: true })
}

function publishedResult (requestId) {
  return Object.freeze({ status: 'published', phase: 'published', requestId })
}

/**
 * Compose authenticated seed-pin clients, live remote-range assessment, durable
 * checkpoints, and the existing idempotent publication boundary.
 */
export function createContentReplication ({
  publication,
  clients,
  createManifest = createDurableManifest,
  createPinRequest = createSeedPinRequest,
  assessDurability = assessDurableManifest,
  assessmentDeps = {},
  getTrustedRelayKeys = () => [],
  getPairedDeviceKeys = () => [],
  readCheckpoint,
  writeCheckpoint,
  onProgress = null,
  logger = null,
  ordinaryRequired = 2,
  maxClients = 16,
  maxStatusAttempts = 3,
  maxPeerConcurrency = 4,
  maxConcurrentRows = 4,
  pollIntervalMs = 100,
  requestTimeoutMs = 5_000,
  operationTimeoutMs = 30_000,
  now = Date.now,
} = {}) {
  if (!publication || typeof publication.markDurabilityVerified !== 'function' ||
      typeof publication.project !== 'function' || typeof publication.announce !== 'function' ||
      typeof publication.finalize !== 'function') {
    throw new TypeError('publication must provide the content publication primitives')
  }
  if (!(clients instanceof Map)) throw new TypeError('clients must be a Map')
  if (typeof createManifest !== 'function' || typeof createPinRequest !== 'function' ||
      typeof assessDurability !== 'function') throw new TypeError('replication builders and assessor must be functions')
  if (typeof getTrustedRelayKeys !== 'function' || typeof getPairedDeviceKeys !== 'function') {
    throw new TypeError('trust snapshot dependencies must be functions')
  }
  if (typeof readCheckpoint !== 'function' || typeof writeCheckpoint !== 'function') {
    throw new TypeError('checkpoint callbacks are required')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  ordinaryRequired = normalizeNonnegativeInteger(ordinaryRequired, 'ordinaryRequired')
  maxClients = normalizePositiveInteger(maxClients, 'maxClients', 256)
  maxStatusAttempts = normalizePositiveInteger(maxStatusAttempts, 'maxStatusAttempts', 256)
  maxPeerConcurrency = normalizePositiveInteger(maxPeerConcurrency, 'maxPeerConcurrency', 256)
  maxConcurrentRows = normalizePositiveInteger(maxConcurrentRows, 'maxConcurrentRows', 256)
  pollIntervalMs = normalizeNonnegativeInteger(pollIntervalMs, 'pollIntervalMs', MAX_TIMER_DELAY_MS)
  requestTimeoutMs = normalizePositiveInteger(requestTimeoutMs, 'requestTimeoutMs', MAX_TIMER_DELAY_MS)
  operationTimeoutMs = normalizePositiveInteger(operationTimeoutMs, 'operationTimeoutMs', MAX_TIMER_DELAY_MS)

  const acquireRowSlot = createSemaphore(maxConcurrentRows, now)
  const keyedQueues = new Map()

  const emitProgress = event => {
    const stable = Object.freeze(event)
    if (typeof onProgress !== 'function') return
    try {
      onProgress(stable)
    } catch {
      try { logger?.warn?.('Content replication progress callback failed', { phase: stable.phase }) } catch {}
    }
  }

  const acquireKey = (key, signal, deadlineAt) => {
    if (signal?.aborted) return Promise.reject(new ContentReplicationAbortError())
    const remaining = deadlineAt - now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.reject(new ContentReplicationTimeoutError())
    }
    let queue = keyedQueues.get(key)
    if (!queue) {
      queue = { active: false, waiters: [] }
      keyedQueues.set(key, queue)
    }
    const dispatch = () => {
      if (queue.active) return
      while (queue.waiters.length > 0) {
        const waiter = queue.waiters.shift()
        if (waiter.cancelled) continue
        queue.active = true
        waiter.granted = true
        waiter.cleanup()
        waiter.resolve(() => {
          if (waiter.released) return
          waiter.released = true
          queue.active = false
          dispatch()
        })
        return
      }
      if (keyedQueues.get(key) === queue) keyedQueues.delete(key)
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cancelled: false,
        granted: false,
        released: false,
        cleanup: () => {},
      }
      const cancel = error => {
        if (waiter.cancelled || waiter.granted) return
        waiter.cancelled = true
        const index = queue.waiters.indexOf(waiter)
        if (index !== -1) queue.waiters.splice(index, 1)
        waiter.cleanup()
        reject(error)
        dispatch()
      }
      const onAbort = () => cancel(new ContentReplicationAbortError())
      const timer = setTimeout(
        () => cancel(new ContentReplicationTimeoutError()),
        Math.max(1, Math.min(remaining, MAX_TIMER_DELAY_MS)),
      )
      waiter.cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      queue.waiters.push(waiter)
      dispatch()
    })
  }

  const withKeyLock = async (key, signal, deadlineAt, operation) => {
    const releaseKey = await acquireKey(key, signal, deadlineAt)
    let releaseSlot = null
    try {
      releaseSlot = await acquireRowSlot(signal, deadlineAt)
      return await operation()
    } finally {
      releaseSlot?.()
      releaseKey()
    }
  }

  const run = async (operation, signal, deadlineAt) => {
    let checkpoint = null
    let authoritativeChanges = 0
    let syncLivePeerState = null
    const currentRunPeerKeys = new Set()
    const identity = Object.freeze({
      channelKey: operation.manifest.channelKey,
      rowId: operation.manifest.rowId,
      idempotencyKey: operation.idempotencyKey,
      requestId: operation.manifest.requestId,
    })
    const external = (callback, timeout = MAX_TIMER_DELAY_MS) => boundedCall(
      callback,
      { signal, deadlineAt, timeout, now },
    )

    let loaded
    try {
      loaded = await external(() => readCheckpoint(identity, { signal, deadlineAt }))
      if (loaded !== null && loaded !== undefined) {
        loaded = snapshotData(loaded, 'checkpoint read result')
      }
    } catch (error) {
      if (error instanceof ContentReplicationAbortError ||
          error instanceof ContentReplicationTimeoutError) throw error
      throw new ContentReplicationCheckpointError('checkpoint read callback failed')
    }
    if (loaded !== null && loaded !== undefined) {
      checkpoint = normalizeCheckpoint(loaded, operation, MAX_CHECKPOINT_PEERS)
    }

    const persist = async (phase, updates = {}) => {
      const current = checkpoint || deepFreeze(checkpointBase(operation))
      if (PHASE_RANK[phase] < PHASE_RANK[current.phase]) return current
      const rawCandidate = {
        ...current,
        ...updates,
        version: CONTENT_REPLICATION_CHECKPOINT_VERSION,
        revision: current.revision + 1,
        phase,
        manifest: operation.manifest,
      }
      const history = prunePeerHistory({
        acceptedPeerKeys: rawCandidate.acceptedPeerKeys,
        peerResults: rawCandidate.peerResults,
        trustedRelayKeys: operation.trustedRelayKeys,
        pairedDeviceKeys: operation.pairedDeviceKeys,
        currentRunPeerKeys,
      })
      const candidate = normalizeCheckpoint({
        ...rawCandidate,
        ...history,
      }, operation, MAX_CHECKPOINT_PEERS)
      if (checkpoint && sameValue({ ...candidate, revision: 0 }, { ...checkpoint, revision: 0 })) {
        return checkpoint
      }

      const expectedRevision = checkpoint ? checkpoint.revision : 0
      let written
      try {
        written = await external(() => writeCheckpoint(candidate, Object.freeze({
          expectedRevision: checkpoint ? checkpoint.revision : null,
          ...identity,
          signal,
          deadlineAt,
        })))
        if (written !== undefined) written = snapshotData(written, 'checkpoint write result')
      } catch (error) {
        if (error instanceof ContentReplicationAbortError ||
            error instanceof ContentReplicationTimeoutError) throw error
        throw new ContentReplicationCheckpointError('checkpoint callback failed')
      }
      if (written === false) throw new ContentReplicationCheckpointError('checkpoint compare-and-swap failed')
      const accepted = written && typeof written === 'object'
        ? normalizeCheckpoint(written, operation, MAX_CHECKPOINT_PEERS)
        : candidate
      if (accepted.revision <= expectedRevision) {
        throw new ContentReplicationCheckpointError('checkpoint revision did not advance')
      }
      if (PHASE_RANK[accepted.phase] < PHASE_RANK[phase]) {
        throw new ContentReplicationCheckpointError('checkpoint write regressed phase')
      }
      const authoritative = !sameValue(accepted, candidate)
      checkpoint = accepted
      syncLivePeerState?.(accepted)
      if (authoritative) authoritativeChanges++
      return checkpoint
    }

    if (checkpoint === null || checkpoint.phase === 'replicationPending') {
      await persist('replicating')
    }
    if (checkpoint.phase === 'published') {
      emitProgress({ phase: 'published' })
      return publishedResult(operation.manifest.requestId)
    }

    const publicationContext = Object.freeze({
      channelKey: operation.manifest.channelKey,
      idempotencyKey: operation.idempotencyKey,
      requestId: operation.manifest.requestId,
    })

    const advancePublication = async () => {
      while (true) {
        if (checkpoint.phase === 'durabilityVerified') {
          const markResult = await external(() => publication.markDurabilityVerified(
            operation.manifest.rowId,
            publicationContext,
          ))
          if (!confirmsDurabilityVerified(markResult, operation.manifest.rowId)) {
            return pendingResult(operation.manifest.requestId)
          }
          const projectionInput = Object.freeze({
            videoId: operation.manifest.rowId,
            ...publicationContext,
            ...operation.staged,
          })
          const projection = await external(() => publication.project(projectionInput))
          const normalizedProjection = confirmedProjection(projection, operation)
          if (normalizedProjection === null) return pendingResult(operation.manifest.requestId)
          await persist('projected', { projection: normalizedProjection, announceError: null })
          continue
        }
        if (checkpoint.phase === 'projected') {
          await persist('announcing', { announceError: null })
          continue
        }
        if (checkpoint.phase === 'announcing') {
          emitProgress({ phase: 'announcing' })
          try {
            const announceResult = await external(() => publication.announce(Object.freeze({
              ...checkpoint.projection,
              idempotencyKey: operation.idempotencyKey,
              requestId: operation.manifest.requestId,
            })))
            if (!confirmsAnnouncement(announceResult)) {
              throw new Error('publication announcement is not authoritative')
            }
          } catch (error) {
            if (error instanceof ContentReplicationAbortError ||
                error instanceof ContentReplicationTimeoutError) throw error
            const attempts = Math.min(
              Number.MAX_SAFE_INTEGER,
              (checkpoint.announceError?.attempts || 0) + 1,
            )
            await persist('announcing', {
              announceError: Object.freeze({ code: 'ANNOUNCE_FAILED', attempts }),
            })
            if (checkpoint.phase === 'announcing') {
              return retryableAnnounceResult(operation.manifest.requestId)
            }
            continue
          }
          await persist('announced', { announceError: null })
          continue
        }
        if (checkpoint.phase === 'announced') {
          const finalizeResult = await external(() => publication.finalize(
            operation.manifest.rowId,
            publicationContext,
          ))
          if (!confirmsPublished(finalizeResult, operation)) {
            return pendingResult(operation.manifest.requestId)
          }
          await persist('published', { announceError: null })
          continue
        }
        if (checkpoint.phase === 'published') {
          emitProgress({ phase: 'published' })
          return publishedResult(operation.manifest.requestId)
        }
        throw new ContentReplicationCheckpointError('checkpoint cannot enter publication from its current phase')
      }
    }

    if (PHASE_RANK[checkpoint.phase] >= PHASE_RANK.durabilityVerified) {
      return advancePublication()
    }
    if (signal?.aborted) return pendingResult(operation.manifest.requestId)

    const trustedRelayKeys = operation.trustedRelayKeys
    const pairedDeviceKeys = operation.pairedDeviceKeys
    const trust = Object.freeze({ trustedRelayKeys, pairedDeviceKeys, ordinaryRequired })

    const assess = async () => {
      let assessment
      try {
        assessment = await external(
          () => assessDurability(operation.manifest.refs, trust, assessmentDeps),
          requestTimeoutMs,
        )
        assessment = snapshotData(assessment, 'durability assessment result')
      } catch {
        assessment = null
      }
      const counts = assessmentCounts(assessment, ordinaryRequired)
      emitProgress({ phase: 'verifying', ...counts })
      return assessment?.eligible === true
    }

    if (await assess()) {
      await persist('durabilityVerified')
      return advancePublication()
    }
    if (signal?.aborted || deadlineAt - now() <= 0) return pendingResult(operation.manifest.requestId)

    const acceptedPeerKeys = new Set(checkpoint.acceptedPeerKeys)
    const peerResults = new Map(checkpoint.peerResults.map(result => [result.peerKey, result]))
    syncLivePeerState = authoritative => {
      acceptedPeerKeys.clear()
      for (const peerKey of authoritative.acceptedPeerKeys) acceptedPeerKeys.add(peerKey)
      peerResults.clear()
      for (const result of authoritative.peerResults) peerResults.set(result.peerKey, result)
    }
    const selectedClients = snapshotEligibleClients(
      clients,
      maxClients,
      trustedRelayKeys,
      pairedDeviceKeys,
      acceptedPeerKeys,
      peerResults,
    )
    const progressByPeer = new Map()
    const hintByPeer = new Map()
    let usefulPinHint = false
    let aborted = false

    const observeStatus = (peerKey, status) => {
      const previous = progressByPeer.get(peerKey) || Object.freeze({ state: null, completedBytes: 0 })
      const next = statusProgress(status, operation.manifest.requestId, previous)
      if (next === null) return false
      progressByPeer.set(peerKey, next)
      emitProgress({
        phase: 'replicating',
        peerKey,
        completedBytes: Math.min(operation.totalBytes, next.completedBytes),
        totalBytes: operation.totalBytes,
      })
      const previousHint = hintByPeer.get(peerKey)
      hintByPeer.set(peerKey, next)
      return previousHint === undefined || previousHint.state !== next.state ||
        previousHint.completedBytes !== next.completedBytes
    }

    const applyPrunedHistory = () => {
      const pruned = prunePeerHistory({
        acceptedPeerKeys,
        peerResults: [...peerResults.values()],
        trustedRelayKeys,
        pairedDeviceKeys,
        currentRunPeerKeys,
      })
      acceptedPeerKeys.clear()
      for (const peerKey of pruned.acceptedPeerKeys) acceptedPeerKeys.add(peerKey)
      peerResults.clear()
      for (const result of pruned.peerResults) peerResults.set(result.peerKey, result)
      return pruned
    }

    const persistPeerHistory = async () => {
      const before = authoritativeChanges
      const pruned = applyPrunedHistory()
      if (!sameValue(pruned.acceptedPeerKeys, checkpoint.acceptedPeerKeys) ||
          !sameValue(pruned.peerResults, checkpoint.peerResults)) {
        await persist('replicating', pruned)
      }
      return authoritativeChanges !== before
    }

    const pinTargets = selectedClients.filter(entry => !acceptedPeerKeys.has(entry.peerKey))
    let pinRequest = null
    if (pinTargets.length > 0) {
      pinRequest = await external(() => createPinRequest({
        manifest: operation.manifest,
        expiresAt: operation.expiresAt,
        deviceKeyPair: operation.deviceKeyPair,
        deviceProof: operation.deviceProof,
        signedDescriptor: operation.signedDescriptor,
        signal,
      }))
      pinRequest = snapshotData(pinRequest, 'PIN request builder result')
      if (!isPlainObject(pinRequest) || pinRequest.requestId !== operation.manifest.requestId ||
          pinRequest.manifest?.requestId !== operation.manifest.requestId) {
        throw new Error('PIN_REQUEST does not match the canonical manifest')
      }
    }

    const pinInteractionRevision = checkpoint.revision + 1
    const pinResults = await mapLimit(pinTargets, maxPeerConcurrency, async ({ peerKey, client }) => {
      if (signal?.aborted || clients.get(peerKey) !== client) {
        return { peerKey, outcome: null, submitted: false, aborted: signal?.aborted === true }
      }
      let submitted = false
      try {
        const rawStatus = await external(
          () => {
            submitted = true
            return client.pin(pinRequest, { timeout: requestTimeoutMs, signal })
          },
          requestTimeoutMs,
        )
        const status = snapshotData(rawStatus, 'PIN response')
        const outcome = pinOutcome(status, operation.manifest.requestId)
        if (outcome === 'accepted') {
          acceptedPeerKeys.add(peerKey)
          usefulPinHint = observeStatus(peerKey, status) || usefulPinHint
        }
        return { peerKey, outcome, submitted, aborted: false }
      } catch (error) {
        return {
          peerKey,
          outcome: protocolRejection(error),
          submitted,
          aborted: error instanceof ContentReplicationAbortError,
        }
      }
    })

    for (const result of pinResults) {
      if (result.aborted) aborted = true
      if (result.submitted) {
        currentRunPeerKeys.add(result.peerKey)
        peerResults.set(result.peerKey, Object.freeze({
          peerKey: result.peerKey,
          outcome: result.outcome,
          lastInteractionRevision: pinInteractionRevision,
        }))
        if (result.outcome !== 'accepted') acceptedPeerKeys.delete(result.peerKey)
      }
    }
    if (await persistPeerHistory()) return run(operation, signal, deadlineAt)

    if (PHASE_RANK[checkpoint.phase] >= PHASE_RANK.durabilityVerified) return advancePublication()
    if (usefulPinHint && await assess()) {
      await persist('durabilityVerified')
      return advancePublication()
    }
    if (aborted || signal?.aborted || deadlineAt - now() <= 0) return pendingResult(operation.manifest.requestId)

    let statusCandidates = selectedClients.filter(({ peerKey, client }) =>
      acceptedPeerKeys.has(peerKey) && clients.get(peerKey) === client)

    for (let attempt = 0; attempt < maxStatusAttempts && statusCandidates.length > 0; attempt++) {
      if (attempt > 0) {
        try {
          await boundedDelay(pollIntervalMs, { signal, deadlineAt, now })
        } catch {
          return pendingResult(operation.manifest.requestId)
        }
      }
      let usefulStatusHint = false
      let historyChanged = false
      const continuing = []
      const statusInteractionRevision = checkpoint.revision + 1
      const statusResults = await mapLimit(statusCandidates, maxPeerConcurrency, async ({ peerKey, client }) => {
        if (signal?.aborted || clients.get(peerKey) !== client || client.closed === true) {
          return {
            peerKey,
            client,
            status: null,
            keep: false,
            terminal: false,
            interacted: false,
            aborted: signal?.aborted === true,
          }
        }
        let interacted = false
        try {
          const rawStatus = await external(
            () => {
              interacted = true
              return client.status(operation.manifest.requestId, { timeout: requestTimeoutMs, signal })
            },
            requestTimeoutMs,
          )
          const status = snapshotData(rawStatus, 'PIN status response')
          if (!isPlainObject(status) || status.requestId !== operation.manifest.requestId) {
            return {
              peerKey,
              client,
              status: null,
              keep: false,
              terminal: false,
              interacted,
              aborted: false,
            }
          }
          const terminal = TERMINAL_STATUS_STATES.has(status.state) && status.state !== 'complete'
          return {
            peerKey,
            client,
            status,
            keep: !TERMINAL_STATUS_STATES.has(status.state),
            terminal,
            terminalOutcome: terminal ? 'rejected' : null,
            interacted,
            aborted: false,
          }
        } catch (error) {
          const terminalOutcome = error?.name === 'SeedPinProtocolError'
            ? error.code === 'NOT_FOUND'
              ? 'notFound'
              : error.code === 'FORBIDDEN'
                ? 'forbidden'
                : null
            : null
          return {
            peerKey,
            client,
            status: null,
            keep: false,
            terminal: terminalOutcome !== null,
            terminalOutcome,
            interacted,
            aborted: error instanceof ContentReplicationAbortError,
          }
        }
      })

      for (const result of statusResults) {
        if (result.aborted) aborted = true
        if (result.status !== null) usefulStatusHint = observeStatus(result.peerKey, result.status) || usefulStatusHint
        if (result.interacted) {
          const previousResult = peerResults.get(result.peerKey)
          peerResults.set(result.peerKey, Object.freeze({
            ...previousResult,
            lastInteractionRevision: statusInteractionRevision,
          }))
          currentRunPeerKeys.add(result.peerKey)
          historyChanged = true
        }
        if (result.terminal) {
          acceptedPeerKeys.delete(result.peerKey)
          const previousResult = peerResults.get(result.peerKey)
          peerResults.set(result.peerKey, Object.freeze({
            ...previousResult,
            outcome: result.terminalOutcome,
          }))
          currentRunPeerKeys.add(result.peerKey)
          historyChanged = true
        }
        if (result.keep && clients.get(result.peerKey) === result.client) {
          continuing.push({ peerKey: result.peerKey, client: result.client })
        }
      }
      if (historyChanged && await persistPeerHistory()) return run(operation, signal, deadlineAt)
      if (usefulStatusHint && await assess()) {
        await persist('durabilityVerified')
        return advancePublication()
      }
      if (aborted || signal?.aborted || deadlineAt - now() <= 0) return pendingResult(operation.manifest.requestId)
      statusCandidates = continuing
    }

    return pendingResult(operation.manifest.requestId)
  }

  return Object.freeze({
    replicate (input, { signal = null } = {}) {
      const deadlineAt = now() + operationTimeoutMs
      const snapshot = snapshotReplicationInput(
        input,
        getTrustedRelayKeys,
        getPairedDeviceKeys,
      )
      const key = `${snapshot.manifest.channelKey}\u0000${snapshot.manifest.rowId}`
      return (async () => {
        try {
          return await withKeyLock(
            key,
            signal,
            deadlineAt,
            async () => {
              const operation = await buildCanonicalInput(
                snapshot,
                createManifest,
                { signal, deadlineAt, now },
              )
              return run(operation, signal, deadlineAt)
            },
          )
        } catch (error) {
          if (error instanceof ContentReplicationAbortError) {
            return pendingResult(snapshot.manifest.requestId)
          }
          throw error
        }
      })()
    },
  })
}
