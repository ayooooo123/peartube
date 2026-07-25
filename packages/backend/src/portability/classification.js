export const PORTABILITY_CLASSIFICATIONS = Object.freeze({
  PORTABLE: 'portable',
  DEVICE_LOCAL: 'device-local',
  NEVER_EXPORTED: 'never-exported',
  UNKNOWN: 'unknown'
})

const NEVER_EXPORTED_PREFIXES = Object.freeze([
  'publisher.rootSecretKey',
  'publisher.recoverySecretKeys',
  'publisher.signingIntent',
  'device.privateKey',
  'device.writerSecretKey',
  'archive.privateKey',
  'vault',
  'credentials'
])

const DEVICE_LOCAL_PREFIXES = Object.freeze([
  'cache',
  'downloads.partialRanges',
  'downloads.temporaryFiles',
  'playback.windowCache',
  'storage.corestore',
  'storage.localIndexes'
])

const PORTABLE_PREFIXES = Object.freeze([
  'publisher.publicRootHistory',
  'publisher.recoveryMetadata',
  'preferences.graph',
  'preferences.index',
  'subscriptions.publisherFeeds',
  'subscriptions.indexFeeds',
  'subscriptions.moderationFeeds',
  'archive.evidence',
  'offload.evidence',
  'policy'
])

function matchesPrefix (path, prefix) {
  return path === prefix || path.startsWith(`${prefix}.`)
}

export function classifyPortability (path) {
  if (typeof path !== 'string' || path.length === 0) return PORTABILITY_CLASSIFICATIONS.UNKNOWN
  if (NEVER_EXPORTED_PREFIXES.some(prefix => matchesPrefix(path, prefix))) return PORTABILITY_CLASSIFICATIONS.NEVER_EXPORTED
  if (DEVICE_LOCAL_PREFIXES.some(prefix => matchesPrefix(path, prefix))) return PORTABILITY_CLASSIFICATIONS.DEVICE_LOCAL
  if (PORTABLE_PREFIXES.some(prefix => matchesPrefix(path, prefix))) return PORTABILITY_CLASSIFICATIONS.PORTABLE
  return PORTABILITY_CLASSIFICATIONS.UNKNOWN
}

export const PORTABILITY_CLASSIFICATION = Object.freeze({
  portable: PORTABLE_PREFIXES,
  deviceLocal: DEVICE_LOCAL_PREFIXES,
  neverExported: NEVER_EXPORTED_PREFIXES
})
