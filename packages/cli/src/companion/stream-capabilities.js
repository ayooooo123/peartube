import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { CompanionContractError, decodeId } from './contracts.js'

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 1024
const DEFAULT_MAX_CONCURRENT_USES = 6
const MAX_TTL_MS = 10 * 60_000
const MAX_ENTRIES = 65_536
const MAX_CONCURRENT_USES = 64
const MAX_GENERATION_ATTEMPTS = 4
const STREAM_METHODS = new Set(['GET', 'HEAD'])

function capabilityError (statusCode, code, message) {
  return new CompanionContractError(statusCode, code, message)
}

function base64Url (bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function digestToken (token) {
  return b4a.toString(crypto.hash(b4a.from(token)), 'hex')
}

function boundedInteger (value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

function boundMethods (methods) {
  if (!Array.isArray(methods) || methods.length < 1 || methods.length > STREAM_METHODS.size) {
    throw new TypeError('capability methods must be a non-empty array')
  }
  const bound = []
  for (const method of methods) {
    if (typeof method !== 'string' || !STREAM_METHODS.has(method) || bound.includes(method)) {
      throw new TypeError('capability methods must contain unique GET or HEAD values')
    }
    bound.push(method)
  }
  return Object.freeze(bound)
}

export function createStreamCapabilityStore ({
  now = Date.now,
  randomBytes = crypto.randomBytes,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxConcurrentUses = DEFAULT_MAX_CONCURRENT_USES
} = {}) {
  if (typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('capability clock and random source are required')
  }
  boundedInteger(ttlMs, 'capability ttl', MAX_TTL_MS)
  boundedInteger(maxEntries, 'capability capacity', MAX_ENTRIES)
  boundedInteger(maxConcurrentUses, 'capability concurrency', MAX_CONCURRENT_USES)

  const entries = new Map()
  const pendingReleases = new Set()

  function dispose (entry) {
    if (entry.disposed || !entry.retired || entry.activeUses > 0) return
    entry.disposed = true
    if (typeof entry.scope.asset?.release !== 'function') return
    const pending = Promise.resolve().then(() => entry.scope.asset.release())
    pendingReleases.add(pending)
    void pending.then(
      () => pendingReleases.delete(pending),
      () => pendingReleases.delete(pending)
    )
  }

  function retire (digest, entry) {
    if (entries.get(digest) === entry) entries.delete(digest)
    entry.retired = true
    dispose(entry)
  }

  function currentTime () {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('capability clock returned an invalid time')
    return value
  }

  function pruneAt (at) {
    let removed = 0
    for (const [digest, entry] of entries) {
      if (entry.scope.expiresAt > at) continue
      retire(digest, entry)
      removed++
    }
    return removed
  }

  function issue ({
    clientIdentity,
    publicationId,
    renditionId,
    assetId,
    asset = null,
    methods = ['GET', 'HEAD'],
    maxConcurrentUses: entryConcurrency = maxConcurrentUses
  } = {}) {
    const issuedAt = currentTime()
    const expiresAt = issuedAt + ttlMs
    if (!Number.isSafeInteger(expiresAt)) throw new TypeError('capability expiry exceeds the safe time range')
    pruneAt(issuedAt)
    if (entries.size >= maxEntries) {
      throw capabilityError(503, 'CAPABILITY_CAPACITY_EXHAUSTED', 'Stream capability capacity is exhausted')
    }

    const boundAssetId = decodeId(assetId, 'assetId')
    if (asset !== null && (
      !asset ||
      typeof asset !== 'object' ||
      Array.isArray(asset) ||
      asset.assetId !== boundAssetId
    )) {
      throw new TypeError('capability asset must match assetId')
    }
    const scope = Object.freeze({
      clientIdentity: decodeId(clientIdentity, 'clientIdentity'),
      publicationId: decodeId(publicationId, 'publicationId'),
      renditionId: decodeId(renditionId, 'renditionId'),
      assetId: boundAssetId,
      asset,
      methods: boundMethods(methods),
      issuedAt,
      expiresAt,
      maxConcurrentUses: boundedInteger(entryConcurrency, 'capability concurrency', MAX_CONCURRENT_USES)
    })

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const bytes = b4a.from(randomBytes(TOKEN_BYTES))
      if (bytes.byteLength !== TOKEN_BYTES) throw new TypeError('capability random source must return 32 bytes')
      const token = base64Url(bytes)
      const digest = digestToken(token)
      if (entries.has(digest)) continue
      entries.set(digest, { scope, activeUses: 0, retired: false, disposed: false })
      return Object.freeze({
        token,
        expiresAt,
        publicationId: scope.publicationId,
        renditionId: scope.renditionId
      })
    }
    throw capabilityError(503, 'CAPABILITY_GENERATION_FAILED', 'Stream capability could not be issued')
  }

  function consume (token, { clientIdentity, publicationId, renditionId, method } = {}) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw capabilityError(403, 'CAPABILITY_INVALID', 'Invalid stream capability')
    }
    const digest = digestToken(token)
    const entry = entries.get(digest)
    if (!entry) throw capabilityError(403, 'CAPABILITY_INVALID', 'Invalid stream capability')

    const at = currentTime()
    if (entry.scope.expiresAt <= at) {
      retire(digest, entry)
      throw capabilityError(410, 'CAPABILITY_EXPIRED', 'Stream capability expired')
    }
    if (
      (clientIdentity !== undefined && entry.scope.clientIdentity !== clientIdentity) ||
      entry.scope.publicationId !== publicationId ||
      entry.scope.renditionId !== renditionId ||
      !entry.scope.methods.includes(method)
    ) {
      throw capabilityError(403, 'CAPABILITY_SCOPE_MISMATCH', 'Stream capability scope mismatch')
    }
    if (entry.activeUses >= entry.scope.maxConcurrentUses) {
      throw capabilityError(429, 'CAPABILITY_CONCURRENCY_EXHAUSTED', 'Stream capability concurrency is exhausted')
    }

    entry.activeUses++
    let released = false
    return Object.freeze({
      clientIdentity: entry.scope.clientIdentity,
      publicationId: entry.scope.publicationId,
      renditionId: entry.scope.renditionId,
      assetId: entry.scope.assetId,
      asset: entry.scope.asset,
      expiresAt: entry.scope.expiresAt,
      release () {
        if (released) return
        released = true
        entry.activeUses--
        dispose(entry)
      }
    })
  }

  function close (token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false
    const digest = digestToken(token)
    const entry = entries.get(digest)
    if (!entry) return false
    retire(digest, entry)
    return true
  }

  function clear () {
    for (const [digest, entry] of entries) retire(digest, entry)
  }

  async function drain () {
    while (pendingReleases.size > 0) await Promise.allSettled([...pendingReleases])
  }

  return Object.freeze({
    issue,
    consume,
    close,
    clear,
    drain,
    prune () { return pruneAt(currentTime()) },
    get size () { pruneAt(currentTime()); return entries.size }
  })
}
