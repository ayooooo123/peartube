import {
  DEFAULT_PARTICIPATION_MODE,
  PARTICIPATION_LIMITS,
  PARTICIPATION_MODES,
} from '../playback/resource-policy.js'

const DEFAULT_PARTICIPATION_LIMITS = PARTICIPATION_LIMITS[DEFAULT_PARTICIPATION_MODE]

export const NETWORK_POLICY_VERSION = 2

export const DEFAULT_NETWORK_POLICY = Object.freeze({
  policyVersion: NETWORK_POLICY_VERSION,
  consentVersion: 0,
  migrationRequired: true,
  effectiveRole: 'watch-only',
  permissions: Object.freeze({ contribute: false, archive: false }),
  contributeWatchedMedia: false,
  archiveEnabled: false,
  contributionBudgetBytes: 0,
  archiveBudgetBytes: 0,
  // A peer that holds content serves it: that is the whole arrangement, and a
  // network where every viewer takes without giving has one source for
  // everything. 'manual' left uploadAllowed false, so a device answered every
  // block request with "unavailable" no matter how much of the title it held.
  // Metered links are still protected by meteredNetwork below, an explicit
  // contribution or archive role is still required, and an operator can narrow
  // any of this at runtime.
  uploadPermission: 'enabled',
  meteredNetwork: 'pause-network',
  // Background work answers to the participation decision: OS permission, a
  // nominal or fair thermal state, power, disk, and the mode's session and daily
  // budgets all gate it, and a device that may not run work suspends. A shipped
  // 'local-only' took the whole swarm down the instant the app was backgrounded,
  // which made Balanced's opportunistic background contribution unreachable on
  // every fresh install. The enum stays as an operator narrowing.
  backgroundMode: 'allow',
  // Recorded when an operator narrows it, so a later change of this default can
  // never overwrite the choice. See applyOperatorOverrides.
  backgroundModeExplicit: false,
  // A fresh install runs the Balanced preset, so the shipped ceilings are the
  // Balanced ceilings. One module decides what Balanced means; the policy only
  // records the choice.
  participationMode: DEFAULT_PARTICIPATION_MODE,
  diskCeilingBytes: DEFAULT_PARTICIPATION_LIMITS.cacheCeilingBytes,
  uploadCeilingBytes: DEFAULT_PARTICIPATION_LIMITS.uploadCeilingBytesPer24h,
  // A ceiling is explicit when the viewer typed it, and that fact is recorded
  // here rather than inferred from the value later. See applyParticipationCeilings.
  diskCeilingExplicit: false,
  uploadCeilingExplicit: false,
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
  participationMode: new Set(PARTICIPATION_MODES),
}

// A participation mode is a preset; a ceiling the viewer typed is a decision.
// Explicitness cannot be recovered from the value: a deliberate 4 GiB cache is
// byte-for-byte the Data Saver preset, so a mode round trip would launder the
// choice back into a preset. The flag stored beside each ceiling is the record.
const CEILING_FIELDS = Object.freeze([
  Object.freeze({ field: 'diskCeilingBytes', flag: 'diskCeilingExplicit', limit: 'cacheCeilingBytes' }),
  Object.freeze({ field: 'uploadCeilingBytes', flag: 'uploadCeilingExplicit', limit: 'uploadCeilingBytesPer24h' }),
])

function participationLimitsFor(mode) {
  return PARTICIPATION_LIMITS[mode] || DEFAULT_PARTICIPATION_LIMITS
}

function effectiveRole(contribute, archive) {
  if (archive) return 'archive-enabled'
  if (contribute) return 'contributor'
  return 'watch-only'
}

export function evaluateNetworkRole(policy = {}) {
  const current = policy.policyVersion === NETWORK_POLICY_VERSION &&
    policy.consentVersion === 1 &&
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
  aiAnalysis: 'no bounded AI analysis worker is available',
  retentionMode: 'local-pin retention has no publication pinning consumer',
})

function boundedTransportIdList(value, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${name} must be bounded list`)
  return Array.from(new Set(value.map(item => {
    if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) {
      throw new Error(`${name} entries must be canonical 32-byte public-key hex`)
    }
    return item
  }))).sort()
}

function boundedBytes(value, name) {
  const next = Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be nonnegative safe integer`)
  return next
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isCompleteExplicitPolicySnapshot(value) {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.policyVersion === NETWORK_POLICY_VERSION &&
    value.consentVersion === 1 &&
    value.migrationRequired === false &&
    typeof value.contributeWatchedMedia === 'boolean' &&
    typeof value.archiveEnabled === 'boolean' &&
    hasOwn(value, 'contributionBudgetBytes') &&
    hasOwn(value, 'archiveBudgetBytes') &&
    hasOwn(value, 'uploadPermission') &&
    hasOwn(value, 'uploadCeilingBytes')
}

function normalizePolicySnapshot(input = {}, base = DEFAULT_NETWORK_POLICY) {
  const normalized = normalizeNetworkPolicy(input, base)
  if (isCompleteExplicitPolicySnapshot(input)) return normalized
  return normalizeNetworkPolicy({
    ...normalized,
    consentVersion: 0,
    migrationRequired: true,
    contributeWatchedMedia: false,
    archiveEnabled: false,
  }, DEFAULT_NETWORK_POLICY)
}

function decodeBoundedList(value, name) {
  let parsed
  try {
    parsed = JSON.parse(String(value))
  } catch {
    throw new Error(`${name} must be valid JSON`)
  }
  return boundedTransportIdList(parsed, name)
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
    participationMode: policy.participationMode,
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
  for (const { flag } of CEILING_FIELDS) {
    if (input[flag] !== undefined) policy[flag] = input[flag] === true
  }
  if (input.backgroundModeExplicit !== undefined) {
    policy.backgroundModeExplicit = input.backgroundModeExplicit === true
  }
  for (const key of ['followedPublishers', 'followedIndexes', 'trustedModerationFeeds']) {
    if (input[key] !== undefined) policy[key] = boundedTransportIdList(input[key], key)
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
  policy.migrationRequired = role.migrationRequired
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

// The first release shipped 'manual'/0 as the default, and a stored policy
// outranks any later default - so a device that merely booted once would refuse
// to serve a byte forever, with nothing in the UI to explain why. A policy that
// still carries the exact retired pair was never a choice anyone made, so it
// migrates. An operator who deliberately picked 'manual' has a ceiling they set
// or a 'disabled' permission, and either one is left alone.
const RETIRED_UPLOAD_DEFAULT = Object.freeze({ uploadPermission: 'manual', uploadCeilingBytes: 0 })

// Participation modes arrived after the ceilings did, and the releases before
// them shipped a 5 GiB cache with an unbounded upload ceiling. A stored policy
// with no participation mode is from one of those releases, so a ceiling that
// still matches the retired default adopts the preset and anything else is a
// number someone set and is left exactly where it is.
const RETIRED_CEILING_DEFAULTS = Object.freeze({
  diskCeilingBytes: 5 * 1024 * 1024 * 1024,
  uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
})

// Every release before this one shipped 'local-only', and that value alone
// cannot say whether an operator chose it or merely inherited it. A policy
// stored before backgroundModeExplicit existed adopts the new default; from here
// on the choice is recorded when it is made, so this migration runs exactly once
// per device and never second-guesses an operator again.
const RETIRED_BACKGROUND_MODE_DEFAULT = 'local-only'

function migrateStoredNetworkPolicy(stored, base) {
  const next = { ...stored }
  if (stored.uploadPermission === RETIRED_UPLOAD_DEFAULT.uploadPermission &&
    Number(stored.uploadCeilingBytes ?? 0) === RETIRED_UPLOAD_DEFAULT.uploadCeilingBytes) {
    next.uploadPermission = base.uploadPermission
    next.uploadCeilingBytes = base.uploadCeilingBytes
  }
  if (stored.participationMode === undefined) {
    next.participationMode = base.participationMode
    if (Number(stored.diskCeilingBytes) === RETIRED_CEILING_DEFAULTS.diskCeilingBytes) {
      next.diskCeilingBytes = base.diskCeilingBytes
    }
    if (Number(next.uploadCeilingBytes) === RETIRED_CEILING_DEFAULTS.uploadCeilingBytes) {
      next.uploadCeilingBytes = base.uploadCeilingBytes
    }
  }
  // The explicit-ceiling flags arrived after the ceilings did. In a policy
  // stored before them, a ceiling that does not match its mode's preset is the
  // only surviving evidence that someone chose it, so it seeds the flag once
  // and every later mode change reads the flag instead of guessing again.
  const limits = participationLimitsFor(next.participationMode)
  for (const { field, flag, limit } of CEILING_FIELDS) {
    if (next[flag] === undefined) {
      next[flag] = Number(next[field] ?? base[field]) !== limits[limit]
    }
  }
  if (next.backgroundModeExplicit === undefined) {
    next.backgroundModeExplicit = stored.backgroundMode !== undefined &&
      stored.backgroundMode !== RETIRED_BACKGROUND_MODE_DEFAULT
    if (!next.backgroundModeExplicit) next.backgroundMode = base.backgroundMode
  }
  return next
}

// Switching modes moves every ceiling that is still following its preset and
// leaves alone every ceiling the viewer set, because Help More must not widen a
// deliberate cap and Data Saver must not shrink one. A ceiling becomes explicit
// when a request carries a new value without also switching the mode: the app
// resubmits the whole policy on every save, so the ceilings inside a mode
// switch are the presets it was already showing, not edits. Typing the new
// mode's own preset back into the field hands the ceiling back to the mode.
function applyParticipationCeilings(policy, base, patch = {}) {
  const modeChanged = policy.participationMode !== base.participationMode
  const limits = participationLimitsFor(policy.participationMode)
  const next = { ...policy }
  for (const { field, flag, limit } of CEILING_FIELDS) {
    const preset = limits[limit]
    const carried = patch[field] !== undefined
    let explicit = base[flag] === true
    if (carried && !modeChanged && policy[field] !== base[field]) explicit = true
    if (carried && policy[field] === preset) explicit = false
    if (modeChanged && !explicit) next[field] = preset
    next[flag] = explicit
  }
  return next
}

// The operator overrides are choices, not presets, so a choice is recorded the
// same way a ceiling is. Setting the field back to the shipped default gives it
// up again; anything else survives every future change of that default.
function applyOperatorOverrides(policy, base, patch = {}) {
  if (patch.backgroundMode === undefined) return policy
  const backgroundModeExplicit = policy.backgroundMode === DEFAULT_NETWORK_POLICY.backgroundMode
    ? false
    : (policy.backgroundMode !== base.backgroundMode ? true : base.backgroundModeExplicit === true)
  return { ...policy, backgroundModeExplicit }
}

export async function loadNetworkPolicy({ store = new Map(), defaults = DEFAULT_NETWORK_POLICY } = {}) {
  let base
  try {
    base = normalizeNetworkPolicy(defaults, DEFAULT_NETWORK_POLICY)
  } catch {
    base = normalizeNetworkPolicy(DEFAULT_NETWORK_POLICY, DEFAULT_NETWORK_POLICY)
  }
  const stored = await readPolicyStore(store)
  if (stored == null) return base
  try {
    // A record from before the consent identity existed carries no answer to
    // the contribution and archive questions. Its operational fields still
    // migrate forward - a ceiling someone chose is not forfeited by a schema
    // bump - while the consent identity resets to watch-only.
    const migrated = migrateStoredNetworkPolicy(stored, base)
    if (stored.policyVersion !== NETWORK_POLICY_VERSION) {
      return normalizeNetworkPolicy({
        ...migrated,
        consentVersion: 0,
        migrationRequired: true,
        contributeWatchedMedia: false,
        archiveEnabled: false,
      }, base)
    }
    return normalizePolicySnapshot(migrated, base)
  } catch {
    return normalizeNetworkPolicy({
      ...DEFAULT_NETWORK_POLICY,
      consentVersion: 0,
      migrationRequired: true,
    }, DEFAULT_NETWORK_POLICY)
  }
}

function unsupportedPolicyError(field, detail) {
  const error = new Error(`${field} is unsupported: ${detail}`)
  error.code = 'UNSUPPORTED_POLICY_FIELD'
  error.field = field
  return error
}

export function assertNetworkPolicyRuntimeSupported(policy) {
  if (policy.followedPublishers.length > 0) throw unsupportedPolicyError('followedPublishers', UNSUPPORTED_RUNTIME_VALUES.followedPublishers)
  if (policy.aiAnalysis !== 'disabled') {
    throw unsupportedPolicyError('aiAnalysis', UNSUPPORTED_RUNTIME_VALUES.aiAnalysis)
  }
  if (policy.retentionMode === 'local-pin') {
    throw unsupportedPolicyError('retentionMode', UNSUPPORTED_RUNTIME_VALUES.retentionMode)
  }
}

function participationRate(value) {
  const next = Number(value)
  return Number.isSafeInteger(next) && next >= 0 ? next : null
}

/**
 * The effective policy every manager runs on. Explicit consent decides which
 * roles this device may hold at all; the participation decision is the
 * authority over the byte path; `meteredNetwork` and `backgroundMode` are
 * operator overrides that may only narrow what the decision already permits,
 * never widen it. A runtime that has never been handed a decision has no
 * participation authority to consult and runs on the operator policy alone.
 */
export function resolveNetworkPolicyForEnvironment(policy, environment = {}, participation = null) {
  const normalized = normalizePolicySnapshot(policy, DEFAULT_NETWORK_POLICY)
  const role = evaluateNetworkRole(normalized)
  const constrainedModes = []
  if (environment.metered) constrainedModes.push(normalized.meteredNetwork)
  if (environment.background) constrainedModes.push(normalized.backgroundMode)
  const networkMode = constrainedModes.includes('pause-network')
    ? 'pause-network'
    : (constrainedModes.includes('local-only') ? 'local-only' : 'allow')
  const networkEnabled = networkMode === 'allow'
  const operatorAllowsUpload = networkEnabled &&
    normalized.uploadPermission === 'enabled' &&
    normalized.uploadCeilingBytes > 0
  // The rule at this branch: a published decision governs the byte path and the
  // operator enums may only narrow it; `participation === null` means no decision
  // has ever been published, and then the operator policy is the only authority
  // there is. That case is deliberately not read as "suspended" - a headless
  // relay or seeder never evaluates participation, and refusing every block
  // request on a process whose whole job is serving would be a far worse lie
  // than serving under the operator's own policy. Every path that reports a
  // participation status publishes the decision behind it (see
  // createNetworkLifecycleApi), so a reported status and the transport cannot
  // disagree; the archive gate is stricter still and fails closed until a
  // decision exists, because custody is a promise to someone else.
  const decisionAllowsUpload = operatorAllowsUpload &&
    (participation === null || participation.upload === true)
  // Serving someone else's bytes needs a role this device was actually granted
  // on top of all of that. A device that has not answered the contribution and
  // archive questions is watch-only, and the transport refuses uploads it was
  // never granted, so reporting anything else here would be the same lie.
  const publicServingAllowed = decisionAllowsUpload &&
    (role.permissions.contribute || role.permissions.archive)
  // The outbound rate belongs to the participation preset, not to whichever
  // manager happens to need it: every consumer reads it from here, and the
  // decision's rate wins wherever it is the tighter of the two.
  const limits = participationLimitsFor(normalized.participationMode)
  const decidedRate = participation === null ? null : participation.outboundBytesPerSecond
  return {
    ...normalized,
    ...role,
    networkMode,
    networkEnabled,
    publicServingAllowed,
    uploadAllowed: publicServingAllowed,
    outboundBytesPerSecond: decidedRate === null
      ? limits.outboundBytesPerSecond
      : Math.min(limits.outboundBytesPerSecond, decidedRate),
  }
}

// Only two things about a participation decision reach the transport: whether
// this device may serve bytes at all, and how fast. Reducing a decision to that
// pair is what lets a status poll which changed neither skip a full manager
// reconfiguration.
function transportTermsOf(decision) {
  if (decision == null) return null
  return Object.freeze({
    upload: decision.upload === true,
    outboundBytesPerSecond: participationRate(decision.outboundBytesPerSecond),
  })
}

function sameTransportTerms(left, right) {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.upload === right.upload &&
    left.outboundBytesPerSecond === right.outboundBytesPerSecond
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
  participationDecision = null,
} = {}) {
  let policy = normalizePolicySnapshot(initialPolicy, DEFAULT_NETWORK_POLICY)
  const environment = { metered: metered === true, background: background === true }
  let transportSuspended = false
  let started = false
  let transition = Promise.resolve()
  let appliedIndexes = new Set()
  let appliedModerationFeeds = new Set()
  // The last participation decision published by the decision authority. Null
  // means nothing has published one yet, not that this device was cleared.
  let participation = transportTermsOf(participationDecision)

  const runTransition = operation => {
    const next = transition.then(operation, operation)
    transition = next.catch(() => {})
    return next
  }

  const normalizeSupported = candidate => {
    const normalized = normalizeNetworkPolicy(candidate, DEFAULT_NETWORK_POLICY)
    assertNetworkPolicyRuntimeSupported(normalized)
    if (normalized.followedIndexes.length > 0 &&
      (typeof scopedNetwork?.followIndexFeed !== 'function' || typeof scopedNetwork?.unfollowIndexFeed !== 'function')) {
      throw unsupportedPolicyError('followedIndexes', 'bounded index-feed transport is unavailable on this runtime')
    }
    if (normalized.trustedModerationFeeds.length > 0 &&
      (typeof scopedNetwork?.followModerationFeed !== 'function' || typeof scopedNetwork?.unfollowModerationFeed !== 'function')) {
      throw unsupportedPolicyError('trustedModerationFeeds', 'bounded moderation-feed transport is unavailable on this runtime')
    }
    if (normalized.retentionMode === 'archive-pledges' && !archiveNetwork?.setParticipation) {
      throw unsupportedPolicyError('retentionMode', 'archive participation is unavailable on this runtime')
    }
    if (normalized.archiveEnabled && !archiveNetwork?.setParticipation) {
      throw unsupportedPolicyError('archiveEnabled', 'archive participation is unavailable on this runtime')
    }
    return normalized
  }
  policy = normalizeSupported(policy)

  const reconcileFeedSubscriptions = async nextPolicy => {
    const indexes = new Set(nextPolicy.followedIndexes)
    const moderation = new Set(nextPolicy.trustedModerationFeeds)
    const workingIndexes = new Set(appliedIndexes)
    const workingModeration = new Set(appliedModerationFeeds)
    try {
      for (const id of appliedIndexes) {
        if (!indexes.has(id)) {
          await scopedNetwork.unfollowIndexFeed({ curatorId: id })
          workingIndexes.delete(id)
        }
      }
      for (const id of appliedModerationFeeds) {
        if (!moderation.has(id)) {
          await scopedNetwork.unfollowModerationFeed({ moderatorId: id })
          workingModeration.delete(id)
        }
      }
      for (const id of indexes) {
        if (!appliedIndexes.has(id)) {
          await scopedNetwork.followIndexFeed({ curatorId: id })
          workingIndexes.add(id)
        }
      }
      for (const id of moderation) {
        if (!appliedModerationFeeds.has(id)) {
          await scopedNetwork.followModerationFeed({ moderatorId: id })
          workingModeration.add(id)
        }
      }
    } catch (error) {
      appliedIndexes = workingIndexes
      appliedModerationFeeds = workingModeration
      throw error
    }
    appliedIndexes = indexes
    appliedModerationFeeds = moderation
  }

  // The reserved bytes an archive has already promised to keep. Custody is a
  // promise this device made; a ceiling that shrinks under it takes away free
  // headroom, never a pledge, so the capacity handed to the archive is floored
  // here instead of failing the whole save.
  const reservedArchiveBytes = () => {
    let status = null
    try {
      status = archiveNetwork?.getStatus?.()
    } catch {
      return 0
    }
    const reserved = Number(status?.reservedBytes)
    return Number.isSafeInteger(reserved) && reserved > 0 ? reserved : 0
  }

  const applyNow = async nextInput => {
    const nextPolicy = normalizeSupported(nextInput)
    const effective = resolveNetworkPolicyForEnvironment(nextPolicy, environment, participation)

    const applied = await scopedNetwork?.applyNetworkPolicy?.(effective)
    await reconcileFeedSubscriptions(nextPolicy)
    const archiveResult = await archiveNetwork?.setParticipation?.({
      enabled: effective.permissions.archive,
      capacityBytes: Math.max(effective.archiveBudgetBytes, reservedArchiveBytes()),
    })
    if (archiveResult?.errorCode) {
      const error = new Error(archiveResult.errorCode)
      error.code = archiveResult.errorCode
      throw error
    }
    await seedingManager?.applyNetworkPolicy?.({
      diskCeilingBytes: nextPolicy.diskCeilingBytes,
      retentionMode: nextPolicy.retentionMode,
      uploadAllowed: effective.uploadAllowed,
      // The transport reports the rate it actually enforces; the policy value is
      // only the request. Seeding reports what is enforced, never a hopeful
      // number nothing is holding it to.
      outboundBytesPerSecond: applied?.outboundBytesPerSecond ?? effective.outboundBytesPerSecond,
      outboundRateEnforced: applied?.outboundRateEnforced === true,
      contributeWatchedMedia: effective.permissions.contribute,
      archiveEnabled: effective.permissions.archive,
      contributionBudgetBytes: effective.contributionBudgetBytes,
      archiveBudgetBytes: effective.archiveBudgetBytes,
      migrationRequired: effective.migrationRequired,
    })

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

  const applyTransactional = async nextInput => {
    const previous = policy
    try {
      return await applyNow(nextInput)
    } catch (error) {
      await applyNow(previous).catch(() => {})
      throw error
    }
  }

  return {
    assertSupported(candidate) {
      return normalizeSupported(candidate)
    },
    start(candidate = policy) {
      if (started) return transition.then(() => resolveNetworkPolicyForEnvironment(policy, environment, participation))
      started = true
      return runTransition(() => applyTransactional(candidate))
    },
    apply(candidate) {
      return runTransition(() => applyTransactional(candidate))
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
    /**
     * Publish the current participation decision. This is the authority over
     * the byte path: the operator enums may narrow what it permits, and nothing
     * may widen it. A decision that changes neither of the two terms the
     * transport cares about costs nothing, so a device may poll its status as
     * often as it likes without reconfiguring every manager.
     */
    setParticipationDecision(decision) {
      const next = transportTermsOf(decision)
      if (sameTransportTerms(next, participation)) {
        return transition.then(() => resolveNetworkPolicyForEnvironment(policy, environment, participation))
      }
      if (!started) {
        // Nothing is configured before startup, so there is nothing to reapply:
        // start() will resolve the policy against this decision.
        participation = next
        return transition.then(() => resolveNetworkPolicyForEnvironment(policy, environment, participation))
      }
      return runTransition(async () => {
        const previous = participation
        participation = next
        try {
          return await applyNow(policy)
        } catch (error) {
          participation = previous
          await applyNow(policy).catch(() => {})
          throw error
        }
      })
    },
    getParticipationDecision() {
      return participation
    },
    getPolicy() {
      return policy
    },
    getEnvironment() {
      return { ...environment, transportSuspended, participation }
    },
  }
}


export function createPolicyApi({
  store = new Map(),
  initialPolicy,
  onPolicyChange = null,
  validatePolicy = null,
  getProfileModerationFeeds = null,
  transactionQueue: providedTransactionQueue = null,
} = {}) {
  let localWrites = Promise.resolve()
  const transactionQueue = providedTransactionQueue || Object.freeze({
    run(operation) {
      const next = localWrites.then(operation, operation)
      localWrites = next.catch(() => {})
      return next
    },
  })
  if (typeof transactionQueue?.run !== 'function') {
    throw new TypeError('policy transaction queue must expose run(operation)')
  }
  const readProfileModerationFeeds = typeof getProfileModerationFeeds === 'function'
    ? () => boundedTransportIdList(getProfileModerationFeeds(), 'profile moderation feeds')
    : null
  const withProfileModerationFeeds = policy => readProfileModerationFeeds
    ? normalizeNetworkPolicy({
        ...policy,
        trustedModerationFeeds: readProfileModerationFeeds(),
      }, DEFAULT_NETWORK_POLICY)
    : policy
  let current = initialPolicy === undefined
    ? null
    : withProfileModerationFeeds(normalizeNetworkPolicy(initialPolicy, DEFAULT_NETWORK_POLICY))
  const ready = current
    ? Promise.resolve(current)
    : loadNetworkPolicy({ store }).then(policy => {
        current = withProfileModerationFeeds(policy)
        return current
      })
  const sameIds = (left, right) =>
    left.length === right.length && left.every((value, index) => value === right[index])

  const profileLinkedFieldError = () => {
    const error = new Error('trustedModerationFeeds is managed by the active consumer moderation profile')
    error.code = 'PROFILE_LINKED_POLICY_FIELD'
    error.field = 'trustedModerationFeeds'
    return error
  }

  const applyPolicy = async policy => {
    const previous = current
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
  }

  const rejection = err => ({
    success: false,
    errorCode: err?.code || 'INVALID_POLICY',
    unsupportedField: err?.field,
    error: err?.message || String(err),
  })

  return {
    ready,
    async getNetworkPolicy() {
      await ready
      const policy = withProfileModerationFeeds(current)
      return { success: true, policy, ...networkPolicyWireFields(policy) }
    },
    async setNetworkPolicy(input = {}) {
      await ready
      return transactionQueue.run(async () => {
        try {
          const patch = decodeNetworkPolicyPatch(input)
          const base = withProfileModerationFeeds(current)
          if (readProfileModerationFeeds && patch.trustedModerationFeeds !== undefined) {
            const requested = boundedTransportIdList(
              patch.trustedModerationFeeds,
              'trustedModerationFeeds',
            )
            if (!sameIds(requested, readProfileModerationFeeds())) {
              throw profileLinkedFieldError()
            }
          }
          const withCeilings = applyParticipationCeilings(
            normalizeNetworkPolicy(patch, base),
            base,
            patch,
          )
          const policy = withProfileModerationFeeds(
            applyOperatorOverrides(withCeilings, base, patch),
          )
          return await applyPolicy(policy)
        } catch (err) {
          return rejection(err)
        }
      })
    },
    async setProfileModerationFeeds(feeds, context = {}) {
      await ready
      const operation = async () => {
        try {
          const trustedModerationFeeds = boundedTransportIdList(
            feeds,
            'profile moderation feeds',
          )
          return await applyPolicy(normalizeNetworkPolicy({
            ...current,
            trustedModerationFeeds,
          }, DEFAULT_NETWORK_POLICY))
        } catch (err) {
          return rejection(err)
        }
      }
      return context.transactionQueue === transactionQueue
        ? operation()
        : transactionQueue.run(operation)
    },
  }
}
