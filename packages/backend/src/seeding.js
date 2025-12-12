/**
 * SeedingManager - Distributed Content Availability
 *
 * "Pied Piper" model: viewers become seeders.
 * Handles content seeding with storage quotas and prioritization.
 */

/**
 * @typedef {import('./types.js').SeedingConfig} SeedingConfig
 * @typedef {import('./types.js').SeedInfo} SeedInfo
 */

export class SeedingManager {
  /**
   * @param {import('corestore')} store - Corestore instance
   * @param {import('hyperbee')} metaDb - Metadata database
   */
  constructor(store, metaDb) {
    this.store = store;
    this.metaDb = metaDb;
    /** @type {Map<string, SeedInfo>} key: `${driveKey}:${videoPath}` -> seed info */
    this.activeSeeds = new Map();
    /** @type {Set<string>} driveKeys that are pinned (always seed) */
    this.pinnedChannels = new Set();
    /** @type {SeedingConfig} */
    this.config = {
      maxStorageGB: 5,            // Default 5GB quota for seeded peer content
      autoSeedWatched: true,      // Automatically seed videos you watch
      autoSeedSubscribed: false,  // Automatically seed subscribed channels (opt-in)
      maxVideosPerChannel: 10     // Max videos to seed per channel if auto-seeding subscriptions
    };
    console.log('[SeedingManager] Initialized');
  }

  /**
   * Initialize seeding manager - load config and state from database
   */
  async init() {
    // Load config from metaDb
    const savedConfig = await this.metaDb.get('seeding-config');
    if (savedConfig?.value) {
      this.config = { ...this.config, ...savedConfig.value };
      console.log('[SeedingManager] Loaded config:', this.config);
    }

    // Load pinned channels
    const pinnedData = await this.metaDb.get('pinned-channels');
    if (pinnedData?.value) {
      for (const key of pinnedData.value) {
        this.pinnedChannels.add(key);
      }
      console.log('[SeedingManager] Loaded', this.pinnedChannels.size, 'pinned channels');
    }

    // Load active seeds
    const seedsData = await this.metaDb.get('active-seeds');
    if (seedsData?.value) {
      for (const [key, info] of Object.entries(seedsData.value)) {
        this.activeSeeds.set(key, /** @type {SeedInfo} */ (info));
      }
      console.log('[SeedingManager] Loaded', this.activeSeeds.size, 'active seeds');
    }
  }

  /**
   * Add a seed for a video
   * @param {string} driveKey
   * @param {string} videoPath
   * @param {'watched'|'pinned'|'subscribed'} reason
   * @param {{blockLength?: number, byteLength?: number}} [blobInfo]
   * @returns {Promise<boolean>}
   */
  async addSeed(driveKey, videoPath, reason, blobInfo) {
    if (!this.config.autoSeedWatched && reason === 'watched') {
      console.log('[SeedingManager] Auto-seed watched disabled, skipping');
      return false;
    }

    const key = `${driveKey}:${videoPath}`;

    // Check if already seeding
    if (this.activeSeeds.has(key)) {
      console.log('[SeedingManager] Already seeding:', key.slice(0, 32));
      return false;
    }

    /** @type {SeedInfo} */
    const seedInfo = {
      driveKey,
      videoPath,
      reason,
      addedAt: Date.now(),
      blocks: blobInfo?.blockLength || 0,
      bytes: blobInfo?.byteLength || 0
    };

    this.activeSeeds.set(key, seedInfo);
    await this.persistSeeds();

    console.log('[SeedingManager] Added seed:', videoPath, 'reason:', reason, 'bytes:', seedInfo.bytes);

    // Enforce quota
    await this.enforceQuota();

    return true;
  }

  /**
   * Remove a seed
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<boolean>}
   */
  async removeSeed(driveKey, videoPath) {
    const key = `${driveKey}:${videoPath}`;
    if (this.activeSeeds.has(key)) {
      this.activeSeeds.delete(key);
      await this.persistSeeds();
      console.log('[SeedingManager] Removed seed:', key.slice(0, 32));
      return true;
    }
    return false;
  }

  /**
   * Pin a channel for always seeding
   * @param {string} driveKey
   */
  async pinChannel(driveKey) {
    this.pinnedChannels.add(driveKey);
    await this.persistPinnedChannels();
    console.log('[SeedingManager] Pinned channel:', driveKey.slice(0, 16));
  }

  /**
   * Unpin a channel
   * @param {string} driveKey
   */
  async unpinChannel(driveKey) {
    this.pinnedChannels.delete(driveKey);
    await this.persistPinnedChannels();
    console.log('[SeedingManager] Unpinned channel:', driveKey.slice(0, 16));
  }

  /**
   * Update seeding config
   * @param {Partial<SeedingConfig>} newConfig
   */
  async setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    await this.metaDb.put('seeding-config', this.config);
    console.log('[SeedingManager] Updated config:', this.config);
  }

  /**
   * Get seeding status
   * @returns {Promise<Object>}
   */
  async getStatus() {
    const storageUsed = this.calculateStorage();
    return {
      activeSeeds: this.activeSeeds.size,
      pinnedChannels: this.pinnedChannels.size,
      storageUsedBytes: storageUsed,
      storageUsedGB: (storageUsed / (1024 * 1024 * 1024)).toFixed(2),
      maxStorageGB: this.config.maxStorageGB,
      config: this.config,
      seeds: Array.from(this.activeSeeds.values()).map(s => ({
        videoPath: s.videoPath,
        reason: s.reason,
        bytes: s.bytes,
        addedAt: s.addedAt
      }))
    };
  }

  /**
   * Calculate total storage used by seeds
   * @returns {number}
   */
  calculateStorage() {
    let total = 0;
    for (const seed of this.activeSeeds.values()) {
      total += seed.bytes || 0;
    }
    return total;
  }

  /**
   * Enforce storage quota by removing old/low-priority seeds
   */
  async enforceQuota() {
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    let currentBytes = this.calculateStorage();

    if (currentBytes <= maxBytes) {
      return; // Under quota
    }

    console.log('[SeedingManager] Over quota, current:', currentBytes, 'max:', maxBytes);

    // Get seeds sorted by priority (pinned > subscribed > watched) then by age
    const seeds = Array.from(this.activeSeeds.entries())
      .map(([key, info]) => ({ key, ...info }))
      .sort((a, b) => {
        // Priority order: pinned (keep) > subscribed > watched (remove first)
        const priorityOrder = { pinned: 3, subscribed: 2, watched: 1 };
        const priorityDiff = (priorityOrder[a.reason] || 0) - (priorityOrder[b.reason] || 0);
        if (priorityDiff !== 0) return priorityDiff;

        // Older first for same priority
        return a.addedAt - b.addedAt;
      });

    // Remove oldest/lowest priority seeds until under quota
    for (const seed of seeds) {
      if (currentBytes <= maxBytes) break;
      if (seed.reason === 'pinned') continue; // Never remove pinned

      this.activeSeeds.delete(seed.key);
      currentBytes -= seed.bytes || 0;
      console.log('[SeedingManager] Removed seed to meet quota:', seed.key.slice(0, 32));
    }

    await this.persistSeeds();
  }

  /**
   * Persist seeds to database
   */
  async persistSeeds() {
    const seedsObj = Object.fromEntries(this.activeSeeds);
    await this.metaDb.put('active-seeds', seedsObj);
  }

  /**
   * Persist pinned channels to database
   */
  async persistPinnedChannels() {
    await this.metaDb.put('pinned-channels', Array.from(this.pinnedChannels));
  }

  /**
   * Get pinned channels
   * @returns {string[]}
   */
  getPinnedChannels() {
    return Array.from(this.pinnedChannels);
  }

  /**
   * Get all active seeds (for warmup/rejoin)
   * @returns {SeedInfo[]}
   */
  getActiveSeeds() {
    return Array.from(this.activeSeeds.values());
  }

  /**
   * Check if a channel is pinned
   * @param {string} driveKey
   * @returns {boolean}
   */
  isChannelPinned(driveKey) {
    return this.pinnedChannels.has(driveKey);
  }

  /**
   * Get current storage limit in GB
   * @returns {number}
   */
  getMaxStorageGB() {
    return this.config.maxStorageGB;
  }

  /**
   * Set storage limit in GB
   * @param {number} gb
   * @returns {Promise<void>}
   */
  async setMaxStorageGB(gb) {
    if (gb < 1) gb = 1;
    if (gb > 100) gb = 100;
    this.config.maxStorageGB = gb;
    await this.metaDb.put('seeding-config', this.config);
    console.log('[SeedingManager] Set max storage to', gb, 'GB');
    // Enforce quota with new limit
    await this.enforceQuota();
  }

  /**
   * Get storage stats for UI display
   * @returns {{ usedBytes: number, maxBytes: number, usedGB: string, maxGB: number, seedCount: number, pinnedCount: number }}
   */
  getStorageStats() {
    const usedBytes = this.calculateStorage();
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    return {
      usedBytes,
      maxBytes,
      usedGB: (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
      maxGB: this.config.maxStorageGB,
      seedCount: this.activeSeeds.size,
      pinnedCount: this.pinnedChannels.size
    };
  }

  /**
   * Clear all non-pinned cached content
   * @returns {Promise<number>} bytes cleared
   */
  async clearCache() {
    let clearedBytes = 0;
    const toRemove = [];

    for (const [key, seed] of this.activeSeeds.entries()) {
      if (seed.reason !== 'pinned') {
        clearedBytes += seed.bytes || 0;
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.activeSeeds.delete(key);
    }

    await this.persistSeeds();
    console.log('[SeedingManager] Cleared cache:', clearedBytes, 'bytes from', toRemove.length, 'seeds');
    return clearedBytes;
  }
}
