import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  ACQUISITION_SCHEMA_VERSION,
  ACQUISITION_STATES,
  TERMINAL_ACQUISITION_STATES,
  acquisitionError,
  acquisitionEventForJob,
  assertNoPrivateSourceMaterial,
  normalizeAcquisitionRequest,
  normalizePrincipalId,
  normalizePublicTitle,
  PUBLICATION_MEDIA_FIELDS,
  projectAcquisitionJob
} from './contract.js'

const JOB_PREFIX = 'acquisition/v1/job/'
const IDEMPOTENCY_PREFIX = 'acquisition/v1/idempotency/'
const ACTIVE_PREFIX = 'acquisition/v1/active/'
const EVENT_PREFIX = 'acquisition/v1/event/'
const LEGACY_MARKER_PREFIX = 'acquisition/v1/migration/companion-ingest-v1/'
const STATES = new Set(ACQUISITION_STATES)
const TERMINAL = new Set(TERMINAL_ACQUISITION_STATES)
const NEXT = new Map([
  ['queued', 'acquiring'],
  ['acquiring', 'verifying'],
  ['verifying', 'publishing'],
  ['publishing', 'completed']
])
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MIGRATION_MARKER = /^[A-Za-z0-9_-]{32}$/
const COUNTER_FIELDS = ['sourceBytesRead', 'sourceBytesAccepted', 'bytesAcquired', 'verifiedBytes', 'committedBytes', 'retainedBytes', 'stagingBytes', 'stagingPeakBytes']
const PATCH_FIELDS = new Set([...COUNTER_FIELDS, 'expectedIdentity', 'attempts', 'startedAt', 'finishedAt', 'errorCode', 'recoverable', 'verifiedPrefix', 'verifiedAsset', 'publication'])

function fail (code, message, statusCode = 409) { throw acquisitionError(code, message, statusCode) }
function clone (value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
function decode (value) {
  if (value == null) return null
  if (typeof value === 'object') return clone(value)
  try { return JSON.parse(String(value)) } catch { fail('ACQUISITION_PERSISTENCE_CORRUPT', 'acquisition persistence is corrupt', 500) }
}
function id (value, name = 'id') {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) fail('ACQUISITION_PERSISTENCE_INVALID', `${name} is invalid`, 500)
  return value
}
function uint (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ACQUISITION_PERSISTENCE_INVALID', `${name} is invalid`, 500)
  return value
}
function normalizeIdentity (input) {
  if (input == null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['sha256', 'etag'].includes(input.kind) ||
      typeof input.value !== 'string' || !input.value || input.value.length > 512 || Object.keys(input).some(key => key !== 'kind' && key !== 'value')) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'source identity is invalid', 500)
  }
  if (input.kind === 'sha256' && !/^[0-9a-f]{64}$/.test(input.value)) fail('ACQUISITION_PERSISTENCE_INVALID', 'source digest is invalid', 500)
  return { kind: input.kind, value: input.value }
}
function normalizeVerifiedPrefix (input, expectedBytes) {
  if (input == null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'byteLength' && key !== 'identity')) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'verified prefix is invalid', 500)
  }
  const byteLength = uint(input.byteLength, 'verifiedPrefix.byteLength')
  if (byteLength > expectedBytes) fail('ACQUISITION_PERSISTENCE_INVALID', 'verified prefix exceeds expected bytes', 500)
  return { byteLength, identity: normalizeIdentity(input.identity) }
}
function normalizeVerifiedAsset (input, expectedBytes) {
  if (input == null) return null
  const fields = new Set(['assetId', 'key', 'treeHash', 'length', 'byteLength', 'blockSize'])
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) fail('ACQUISITION_PERSISTENCE_INVALID', 'verified asset is invalid', 500)
  const result = { assetId: id(input.assetId, 'assetId'), key: id(input.key, 'asset key'), treeHash: id(input.treeHash, 'asset treeHash'), length: uint(input.length, 'asset length'), byteLength: uint(input.byteLength, 'asset byteLength'), blockSize: uint(input.blockSize, 'asset blockSize') }
  if (result.byteLength !== expectedBytes || result.blockSize < 1) fail('ACQUISITION_PERSISTENCE_INVALID', 'verified asset byte length is invalid', 500)
  assertNoPrivateSourceMaterial(result, 'verified asset')
  return result
}
function normalizePublication (input) {
  if (input == null) return null
  const fields = new Set(['publicationId', 'manifestId', 'renditionId', 'assetId'])
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) fail('ACQUISITION_PERSISTENCE_INVALID', 'publication result is invalid', 500)
  const result = {}
  for (const field of fields) result[field] = id(input[field], field)
  assertNoPrivateSourceMaterial(result, 'publication result')
  return result
}
function plainObject (value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function boundedMetadataValue (value) {
  if (typeof value === 'string') return Boolean(value) && b4a.byteLength(value) <= 512
  return Number.isSafeInteger(value) && value >= 0
}


function normalizePublicationMetadata (input) {
  if (input == null) return null
  if (!plainObject(input) || Object.keys(input).some(key => key !== 'title' && key !== 'sourceFileName' && key !== 'mediaContext')) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'publication metadata is invalid', 500)
  }
  if (input.title !== null && input.title !== undefined) {
    normalizePublicTitle(input.title, 'ACQUISITION_PERSISTENCE_INVALID')
  }
  if (input.sourceFileName !== null && input.sourceFileName !== undefined &&
      (typeof input.sourceFileName !== 'string' || !/^[^/\\]{1,255}$/.test(input.sourceFileName))) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'publication source file name is invalid', 500)
  }
  if (input.mediaContext !== null) {
    if (!plainObject(input.mediaContext) || Object.keys(input.mediaContext).some(key => !PUBLICATION_MEDIA_FIELDS.has(key))) {
      fail('ACQUISITION_PERSISTENCE_INVALID', 'publication media context is invalid', 500)
    }
    if (!Object.values(input.mediaContext).every(boundedMetadataValue)) {
      fail('ACQUISITION_PERSISTENCE_INVALID', 'publication media context value is invalid', 500)
    }
  }
  return input
}
function normalizeRequesterPublisherIds (input) {
  if (!Array.isArray(input) || input.length > 64) fail('ACQUISITION_PERSISTENCE_INVALID', 'requester publisher scope is invalid', 500)
  const values = input.map(value => id(value, 'requester publisher id'))
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && value <= values[index - 1])) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'requester publisher scope is not canonical', 500)
  }
  return values
}

// A backfill fills gaps and overwrites nothing: a job that already names its
// work keeps that name, and only the fields it is missing are added. Returns
// null when there is nothing to add, so the caller writes no operation.
function mergedPublicationMetadata (existing, incoming) {
  if (incoming == null) return null
  if (existing == null) return incoming
  const merged = { ...existing }
  let changed = false
  for (const field of ['title', 'sourceFileName', 'mediaContext']) {
    if (merged[field] != null || incoming[field] == null) continue
    merged[field] = incoming[field]
    changed = true
  }
  return changed ? merged : null
}
function normalizePatch (patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('ACQUISITION_PERSISTENCE_INVALID', 'job patch is invalid', 500)
  for (const key of Object.keys(patch)) if (!PATCH_FIELDS.has(key)) fail('ACQUISITION_PERSISTENCE_INVALID', `unknown job patch field ${key}`, 500)
  const result = {}
  for (const field of COUNTER_FIELDS) {
    if (patch[field] === undefined) continue
    result[field] = uint(patch[field], field)
    if (field !== 'stagingBytes' && result[field] < current[field]) fail('ACQUISITION_ACCOUNTING_REGRESSION', `${field} must be monotonic`)
  }
  if (patch.expectedIdentity !== undefined) {
    result.expectedIdentity = normalizeIdentity(patch.expectedIdentity)
    if (result.expectedIdentity === null || (current.expectedIdentity !== null &&
        (result.expectedIdentity.kind !== current.expectedIdentity.kind || result.expectedIdentity.value !== current.expectedIdentity.value)) ||
        current.bytesAcquired !== 0 || current.verifiedBytes !== 0 || current.committedBytes !== 0) {
      fail('ACQUISITION_PERSISTENCE_INVALID', 'expectedIdentity cannot change after acquisition starts', 500)
    }
  }
  if (patch.attempts !== undefined) { result.attempts = uint(patch.attempts, 'attempts'); if (result.attempts < current.attempts) fail('ACQUISITION_ACCOUNTING_REGRESSION', 'attempts must be monotonic') }
  for (const field of ['startedAt', 'finishedAt']) if (patch[field] !== undefined) result[field] = patch[field] == null ? null : uint(patch[field], field)
  if (patch.errorCode !== undefined) {
    if (patch.errorCode !== null && (typeof patch.errorCode !== 'string' || !ERROR_CODE.test(patch.errorCode))) fail('ACQUISITION_PERSISTENCE_INVALID', 'errorCode is invalid', 500)
    result.errorCode = patch.errorCode
  }
  if (patch.recoverable !== undefined) { if (typeof patch.recoverable !== 'boolean') fail('ACQUISITION_PERSISTENCE_INVALID', 'recoverable is invalid', 500); result.recoverable = patch.recoverable }
  if (patch.verifiedPrefix !== undefined) result.verifiedPrefix = normalizeVerifiedPrefix(patch.verifiedPrefix, current.expectedBytes)
  if (patch.verifiedAsset !== undefined) result.verifiedAsset = normalizeVerifiedAsset(patch.verifiedAsset, current.expectedBytes)
  if (patch.publication !== undefined) result.publication = normalizePublication(patch.publication)
  return result
}
function validateCounters (job) {
  for (const field of COUNTER_FIELDS) uint(job[field], field)
  if (job.sourceBytesAccepted > job.sourceBytesRead || job.bytesAcquired > job.sourceBytesAccepted || job.verifiedBytes > job.bytesAcquired ||
      job.committedBytes > job.verifiedBytes || job.retainedBytes > job.committedBytes || job.stagingPeakBytes < job.stagingBytes || job.bytesAcquired > job.expectedBytes) {
    fail('ACQUISITION_PERSISTENCE_INVALID', 'job accounting counters are inconsistent', 500)
  }
}
function validateDurableJob (job) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.schemaVersion !== ACQUISITION_SCHEMA_VERSION || !STATES.has(job.state)) fail('ACQUISITION_PERSISTENCE_INVALID', 'job schema or state is invalid', 500)
  id(job.acquisitionId, 'acquisitionId'); id(job.principalId, 'principalId'); id(job.publisherId, 'publisherId')
  normalizeAcquisitionRequest(job.request); uint(job.version, 'version'); uint(job.expectedBytes, 'expectedBytes'); uint(job.attempts, 'attempts'); uint(job.createdAt, 'createdAt'); uint(job.updatedAt, 'updatedAt'); validateCounters(job)
  if (job.request.publisherId !== job.publisherId || job.request.retentionClass !== job.retentionClass) fail('ACQUISITION_PERSISTENCE_INVALID', 'job request projection is inconsistent', 500)
  if (job.errorCode != null && !ERROR_CODE.test(job.errorCode)) fail('ACQUISITION_PERSISTENCE_INVALID', 'job errorCode is invalid', 500)
  if (typeof job.recoverable !== 'boolean') fail('ACQUISITION_PERSISTENCE_INVALID', 'job recoverable is invalid', 500)
  if (typeof job.isRemote !== 'boolean') fail('ACQUISITION_PERSISTENCE_INVALID', 'job remote-origin flag is invalid', 500)
  if (job.deferredInput !== undefined && typeof job.deferredInput !== 'boolean') fail('ACQUISITION_PERSISTENCE_INVALID', 'job deferred-input flag is invalid', 500)
  normalizeRequesterPublisherIds(job.requesterPublisherIds); normalizePublicationMetadata(job.publicationMetadata); normalizeIdentity(job.expectedIdentity); normalizeVerifiedPrefix(job.verifiedPrefix, job.expectedBytes); normalizeVerifiedAsset(job.verifiedAsset, job.expectedBytes); normalizePublication(job.publication)
  assertNoPrivateSourceMaterial({
    ...job,
    request: { ...job.request, sourceFileName: null },
    publicationMetadata: null
  }, 'durable acquisition job'); projectAcquisitionJob(job)
  return job
}
function stateEventType (state) { return `acquisition.${state}` }

export function createAcquisitionStore ({ bee, now = () => Date.now() } = {}) {
  if (!bee || typeof bee.get !== 'function' || typeof bee.batch !== 'function' || typeof bee.createReadStream !== 'function') throw new TypeError('acquisition store requires an atomic Hyperbee-compatible store')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  let writes = Promise.resolve()
  let stateCounts = null
  const jobKey = acquisitionId => `${JOB_PREFIX}${acquisitionId}`
  const idempotencyKey = digest => `${IDEMPOTENCY_PREFIX}${digest}`
  const activeKey = acquisitionId => `${ACTIVE_PREFIX}${acquisitionId}`
  const eventKey = (acquisitionId, sequence) => `${EVENT_PREFIX}${acquisitionId}/${String(sequence).padStart(16, '0')}`
  function timestamp () { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must return a non-negative safe integer'); return value }
  function serialized (operation) { const result = writes.then(operation, operation); writes = result.catch(() => {}); return result }
  async function readUnserialized (key) { const node = await bee.get(key); return node ? decode(node.value) : null }
  async function read (key) { await writes; return readUnserialized(key) }
  function emptyStateCounts () { return Object.fromEntries(ACQUISITION_STATES.map(state => [state, 0])) }
  async function ensureStateCounts () {
    if (stateCounts !== null) return stateCounts
    const counts = emptyStateCounts()
    for await (const entry of bee.createReadStream({ gte: JOB_PREFIX, lt: `${JOB_PREFIX}\uffff` })) {
      const job = validateDurableJob(decode(entry.value))
      counts[job.state]++
    }
    stateCounts = counts
    return stateCounts
  }
  function moveStateCount (from, to) {
    if (from !== null) stateCounts[from]--
    stateCounts[to]++
  }
  async function atomic (operations) {
    const batch = bee.batch()
    if (!batch || typeof batch.put !== 'function' || typeof batch.del !== 'function' || typeof batch.flush !== 'function') fail('ACQUISITION_PERSISTENCE_FAILED', 'store lacks atomic batches', 500)
    for (const [operation, key, value] of operations) { if (operation === 'put') await batch.put(key, clone(value)); else await batch.del(key) }
    await batch.flush()
  }
  function checkedCurrent (current, acquisitionId, expectedVersion, from) {
    if (!current) fail('ACQUISITION_NOT_FOUND', 'acquisition not found', 404)
    if (current.acquisitionId !== acquisitionId) fail('ACQUISITION_PERSISTENCE_CORRUPT', 'job id mismatch', 500)
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) fail('ACQUISITION_VERSION_CONFLICT', 'acquisition version changed')
    const states = Array.isArray(from) ? from : [from]
    if (!states.includes(current.state)) fail('ACQUISITION_VERSION_CONFLICT', `expected ${states.join('|')}, have ${current.state}`)
  }
  function withEventOperations (job, type, operations) { const event = acquisitionEventForJob(job, type); operations.push(['put', eventKey(job.acquisitionId, job.version), event]); return event }
  const store = {
    async ready () { await writes; return this },
    async get (acquisitionId) { const job = await read(jobKey(id(acquisitionId, 'acquisitionId'))); return job ? clone(validateDurableJob(job)) : null },
    async findByIdempotency (digest) {
      const index = await read(idempotencyKey(digest)); if (!index) return null
      const job = await read(jobKey(index.acquisitionId))
      if (!job || index.idempotencyDigest !== digest || job.idempotencyDigest !== digest || job.requestFingerprint !== index.requestFingerprint) fail('ACQUISITION_PERSISTENCE_CORRUPT', 'idempotency index is corrupt', 500)
      return clone(validateDurableJob(job))
    },
    createOrReplay ({ idempotencyDigest, requestFingerprint, job }) {
      return serialized(async () => {
        await ensureStateCounts()
        const index = await readUnserialized(idempotencyKey(idempotencyDigest))
        if (index) {
          if (index.requestFingerprint !== requestFingerprint) fail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another request')
          const existing = await readUnserialized(jobKey(index.acquisitionId))
          if (!existing || existing.idempotencyDigest !== idempotencyDigest) fail('ACQUISITION_PERSISTENCE_CORRUPT', 'idempotency index is corrupt', 500)
          return { created: false, job: clone(validateDurableJob(existing)) }
        }
        validateDurableJob(job)
        if (job.state !== 'queued' || job.version !== 0 || job.idempotencyDigest !== idempotencyDigest || job.requestFingerprint !== requestFingerprint) fail('ACQUISITION_PERSISTENCE_INVALID', 'initial acquisition job is invalid', 500)
        const operations = [['put', jobKey(job.acquisitionId), job], ['put', idempotencyKey(idempotencyDigest), { schemaVersion: 1, idempotencyDigest, requestFingerprint, acquisitionId: job.acquisitionId }], ['put', activeKey(job.acquisitionId), { acquisitionId: job.acquisitionId }]]
        const event = withEventOperations(job, 'acquisition.queued', operations); await atomic(operations); moveStateCount(null, 'queued'); return { created: true, job: clone(job), event }
      })
    },
    transition (acquisitionId, { expectedVersion, from, to, patch = {} } = {}) {
      return serialized(async () => {
        await ensureStateCounts()
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, from)
        if (TERMINAL.has(current.state)) fail('ACQUISITION_TERMINAL', `acquisition is ${current.state}`)
        if (!STATES.has(to) || (to !== 'failed' && to !== 'cancelled' && NEXT.get(current.state) !== to)) fail('ACQUISITION_INVALID_TRANSITION', `${current.state} -> ${to}`)
        if (to === 'completed') fail('ACQUISITION_PERSISTENCE_INVALID', 'completed transition requires atomic publication', 500)
        const next = { ...current, ...normalizePatch(patch, current), state: to, version: current.version + 1, updatedAt: timestamp() }
        if (to === 'failed' || to === 'cancelled') next.finishedAt = next.finishedAt ?? next.updatedAt
        else { next.errorCode = null; next.recoverable = false }
        validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next]]; if (TERMINAL.has(to)) operations.push(['del', activeKey(acquisitionId)])
        const event = withEventOperations(next, stateEventType(to), operations); await atomic(operations); moveStateCount(current.state, to); return { job: clone(next), event }
      })
    },
    updateProgress (acquisitionId, { expectedVersion, state, patch = {} } = {}) {
      return serialized(async () => {
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, state)
        const next = { ...current, ...normalizePatch(patch, current), version: current.version + 1, updatedAt: timestamp() }; validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next]]; const event = withEventOperations(next, 'acquisition.progress', operations); await atomic(operations); return { job: clone(next), event }
      })
    },
    retry (acquisitionId, { expectedVersion, resetVerifiedPrefix = false } = {}) {
      return serialized(async () => {
        await ensureStateCounts()
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, 'failed')
        if (!current.recoverable) fail('ACQUISITION_TERMINAL', 'acquisition failure is not recoverable')
        const next = { ...current, state: 'queued', version: current.version + 1, errorCode: null, recoverable: false, finishedAt: null, updatedAt: timestamp(), ...(resetVerifiedPrefix ? { verifiedPrefix: null, stagingBytes: 0 } : {}) }; validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next], ['put', activeKey(acquisitionId), { acquisitionId }]]; const event = withEventOperations(next, 'acquisition.restarted', operations); await atomic(operations); moveStateCount('failed', 'queued'); return { job: clone(next), event }
      })
    },
    exhaust (acquisitionId, { expectedVersion } = {}) {
      return serialized(async () => {
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, 'failed')
        if (!current.recoverable) return { job: clone(validateDurableJob(current)), event: null }
        const next = { ...current, version: current.version + 1, recoverable: false, updatedAt: timestamp() }
        validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next]]
        const event = withEventOperations(next, 'acquisition.failed', operations)
        await atomic(operations)
        return { job: clone(next), event }
      })
    },
    recover (acquisitionId, { expectedVersion } = {}) {
      return serialized(async () => {
        await ensureStateCounts()
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, ['acquiring', 'verifying'])
        const next = { ...current, state: 'queued', version: current.version + 1, errorCode: null, recoverable: false, finishedAt: null, updatedAt: timestamp() }; validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next], ['put', activeKey(acquisitionId), { acquisitionId }]]; const event = withEventOperations(next, 'acquisition.restarted', operations); await atomic(operations); moveStateCount(current.state, 'queued'); return { job: clone(next), event }
      })
    },
    complete (acquisitionId, { expectedVersion, publication } = {}) {
      return serialized(async () => {
        await ensureStateCounts()
        const current = await readUnserialized(jobKey(acquisitionId)); checkedCurrent(current, acquisitionId, expectedVersion, 'publishing')
        const result = normalizePublication(publication)
        if (!current.verifiedAsset || current.verifiedBytes !== current.expectedBytes || result.assetId !== current.verifiedAsset.assetId) fail('ACQUISITION_NOT_VERIFIED', 'publication requires exact asset verification')
        const at = timestamp()
        const next = { ...current, state: 'completed', version: current.version + 1, bytesAcquired: current.expectedBytes, sourceBytesAccepted: current.expectedBytes, verifiedBytes: current.expectedBytes, committedBytes: current.expectedBytes, retainedBytes: current.expectedBytes, stagingBytes: 0, publication: result, errorCode: null, recoverable: false, finishedAt: at, updatedAt: at }; validateDurableJob(next)
        const operations = [['put', jobKey(acquisitionId), next], ['del', activeKey(acquisitionId)]]; const event = withEventOperations(next, 'acquisition.completed', operations); await atomic(operations); moveStateCount('publishing', 'completed'); return { job: clone(next), event }
      })
    },
    async list ({ cursor = null, limit = 64, states = null, principalId = null } = {}) {
      await writes
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail('ACQUISITION_LIST_INVALID', 'list limit is invalid', 400)
      if (cursor != null) id(cursor, 'cursor')
      const selectedStates = states == null ? null : new Set(states)
      if (selectedStates && ([...selectedStates].some(state => !STATES.has(state)) || selectedStates.size !== states.length)) fail('ACQUISITION_LIST_INVALID', 'list states are invalid', 400)
      const owner = principalId == null ? null : normalizePrincipalId(principalId)
      const jobs = []
      for await (const entry of bee.createReadStream({ gte: JOB_PREFIX, lt: `${JOB_PREFIX}\uffff` })) { const job = validateDurableJob(decode(entry.value)); if (owner != null && job.principalId !== owner) continue; if (selectedStates && !selectedStates.has(job.state)) continue; jobs.push(job) }
      jobs.sort((left, right) => right.updatedAt - left.updatedAt || left.acquisitionId.localeCompare(right.acquisitionId))
      const found = cursor == null ? -1 : jobs.findIndex(job => job.acquisitionId === cursor)
      const start = found < 0 ? 0 : found + 1
      const page = jobs.slice(start, start + limit)
      return { items: page.map(clone), cursor: start + page.length < jobs.length && page.length > 0 ? page[page.length - 1].acquisitionId : null }
    },
    countByState () {
      return serialized(async () => ({ ...(await ensureStateCounts()) }))
    },
    async listAccountingSince (since) {
      await writes
      const floor = uint(since, 'accounting window start')
      const records = []
      for await (const entry of bee.createReadStream({ gte: JOB_PREFIX, lt: `${JOB_PREFIX}\uffff` })) {
        const job = validateDurableJob(decode(entry.value))
        if (job.updatedAt < floor && job.createdAt < floor) continue
        records.push({
          acquisitionId: job.acquisitionId,
          sourceBytesRead: job.sourceBytesRead,
          updatedAt: job.updatedAt,
          createdAt: job.createdAt,
          isRemote: job.isRemote,
        })
      }
      return records
    },
    async listActive () {
      await writes; const jobs = []
      for await (const entry of bee.createReadStream({ gte: ACTIVE_PREFIX, lt: `${ACTIVE_PREFIX}\uffff` })) { const pointer = decode(entry.value); const job = await readUnserialized(jobKey(pointer?.acquisitionId)); if (!job || TERMINAL.has(job.state)) fail('ACQUISITION_PERSISTENCE_CORRUPT', 'active index is corrupt', 500); jobs.push(clone(validateDurableJob(job))) }
      return jobs
    },
    // Remove a finished acquisition and everything keyed to it. An operator
    // clearing a dead attempt means the row, its event log and its idempotency
    // index: leaving the index behind would make `findByIdempotency` read a
    // record whose job is gone and fail the whole store as corrupt. A job that
    // has not finished is refused rather than silently deleted out from under
    // the worker still writing to it.
    forget (acquisitionId) {
      return serialized(async () => {
        await ensureStateCounts()
        const key = jobKey(id(acquisitionId, 'acquisitionId'))
        const current = await readUnserialized(key)
        if (!current) return { forgotten: false, state: null }
        if (!TERMINAL.has(current.state)) fail('ACQUISITION_JOB_ACTIVE', 'only a finished acquisition can be forgotten', 409)
        const operations = [['del', key], ['del', activeKey(current.acquisitionId)]]
        if (current.idempotencyDigest) operations.push(['del', idempotencyKey(current.idempotencyDigest)])
        const prefix = `${EVENT_PREFIX}${current.acquisitionId}/`
        for await (const entry of bee.createReadStream({ gte: prefix, lt: `${prefix}\uffff` })) operations.push(['del', entry.key])
        await atomic(operations)
        stateCounts[current.state]--
        return { forgotten: true, state: current.state }
      })
    },
    async listEvents (acquisitionId) { await writes; const prefix = `${EVENT_PREFIX}${id(acquisitionId, 'acquisitionId')}/`; const events = []; for await (const entry of bee.createReadStream({ gte: prefix, lt: `${prefix}\uffff` })) events.push(decode(entry.value)); return events },
    importLegacyPublicJobs (jobs, markerId) {
      return serialized(async () => {
        await ensureStateCounts()
        if (typeof markerId !== 'string' || !MIGRATION_MARKER.test(markerId)) fail('ACQUISITION_PERSISTENCE_INVALID', 'migration marker is invalid', 500)
        const markerKey = `${LEGACY_MARKER_PREFIX}${markerId}`
        // A relay that already migrated still gets the work identity written
        // onto its imported jobs. The alternative is an inventory that can only
        // ever name the machine ids of everything it holds.
        const alreadyMigrated = Boolean(await readUnserialized(markerKey))
        const operations = []; const insertedStates = []; let migrated = 0; let skipped = 0
        for (const input of jobs) {
          const existing = await readUnserialized(jobKey(input.acquisitionId))
          if (existing) {
            skipped++
            const merged = mergedPublicationMetadata(existing.publicationMetadata, input.publicationMetadata)
            if (merged) {
              const named = { ...existing, publicationMetadata: merged }
              validateDurableJob(named)
              operations.push(['put', jobKey(input.acquisitionId), named])
            }
            continue
          }
          if (alreadyMigrated) {
            skipped++
            continue
          }
          validateDurableJob(input)
          operations.push(['put', jobKey(input.acquisitionId), input])
          if (!TERMINAL.has(input.state)) operations.push(['put', activeKey(input.acquisitionId), { acquisitionId: input.acquisitionId }])
          withEventOperations(input, stateEventType(input.state), operations)
          insertedStates.push(input.state)
          migrated++
        }
        if (!alreadyMigrated) operations.push(['put', markerKey, { schemaVersion: 1, migrated, skipped, migratedAt: timestamp() }])
        if (operations.length > 0) await atomic(operations)
        for (const state of insertedStates) moveStateCount(null, state)
        return { migrated, skipped }
      })
    },
    async close () { await writes }
  }
  return Object.freeze(store)
}

function base64url (bytes) { return b4a.toString(bytes, 'base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
function legacyResolutionRef (jobId) { return base64url(crypto.hash(b4a.from(`peartube.legacy-resolution.v1\u0000${jobId}`))).slice(0, 43) }
async function legacyPublicJobs (legacyStore) {
  if (!legacyStore) throw new TypeError('legacyStore is required')
  if (typeof legacyStore.listJobIds === 'function' && typeof legacyStore.getJob === 'function') {
    const result = []
    for (const entry of await legacyStore.listJobIds()) {
      const job = await legacyStore.getJob(entry.jobId)
      if (job) result.push(job)
    }
    return result
  }
  if (typeof legacyStore.listJobs === 'function') return legacyStore.listJobs()
  if (typeof legacyStore.listRecent === 'function') return legacyStore.listRecent(64)
  throw new TypeError('legacyStore must expose listJobIds/getJob, listJobs, or listRecent')
}
function legacyPublication (job) {
  const source = job.publication || job
  if (![source.publicationId, source.manifestId, source.renditionId, source.assetId].every(value => typeof value === 'string' && ID.test(value))) return null
  return { publicationId: source.publicationId, manifestId: source.manifestId, renditionId: source.renditionId, assetId: source.assetId }
}
// A migrated job keeps the name of the work it was fetching and the name the
// source gave its file. Dropping them made every imported row read
// `Acquisition <id>`, which is the one thing an inventory surface must never
// do. The retired ingest wrote these under two shapes — the request's selector
// and the archive manager's coordinates — so both are mapped onto the one
// whitelist rather than guessed at read time.
const LEGACY_MEDIA_ALIASES = new Map([
  ['kind', 'kind'],
  ['contentKind', 'kind'],
  ['namespace', 'namespace'],
  ['mediaProvider', 'namespace'],
  ['identifier', 'identifier'],
  ['seriesIdentifier', 'identifier'],
  ['mediaId', 'identifier'],
  ['title', 'title'],
  ['season', 'season'],
  ['seasonNumber', 'season'],
  ['episode', 'episode'],
  ['episodeNumber', 'episode'],
  ['releaseYear', 'releaseYear'],
  ['workEntityId', 'workEntityId']
])

function legacyFileName (value) {
  if (typeof value !== 'string') return null
  const name = value.split(/[/\\]/).pop().trim()
  return name && name.length <= 255 ? name : null
}

function legacyMediaContext (job, request) {
  const context = {}
  for (const candidate of [request.mediaContext, job?.mediaContext, job?.mediaCoordinates]) {
    if (!plainObject(candidate)) continue
    for (const [key, value] of Object.entries(candidate)) {
      const field = LEGACY_MEDIA_ALIASES.get(key)
      if (!field || context[field] !== undefined || !boundedMetadataValue(value)) continue
      context[field] = value
    }
  }
  return Object.keys(context).length > 0 ? context : null
}

function legacyPublicationMetadata (job) {
  const request = plainObject(job?.request) ? job.request : {}
  const title = [job?.title, request.title].find(value => boundedMetadataValue(value) && typeof value === 'string') ?? null
  const sourceFileName = [job?.sourceFileName, job?.fileName, job?.filename, request.sourceFileName, request.fileName]
    .map(legacyFileName)
    .find(Boolean) ?? null
  const mediaContext = legacyMediaContext(job, request)
  return title === null && sourceFileName === null && mediaContext === null
    ? null
    : { title, sourceFileName, mediaContext }
}
export async function migrateLegacyIngest ({ legacyStore, acquisitionStore, legacyPrincipalId = 'local', legacyPublisherId = 'local', now = () => Date.now() } = {}) {
  if (!acquisitionStore || typeof acquisitionStore.importLegacyPublicJobs !== 'function') throw new TypeError('acquisitionStore is required')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const principalId = normalizePrincipalId(legacyPrincipalId); const publisherId = id(legacyPublisherId, 'legacyPublisherId'); const imported = []
  for (const legacy of await legacyPublicJobs(legacyStore)) {
    const acquisitionId = id(legacy.jobId ?? legacy.acquisitionId, 'legacy job id'); const expectedBytes = uint(legacy.expectedBytes ?? legacy.request?.expected?.byteLength, 'legacy expectedBytes')
    if (expectedBytes < 1) fail('ACQUISITION_PERSISTENCE_INVALID', 'legacy expectedBytes is invalid', 500)
    const legacyState = STATES.has(legacy.state) ? legacy.state : 'failed'; const interrupted = !TERMINAL.has(legacyState) && legacyState !== 'queued'; const publication = legacyPublication(legacy); const completed = legacyState === 'completed' && publication !== null
    const state = completed ? 'completed' : (legacyState === 'cancelled' ? 'cancelled' : (legacyState === 'failed' ? 'failed' : (legacyState === 'queued' ? 'queued' : 'failed')))
    const at = Number.isSafeInteger(legacy.updatedAt) && legacy.updatedAt >= 0 ? legacy.updatedAt : now(); const bytesAcquired = Math.min(expectedBytes, Number.isSafeInteger(legacy.bytesReceived) && legacy.bytesReceived >= 0 ? legacy.bytesReceived : 0)
    const request = normalizeAcquisitionRequest({ schemaVersion: 1, resolutionRef: legacyResolutionRef(acquisitionId), publisherId, retentionClass: legacy.retentionClass === 'archive-pin' ? 'archive-pin' : 'contribution-cache' })
    const verifiedAsset = completed ? { assetId: publication.assetId, key: publication.assetId, treeHash: publication.assetId, length: 1, byteLength: expectedBytes, blockSize: expectedBytes } : null
    imported.push({ schemaVersion: 1, acquisitionId, state, version: 0, principalId, publisherId, requesterPublisherIds: [publisherId], isRemote: false, idempotencyDigest: null, requestFingerprint: null, request, retentionClass: request.retentionClass, publicationMetadata: legacyPublicationMetadata(legacy), expectedBytes, sourceBytesRead: bytesAcquired, sourceBytesAccepted: bytesAcquired, bytesAcquired, verifiedBytes: completed ? expectedBytes : 0, committedBytes: completed ? expectedBytes : 0, retainedBytes: completed ? expectedBytes : 0, stagingBytes: 0, stagingPeakBytes: 0, attempts: 0, startedAt: null, finishedAt: TERMINAL.has(state) ? at : null, verifiedPrefix: null, verifiedAsset, publication: completed ? publication : null, errorCode: state === 'failed' ? (interrupted ? 'LEGACY_SOURCE_GRANT_REQUIRED' : (ERROR_CODE.test(legacy.errorCode || '') ? legacy.errorCode : 'LEGACY_INGEST_FAILED')) : (state === 'cancelled' ? 'CANCELLED' : null), recoverable: state === 'failed' && (interrupted || legacy.recoverable === true), createdAt: Number.isSafeInteger(legacy.createdAt) && legacy.createdAt >= 0 ? legacy.createdAt : at, updatedAt: at })
  }
  const marker = base64url(crypto.hash(b4a.from(`${principalId}\u0000${publisherId}`))).slice(0, 32)
  return acquisitionStore.importLegacyPublicJobs(imported, marker)
}
