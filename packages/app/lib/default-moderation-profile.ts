export type ModerationProfile = {
  version: number
  enabled: boolean
  curatorSubscriptions: string[]
  scope: 'local-device'
  protocolAuthority: false
}

export type ModerationProfileStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export const DEFAULT_MODERATION_PROFILE_STORAGE_KEY = 'peartube.default-moderation-profile.v1'
export const DEFAULT_CURATED_MODERATION_FEED_IDS = Object.freeze([
  '3f41c5f2d9a0e74c8b1f36a5d0e2947bc91e8a42f674d2be09c51a8734f0bd62',
])

// These identifiers authenticate optional moderation-feed pages only. They are
// deliberately not bootstrap, publisher, replication, or playback trust roots.
export const DEFAULT_MODERATION_PROFILE: ModerationProfile = Object.freeze({
  version: 1,
  enabled: true,
  curatorSubscriptions: DEFAULT_CURATED_MODERATION_FEED_IDS as unknown as string[],
  scope: 'local-device',
  protocolAuthority: false,
})

type StoredProfile = { profile: ModerationProfile, customized: boolean }

function clone(profile: ModerationProfile): ModerationProfile {
  return {
    version: profile.version,
    enabled: profile.enabled !== false,
    curatorSubscriptions: Array.from(new Set((profile.curatorSubscriptions || []).map(String))).sort(),
    scope: 'local-device',
    protocolAuthority: false,
  }
}

function valid(value: unknown): value is StoredProfile {
  const stored = value as StoredProfile | null
  return Boolean(stored && stored.profile && Number.isSafeInteger(stored.profile.version) && Array.isArray(stored.profile.curatorSubscriptions))
}

export function createDefaultModerationProfileStore({
  storage,
  bundledProfile = DEFAULT_MODERATION_PROFILE,
  storageKey = DEFAULT_MODERATION_PROFILE_STORAGE_KEY,
}: {
  storage: ModerationProfileStorage
  bundledProfile?: ModerationProfile
  storageKey?: string
}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw new TypeError('local moderation profile storage is required')
  const bundled = clone(bundledProfile)

  async function read(): Promise<StoredProfile> {
    const stored = await storage.get(storageKey)
    if (!valid(stored)) return { profile: clone(bundled), customized: false }
    // A user decision is durable across app updates. Only Restore Defaults opts
    // into a newer bundled descriptor.
    if (stored.customized !== true && stored.profile.version < bundled.version) {
      return { profile: clone(bundled), customized: false }
    }
    return { profile: clone(stored.profile), customized: stored.customized === true }
  }

  async function write(value: StoredProfile) {
    await storage.set(storageKey, { profile: clone(value.profile), customized: value.customized === true })
  }

  return {
    async inspect() { return read() },
    async replace(profile: ModerationProfile) {
      const next = { profile: clone(profile), customized: true }
      await write(next)
      return next
    },
    async disable() {
      const current = await read()
      const next = { profile: { ...current.profile, enabled: false }, customized: true }
      await write(next)
      return next
    },
    async restoreDefaults() {
      const next = { profile: clone(bundled), customized: false }
      await write(next)
      return next
    },
  }
}
