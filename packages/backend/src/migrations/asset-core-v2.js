import { normalizeBytes } from '../publisher/canonical.js'

function isNonEmptyPath(value) {
  return typeof value === 'string' && value.length > 0
}

function isLegacyRange(input) {
  try {
    normalizeBytes(input?.key, 32, 'legacy core key')
  } catch {
    return false
  }
  const start = input?.start
  const end = input?.end
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start
}

export function classifyLegacyAssetReference(input = {}) {
  if (isNonEmptyPath(input.sourcePath) || isNonEmptyPath(input.localFilePath) || isLegacyRange(input)) {
    return 'reingest-required'
  }
  return 'quarantine'
}
