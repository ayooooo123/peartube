export function resolveRuntimePolicy({ env = {}, network = {}, upload = {}, media = {} } = {}) {
  return {
    trustedRelayKeys: [
      ...(network.trustedRelayKeys || []),
      ...String(env.PEARTUBE_RELAYS || '').split(',').filter(Boolean),
    ],
    followedIndexes: network.followedIndexes || [],
    trustedModerationFeeds: network.trustedModerationFeeds || [],
    uploadOrigin: upload.origin || null,
    mediaOrigin: media.origin || null,
  }
}
