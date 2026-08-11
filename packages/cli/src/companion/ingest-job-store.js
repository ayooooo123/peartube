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

function assertDurableValue (value, depth = 0, seen = new Set()) {
  if (depth > 16) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record exceeds its bounds')
  if (typeof value === 'string') {
    if (LOCATOR_VALUE.test(value)) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains a locator')
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const child of value) assertDurableValue(child, depth + 1, seen)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const compact = key.replaceAll('-', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
      if (FORBIDDEN_DURABLE_KEY.test(compact)) {
        throw storeError('INGEST_PERSISTENCE_INVALID', 'Ingest record contains prohibited source material')
      }
      assertDurableValue(child, depth + 1, seen)
    }
  } finally {
    seen.delete(value)
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
      const job = await readNode(jobKey(index.jobId))
      if (!job || job.requestFingerprint !== index.requestFingerprint) {
        throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
      }
      return clone(job)
    },

    createOrReplay ({ idempotencyDigest, requestFingerprint, job }) {
      return serialized(async () => {
        const index = await readNodeUnserialized(idempotencyKey(idempotencyDigest))
        if (index) {
          if (index.requestFingerprint !== requestFingerprint) {
            throw storeError('IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT')
          }
          const existing = await readNodeUnserialized(jobKey(index.jobId))
          if (!existing || existing.requestFingerprint !== requestFingerprint) {
            throw storeError('INGEST_PERSISTENCE_CORRUPT', 'Ingest idempotency index is corrupt')
          }
          return { created: false, job: clone(existing) }
        }
        if (!job || job.state !== 'queued' || job.version !== 0 || job.requestFingerprint !== requestFingerprint) {
          throw storeError('INGEST_PERSISTENCE_INVALID', 'Invalid initial ingest job')
        }
        assertDurableValue(job)
        const record = clone(job)
        const pointer = Object.freeze({ schemaVersion: 1, jobId: record.jobId, requestFingerprint })
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

    async close () {
      await writes
    }
  })
}
