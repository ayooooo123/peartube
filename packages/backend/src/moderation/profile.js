import { createModerationPolicyEvaluator } from './policy.js'

export const CONSUMER_MODERATION_PROFILE_SETTING_KEY = 'consumer-moderation-profile:v1'

export const DEFAULT_CURATED_MODERATION_FEED_IDS = Object.freeze([
  '3f41c5f2d9a0e74c8b1f36a5d0e2947bc91e8a42f674d2be09c51a8734f0bd62',
])

export const DEFAULT_CONSUMER_MODERATION_PROFILE = Object.freeze({
  version: 1,
  enabled: true,
  curatorSubscriptions: DEFAULT_CURATED_MODERATION_FEED_IDS,
  scope: 'local-device',
  protocolAuthority: false,
})

function cloneProfile(value, fallback = DEFAULT_CONSUMER_MODERATION_PROFILE) {
  const input = value && typeof value === 'object' ? value : fallback
  const version = Number(input.version)
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('moderation profile version is invalid')
  if (!Array.isArray(input.curatorSubscriptions) || input.curatorSubscriptions.length > 256) {
    throw new Error('moderation profile curator subscriptions are invalid')
  }
  const curatorSubscriptions = Array.from(new Set(input.curatorSubscriptions.map(value => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error('moderation profile curator subscription must be canonical 32-byte public-key hex')
    }
    return value
  }))).sort()
  return {
    version,
    enabled: input.enabled !== false,
    curatorSubscriptions,
    scope: 'local-device',
    protocolAuthority: false,
  }
}

function cloneState(state) {
  return {
    profile: cloneProfile(state.profile),
    customized: state.customized === true,
  }
}

function normalizeStoredState(value, bundledProfile) {
  if (!value || typeof value !== 'object') return null
  const wrapped = value.profile && typeof value.profile === 'object'
    ? value
    : { profile: value, customized: value.customized === true }
  try {
    const state = cloneState(wrapped)
    if (!state.customized && state.profile.version < bundledProfile.version) {
      return { profile: cloneProfile(bundledProfile), customized: false }
    }
    return state
  } catch {
    return null
  }
}

export function createConsumerModerationProfileController(options = {}) {
  const repository = options.repository || {}
  const bundledProfile = cloneProfile(options.bundledProfile || DEFAULT_CONSUMER_MODERATION_PROFILE)
  let state = { profile: cloneProfile(bundledProfile), customized: false }

  async function save(next) {
    const candidate = cloneState(next)
    await repository.save?.(cloneState(candidate))
    state = candidate
    return cloneState(state)
  }

  async function previewMutation(input) {
    await ready
    if (input?.operation === 'restore-defaults') {
      return { profile: cloneProfile(bundledProfile), customized: false }
    }
    if (input?.profile?.enabled === false) {
      return {
        profile: {
          ...cloneProfile(input.profile || state.profile),
          enabled: false,
          curatorSubscriptions: [],
        },
        customized: true,
      }
    }
    return { profile: cloneProfile(input?.profile), customized: true }
  }

  async function previewReload() {
    await ready
    const stored = normalizeStoredState(await repository.load?.(), bundledProfile)
    return cloneState(stored || { profile: cloneProfile(bundledProfile), customized: false })
  }

  async function initialize() {
    const raw = await repository.load?.()
    const stored = normalizeStoredState(raw, bundledProfile)
    const next = stored || { profile: cloneProfile(bundledProfile), customized: false }
    state = cloneState(next)
    if (!stored || JSON.stringify(raw) !== JSON.stringify(state)) {
      await repository.save?.(cloneState(state))
    }
    return cloneState(state)
  }

  const ready = initialize()

  return {
    ready,
    async inspect() {
      await ready
      return cloneState(state)
    },
    async reload() {
      return save(await previewReload())
    },
    async replace(profile) {
      await ready
      return save({ profile: cloneProfile(profile), customized: true })
    },
    async disable() {
      await ready
      return save({
        profile: { ...cloneProfile(state.profile), enabled: false, curatorSubscriptions: [] },
        customized: true,
      })
    },
    async restoreDefaults() {
      await ready
      return save({ profile: cloneProfile(bundledProfile), customized: false })
    },
    previewMutation,
    previewReload,
    async commit(next) {
      await ready
      return save(next)
    },
    getProfile() {
      return cloneProfile(state.profile)
    },
    getEffectiveCuratorSubscriptions() {
      return state.profile.enabled === false ? [] : state.profile.curatorSubscriptions.slice()
    },
    isCuratorSubscribed(curatorId) {
      return state.profile.enabled !== false &&
        state.profile.curatorSubscriptions.includes(String(curatorId).toLowerCase())
    },
  }
}

export function createConsumerModerationProfileTransaction({
  profileController,
  applyState,
  afterCommit = async () => {},
  transactionQueue: providedTransactionQueue = null,
} = {}) {
  if (
    !profileController ||
    typeof profileController.inspect !== 'function' ||
    typeof profileController.previewMutation !== 'function' ||
    typeof profileController.commit !== 'function' ||
    typeof applyState !== 'function' ||
    typeof afterCommit !== 'function'
  ) {
    throw new TypeError('moderation profile transaction dependencies are required')
  }
  let localWrites = Promise.resolve()
  const transactionQueue = providedTransactionQueue || Object.freeze({
    run(operation) {
      const next = localWrites.then(operation, operation)
      localWrites = next.catch(() => {})
      return next
    },
  })
  if (typeof transactionQueue?.run !== 'function') {
    throw new TypeError('moderation profile transaction queue must expose run(operation)')
  }

  async function applyCandidate(candidate) {
    const previous = await profileController.inspect()
    try {
      await applyState(candidate, { transactionQueue })
    } catch (error) {
      await applyState(previous, { transactionQueue }).catch(() => {})
      throw error
    }
    try {
      const committed = await profileController.commit(candidate)
      await afterCommit(committed)
      return committed
    } catch (error) {
      await profileController.commit(previous).catch(() => {})
      await applyState(previous, { transactionQueue }).catch(() => {})
      await afterCommit(previous).catch(() => {})
      throw error
    }
  }

  return Object.freeze({
    async apply(input) {
      return transactionQueue.run(async () =>
        applyCandidate(await profileController.previewMutation(input))
      )
    },
    async reload() {
      return transactionQueue.run(async () =>
        applyCandidate(await profileController.previewReload())
      )
    },
  })
}

export function createConsumerModerationPolicy({
  profileController,
  moderationManager,
  localBlocks = () => [],
  localAllows = () => [],
} = {}) {
  if (!profileController || typeof profileController.isCuratorSubscribed !== 'function') {
    throw new TypeError('moderation profile controller is required')
  }

  function beginEvaluation() {
    if (profileController.getProfile().enabled === false) {
      return {
        enabled: false,
        evaluate: () => ({ action: 'visible', reason: 'profile-disabled', evidence: [] }),
      }
    }
    const records = moderationManager?.getRecords?.() || []
    const subscribedRecords = records.filter(record => {
      const sourceId = String(record?.sourceId || '')
      const separator = sourceId.indexOf(':')
      const curatorId = separator === -1 ? sourceId : sourceId.slice(0, separator)
      return profileController.isCuratorSubscribed(curatorId)
    })
    return {
      enabled: true,
      evaluate: createModerationPolicyEvaluator({
        localBlocks: localBlocks(),
        localAllows: localAllows(),
        feedBlocks: subscribedRecords.filter(record => record.action !== 'allow'),
        feedAllows: subscribedRecords.filter(record => record.action === 'allow'),
      }),
    }
  }

  return {
    get enabled() {
      return profileController.getProfile().enabled !== false
    },
    get curatorSubscriptions() {
      return profileController.getEffectiveCuratorSubscriptions()
    },
    beginEvaluation,
    evaluate(entity) {
      return beginEvaluation().evaluate(entity)
    },
  }
}
