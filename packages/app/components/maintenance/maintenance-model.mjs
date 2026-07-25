import { base64ToBytes, bytesToBase64 } from '../../lib/maintenance-file-transfer.mjs'

export const MIGRATION_ID = 'publication-v1'
export const MAX_MIGRATION_REPORT_BYTES = 65_536
export const MAX_PORTABLE_MANIFEST_BYTES = 1_048_576
export const MAX_PORTABLE_FILE_BYTES = 1_500_000

const STATE_PRESENTATION = Object.freeze({
  pending: Object.freeze({ label: 'Waiting to start', tone: 'neutral' }),
  running: Object.freeze({ label: 'Import in progress', tone: 'active' }),
  retrying: Object.freeze({ label: 'Retry in progress', tone: 'active' }),
  complete: Object.freeze({ label: 'Migration complete', tone: 'success' }),
  failed: Object.freeze({ label: 'Migration failed', tone: 'danger' }),
})

const COUNTERS = Object.freeze([
  ['Processed', 'processedCount'],
  ['Imported', 'importedCount'],
  ['Skipped', 'skippedCount'],
  ['Quarantined', 'quarantinedCount'],
  ['Unsupported', 'unsupportedCount'],
  ['Remaining', 'remainingCount'],
])

function boundedCount(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(1_000_000_000, Math.floor(value))
}

function cleanErrorText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function boundedError(error, fallback = 'Maintenance action failed') {
  const message = error instanceof Error ? cleanErrorText(error.message) : cleanErrorText(typeof error === 'string' ? error : '')
  return message || fallback
}

export function boundedDiagnosticCode(value, fallback = 'MIGRATION_FAILED') {
  return cleanErrorText(value).slice(0, 64) || fallback
}

function capability(available, reason) {
  return Object.freeze({ available, reason: available ? '' : reason })
}

export function maintenanceCapabilities({ rpc, files } = {}) {
  const hasStatus = typeof rpc?.getMigrationStatus === 'function'
  const hasRetry = typeof rpc?.retryMigration === 'function'
  const hasReport = typeof rpc?.exportMigrationReport === 'function' && typeof files?.save === 'function'
  const hasExport = typeof rpc?.exportPortableState === 'function' && typeof files?.save === 'function'
  const hasSelect = typeof files?.select === 'function' && typeof rpc?.restorePortableState === 'function'
  const hasRestore = typeof rpc?.restorePortableState === 'function'
  return Object.freeze({
    status: capability(hasStatus, 'Unavailable in this build: migration status service is not connected.'),
    retry: capability(hasRetry, 'Unavailable in this build: migration retry service is not connected.'),
    report: capability(hasReport, 'Unavailable in this build: report service or file export is not connected.'),
    export: capability(hasExport, 'Unavailable in this build: portable-state service or file export is not connected.'),
    select: capability(hasSelect, 'Unavailable in this build: file selection or portable-state restore service is not connected.'),
    restore: capability(hasRestore, 'Unavailable in this build: portable-state restore service is not connected.'),
  })
}

function responseFailure(result, fallback) {
  const code = cleanErrorText(result?.errorCode)
  const message = cleanErrorText(result?.error || result?.errorMessage)
  const detail = [code, message].filter(Boolean).join(' · ')
  return new Error(detail || fallback)
}

function requireMethod(rpc, method) {
  const fn = rpc?.[method]
  if (typeof fn !== 'function') throw new Error('Maintenance is unavailable in this build')
  return fn.bind(rpc)
}

function requireBytes(value, maxBytes, label) {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) throw new Error(`${label} is unavailable`)
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds the safe size limit`)
  return bytes
}

function safeDigest(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(value)) {
    throw new Error('Portable state checksum is unavailable')
  }
  return value
}

export function migrationPresentation(state) {
  return STATE_PRESENTATION[state] || Object.freeze({ label: 'Migration state unavailable', tone: 'neutral' })
}

export function migrationCounterRows(status) {
  return COUNTERS.map(([label, field]) => [label, boundedCount(status?.[field])])
}

export function canRetryMigration(status) {
  return status?.state === 'failed' && status?.retryable === true
}

export function createPortableEnvelope({ schemaVersion, manifestBytes: input, manifestDigest }) {
  const manifestBytes = requireBytes(input, MAX_PORTABLE_MANIFEST_BYTES, 'Portable state')
  const envelope = {
    kind: 'peartube-portable-state',
    envelopeVersion: 1,
    schemaVersion: boundedCount(schemaVersion),
    manifestDigest: safeDigest(manifestDigest),
    manifestBytes: bytesToBase64(manifestBytes),
  }
  return new TextEncoder().encode(`${JSON.stringify(envelope)}\n`)
}

export function parsePortableEnvelope(input) {
  const bytes = requireBytes(input, MAX_PORTABLE_FILE_BYTES, 'Portable state file')
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('Invalid portable state file')
  }
  try {
    if (!parsed || Array.isArray(parsed) || parsed.kind !== 'peartube-portable-state' || parsed.envelopeVersion !== 1) {
      throw new Error('invalid envelope')
    }
    if (!Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) throw new Error('invalid schema')
    return {
      schemaVersion: parsed.schemaVersion,
      manifestDigest: safeDigest(parsed.manifestDigest),
      manifestBytes: base64ToBytes(parsed.manifestBytes, MAX_PORTABLE_MANIFEST_BYTES),
    }
  } catch {
    throw new Error('Invalid portable state file')
  }
}

export function createMaintenanceActions({ rpc, files }) {
  return Object.freeze({
    async getMigrationStatus() {
      const result = await requireMethod(rpc, 'getMigrationStatus')({ migrationId: MIGRATION_ID })
      if (!result || result.success === false) throw responseFailure(result, 'Migration status could not be loaded')
      return result
    },

    async retryMigration(status) {
      if (!canRetryMigration(status)) throw new Error('This migration is not retryable')
      const result = await requireMethod(rpc, 'retryMigration')({ migrationId: MIGRATION_ID })
      if (!result || result.success === false) throw responseFailure(result, 'Migration retry failed')
      return result
    },

    async saveMigrationReport() {
      const result = await requireMethod(rpc, 'exportMigrationReport')({ migrationId: MIGRATION_ID })
      if (!result || result.success === false) throw responseFailure(result, 'Migration report export failed')
      const bytes = requireBytes(result.reportBytes, MAX_MIGRATION_REPORT_BYTES, 'Migration report')
      if (!files || typeof files.save !== 'function') throw new Error('File export is unavailable')
      return files.save({
        bytes,
        fileName: 'peartube-publication-v1-migration-report.json',
        mimeType: 'application/json',
      })
    },

    async savePortableState() {
      const result = await requireMethod(rpc, 'exportPortableState')()
      if (!result || result.success === false) throw responseFailure(result, 'Portable state export failed')
      const bytes = createPortableEnvelope({
        schemaVersion: result.schemaVersion,
        manifestBytes: result.manifestBytes,
        manifestDigest: result.manifestDigest,
      })
      if (!files || typeof files.save !== 'function') throw new Error('File export is unavailable')
      return files.save({ bytes, fileName: 'peartube-portable-state.json', mimeType: 'application/json' })
    },

    async selectPortableState() {
      if (!files || typeof files.select !== 'function') throw new Error('File selection is unavailable')
      const selected = await files.select({ maxBytes: MAX_PORTABLE_FILE_BYTES, mimeType: 'application/json' })
      if (!selected) return null
      return { fileName: selected.fileName, ...parsePortableEnvelope(selected.bytes) }
    },

    async restorePortableState(selection) {
      if (!selection) throw new Error('Select a portable state file first')
      const manifestBytes = requireBytes(selection.manifestBytes, MAX_PORTABLE_MANIFEST_BYTES, 'Portable state')
      const manifestDigest = safeDigest(selection.manifestDigest)
      const result = await requireMethod(rpc, 'restorePortableState')({ manifestBytes, manifestDigest })
      if (!result || result.success === false) throw responseFailure(result, 'Portable state restore failed')
      return result
    },
  })
}
