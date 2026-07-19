import b4a from 'b4a'
import c from 'compact-encoding'
import sodium from 'sodium-universal'

import { createDurableManifest } from './manifest.js'
import {
  MAX_SEED_PIN_ERROR_BYTES,
  MAX_SEED_PIN_REFS,
  SEED_PIN_ERROR_CODES,
  SEED_PIN_REF_STATES,
  SEED_PIN_STATUS_STATES,
} from './protocol.js'

const RECORD_VERSION = 1
const RECORD_MAGIC = b4a.from([0x50, 0x53, RECORD_VERSION, 0x00])
const REQUEST_PREFIX = 'seed-pin/v1/request/'
const CHANNEL_PREFIX = 'seed-pin/v1/channel/'
const ACTIVE_PREFIX = 'seed-pin/v1/active/'
const RESUMABLE_PREFIX = 'seed-pin/v1/resumable/'
const HEX_32 = /^[0-9a-f]{64}$/
const MAX_BODY_BYTES = 512 * 1024
const MAX_PIN_RECORD_BYTES = 512 * 1024
const MAX_INDEX_KEY_BYTES = 256
const DEFAULT_LEASE_DURATION = 30_000
const DEFAULT_MAX_RESUMABLE = 256
const FEED_LOCKS = new Map()
const STATUS_STATES = new Set(SEED_PIN_STATUS_STATES)
const REF_STATES = new Set(SEED_PIN_REF_STATES)
const ERROR_CODES = new Set(Object.values(SEED_PIN_ERROR_CODES))
const ADMISSION_STATES = new Set(['accepted', 'rejected', 'retryable-admission'])
const RESUMABLE_STATES = new Set(['accepted', 'pinning', 'retryable'])
const ACTIVE_STATES = new Set([...RESUMABLE_STATES, 'complete'])
const WORKER_STATES = new Set([
  'accepted',
  'pinning',
  'complete',
  'failed',
  'retryable',
  'cancelled',
  'released',
])
const WORKER_TRANSITIONS = new Map([
  ['accepted', new Set(WORKER_STATES)],
  ['pinning', new Set(['pinning', 'complete', 'failed', 'retryable', 'cancelled', 'released'])],
  ['retryable', new Set(['pinning', 'complete', 'failed', 'retryable', 'cancelled', 'released'])],
  ['complete', new Set(['complete', 'cancelled', 'released'])],
  ['failed', new Set(['failed', 'cancelled', 'released'])],
  ['cancelled', new Set(['cancelled'])],
  ['released', new Set(['released'])],
])

export const MAX_RESUMABLE_SEED_PINS = DEFAULT_MAX_RESUMABLE

export class PinStore {
  constructor ({
    db,
    leaseDuration = DEFAULT_LEASE_DURATION,
    maxResumable = DEFAULT_MAX_RESUMABLE,
    now = Date.now,
  } = {}) {
    if (!db || typeof db.get !== 'function' || typeof db.batch !== 'function' ||
        typeof db.createReadStream !== 'function') {
      throw new TypeError('db must be the existing writable metadata Hyperbee')
    }
    if (!Number.isSafeInteger(leaseDuration) || leaseDuration <= 0) {
      throw new RangeError('leaseDuration must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxResumable) || maxResumable <= 0 ||
        maxResumable > DEFAULT_MAX_RESUMABLE) {
      throw new RangeError(`maxResumable must be between 1 and ${DEFAULT_MAX_RESUMABLE}`)
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    this.db = db
    this.leaseDuration = leaseDuration
    this.maxResumable = maxResumable
    this.now = now
  }

  async claimVerified ({ request, owner, authorizationDigest, acceptedAt, claimedAt } = {}) {
    const normalizedRequest = normalizeVerifiedRequest(request)
    const normalizedOwner = normalizeOwner(owner)
    const digest = normalizeHex32(authorizationDigest, 'authorizationDigest')
    const accepted = normalizeTimestamp(acceptedAt, 'acceptedAt')
    const claimed = normalizeTimestamp(claimedAt, 'claimedAt')
    if (claimed > Number.MAX_SAFE_INTEGER - this.leaseDuration) {
      throw new RangeError('claim lease expiry exceeds the safe integer range')
    }
    const bodyDigest = digestRequestBody(request)

    return withFeedLock(this.db, async () => {
      const existing = await this._read(normalizedRequest.requestId)
      if (existing !== null) {
        if (!sameOwner(existing.owner, normalizedOwner) ||
            existing.authorizationDigest !== digest ||
            existing.bodyDigest !== bodyDigest) {
          return claimResult('conflict', existing, null)
        }
        const reclaimable = existing.status.state === 'retryable-admission' ||
          (existing.status.state === 'admitting' &&
            Number.isSafeInteger(existing.claimExpiresAt) &&
            claimed >= existing.claimExpiresAt)
        if (!reclaimable) return claimResult('matched', existing, null)
      }

      const claimToken = randomToken()
      const claimExpiresAt = claimed + this.leaseDuration
      const firstAcceptedAt = existing === null ? accepted : existing.acceptedAt
      const updatedAt = Math.max(
        firstAcceptedAt,
        claimed,
        existing?.updatedAt || 0,
        existing?.status.updatedAt || 0,
      )
      const refs = existing?.status.refs || initialStatusRefs(normalizedRequest.manifest)
      const record = normalizeRecord({
        version: RECORD_VERSION,
        requestId: normalizedRequest.requestId,
        manifest: normalizedRequest.manifest,
        owner: normalizedOwner,
        authorizationDigest: digest,
        bodyDigest,
        acceptedAt: firstAcceptedAt,
        updatedAt,
        claimedAt: claimed,
        claimExpiresAt,
        claimToken,
        status: {
          requestId: normalizedRequest.requestId,
          state: 'admitting',
          acceptedAt: firstAcceptedAt,
          updatedAt,
          completedAt: null,
          errorCode: null,
          error: null,
          refs,
        },
        progress: existing?.progress || { downloadedBlocks: 0, downloadedBytes: 0 },
      })
      await this._write(record)
      return claimResult('claimed', record, claimToken)
    })
  }

  async finalizeAdmission ({ requestId, authorizationDigest, claimToken, decision } = {}) {
    const id = normalizeHex32(requestId, 'requestId')
    const digest = normalizeHex32(authorizationDigest, 'authorizationDigest')
    const token = normalizeHex32(claimToken, 'claimToken')
    const normalizedDecision = normalizeDecision(decision)

    return withFeedLock(this.db, async () => {
      const existing = await this._read(id)
      if (existing === null) throw new Error('seed pin record not found')
      const current = existing.status.state === 'admitting' &&
        existing.authorizationDigest === digest &&
        existing.claimToken === token &&
        Number.isSafeInteger(existing.claimExpiresAt) &&
        normalizedDecision.updatedAt < existing.claimExpiresAt
      if (!current) return finalizeResult('conflict', existing)

      const updatedAt = Math.max(
        existing.acceptedAt,
        existing.updatedAt,
        existing.status.updatedAt,
        normalizedDecision.updatedAt,
      )
      const record = normalizeRecord({
        ...existing,
        updatedAt,
        claimToken: null,
        claimExpiresAt: null,
        status: {
          ...existing.status,
          state: normalizedDecision.state,
          updatedAt,
          completedAt: null,
          errorCode: normalizedDecision.code,
          error: normalizedDecision.error,
        },
      })
      await this._write(record)
      return finalizeResult('finalized', record)
    })
  }

  async getByRequestId (requestId) {
    const record = await this._read(normalizeHex32(requestId, 'requestId'))
    return record === null ? null : cloneRecord(record)
  }

  async getOwnedStatus ({ requestId, identityPublicKey, devicePublicKey } = {}) {
    const id = normalizeHex32(requestId, 'requestId')
    const owner = normalizeOwner({ identityPublicKey, devicePublicKey })
    const record = await this._read(id)
    if (record === null || !sameOwner(record.owner, owner)) return null
    return cloneStatus(record.status)
  }

  async listResumable ({ limit = this.maxResumable } = {}) {
    const bounded = normalizeListLimit(limit, this.maxResumable)
    return this._readIndexPage({
      prefix: RESUMABLE_PREFIX,
      limit: bounded,
      states: RESUMABLE_STATES,
      name: 'resumable',
    })
  }

  async listActive ({ limit = this.maxResumable, cursor = null } = {}) {
    const bounded = normalizeListLimit(limit, this.maxResumable)
    const cursorKey = cursor === null ? null : normalizeActiveCursor(cursor)
    return this._readIndexPage({
      prefix: ACTIVE_PREFIX,
      limit: bounded,
      cursorKey,
      states: ACTIVE_STATES,
      name: 'active',
      captureError: true,
    })
  }

  async updateWorkerStatus (input = {}) {
    const normalized = normalizeWorkerUpdate(input)
    return withFeedLock(this.db, async () => {
      const existing = await this._read(normalized.requestId)
      if (existing === null) throw new Error('seed pin record not found')
      if (existing.status.state === 'admitting' || existing.status.state === 'retryable-admission' ||
          existing.status.state === 'rejected') {
        throw new Error(`seed pin record is not admitted: ${existing.status.state}`)
      }
      if (!WORKER_TRANSITIONS.get(existing.status.state)?.has(normalized.state)) {
        return cloneRecord(existing)
      }

      const refs = mergeProgressRefs(existing.status.refs, normalized.refs)
      if (normalized.state === 'complete' && refs.some(ref => ref.state !== 'complete')) {
        throw new Error('cannot complete a seed pin before every ref is locally complete')
      }
      const downloadedBlocks = Math.max(
        existing.progress.downloadedBlocks,
        normalized.downloadedBlocks,
      )
      const downloadedBytes = Math.max(
        existing.progress.downloadedBytes,
        normalized.downloadedBytes,
      )
      const clock = normalizeTimestamp(this.now(), 'now')
      const updatedAt = Math.max(
        existing.acceptedAt,
        existing.updatedAt,
        existing.status.updatedAt,
        normalized.updatedAt,
        clock,
      )
      const completedAt = normalized.state === 'complete'
        ? Math.max(existing.acceptedAt, normalized.completedAt ?? updatedAt)
        : null
      const record = normalizeRecord({
        ...existing,
        updatedAt,
        status: {
          ...existing.status,
          state: normalized.state,
          updatedAt,
          completedAt,
          errorCode: normalized.errorCode,
          error: normalized.error,
          refs,
        },
        progress: { downloadedBlocks, downloadedBytes },
      })
      await this._write(record)
      return cloneRecord(record)
    })
  }

  async reopenCompleteForRepair ({ requestId, refIndex, updatedAt } = {}) {
    const id = normalizeHex32(requestId, 'requestId')
    const updated = normalizeTimestamp(updatedAt, 'updatedAt')
    if (!Number.isSafeInteger(refIndex) || refIndex < 0 || refIndex >= MAX_SEED_PIN_REFS) {
      throw new RangeError('refIndex must be an in-range nonnegative safe integer')
    }
    return withFeedLock(this.db, async () => {
      const existing = await this._read(id)
      if (existing === null) throw new Error('seed pin record not found')
      if (existing.status.state !== 'complete') return cloneRecord(existing)
      if (refIndex >= existing.status.refs.length) throw new RangeError('refIndex is outside stored refs')
      const clock = normalizeTimestamp(this.now(), 'now')
      const nextUpdatedAt = Math.max(existing.updatedAt, existing.status.updatedAt, updated, clock)
      const refs = existing.status.refs.map((ref, index) => ({
        ...ref,
        state: index < refIndex ? 'complete' : index === refIndex ? 'pinning' : 'pending',
      }))
      const record = normalizeRecord({
        ...existing,
        updatedAt: nextUpdatedAt,
        status: {
          ...existing.status,
          state: 'pinning',
          updatedAt: nextUpdatedAt,
          completedAt: null,
          errorCode: null,
          error: null,
          refs,
        },
      })
      await this._write(record)
      return cloneRecord(record)
    })
  }

  async _read (requestId) {
    const node = await this.db.get(requestKey(requestId), {
      keyEncoding: 'utf-8',
      valueEncoding: c.raw,
    })
    if (node === null) return null
    const record = decodeRecord(node.value)
    if (record.requestId !== requestId) throw new Error('malformed seed pin record requestId')
    return record
  }

  async _readIndexPage ({
    prefix,
    limit,
    cursorKey = null,
    states,
    name,
    captureError = false,
  }) {
    const range = {
      lt: `${prefix}\xff`,
      limit,
      keyEncoding: 'utf-8',
      valueEncoding: c.raw,
    }
    if (cursorKey === null) range.gte = prefix
    else range.gt = cursorKey
    const records = []
    for await (const node of this.db.createReadStream(range)) {
      const rawCursor = normalizeRawIndexCursor(node.key, prefix, name)
      let indexRequestId = null
      let record
      try {
        indexRequestId = normalizeIndexKey(node.key, prefix, name)
        record = decodeRecord(node.value)
        if (record.requestId !== indexRequestId) {
          throw new Error(`malformed seed pin ${name} index key`)
        }
        if (!states.has(record.status.state)) {
          throw new Error(`malformed seed pin ${name} index state`)
        }
      } catch (error) {
        const cursor = indexRequestId || rawCursor
        error.cursor = cursor
        if (!captureError) throw error
        return { records, cursor, error }
      }
      records.push(cloneRecord(record))
    }
    if (!captureError) return records
    return {
      records,
      cursor: records.length === limit ? records[records.length - 1].requestId : null,
      error: null,
    }
  }

  async _write (record) {
    const normalized = normalizeRecord(record)
    const encoded = encodeRecord(normalized)
    const batch = this.db.batch({ keyEncoding: 'utf-8', valueEncoding: c.raw })
    try {
      await batch.put(requestKey(normalized.requestId), encoded)
      await batch.put(channelIndexKey(normalized.manifest), encoded)
      if (ACTIVE_STATES.has(normalized.status.state)) {
        await batch.put(activeIndexKey(normalized.requestId), encoded)
      } else {
        await batch.del(activeIndexKey(normalized.requestId))
      }
      if (RESUMABLE_STATES.has(normalized.status.state)) {
        await batch.put(resumableIndexKey(normalized.requestId), encoded)
      } else {
        await batch.del(resumableIndexKey(normalized.requestId))
      }
      await batch.flush()
    } catch (error) {
      await batch.close().catch(() => {})
      throw error
    }
  }
}

export function createPinStore (options) {
  return new PinStore(options)
}


async function withFeedLock (db, operation) {
  const key = await metadataFeedKey(db)
  let lock = FEED_LOCKS.get(key)
  if (lock === undefined) {
    lock = { tail: Promise.resolve(), users: 0 }
    FEED_LOCKS.set(key, lock)
  }
  lock.users++
  const previous = lock.tail
  let release
  const gate = new Promise(resolve => { release = resolve })
  lock.tail = previous.then(() => gate)
  await previous
  try {
    return await operation()
  } finally {
    release()
    lock.users--
    if (lock.users === 0 && FEED_LOCKS.get(key) === lock) FEED_LOCKS.delete(key)
  }
}

async function metadataFeedKey (db) {
  if (typeof db.ready === 'function') await db.ready()
  const core = db.core
  if (!core || (typeof core !== 'object' && typeof core !== 'function')) {
    throw new TypeError('metadata Hyperbee must expose its core')
  }
  if (typeof core.ready === 'function') await core.ready()
  const key = core.discoveryKey || core.key
  if (!(key instanceof Uint8Array) && !b4a.isBuffer(key)) {
    throw new TypeError('metadata core must expose a stable discovery key')
  }
  if (key.byteLength !== 32) throw new TypeError('metadata discovery key must be 32 bytes')
  return b4a.toString(key, 'hex')
}

function normalizeActiveCursor (cursor) {
  if (typeof cursor !== 'string') throw new TypeError('cursor must be a string')
  if (HEX_32.test(cursor)) return `${ACTIVE_PREFIX}${cursor}`
  return normalizeRawIndexCursor(cursor, ACTIVE_PREFIX, 'active')
}

function normalizeRawIndexCursor (key, prefix, name) {
  if (typeof key !== 'string' || !key.startsWith(prefix) || key <= prefix ||
      key >= `${prefix}\xff` || b4a.byteLength(key) > MAX_INDEX_KEY_BYTES) {
    throw new Error(`malformed seed pin ${name} index key`)
  }
  return key
}

function normalizeIndexKey (key, prefix, name) {
  if (typeof key !== 'string' || key.length !== prefix.length + 64) {
    throw new Error(`malformed seed pin ${name} index key`)
  }
  const requestId = key.slice(prefix.length)
  if (!HEX_32.test(requestId)) throw new Error(`malformed seed pin ${name} index key`)
  return requestId
}

function requestKey (requestId) {
  return `${REQUEST_PREFIX}${requestId}`
}

function channelIndexKey (manifest) {
  return `${CHANNEL_PREFIX}${manifest.channelKey}/${manifest.requestId}`
}

function activeIndexKey (requestId) {
  return `${ACTIVE_PREFIX}${requestId}`
}

function resumableIndexKey (requestId) {
  return `${RESUMABLE_PREFIX}${requestId}`
}

function normalizeVerifiedRequest (request) {
  assertPlainObject(request, 'request')
  assertExactFields(request, [
    'version', 'manifest', 'requestId', 'expiresAt', 'signedDescriptor', 'attestation',
  ], 'request')
  if (request.version !== 1) throw new TypeError('unsupported seed pin request version')
  const requestId = normalizeHex32(request.requestId, 'request.requestId')
  const expiresAt = normalizeTimestamp(request.expiresAt, 'request.expiresAt')
  if (expiresAt === 0) throw new RangeError('request.expiresAt must be positive')
  assertPlainObject(request.signedDescriptor, 'request.signedDescriptor')
  assertExactFields(request.signedDescriptor, ['schema', 'descriptor', 'proof', 'attestation'], 'request.signedDescriptor')
  if (typeof request.signedDescriptor.schema !== 'string') {
    throw new TypeError('request.signedDescriptor.schema must be a string')
  }
  assertPlainObject(request.signedDescriptor.descriptor, 'request.signedDescriptor.descriptor')
  normalizeOpaqueBytes(request.signedDescriptor.proof, 'request.signedDescriptor.proof')
  normalizeOpaqueBytes(request.signedDescriptor.attestation, 'request.signedDescriptor.attestation')
  normalizeOpaqueBytes(request.attestation, 'request.attestation')
  const manifest = normalizeManifest(request.manifest)
  if (manifest.requestId !== requestId) throw new Error('requestId must match canonical manifest')
  return { version: 1, manifest, requestId, expiresAt }
}

function normalizeManifest (manifest) {
  assertPlainObject(manifest, 'manifest')
  assertExactFields(manifest, ['version', 'channelKey', 'rowId', 'refs', 'assets', 'requestId'], 'manifest')
  if (!Array.isArray(manifest.refs) || manifest.refs.length === 0 || manifest.refs.length > MAX_SEED_PIN_REFS) {
    throw new RangeError(`manifest.refs must contain between 1 and ${MAX_SEED_PIN_REFS} entries`)
  }
  for (let index = 0; index < manifest.refs.length; index++) {
    assertPlainObject(manifest.refs[index], `manifest.refs[${index}]`)
    assertExactFields(manifest.refs[index], ['coreKey', 'start', 'end', 'kind'], `manifest.refs[${index}]`)
  }
  assertPlainObject(manifest.assets, 'manifest.assets')
  assertExactFields(manifest.assets, ['media', 'thumbnail', 'artwork'], 'manifest.assets')
  assertPlainObject(manifest.assets.artwork, 'manifest.assets.artwork')
  assertExactFields(
    manifest.assets.artwork,
    ['avatar', 'poster', 'banner', 'backdrop'],
    'manifest.assets.artwork',
  )
  const canonical = createDurableManifest(manifest)
  if (!sameManifest(manifest, canonical)) throw new Error('manifest must be canonical')
  return cloneManifest(canonical)
}

function sameManifest (left, right) {
  if (left.version !== right.version || left.channelKey !== right.channelKey ||
      left.rowId !== right.rowId || left.requestId !== right.requestId ||
      left.refs.length !== right.refs.length) return false
  for (let index = 0; index < left.refs.length; index++) {
    const a = left.refs[index]
    const b = right.refs[index]
    if (a.coreKey !== b.coreKey || a.start !== b.start || a.end !== b.end || a.kind !== b.kind) return false
  }
  if (!sameArray(left.assets.media, right.assets.media) || left.assets.thumbnail !== right.assets.thumbnail) return false
  for (const role of ['avatar', 'poster', 'banner', 'backdrop']) {
    if (left.assets.artwork[role] !== right.assets.artwork[role]) return false
  }
  return true
}

function normalizeOwner (owner) {
  assertPlainObject(owner, 'owner')
  assertExactFields(owner, ['identityPublicKey', 'devicePublicKey'], 'owner')
  return {
    identityPublicKey: normalizeHex32(owner.identityPublicKey, 'owner.identityPublicKey'),
    devicePublicKey: normalizeHex32(owner.devicePublicKey, 'owner.devicePublicKey'),
  }
}

function normalizeDecision (decision) {
  assertPlainObject(decision, 'decision')
  assertExactFields(decision, ['state', 'code', 'error', 'updatedAt'], 'decision')
  if (!ADMISSION_STATES.has(decision.state)) throw new TypeError('unsupported admission decision state')
  const code = decision.code === null ? null : normalizeErrorCode(decision.code)
  if (decision.error !== null) throw new TypeError('admission decision.error must be null')
  if (decision.state === 'accepted' && code !== null) {
    throw new TypeError('accepted admission decision code must be null')
  }
  if (decision.state !== 'accepted' && code === null) {
    throw new TypeError('non-accepted admission decision requires an error code')
  }
  return {
    state: decision.state,
    code,
    error: null,
    updatedAt: normalizeTimestamp(decision.updatedAt, 'decision.updatedAt'),
  }
}

function normalizeWorkerUpdate (input) {
  assertPlainObject(input, 'worker update')
  assertExactFields(input, [
    'requestId', 'state', 'refs', 'errorCode', 'error', 'completedAt',
    'downloadedBlocks', 'downloadedBytes', 'updatedAt',
  ], 'worker update')
  if (!WORKER_STATES.has(input.state)) throw new TypeError('unsupported worker state')
  if (!Array.isArray(input.refs) || input.refs.length > MAX_SEED_PIN_REFS) {
    throw new RangeError('worker refs are out of bounds')
  }
  const errorCode = input.errorCode === null ? null : normalizeErrorCode(input.errorCode)
  const error = normalizeOptionalError(input.error)
  if ((input.state === 'pinning' || input.state === 'complete' || input.state === 'accepted') &&
      (errorCode !== null || error !== null)) {
    throw new TypeError(`${input.state} worker state cannot contain an error`)
  }
  return {
    requestId: normalizeHex32(input.requestId, 'requestId'),
    state: input.state,
    refs: input.refs.map((ref, index) => normalizeStatusRef(ref, `refs[${index}]`)),
    errorCode,
    error,
    completedAt: input.completedAt === null
      ? null
      : normalizeTimestamp(input.completedAt, 'completedAt'),
    downloadedBlocks: normalizeTimestamp(input.downloadedBlocks, 'downloadedBlocks'),
    downloadedBytes: normalizeTimestamp(input.downloadedBytes, 'downloadedBytes'),
    updatedAt: normalizeTimestamp(input.updatedAt, 'updatedAt'),
  }
}

function normalizeRecord (record) {
  assertPlainObject(record, 'record')
  assertExactFields(record, [
    'version', 'requestId', 'manifest', 'owner', 'authorizationDigest', 'bodyDigest',
    'acceptedAt', 'updatedAt', 'claimedAt', 'claimExpiresAt', 'claimToken', 'status', 'progress',
  ], 'record')
  if (record.version !== RECORD_VERSION) throw new Error('unsupported seed pin record version')
  const requestId = normalizeHex32(record.requestId, 'record.requestId')
  const manifest = normalizeManifest(record.manifest)
  if (manifest.requestId !== requestId) throw new Error('record manifest requestId mismatch')
  const acceptedAt = normalizeTimestamp(record.acceptedAt, 'record.acceptedAt')
  const updatedAt = normalizeTimestamp(record.updatedAt, 'record.updatedAt')
  if (updatedAt < acceptedAt) throw new Error('record updatedAt regressed before acceptedAt')
  const claimedAt = record.claimedAt === null ? null : normalizeTimestamp(record.claimedAt, 'record.claimedAt')
  const claimExpiresAt = record.claimExpiresAt === null
    ? null
    : normalizeTimestamp(record.claimExpiresAt, 'record.claimExpiresAt')
  const claimToken = record.claimToken === null ? null : normalizeHex32(record.claimToken, 'record.claimToken')
  if (record.status?.state === 'admitting') {
    if (claimedAt === null || claimExpiresAt === null || claimToken === null || claimExpiresAt <= claimedAt) {
      throw new Error('malformed active seed pin claim lease')
    }
  } else if (claimExpiresAt !== null || claimToken !== null) {
    throw new Error('malformed inactive seed pin claim lease')
  }
  const status = normalizeStatus(record.status, manifest, requestId, acceptedAt)
  if (status.updatedAt > updatedAt) throw new Error('record status updatedAt exceeds record updatedAt')
  assertPlainObject(record.progress, 'record.progress')
  assertExactFields(record.progress, ['downloadedBlocks', 'downloadedBytes'], 'record.progress')
  const progress = {
    downloadedBlocks: normalizeTimestamp(record.progress.downloadedBlocks, 'record.progress.downloadedBlocks'),
    downloadedBytes: normalizeTimestamp(record.progress.downloadedBytes, 'record.progress.downloadedBytes'),
  }
  return {
    version: RECORD_VERSION,
    requestId,
    manifest,
    owner: normalizeOwner(record.owner),
    authorizationDigest: normalizeHex32(record.authorizationDigest, 'record.authorizationDigest'),
    bodyDigest: normalizeHex32(record.bodyDigest, 'record.bodyDigest'),
    acceptedAt,
    updatedAt,
    claimedAt,
    claimExpiresAt,
    claimToken,
    status,
    progress,
  }
}

function normalizeStatus (status, manifest, requestId, acceptedAt) {
  assertPlainObject(status, 'status')
  assertExactFields(status, [
    'requestId', 'state', 'acceptedAt', 'updatedAt', 'completedAt', 'errorCode', 'error', 'refs',
  ], 'status')
  if (normalizeHex32(status.requestId, 'status.requestId') !== requestId) {
    throw new Error('status requestId mismatch')
  }
  if (!STATUS_STATES.has(status.state)) throw new Error('unsupported stored seed pin status')
  if (normalizeTimestamp(status.acceptedAt, 'status.acceptedAt') !== acceptedAt) {
    throw new Error('status acceptedAt mismatch')
  }
  const updatedAt = normalizeTimestamp(status.updatedAt, 'status.updatedAt')
  if (updatedAt < acceptedAt) throw new Error('status updatedAt regressed before acceptedAt')
  const completedAt = status.completedAt === null
    ? null
    : normalizeTimestamp(status.completedAt, 'status.completedAt')
  if (status.state === 'complete' && (completedAt === null || completedAt < acceptedAt)) {
    throw new Error('complete status requires completedAt')
  }
  if (status.state !== 'complete' && completedAt !== null) {
    throw new Error('non-complete status cannot contain completedAt')
  }
  if (!Array.isArray(status.refs) || status.refs.length !== manifest.refs.length ||
      status.refs.length > MAX_SEED_PIN_REFS) {
    throw new Error('status refs do not match manifest refs')
  }
  const refs = status.refs.map((ref, index) => {
    const normalized = normalizeStatusRef(ref, `status.refs[${index}]`)
    const expected = manifest.refs[index]
    if (normalized.coreKey !== expected.coreKey || normalized.start !== expected.start ||
        normalized.end !== expected.end || normalized.kind !== expected.kind) {
      throw new Error('status ref does not match manifest ref')
    }
    return normalized
  })
  return {
    requestId,
    state: status.state,
    acceptedAt,
    updatedAt,
    completedAt,
    errorCode: status.errorCode === null ? null : normalizeErrorCode(status.errorCode),
    error: normalizeOptionalError(status.error),
    refs,
  }
}

function normalizeStatusRef (ref, name) {
  assertPlainObject(ref, name)
  assertExactFields(ref, ['coreKey', 'start', 'end', 'kind', 'state', 'bytesPinned'], name)
  const coreKey = normalizeHex32(ref.coreKey, `${name}.coreKey`)
  const start = normalizeTimestamp(ref.start, `${name}.start`)
  const end = normalizeTimestamp(ref.end, `${name}.end`)
  if (end <= start) throw new RangeError(`${name}.end must be greater than start`)
  if (!['media', 'thumbnail', 'artwork'].includes(ref.kind)) throw new TypeError(`${name}.kind is invalid`)
  if (!REF_STATES.has(ref.state)) throw new TypeError(`${name}.state is invalid`)
  return {
    coreKey,
    start,
    end,
    kind: ref.kind,
    state: ref.state,
    bytesPinned: normalizeTimestamp(ref.bytesPinned, `${name}.bytesPinned`),
  }
}

function mergeProgressRefs (previous, next) {
  if (previous.length !== next.length) throw new Error('worker refs do not match stored refs')
  return previous.map((oldRef, index) => {
    const newRef = next[index]
    if (oldRef.coreKey !== newRef.coreKey || oldRef.start !== newRef.start ||
        oldRef.end !== newRef.end || oldRef.kind !== newRef.kind) {
      throw new Error('worker ref identity does not match stored ref')
    }
    const bytesPinned = Math.max(oldRef.bytesPinned, newRef.bytesPinned)
    let state = newRef.state
    if (oldRef.state === 'complete') state = 'complete'
    else if (oldRef.state === 'pinning' && state === 'pending') state = 'pinning'
    return { ...oldRef, state, bytesPinned }
  })
}

function initialStatusRefs (manifest) {
  return manifest.refs.map(ref => ({ ...ref, state: 'pending', bytesPinned: 0 }))
}

function encodeRecord (record) {
  const body = b4a.from(JSON.stringify(record))
  const encoded = b4a.concat([RECORD_MAGIC, body])
  if (encoded.byteLength > MAX_PIN_RECORD_BYTES) {
    throw new RangeError('seed pin record is too large')
  }
  return encoded
}

function decodeRecord (value) {
  if (!(value instanceof Uint8Array) && !b4a.isBuffer(value)) {
    throw new Error('malformed seed pin record value')
  }
  if (value.byteLength > MAX_PIN_RECORD_BYTES) {
    throw new Error('seed pin record is too large')
  }
  if (value.byteLength <= RECORD_MAGIC.byteLength ||
      !b4a.equals(value.subarray(0, RECORD_MAGIC.byteLength), RECORD_MAGIC)) {
    throw new Error('malformed or unsupported seed pin record version')
  }
  let decoded
  try {
    decoded = JSON.parse(b4a.toString(value.subarray(RECORD_MAGIC.byteLength)))
  } catch {
    throw new Error('malformed seed pin record encoding')
  }
  return normalizeRecord(decoded)
}

function digestRequestBody (request) {
  const canonical = stableValue(request, new Set())
  const encoded = b4a.from(JSON.stringify(canonical))
  if (encoded.byteLength > MAX_BODY_BYTES) throw new RangeError('request body is too large')
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, encoded)
  return b4a.toString(digest, 'hex')
}

function stableValue (value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('request body numbers must be finite')
    return Object.is(value, -0) ? 0 : value
  }
  if (value instanceof Uint8Array || b4a.isBuffer(value)) {
    return { $bytes: b4a.toString(value, 'hex') }
  }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('request body must be finite plain data')
  seen.add(value)
  let normalized
  if (Array.isArray(value)) {
    normalized = value.map(entry => stableValue(entry, seen))
  } else {
    assertPlainObject(value, 'request body value')
    normalized = {}
    for (const key of Object.keys(value).sort()) normalized[key] = stableValue(value[key], seen)
  }
  seen.delete(value)
  return normalized
}

function randomToken () {
  const token = b4a.allocUnsafe(32)
  sodium.randombytes_buf(token)
  return b4a.toString(token, 'hex')
}

function normalizeOpaqueBytes (value, name) {
  if (typeof value === 'string') {
    if (value.length === 0) throw new TypeError(`${name} must not be empty`)
    return value
  }
  if ((value instanceof Uint8Array || b4a.isBuffer(value)) && value.byteLength > 0) return b4a.from(value)
  throw new TypeError(`${name} must be non-empty bytes or a string`)
}

function normalizeHex32 (value, name) {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new TypeError(`${name} must be a lowercase 32-byte hex value`)
  }
  return value
}

function normalizeListLimit (value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('limit must be a positive safe integer')
  }
  return Math.min(value, maximum)
}

function normalizeTimestamp (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`)
  }
  return value
}

function normalizeErrorCode (value) {
  if (typeof value !== 'string' || !ERROR_CODES.has(value)) throw new TypeError('invalid seed pin error code')
  return value
}

function normalizeOptionalError (value) {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError('status error must be a string or null')
  const bytes = b4a.from(value)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SEED_PIN_ERROR_BYTES || b4a.toString(bytes) !== value) {
    throw new RangeError(`status error must be between 1 and ${MAX_SEED_PIN_ERROR_BYTES} UTF-8 bytes`)
  }
  return value
}

function assertPlainObject (value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertExactFields (value, expected, name) {
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError(`${name} must contain exactly ${expected.join(', ')}`)
  }
}

function sameOwner (left, right) {
  return left.identityPublicKey === right.identityPublicKey &&
    left.devicePublicKey === right.devicePublicKey
}

function sameArray (left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function claimResult (outcome, record, claimToken) {
  return { outcome, record: cloneRecord(record), claimToken }
}

function finalizeResult (outcome, record) {
  return { outcome, record: cloneRecord(record) }
}

function cloneManifest (manifest) {
  return {
    version: manifest.version,
    channelKey: manifest.channelKey,
    rowId: manifest.rowId,
    refs: manifest.refs.map(ref => ({ ...ref })),
    assets: {
      media: [...manifest.assets.media],
      thumbnail: manifest.assets.thumbnail,
      artwork: { ...manifest.assets.artwork },
    },
    requestId: manifest.requestId,
  }
}

function cloneStatus (status) {
  return {
    requestId: status.requestId,
    state: status.state,
    acceptedAt: status.acceptedAt,
    updatedAt: status.updatedAt,
    completedAt: status.completedAt,
    errorCode: status.errorCode,
    error: status.error,
    refs: status.refs.map(ref => ({ ...ref })),
  }
}

function cloneRecord (record) {
  return {
    version: record.version,
    requestId: record.requestId,
    manifest: cloneManifest(record.manifest),
    owner: { ...record.owner },
    authorizationDigest: record.authorizationDigest,
    bodyDigest: record.bodyDigest,
    acceptedAt: record.acceptedAt,
    updatedAt: record.updatedAt,
    claimedAt: record.claimedAt,
    claimExpiresAt: record.claimExpiresAt,
    claimToken: record.claimToken,
    status: cloneStatus(record.status),
    progress: { ...record.progress },
  }
}
