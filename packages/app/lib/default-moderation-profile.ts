export type ModerationProfile = {
  version: number
  enabled: boolean
  curatorSubscriptions: string[]
  scope: 'local-device'
  protocolAuthority: false
}

export const CONSUMER_MODERATION_PROFILE_SETTING_KEY = 'consumer-moderation-profile:v1'
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
