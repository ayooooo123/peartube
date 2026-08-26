import { CONTROL_PUBLISHER_ID, INDEX_SCHEMA_LIMITS } from './schema.js'

export const INDEX_ADMISSION_CODES = Object.freeze({
  LIMIT_EXCEEDED: 'INDEX_ADMISSION_LIMIT_EXCEEDED',
  TOMBSTONED: 'INDEX_ADMISSION_TOMBSTONED',
  PUBLISHER_MISMATCH: 'INDEX_PUBLISHER_MISMATCH',
  INVALID_OPERATION: 'INDEX_INVALID_OPERATION',
})

const HEX_32 = /^[0-9a-f]{64}$/
const LIMIT_FIELDS = new Set(['maxRetainedBytes', 'maxRows'])
const LIMIT_SCOPES = new Set(['global', 'shard', 'publisher', 'trustClasses'])
const MAX_TRUST_CLASSES = 256
const DEFAULT_MEMBERSHIP = Object.freeze({ shardId: 'default', trustClass: 'untrusted' })

export class IndexerAdmissionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'IndexerAdmissionError'
    this.code = code
    Object.assign(this, details)
  }
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedUnsigned(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a finite bounded unsigned integer`)
  }
  return value
}

export function validateBoundedText(name, value, limit = INDEX_SCHEMA_LIMITS.maxControlIdBytes) {
  if (typeof value !== 'string' || value.length === 0) throw invalidOperation(`${name} must be a non-empty string`)
  if (Buffer.byteLength(value, 'utf8') > limit) throw invalidOperation(`${name} exceeds its UTF-8 byte limit`)
  return value
}

function validateLimit(name, value) {
  if (!plainObject(value)) throw new TypeError(`${name} must be an object`)
  for (const field of Object.keys(value)) {
    if (!LIMIT_FIELDS.has(field)) throw new TypeError(`${name}.${field} is not supported`)
  }
  return Object.freeze({
    maxRetainedBytes: boundedUnsigned(`${name}.maxRetainedBytes`, value.maxRetainedBytes),
    maxRows: boundedUnsigned(`${name}.maxRows`, value.maxRows, Number.MAX_SAFE_INTEGER - 1),
  })
}

export function validateAdmissionLimits(limits) {
  if (!plainObject(limits)) throw new TypeError('limits.global, limits.shard, limits.publisher and limits.trustClasses are required')
  for (const name of Object.keys(limits)) {
    if (!LIMIT_SCOPES.has(name)) throw new TypeError(`limits.${name} is not supported`)
  }
  const trustClasses = limits.trustClasses
  if (!plainObject(trustClasses)) throw new TypeError('limits.trustClasses must be an object')
  const entries = Object.entries(trustClasses)
  if (entries.length === 0 || entries.length > MAX_TRUST_CLASSES) {
    throw new TypeError(`limits.trustClasses must contain between 1 and ${MAX_TRUST_CLASSES} entries`)
  }
  if (!Object.hasOwn(trustClasses, 'untrusted')) throw new TypeError('limits.trustClasses.untrusted is required')
  const validatedTrustClasses = Object.create(null)
  for (const [name, value] of entries) {
    validateBoundedText(`limits.trustClasses.${name}`, name)
    validatedTrustClasses[name] = validateLimit(`limits.trustClasses.${name}`, value)
  }
  return Object.freeze({
    global: validateLimit('limits.global', limits.global),
    shard: validateLimit('limits.shard', limits.shard),
    publisher: validateLimit('limits.publisher', limits.publisher),
    trustClasses: Object.freeze(validatedTrustClasses),
  })
}

export function validateAdmissionPolicy(policy) {
  if (policy === undefined || policy === null) return null
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('policy must be an object')
  if (policy.resolvePublisher !== undefined && typeof policy.resolvePublisher !== 'function') {
    throw new TypeError('policy.resolvePublisher must be a function')
  }
  if (policy.now !== undefined && typeof policy.now !== 'function') throw new TypeError('policy.now must be a function')
  return policy
}

export function validatePublisherId(publisherId) {
  if (typeof publisherId !== 'string' || !HEX_32.test(publisherId)) {
    throw invalidOperation('publisherId must be canonical lowercase 64-hex', { scope: 'publisher', requested: publisherId })
  }
  if (publisherId === CONTROL_PUBLISHER_ID) {
    throw invalidOperation('publisherId is reserved for local index control records', { scope: 'publisher', requested: publisherId })
  }
  return publisherId
}

function returnedPromise(value) {
  return value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'
}

export function resolvePublisherMembership(policy, publisherId, trustClasses) {
  const resolved = policy?.resolvePublisher
    ? policy.resolvePublisher(publisherId)
    : DEFAULT_MEMBERSHIP
  if (returnedPromise(resolved)) {
    throw invalidOperation('policy.resolvePublisher must return synchronously', { scope: 'policy', requested: 'Promise' })
  }
  if (!plainObject(resolved)) {
    throw invalidOperation('policy.resolvePublisher must return { shardId, trustClass }', { scope: 'policy', requested: resolved })
  }
  for (const name of Object.keys(resolved)) {
    if (name !== 'shardId' && name !== 'trustClass') {
      throw invalidOperation(`policy.resolvePublisher returned unsupported field ${name}`, {
        scope: 'policy',
        requested: name,
      })
    }
  }
  const shardId = validateBoundedText('policy shardId', resolved.shardId)
  const trustClass = validateBoundedText('policy trustClass', resolved.trustClass)
  if (!Object.hasOwn(trustClasses, trustClass)) {
    throw invalidOperation(`policy returned unknown trust class ${trustClass}`, {
      scope: 'trustClass',
      requested: trustClass,
    })
  }
  return Object.freeze({ shardId, trustClass })
}

export function resolveAdmissionTime(policy) {
  const value = policy?.now ? policy.now() : Date.now()
  if (returnedPromise(value)) throw invalidOperation('policy.now must return synchronously', { scope: 'policy', requested: 'Promise' })
  try {
    return boundedUnsigned('policy.now()', value)
  } catch (error) {
    throw invalidOperation(error.message, { scope: 'policy', requested: value })
  }
}

export function safeUsageAdd(current, delta, label) {
  const next = current + delta
  if (!Number.isSafeInteger(next) || next < 0) {
    throw invalidOperation(`${label} accounting would leave the safe unsigned integer range`, {
      scope: 'accounting',
      current,
      requested: next,
    })
  }
  return next
}

export function assertWithinBudget({ scope, scopeId, resource, current, requested, limit }) {
  if (requested <= current || requested <= limit) return
  throw new IndexerAdmissionError(
    INDEX_ADMISSION_CODES.LIMIT_EXCEEDED,
    `index admission ${scope} ${scopeId} ${resource} limit ${limit} exceeded: current ${current}, requested ${requested}`,
    { scope, scopeId, resource, limit, current, requested },
  )
}

export function invalidOperation(message, details) {
  return new IndexerAdmissionError(INDEX_ADMISSION_CODES.INVALID_OPERATION, message, details)
}

export function publisherMismatch(publisherId, actualPublisherId, collection) {
  return new IndexerAdmissionError(
    INDEX_ADMISSION_CODES.PUBLISHER_MISMATCH,
    `index row publisher ${actualPublisherId} does not match requested publisher ${publisherId} for ${collection}`,
    { scope: 'publisher', scopeId: publisherId, current: publisherId, requested: actualPublisherId, collection },
  )
}

export function tombstonedPublisher(tombstone) {
  return new IndexerAdmissionError(
    INDEX_ADMISSION_CODES.TOMBSTONED,
    `publisher ${tombstone.publisherId} is locally tombstoned: ${tombstone.reason}; clear the tombstone before reinserting`,
    {
      scope: 'publisher',
      scopeId: tombstone.publisherId,
      reason: tombstone.reason,
      evictedAt: tombstone.evictedAt,
    },
  )
}
