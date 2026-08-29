import b4a from 'b4a'
import AbortController from 'abort-controller'

import { createSourceReader, isSourceReader } from '../assets/source-reader.js'
import { acquisitionError, normalizePrincipalId } from './contract.js'
const GRANT_FIELDS = new Set(['token', 'adapterId', 'audience', 'expiresAt'])
const AUDIENCE_FIELDS = new Set(['principalId', 'acquisitionId'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOKEN = /^[A-Za-z0-9._~-]{16,256}$/

function fail (code, message, statusCode = 400) {
  throw acquisitionError(code, message, statusCode)
}

function strictObject (value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_GRANT_INVALID', `${name} must be an object`)
  for (const key of Object.keys(value)) if (!fields.has(key)) fail('SOURCE_GRANT_INVALID', `${name} contains unknown field ${key}`)
  for (const key of fields) if (!Object.prototype.hasOwnProperty.call(value, key)) fail('SOURCE_GRANT_INVALID', `${name} is missing ${key}`)
}

function boundedId (value, name) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim() ||
      b4a.byteLength(value) > 128 || !ID.test(value)) fail('SOURCE_GRANT_INVALID', `${name} is invalid`)
  return value
}

function normalizeGrant (grant, acquisitionId, principalId, at, maxTtlMs) {
  strictObject(grant, GRANT_FIELDS, 'source grant')
  strictObject(grant.audience, AUDIENCE_FIELDS, 'source grant audience')
  const audiencePrincipal = normalizePrincipalId(grant.audience.principalId, 'source grant audience principal')
  const audienceAcquisition = boundedId(grant.audience.acquisitionId, 'source grant audience acquisition')
  if (audiencePrincipal !== principalId || audienceAcquisition !== acquisitionId) {
    fail('SOURCE_GRANT_AUDIENCE_MISMATCH', 'source grant audience does not match this acquisition', 403)
  }
  if (typeof grant.token !== 'string' || !TOKEN.test(grant.token) || b4a.byteLength(grant.token) > 256) {
    fail('SOURCE_GRANT_INVALID', 'source grant token is invalid')
  }
  const adapterId = boundedId(grant.adapterId, 'source grant adapterId')
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= at) fail('SOURCE_GRANT_EXPIRED', 'source grant has expired', 403)
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || grant.expiresAt - at > maxTtlMs) {
    fail('SOURCE_GRANT_TTL_EXCEEDED', 'source grant exceeds the configured TTL', 403)
  }
  return { token: grant.token, adapterId, principalId, acquisitionId, expiresAt: grant.expiresAt }
}

function linkedAbortSignal(...signals) {
  const controller = new AbortController()
  const listeners = []
  for (const signal of signals.filter(Boolean)) {
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    if (signal.aborted) abort()
    else {
      signal.addEventListener('abort', abort, { once: true })
      listeners.push([signal, abort])
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [signal, abort] of listeners) signal.removeEventListener('abort', abort)
    }
  }
}

function bindReaderToGrant(reader, grantSignal) {
  return createSourceReader({
    resumable: reader.resumable,
    maxReadBytes: reader.maxReadBytes,
    async describe({ signal } = {}) {
      const linked = linkedAbortSignal(grantSignal, signal)
      try { return await reader.describe({ signal: linked.signal }) } finally { linked.cleanup() }
    },
    open(input = {}) {
      return (async function * () {
        const linked = linkedAbortSignal(grantSignal, input.signal)
        try {
          for await (const chunk of reader.open({ ...input, signal: linked.signal })) yield chunk
        } finally {
          linked.cleanup()
        }
      })()
    },
    async close(reason) {
      await reader.close(reason)
    }
  })
}

export function createSourceGrantVault ({ resolver, now = () => Date.now() } = {}) {
  if (!resolver || typeof resolver.resolve !== 'function') throw new TypeError('source grant vault requires resolver.resolve')
  if (resolver.revoke != null && typeof resolver.revoke !== 'function') throw new TypeError('source grant resolver.revoke must be a function')
  if (typeof now !== 'function') throw new TypeError('source grant vault now must be a function')
  const entries = new Map()
  let closed = false
  let generation = 0

  function currentTime () {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must return a non-negative safe integer')
    return value
  }

  function scheduleExpiry (entry) {
    const remaining = entry.expiresAt - currentTime()
    if (remaining <= 0) {
      revokeEntry(entry, acquisitionError('SOURCE_GRANT_EXPIRED', 'source grant has expired', 403)).catch(() => {})
      return
    }
    entry.timer = setTimeout(() => scheduleExpiry(entry), Math.min(remaining, 0x7fffffff))
    entry.timer?.unref?.()
  }

  async function revokeEntry (entry, reason) {
    if (!entry || entry.revoked) return
    entry.revoked = true
    clearTimeout(entry.timer)
    entry.controller.abort(reason)
    entries.delete(entry.acquisitionId)
    await Promise.all([...entry.readers].map(reader => reader.close(reason).catch(() => {})))
    entry.readers.clear()
    if (resolver.revoke) {
      await resolver.revoke({
        token: entry.token,
        adapterId: entry.adapterId,
        acquisitionId: entry.acquisitionId,
        principalId: entry.principalId,
        reason
      })
    }
  }

  return Object.freeze({
    async attach ({ acquisitionId, grant, principal, maxTtlMs } = {}) {
      if (closed) fail('SOURCE_GRANT_VAULT_CLOSED', 'source grant vault is closed', 503)
      const normalizedAcquisitionId = boundedId(acquisitionId, 'acquisitionId')
      const principalId = normalizePrincipalId(principal)
      const normalized = normalizeGrant(grant, normalizedAcquisitionId, principalId, currentTime(), maxTtlMs)
      const previous = entries.get(normalizedAcquisitionId)
      if (previous) await revokeEntry(previous, acquisitionError('SOURCE_GRANT_REPLACED', 'source grant was replaced', 409))
      const entry = { ...normalized, generation: ++generation, revoked: false, readers: new Set(), controller: new AbortController(), timer: null }
      entries.set(normalizedAcquisitionId, entry)
      scheduleExpiry(entry)
      return Object.freeze({ adapterId: entry.adapterId, expiresAt: entry.expiresAt })
    },
    has ({ acquisitionId, principal } = {}) {
      if (closed) return false
      const entry = entries.get(acquisitionId)
      if (!entry || entry.revoked || entry.expiresAt <= currentTime()) return false
      return entry.principalId === normalizePrincipalId(principal)
    },
    inspect ({ acquisitionId, principal } = {}) {
      if (!this.has({ acquisitionId, principal })) return null
      const entry = entries.get(acquisitionId)
      return Object.freeze({ adapterId: entry.adapterId, expiresAt: entry.expiresAt })
    },
    async resolve ({ acquisitionId, principal, signal, budget } = {}) {
      if (closed) fail('SOURCE_GRANT_VAULT_CLOSED', 'source grant vault is closed', 503)
      const principalId = normalizePrincipalId(principal)
      const entry = entries.get(acquisitionId)
      if (!entry || entry.revoked) fail('SOURCE_GRANT_UNAVAILABLE', 'source grant is unavailable', 409)
      if (entry.principalId !== principalId) fail('SOURCE_GRANT_AUDIENCE_MISMATCH', 'source grant audience does not match', 403)
      if (entry.expiresAt <= currentTime()) {
        await revokeEntry(entry, acquisitionError('SOURCE_GRANT_EXPIRED', 'source grant has expired', 403))
        fail('SOURCE_GRANT_EXPIRED', 'source grant has expired', 403)
      }
      if (signal?.aborted) fail('ACQUISITION_CANCELLED', 'source resolution was cancelled', 499)
      const linked = linkedAbortSignal(entry.controller.signal, signal)
      let implementation
      try {
        implementation = await resolver.resolve({
          token: entry.token,
          adapterId: entry.adapterId,
          acquisitionId: entry.acquisitionId,
          principalId: entry.principalId,
          expiresAt: entry.expiresAt,
          signal: linked.signal,
          budget
        })
      } finally {
        linked.cleanup()
      }
      const resolved = isSourceReader(implementation) ? implementation : createSourceReader(implementation)
      const reader = bindReaderToGrant(resolved, entry.controller.signal)
      if (entry.revoked || entries.get(acquisitionId)?.generation !== entry.generation) {
        await reader.close(acquisitionError('SOURCE_GRANT_REVOKED', 'source grant was revoked', 403)).catch(() => {})
        fail('SOURCE_GRANT_REVOKED', 'source grant was revoked', 403)
      }
      entry.readers.add(reader)
      return reader
    },
    async revoke ({ acquisitionId, principal = null, reason = null } = {}) {
      const entry = entries.get(acquisitionId)
      if (!entry) return false
      if (principal != null && entry.principalId !== normalizePrincipalId(principal)) {
        fail('SOURCE_GRANT_AUDIENCE_MISMATCH', 'source grant audience does not match', 403)
      }
      await revokeEntry(entry, reason || acquisitionError('SOURCE_GRANT_REVOKED', 'source grant was revoked', 403))
      return true
    },
    async revokeAll (reason = null) {
      await Promise.all([...entries.values()].map(entry => revokeEntry(entry, reason || acquisitionError('SOURCE_GRANT_REVOKED', 'source grant was revoked', 403))))
    },
    async close () {
      if (closed) return
      closed = true
      await this.revokeAll(acquisitionError('SOURCE_GRANT_VAULT_CLOSED', 'source grant vault closed', 503))
    }
  })
}
