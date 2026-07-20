// Distinguish an authoritative target-channel duplicate (blocks transfer) from
// advisory network matches (warn only). `--force` bypasses only a failed local
// source job, never a winning/pending target-authority identity.
export function itemIdentity (item) {
  if (!item) return null
  if (item.contentKind === 'movie') return 'movie'
  if (item.seasonNumber != null && item.episodeNumber != null) {
    return `s${item.seasonNumber}e${item.episodeNumber}`
  }
  if (item.sourceProvider && item.sourceVideoId) return `src:${item.sourceProvider}:${item.sourceVideoId}`
  if (item.identityUrl) return `url:${item.identityUrl}`
  return null
}

export function createDuplicateCheck ({ channelReader, activeJobsReader, networkReader } = {}) {
  return {
    async check ({ channel, item, force = false } = {}) {
      const identity = itemIdentity(item)

      // 1. Existing target-channel item with the same exact identity is a no-op.
      if (channel && typeof channelReader === 'function') {
        const existing = await channelReader({ channel, item, identity })
        if (existing) {
          return {
            status: 'already-exists',
            source: 'channel',
            existing: {
              channelKey: existing.channelKey || channel.channelKey || null,
              videoId: existing.videoId || existing.id || null,
              availability: existing.availability || 'published'
            }
          }
        }
      }

      // 2. An active durable job for the same identity also blocks (never bypassed by force).
      if (typeof activeJobsReader === 'function') {
        const activeJob = await activeJobsReader({ channel, item, identity })
        if (activeJob) {
          return {
            status: 'already-exists',
            source: 'active-job',
            existing: {
              channelKey: activeJob.channelKey || null,
              videoId: activeJob.videoId || null,
              availability: 'replicationPending',
              jobId: activeJob.jobId || null
            }
          }
        }
      }

      // 3. Structured public/feed matches are advisory only and never block.
      const advisories = []
      if (typeof networkReader === 'function') {
        const matches = await networkReader({ channel, item, identity }) || []
        for (const match of matches) {
          advisories.push({
            kind: match.exact ? 'exact' : 'fuzzy',
            channelKey: match.channelKey || null,
            videoId: match.videoId || null,
            title: match.title || null,
            year: match.year || null
          })
        }
      }

      return { status: 'ok', advisories, force }
    }
  }
}
