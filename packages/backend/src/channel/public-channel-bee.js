/**
 * PublicChannelBee - Simple auto-replicating channel index
 *
 * This provides a simple Hyperbee-based storage for public channel data.
 * Unlike Autobase, it auto-replicates via store.replicate() without any
 * special setup.
 *
 * Use cases:
 * - Public feed discovery (viewers load this, not the Autobase)
 * - Instant video list sync
 * - Channel metadata
 *
 * Single-writer: Only the channel owner can write. But anyone can read
 * once they have the key, and it replicates automatically.
 */

import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import ReadyResource from 'ready-resource'

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

    // Wrap in Hyperbee for key-value storage
    this.bee = new Hyperbee(this.core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await this.bee.ready()

    console.log('[PublicBee] Ready:', this.keyHex?.slice(0, 16), 'writable:', this.writable, 'length:', this.core.length)
  }

  async _close() {
    if (this.bee) await this.bee.close()
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
    // the comments admin writer key here; keep it in private channel metadata only.
    delete out.commentsAdminKey
    return out
  }

  async getMetadata() {
    await this.waitForSync(1500)
    const node = await this.bee.get('meta')
    return this._sanitizePublicMetadata(node?.value || null)
  }

  async setMetadata(meta) {
    if (!this.writable) throw new Error('Not writable')
    // Merge with existing metadata so callers can perform partial updates without
    // accidentally dropping previously published fields (e.g. commentsAutobaseKey).
    const existing = await this.bee.get('meta').catch(() => null)
    const prev = this._sanitizePublicMetadata(existing?.value || null) || {}
    const patch = this._sanitizePublicMetadata(meta) || {}

    await this.bee.put('meta', {
      ...prev,
      ...patch,
      updatedAt: Date.now()
    })
    console.log('[PublicBee] Metadata updated')
  }

  // ============================================
  // Video Operations
  // ============================================

  async listVideos() {
    // Give replication a chance before scanning.
    await this.waitForSync(1500)

    const videos = []
    const stream = this.bee.createReadStream({
      gte: 'videos/',
      lt: 'videos0' // '0' comes after '/' in ASCII
    })

    try {
      for await (const node of stream) {
        if (node.value) {
          videos.push(node.value)
        }
      }
    } catch (error) {
      try {
        stream.destroy?.(error)
      } catch (destroyError) {
        console.warn('[PublicBee] listVideos stream destroy failed:', destroyError?.message || destroyError)
      }
      console.warn('[PublicBee] listVideos stream failed:', error?.message || error)
      return videos
    }

    // Sort by upload time, newest first
    videos.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
    return videos
  }

  async getVideo(videoId) {
    const node = await this.bee.get(`videos/${videoId}`)
    return node?.value || null
  }

  async putVideo(videoId, metadata) {
    if (!this.writable) throw new Error('Not writable')
    await this.bee.put(`videos/${videoId}`, {
      ...metadata,
      id: videoId,
      syncedAt: Date.now()
    })
    console.log('[PublicBee] Video added/updated:', videoId)
  }

  async deleteVideo(videoId) {
    if (!this.writable) throw new Error('Not writable')
    await this.bee.del(`videos/${videoId}`)
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

    const batch = this.bee.batch()
    const now = Date.now()

    for (const c of changes) {
      if (!c || typeof c.id !== 'string' || c.id.length === 0) continue
      if (c.type === 'del') {
        await batch.del(`videos/${c.id}`)
      } else if (c.type === 'put') {
        await batch.put(`videos/${c.id}`, {
          ...(c.value || {}),
          id: c.id,
          syncedAt: now
        })
      }
    }

    await batch.flush()
    console.log('[PublicBee] Applied', changes.length, 'video change(s)')
  }

  // ============================================
  // Bulk Sync (for syncing from Autobase)
  // ============================================

  /**
   * Sync all videos from a source (e.g., Autobase channel)
   * @param {Array<Object>} videos - Video metadata array
   */
  async syncVideos(videos, opts = {}) {
    if (!this.writable) throw new Error('Not writable')

    const destructive = opts.destructive !== false
    const batch = this.bee.batch()

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
      await batch.put(`videos/${video.id}`, {
        ...video,
        syncedAt: now
      })
    }

    // Delete videos that no longer exist in source only for explicitly complete
    // source snapshots. syncFromChannel intentionally disables this path.
    if (destructive) {
      for (const id of existing) {
        if (!sourceIds.has(id)) {
          await batch.del(`videos/${id}`)
        }
      }
    }

    await batch.flush()
    console.log('[PublicBee] Synced', videos.length, 'videos', destructive ? '(destructive)' : '(non-destructive)')
  }

  /**
   * Sync metadata and videos from an Autobase channel
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

      // Sync videos non-destructively. The Autobase view may be stale or
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
