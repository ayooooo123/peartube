export const MAX_RENDERED_DIAGNOSTIC_ITEMS = 8

const STORAGE_CATEGORIES = Object.freeze([
  ['owned-originals', 'Owned originals', 'ownedOriginalBytes', 'protected', 'Your original uploads stay on this device.'],
  ['published-media', 'Published media', 'immutablePublicationBytes', 'protected', 'Immutable published media is retained.'],
  ['archive-pledges', 'Archive pledges', 'pledgedArchiveBytes', 'protected', 'Pledged archive bytes stay protected until the pledge ends.'],
  ['local-cache', 'Local cache', 'localCacheBytes', 'evictable', 'Safely evictable; playback may fetch these bytes again.'],
  ['thumbnails', 'Thumbnails', 'thumbnailBytes', 'evictable', 'Safely evictable; previews may be rebuilt or fetched again.'],
  ['indexes', 'Indexes', 'indexBytes', 'protected', 'Local indexes are retained for discovery and recovery.'],
  ['temporary-transfers', 'Temporary transfers', 'temporaryTransferBytes', 'evictable', 'Incomplete transfer data can be removed and downloaded again.'],
])

const OPERATOR_MODES = Object.freeze({
  'local-first': 'Local-first',
  altruistic: 'Altruistic archive',
  'friend-family': 'Friends & family',
  community: 'Community archive',
  paid: 'Paid operator',
})

function finiteNonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function formatStorageBytes(value) {
  const bytes = finiteNonNegative(value)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let unitIndex = -1
  do {
    amount /= 1024
    unitIndex += 1
  } while (amount >= 1024 && unitIndex < units.length - 1)
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unitIndex]}`
}

export function buildStorageCategoryRows(stats) {
  const source = stats ?? {}
  return STORAGE_CATEGORIES.map(([key, label, field, protection, detail]) => ({
    key,
    label,
    bytes: finiteNonNegative(source[field]),
    formattedBytes: formatStorageBytes(source[field]),
    protection,
    detail,
  }))
}

export function buildStoragePreviewView(preview) {
  if (!preview) return null
  const feasible = preview.success !== false && preview.feasible === true
  const consequences = Array.isArray(preview.consequences)
    ? preview.consequences.slice(0, MAX_RENDERED_DIAGNOSTIC_ITEMS).map(String)
    : []
  const affectedCategories = Array.isArray(preview.affectedCategories)
    ? preview.affectedCategories.slice(0, MAX_RENDERED_DIAGNOSTIC_ITEMS).map(String)
    : []

  return {
    feasible,
    summary: feasible
      ? `${formatStorageBytes(preview.requiredEvictionBytes)} can be safely evicted before the new limit is applied.`
      : `This limit cannot be applied: ${formatStorageBytes(preview.requiredEvictionBytes)} must be removed, but only ${formatStorageBytes(preview.evictableBytes)} is safely evictable.`,
    protectedCopy: `${formatStorageBytes(preview.protectedBytes)} remains protected, including owned originals, publications, and archive pledges.`,
    affectedSeedCopy: `${finiteNonNegative(preview.affectedSeedCount)} cached seed${preview.affectedSeedCount === 1 ? '' : 's'} may be removed.`,
    consequences,
    affectedCategories,
    hiddenConsequenceCount: Math.max(0, (Array.isArray(preview.consequences) ? preview.consequences.length : 0) - consequences.length),
    hiddenCategoryCount: Math.max(0, (Array.isArray(preview.affectedCategories) ? preview.affectedCategories.length : 0) - affectedCategories.length),
  }
}

export function buildStorageLimitConfirmationCopy(previewView) {
  if (!previewView) return 'Safe eviction could not be verified.'
  const categoryCopy = previewView.affectedCategories.length > 0
    ? `Affected categories: ${previewView.affectedCategories.join(', ')}${previewView.hiddenCategoryCount > 0 ? ` (+${previewView.hiddenCategoryCount} more affected categories)` : ''}.`
    : 'No storage categories are expected to be evicted.'
  const consequenceCopy = previewView.consequences.length > 0
    ? previewView.consequences.map((item) => `• ${item}`).join('\n')
    : 'No additional safe-eviction consequences were reported.'
  const hiddenCopy = previewView.hiddenConsequenceCount > 0
    ? `\n+${previewView.hiddenConsequenceCount} more consequences not rendered`
    : ''
  return `${previewView.summary}\n${previewView.protectedCopy}\n${previewView.affectedSeedCopy}\n${categoryCopy}\n\n${consequenceCopy}${hiddenCopy}`
}

export function getStorageLimitDecision({ currentMaxBytes, requestedMaxBytes, preview, confirmed = false }) {
  if (requestedMaxBytes >= currentMaxBytes) return { action: 'apply' }
  if (!preview) return { action: 'preview' }
  if (preview.success === false || preview.feasible !== true) return { action: 'blocked' }
  return { action: confirmed ? 'apply' : 'confirm' }
}

export async function runStorageLimitChange({
  currentMaxBytes,
  requestedMaxBytes,
  previewStorageLimit,
  confirm,
  apply,
}) {
  const initialDecision = getStorageLimitDecision({ currentMaxBytes, requestedMaxBytes })
  if (initialDecision.action === 'apply') {
    await apply()
    return { status: 'applied', preview: null, previewView: null }
  }

  const preview = await previewStorageLimit({ maxBytes: requestedMaxBytes })
  const previewView = buildStoragePreviewView(preview)
  const decision = getStorageLimitDecision({ currentMaxBytes, requestedMaxBytes, preview })
  if (decision.action === 'blocked' || !previewView) {
    return { status: 'blocked', preview, previewView }
  }

  const confirmed = await confirm(previewView)
  if (!confirmed) return { status: 'cancelled', preview, previewView }

  const confirmedDecision = getStorageLimitDecision({
    currentMaxBytes,
    requestedMaxBytes,
    preview,
    confirmed: true,
  })
  if (confirmedDecision.action !== 'apply') return { status: 'blocked', preview, previewView }

  await apply()
  return { status: 'applied', preview, previewView }
}

export function buildArchiveOperatorView(status) {
  const declaredMode = typeof status?.operatorMode === 'string' ? status.operatorMode : 'local-first'
  const mode = Object.prototype.hasOwnProperty.call(OPERATOR_MODES, declaredMode) ? declaredMode : 'local-first'
  const active = finiteNonNegative(status?.activePledgeCount)
  const healthy = finiteNonNegative(status?.healthyPledgeCount)
  const failed = finiteNonNegative(status?.failedPledgeCount)
  const challengeSuccesses = finiteNonNegative(status?.challengeSuccessCount)
  const challengeFailures = finiteNonNegative(status?.challengeFailureCount)
  const capacityRejections = finiteNonNegative(status?.capacityRejectionCount)
  const offloadRejections = finiteNonNegative(status?.offloadRejectionCount)
  const reportedFailureCodes = Array.isArray(status?.recentFailureCodes) ? status.recentFailureCodes.map(String) : []
  const rawFailureCodes = typeof status?.errorCode === 'string' && status.errorCode
    ? [status.errorCode, ...reportedFailureCodes.filter((code) => code !== status.errorCode)]
    : reportedFailureCodes
  const failureCodes = rawFailureCodes.slice(0, MAX_RENDERED_DIAGNOSTIC_ITEMS)
  const pledgeHealth = failed > 0 || healthy < active ? 'degraded' : active > 0 ? 'healthy' : 'idle'

  return {
    mode,
    modeLabel: OPERATOR_MODES[mode],
    trustCopy: mode === 'local-first'
      ? 'Untrusted local-first mode: this device keeps local data first and does not assume any relay is trusted.'
      : 'Remote operators remain untrusted; local copies and verified proofs stay authoritative.',
    pledgeHealth,
    pledgeCopy: active > 0
      ? `${healthy} of ${active} healthy${failed > 0 ? ` · ${failed} failed` : ''}`
      : 'No active archive pledges.',
    challengeCopy: `${challengeSuccesses} passed · ${challengeFailures} failed`,
    capacityCopy: `${formatStorageBytes(status?.capacityAvailableBytes)} available of ${formatStorageBytes(status?.capacityTotalBytes)} · ${capacityRejections} rejected`,
    offloadCopy: `${offloadRejections} rejected offload request${offloadRejections === 1 ? '' : 's'}`,
    failureCodes,
    hiddenFailureCount: Math.max(0, rawFailureCodes.length - failureCodes.length),
  }
}
