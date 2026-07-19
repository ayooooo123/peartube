import { createHash } from 'node:crypto'

export const JOB_KEY_PREFIX = 'content-add/v1/job/'
export const ACTIVE_KEY_PREFIX = 'content-add/v1/active/'

export const ROW_STATES = [
  'pending',
  'resolving',
  'downloading',
  'uploading',
  'uploaded',
  'replicationPending',
  'durabilityVerified',
  'projecting',
  'projected',
  'announcing',
  'announced',
  'finalizing',
  'published'
]

const STATE_INDEX = new Map(ROW_STATES.map((state, index) => [state, index]))
const TERMINAL_STATES = new Set(['published', 'skipped'])

// Fields that must never be serialized into durable job storage.
const FORBIDDEN_KEYS = new Set(['fetchUrl', 'displayUrl'])
const SECRET_PATTERN = /(token|secret|cookie|password|apikey|api_key|authorization|credential)/i

export class JobStoreError extends Error {
  constructor (message, { code } = {}) {
    super(message)
    this.name = 'JobStoreError'
    this.code = code
  }
}

export function deriveIntentIds (jobId, rowId) {
  const digest = (kind) => createHash('sha256').update(`${jobId}\u0000${rowId}\u0000${kind}`).digest('hex')
  return {
    channelIntentId: digest('channel').slice(0, 32),
    videoId: digest('video').slice(0, 32),
    blobIntentId: digest('blob').slice(0, 32)
  }
}

export function createJobStore ({ bee, now = () => Date.now() } = {}) {
  if (!bee) throw new Error('job store requires a hyperbee')

  const jobKey = (jobId) => `${JOB_KEY_PREFIX}${jobId}`
  const rowKey = (jobId, rowId) => `${JOB_KEY_PREFIX}${jobId}/row/${rowId}`
  const activeKey = (createdAt, jobId) => `${ACTIVE_KEY_PREFIX}${String(createdAt).padStart(16, '0')}/${jobId}`

  async function putBatch (entries) {
    if (typeof bee.batch === 'function') {
      const batch = bee.batch()
      for (const [key, value] of entries) await batch.put(key, value)
      await batch.flush()
      return
    }
    for (const [key, value] of entries) await bee.put(key, value)
  }

  async function readJob (jobId) {
    const node = await bee.get(jobKey(jobId))
    return node ? decode(node.value) : null
  }

  async function readRow (jobId, rowId) {
    const node = await bee.get(rowKey(jobId, rowId))
    return node ? decode(node.value) : null
  }

  async function summarize (jobId) {
    const job = await readJob(jobId)
    if (!job) return null
    const rows = []
    for (const rowId of job.rowIds) rows.push(await readRow(jobId, rowId))
    return { ...job, rows }
  }

  function firstIncompleteRow (job) {
    for (const row of job.rows) {
      if (!TERMINAL_STATES.has(row.state)) return row
    }
    return null
  }

  return {
    deriveIntentIds,

    async createJob ({ jobId, manifest, manifestChecksum, rows }) {
      if (!jobId) throw new JobStoreError('jobId is required', { code: 'ERR_JOB_ID_REQUIRED' })
      const existing = await readJob(jobId)
      if (existing) return summarize(jobId) // idempotent create
      const createdAt = now()
      const rowIds = rows.map((row) => row.rowId)
      const jobRecord = {
        jobId,
        createdAt,
        updatedAt: createdAt,
        manifestChecksum: manifestChecksum || null,
        rowIds,
        state: 'active'
      }
      const entries = [
        [jobKey(jobId), sanitize(jobRecord)],
        [activeKey(createdAt, jobId), { jobId, createdAt }]
      ]
      for (const row of rows) {
        entries.push([rowKey(jobId, row.rowId), sanitize({
          rowId: row.rowId,
          state: 'pending',
          version: 0,
          attempts: 0,
          progress: null,
          error: null,
          failedFrom: null,
          intent: deriveIntentIds(jobId, row.rowId),
          data: row.data || {},
          createdAt,
          updatedAt: createdAt
        })])
      }
      await putBatch(entries)
      return summarize(jobId)
    },

    getJob: summarize,
    getRow: readRow,

    async listActive () {
      const out = []
      for await (const entry of bee.createReadStream({ gte: ACTIVE_KEY_PREFIX, lt: `${ACTIVE_KEY_PREFIX}\uffff` })) {
        const value = decode(entry.value)
        if (value) out.push(value)
      }
      return out
    },

    async firstIncompleteRow (jobId) {
      const job = await summarize(jobId)
      return job ? firstIncompleteRow(job) : null
    },

    async validateManifestChecksum (jobId, checksum) {
      const job = await readJob(jobId)
      if (!job) throw new JobStoreError('job not found', { code: 'ERR_JOB_NOT_FOUND' })
      if (job.manifestChecksum && job.manifestChecksum !== checksum) {
        throw new JobStoreError('manifest checksum mismatch', { code: 'ERR_MANIFEST_CHECKSUM' })
      }
      return true
    },

    async transitionRow (jobId, rowId, { to, patch = {}, expectedVersion = null, error = null } = {}) {
      const current = await readRow(jobId, rowId)
      if (!current) throw new JobStoreError('row not found', { code: 'ERR_ROW_NOT_FOUND' })
      if (expectedVersion !== null && current.version !== expectedVersion) {
        throw new JobStoreError(`stale row version ${expectedVersion} (have ${current.version})`, { code: 'ERR_ROW_VERSION' })
      }
      assertTransition(current, to)

      const isRetry = current.state === 'failed'
      const next = sanitize({
        ...current,
        ...patch,
        rowId,
        intent: current.intent,
        state: to,
        version: current.version + 1,
        attempts: isRetry ? current.attempts + 1 : current.attempts,
        error: to === 'failed' ? normalizeError(error) : (to === current.failedFrom ? null : current.error),
        failedFrom: to === 'failed' ? current.state : current.failedFrom,
        data: { ...current.data, ...(patch.data || {}) },
        updatedAt: now()
      })

      const job = await readJob(jobId)
      const entries = [[rowKey(jobId, rowId), next]]
      if (job) entries.push([jobKey(jobId), sanitize({ ...job, updatedAt: now() })])
      await putBatch(entries)
      return next
    },

    async releaseJob (jobId) {
      const job = await readJob(jobId)
      if (!job) return
      await bee.del(activeKey(job.createdAt, jobId))
    }
  }
}

function assertTransition (row, to) {
  if (!ROW_STATES.includes(to) && to !== 'failed' && to !== 'skipped') {
    throw new JobStoreError(`unknown target state ${to}`, { code: 'ERR_UNKNOWN_STATE' })
  }
  if (TERMINAL_STATES.has(row.state)) {
    throw new JobStoreError(`row is terminal (${row.state})`, { code: 'ERR_ROW_TERMINAL' })
  }
  if (to === 'failed' || to === 'skipped') return
  if (row.state === 'failed') {
    if (to !== row.failedFrom) {
      throw new JobStoreError(`retry must resume ${row.failedFrom}, not ${to}`, { code: 'ERR_INVALID_TRANSITION' })
    }
    return
  }
  const fromIndex = STATE_INDEX.get(row.state)
  const toIndex = STATE_INDEX.get(to)
  if (toIndex !== fromIndex + 1) {
    throw new JobStoreError(`illegal transition ${row.state} -> ${to}`, { code: 'ERR_INVALID_TRANSITION' })
  }
}

function normalizeError (error) {
  if (!error) return null
  const out = { message: error.message != null ? String(error.message) : String(error) }
  if (error.code != null) out.code = error.code
  return out
}

export function sanitize (value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key) || SECRET_PATTERN.test(key)) continue
      out[key] = sanitize(value[key])
    }
    return out
  }
  return value
}

function decode (value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}
