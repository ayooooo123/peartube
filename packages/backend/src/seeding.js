/**
 * SeedingManager - Distributed Content Availability
 *
 * "Pied Piper" model: viewers become seeders.
 * Handles content seeding with storage quotas and prioritization.
 */

import { normalizeBlobsCoreKey, normalizeBlobRefInput, stringifyBlobId } from './blob-ref.js';
import { collectCorestoreGarbage } from './corestore-gc.js';

/**
 * @typedef {import('./types.js').SeedingConfig} SeedingConfig
 * @typedef {import('./types.js').SeedInfo} SeedInfo
 */

function normalizeSeedBlobRef(seed) {
  const blobsCoreKey = normalizeBlobsCoreKey(seed?.blobsCoreKey)
  const blob = normalizeBlobRefInput(seed?.blobId || seed?.blob)
  if (!blobsCoreKey || !blob) return null
  return { blobsCoreKey, blob, blobId: stringifyBlobId(blob) }
}

function formatBytesAsGB(bytes) {
  return (Math.max(0, Number(bytes) || 0) / (1024 * 1024 * 1024)).toFixed(2);
}

function normalizeProtectedSeedKeys(keys) {
  if (!keys) return new Set()
  if (keys instanceof Set) return keys
  if (Array.isArray(keys)) return new Set(keys.filter(Boolean))
  if (typeof keys === 'string') return new Set([keys])
  return new Set()
}

function createNoopRelease() {
  return () => {}
}

function mergeSeedReason(existingReason, nextReason) {
  const priority = { watched: 1, subscribed: 2, pinned: 3 }
  return (priority[nextReason] || 0) > (priority[existingReason] || 0)
    ? nextReason
    : existingReason
}

function hasFiniteByteLength(blobInfo) {
  return Number.isFinite(Number(blobInfo?.byteLength)) && Number(blobInfo.byteLength) >= 0
}

function normalizeByteLength(blobInfo, fallback = 0) {
  return hasFiniteByteLength(blobInfo)
    ? Math.round(Number(blobInfo.byteLength))
    : fallback
}

export class SeedingAuthorizationError extends Error {
  constructor(message = 'Unauthorized seeding mutation') {
    super(message)
    this.name = 'SeedingAuthorizationError'
  }
}

function normalizeDriveKey(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class SeedingManager {
  /**
   * @param {import('corestore')} store - Corestore instance
   * @param {import('hyperbee')} metaDb - Metadata database
   * @param {{ getDiskUsageBytes?: () => number | Promise<number>, isCacheClearBlocked?: () => boolean }} [options]
   */
  constructor(store, metaDb, options = {}) {
    this.store = store;
    this.metaDb = metaDb;
    this.identityManager = options.identityManager || null;
    this.requiresIdentityAuthorization = Object.prototype.hasOwnProperty.call(options, 'identityManager');
    this.getDiskUsageBytes = typeof options.getDiskUsageBytes === 'function'
      ? options.getDiskUsageBytes
      : (typeof store?.getDiskUsageBytes === 'function' ? () => store.getDiskUsageBytes() : null);
    this.isCacheClearBlocked = typeof options.isCacheClearBlocked === 'function'
      ? options.isCacheClearBlocked
      : null;
    /** @type {Map<string, SeedInfo>} key: `${driveKey}:${videoPath}` -> seed info */
    this.activeSeeds = new Map();
    /** @type {Map<string, number>} blobsCoreKey -> active playback/prefetch retain count */
    this.protectedBlobCores = new Map();
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

  getActiveIdentityDriveKey() {
    const active = this.identityManager?.getActiveIdentity?.()
    return normalizeDriveKey(active?.driveKey || active?.channelKey)
  }

  assertAuthorizedMutation(options = {}) {
    if (options.authorized === true) return
    if (!this.requiresIdentityAuthorization) return
    if (this.getActiveIdentityDriveKey()) return
    throw new SeedingAuthorizationError()
  }

  assertAuthorizedForSeed(driveKey, reason, options = {}) {
    if (reason === 'watched' && options.userInitiated !== true) return
    this.assertAuthorizedMutation(options)
  }

  retainBlobRef(blobInfo) {
    const ref = normalizeSeedBlobRef(blobInfo)
    if (!ref) return createNoopRelease()

    const key = ref.blobsCoreKey
    this.protectedBlobCores.set(key, (this.protectedBlobCores.get(key) || 0) + 1)

    let released = false
    return () => {
      if (released) return
      released = true
      const nextCount = (this.protectedBlobCores.get(key) || 0) - 1
      if (nextCount > 0) {
        this.protectedBlobCores.set(key, nextCount)
      } else {
        this.protectedBlobCores.delete(key)
      }
    }
  }

  isSeedBlobProtected(seed) {
    const ref = normalizeSeedBlobRef(seed)
    return Boolean(ref && this.protectedBlobCores.has(ref.blobsCoreKey))
  }

  isCacheClearBlockedNow() {
    try {
      return Boolean(this.isCacheClearBlocked?.())
    } catch {
      return false
    }
  }

  shouldSkipSeedClear(seed) {
    return this.isCacheClearBlockedNow() || this.isSeedBlobProtected(seed)
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
   * @param {{blockLength?: number, byteLength?: number, publicBeeKey?: string | null, blobId?: string | null, blobsCoreKey?: string | null, thumbnailBlobId?: string | null, thumbnailBlobsCoreKey?: string | null, mimeType?: string | null, thumbnailMimeType?: string | null}} [blobInfo]
   * @param {{protectSelf?: boolean, protectedKeys?: string[] | Set<string>}} [options]
   * @returns {Promise<boolean>}
   */
  async addSeed(driveKey, videoPath, reason, blobInfo, options = {}) {
    this.assertAuthorizedForSeed(driveKey, reason, options)

    if (!this.config.autoSeedWatched && reason === 'watched') {
      console.log('[SeedingManager] Auto-seed watched disabled, skipping');
      return false;
    }

    const key = `${driveKey}:${videoPath}`;

    // Check if already seeding
    if (this.activeSeeds.has(key)) {
      console.log('[SeedingManager] Already seeding:', key.slice(0, 32));
      const existing = this.activeSeeds.get(key)
      const updatedSeedInfo = {
        ...existing,
        reason: mergeSeedReason(existing.reason, reason),
        blocks: blobInfo?.blockLength || existing.blocks || 0,
        bytes: normalizeByteLength(blobInfo, existing.bytes || 0),
        publicBeeKey: blobInfo?.publicBeeKey || existing.publicBeeKey || null,
        blobId: blobInfo?.blobId || existing.blobId || null,
        blobsCoreKey: blobInfo?.blobsCoreKey || existing.blobsCoreKey || null,
        thumbnailBlobId: blobInfo?.thumbnailBlobId || existing.thumbnailBlobId || null,
        thumbnailBlobsCoreKey: blobInfo?.thumbnailBlobsCoreKey || existing.thumbnailBlobsCoreKey || null,
        mimeType: blobInfo?.mimeType || existing.mimeType || null,
        thumbnailMimeType: blobInfo?.thumbnailMimeType || existing.thumbnailMimeType || null
      }
      this.activeSeeds.set(key, updatedSeedInfo)
      await this.persistSeeds()
      const protectedKeys = normalizeProtectedSeedKeys(options.protectedKeys)
      if (options.protectSelf) protectedKeys.add(key)
      await this.enforceQuota({ protectedKeys });
      return false;
    }

    /** @type {SeedInfo} */
    const seedInfo = {
      driveKey,
      videoPath,
      reason,
      addedAt: Date.now(),
      blocks: blobInfo?.blockLength || 0,
      bytes: normalizeByteLength(blobInfo, 0),
      publicBeeKey: blobInfo?.publicBeeKey || null,
      blobId: blobInfo?.blobId || null,
      blobsCoreKey: blobInfo?.blobsCoreKey || null,
      thumbnailBlobId: blobInfo?.thumbnailBlobId || null,
      thumbnailBlobsCoreKey: blobInfo?.thumbnailBlobsCoreKey || null,
      mimeType: blobInfo?.mimeType || null,
      thumbnailMimeType: blobInfo?.thumbnailMimeType || null
    };

    this.activeSeeds.set(key, seedInfo);
    await this.persistSeeds();

    console.log('[SeedingManager] Added seed:', videoPath, 'reason:', reason, 'bytes:', seedInfo.bytes);

    // Enforce quota
    const protectedKeys = normalizeProtectedSeedKeys(options.protectedKeys)
    if (options.protectSelf) protectedKeys.add(key)
    await this.enforceQuota({ protectedKeys });

    return true;
  }

  /**
   * Remove a seed
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<boolean>}
   */
  async removeSeed(driveKey, videoPath, options = {}) {
    const key = `${driveKey}:${videoPath}`;
    if (this.activeSeeds.has(key)) {
      const seed = this.activeSeeds.get(key);
      this.activeSeeds.delete(key);
      let clearedBlob = false;
      if (options.clearBlob !== false) {
        clearedBlob = await this.clearSeedBlob(seed);
      }
      await this.persistSeeds();
      if (clearedBlob) {
        await collectCorestoreGarbage(this.store, {
          label: 'seed removal',
          log: console.log
        });
      }
      console.log('[SeedingManager] Removed seed:', key.slice(0, 32));
      return true;
    }
    return false;
  }

  /**
   * Pin a channel for always seeding
   * @param {string} driveKey
   */
  async pinChannel(driveKey, options = {}) {
    this.assertAuthorizedMutation(options)
    this.pinnedChannels.add(driveKey);
    await this.persistPinnedChannels();
    console.log('[SeedingManager] Pinned channel:', driveKey.slice(0, 16));
  }

  /**
   * Unpin a channel
   * @param {string} driveKey
   */
  async unpinChannel(driveKey, options = {}) {
    this.assertAuthorizedMutation(options)
    this.pinnedChannels.delete(driveKey);
    await this.persistPinnedChannels();
    console.log('[SeedingManager] Unpinned channel:', driveKey.slice(0, 16));
  }

  /**
   * Update seeding config
   * @param {Partial<SeedingConfig>} newConfig
   */
  async setConfig(newConfig, options = {}) {
    this.assertAuthorizedMutation(options)
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
        addedAt: s.addedAt,
        publicBeeKey: s.publicBeeKey || null,
        blobId: s.blobId || null,
        blobsCoreKey: s.blobsCoreKey || null,
        thumbnailBlobId: s.thumbnailBlobId || null,
        thumbnailBlobsCoreKey: s.thumbnailBlobsCoreKey || null,
        mimeType: s.mimeType || null,
        thumbnailMimeType: s.thumbnailMimeType || null
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
   * Update the locally cached byte accounting for an already tracked seed.
   * This is cache bookkeeping, not an explicit channel/seeding mutation, so it
   * can be driven by automatic playback downloads without an active identity.
   * @param {string} driveKey
   * @param {string} videoPath
   * @param {number} byteLength
   * @param {{ persist?: boolean }} [options]
   */
  async updateSeedCachedBytes(driveKey, videoPath, byteLength, options = {}) {
    const key = `${driveKey}:${videoPath}`;
    const seed = this.activeSeeds.get(key);
    if (!seed) return false;

    const nextBytes = Math.max(0, Math.round(Number(byteLength) || 0));
    if (nextBytes === (seed.bytes || 0)) return false;

    this.activeSeeds.set(key, { ...seed, bytes: nextBytes });
    if (options.persist === true) await this.persistSeeds();
    return true;
  }

  /**
   * Enforce storage quota by removing old/low-priority seeds
   */
  async enforceQuota(options = {}) {
    const protectedKeys = normalizeProtectedSeedKeys(options.protectedKeys)
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    let trackedBytes = this.calculateStorage();
    const totalStorageBytes = await this.getTotalStorageBytes();
    let quotaBytes = Number.isFinite(totalStorageBytes)
      ? Math.max(trackedBytes, totalStorageBytes)
      : trackedBytes;

    if (quotaBytes <= maxBytes) {
      return; // Under quota
    }

    console.log('[SeedingManager] Over quota, current:', trackedBytes, 'total:', totalStorageBytes ?? 'unavailable', 'max:', maxBytes);

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
    let clearedBlob = false;
    for (const seed of seeds) {
      if (quotaBytes <= maxBytes) break;
      if (seed.reason === 'pinned') continue; // Never remove pinned
      if (protectedKeys.has(seed.key) || this.shouldSkipSeedClear(seed)) continue;

      this.activeSeeds.delete(seed.key);
      clearedBlob = (await this.clearSeedBlob(seed)) || clearedBlob;
      const seedBytes = Math.max(0, Number(seed.bytes) || 0);
      trackedBytes = Math.max(0, trackedBytes - seedBytes);
      quotaBytes = Math.max(trackedBytes, quotaBytes - seedBytes);
      console.log('[SeedingManager] Removed seed to meet quota:', seed.key.slice(0, 32));
    }

    await this.persistSeeds();

    if (clearedBlob) {
      await collectCorestoreGarbage(this.store, {
        label: 'quota enforcement',
        log: console.log
      });
    }
  }

  /**
   * Clear the Hypercore block range for a cached seed.
   * @param {SeedInfo & { blobId?: string | object | null, blobsCoreKey?: string | null }} seed
   * @returns {Promise<boolean>}
   */
  async clearSeedBlob(seed) {
    const ref = normalizeSeedBlobRef(seed);
    if (!ref) return false;

    try {
      const core = this.store.get(Buffer.from(ref.blobsCoreKey, 'hex'));
      await core.ready?.();
      const start = ref.blob.blockOffset;
      const end = ref.blob.blockOffset + ref.blob.blockLength;
      if (typeof core.clear === 'function') {
        await core.clear(start, end);
        console.log('[SeedingManager] Cleared cached blob range:', ref.blobsCoreKey.slice(0, 16), start, end);
        return true;
      }
    } catch (err) {
      console.log('[SeedingManager] Failed to clear cached blob range:', err?.message);
    }

    return false;
  }

  /**
   * Clear persisted partial download intents that reserve cache storage but may
   * not have been promoted into activeSeeds yet.
   * @param {{ excludeKeys?: Set<string> | string[] }} [options]
   * @returns {Promise<{ clearedBytes: number, clearedCount: number, clearedBlob: boolean }>}
   */
  async clearDownloadIntents(options = {}) {
    const excludeKeys = normalizeProtectedSeedKeys(options.excludeKeys)
    if (typeof this.metaDb?.createReadStream !== 'function') {
      return { clearedBytes: 0, clearedCount: 0, clearedBlob: false }
    }

    const entries = []
    for await (const entry of this.metaDb.createReadStream({ gte: 'download-intent:', lt: 'download-intent:~' })) {
      const intent = entry?.value
      if (!intent?.driveKey || !intent?.videoPath) continue
      const seedKey = `${intent.driveKey}:${intent.videoPath}`
      if (excludeKeys.has(seedKey) || this.shouldSkipSeedClear(intent)) continue
      entries.push({ key: entry.key, seedKey, intent })
    }

    let clearedBytes = 0
    let clearedBlob = false
    for (const entry of entries) {
      const intent = entry.intent
      clearedBytes += Math.max(0, Number(intent.totalBytes || intent.byteLength || 0) || 0)
      clearedBlob = (await this.clearSeedBlob({
        driveKey: intent.driveKey,
        videoPath: intent.videoPath,
        blobId: intent.blobId || null,
        blobsCoreKey: intent.blobsCoreKey || null
      })) || clearedBlob
      await this.metaDb.del?.(entry.key)
      this.activeSeeds.delete(entry.seedKey)
    }

    if (entries.length > 0) await this.persistSeeds()
    return { clearedBytes: Math.round(clearedBytes), clearedCount: entries.length, clearedBlob }
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
  async setMaxStorageGB(gb, options = {}) {
    this.assertAuthorizedMutation(options)
    const previousMaxStorageGB = this.config.maxStorageGB;
    if (gb < 1) gb = 1;
    if (gb > 100) gb = 100;
    this.config.maxStorageGB = gb;
    await this.metaDb.put('seeding-config', this.config);
    console.log('[SeedingManager] Set max storage to', gb, 'GB');
    if (gb < previousMaxStorageGB) {
      const partials = await this.clearDownloadIntents()
      if (partials.clearedBlob) {
        await collectCorestoreGarbage(this.store, {
          label: 'partial download intent clear',
          log: console.log
        });
      }
    }
    // Enforce quota with the new limit after any lower-limit partial cleanup.
    await this.enforceQuota();
  }

  async getTotalStorageBytes() {
    if (!this.getDiskUsageBytes) return null;
    try {
      const value = await this.getDiskUsageBytes();
      return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    } catch (err) {
      console.log('[SeedingManager] Failed to measure total storage:', err?.message);
      return null;
    }
  }

  buildStorageStats(totalStorageBytes = null) {
    const usedBytes = Math.round(this.calculateStorage());
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    const measuredTotal = Number.isFinite(totalStorageBytes) && totalStorageBytes >= 0
      ? Math.round(totalStorageBytes)
      : usedBytes;
    const untrackedStorageBytes = Math.max(0, measuredTotal - usedBytes);
    return {
      usedBytes,
      maxBytes,
      usedGB: formatBytesAsGB(usedBytes),
      maxGB: this.config.maxStorageGB,
      seedCount: this.activeSeeds.size,
      pinnedCount: this.pinnedChannels.size,
      totalStorageBytes: measuredTotal,
      totalStorageGB: formatBytesAsGB(measuredTotal),
      untrackedStorageBytes,
      untrackedStorageGB: formatBytesAsGB(untrackedStorageBytes)
    };
  }

  getStorageStatsSync() {
    return this.buildStorageStats(null);
  }

  /**
   * Get storage stats for UI display
   * @returns {Promise<{ usedBytes: number, maxBytes: number, usedGB: string, maxGB: number, seedCount: number, pinnedCount: number, totalStorageBytes: number, totalStorageGB: string, untrackedStorageBytes: number, untrackedStorageGB: string }>}
   */
  async getStorageStats() {
    return this.buildStorageStats(await this.getTotalStorageBytes());
  }

  /**
   * Clear all non-pinned cached content
   * @returns {Promise<{ clearedBytes: number, totalStorageBytes: number, totalStorageGB: string, untrackedStorageBytes: number, untrackedStorageGB: string }>} bytes cleared and post-clear total storage snapshot
   */
  async clearCache(options = {}) {
    this.assertAuthorizedMutation(options)
    let clearedBytes = 0;
    const toRemove = [];
    let clearedBlob = false;

    for (const [key, seed] of this.activeSeeds.entries()) {
      if (seed.reason !== 'pinned' && !this.shouldSkipSeedClear(seed)) {
        clearedBytes += seed.bytes || 0;
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      const seed = this.activeSeeds.get(key);
      this.activeSeeds.delete(key);
      clearedBlob = (await this.clearSeedBlob(seed)) || clearedBlob;
    }

    const partials = await this.clearDownloadIntents({ excludeKeys: new Set(this.activeSeeds.keys()) })
    clearedBytes += partials.clearedBytes
    clearedBlob = partials.clearedBlob || clearedBlob

    await this.persistSeeds();

    if (clearedBlob) {
      await collectCorestoreGarbage(this.store, {
        label: 'cache clear',
        log: console.log
      });
    }

    console.log('[SeedingManager] Cleared cache:', clearedBytes, 'bytes from', toRemove.length, 'seeds');
    const stats = this.buildStorageStats(await this.getTotalStorageBytes());
    return {
      clearedBytes: Math.round(clearedBytes),
      totalStorageBytes: stats.totalStorageBytes,
      totalStorageGB: stats.totalStorageGB,
      untrackedStorageBytes: stats.untrackedStorageBytes,
      untrackedStorageGB: stats.untrackedStorageGB
    };
  }

  clearCacheSync() {
    return this.buildStorageStats(null);
  }
}
