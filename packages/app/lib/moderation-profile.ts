import {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  type ModerationProfile,
} from './default-moderation-profile'

export {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  type ModerationProfile,
}

export type ModerationProfileState = {
  profile: ModerationProfile
  customized: boolean
}

export type ModerationProfileRpc = {
  getPersonalSettings?: (request?: Record<string, never>) => Promise<unknown>
  setPersonalSetting?: (request: { key: string; value: string }) => Promise<unknown>
}

const MAX_SUBSCRIPTIONS = 256
const MAX_PROFILE_SETTING_BYTES = 64 * 1024

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function normalizeSignerIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTIONS) {
    throw new Error('moderation profile subscriptions must be a bounded list')
  }
  return Array.from(new Set(value.map((candidate) => {
    if (typeof candidate !== 'string') {
      throw new Error('moderation profile subscription signer is invalid')
    }
    const signerId = candidate.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(signerId)) {
      throw new Error('moderation profile subscription signer is invalid')
    }
    return signerId
  }))).sort()
}

export function normalizeModerationProfileState(value: unknown): ModerationProfileState {
  const wrapper = objectValue(value, 'moderation profile state')
  const profileValue = objectValue(wrapper.profile || wrapper, 'moderation profile')
  const version = Number(profileValue.version)
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('moderation profile version is invalid')
  }
  return {
    profile: {
      version,
      enabled: profileValue.enabled !== false,
      curatorSubscriptions: normalizeSignerIds(profileValue.curatorSubscriptions),
      scope: 'local-device',
      protocolAuthority: false,
    },
    customized: wrapper.profile ? wrapper.customized === true : false,
  }
}

function requireMethod<T extends keyof ModerationProfileRpc>(
  rpc: ModerationProfileRpc | null | undefined,
  method: T,
) {
  const candidate = rpc?.[method]
  if (typeof candidate !== 'function') {
    throw new Error('Moderation profile is unavailable in this build')
  }
  return candidate.bind(rpc) as Exclude<ModerationProfileRpc[T], undefined>
}

function responseError(response: unknown): string | null {
  if (!response || typeof response !== 'object') return 'Moderation profile update returned an invalid response'
  const value = response as Record<string, unknown>
  if (value.success !== false) return null
  const message = typeof value.error === 'string' ? value.error.trim().slice(0, 240) : ''
  return message || String(value.errorCode || 'Moderation profile update was rejected').slice(0, 240)
}

export function createModerationProfileActions(rpc: ModerationProfileRpc | null | undefined) {
  const load = async (): Promise<ModerationProfileState> => {
    const response = objectValue(
      await requireMethod(rpc, 'getPersonalSettings')({}),
      'personal settings response',
    )
    const settings = Array.isArray(response.settings) ? response.settings : []
    const setting = settings.find((candidate) =>
      candidate && typeof candidate === 'object' &&
      (candidate as Record<string, unknown>).key === CONSUMER_MODERATION_PROFILE_SETTING_KEY
    ) as Record<string, unknown> | undefined
    if (typeof setting?.value !== 'string' ||
        setting.value.length > MAX_PROFILE_SETTING_BYTES) {
      throw new Error('Backend moderation profile is unavailable')
    }
    return normalizeModerationProfileState(JSON.parse(setting.value))
  }

  const save = async (input: unknown): Promise<ModerationProfileState> => {
    const response = await requireMethod(rpc, 'setPersonalSetting')({
      key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      value: JSON.stringify(input),
    })
    const error = responseError(response)
    if (error) throw new Error(error)
    return load()
  }

  return Object.freeze({
    load,
    async replace(state: ModerationProfileState, curatorSubscriptions: string[]) {
      const current = normalizeModerationProfileState(state)
      const next = normalizeModerationProfileState({
        profile: {
          ...current.profile,
          enabled: true,
          curatorSubscriptions,
        },
        customized: true,
      })
      return save({ profile: next.profile })
    },
    async disable(state: ModerationProfileState) {
      const current = normalizeModerationProfileState(state)
      return save({
        profile: {
          ...current.profile,
          enabled: false,
          curatorSubscriptions: [],
        },
      })
    },
    restoreDefaults() {
      return save({ operation: 'restore-defaults' })
    },
  })
}
