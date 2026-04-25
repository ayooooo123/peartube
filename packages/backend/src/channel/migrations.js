/**
 * Schema Migration Utilities
 *
 * Handles migration of operations from older schema versions to current version.
 */

const CURRENT_SCHEMA_VERSION = 1

/**
 * Migrate an operation from an older schema version to current version
 * @param {Object} op - Operation to migrate
 * @param {number} fromVersion - Source schema version
 * @param {number} toVersion - Target schema version
 * @returns {Object} - Migrated operation
 */
export function migrateOp(op, fromVersion, toVersion) {
  if (fromVersion >= toVersion) {
    return op // No migration needed
  }

  let migrated = { ...op }

  // Migration from version 0 to 1: Add schemaVersion field
  if (fromVersion < 1 && toVersion >= 1) {
    migrated.schemaVersion = 1
  }

  // Migration from version 1 to 2: Add logicalClock field (future)
  if (fromVersion < 2 && toVersion >= 2) {
    // Logical clock will be set by _applyOp if missing
    if (!migrated.logicalClock) {
      migrated.logicalClock = 0
    }
  }

  return migrated
}

/**
 * Get migration path between versions
 * @param {number} fromVersion
 * @param {number} toVersion
 * @returns {number[]} - Array of version steps to migrate through
 */
export function getMigrationPath(fromVersion, toVersion) {
  if (fromVersion >= toVersion) {
    return []
  }

  const path = []
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    path.push(v)
  }
  return path
}

/**
 * Apply all migrations in sequence
 * @param {Object} op - Operation to migrate
 * @param {number} fromVersion
 * @param {number} toVersion
 * @returns {Object} - Fully migrated operation
 */
export function applyMigrations(op, fromVersion, toVersion) {
  const path = getMigrationPath(fromVersion, toVersion)
  let migrated = op

  for (const targetVersion of path) {
    migrated = migrateOp(migrated, fromVersion, targetVersion)
    fromVersion = targetVersion
  }

  return migrated
}
