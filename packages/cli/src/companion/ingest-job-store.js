const JOB_PREFIX = 'companion-ingest/v1/job/'
const IDEMPOTENCY_PREFIX = 'companion-ingest/v1/idempotency/'
const ACTIVE_PREFIX = 'companion-ingest/v1/active/'
const PUBLICATION_PREFIX = 'companion-ingest/v1/publication/'

export const INGEST_JOB_STATES = Object.freeze([
  'queued',
  'acquiring',
  'verifying',
  'publishing',
  'completed',
  'failed',
  'cancelled'
])

export const TERMINAL_INGEST_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled'])

const TERMINAL = new Set(TERMINAL_INGEST_JOB_STATES)
const NEXT = new Map([
  ['queued', 'acquiring'],
  ['acquiring', 'verifying'],
  ['verifying', 'publishing'],
  ['publishing', 'completed']
])
const PATCH_FIELDS = new Set([
  'bytesReceived',
  'errorCode',
  'recoverable',
  'publication',
  'completedAt',
  'failedAt',
  'cancelledAt'
])
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const FORBIDDEN_DURABLE_KEY = /(?:^|_)(?:spool|sourcecapability|capability|cookie|authorization|credential|secret|password|passkey|debrid|headers?|sourceurl|fetchurl|signedurl|localpath|filepath)(?:$|_)/i
const LOCATOR_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/|^(?:magnet|data|file|ftp|rtsp):|^\/\/)/i
const MAX_DURABLE_STRING_BYTES = 4096
const MAX_DURABLE_KEY_BYTES = 128
const MAX_DURABLE_ENTRIES = 512
const MAX_DURABLE_RECORD_BYTES = 128 * 1024

export class IngestJobStoreError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'IngestJobStoreError'
    this.code = code
  }
}

function storeError (code, message) {
  return new IngestJobStoreError(code, message)
}

function decode (value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest persistence is corrupt')
  }
}

function assertDurableValue (value, depth = 0, state = { seen: new Set(), entries: 0 }) {
  if (depth > 16) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record exceeds its bounds')
  state.entries++
  if (state.entries > MAX_DURABLE_ENTRIES) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record exceeds its bounds')
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_DURABLE_STRING_BYTES) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest string exceeds its bound')
    if (LOCATOR_VALUE.test(value)) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains a locator')
    return
  }
  if (!value || typeof value !== 'object') return
  if (state.seen.has(value)) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains a cycle')
  state.seen.add(value)
  try {
    const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value)
    if (entries.length > MAX_DURABLE_ENTRIES) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record exceeds its bounds')
    for (const [key, child] of entries) {
      if (Buffer.byteLength(key) > MAX_DURABLE_KEY_BYTES) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest field exceeds its bound')
      if (!Array.isArray(value)) {
        const compact = key.replaceAll('-', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
        if (FORBIDDEN_DURABLE_KEY.test(compact)) {
          throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains prohibited source material')
        }
      }
      assertDurableValue(child, depth + 1, state)
    }
  } finally {
    state.seen.delete(value)
  }
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value)) > MAX_DURABLE_RECORD_BYTES) {
    throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record exceeds its byte bound')
  }
}

function clone (value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizePatch (patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest job patch')
  }
  const result = {}
  for (const [field, value] of Object.entries(patch)) {
    if (!PATCH_FIELDS.has(field)) throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest job patch')
    result[field] = value
  }
  if (result.errorCode != null && !ERROR_CODE.test(result.errorCode)) {
    throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest error code')
  }
  if (result.bytesReceived != null && (!Number.isSafeInteger(result.bytesReceived) || result.bytesReceived < 0)) {
    throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest byte progress')
  }
  if (result.recoverable != null && typeof result.recoverable !== 'boolean') {
    throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest recovery flag')
  }
  assertDurableValue(result)
  return clone(result)
}

function assertTransition (current, to) {
  if (!INGEST_JOB_STATES.includes(to)) throw storeError('INGEST_INVALID_TRANSITION', `INGEST_INVALID_TRANSITION: unknown target ${to}`)
  if (TERMINAL.has(current.state)) throw storeError('INGEST_JOB_TERMINAL', `INGEST_JOB_TERMINAL: ${current.state}`)
  if (to === 'failed' || to === 'cancelled') return
  if (NEXT.get(current.state) !== to) {
    throw storeError('INGEST_INVALID_TRANSITION', `INGEST_INVALID_TRANSITION: ${current.state} -> ${to}`)
  }
}

export function createIngestJobStore ({ bee, now = () => Date.now() } = {}) {
  if (!bee || typeof bee.get !== 'function' || typeof bee.batch !== 'function') {
    throw new TypeError('ingest job store requires an atomic Hyperbee-compatible store')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')

  const jobKey = jobId => `${JOB_PREFIX}${jobId}`
  const idempotencyKey = digest => `${IDEMPOTENCY_PREFIX}${digest}`
  const activeKey = jobId => `${ACTIVE_PREFIX}${jobId}`
  const publicationKey = fence => `${PUBLICATION_PREFIX}${fence}`
  let writes = Promise.resolve()

  function persistenceFailure (error) {
    if (error instanceof IngestJobStoreError) return error
    return storeError('INGEST_PERSISTENCE_FAILED', 'Ingest persistence failed')
  }

  function serialized (operation) {
    const result = writes.then(operation, operation).catch(error => { throw persistenceFailure(error) })
    writes = result.catch(() => {})
    return result
  }

  async function readNode (key) {
    await writes
    try {
      const node = await bee.get(key)
      return node ? decode(node.value) : null
    } catch (error) {
      throw persistenceFailure(error)
    }
  }

  async function readNodeUnserialized (key) {
    const node = await bee.get(key)
    return node ? decode(node.value) : null
  }

  async function atomic (operations) {
    const batch = bee.batch()
    if (!batch || typeof batch.put !== 'function' || typeof batch.del !== 'function' || typeof batch.flush !== 'function') {
      throw storeError('INGEST_PERSISTENCE_FAILED', 'Ingest persistence lacks atomic batches')
    }
    for (const operation of operations) {
      if (operation[0] === 'put') await batch.put(operation[1], operation[2])
      else await batch.del(operation[1])
    }
    await batch.flush()
  }

  function checkedCurrent (current, { jobId, expectedVersion, from }) {
    if (!current) throw storeError('INGEST_JOB_NOT_FOUND', 'INGEST_JOB_NOT_FOUND')
    if (!Number.isSafeInteger(expectedVersion) || current.version !== expectedVersion) {
      throw storeError('INGEST_VERSION_CONFLICT', `INGEST_VERSION_CONFLICT: expected ${expectedVersion}, have ${current.version}`)
    }
    const allowed = Array.isArray(from) ? from : [from]
    if (!allowed.includes(current.state)) {
      throw storeError('INGEST_VERSION_CONFLICT', `INGEST_VERSION_CONFLICT: expected ${allowed.join('|')}, have ${current.state}`)
    }
    if (current.jobId !== jobId) throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest persistence is corrupt')
  }

  return Object.freeze({
    async getJob (jobId) {
      return clone(await readNode(jobKey(jobId)))
    },

    async findByIdempotency (digest) {
      const index = await readNode(idempotencyKey(digest))
      if (!index) return null
      if (index.idempotencyDigest !== digest) {
        throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
      }
      const job = await readNode(jobKey(index.jobId))
      if (!job || job.idempotencyDigest !== digest || job.requestFingerprint !== index.requestFingerprint) {
        throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
      }
      return clone(job)
    },

    createOrReplay ({ idempotencyDigest, requestFingerprint, job }) {
      return serialized(async () => {
        const index = await readNodeUnserialized(idempotencyKey(idempotencyDigest))
        if (index) {
          if (index.idempotencyDigest !== idempotencyDigest) {
            throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
          }
          if (index.requestFingerprint !== requestFingerprint) {
            throw storeError('IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT')
          }
          const existing = await readNodeUnserialized(jobKey(index.jobId))
          if (!existing || existing.idempotencyDigest !== idempotencyDigest || existing.requestFingerprint !== requestFingerprint) {
            throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
          }
          return { created: false, job: clone(existing) }
        }
        if (!job || job.state !== 'queued' || job.version !== 0 || job.idempotencyDigest !== idempotencyDigest || job.requestFingerprint !== requestFingerprint) {
          throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid initial ingest job')
        }
        assertDurableValue(job)
        const record = clone(job)
        const pointer = Object.freeze({ schemaVersion: 1, idempotencyDigest, jobId: record.jobId, requestFingerprint })
        await atomic([
          ['put', jobKey(record.jobId), record],
          ['put', idempotencyKey(idempotencyDigest), pointer],
          ['put', activeKey(record.jobId), { jobId: record.jobId }]
        ])
        return { created: true, job: clone(record) }
      })
    },

    transition (jobId, { expectedVersion, from, to, patch = {} } = {}) {
      return serialized(async () => {
        const current = await readNodeUnserialized(jobKey(jobId))
        checkedCurrent(current, { jobId, expectedVersion, from })
        assertTransition(current, to)
        if (to === 'completed') throw storeError('INGEST_PERSISTENCE_INVALID', 'Completed jobs require an atomic publication result')
        const timestamp = now()
        const next = {
          ...current,
          ...normalizePatch(patch),
          state: to,
          version: current.version + 1,
          updatedAt: timestamp
        }
        assertDurableValue(next)
        const operations = [['put', jobKey(jobId), next]]
        if (TERMINAL.has(to)) operations.push(['del', activeKey(jobId)])
        await atomic(operations)
        return clone(next)
      })
    },

    updateProgress (jobId, { expectedVersion, state, bytesReceived } = {}) {
      return serialized(async () => {
        const current = await readNodeUnserialized(jobKey(jobId))
        checkedCurrent(current, { jobId, expectedVersion, from: state })
        if (TERMINAL.has(current.state)) throw storeError('INGEST_JOB_TERMINAL', `INGEST_JOB_TERMINAL: ${current.state}`)
        if (!Number.isSafeInteger(bytesReceived) || bytesReceived < current.bytesReceived || bytesReceived > current.expectedBytes) {
          throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid ingest byte progress')
        }
        const next = {
          ...current,
          bytesReceived,
          version: current.version + 1,
          updatedAt: now()
        }
        await atomic([['put', jobKey(jobId), next]])
        return clone(next)
      })
    },

    reopenRecoverable (jobId, { expectedVersion, resetProgress = false } = {}) {
      return serialized(async () => {
        const current = await readNodeUnserialized(jobKey(jobId))
        checkedCurrent(current, { jobId, expectedVersion, from: 'failed' })
        if (current.recoverable !== true) {
          throw storeError('INGEST_JOB_TERMINAL', 'INGEST_JOB_TERMINAL: failed')
        }
        const next = {
          ...current,
          bytesReceived: resetProgress ? 0 : current.bytesReceived,
          state: 'queued',
          version: current.version + 1,
          errorCode: null,
          failedAt: null,
          recoverable: false,
          updatedAt: now()
        }
        assertDurableValue(next)
        await atomic([
          ['put', jobKey(jobId), next],
          ['put', activeKey(jobId), { jobId }]
        ])
        return clone(next)
      })
    },

    completePublication (jobId, { expectedVersion, result } = {}) {
      return serialized(async () => {
        const current = await readNodeUnserialized(jobKey(jobId))
        checkedCurrent(current, { jobId, expectedVersion, from: 'publishing' })
        assertTransition(current, 'completed')
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid publication result')
        }
        const publication = clone(result)
        assertDurableValue(publication)
        const timestamp = now()
        const next = {
          ...current,
          state: 'completed',
          version: current.version + 1,
          bytesReceived: current.expectedBytes,
          errorCode: null,
          recoverable: false,
          publication,
          completedAt: timestamp,
          updatedAt: timestamp
        }
        const fence = current.publicationFence?.videoId
        if (typeof fence !== 'string' || !fence) throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest publication fence is corrupt')
        await atomic([
          ['put', publicationKey(fence), { schemaVersion: 1, jobId, result: publication }],
          ['put', jobKey(jobId), next],
          ['del', activeKey(jobId)]
        ])
        return clone(next)
      })
    },

    async getPublicationResult (fence) {
      const value = await readNode(publicationKey(fence))
      return value ? clone(value) : null
    },

    async listActive () {
      await writes
      const jobs = []
      try {
        for await (const entry of bee.createReadStream({ gte: ACTIVE_PREFIX, lt: `${ACTIVE_PREFIX}\uffff` })) {
          const pointer = decode(entry.value)
          if (!pointer?.jobId) throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest active index is corrupt')
          const job = await readNodeUnserialized(jobKey(pointer.jobId))
          if (!job || TERMINAL.has(job.state)) throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest active index is corrupt')
          jobs.push(clone(job))
        }
        return jobs
      } catch (error) {
        throw persistenceFailure(error)
      }
    },

    async listRecent (limit = 64) {
      await writes
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
        throw storeError('INGEST_LIST_LIMIT_INVALID', 'recent ingest job limit is invalid')
      }
      const jobs = []
      try {
        for await (const entry of bee.createReadStream({ gte: JOB_PREFIX, lt: `${JOB_PREFIX}\uffff` })) {
          const job = decode(entry.value)
          if (!job?.jobId || !INGEST_JOB_STATES.includes(job.state)) {
            throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest job record is corrupt')
          }
          jobs.push(job)
        }
        jobs.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
        return jobs.slice(0, limit).map(clone)
      } catch (error) {
        throw persistenceFailure(error)
      }
    },

    // Every job id this relay has ever recorded, with whether it has settled.
    // The staging sweep needs the WHOLE set rather than the recent window
    // `listRecent` returns: an id it never hears about is staging state that
    // nothing will ever reclaim, and the bucket is never enumerated to find it.
    async listJobIds () {
      await writes
      const ids = []
      try {
        for await (const entry of bee.createReadStream({ gte: JOB_PREFIX, lt: `${JOB_PREFIX}\uffff` })) {
          const job = decode(entry.value)
          if (!job?.jobId || !INGEST_JOB_STATES.includes(job.state)) {
            throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest job record is corrupt')
          }
          ids.push({ jobId: job.jobId, terminal: TERMINAL.has(job.state) })
        }
        return ids
      } catch (error) {
        throw persistenceFailure(error)
      }
    },

    async close () {
      await writes
    }
  })
}
