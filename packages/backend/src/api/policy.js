export const NETWORK_POLICY_VERSION = 2

export const DEFAULT_NETWORK_POLICY = Object.freeze({
  policyVersion: NETWORK_POLICY_VERSION,
  consentVersion: 1,
  migrationRequired: false,
  effectiveRole: 'watch-only',
  permissions: Object.freeze({ contribute: false, archive: false }),
  contributeWatchedMedia: false,
  archiveEnabled: false,
  contributionBudgetBytes: 0,
  archiveBudgetBytes: 0,
  uploadPermission: 'manual',
  meteredNetwork: 'pause-network',
  backgroundMode: 'local-only',
  diskCeilingBytes: 5 * 1024 * 1024 * 1024,
  uploadCeilingBytes: 0,
  retentionMode: 'none',
  followedPublishers: [],
  followedIndexes: [],
  trustedModerationFeeds: [],
  aiAnalysis: 'disabled',
})

const ENUMS = {
  uploadPermission: new Set(['disabled', 'manual', 'enabled']),
  meteredNetwork: new Set(['pause-network', 'local-only', 'allow']),
  backgroundMode: new Set(['pause-network', 'local-only', 'allow']),
  retentionMode: new Set(['none', 'local-pin', 'archive-pledges']),
  aiAnalysis: new Set(['disabled', 'local-only', 'enabled']),
}

function effectiveRole(contribute, archive) {
  if (archive) return 'archive-enabled'
  if (contribute) return 'contributor'
  return 'watch-only'
}

export function evaluateNetworkRole(policy = {}) {
  const current = policy.policyVersion === NETWORK_POLICY_VERSION &&
    policy.migrationRequired !== true
  const contribute = current && policy.contributeWatchedMedia === true
  const archive = current && policy.archiveEnabled === true
  const contributionBudgetBytes = boundedBytes(policy.contributionBudgetBytes ?? 0, 'contributionBudgetBytes')
  const archiveBudgetBytes = boundedBytes(policy.archiveBudgetBytes ?? 0, 'archiveBudgetBytes')
  return Object.freeze({
    policyVersion: NETWORK_POLICY_VERSION,
    consentVersion: boundedBytes(policy.consentVersion ?? 0, 'consentVersion'),
    migrationRequired: !current,
    effectiveRole: effectiveRole(contribute, archive),
    permissions: Object.freeze({ contribute, archive }),
    contributionBudgetBytes,
    archiveBudgetBytes,
  })
}

const NETWORK_POLICY_KEY = 'network-policy:v1'
const UNSUPPORTED_RUNTIME_VALUES = Object.freeze({
  followedPublishers: 'publisher descriptors are required before scoped discovery can follow a publisher',
  followedIndexes: 'no scoped index-feed synchronizer is available',
  trustedModerationFeeds: 'no moderation-feed transport is available',
  aiAnalysis: 'no bounded AI analysis worker is available',
  retentionMode: 'local-pin retention has no publication pinning consumer',
})

function boundedList(value, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${name} must be bounded list`)
  return value.map(item => String(item)).filter(Boolean)
}

function boundedBytes(value, name) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be nonnegative safe integer`)
  return next
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function decodeBoundedList(value, name) {
  let parsed
  try {
    parsed = JSON.parse(String(value))
  } catch {
    throw new Error(`${name} must be valid JSON`)
  }
  return boundedList(parsed, name)
}

function decodeNetworkPolicyPatch(input = {}) {
  const patch = { ...input }
  for (const key of Object.keys(ENUMS)) {
    if (input[key] === null) delete patch[key]
  }
  const listFields = [
    ['followedPublishersJson', 'followedPublishers'],
    ['followedIndexesJson', 'followedIndexes'],
    ['trustedModerationFeedsJson', 'trustedModerationFeeds'],
  ]
  for (const [wireName, policyName] of listFields) {
    if (input[wireName] != null) patch[policyName] = decodeBoundedList(input[wireName], policyName)
    delete patch[wireName]
  }
  for (const key of [
    'diskCeilingBytes',
    'uploadCeilingBytes',
    'contributionBudgetBytes',
    'archiveBudgetBytes',
  ]) {
    const flag = `${key}Present`
    if (hasOwn(input, flag) && input[flag] !== true) delete patch[key]
    else if (input[flag] === true && !hasOwn(input, key)) patch[key] = 0
    delete patch[flag]
  }
  return patch
}

function networkPolicyWireFields(policy) {
  return {
    policyVersion: policy.policyVersion,
    consentVersion: policy.consentVersion,
    migrationRequired: policy.migrationRequired,
    effectiveRole: policy.effectiveRole,
    permissions: { ...policy.permissions },
    contributeWatchedMedia: policy.contributeWatchedMedia,
    archiveEnabled: policy.archiveEnabled,
    contributionBudgetBytes: policy.contributionBudgetBytes,
    archiveBudgetBytes: policy.archiveBudgetBytes,
    uploadPermission: policy.uploadPermission,
    meteredNetwork: policy.meteredNetwork,
    backgroundMode: policy.backgroundMode,
    diskCeilingBytes: policy.diskCeilingBytes,
    uploadCeilingBytes: policy.uploadCeilingBytes,
    retentionMode: policy.retentionMode,
    followedPublishersJson: JSON.stringify(policy.followedPublishers),
    followedIndexesJson: JSON.stringify(policy.followedIndexes),
    trustedModerationFeedsJson: JSON.stringify(policy.trustedModerationFeeds),
    aiAnalysis: policy.aiAnalysis,
  }
}

export function normalizeNetworkPolicy(input = {}, base = DEFAULT_NETWORK_POLICY) {
  const policy = { ...base }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (input[key] !== undefined) {
      if (!allowed.has(input[key])) throw new Error(`invalid ${key}`)
      policy[key] = input[key]
    }
  }
  for (const key of [
    'diskCeilingBytes',
    'uploadCeilingBytes',
    'contributionBudgetBytes',
    'archiveBudgetBytes',
  ]) {
    if (input[key] !== undefined) policy[key] = boundedBytes(input[key], key)
  }
  for (const key of ['followedPublishers', 'followedIndexes', 'trustedModerationFeeds']) {
    if (input[key] !== undefined) policy[key] = boundedList(input[key], key)
  }
  policy.policyVersion = NETWORK_POLICY_VERSION
  policy.consentVersion = boundedBytes(input.consentVersion ?? policy.consentVersion ?? 0, 'consentVersion')
  policy.migrationRequired = hasOwn(input, 'migrationRequired')
    ? input.migrationRequired === true
    : policy.migrationRequired === true
  policy.contributeWatchedMedia = hasOwn(input, 'contributeWatchedMedia')
    ? input.contributeWatchedMedia === true
    : policy.contributeWatchedMedia === true
  policy.archiveEnabled = hasOwn(input, 'archiveEnabled')
    ? input.archiveEnabled === true
    : policy.archiveEnabled === true
  const role = evaluateNetworkRole(policy)
  policy.effectiveRole = role.effectiveRole
  policy.permissions = role.permissions
  return policy
}

function storedValue(value) {
  if (value && typeof value === 'object' && hasOwn(value, 'value')) return value.value
  return value
}

async function readPolicyStore(store) {
  if (typeof store?.get !== 'function') return null
  return storedValue(await store.get(NETWORK_POLICY_KEY))
}

async function writePolicyStore(store, policy) {
  if (typeof store?.put === 'function') await store.put(NETWORK_POLICY_KEY, policy)
  else if (typeof store?.set === 'function') await store.set(NETWORK_POLICY_KEY, policy)
}

export async function loadNetworkPolicy({ store = new Map(), defaults = DEFAULT_NETWORK_POLICY } = {}) {
  const base = normalizeNetworkPolicy(defaults, DEFAULT_NETWORK_POLICY)
  const stored = await readPolicyStore(store)
  if (stored == null) return base
  if (stored.policyVersion !== NETWORK_POLICY_VERSION) {
    return normalizeNetworkPolicy({
      ...stored,
      policyVersion: NETWORK_POLICY_VERSION,
      consentVersion: 0,
      migrationRequired: true,
      contributeWatchedMedia: false,
      archiveEnabled: false,
      contributionBudgetBytes: 0,
      archiveBudgetBytes: 0,
    }, base)
  }
  return normalizeNetworkPolicy(stored, base)
}

function unsupportedPolicyError(field, detail) {
  const error = new Error(`${field} is unsupported: ${detail}`)
  error.code = 'UNSUPPORTED_POLICY_FIELD'
  error.field = field
  return error
}

export function assertNetworkPolicyRuntimeSupported(policy) {
  for (const field of ['followedPublishers', 'followedIndexes', 'trustedModerationFeeds']) {
    if (policy[field].length > 0) throw unsupportedPolicyError(field, UNSUPPORTED_RUNTIME_VALUES[field])
  }
  if (policy.aiAnalysis !== 'disabled') {
    throw unsupportedPolicyError('aiAnalysis', UNSUPPORTED_RUNTIME_VALUES.aiAnalysis)
  }
  if (policy.retentionMode === 'local-pin') {
    throw unsupportedPolicyError('retentionMode', UNSUPPORTED_RUNTIME_VALUES.retentionMode)
  }
}

export function resolveNetworkPolicyForEnvironment(policy, environment = {}) {
  const normalized = normalizeNetworkPolicy(policy, DEFAULT_NETWORK_POLICY)
  const role = evaluateNetworkRole(normalized)
  const constrainedModes = []
  if (environment.metered) constrainedModes.push(normalized.meteredNetwork)
  if (environment.background) constrainedModes.push(normalized.backgroundMode)
  const networkMode = constrainedModes.includes('pause-network')
    ? 'pause-network'
    : (constrainedModes.includes('local-only') ? 'local-only' : 'allow')
  const networkEnabled = networkMode === 'allow'
  const publicServingAllowed = networkEnabled &&
    (role.permissions.contribute || role.permissions.archive)
  return {
    ...normalized,
    ...role,
    networkMode,
    networkEnabled,
    publicServingAllowed,
    uploadAllowed: publicServingAllowed,
  }
}

export function createNetworkPolicyRuntime({
  initialPolicy = DEFAULT_NETWORK_POLICY,
  scopedNetwork = null,
  seedingManager = null,
  archiveNetwork = null,
  metered = false,
  background = false,
  suspendTransport = null,
  resumeTransport = null,
} = {}) {
  let policy = normalizeNetworkPolicy(initialPolicy, DEFAULT_NETWORK_POLICY)
  const environment = { metered: metered === true, background: background === true }
  let transportSuspended = false
  let started = false
  let transition = Promise.resolve()

  const runTransition = operation => {
    const next = transition.then(operation, operation)
    transition = next.catch(() => {})
    return next
  }

  const normalizeSupported = candidate => {
    const normalized = normalizeNetworkPolicy(candidate, DEFAULT_NETWORK_POLICY)
    assertNetworkPolicyRuntimeSupported(normalized)
    if (normalized.archiveEnabled && !archiveNetwork?.setParticipation) {
      throw unsupportedPolicyError('archiveEnabled', 'archive participation is unavailable on this runtime')
    }
    return normalized
  }
  policy = normalizeSupported(policy)

  const applyNow = async nextInput => {
    const nextPolicy = normalizeSupported(nextInput)
    const effective = resolveNetworkPolicyForEnvironment(nextPolicy, environment)

    await scopedNetwork?.applyNetworkPolicy?.(effective)
    await seedingManager?.applyNetworkPolicy?.({
      contributeWatchedMedia: effective.permissions.contribute,
      archiveEnabled: effective.permissions.archive,
      contributionBudgetBytes: effective.contributionBudgetBytes,
      archiveBudgetBytes: effective.archiveBudgetBytes,
      migrationRequired: effective.migrationRequired,
    })
    const archiveResult = await archiveNetwork?.setParticipation?.({
      enabled: effective.permissions.archive,
      capacityBytes: effective.archiveBudgetBytes,
    })
    if (archiveResult?.errorCode) {
      const error = new Error(archiveResult.errorCode)
      error.code = archiveResult.errorCode
      throw error
    }

    if (effective.networkMode === 'pause-network' && !transportSuspended) {
      await suspendTransport?.()
      transportSuspended = true
    } else if (effective.networkMode !== 'pause-network' && transportSuspended) {
      await resumeTransport?.()
      transportSuspended = false
    }
    policy = nextPolicy
    return effective
  }

  return {
    assertSupported(candidate) {
      return normalizeSupported(candidate)
    },
    start(candidate = policy) {
      if (started) return transition.then(() => resolveNetworkPolicyForEnvironment(policy, environment))
      started = true
      return runTransition(() => applyNow(candidate))
    },
    apply(candidate) {
      return runTransition(() => applyNow(candidate))
    },
    setEnvironment(next = {}) {
      return runTransition(async () => {
        const shouldRefreshForegroundTransport =
          hasOwn(next, 'background') &&
          next.background !== true &&
          !transportSuspended
        if (hasOwn(next, 'metered')) environment.metered = next.metered === true
        if (hasOwn(next, 'background')) environment.background = next.background === true
        const effective = await applyNow(policy)
        if (shouldRefreshForegroundTransport && effective.networkMode !== 'pause-network') {
          await resumeTransport?.()
        }
        return effective
      })
    },
    getPolicy() {
      return policy
    },
    getEnvironment() {
      return { ...environment, transportSuspended }
    },
  }
}


export function createPolicyApi({
  store = new Map(),
  initialPolicy,
  onPolicyChange = null,
  validatePolicy = null,
} = {}) {
  let current = initialPolicy === undefined
    ? null
    : normalizeNetworkPolicy(initialPolicy, DEFAULT_NETWORK_POLICY)
  const ready = current
    ? Promise.resolve(current)
    : loadNetworkPolicy({ store }).then(policy => {
        current = policy
        return policy
      })
  let writes = Promise.resolve()

  const enqueueWrite = operation => {
    const next = writes.then(operation, operation)
    writes = next.catch(() => {})
    return next
  }

  return {
    ready,
    async getNetworkPolicy() {
      await ready
      const policy = current
      return { success: true, policy, ...networkPolicyWireFields(policy) }
    },
    async setNetworkPolicy(input = {}) {
      await ready
      return enqueueWrite(async () => {
        const previous = current
        try {
          const policy = normalizeNetworkPolicy(decodeNetworkPolicyPatch(input), previous)
          await validatePolicy?.(policy)
          await writePolicyStore(store, policy)
          try {
            await onPolicyChange?.(policy)
          } catch (error) {
            await writePolicyStore(store, previous)
            await onPolicyChange?.(previous).catch(() => {})
            throw error
          }
          current = policy
          return { success: true, policy }
        } catch (err) {
          return {
            success: false,
            errorCode: err?.code || 'INVALID_POLICY',
            unsupportedField: err?.field,
            error: err?.message || String(err),
          }
        }
      })
    },
  }
}
