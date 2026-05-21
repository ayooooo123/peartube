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
      if (Array.isArray(options.previewVideos)) {
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

  async enforceQuota() {
    let total = this.getTotalBytes();
    if (total <= this.maxBytes) return;

    const evictable = Array.from(this.channels.values())
      .filter((channel) => !channel.pinned)
      .sort((a, b) => a.addedAt - b.addedAt);

    let changed = false;
    for (const channel of evictable) {
      if (total <= this.maxBytes) break;
      if (!this.channels.delete(channel.driveKey)) continue;
      total -= channel.bytes;
      changed = true;
    }

    if (changed) {
      await this._persist();
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
