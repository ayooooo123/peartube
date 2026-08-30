import b4a from 'b4a'

import { acquisitionError, canonicalAcquisitionRequest, normalizeAcquisitionRequest, normalizePrincipalId } from './contract.js'

export const ACQUISITION_POLICY_VERSION = 1
export const ACQUISITION_CONSENT_VERSION = 1
export const ACQUISITION_REQUESTER_MODES = Object.freeze(['local-only', 'allowlisted', 'public'])

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MODES = new Set(ACQUISITION_REQUESTER_MODES)
const BOOLEAN_FIELDS = ['migrationRequired', 'enabled', 'acceptPublicRequests']
const LIMIT_FIELDS = [
  'maxQueuedJobs',
  'maxConcurrentJobs',
  'maxConcurrentPerRequester',
  'maxRequestBytes',
  'maxAcquireBytesPer24h',
  'maxAcquireBytesPerSecond',
  'maxStagingBytes',
  'minFreeDiskBytes',
  'maxJobRuntimeMs',
  'sourceGrantTtlMs',
  'publicRequestsPerMinute',
  'maxAttempts',
  'retryBaseMs',
  'retryMaxMs'
]
const POLICY_FIELDS = new Set([
  'policyVersion',
  'consentVersion',
  ...BOOLEAN_FIELDS,
  'requesterMode',
  'allowedPublisherIds',
  'allowedAdapterIds',
  ...LIMIT_FIELDS
])

export const CLOSED_ACQUISITION_POLICY = Object.freeze({
  policyVersion: ACQUISITION_POLICY_VERSION,
  consentVersion: ACQUISITION_CONSENT_VERSION,
  migrationRequired: true,
  enabled: false,
  acceptPublicRequests: false,
  requesterMode: 'local-only',
  allowedPublisherIds: Object.freeze([]),
  allowedAdapterIds: Object.freeze([]),
  maxQueuedJobs: 0,
  maxConcurrentJobs: 0,
  maxConcurrentPerRequester: 0,
  maxRequestBytes: 0,
  maxAcquireBytesPer24h: 0,
  maxAcquireBytesPerSecond: 0,
  maxStagingBytes: 0,
  minFreeDiskBytes: 0,
  maxJobRuntimeMs: 0,
  sourceGrantTtlMs: 0,
  publicRequestsPerMinute: 0,
  maxAttempts: 0,
  retryBaseMs: 0,
  retryMaxMs: 0
})

function fail (code, message, statusCode = 400) {
  throw acquisitionError(code, message, statusCode)
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeIds (value, field) {
  if (!Array.isArray(value) || value.length > 64) fail('ACQUISITION_POLICY_INVALID', `${field} must be a bounded array`)
  const normalized = value.map(entry => {
    if (typeof entry !== 'string' || entry !== entry.normalize('NFC') || entry !== entry.trim() ||
        b4a.byteLength(entry) > 128 || !ID.test(entry)) {
      fail('ACQUISITION_POLICY_INVALID', `${field} contains an invalid id`)
    }
    return entry
  })
  if (new Set(normalized).size !== normalized.length) fail('ACQUISITION_POLICY_INVALID', `${field} contains a duplicate id`)
  return normalized.sort()
}
function validatePolicyShape (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ACQUISITION_POLICY_INVALID', 'policy must be an object')
  for (const key of Object.keys(input)) {
    if (!POLICY_FIELDS.has(key)) fail('ACQUISITION_POLICY_INVALID', `policy contains unknown field ${key}`)
  }
  for (const key of POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) fail('ACQUISITION_POLICY_INVALID', `policy is missing ${key}`)
  }
  if (input.policyVersion !== ACQUISITION_POLICY_VERSION) fail('ACQUISITION_POLICY_INVALID', 'policyVersion must be 1')
  if (input.consentVersion !== ACQUISITION_CONSENT_VERSION) fail('ACQUISITION_POLICY_INVALID', 'consentVersion must be 1')
  for (const field of BOOLEAN_FIELDS) {
    if (typeof input[field] !== 'boolean') fail('ACQUISITION_POLICY_INVALID', `${field} must be a boolean`)
  }
  if (!MODES.has(input.requesterMode)) fail('ACQUISITION_POLICY_INVALID', 'requesterMode is invalid')
}


export function normalizeAcquisitionPolicy (input = CLOSED_ACQUISITION_POLICY) {
  validatePolicyShape(input)
  const result = {
    policyVersion: ACQUISITION_POLICY_VERSION,
    consentVersion: ACQUISITION_CONSENT_VERSION,
    migrationRequired: input.migrationRequired,
    enabled: input.enabled,
    acceptPublicRequests: input.acceptPublicRequests,
    requesterMode: input.requesterMode,
    allowedPublisherIds: normalizeIds(input.allowedPublisherIds, 'allowedPublisherIds'),
    allowedAdapterIds: normalizeIds(input.allowedAdapterIds, 'allowedAdapterIds')
  }
  for (const field of LIMIT_FIELDS) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 0) fail('ACQUISITION_POLICY_INVALID', `${field} must be a non-negative safe integer`)
    result[field] = input[field]
  }
  if (result.retryBaseMs > result.retryMaxMs && result.retryMaxMs !== 0) fail('ACQUISITION_POLICY_INVALID', 'retryBaseMs must not exceed retryMaxMs')
  if (result.requesterMode === 'public' && result.acceptPublicRequests !== true) {
    fail('ACQUISITION_POLICY_INVALID', 'public requesterMode requires acceptPublicRequests')
  }
  return Object.freeze({ ...result, allowedPublisherIds: Object.freeze(result.allowedPublisherIds), allowedAdapterIds: Object.freeze(result.allowedAdapterIds) })
}

function consentGranted (consent) {
  return consent === true || (
    consent && typeof consent === 'object' && !Array.isArray(consent) &&
    consent.version === ACQUISITION_CONSENT_VERSION && consent.granted === true &&
    Object.keys(consent).every(key => key === 'version' || key === 'granted')
  )
}

function assertOpenPolicy (policy) {
  if (policy.migrationRequired) fail('ACQUISITION_MIGRATION_REQUIRED', 'acquisition policy migration must be acknowledged', 403)
  if (!policy.enabled) fail('ACQUISITION_DISABLED', 'acquisition provider is disabled', 403)
  for (const field of LIMIT_FIELDS) {
    if (policy[field] <= 0) fail('ACQUISITION_POLICY_CLOSED', `${field} must be configured before acquisitions are enabled`, 403)
  }
  if (policy.allowedPublisherIds.length === 0) fail('ACQUISITION_PUBLISHER_DENIED', 'no publisher is allowlisted', 403)
  if (policy.allowedAdapterIds.length === 0) fail('ACQUISITION_ADAPTER_DENIED', 'no acquisition adapter is allowlisted', 403)
}

function principalIsLocal (principal) {
  return principal?.isLocal === true || principal?.kind === 'local' || principal?.transport === 'local'
}

function principalPublisherIds (principal) {
  const raw = principal?.publisherIds ?? principal?.allowedPublisherIds
  const values = Array.isArray(raw) ? raw : (typeof principal?.publisherId === 'string' && principal.publisherId ? [principal.publisherId] : [])
  return Array.isArray(values) ? values : []
}

function assertRequester (policy, request, principal, isRemote) {
  if (policy.requesterMode === 'local-only') {
    if (isRemote || !principalIsLocal(principal)) fail('ACQUISITION_REQUESTER_DENIED', 'only local requests are admitted', 403)
    return
  }
  if (policy.requesterMode === 'allowlisted') {
    if (!principalPublisherIds(principal).includes(request.publisherId)) {
      fail('ACQUISITION_REQUESTER_DENIED', 'requester is not allowlisted for this publisher', 403)
    }
    return
  }
  if (!policy.acceptPublicRequests) fail('ACQUISITION_REQUESTER_DENIED', 'public requests are disabled', 403)
}

export function createAcquisitionPolicyRuntime ({ policy = CLOSED_ACQUISITION_POLICY, load = null, save = null, now = () => Date.now() } = {}) {
  if (load != null && typeof load !== 'function') throw new TypeError('policy load must be a function')
  if (save != null && typeof save !== 'function') throw new TypeError('policy save must be a function')
  if (typeof now !== 'function') throw new TypeError('policy now must be a function')
  let current = normalizeAcquisitionPolicy(policy)
  let loaded = false
  const listeners = new Set()
  let writes = Promise.resolve()

  async function ensureLoaded () {
    if (loaded) return
    loaded = true
    if (load) {
      const persisted = await load()
      if (persisted != null) current = normalizeAcquisitionPolicy(persisted)
    }
  }

  function notify (previous) {
    for (const listener of listeners) listener(current, previous)
  }

  return Object.freeze({
    async getPolicy () {
      await ensureLoaded()
      return clone(current)
    },
    async setPolicy (input, { consent = null } = {}) {
      const next = normalizeAcquisitionPolicy(input)
      if ((next.enabled || !next.migrationRequired) && !consentGranted(consent)) {
        fail('ACQUISITION_CONSENT_REQUIRED', 'explicit current-version consent is required', 403)
      }
      const operation = writes.then(async () => {
        await ensureLoaded()
        const previous = current
        if (save) await save(clone(next))
        current = next
        notify(previous)
        return clone(current)
      })
      writes = operation.catch(() => {})
      return operation
    },
    async admit ({ request: input, principal, adapterId, freeDiskBytes = Number.MAX_SAFE_INTEGER, isRemote = false } = {}) {
      await ensureLoaded()
      const request = normalizeAcquisitionRequest(input)
      const principalId = normalizePrincipalId(principal)
      assertOpenPolicy(current)
      assertRequester(current, request, principal, isRemote)
      if (!current.allowedPublisherIds.includes(request.publisherId)) fail('ACQUISITION_PUBLISHER_DENIED', 'publisher is not allowlisted', 403)
      if (adapterId != null && (typeof adapterId !== 'string' || !current.allowedAdapterIds.includes(adapterId))) {
        fail('ACQUISITION_ADAPTER_DENIED', 'adapter is not allowlisted', 403)
      }
      const requestBytes = b4a.byteLength(canonicalAcquisitionRequest(request))
      if (requestBytes > current.maxRequestBytes) fail('ACQUISITION_REQUEST_TOO_LARGE', 'acquisition request exceeds policy', 413)
      if (!Number.isSafeInteger(freeDiskBytes) || freeDiskBytes < current.minFreeDiskBytes) {
        fail('ACQUISITION_STORAGE_DENIED', 'minimum free disk policy is not satisfied', 507)
      }
      const currentTime = now()
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) throw new TypeError('now must return a non-negative safe integer')
      if (request.retentionUntil != null) {
        if (request.retentionUntil <= currentTime) fail('ACQUISITION_RETENTION_EXPIRED', 'retentionUntil has passed', 409)
        if (request.retentionUntil - currentTime > current.maxJobRuntimeMs) {
          fail('ACQUISITION_RUNTIME_DENIED', 'retentionUntil exceeds maxJobRuntimeMs', 403)
        }
      }
      return { policy: clone(current), principalId, request, requestBytes, admittedAt: currentTime }
    },
    subscribe (listener) {
      if (typeof listener !== 'function') throw new TypeError('policy listener must be a function')
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
}
