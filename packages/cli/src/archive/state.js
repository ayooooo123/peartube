const PREFIX = 'archive:state:'
const SOURCE_PREFIX = 'archive:source:'

function buildVideoKey(sourceId, videoId) {
  return `${PREFIX}${sourceId}:${videoId}`
}

function buildSourceKey(sourceId) {
  return `${SOURCE_PREFIX}${sourceId}`
}

export const ARCHIVE_STATUS = Object.freeze({
  ARCHIVED: 'archived',
  FAILED: 'failed',
  ABANDONED: 'abandoned'
})

/**
 * State store backed by ctx.metaDb (a Hyperbee).
 * Tracks per-(sourceId, videoId) status to dedupe across polls,
 * and per-sourceId metadata (channel key, last poll time).
 *
 * Records are JSON; metaDb's valueEncoding is 'json'.
 */
export function createArchiveState({ metaDb }) {
  if (!metaDb || typeof metaDb.get !== 'function') {
    throw new Error('createArchiveState requires a Hyperbee-shaped metaDb')
  }

  return {
    async getVideo(sourceId, videoId) {
      const node = await metaDb.get(buildVideoKey(sourceId, videoId))
      return node?.value ?? null
    },

    async putVideo(sourceId, videoId, record) {
      const value = {
        sourceId,
        videoId,
        ...record,
        updatedAt: Date.now()
      }
      await metaDb.put(buildVideoKey(sourceId, videoId), value)
      return value
    },

    async markArchived(sourceId, videoId, { peartubeVideoId, bytes, title }) {
      return this.putVideo(sourceId, videoId, {
        status: ARCHIVE_STATUS.ARCHIVED,
        peartubeVideoId: peartubeVideoId || null,
        bytes: Number.isFinite(bytes) ? Number(bytes) : 0,
        title: typeof title === 'string' ? title : null,
        retries: 0,
        lastError: null,
        archivedAt: Date.now()
      })
    },

    async markFailed(sourceId, videoId, error, { maxRetries }) {
      const existing = await this.getVideo(sourceId, videoId)
      const retries = (existing?.retries || 0) + 1
      const status = retries > Math.max(0, Number(maxRetries) || 0)
        ? ARCHIVE_STATUS.ABANDONED
        : ARCHIVE_STATUS.FAILED
      return this.putVideo(sourceId, videoId, {
        status,
        retries,
        lastError: error?.message || String(error),
        peartubeVideoId: existing?.peartubeVideoId || null
      })
    },

    async listVideos(sourceId) {
      const gte = `${PREFIX}${sourceId}:`
      const lt = `${PREFIX}${sourceId}:￿`
      const out = []
      for await (const entry of metaDb.createReadStream({ gte, lt })) {
        if (entry?.value) out.push(entry.value)
      }
      return out
    },

    async getSource(sourceId) {
      const node = await metaDb.get(buildSourceKey(sourceId))
      return node?.value ?? null
    },

    async putSource(sourceId, record) {
      const value = {
        sourceId,
        ...record,
        updatedAt: Date.now()
      }
      await metaDb.put(buildSourceKey(sourceId), value)
      return value
    }
  }
}
