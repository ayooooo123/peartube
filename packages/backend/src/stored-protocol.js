import b4a from 'b4a'

export const STORED_PROTOCOL_ERROR_CODE = 'STORED_PROTOCOL_VERSION_UNSUPPORTED'
export const STORED_PROTOCOL_MARKER_FILENAME = 'stored-protocol.json'

// Protocols 5 and 6 add transport methods only; persisted storage remains
// byte-for-byte compatible. Explicit validators preserve the fail-closed
// migration chain without rewriting user data.
function validateProtocol4To5Transition(_context, step = {}) {
  if (step.fromVersion !== 4 || step.toVersion !== 5 || step.expectedVersion < 5) {
    throw new Error('invalid stored protocol 4 to 5 transition')
  }
}

function validateProtocol5To6Transition(_context, step = {}) {
  if (step.fromVersion !== 5 || step.toVersion !== 6 || step.expectedVersion < 6) {
    throw new Error('invalid stored protocol 5 to 6 transition')
  }
}

// Protocol 8 adds cover art to the content record and the catalog response.
// Both are appended, version-gated fields: records written before the bump
// decode unchanged and simply carry no artwork, so no user data is rewritten.
function validateProtocol7To8Transition(_context, step = {}) {
  if (step.fromVersion !== 7 || step.toVersion !== 8 || step.expectedVersion < 8) {
    throw new Error('invalid stored protocol 7 to 8 transition')
  }
}

export const DEFAULT_STORED_PROTOCOL_MIGRATIONS = Object.freeze({
  4: validateProtocol4To5Transition,
  5: validateProtocol5To6Transition,
  7: validateProtocol7To8Transition,
})

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

function resolveMigration(migrations, fromVersion) {
  if (migrations instanceof Map) return migrations.get(fromVersion)
  if (migrations && typeof migrations === 'object') return migrations[fromVersion]
  return undefined
}

function assertMigrationChain(storedVersion, expectedVersion, migrations) {
  for (let version = storedVersion; version < expectedVersion; version += 1) {
    if (typeof resolveMigration(migrations, version) !== 'function') {
      throw unsupported(storedVersion, expectedVersion, `missing-migration-${version}-${version + 1}`)
    }
  }
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
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw error
  }
}

/**
 * Validate persisted backend state before opening or exposing it. Older state is
 * accepted only when every one-version transition has an explicitly registered,
 * deterministic migration. The returned commit is deliberately separate from
 * migration so callers can persist readiness only after complete backend startup.
 */
export function prepareStoredProtocolState({
  storagePath,
  expectedVersion,
  migrations = null,
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

  if (storedVersion !== null && storedVersion > expectedVersion) {
    throw unsupported(storedVersion, expectedVersion, 'newer-state')
  }
  if (storedVersion !== null && storedVersion < expectedVersion) {
    assertMigrationChain(storedVersion, expectedVersion, migrations)
  }

  const status = storedVersion === null
    ? 'uninitialized'
    : storedVersion === expectedVersion
      ? 'compatible'
      : 'migration-required'
  let migrationComplete = status !== 'migration-required'
  let migrationPromise = null

  async function migrate(context) {
    if (migrationComplete) return
    if (migrationPromise) return migrationPromise

    migrationPromise = (async () => {
      for (let fromVersion = storedVersion; fromVersion < expectedVersion; fromVersion += 1) {
        const migration = resolveMigration(migrations, fromVersion)
        await migration(context, Object.freeze({
          fromVersion,
          toVersion: fromVersion + 1,
          expectedVersion,
        }))
      }
      migrationComplete = true
    })()

    try {
      await migrationPromise
    } finally {
      migrationPromise = null
    }
  }

  function commit() {
    if (!migrationComplete) throw new Error('Stored protocol migration has not completed')
    if (storedVersion === expectedVersion) return false
    writeMarkerAtomically(markerPath, expectedVersion, fs)
    return true
  }

  return Object.freeze({
    status,
    storedVersion,
    expectedVersion,
    markerPath,
    migrate,
    commit,
  })
}
