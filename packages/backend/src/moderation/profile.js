import { evaluateModerationPolicy } from './policy.js'

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
  const curatorSubscriptions = Array.from(new Set(
    input.curatorSubscriptions.map(value => String(value).toLowerCase()).filter(Boolean)
  )).sort()
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
    state = cloneState(next)
    await repository.save?.(cloneState(state))
    return cloneState(state)
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
      const stored = normalizeStoredState(await repository.load?.(), bundledProfile)
      return save(stored || { profile: cloneProfile(bundledProfile), customized: false })
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

export function createConsumerModerationPolicy({
  profileController,
  moderationManager,
  localBlocks = () => [],
  localAllows = () => [],
} = {}) {
  if (!profileController || typeof profileController.isCuratorSubscribed !== 'function') {
    throw new TypeError('moderation profile controller is required')
  }

  return {
    get enabled() {
      return profileController.getProfile().enabled !== false
    },
    get curatorSubscriptions() {
      return profileController.getEffectiveCuratorSubscriptions()
    },
    evaluate(entity) {
      if (!this.enabled) {
        return { action: 'visible', reason: 'profile-disabled', evidence: [] }
      }
      const records = moderationManager?.getRecords?.() || []
      const subscribedRecords = records.filter(record => {
        const sourceId = String(record?.sourceId || '')
        const separator = sourceId.indexOf(':')
        const curatorId = separator === -1 ? sourceId : sourceId.slice(0, separator)
        return profileController.isCuratorSubscribed(curatorId)
      })
      return evaluateModerationPolicy(entity, {
        localBlocks: localBlocks(),
        localAllows: localAllows(),
        feedBlocks: subscribedRecords.filter(record => record.action !== 'allow'),
        feedAllows: subscribedRecords.filter(record => record.action === 'allow'),
      })
    },
  }
}
