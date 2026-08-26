export type ModerationProfile = {
  version: number
  enabled: boolean
  curatorSubscriptions: string[]
  scope: 'local-device'
  protocolAuthority: false
}

export const CONSUMER_MODERATION_PROFILE_SETTING_KEY = 'consumer-moderation-profile:v1'
export const DEFAULT_CURATED_MODERATION_FEED_IDS: readonly string[] = Object.freeze([])

// These identifiers authenticate optional moderation-feed pages only. They are
// deliberately not bootstrap, publisher, replication, or playback trust roots.
export const DEFAULT_MODERATION_PROFILE: ModerationProfile = Object.freeze({
  version: 1,
  enabled: true,
  curatorSubscriptions: DEFAULT_CURATED_MODERATION_FEED_IDS as unknown as string[],
  scope: 'local-device',
  protocolAuthority: false,
})
