import { base64ToBytes, bytesToBase64 } from '../../lib/maintenance-file-transfer.mjs'

export const MAX_PORTABLE_MANIFEST_BYTES = 1_048_576
export const MAX_PORTABLE_FILE_BYTES = 1_500_000


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


function capability(available, reason) {
  return Object.freeze({ available, reason: available ? '' : reason })
}

export function maintenanceCapabilities({ rpc, files } = {}) {
  const hasExport = typeof rpc?.exportPortableState === 'function' && typeof files?.save === 'function'
  const hasSelect = typeof files?.select === 'function' && typeof rpc?.restorePortableState === 'function'
  const hasRestore = typeof rpc?.restorePortableState === 'function'
  return Object.freeze({
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
