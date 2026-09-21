import b4a from 'b4a'

export const STORED_PROTOCOL_ERROR_CODE = 'STORED_PROTOCOL_VERSION_UNSUPPORTED'
export const STORED_PROTOCOL_MARKER_FILENAME = 'stored-protocol.json'
// 11: public projection format tokens became 'summary'/'detailed'. There is no
// migration, so a store written at 10 is refused rather than read as unset.
export const STORAGE_FORMAT_VERSION = 11

const MAX_MARKER_BYTES = 128
const MAX_PROTOCOL_VERSION = 0x7fffffff

function isProtocolVersion(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PROTOCOL_VERSION
}

function unsupported(storedVersion, expectedVersion, reason) {
  const error = new Error(STORED_PROTOCOL_ERROR_CODE)
  error.code = STORED_PROTOCOL_ERROR_CODE
  error.storedVersion = isProtocolVersion(storedVersion) ? storedVersion : null
  error.expectedVersion = expectedVersion
  error.details = Object.freeze({
    storedVersion: error.storedVersion,
    expectedVersion,
  })
  if (reason) error.reason = reason
  return error
}

function readMarker(markerPath, expectedVersion, fs) {
  if (!fs.existsSync(markerPath)) {
    return { status: 'uninitialized', storedVersion: null }
  }
  try {
    if (fs.statSync(markerPath).size > MAX_MARKER_BYTES) {
      throw unsupported(null, expectedVersion, 'marker-size-invalid')
    }
  } catch (error) {
    if (error?.code === STORED_PROTOCOL_ERROR_CODE) throw error
    throw unsupported(null, expectedVersion, 'marker-unreadable')
  }

  let serialized
  try {
    serialized = fs.readFileSync(markerPath, 'utf8')
  } catch {
    throw unsupported(null, expectedVersion, 'marker-unreadable')
  }

  if (typeof serialized !== 'string' || b4a.byteLength(serialized) > MAX_MARKER_BYTES) {
    throw unsupported(null, expectedVersion, 'marker-size-invalid')
  }

  let marker
  try {
    marker = JSON.parse(serialized)
  } catch {
    throw unsupported(null, expectedVersion, 'marker-json-invalid')
  }

  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 1 ||
    !isProtocolVersion(marker.protocolVersion)
  ) {
    throw unsupported(null, expectedVersion, 'marker-shape-invalid')
  }

  return {
    status: marker.protocolVersion === expectedVersion ? 'compatible' : 'versioned',
    storedVersion: marker.protocolVersion,
  }
}

function writeMarkerAtomically(markerPath, expectedVersion, fs) {
  const serialized = JSON.stringify({ protocolVersion: expectedVersion })
  if (b4a.byteLength(serialized) > MAX_MARKER_BYTES) {
    throw new RangeError('Stored protocol marker exceeds its bounded encoding')
  }

  const temporaryPath = `${markerPath}.tmp`
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryPath, markerPath)
  } catch (error) {
    try { fs.unlinkSync(temporaryPath) } catch {
      // best-effort cleanup: the write failure is the error to surface
    }
    throw error
  }
}

/**
 * Validate persisted backend state before opening or exposing it. State written
 * by any other protocol version is refused outright. The returned commit is
 * deliberately separate from validation so callers persist readiness only after
 * complete backend startup.
 */
export function prepareStoredProtocolState({
  storagePath,
  expectedVersion = STORAGE_FORMAT_VERSION,
  fs,
  path,
} = {}) {
  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    throw new TypeError('Stored protocol validation requires a storagePath')
  }
  if (!isProtocolVersion(expectedVersion)) {
    throw new TypeError('Stored protocol validation requires a bounded positive expectedVersion')
  }
  if (!fs || !path || typeof path.join !== 'function') {
    throw new TypeError('Stored protocol validation requires filesystem and path modules')
  }

  const markerPath = path.join(storagePath, STORED_PROTOCOL_MARKER_FILENAME)
  const marker = readMarker(markerPath, expectedVersion, fs)
  const storedVersion = marker.storedVersion

  if (storedVersion !== null && storedVersion !== expectedVersion) {
    throw unsupported(
      storedVersion,
      expectedVersion,
      storedVersion > expectedVersion ? 'newer-state' : 'retired-state',
    )
  }

  return Object.freeze({
    status: storedVersion === null ? 'uninitialized' : 'compatible',
    storedVersion,
    expectedVersion,
    markerPath,
    commit() {
      if (storedVersion === expectedVersion) return false
      writeMarkerAtomically(markerPath, expectedVersion, fs)
      return true
    },
  })
}
