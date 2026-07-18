// Public feed API group, extracted from api.js.

export function createFeedApi({ ctx, publicFeed, loadChannel, isValidHypercoreHex }) {
  return {
    /**
     * Get public feed entries
     * @returns {{entries: Array, stats: Object}}
     */
    getPublicFeed() {
      if (!publicFeed) {
        return { entries: [], stats: { totalEntries: 0, hiddenCount: 0, peerCount: 0 } }
      }
      const rawFeed = publicFeed.getFeed()
      const feed = rawFeed
        .map((entry) => {
          return {
            driveKey: entry?.driveKey || entry?.channelKey || '',
            channelKey: entry?.channelKey || entry?.driveKey || '',
            source: entry?.source || 'peer',
            publicBeeKey: entry?.publicBeeKey || null,
            relayRole: entry?.relayRole || null,
            relayServing: Boolean(entry?.relayServing),
            catalogVersion: entry?.catalogVersion || null,
            previewVideosHash: entry?.previewVideosHash || null,
            channelName: entry?.channelName || null,
            videoCount: entry?.videoCount || 0,
            peerCount: entry?.peerCount || 0,
            discoveryOnly: Boolean(entry?.discoveryOnly),
            restoredFromCache: Boolean(entry?.restoredFromCache),
            restoredFrom: entry?.restoredFrom || null,
            requiresAvailabilityProbe: Boolean(entry?.requiresAvailabilityProbe),
            lastSeen: entry?.lastSeen || entry?.lastSeenAt || entry?.addedAt || 0,
            manifestUpdatedAt: entry?.manifestUpdatedAt || 0,
            videos: Array.isArray(entry?.videos) ? entry.videos : Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
            previewVideos: Array.isArray(entry?.videos) ? entry.videos : Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
          }
        })
        .filter((entry) => typeof entry.channelKey === 'string' && entry.channelKey.length > 0)
      const stats = publicFeed.getStats()
      const keyedEntries = feed.filter((e) => typeof e.publicBeeKey === 'string' && e.publicBeeKey.length > 0).length
      const unkeyedEntries = feed.length - keyedEntries
      console.log(
        `[API] Returning ${feed.length} feed entries (${stats.peerCount} peers, keyed=${keyedEntries}, fallback=${unkeyedEntries}, raw=${rawFeed.length})`
      )
      return {
        entries: feed,
        stats: {
          ...stats,
          keyedEntries,
          unkeyedEntries,
        },
      }
    },

    /**
     * Refresh feed from peers
     * @returns {{success: boolean, peerCount: number}}
     */
    refreshFeed() {
      console.log('[API] Refreshing feed...')
      let peerCount = 0
      if (publicFeed) {
        peerCount = publicFeed.requestFeedsFromPeers()
      }
      return { success: true, peerCount }
    },

    /**
     * Submit channel to public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async submitToFeed(driveKey) {
      console.log('[API] Submitting channel to feed:', driveKey?.slice(0, 16))
      if (publicFeed && driveKey) {
        // Get publicBeeKey from the channel for fast viewer access
        let publicBeeKey = null
        try {
          const channel = await loadChannel(ctx, driveKey)
          if (channel?.publicProjectionActive === false) {
            return {
              success: false,
              error: 'Unable to publish channel: public projection is inactive',
            }
          }
          publicBeeKey = channel?.publicBeeKey || await channel?.getPublicBeeKey()
          console.log('[API] submitToFeed: got publicBeeKey:', publicBeeKey?.slice(0, 16))

          // Comments are HyperDB-backed in the channel now; publish the channel DB
          // key as the comments DB key for older clients/debug screens.
          const commentsDbKey = channel.keyHex || driveKey
          if (commentsDbKey) {
            console.log('[API] submitToFeed: comments DB key:', commentsDbKey.slice(0, 16))

            if (channel.publicBee?.writable) {
              const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}))
              if (!pubMeta?.commentsDbKey) {
                await channel.publicBee.setMetadata({
                  ...pubMeta,
                  commentsDbKey
                })
                console.log('[API] submitToFeed: synced commentsDbKey to PublicBee')
              }
            }
          }
        } catch (err) {
          console.log('[API] submitToFeed: channel/comments init error:', err?.message)
        }
        if (!isValidHypercoreHex(publicBeeKey)) {
          return {
            success: false,
            error: 'Unable to publish channel: missing publicBeeKey',
          }
        }
        await publicFeed.submitChannel(driveKey, publicBeeKey)
      }
      return { success: true }
    },

    /**
     * Unpublish channel from public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unpublishFromFeed(driveKey) {
      console.log('[API] Unpublishing channel from feed:', driveKey?.slice(0, 16))
      if (publicFeed && driveKey) {
        await publicFeed.unpublishChannel(driveKey)
      }
      return { success: true }
    },

    /**
     * Check if channel is published to feed
     * @param {string} driveKey
     * @returns {{published: boolean}}
     */
    isChannelPublished(driveKey) {
      if (publicFeed && driveKey) {
        return { published: publicFeed.isChannelPublished(driveKey) }
      }
      return { published: false }
    },

    /**
     * Hide channel from feed
     * @param {string} driveKey
     * @returns {{success: boolean}}
     */
    hideChannel(driveKey) {
      console.log('[API] Hiding channel:', driveKey?.slice(0, 16))
      if (publicFeed && driveKey) {
        publicFeed.hideChannel(driveKey)
      }
      return { success: true }
    },
  }
}
