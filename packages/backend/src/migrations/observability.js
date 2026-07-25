import b4a from 'b4a'

import { encodeCanonical, hashCanonical } from '../publisher/canonical.js'

const STATE_VERSION = 1
const STATE_KEY_PREFIX = 'migration-observability/v1/'
const STATES = new Set(['pending', 'running', 'complete', 'failed', 'retrying'])
const RESULT_STATES = new Set(['pending', 'complete', 'failed'])
const FAILURE_CATEGORIES = new Set(['execution', 'quarantined', 'unsupported'])

export const MIGRATION_LIMITS = Object.freeze({
  maxMigrations: 8,
  maxMigrationIdBytes: 64,
  maxFailureEntries: 32,
  maxFailureCodeBytes: 64,
  maxFailureCategoryBytes: 64,
  maxReportBytes: 65_536
})

function boundedCount (value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number))
}

function boundedTimestamp (value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) return 0
  return number
}

function normalizeMigrationId (value) {
  const migrationId = typeof value === 'string' ? value : ''
  if (
    migrationId.length === 0 ||
    b4a.byteLength(migrationId) > MIGRATION_LIMITS.maxMigrationIdBytes ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(migrationId)
  ) return ''
  return migrationId
}

function normalizeErrorCode (value, fallback = 'MIGRATION_FAILED') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    b4a.byteLength(value) > MIGRATION_LIMITS.maxFailureCodeBytes ||
    !/^[A-Z][A-Z0-9_]*$/.test(value)
  ) return fallback
  return value
}

function normalizeCategory (value) {
  if (
    typeof value !== 'string' ||
    b4a.byteLength(value) > MIGRATION_LIMITS.maxFailureCategoryBytes ||
    !FAILURE_CATEGORIES.has(value)
  ) return 'execution'
  return value
}

function safeErrorMessage (code) {
  if (code === 'MIGRATION_STATE_INVALID') return 'Migration state is invalid'
  return 'Migration failed'
}

function failureSubjectHash (migrationId, failure, code, category) {
  if (typeof failure?.subjectHash === 'string' && /^[0-9a-f]{64}$/.test(failure.subjectHash)) {
    return failure.subjectHash
  }

  let subject = ''
  try {
    subject = String(failure?.subject ?? '')
  } catch {}
  if (subject.length > 4_096) subject = subject.slice(0, 4_096)

  return b4a.toString(hashCanonical('peartube.migration.failure-subject.v1', {
    category,
    code,
    migrationId,
    subject
  }), 'hex')
}

function normalizeFailure (migrationId, failure = {}) {
  const category = normalizeCategory(failure?.category)
  const code = normalizeErrorCode(failure?.code)
  return {
    category,
    code,
    subjectHash: failureSubjectHash(migrationId, failure, code, category)
  }
}

function compareFailures (left, right) {
  if (left.category !== right.category) return left.category < right.category ? -1 : 1
  if (left.code !== right.code) return left.code < right.code ? -1 : 1
  if (left.subjectHash === right.subjectHash) return 0
  return left.subjectHash < right.subjectHash ? -1 : 1
}

function mergeFailures (migrationId, previous = [], incoming = []) {
  const entries = []
  const seen = new Set()
  const input = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ]

  for (const failure of input) {
    const normalized = normalizeFailure(migrationId, failure)
    const key = `${normalized.category}\0${normalized.code}\0${normalized.subjectHash}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(normalized)
  }
  entries.sort(compareFailures)

  return {
    entries: entries.slice(0, MIGRATION_LIMITS.maxFailureEntries),
    total: boundedCount(entries.length)
  }
}

function initialState (migrationId, updatedAt) {
  return {
    version: STATE_VERSION,
    migrationId,
    state: 'pending',
    attempts: 0,
    processedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    unsupportedCount: 0,
    remainingCount: 0,
    updatedAt,
    checkpoint: null,
    failures: [],
    failureCount: 0,
    errorCode: null,
    errorMessage: null
  }
}

function normalizeStoredState (migrationId, value, updatedAt) {
  if (!value || typeof value !== 'object' || value.version !== STATE_VERSION) {
    return initialState(migrationId, updatedAt)
  }

  const failures = mergeFailures(migrationId, [], value.failures)
  const errorCode = value.state === 'failed'
    ? normalizeErrorCode(value.errorCode)
    : null
  return {
    version: STATE_VERSION,
    migrationId,
    state: STATES.has(value.state) ? value.state : 'failed',
    attempts: boundedCount(value.attempts),
    processedCount: boundedCount(value.processedCount),
    importedCount: boundedCount(value.importedCount),
    skippedCount: boundedCount(value.skippedCount),
    quarantinedCount: boundedCount(value.quarantinedCount),
    unsupportedCount: boundedCount(value.unsupportedCount),
    remainingCount: boundedCount(value.remainingCount),
    updatedAt: boundedTimestamp(value.updatedAt || updatedAt),
    checkpoint: Object.hasOwn(value, 'checkpoint') ? value.checkpoint : null,
    failures: failures.entries,
    failureCount: Math.max(boundedCount(value.failureCount), failures.total),
    errorCode,
    errorMessage: errorCode ? safeErrorMessage(errorCode) : null
  }
}

function applyProgress (migrationId, state, progress = {}) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw Object.assign(new Error('invalid migration progress'), { code: 'MIGRATION_STATE_INVALID' })
  }

  const failures = Object.hasOwn(progress, 'failures')
    ? mergeFailures(migrationId, state.failures, progress.failures)
    : { entries: state.failures, total: state.failureCount }
  const next = {
    ...state,
    processedCount: Object.hasOwn(progress, 'processedCount') ? boundedCount(progress.processedCount) : state.processedCount,
    importedCount: Object.hasOwn(progress, 'importedCount') ? boundedCount(progress.importedCount) : state.importedCount,
    skippedCount: Object.hasOwn(progress, 'skippedCount') ? boundedCount(progress.skippedCount) : state.skippedCount,
    quarantinedCount: Object.hasOwn(progress, 'quarantinedCount') ? boundedCount(progress.quarantinedCount) : state.quarantinedCount,
    unsupportedCount: Object.hasOwn(progress, 'unsupportedCount') ? boundedCount(progress.unsupportedCount) : state.unsupportedCount,
    remainingCount: Object.hasOwn(progress, 'remainingCount') ? boundedCount(progress.remainingCount) : state.remainingCount,
    checkpoint: Object.hasOwn(progress, 'checkpoint') ? progress.checkpoint : state.checkpoint,
    failures: failures.entries,
    failureCount: Math.max(state.failureCount, failures.total)
  }
  return next
}

function reportBody (state, failures, failuresTruncated) {
  const report = {
    failures,
    failuresTruncated,
    importedCount: state.importedCount,
    migrationId: state.migrationId,
    processedCount: state.processedCount,
    quarantinedCount: state.quarantinedCount,
    remainingCount: state.remainingCount,
    retryable: state.state !== 'complete',
    skippedCount: state.skippedCount,
    state: state.state,
    unsupportedCount: state.unsupportedCount,
    updatedAt: state.updatedAt,
    version: state.version
  }
  if (state.errorCode) {
    report.errorCode = state.errorCode
    report.errorMessage = state.errorMessage
  }
  return report
}

function buildReport (state, maxReportBytes) {
  const failures = state.failures.slice()
  let bytes
  while (true) {
    const body = reportBody(state, failures, state.failureCount > failures.length)
    bytes = encodeCanonical(body)
    if (bytes.byteLength <= maxReportBytes) {
      return {
        body,
        bytes,
        digest: b4a.toString(hashCanonical('peartube.migration.report.v1', body), 'hex')
      }
    }
    if (failures.length === 0) return null
    failures.pop()
  }
}

function statusResponse (state, maxReportBytes) {
  const report = buildReport(state, maxReportBytes)
  const response = {
    success: true,
    migrationId: state.migrationId,
    state: state.state,
    version: state.version,
    processedCount: state.processedCount,
    importedCount: state.importedCount,
    skippedCount: state.skippedCount,
    quarantinedCount: state.quarantinedCount,
    unsupportedCount: state.unsupportedCount,
    remainingCount: state.remainingCount,
    retryable: state.state !== 'complete',
    updatedAt: state.updatedAt
  }
  if (state.errorCode) {
    response.errorCode = state.errorCode
    response.errorMessage = state.errorMessage
  }
  if (report) response.reportDigest = report.digest
  return response
}

function missingStatusResponse (migrationId) {
  return {
    success: false,
    migrationId: typeof migrationId === 'string' ? migrationId : '',
    state: 'failed',
    version: STATE_VERSION,
    processedCount: 0,
    importedCount: 0,
    skippedCount: 0,
    quarantinedCount: 0,
    unsupportedCount: 0,
    remainingCount: 0,
    retryable: false,
    updatedAt: 0,
    errorCode: 'MIGRATION_NOT_FOUND',
    errorMessage: 'Migration not found'
  }
}

function missingReportResponse (migrationId) {
  return {
    success: false,
    migrationId: typeof migrationId === 'string' ? migrationId : '',
    errorCode: 'MIGRATION_NOT_FOUND'
  }
}

function migrationEntries (migrations) {
  const entries = migrations instanceof Map
    ? Array.from(migrations.entries())
    : Object.entries(migrations || {})
  if (entries.length > MIGRATION_LIMITS.maxMigrations) throw new Error('migration count exceeds its limit')

  const normalized = new Map()
  for (const [rawId, rawAdapter] of entries) {
    const migrationId = normalizeMigrationId(rawId)
    const adapter = typeof rawAdapter === 'function' ? rawAdapter : rawAdapter?.adapter
    if (!migrationId || typeof adapter !== 'function') throw new Error('invalid migration adapter')
    if (normalized.has(migrationId)) throw new Error('duplicate migration adapter')
    normalized.set(migrationId, adapter)
  }
  return normalized
}

export function createMigrationLifecycle ({
  store,
  migrations,
  now = Date.now,
  maxReportBytes = MIGRATION_LIMITS.maxReportBytes
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error('migration state store must provide get and put')
  }
  if (typeof now !== 'function') throw new Error('migration clock must be a function')

  const adapters = migrationEntries(migrations)
  const reportLimit = Math.min(
    MIGRATION_LIMITS.maxReportBytes,
    Math.max(512, boundedCount(maxReportBytes) || MIGRATION_LIMITS.maxReportBytes)
  )
  const activeRuns = new Map()

  function timestamp () {
    return boundedTimestamp(now())
  }

  function stateKey (migrationId) {
    return `${STATE_KEY_PREFIX}${migrationId}`
  }

  async function saveState (state) {
    await store.put(stateKey(state.migrationId), state)
    return state
  }

  async function loadState (migrationId) {
    const record = await store.get(stateKey(migrationId))
    const value = record && typeof record === 'object' && Object.hasOwn(record, 'value')
      ? record.value
      : record
    if (value) return normalizeStoredState(migrationId, value, timestamp())
    return saveState(initialState(migrationId, timestamp()))
  }

  async function status (request = {}) {
    const migrationId = normalizeMigrationId(request?.migrationId)
    if (!migrationId || !adapters.has(migrationId)) return missingStatusResponse(request?.migrationId)
    return statusResponse(await loadState(migrationId), reportLimit)
  }

  async function execute (migrationId) {
    let current = await loadState(migrationId)
    if (current.state === 'complete') return statusResponse(current, reportLimit)

    const executionState = current.state === 'pending' ? 'running' : 'retrying'
    current = {
      ...current,
      state: executionState,
      attempts: boundedCount(current.attempts + 1),
      updatedAt: timestamp(),
      errorCode: null,
      errorMessage: null
    }
    await saveState(current)

    const persistCheckpoint = async (progress = {}) => {
      current = {
        ...applyProgress(migrationId, current, progress),
        state: executionState,
        updatedAt: timestamp(),
        errorCode: null,
        errorMessage: null
      }
      await saveState(current)
      return statusResponse(current, reportLimit)
    }

    try {
      const outcome = await adapters.get(migrationId)({
        migrationId,
        checkpoint: current.checkpoint,
        persistCheckpoint
      })
      if (!outcome || typeof outcome !== 'object' || !RESULT_STATES.has(outcome.state || 'complete')) {
        throw Object.assign(new Error('invalid migration result'), { code: 'MIGRATION_STATE_INVALID' })
      }

      current = applyProgress(migrationId, current, outcome)
      current = {
        ...current,
        state: outcome.state || 'complete',
        updatedAt: timestamp(),
        errorCode: null,
        errorMessage: null
      }
      if (current.state === 'failed') {
        current.errorCode = normalizeErrorCode(outcome.errorCode)
        current.errorMessage = safeErrorMessage(current.errorCode)
      }
      await saveState(current)
      return statusResponse(current, reportLimit)
    } catch (error) {
      const errorCode = normalizeErrorCode(error?.code)
      const failures = mergeFailures(migrationId, current.failures, [{
        code: errorCode,
        category: 'execution'
      }])
      current = {
        ...current,
        state: 'failed',
        updatedAt: timestamp(),
        failures: failures.entries,
        failureCount: Math.max(current.failureCount, failures.total),
        errorCode,
        errorMessage: safeErrorMessage(errorCode)
      }
      await saveState(current)
      return statusResponse(current, reportLimit)
    }
  }

  function retry (request = {}) {
    const migrationId = normalizeMigrationId(request?.migrationId)
    if (!migrationId || !adapters.has(migrationId)) {
      return Promise.resolve({ ...missingStatusResponse(request?.migrationId), joined: false })
    }

    const active = activeRuns.get(migrationId)
    if (active) return active.then(response => ({ ...response, joined: true }))

    const execution = execute(migrationId)
    activeRuns.set(migrationId, execution)
    const clear = () => {
      if (activeRuns.get(migrationId) === execution) activeRuns.delete(migrationId)
    }
    execution.then(clear, clear)
    return execution.then(response => ({ ...response, joined: false }))
  }

  async function exportReport (request = {}) {
    const migrationId = normalizeMigrationId(request?.migrationId)
    if (!migrationId || !adapters.has(migrationId)) return missingReportResponse(request?.migrationId)

    const report = buildReport(await loadState(migrationId), reportLimit)
    if (!report) {
      return {
        success: false,
        migrationId,
        errorCode: 'MIGRATION_REPORT_TOO_LARGE'
      }
    }
    return {
      success: true,
      migrationId,
      reportBytes: report.bytes,
      reportDigest: report.digest
    }
  }

  return Object.freeze({
    exportMigrationReport: exportReport,
    getMigrationStatus: status,
    retryMigration: retry
  })
}

export function getMigrationStatus (lifecycle, request) {
  return lifecycle.getMigrationStatus(request)
}

export function retryMigration (lifecycle, request) {
  return lifecycle.retryMigration(request)
}

export function exportMigrationReport (lifecycle, request) {
  return lifecycle.exportMigrationReport(request)
}
