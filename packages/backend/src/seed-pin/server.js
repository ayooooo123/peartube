import b4a from 'b4a'
import Protomux from 'protomux'

import { verifySeedPinRequest } from './auth.js'
import {
  PIN_REQUEST_ENCODING,
  PIN_RESPONSE_ENCODING,
  SEED_PIN_ERROR_CODES,
  SeedPinVerificationLimiter,
  SEED_PIN_PROTOCOL,
  STATUS_REQUEST_ENCODING,
  STATUS_RESPONSE_ENCODING,
  isInvalidSeedPinWireMessage,
  seedPinAuthorizationDigest,
  seedPinErrorResponse,
  seedPinSuccessResponse,
  verifySeedPinStatusRequest,
} from './protocol.js'

const RESUMABLE_RECORD_STATES = new Set(['accepted', 'retryable'])
const SUPPORTED_RECORD_STATES = new Set([
  'accepted',
  'pinning',
  'retryable',
  'complete',
  'failed',
  'cancelled',
  'released',
  'admitting',
  'retryable-admission',
  'rejected',
])
const CLAIM_OUTCOMES = new Set(['claimed', 'matched', 'conflict'])
const FINALIZE_OUTCOMES = new Set(['finalized', 'conflict'])

/**
 * - claimVerified({ request, owner, authorizationDigest, acceptedAt, claimedAt }) ->
 *   { outcome: 'claimed' | 'matched' | 'conflict', record, claimToken }
 * - finalizeAdmission({ requestId, authorizationDigest, claimToken, decision }) ->
 *   { outcome: 'finalized' | 'conflict', record }
 * - getByRequestId(requestId) -> record or null
 * - getOwnedStatus({ requestId, identityPublicKey, devicePublicKey }) -> status or null
 *
 * claimVerified atomically creates or leases an `admitting` record before policy/capacity.
 * A claimed result has a fresh 32-byte lowercase-hex token and finite lease expiry in its
 * record; the store MUST reclaim expired or retryable admission leases. finalizeAdmission
 * compares both authorizationDigest and claimToken, preventing stale claimants from winning.
 * Worker start(requestId) is idempotent scheduling and receives no authorization material.
 */
export class SeedPinServer {
  constructor (streamOrMux, options = {}) {
    this.mux = Protomux.from(streamOrMux)
    this.remotePublicKey = normalizeRemotePublicKey(options.remotePublicKey)
    this.store = assertStore(options.store)
    this.worker = assertWorker(options.worker)
    this.verificationLimiter = assertVerificationLimiter(
      options.verificationLimiter || new SeedPinVerificationLimiter(),
    )
    this.admission = options.admission || allow
    this.capacity = options.capacity || allow
    if (typeof this.admission !== 'function') throw new TypeError('admission must be a function')
    if (typeof this.capacity !== 'function') throw new TypeError('capacity must be a function')
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.closed = false
    this.requestLocks = new Map()

    this.channel = this.mux.createChannel({
      protocol: SEED_PIN_PROTOCOL,
      id: options.channelId || null,
      messages: [
        { encoding: PIN_REQUEST_ENCODING, onmessage: (message) => { void this._handlePin(message) } },
        { encoding: PIN_RESPONSE_ENCODING },
        { encoding: STATUS_REQUEST_ENCODING, onmessage: (message) => { void this._handleStatus(message) } },
        { encoding: STATUS_RESPONSE_ENCODING },
      ],
    })
    if (this.channel === null) throw new Error('seed pin protocol channel is unavailable')
    this.pinResponse = this.channel.messages[1]
    this.statusResponse = this.channel.messages[3]
    this.channel.open()
  }

  opened () {
    return this.channel.fullyOpened()
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.channel.close()
  }

  async _handlePin (message) {
    if (this.closed || isInvalidSeedPinWireMessage(message)) return
    const correlationId = message.correlationId
    const wireRequestId = message.requestId
    let releaseVerification = null
    try {
      releaseVerification = this.verificationLimiter.tryAcquire()
      if (releaseVerification === null) {
        this._sendPinError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.BUSY)
        return
      }
      const now = normalizeNow(this.now())
      const verified = await verifySeedPinRequest(message.request, {
        remotePublicKey: this.remotePublicKey,
        now,
      })
      if (this.closed) return
      if (!verified.valid) {
        this._sendPinError(correlationId, wireRequestId, classifyPinVerificationError(verified.error))
        return
      }
      if (wireRequestId !== verified.requestId || message.request.requestId !== verified.requestId ||
          message.request.manifest.requestId !== verified.requestId) {
        this._sendPinError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.INVALID_REQUEST)
        return
      }
      const request = canonicalVerifiedRequest(message.request, verified)
      const authorizationDigest = seedPinAuthorizationDigest(request)
      const owner = Object.freeze({
        identityPublicKey: verified.identityPublicKey,
        devicePublicKey: verified.requesterDevicePublicKey,
      })
      const result = await this._withRequestLock(verified.requestId, async () => {
        return this._claimVerified({
          request,
          verified,
          owner,
          authorizationDigest,
          acceptedAt: now,
        })
      })
      if (result.code) this._sendPinError(correlationId, wireRequestId, result.code)
      else this._sendPinSuccess(correlationId, wireRequestId, result.status)
    } catch {
      this._sendPinError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.INTERNAL)
    } finally {
      if (releaseVerification !== null) releaseVerification()
    }
  }

  async _claimVerified (context) {
    let claim
    const claimedAt = normalizeNow(this.now())
    try {
      claim = await this.store.claimVerified({
        request: context.request,
        owner: context.owner,
        authorizationDigest: context.authorizationDigest,
        acceptedAt: context.acceptedAt,
        claimedAt,
      })
    } catch {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (!isClaimResult(claim, claimedAt)) return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    if (claim.outcome === 'conflict') return { code: SEED_PIN_ERROR_CODES.REPLAY_CONFLICT }
    if (!recordMatches(claim.record, context)) return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    if (claim.outcome === 'matched') {
      return this._resumeOwnedStatus(context.verified.requestId, context.owner)
    }
    if (claim.record.status.state !== 'admitting') {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    return this._runAdmission({ ...context, claimToken: claim.claimToken })
  }

  async _runAdmission (context) {
    const callbackContext = Object.freeze({
      request: context.request,
      verified: context.verified,
      owner: Object.freeze({ ...context.owner }),
      authorizationDigest: context.authorizationDigest,
    })
    try {
      if (await this.admission(callbackContext) !== true) {
        return this._finalizeAdmission(
          context,
          { state: 'rejected', code: SEED_PIN_ERROR_CODES.POLICY_REJECTED },
          SEED_PIN_ERROR_CODES.POLICY_REJECTED,
        )
      }
    } catch {
      return this._finalizeAdmission(
        context,
        { state: 'retryable-admission', code: SEED_PIN_ERROR_CODES.BUSY },
        SEED_PIN_ERROR_CODES.BUSY,
      )
    }
    try {
      if (await this.capacity(callbackContext) !== true) {
        return this._finalizeAdmission(
          context,
          { state: 'retryable-admission', code: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED },
          SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
        )
      }
    } catch {
      return this._finalizeAdmission(
        context,
        { state: 'retryable-admission', code: SEED_PIN_ERROR_CODES.BUSY },
        SEED_PIN_ERROR_CODES.BUSY,
      )
    }
    return this._finalizeAdmission(
      context,
      { state: 'accepted', code: null },
      null,
    )
  }

  async _finalizeAdmission (context, decision, responseCode) {
    let finalized
    try {
      finalized = await this.store.finalizeAdmission({
        requestId: context.verified.requestId,
        authorizationDigest: context.authorizationDigest,
        claimToken: context.claimToken,
        decision: Object.freeze({
          state: decision.state,
          code: decision.code,
          error: null,
          updatedAt: normalizeNow(this.now()),
        }),
      })
    } catch {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (!isFinalizeResult(finalized)) return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    if (finalized.outcome === 'conflict') {
      return {
        code: recordMatches(finalized.record, context)
          ? SEED_PIN_ERROR_CODES.BUSY
          : SEED_PIN_ERROR_CODES.REPLAY_CONFLICT,
      }
    }
    if (!recordMatches(finalized.record, context) ||
        finalized.record.status.state !== decision.state) {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (responseCode !== null) return { code: responseCode }
    return this._resumeOwnedStatus(context.verified.requestId, context.owner)
  }

  async _resumeOwnedStatus (requestId, owner) {
    let status
    try {
      status = await this.store.getOwnedStatus({ requestId, ...owner })
    } catch {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (!status || !SUPPORTED_RECORD_STATES.has(status.state)) {
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (status.state === 'admitting' || status.state === 'retryable-admission') {
      return { code: SEED_PIN_ERROR_CODES.BUSY }
    }
    if (status.state === 'rejected') {
      if (status.errorCode === SEED_PIN_ERROR_CODES.POLICY_REJECTED ||
          status.errorCode === SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED) {
        return { code: status.errorCode }
      }
      return { code: SEED_PIN_ERROR_CODES.INTERNAL }
    }
    if (RESUMABLE_RECORD_STATES.has(status.state)) {
      try {
        await this.worker.start(requestId)
      } catch {
        return { code: SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE }
      }
      try {
        status = await this.store.getOwnedStatus({ requestId, ...owner })
      } catch {
        return { code: SEED_PIN_ERROR_CODES.INTERNAL }
      }
      if (!status || !SUPPORTED_RECORD_STATES.has(status.state)) {
        return { code: SEED_PIN_ERROR_CODES.INTERNAL }
      }
    }
    return { status }
  }

  async _handleStatus (message) {
    if (this.closed || isInvalidSeedPinWireMessage(message)) return
    const correlationId = message.correlationId
    const wireRequestId = message.requestId
    let releaseVerification = null
    try {
      releaseVerification = this.verificationLimiter.tryAcquire()
      if (releaseVerification === null) {
        this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.BUSY)
        return
      }
      const verified = verifySeedPinStatusRequest(message.request, {
        remotePublicKey: this.remotePublicKey,
        now: normalizeNow(this.now()),
      })
      if (this.closed) return
      if (!verified.valid) {
        this._sendStatusError(
          correlationId,
          wireRequestId,
          classifyStatusVerificationError(verified.error),
        )
        return
      }
      if (wireRequestId !== verified.requestId || message.request.requestId !== verified.requestId) {
        this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.INVALID_REQUEST)
        return
      }
      let existing
      try {
        existing = await this.store.getByRequestId(verified.requestId)
      } catch {
        this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.INTERNAL)
        return
      }
      if (!existing) {
        this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.NOT_FOUND)
        return
      }
      const owner = Object.freeze({
        identityPublicKey: verified.identityPublicKey,
        devicePublicKey: verified.devicePublicKey,
      })
      if (!sameOwner(existing.owner, owner)) {
        this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.FORBIDDEN)
        return
      }
      const result = await this._resumeOwnedStatus(verified.requestId, owner)
      if (result.code) this._sendStatusError(correlationId, wireRequestId, result.code)
      else this._sendStatusSuccess(correlationId, wireRequestId, result.status)
    } catch {
      this._sendStatusError(correlationId, wireRequestId, SEED_PIN_ERROR_CODES.INTERNAL)
    } finally {
      if (releaseVerification !== null) releaseVerification()
    }
  }

  async _withRequestLock (requestId, operation) {
    const previous = this.requestLocks.get(requestId) || Promise.resolve()
    const current = previous.then(operation, operation)
    const settled = current.then(noop, noop)
    this.requestLocks.set(requestId, settled)
    try {
      return await current
    } finally {
      if (this.requestLocks.get(requestId) === settled) this.requestLocks.delete(requestId)
    }
  }

  _sendPinSuccess (correlationId, requestId, status) {
    this._safeSend(this.pinResponse, seedPinSuccessResponse(correlationId, requestId, status), correlationId, requestId)
  }

  _sendPinError (correlationId, requestId, code) {
    this._safeSend(this.pinResponse, seedPinErrorResponse(correlationId, requestId, code))
  }

  _sendStatusSuccess (correlationId, requestId, status) {
    this._safeSend(this.statusResponse, seedPinSuccessResponse(correlationId, requestId, status), correlationId, requestId)
  }

  _sendStatusError (correlationId, requestId, code) {
    this._safeSend(this.statusResponse, seedPinErrorResponse(correlationId, requestId, code))
  }

  _safeSend (messageType, response, correlationId = null, requestId = null) {
    if (this.closed || this.channel.closed) return
    try {
      messageType.send(response)
    } catch {
      if (correlationId === null || requestId === null) return
      try {
        messageType.send(seedPinErrorResponse(
          correlationId,
          requestId,
          SEED_PIN_ERROR_CODES.INTERNAL,
        ))
      } catch {}
    }
  }
}

function normalizeRemotePublicKey (value) {
  if (!(value instanceof Uint8Array) && !b4a.isBuffer(value)) {
    throw new TypeError('remotePublicKey must be the live 32-byte connection key')
  }
  if (value.byteLength !== 32) {
    throw new TypeError('remotePublicKey must be the live 32-byte connection key')
  }
  return b4a.from(value)
}

function assertStore (store) {
  if (!store || typeof store.claimVerified !== 'function' ||
      typeof store.finalizeAdmission !== 'function' ||
      typeof store.getByRequestId !== 'function' ||
      typeof store.getOwnedStatus !== 'function') {
    throw new TypeError(
      'store must implement claimVerified, finalizeAdmission, getByRequestId, and getOwnedStatus',
    )
  }
  return store
}

function assertWorker (worker) {
  if (!worker || typeof worker.start !== 'function') {
    throw new TypeError('worker must implement start(requestId)')
  }
  return worker
}

function assertVerificationLimiter (limiter) {
  if (!limiter || typeof limiter.tryAcquire !== 'function' ||
      !Number.isSafeInteger(limiter.maxConcurrent) || limiter.maxConcurrent <= 0) {
    throw new TypeError('verificationLimiter must have a finite maxConcurrent and tryAcquire()')
  }
  return limiter
}

function normalizeNow (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('now must be a nonnegative safe integer')
  return value
}

function canonicalVerifiedRequest (wireRequest, verified) {
  return freezeDeep({
    version: verified.version,
    manifest: clonePlain(verified.manifest),
    requestId: verified.requestId,
    expiresAt: verified.expiresAt,
    signedDescriptor: {
      schema: wireRequest.signedDescriptor.schema,
      descriptor: clonePlain(verified.descriptor),
      proof: wireRequest.signedDescriptor.proof,
      attestation: wireRequest.signedDescriptor.attestation,
    },
    attestation: wireRequest.attestation,
  })
}

function clonePlain (value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clonePlain)
  const cloned = {}
  for (const key of Object.keys(value)) cloned[key] = clonePlain(value[key])
  return cloned
}

function isClaimResult (value, claimedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || !keys.includes('outcome') ||
      !keys.includes('record') || !keys.includes('claimToken')) return false
  if (!CLAIM_OUTCOMES.has(value.outcome) || !isStoreRecord(value.record)) return false
  if (value.outcome !== 'claimed') return value.claimToken === null
  return /^[0-9a-f]{64}$/.test(value.claimToken) &&
    value.record.claimToken === value.claimToken &&
    Number.isSafeInteger(value.record.claimExpiresAt) &&
    value.record.claimExpiresAt > claimedAt
}

function isFinalizeResult (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === 2 && keys.includes('outcome') && keys.includes('record') &&
    FINALIZE_OUTCOMES.has(value.outcome) && isStoreRecord(value.record)
}

function isStoreRecord (record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record) &&
    Boolean(record.owner) && typeof record.owner === 'object' &&
    /^[0-9a-f]{64}$/.test(record.owner.identityPublicKey) &&
    /^[0-9a-f]{64}$/.test(record.owner.devicePublicKey) &&
    /^[0-9a-f]{64}$/.test(record.authorizationDigest) &&
    Boolean(record.status) && typeof record.status === 'object' && !Array.isArray(record.status) &&
    SUPPORTED_RECORD_STATES.has(record.status.state)
}

function recordMatches (record, context) {
  return Boolean(record) && sameOwner(record.owner, context.owner) &&
    record.authorizationDigest === context.authorizationDigest
}

function sameOwner (left, right) {
  return left?.identityPublicKey === right.identityPublicKey &&
    left?.devicePublicKey === right.devicePublicKey
}

function classifyPinVerificationError (error) {
  const message = String(error || '').toLowerCase()
  if (message.includes('expired')) return SEED_PIN_ERROR_CODES.EXPIRED
  if (message.includes('channel') && message.includes('manifest')) return SEED_PIN_ERROR_CODES.CHANNEL_MISMATCH
  if (message.includes('live') || message.includes('requester device')) {
    return SEED_PIN_ERROR_CODES.LIVE_PEER_MISMATCH
  }
  if (message.includes('identity') && message.includes('mismatch')) {
    return SEED_PIN_ERROR_CODES.IDENTITY_MISMATCH
  }
  if (message.includes('requestid') || message.includes('canonical manifest') ||
      message.includes('manifest.requestid') || message.includes('unsupported') ||
      message.includes('required') || message.includes('must be')) {
    return SEED_PIN_ERROR_CODES.INVALID_REQUEST
  }
  return SEED_PIN_ERROR_CODES.INVALID_AUTH
}

function classifyStatusVerificationError (error) {
  const message = String(error || '').toLowerCase()
  if (message.includes('expired')) return SEED_PIN_ERROR_CODES.EXPIRED
  if (message.includes('live remote') || message.includes('device does not match')) {
    return SEED_PIN_ERROR_CODES.LIVE_PEER_MISMATCH
  }
  if (message.includes('identity') && message.includes('mismatch')) {
    return SEED_PIN_ERROR_CODES.IDENTITY_MISMATCH
  }
  if (message.includes('requestid') || message.includes('unsupported') ||
      message.includes('required') || message.includes('must be')) {
    return SEED_PIN_ERROR_CODES.INVALID_REQUEST
  }
  return SEED_PIN_ERROR_CODES.INVALID_AUTH
}

function freezeDeep (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) freezeDeep(entry)
  return Object.freeze(value)
}

async function allow () {
  return true
}

function noop () {}
