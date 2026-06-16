/**
 * PublicChannelBee - Simple auto-replicating channel index
 *
 * This provides simple HyperDB-backed storage for public channel data.
 * It auto-replicates via store.replicate() without any special setup.
 *
 * Use cases:
 * - Public feed discovery (viewers load this typed public index)
 * - Instant video list sync
 * - Channel metadata
 *
 * Single-writer: Only the channel owner can write. But anyone can read
 * once they have the key, and it replicates automatically.
 */

import HyperDB from 'hyperdb'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import ReadyResource from 'ready-resource'

import publicDbDefinition from './public-hyperdb-spec/hyperdb/index.js'

const PUBLIC_METADATA_INTERNAL_FIELDS = new Set(['key'])

const DEFAULT_LIST_VIDEOS_SYNC_TIMEOUT_MS = 1500
const DEFAULT_LIST_VIDEOS_STREAM_TIMEOUT_MS = 1200
const SOURCE_METADATA_FIELDS = [
  'sourcePlatform',
  'sourcePlatformLabel',
  'sourceUrl',
  'sourceId',
  'sourceCreatorName',
  'sourceCreatorHandle',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'sourceViewCount',
  'sourceLikeCount',
  'sourceCommentCount',
  'sourceArchivedAt',
  'sourceRelayId',
  'sourceMetadataJson',
]

function normalizeTimeoutMs(value, fallback) {
  const timeout = Number(value)
  return Number.isFinite(timeout) && timeout >= 0 ? timeout : fallback
}

function extractSourceMetadata(value, videoId) {
  const out = { videoId }
  let hasMetadata = false
  for (const field of SOURCE_METADATA_FIELDS) {
    if (value?.[field] === undefined || value?.[field] === null) continue
    out[field] = value[field]
    hasMetadata = true
  }
  return hasMetadata ? out : null
}

export class PublicChannelBee extends ReadyResource {
  /**
   * @param {import('corestore')} store
   * @param {Object} opts
   * @param {Buffer|string} [opts.key] - Hypercore key (for loading existing)
   * @param {string} [opts.name] - Core name (for creating new)
   */
  constructor(store, opts = {}) {
    super()
    this.store = store
    this.opts = opts
    this.db = null
    // Kept for legacy tests/callers that verify the raw Hyperbee path is gone.
    this.bee = null
    this.core = null

    this.ready().catch(() => {})
  }

  async _open() {
    // Create or load the Hypercore
    if (this.opts.key) {
      // Load existing by key
      const keyBuf = typeof this.opts.key === 'string'
        ? b4a.from(this.opts.key, 'hex')
        : this.opts.key
      this.core = this.store.get({ key: keyBuf })
    } else if (this.opts.name) {
      // Create new with name (deterministic key derivation)
      this.core = this.store.get({ name: this.opts.name })
    } else {
      throw new Error('PublicChannelBee requires either key or name')
    }

    await this.core.ready()

    // Wrap the public core in HyperDB for typed collections + secondary indexes.
    this.db = HyperDB.bee(this.core, publicDbDefinition, {
      autoUpdate: true,
      writable: this.core.writable !== false,
      extension: false,
    })
    await this.db.ready()

    console.log('[PublicBee] Ready:', this.keyHex?.slice(0, 16), 'writable:', this.writable, 'length:', this.core.length)
  }

  async _close() {
    if (this.db) await this.db.close()
  }

  get key() {
    return this.core?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.core?.discoveryKey || null
  }

  get writable() {
    return this.core?.writable || false
  }

  /**
   * Best-effort wait for replication to deliver blocks for this bee.
   * On mobile (few peers, slower links), immediate reads often return empty unless we wait a bit.
   *
   * Keep this bounded and short: callers (UI) often retry, so we prefer returning
   * quickly over blocking for multi-second syncs.
   *
   * @param {number} [timeoutMs=1500]
   */
  async waitForSync(timeoutMs = 1500) {
    // Only makes sense if we have a core and we're not the writer (writers already have the data locally).
    if (!this.core) return
    if (this.writable) return

    try {
      // Hypercore v11 supports update({ wait: true, timeout })
      await this.core.update({ wait: true, timeout: timeoutMs })
    } catch {
      // Non-fatal: if no peers / no replication, just continue with whatever we have.
    }
  }

  // ============================================
  // Channel Metadata
  // ============================================

  _sanitizePublicMetadata(meta) {
    if (!meta || typeof meta !== 'object') return null
    const out = { ...meta }
    // PublicBee is intentionally readable by anyone with the key. Never persist
    // private moderation/admin material here.
    delete out.commentsAdminKey
    delete out.commentsAutobaseKey
    for (const key of Object.keys(out)) {
      if (PUBLIC_METADATA_INTERNAL_FIELDS.has(key)) delete out[key]
    }
    return out
  }

  _sanitizePublicVideo(video) {
    if (!video || typeof video !== 'object') return null
    const out = { ...video }
    delete out.commentsAdminKey
    return out
  }

  async _getSourceMetadata(videoId) {
    if (!this.db || !videoId) return null
    return this.db.get('@peartubePublic/videoSourceMetadata', { videoId }).catch(() => null)
  }

  async _withSourceMetadata(video) {
    if (!video?.id) return video || null
    const metadata = await this._getSourceMetadata(video.id)
    if (!metadata) return video
    const { videoId, ...sourceMetadata } = metadata
    return { ...video, ...sourceMetadata }
  }

  async _withSourceMetadataList(videos) {
    if (!this.db) return videos || []
    return Promise.all((videos || []).map((video) => this._withSourceMetadata(video)))
  }

  async getMetadata() {
    await this.waitForSync(1500)
    if (!this.db) {
      const existing = await this.bee?.get?.('meta')?.catch?.(() => null)
      return this._sanitizePublicMetadata(existing?.value || null)
    }
    this.db.update?.()
    const meta = await this.db.get('@peartubePublic/metadata', { key: 'meta' })
    return this._sanitizePublicMetadata(meta || null)
  }

  _toStoredPublicMetadata(meta) {
    return {
      ...(this._sanitizePublicMetadata(meta) || {}),
      key: 'meta'
    }
  }

  async setMetadata(meta) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) {
      const existing = await this.bee?.get?.('meta')?.catch?.(() => null)
      const prev = this._sanitizePublicMetadata(existing?.value || null) || {}
      const patch = this._sanitizePublicMetadata(meta) || {}
      await this.bee?.put?.('meta', { ...prev, ...patch, updatedAt: Date.now() })
      return
    }
    // Merge with existing metadata so callers can perform partial updates without
    // accidentally dropping previously published fields.
    const prev = this._sanitizePublicMetadata(await this.getMetadata()) || {}
    const patch = this._sanitizePublicMetadata(meta) || {}

    await this.db.insert('@peartubePublic/metadata', this._toStoredPublicMetadata({
      ...prev,
      ...patch,
      updatedAt: Date.now()
    }))
    await this.db.flush()
    console.log('[PublicBee] Metadata updated')
  }

  // ============================================
  // Video Operations
  // ============================================

  async listVideos(options = {}) {
    const syncTimeoutMs = normalizeTimeoutMs(options?.syncTimeoutMs, DEFAULT_LIST_VIDEOS_SYNC_TIMEOUT_MS)
    const streamTimeoutMs = normalizeTimeoutMs(options?.timeoutMs, DEFAULT_LIST_VIDEOS_STREAM_TIMEOUT_MS)

    // Give replication a chance before scanning.
    await this.waitForSync(syncTimeoutMs)

    if (!this.db) {
      const stream = this.bee?.createReadStream?.({
        gte: 'videos/',
        lt: 'videos0'
      })
      return this._collectVideoStream(stream, streamTimeoutMs)
    }
    this.db.update?.()

    const stream = this.db.find('@peartubePublic/videos-by-uploaded-at', {}, {
      reverse: true
    })
    return this._collectVideoStream(stream, streamTimeoutMs)
  }

  async _collectVideoStream(stream, streamTimeoutMs) {
    const videos = []
    let timeout = null
    let timedOut = false

    const destroyStream = (err) => {
      try {
        stream.destroy?.(err)
      } catch (destroyError) {
        console.warn('[PublicBee] listVideos stream destroy failed:', destroyError?.message || destroyError)
      }
    }

    if (streamTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        destroyStream(new Error(`PublicBee listVideos timed out after ${streamTimeoutMs}ms`))
      }, streamTimeoutMs)
      timeout.unref?.()
    }

    try {
      for await (const item of stream) {
        const video = item?.value || item
        if (video) {
          videos.push(this._sanitizePublicVideo(video))
        }
      }
    } catch (error) {
      if (!timedOut) {
        destroyStream(error)
        console.warn('[PublicBee] listVideos stream failed:', error?.message || error)
      } else {
        console.log('[PublicBee] listVideos stream timed out; returning partial results:', error?.message || error)
      }
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    const joined = await this._withSourceMetadataList(videos)
    joined.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return joined
  }

  async getVideo(videoId) {
    const node = this.db
      ? await this.db.get('@peartubePublic/videos', { id: videoId })
      : null
    return this._withSourceMetadata(this._sanitizePublicVideo(node) || null)
  }

  async putVideo(videoId, metadata) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')
    await this.db.insert('@peartubePublic/videos', this._sanitizePublicVideo({
      ...metadata,
      id: videoId,
      syncedAt: Date.now()
    }))
    const sourceMetadata = extractSourceMetadata(metadata, videoId)
    if (sourceMetadata) {
      await this.db.insert('@peartubePublic/videoSourceMetadata', sourceMetadata)
    }
    await this.db.flush()
    console.log('[PublicBee] Video added/updated:', videoId)
  }

  async deleteVideo(videoId) {
    if (!this.writable) throw new Error('Not writable')
    if (!this.db) throw new Error('Public HyperDB not ready')
    await this.db.delete('@peartubePublic/videos', { id: videoId })
    await this.db.delete('@peartubePublic/videoSourceMetadata', { videoId }).catch(() => {})
    await this.db.flush()
    console.log('[PublicBee] Video deleted:', videoId)
  }

  /**
   * Apply a set of video changes efficiently using a Hyperbee batch.
   *
   * Each change is either:
   * - { type: 'put', id: string, value: object }
   * - { type: 'del', id: string }
   *
   * @param {Array<{type: 'put'|'del', id: string, value?: any}>} changes
   */
  async applyVideoChanges(changes) {
    if (!this.writable) throw new Error('Not writable')
    if (!Array.isArray(changes) || changes.length === 0) return

    const batch = []
    const now = Date.now()

    for (const c of changes) {
      if (!c || typeof c.id !== 'string' || c.id.length === 0) continue
      if (c.type === 'del') {
        batch.push(['@peartubePublic/videos', { id: c.id }, { type: 'delete' }])
        batch.push(['@peartubePublic/videoSourceMetadata', { videoId: c.id }, { type: 'delete' }])
      } else if (c.type === 'put') {
        batch.push(['@peartubePublic/videos', this._sanitizePublicVideo({
          ...(c.value || {}),
          id: c.id,
          syncedAt: now
        })])
        const sourceMetadata = extractSourceMetadata(c.value, c.id)
        if (sourceMetadata) batch.push(['@peartubePublic/videoSourceMetadata', sourceMetadata])
      }
    }

    if (batch.length > 0) {
      await this.db.insertAll(batch)
      await this.db.flush()
    }
    console.log('[PublicBee] Applied', changes.length, 'video change(s)')
  }

  // ============================================
  // Bulk Sync (for syncing from channel HyperDB)
  // ============================================

  /**
   * Sync all videos from a source snapshot.
   * @param {Array<Object>} videos - Video metadata array
   */
  async syncVideos(videos, opts = {}) {
    if (!this.writable) throw new Error('Not writable')

    if (!this.db) throw new Error('Public HyperDB not ready')

    const destructive = opts.destructive !== false
    const batch = []

    // Get existing video IDs only when this sync is allowed to delete missing
    // entries. Non-destructive callers may be syncing from stale/partial views.
    const existing = new Set()
    if (destructive) {
      const existingVideos = await this.listVideos()
      for (const v of existingVideos) {
        existing.add(v.id)
      }
    }

    // Add/update videos from source
    const sourceIds = new Set()
    const now = Date.now()
    for (const video of videos) {
      if (!video.id) continue
      sourceIds.add(video.id)
      batch.push(['@peartubePublic/videos', this._sanitizePublicVideo({
        ...video,
        syncedAt: now
      })])
      const sourceMetadata = extractSourceMetadata(video, video.id)
      if (sourceMetadata) batch.push(['@peartubePublic/videoSourceMetadata', sourceMetadata])
    }

    // Delete videos that no longer exist in source only for explicitly complete
    // source snapshots. syncFromChannel intentionally disables this path.
    if (destructive) {
      for (const id of existing) {
        if (!sourceIds.has(id)) {
          batch.push(['@peartubePublic/videos', { id }, { type: 'delete' }])
          batch.push(['@peartubePublic/videoSourceMetadata', { videoId: id }, { type: 'delete' }])
        }
      }
    }

    if (batch.length > 0) {
      await this.db.insertAll(batch)
      await this.db.flush()
    }
    console.log('[PublicBee] Synced', videos.length, 'videos', destructive ? '(destructive)' : '(non-destructive)')
  }

  /**
   * Sync metadata and videos from a channel.
   * @param {import('./multi-writer-channel.js').MultiWriterChannel} channel
   */
  async syncFromChannel(channel) {
    if (!this.writable) {
      console.log('[PublicBee] Not writable, skipping sync')
      return
    }

    try {
      // Sync metadata
      const meta = await channel.getMetadata()
      if (meta) {
        await this.setMetadata(meta)
      }

      // Sync videos non-destructively. The channel DB may be stale or partial
      // partially materialized (especially after bounded replication waits), so
      // absence from this read must not delete already-published public videos.
      const videos = await channel.listVideos()
      await this.syncVideos(videos || [], { destructive: false })

      console.log('[PublicBee] Synced from channel:', channel.keyHex?.slice(0, 16))
    } catch (err) {
      console.error('[PublicBee] Sync error:', err.message)
    }
  }
}
