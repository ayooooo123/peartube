function isNonEmptyPath(value) {
  return typeof value === 'string' && value.length > 0
}

function isLegacyRange(input) {
  const start = Number(input?.start)
  const end = Number(input?.end)
  return input?.key != null &&
    Number.isSafeInteger(start) &&
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
