import b4a from 'b4a'
import { RETENTION_PRIORITY } from './constants.js'

/**
 * @typedef {Object} CacheChannelRecord
 * @property {string} driveKey - Hex-encoded drive key
 * @property {string} publicBeeKey - Hex-encoded public bee key
 * @property {'discovered'|'pinned'} source - How this channel was added
 * @property {number} addedAt - Unix timestamp (ms)
 * @property {number} bytes - Tracked byte usage for this channel
 * @property {boolean} pinned - Whether this channel is pinned (never evicted)
 * @property {Array<Object>} previewVideos - Compact playable preview refs used to rejoin blob-core swarms after restart
 */

function normalizePreviewVideos(previewVideos) {
  if (!Array.isArray(previewVideos)) return [];
  return previewVideos
    .filter((video) => video && typeof video === 'object')
    .map((video) => ({ ...video }))
}

export class CacheManager {
  /**
   * @param {import('corestore')} store
   * @param {import('hyperbee')} metaDb
   * @param {number} maxBytes
   */
  constructor(store, metaDb, maxBytes) {
    this.store = store;
    this.metaDb = metaDb;
    this.maxBytes = Number.isFinite(maxBytes) ? maxBytes : 0;
    /** @type {Map<string, CacheChannelRecord>} */
    this.channels = new Map();
  }

  async init() {
    const cached = await this.metaDb.get('cache-channels');
    const records = cached?.value;
    if (!Array.isArray(records)) return;

    for (const record of records) {
      if (!record || typeof record.driveKey !== 'string') continue;
      /** @type {CacheChannelRecord} */
      const normalized = {
        driveKey: record.driveKey,
        publicBeeKey: typeof record.publicBeeKey === 'string' ? record.publicBeeKey : '',
        source: record.source === 'pinned' ? 'pinned' : 'discovered',
        addedAt: Number.isFinite(record.addedAt) ? record.addedAt : Date.now(),
        bytes: Number.isFinite(record.bytes) ? record.bytes : 0,
        pinned: Boolean(record.pinned),
        previewVideos: normalizePreviewVideos(record.previewVideos)
      };
      this.channels.set(normalized.driveKey, normalized);
    }
  }

  /**
   * @param {string} driveKey
   * @param {string} publicBeeKey
   * @param {'discovered'|'pinned'} source
   */
  async addChannel(driveKey, publicBeeKey, source, options = {}) {
    const previewVideos = normalizePreviewVideos(options.previewVideos)
    const existing = this.channels.get(driveKey)
    if (existing) {
      let changed = false
      if (typeof publicBeeKey === 'string' && publicBeeKey && existing.publicBeeKey !== publicBeeKey) {
        existing.publicBeeKey = publicBeeKey
        changed = true
      }
      if (source === 'pinned' && !existing.pinned) {
        existing.pinned = true
        existing.source = 'pinned'
        changed = true
      }
      if (Array.isArray(options.previewVideos) || options.clearPreviewVideos === true) {
        const nextSignature = JSON.stringify(previewVideos)
        const currentSignature = JSON.stringify(existing.previewVideos || [])
        if (nextSignature !== currentSignature) {
          existing.previewVideos = previewVideos
          changed = true
        }
      }
      if (changed) await this._persist()
      return changed;
    }

    /** @type {CacheChannelRecord} */
    const record = {
      driveKey,
      publicBeeKey,
      source,
      addedAt: Date.now(),
      bytes: 0,
      pinned: source === 'pinned',
      previewVideos
    };

    this.channels.set(driveKey, record);
    await this._persist();
    return true;
  }

  /**
   * @param {string} driveKey
   */
  async removeChannel(driveKey) {
    const existing = this.channels.get(driveKey);
    if (!existing || existing.pinned) return false;

    this.channels.delete(driveKey);
    await this._persist();
    return true;
  }

  /**
   * @param {string} driveKey
   * @param {string} publicBeeKey
   */
  async pinChannel(driveKey, publicBeeKey) {
    const existing = this.channels.get(driveKey);
    if (existing) {
      existing.publicBeeKey = publicBeeKey;
      existing.pinned = true;
      existing.source = 'pinned';
    } else {
      this.channels.set(driveKey, {
        driveKey,
        publicBeeKey,
        source: 'pinned',
        addedAt: Date.now(),
        bytes: 0,
        pinned: true,
        previewVideos: []
      });
    }

    await this._persist();
  }

  /**
   * @param {string} driveKey
   */
  async unpinChannel(driveKey) {
    const existing = this.channels.get(driveKey);
    if (!existing) return false;

    existing.pinned = false;
    existing.source = 'discovered';
    await this._persist();
    return true;
  }

  getChannels() {
    return Array.from(this.channels.values());
  }

  /**
   * @param {string} driveKey
   * @param {number} bytes
   */
  async updateChannelSize(driveKey, bytes) {
    const existing = this.channels.get(driveKey);
    if (!existing) return false;

    existing.bytes = Number.isFinite(bytes) ? bytes : 0;
    await this._persist();
    return true;
  }

  /**
   * Reclaim disk by clearing cached discovery blob ranges when tracked usage
   * exceeds maxBytes. Deliberately-retained content (pinned, or catalog
   * retentionClass private/allowlist) is never evicted; only network-discovered
   * cache is. Lowest retention priority is evicted first, oldest within a class.
   *
   * @param {{
   *   retentionClassOf?: (driveKey: string) => string,
   *   protectedCoreKeys?: Set<string> | string[],
   *   resolveChannelBlobRefs?: (channel: CacheChannelRecord) => Promise<Array<{blobsCoreKey: string, blobId: string}>> | Array<{blobsCoreKey: string, blobId: string}>,
   *   onEvicted?: (driveKey: string) => any,
   *   collectGarbage?: () => any,
   *   log?: (...args: any[]) => void,
   * }} [options]
   * @returns {Promise<{evicted: string[], freedBytes: number, clearedRanges: number}>}
   */
  async enforceQuota(options = {}) {
    const retentionClassOf = typeof options.retentionClassOf === 'function' ? options.retentionClassOf : () => 'discovery'
    const resolveChannelBlobRefs = typeof options.resolveChannelBlobRefs === 'function' ? options.resolveChannelBlobRefs : null
    const onEvicted = typeof options.onEvicted === 'function' ? options.onEvicted : null
    const collectGarbage = typeof options.collectGarbage === 'function' ? options.collectGarbage : null
    const log = typeof options.log === 'function' ? options.log : null
    const protectedCoreKeys = options.protectedCoreKeys instanceof Set
      ? options.protectedCoreKeys
      : new Set(Array.isArray(options.protectedCoreKeys) ? options.protectedCoreKeys : [])
    const discoveryPriority = RETENTION_PRIORITY.discovery || 1

    let total = this.getTotalBytes()
    const result = { evicted: [], freedBytes: 0, clearedRanges: 0 }
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || total <= this.maxBytes) return result

    // Only network-discovered cache is evictable: pinned channels and anything
    // the catalog marks private/allowlist (deliberate uploads, allowlisted
    // seeds) are protected. Evict lowest priority first, oldest within a class.
    const evictable = Array.from(this.channels.values())
      .filter((channel) => !channel.pinned)
      .filter((channel) => (RETENTION_PRIORITY[retentionClassOf(channel.driveKey)] || 0) <= discoveryPriority)
      .sort((a, b) => {
        const pa = RETENTION_PRIORITY[retentionClassOf(a.driveKey)] || 0
        const pb = RETENTION_PRIORITY[retentionClassOf(b.driveKey)] || 0
        return pa - pb || a.addedAt - b.addedAt
      })

    for (const channel of evictable) {
      if (total <= this.maxBytes) break
      let refs = this._channelBlobRefs(channel)
      if (resolveChannelBlobRefs) {
        try {
          const resolved = await resolveChannelBlobRefs(channel)
          if (Array.isArray(resolved) && resolved.length > 0) refs = resolved
        } catch { /* fall back to cached preview refs */ }
      }
      // A channel with ANY protected (active/in-use) blob core is left intact:
      // we won't clear a protected range, so we could never fully reclaim the
      // channel, and subtracting its bytes would overstate freed disk.
      if (refs.length === 0 || refs.some((ref) => protectedCoreKeys.has(ref.blobsCoreKey))) {
        log?.('[CacheManager] Skipped eviction; channel has no clearable refs or an active core', channel.driveKey.slice(0, 16))
        continue
      }
      let clearedForChannel = 0
      for (const ref of refs) {
        if (await this._clearBlobRange(ref.blobsCoreKey, ref.blobId, log)) clearedForChannel += 1
      }
      // Only drop the record and claim the channel's bytes once EVERY range is
      // actually gone; a partial clear leaves the channel tracked so the quota
      // never overstates freed disk and a later sweep retries (re-clearing an
      // already-cleared range is a no-op).
      if (clearedForChannel !== refs.length) {
        log?.('[CacheManager] Skipped eviction; channel not fully reclaimed', channel.driveKey.slice(0, 16), `${clearedForChannel}/${refs.length}`)
        continue
      }
      result.clearedRanges += clearedForChannel
      this.channels.delete(channel.driveKey)
      const bytes = Math.max(0, Number(channel.bytes) || 0)
      total -= bytes
      result.freedBytes += bytes
      result.evicted.push(channel.driveKey)
      if (onEvicted) { try { await onEvicted(channel.driveKey) } catch { /* best effort */ } }
      log?.('[CacheManager] Evicted discovery channel', channel.driveKey.slice(0, 16), 'freed~', bytes, 'ranges', clearedForChannel)
    }

    if (result.evicted.length > 0) {
      await this._persist()
      if (collectGarbage) { try { await collectGarbage() } catch { /* best effort */ } }
    }
    return result
  }

  _channelBlobRefs(channel) {
    const refs = []
    for (const video of (channel?.previewVideos || [])) {
      if (video?.blobId && video?.blobsCoreKey) {
        refs.push({ blobsCoreKey: String(video.blobsCoreKey), blobId: String(video.blobId) })
      }
      if (video?.thumbnailBlobId && video?.thumbnailBlobsCoreKey) {
        refs.push({ blobsCoreKey: String(video.thumbnailBlobsCoreKey), blobId: String(video.thumbnailBlobId) })
      }
    }
    return refs
  }

  // Clear a single blob's Hypercore block range. blobId is
  // "blockOffset:blockLength:byteOffset:byteLength" (matches the seeder).
  async _clearBlobRange(blobsCoreKey, blobId, log = null) {
    if (!/^[0-9a-f]{64}$/i.test(blobsCoreKey || '')) return false
    const parts = String(blobId || '').split(':')
    const blockOffset = Number(parts[0])
    const blockLength = Number(parts[1])
    if (!Number.isInteger(blockOffset) || blockOffset < 0 || !Number.isInteger(blockLength) || blockLength <= 0) return false
    let core = null
    try {
      core = this.store.get(b4a.from(blobsCoreKey, 'hex'))
      await core.ready?.()
      if (typeof core.clear !== 'function') return false
      await core.clear(blockOffset, blockOffset + blockLength)
      return true
    } catch (err) {
      log?.('[CacheManager] Failed to clear blob range', String(blobsCoreKey).slice(0, 16), err?.message || String(err))
      return false
    } finally {
      try { await core?.close?.() } catch { /* best effort */ }
    }
  }

  getTotalBytes() {
    let total = 0;
    for (const channel of this.channels.values()) {
      total += channel.bytes;
    }
    return total;
  }

  getStats() {
    let pinnedChannels = 0;
    for (const channel of this.channels.values()) {
      if (channel.pinned) pinnedChannels += 1;
    }

    return {
      totalChannels: this.channels.size,
      pinnedChannels,
      totalBytes: this.getTotalBytes(),
      maxBytes: this.maxBytes
    };
  }

  async _persist() {
    await this.metaDb.put('cache-channels', Array.from(this.channels.values()));
  }
}
