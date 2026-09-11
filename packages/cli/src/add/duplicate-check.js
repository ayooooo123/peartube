const ACTIVE_CANONICAL_ACQUISITION_STATES = new Set([
  'queued',
  'acquiring',
  'verifying',
  'publishing'
])

// Distinguish an authoritative target-channel duplicate (blocks transfer) from
// advisory network matches (warn only). `--force` never bypasses a duplicate
// already owned by the target channel or an active provider acquisition.
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

async function checkChannelDuplicate (channelReader, { channel, item, identity }) {
  if (!channel || typeof channelReader !== 'function') return null
  const existing = await channelReader({ channel, item, identity })
  if (!existing) return null
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

async function checkActiveJobDuplicate (activeJobsReader, { channel, item, identity }) {
  if (typeof activeJobsReader !== 'function') return null
  const activeJob = await activeJobsReader({ channel, item, identity })
  if (!activeJob || !ACTIVE_CANONICAL_ACQUISITION_STATES.has(activeJob.state)) return null
  return {
    status: 'already-exists',
    source: 'active-acquisition',
    existing: {
      channelKey: activeJob.channelKey || null,
      videoId: activeJob.publicationId || null,
      availability: activeJob.state,
      acquisitionId: activeJob.acquisitionId || null
    }
  }
}

async function collectNetworkAdvisories (networkReader, { channel, item, identity }) {
  const advisories = []
  if (typeof networkReader !== 'function') return advisories
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
  return advisories
}

export function createDuplicateCheck ({ channelReader, activeJobsReader, networkReader } = {}) {
  return {
    async check ({ channel, item, force = false } = {}) {
      const identity = itemIdentity(item)

      // 1. Existing target-channel item with the same exact identity is a no-op.
      const channelDuplicate = await checkChannelDuplicate(channelReader, { channel, item, identity })
      if (channelDuplicate) return channelDuplicate

      // 2. An active provider acquisition for the same identity also blocks
      // (never bypassed by force). Retired local-job records without a
      // canonical provider state are ignored rather than exposed as a
      // publication or durability status.
      const jobDuplicate = await checkActiveJobDuplicate(activeJobsReader, { channel, item, identity })
      if (jobDuplicate) return jobDuplicate

      // 3. Structured public/feed matches are advisory only and never block.
      const advisories = await collectNetworkAdvisories(networkReader, { channel, item, identity })

      return { status: 'ok', advisories, force }
    }
  }
}
