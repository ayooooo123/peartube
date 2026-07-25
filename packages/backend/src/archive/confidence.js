const MAX_EVIDENCE_ITEMS = 128

function boundedString(value, name, max = 128, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be a bounded string`)
  return value
}

function normalizeDeviceCopy(copy = {}) {
  return {
    deviceId: boundedString(copy.deviceId, 'deviceId', 128, true),
    physicalDeviceId: boundedString(copy.physicalDeviceId || copy.deviceId, 'physicalDeviceId', 128, true),
    sameDevice: copy.sameDevice === true,
    connected: copy.connected === true,
    fullCopy: copy.fullCopy === true,
    publisherControlled: copy.publisherControlled === true,
  }
}

function normalizeChallenge(challenge = {}) {
  return {
    archivistId: boundedString(challenge.archivistId, 'archivistId', 128, true),
    physicalDeviceId: boundedString(challenge.physicalDeviceId || challenge.deviceId || challenge.archivistId, 'physicalDeviceId', 128, true),
    sameDevice: challenge.sameDevice === true,
    connected: challenge.connected === true,
    recent: challenge.recent === true,
    passed: challenge.passed === true,
    intentional: challenge.intentional === true || challenge.operatorIntent === true,
  }
}

function boundedArray(value, normalize, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) throw new Error(`${name} must be a bounded array`)
  return value.map(normalize)
}

export function normalizeArchiveEvidence(input = {}) {
  const publisherDeviceCopies = boundedArray(
    input.publisherDeviceCopies || input.ownDeviceCopies,
    normalizeDeviceCopy,
    'publisherDeviceCopies'
  ).sort((left, right) => left.deviceId.localeCompare(right.deviceId))
  const archivistChallenges = boundedArray(input.archivistChallenges, normalizeChallenge, 'archivistChallenges')
    .sort((left, right) => left.archivistId.localeCompare(right.archivistId))
  const viewerFullCopies = Math.max(0, Math.min(MAX_EVIDENCE_ITEMS, Number(input.viewerFullCopies) || 0))
  return {
    publicationId: input.publicationId == null ? null : boundedString(input.publicationId, 'publicationId', 64, true),
    byteLength: Number.isSafeInteger(Number(input.byteLength)) && Number(input.byteLength) >= 0 ? Number(input.byteLength) : 0,
    localPhysicalDeviceId: boundedString(input.localPhysicalDeviceId, 'localPhysicalDeviceId', 128),
    activePlayback: input.activePlayback === true,
    policyVersion: Number.isSafeInteger(Number(input.policyVersion)) ? Number(input.policyVersion) : 1,
    publisherDeviceCopies,
    archivistChallenges,
    viewerFullCopies,
  }
}

export function assessArchiveConfidence(input = {}) {
  const evidence = normalizeArchiveEvidence(input)
  const localPhysicalDeviceId = evidence.localPhysicalDeviceId
  const seenPhysicalDevices = new Set(localPhysicalDeviceId ? [localPhysicalDeviceId] : [])
  const durablePublisherDevices = []
  for (const copy of evidence.publisherDeviceCopies) {
    if (copy.sameDevice || !copy.connected || !copy.fullCopy || !copy.publisherControlled) continue
    if (seenPhysicalDevices.has(copy.physicalDeviceId)) continue
    seenPhysicalDevices.add(copy.physicalDeviceId)
    durablePublisherDevices.push(copy.deviceId)
  }

  const durableArchivists = []
  for (const challenge of evidence.archivistChallenges) {
    if (challenge.sameDevice || !challenge.connected || !challenge.recent || !challenge.passed || !challenge.intentional) continue
    if (seenPhysicalDevices.has(challenge.physicalDeviceId)) continue
    seenPhysicalDevices.add(challenge.physicalDeviceId)
    durableArchivists.push(challenge.archivistId)
  }

  const eligible = !evidence.activePlayback && (durablePublisherDevices.length > 0 || durableArchivists.length > 0)
  const reasons = []
  if (durablePublisherDevices.length > 0) reasons.push('publisher-device-confirmed')
  if (durableArchivists.length > 0) reasons.push('intentional-archivist-challenge-confirmed')
  const limitations = ['remote-copies-can-disappear', 'source-offload-may-be-irrecoverable']
  if (evidence.activePlayback) limitations.unshift('playback-active')
  if (!eligible && durablePublisherDevices.length === 0) limitations.push('no-distinct-publisher-device-copy')
  if (!eligible && durableArchivists.length === 0) limitations.push('no-recent-intentional-archivist-proof')
  if (evidence.viewerFullCopies > 0) limitations.push('viewer-copies-are-transient-and-excluded')

  return {
    eligible,
    reasons,
    limitations,
    viewerFullCopies: evidence.viewerFullCopies,
    durablePublisherDevices,
    durableArchivists,
    evidence,
  }
}
