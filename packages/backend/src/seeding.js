/**
 * SeedingManager - Distributed Content Availability
 *
 * "Pied Piper" model: viewers become seeders.
 * Handles content seeding with storage quotas and prioritization.
 */

import { normalizeBlobsCoreKey, normalizeBlobRefInput, stringifyBlobId } from './blob-ref.js';
import { collectCorestoreGarbage } from './corestore-gc.js';
import {
  DEFAULT_PARTICIPATION_MODE,
  PARTICIPATION_LIMITS,
} from './playback/resource-policy.js';

const DEFAULT_STORAGE_MAINTENANCE_DELAY_MS = 30000
const BYTES_PER_GB = 1024 * 1024 * 1024
// How long an on-disk measurement is reused for admission decisions. Long
// enough that a burst of checks walks the tree once; short enough that a
// download admitted now is measured against something taken seconds ago.
const QUOTA_MEASUREMENT_TTL_MS = 5000
// The cache ceiling is decided by the participation policy; this manager reads
// it rather than keeping a second opinion. It is only a pre-policy starting
// value: applyNetworkPolicy replaces it on the first policy application.
const DEFAULT_PARTICIPATION_LIMITS = PARTICIPATION_LIMITS[DEFAULT_PARTICIPATION_MODE]

export const STORAGE_CATEGORY_FIELDS = Object.freeze([
  'ownedOriginalBytes',
  'immutablePublicationBytes',
  'pledgedArchiveBytes',
  'localCacheBytes',
  'thumbnailBytes',
  'indexBytes',
  'temporaryTransferBytes'
])

function normalizeStorageBytes(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

export function buildStorageCategoryTotals(usage = {}) {
  const categories = {}
  for (const field of STORAGE_CATEGORY_FIELDS) {
    categories[field] = normalizeStorageBytes(usage[field])
  }
  const protectedBytes = categories.ownedOriginalBytes
    + categories.immutablePublicationBytes
    + categories.pledgedArchiveBytes
  const evictableBytes = categories.localCacheBytes
    + categories.thumbnailBytes
    + categories.indexBytes
    + categories.temporaryTransferBytes
  return {
    ...categories,
    totalCategorizedBytes: protectedBytes + evictableBytes,
    evictableBytes,
    protectedBytes
  }
}

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

function resolveStorageMaintenanceDelayMs(value) {
  const explicit = Number(value)
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit)

  const envValue = Number(globalThis?.process?.env?.PEARTUBE_STORAGE_MAINTENANCE_DELAY_MS)
  if (Number.isFinite(envValue) && envValue >= 0) return Math.floor(envValue)

  return DEFAULT_STORAGE_MAINTENANCE_DELAY_MS
}

/**
 * Admission rule for the actively-playing video's full background download.
 * A single watch otherwise background-caches the entire file to disk (the
 * playback window cache only trims *behind* the playhead, while the fill races
 * ahead to EOF), so a large video blows past the storage quota mid-watch.
 *
 * Returns true only when the bytes still needed to fully cache the video fit
 * within the remaining quota headroom. Zero/unknown remaining always fits.
 * @param {number} headroomBytes
 * @param {number} remainingBytes
 * @returns {boolean}
 */
export function fullDownloadFitsQuota(headroomBytes, remainingBytes) {
  const remaining = Math.max(0, Number(remainingBytes) || 0)
  if (remaining === 0) return true
  const headroom = Math.max(0, Number(headroomBytes) || 0)
  return headroom >= remaining
}

const SEED_REASON_PRIORITY = Object.freeze({
  watched: 1,
  subscribed: 2,
  pinned: 3,
  pledged: 4,
  archive: 4
})

function isProtectedSeedReason(reason) {
  return reason === 'pinned' || reason === 'pledged' || reason === 'archive'
}

function mergeSeedReason(existingReason, nextReason) {
  return (SEED_REASON_PRIORITY[nextReason] || 0) > (SEED_REASON_PRIORITY[existingReason] || 0)
    ? nextReason
    : existingReason
}

function retentionClassForReason(reason) {
  return isProtectedSeedReason(reason) ? 'archive-pin' : 'contribution-cache'
}

function seedStorageBytes(seed) {
  return normalizeStorageBytes(seed?.bytes) + normalizeStorageBytes(seed?.thumbnailBytes)
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
   * @param {{ getDiskUsageBytes?: () => number | Promise<number>, getStorageCategoryUsage?: () => Object | Promise<Object>, isCacheClearBlocked?: () => boolean, storageMaintenanceDelayMs?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
   */
  constructor(store, metaDb, options = {}) {
    this.store = store;
    this.metaDb = metaDb;
    this.identityManager = options.identityManager || null;
    // Sub-encoded metaDb keyspaces (download intents live here).
    this.metaSubspaces = options.metaSubspaces || null;
    this.requiresIdentityAuthorization = Object.prototype.hasOwnProperty.call(options, 'identityManager');
    this.getDiskUsageBytes = typeof options.getDiskUsageBytes === 'function'
      ? options.getDiskUsageBytes
      : (typeof store?.getDiskUsageBytes === 'function' ? () => store.getDiskUsageBytes() : null);
    this.getStorageCategoryUsage = typeof options.getStorageCategoryUsage === 'function'
      ? options.getStorageCategoryUsage
      : null;
    this.isCacheClearBlocked = typeof options.isCacheClearBlocked === 'function'
      ? options.isCacheClearBlocked
      : null;
    this.storageMaintenanceDelayMs = resolveStorageMaintenanceDelayMs(options.storageMaintenanceDelayMs);
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    /** @type {Map<string, SeedInfo>} key: `${driveKey}:${videoPath}` -> seed info */
    this.activeSeeds = new Map();
    /** @type {Map<string, number>} blobsCoreKey -> active playback/prefetch retain count */
    this.protectedBlobCores = new Map();
    /** @type {Map<string, number>} blobsCoreKey -> active archive custody retain count */
    this.protectedArchiveCores = options.protectedArchiveCores instanceof Map ? options.protectedArchiveCores : new Map();
    /** @type {Set<string>} driveKeys that are pinned (always seed) */
    this.pinnedChannels = new Set();
    /** @type {ReturnType<typeof setTimeout> | null} pending throttled seed persist */
    this._seedPersistTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} pending storage compaction timer */
    this._storageMaintenanceTimer = null;
    /** @type {number | null} last successful on-disk measurement, in bytes */
    this._measuredStorageBytes = null;
    /** @type {number} when that measurement was taken */
    this._measuredStorageAt = 0;
    this._storageMaintenanceCompacting = false;
    this._storageMaintenancePendingLabel = null;
    /** @type {SeedingConfig} */
    this.config = {
      // The seeded-content quota is the participation cache ceiling, not a
      // number chosen here: a fresh install runs Balanced, so it is 20 GiB.
      maxStorageGB: DEFAULT_PARTICIPATION_LIMITS.cacheCeilingBytes / BYTES_PER_GB,
      autoSeedWatched: true,      // Automatically seed videos you watch
      autoSeedSubscribed: false,  // Automatically seed subscribed channels (opt-in)
      maxVideosPerChannel: 10     // Max videos to seed per channel if auto-seeding subscriptions
    };
    /**
     * What this device is actually permitted to send, as confirmed by the
     * component that enforces it. This manager enforces nothing on the
     * outbound path - the scoped network transport does - so it reports a rate
     * only when the transport has said it is applying that exact rate. A
     * number nobody enforces is worse than no number: it reads like a cap in
     * getStatus() and in the UI while the uplink runs flat out.
     * @type {{uploadAllowed: boolean, outboundBytesPerSecond: number | null, outboundRateEnforced: boolean}}
     */
    this.contribution = {
      uploadAllowed: false,
      outboundBytesPerSecond: null,
      outboundRateEnforced: false,
    };
    this.retentionPolicy = {
      contributeWatchedMedia: false,
      archiveEnabled: false,
      contributionBudgetBytes: 0,
      archiveBudgetBytes: 0,
      migrationRequired: true
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
    return Boolean(ref && (
      this.protectedBlobCores.has(ref.blobsCoreKey) ||
      this.protectedArchiveCores.has(ref.blobsCoreKey)
    ))
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

  scheduleCorestoreCompaction(label = 'cache clear compaction') {
    if (typeof this.store?.storage?.compact !== 'function') return false

    this._storageMaintenancePendingLabel = label
    if (this._storageMaintenanceTimer || this._storageMaintenanceCompacting) return true

    let timer = null
    timer = this.setTimer(() => {
      if (this._storageMaintenanceTimer === timer) this._storageMaintenanceTimer = null
      return this.runScheduledCorestoreCompaction()
    }, this.storageMaintenanceDelayMs)
    this._storageMaintenanceTimer = timer
    timer?.unref?.()
    return true
  }

  async runScheduledCorestoreCompaction() {
    if (this.isCacheClearBlockedNow()) {
      this.scheduleCorestoreCompaction(this._storageMaintenancePendingLabel || 'cache clear compaction')
      return { compacted: false, blocked: true }
    }
    if (this._storageMaintenanceCompacting) return { compacted: false, running: true }

    this._storageMaintenanceCompacting = true
    const label = this._storageMaintenancePendingLabel || 'cache clear compaction'
    this._storageMaintenancePendingLabel = null
    try {
      return await collectCorestoreGarbage(this.store, {
        label,
        log: console.log,
        skipFlush: true
      })
    } finally {
      this._storageMaintenanceCompacting = false
      if (this._storageMaintenancePendingLabel) this.scheduleCorestoreCompaction(this._storageMaintenancePendingLabel)
    }
  }

  async flushClearedBlobRanges(label) {
    await collectCorestoreGarbage(this.store, {
      label,
      log: console.log,
      skipCompact: true
    });
    this.scheduleCorestoreCompaction(`${label} compaction`);
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
        this.activeSeeds.set(key, {
          ...info,
          retentionClass: info.retentionClass || retentionClassForReason(info.reason)
        });
      }
      console.log('[SeedingManager] Loaded', this.activeSeeds.size, 'active seeds');
    }
  }


  retentionUsage(excludeKey = null) {
    const usage = { contributionUsedBytes: 0, archiveUsedBytes: 0 }
    for (const [key, seed] of this.activeSeeds) {
      if (key === excludeKey) continue
      const field = seed.retentionClass === 'archive-pin' ? 'archiveUsedBytes' : 'contributionUsedBytes'
      usage[field] += seedStorageBytes(seed)
    }
    return usage
  }

  assertRetentionAdmission(reason, blobInfo, existingKey = null) {
    const retentionClass = retentionClassForReason(reason)
    const policy = this.retentionPolicy
    const allowed = retentionClass === 'archive-pin'
      ? policy.archiveEnabled
      : policy.contributeWatchedMedia
    const budget = retentionClass === 'archive-pin'
      ? policy.archiveBudgetBytes
      : policy.contributionBudgetBytes
    if (policy.migrationRequired || !allowed || budget <= 0) {
      throw new SeedingAuthorizationError(`explicit ${retentionClass} permission is required`)
    }
    const usage = this.retentionUsage(existingKey)
    const used = retentionClass === 'archive-pin'
      ? usage.archiveUsedBytes
      : usage.contributionUsedBytes
    const requested = normalizeByteLength(blobInfo, 0) +
      normalizeStorageBytes(blobInfo?.thumbnailByteLength)
    if (used + requested > budget) {
      throw new SeedingAuthorizationError(`${retentionClass} budget exceeded`)
    }
    return retentionClass
  }

  /**
   * Add a seed for a video
   * @param {string} driveKey
   * @param {string} videoPath
   * @param {'watched'|'pinned'|'subscribed'|'pledged'|'archive'} reason
   * @param {{blockLength?: number, byteLength?: number, thumbnailByteLength?: number, publicBeeKey?: string | null, blobId?: string | null, blobsCoreKey?: string | null, thumbnailBlobId?: string | null, thumbnailBlobsCoreKey?: string | null, mimeType?: string | null, thumbnailMimeType?: string | null}} [blobInfo]
   * @param {{protectSelf?: boolean, protectedKeys?: string[] | Set<string>}} [options]
   * @returns {Promise<boolean>}
   */
  async addSeed(driveKey, videoPath, reason, blobInfo, options = {}) {
    this.assertAuthorizedForSeed(driveKey, reason, options)
    const key = `${driveKey}:${videoPath}`;
    const existingSeed = this.activeSeeds.get(key)
    const mergedReason = existingSeed ? mergeSeedReason(existingSeed.reason, reason) : reason
    const retentionClass = this.assertRetentionAdmission(mergedReason, blobInfo, key)

    if (!this.config.autoSeedWatched && reason === 'watched') {
      console.log('[SeedingManager] Auto-seed watched disabled, skipping');
      return false;
    }

    // Admission is rechecked at the mutation boundary above.

    // Check if already seeding
    if (existingSeed) {
      console.log('[SeedingManager] Already seeding:', key.slice(0, 32));
      const existing = existingSeed
      const updatedSeedInfo = {
        ...existing,
        reason: mergedReason,
        retentionClass,
        blocks: blobInfo?.blockLength || existing.blocks || 0,
        bytes: normalizeByteLength(blobInfo, existing.bytes || 0),
        thumbnailBytes: blobInfo?.thumbnailByteLength == null
          ? normalizeStorageBytes(existing.thumbnailBytes)
          : normalizeStorageBytes(blobInfo.thumbnailByteLength),
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
      retentionClass,
      addedAt: Date.now(),
      blocks: blobInfo?.blockLength || 0,
      bytes: normalizeByteLength(blobInfo, 0),
      thumbnailBytes: normalizeStorageBytes(blobInfo?.thumbnailByteLength),
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
      if (seed.retentionClass === 'archive-pin' && options.archivePinRemoval !== true) {
        return false;
      }
      this.activeSeeds.delete(key);
      let clearedBlob = false;
      if (options.clearBlob !== false) {
        clearedBlob = await this.clearSeedBlob(seed);
      }
      await this.persistSeeds();
      if (clearedBlob) {
        await this.flushClearedBlobRanges('seed removal');
      }
      console.log('[SeedingManager] Removed seed:', key.slice(0, 32));
      return true;
    }
    return false;
  }

  /**
   * Remove an archive pin only through an explicit archive operation.
   * Generic cache eviction/removal cannot release archival custody.
   */
  async removeArchivePin(driveKey, videoPath, options = {}) {
    const key = `${driveKey}:${videoPath}`;
    const seed = this.activeSeeds.get(key);
    if (!seed || seed.retentionClass !== 'archive-pin') return false;
    return this.removeSeed(driveKey, videoPath, { ...options, archivePinRemoval: true });
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

  async applyNetworkPolicy({
    diskCeilingBytes,
    uploadAllowed,
    outboundBytesPerSecond,
    outboundRateEnforced,
    contributeWatchedMedia = false,
    archiveEnabled = false,
    contributionBudgetBytes = 0,
    archiveBudgetBytes = 0,
    migrationRequired = true
  } = {}) {
    // The operator ceiling is optional: a consent-only policy carries just the
    // per-class budgets. When it is supplied it must still be a real byte count.
    const ceilingProvided = diskCeilingBytes !== undefined && diskCeilingBytes !== null
    const ceiling = ceilingProvided ? Number(diskCeilingBytes) : Number.POSITIVE_INFINITY
    if (ceilingProvided && (!Number.isSafeInteger(ceiling) || ceiling < 0)) {
      throw new TypeError('diskCeilingBytes must be a non-negative safe integer')
    }
    // Only the transport that applied the rate may claim it. Without that
    // confirmation there is no cap to report, whatever number was requested.
    const outbound = Number(outboundBytesPerSecond)
    const enforced = outboundRateEnforced === true &&
      Number.isSafeInteger(outbound) && outbound >= 0
    this.contribution = {
      uploadAllowed: uploadAllowed === true,
      outboundBytesPerSecond: enforced ? outbound : null,
      outboundRateEnforced: enforced,
    }
    const contribution = normalizeStorageBytes(contributionBudgetBytes)
    const archive = normalizeStorageBytes(archiveBudgetBytes)
    this.retentionPolicy = {
      contributeWatchedMedia: contributeWatchedMedia === true && migrationRequired !== true,
      archiveEnabled: archiveEnabled === true && migrationRequired !== true,
      contributionBudgetBytes: contribution,
      archiveBudgetBytes: archive,
      migrationRequired: migrationRequired === true
    }
    // Two caps now describe the same disk: the operator's absolute ceiling and
    // the per-class retention budgets. Honour whichever is tighter so neither
    // the operator's limit nor a class budget can be exceeded.
    const budgetedBytes = contribution + archive
    const effectiveBytes = budgetedBytes > 0 ? Math.min(ceiling, budgetedBytes) : (ceilingProvided ? ceiling : 0)
    const previousBytes = this.config.maxStorageGB * BYTES_PER_GB
    this.config = {
      ...this.config,
      maxStorageGB: effectiveBytes / BYTES_PER_GB
    }
    await this.metaDb.put('seeding-config', this.config)
    if (effectiveBytes < previousBytes) {
      const partials = await this.clearDownloadIntents()
      if (partials.clearedBlob) await this.flushClearedBlobRanges('policy partial download clear')
    }
    await this.enforceContributionRetention()
    await this.enforceArchiveRetention()
    await this.enforceQuota()
    return {
      diskCeilingBytes: ceilingProvided ? ceiling : null,
      ...this.contribution,
      ...this.getRetentionBudgetStatus()
    }
  }

  async enforceContributionRetention() {
    const policy = this.retentionPolicy
    const candidates = Array.from(this.activeSeeds.entries())
      .filter(([, seed]) => seed.retentionClass !== 'archive-pin')
      .sort((left, right) => {
        const age = normalizeStorageBytes(left[1].addedAt) - normalizeStorageBytes(right[1].addedAt)
        return age || left[0].localeCompare(right[0])
      })
    let used = candidates.reduce((total, [, seed]) => total + seedStorageBytes(seed), 0)
    const allowed = !policy.migrationRequired && policy.contributeWatchedMedia
    let clearedBlob = false
    for (const [key, seed] of candidates) {
      if (allowed && used <= policy.contributionBudgetBytes) break
      this.activeSeeds.delete(key)
      used -= seedStorageBytes(seed)
      clearedBlob = (await this.clearSeedBlob(seed)) || clearedBlob
    }
    await this.persistSeeds()
    if (clearedBlob) await this.flushClearedBlobRanges('contribution retention policy')
  }

  async enforceArchiveRetention() {
    const policy = this.retentionPolicy
    const candidates = Array.from(this.activeSeeds.entries())
      .filter(([, seed]) => seed.retentionClass === 'archive-pin')
      .sort((left, right) => {
        const age = normalizeStorageBytes(left[1].addedAt) - normalizeStorageBytes(right[1].addedAt)
        return age || left[0].localeCompare(right[0])
      })
    let used = candidates.reduce((total, [, seed]) => total + seedStorageBytes(seed), 0)
    const allowed = !policy.migrationRequired && policy.archiveEnabled
    let clearedBlob = false
    for (const [key, seed] of candidates) {
      if (allowed && used <= policy.archiveBudgetBytes) break
      this.activeSeeds.delete(key)
      used -= seedStorageBytes(seed)
      clearedBlob = (await this.clearSeedBlob(seed)) || clearedBlob
    }
    await this.persistSeeds()
    if (clearedBlob) await this.flushClearedBlobRanges('archive retention policy')
  }

  getRetentionBudgetStatus() {
    const usage = this.retentionUsage()
    return {
      ...this.retentionPolicy,
      ...usage
    }
  }

  /**
   * Get seeding status
   * @returns {Promise<Object>}
   */
  async getStatus() {
    const retention = this.getRetentionBudgetStatus()
    return {
      activeSeeds: this.activeSeeds.size,
      activeContributionSeeds: Array.from(this.activeSeeds.values())
        .filter(seed => seed.retentionClass !== 'archive-pin').length,
      activeArchivePins: Array.from(this.activeSeeds.values())
        .filter(seed => seed.retentionClass === 'archive-pin').length,
      pinnedChannels: this.pinnedChannels.size,
      storageUsedBytes: retention.contributionUsedBytes + retention.archiveUsedBytes,
      storageUsedGB: ((retention.contributionUsedBytes + retention.archiveUsedBytes) / (1024 * 1024 * 1024)).toFixed(2),
      maxStorageGB: this.config.maxStorageGB,
      contribution: { ...this.contribution },
      retention,
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

  _planStorageLimit(requestedMaxBytes, options = {}) {
    const currentUsedBytes = Array.from(this.activeSeeds.values())
      .reduce((total, seed) => total + normalizeStorageBytes(seed.bytes), 0)
    const maxBytes = Number(requestedMaxBytes)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      return {
        preview: {
          success: false,
          requestedMaxBytes: 0,
          currentUsedBytes,
          requiredEvictionBytes: 0,
          evictableBytes: 0,
          protectedBytes: currentUsedBytes,
          affectedSeedCount: 0,
          affectedCategories: [],
          consequences: [],
          feasible: false,
          errorCode: 'INVALID_STORAGE_LIMIT'
        },
        candidates: []
      }
    }

    const protectedKeys = normalizeProtectedSeedKeys(options.protectedKeys)
    const orderedSeeds = Array.from(this.activeSeeds.entries())
      .map(([key, info]) => ({ key, ...info }))
      .sort((a, b) => {
        const priorityDiff = (SEED_REASON_PRIORITY[a.reason] || 0) - (SEED_REASON_PRIORITY[b.reason] || 0)
        if (priorityDiff !== 0) return priorityDiff
        const ageDiff = normalizeStorageBytes(a.addedAt) - normalizeStorageBytes(b.addedAt)
        if (ageDiff !== 0) return ageDiff
        return a.key.localeCompare(b.key)
      })

    const evictableSeeds = []
    let evictableBytes = 0
    let protectedBytes = 0
    for (const seed of orderedSeeds) {
      const bytes = normalizeStorageBytes(seed.bytes)
      if (isProtectedSeedReason(seed.reason)
        || (options.ignoreTransientProtection !== true
          && (protectedKeys.has(seed.key) || this.shouldSkipSeedClear(seed)))) {
        protectedBytes += bytes
      } else {
        evictableSeeds.push(seed)
        evictableBytes += bytes
      }
    }

    const requiredEvictionBytes = Math.max(0, currentUsedBytes - maxBytes)
    const candidates = []
    let plannedEvictionBytes = 0
    for (const seed of evictableSeeds) {
      if (plannedEvictionBytes >= requiredEvictionBytes) break
      candidates.push(seed)
      plannedEvictionBytes += normalizeStorageBytes(seed.bytes)
    }
    const affectedSeedCount = candidates.length
    const consequences = affectedSeedCount === 0
      ? []
      : [
          `${affectedSeedCount} local cache seed${affectedSeedCount === 1 ? '' : 's'} will stop seeding on this device.`,
          'Evicted content may become unavailable if no other peer retains it.'
        ]
    const feasible = requiredEvictionBytes <= evictableBytes
    const preview = {
      success: true,
      requestedMaxBytes: maxBytes,
      currentUsedBytes,
      requiredEvictionBytes,
      evictableBytes,
      protectedBytes,
      affectedSeedCount,
      affectedCategories: affectedSeedCount === 0 ? [] : ['localCacheBytes'],
      consequences,
      feasible
    }
    if (!feasible) preview.errorCode = 'STORAGE_LIMIT_INFEASIBLE'
    return { preview, candidates }
  }

  previewStorageLimit(input = {}, options = {}) {
    return this._planStorageLimit(input?.maxBytes, options).preview
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
    const retentionClass = seed.retentionClass || retentionClassForReason(seed.reason)
    const policy = this.retentionPolicy
    const allowed = retentionClass === 'archive-pin' ? policy.archiveEnabled : policy.contributeWatchedMedia
    const budget = retentionClass === 'archive-pin' ? policy.archiveBudgetBytes : policy.contributionBudgetBytes
    const usage = this.retentionUsage(key)
    const otherUsed = retentionClass === 'archive-pin' ? usage.archiveUsedBytes : usage.contributionUsedBytes
    if (policy.migrationRequired || !allowed ||
        otherUsed + normalizeStorageBytes(seed.thumbnailBytes) + Math.max(0, Math.round(Number(byteLength) || 0)) > budget) {
      return false
    }

    const nextBytes = Math.max(0, Math.round(Number(byteLength) || 0));
    if (nextBytes === (seed.bytes || 0)) return false;

    this.activeSeeds.set(key, { ...seed, bytes: nextBytes });
    // Persist cached-byte progress so the accounting survives an app relaunch.
    // Without this, a video that was streamed/partially cached (the common
    // mobile case — the full background download never finished) reset to its
    // initial byte count, which is usually 0, on the next launch. That left the
    // storage card stuck at zero even though blocks were cached on disk.
    // Per-block download events are frequent, so coalesce writes with a timer
    // unless the caller asks for an immediate flush.
    if (options.persist === true) {
      await this.flushSeedPersist();
    } else {
      this.scheduleSeedPersist();
    }
    return true;
  }

  scheduleSeedPersist() {
    if (this._seedPersistTimer) return;
    this._seedPersistTimer = setTimeout(() => {
      this._seedPersistTimer = null;
      this.persistSeeds().catch((err) => {
        console.log('[SeedingManager] Deferred seed persist failed:', err?.message);
      });
    }, 5000);
    // Best-effort flush — never hold the process open just for this.
    this._seedPersistTimer?.unref?.();
  }

  async flushSeedPersist() {
    if (this._seedPersistTimer) {
      clearTimeout(this._seedPersistTimer);
      this._seedPersistTimer = null;
    }
    await this.persistSeeds();
  }

  /**
   * Enforce storage quota by removing old/low-priority seeds.
   *
   * Serialized: clearing blob ranges + Corestore compaction is slow, and two
   * overlapping passes could interleave deletes on activeSeeds or double-clear a
   * core. Callers (addSeed, setMaxStorageGB, the post-playback sweep) may fire
   * concurrently, so each pass runs after the previous one settles.
   */
  async enforceQuota(options = {}) {
    const run = (this._enforceQuotaChain || Promise.resolve())
      .catch(() => {})
      .then(() => this._enforceQuotaOnce(options))
    this._enforceQuotaChain = run
    return run
  }

  async _enforceQuotaOnce(options = {}) {
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    // The quota bounds content cached from the network (tracked seeds). The
    // user's own uploaded/published videos live in the same corestore but are
    // never registered as seeds, so they are excluded by construction. We must
    // NOT enforce against raw on-disk usage here: it commingles uploads with
    // cache, so doing so would evict the user's seeded cache to make room for
    // their own uploads — i.e. charge uploads against a limit they don't belong
    // to.
    const plan = this._planStorageLimit(maxBytes, options)
    if (plan.preview.requiredEvictionBytes === 0) return;

    console.log('[SeedingManager] Over cache quota, tracked:', plan.preview.currentUsedBytes, 'max:', maxBytes);

    let clearedBlob = false;
    for (const seed of plan.candidates) {
      this.activeSeeds.delete(seed.key);
      clearedBlob = (await this.clearSeedBlob(seed)) || clearedBlob;
      console.log('[SeedingManager] Removed seed to meet quota:', seed.key.slice(0, 32));
    }

    await this.persistSeeds();

    if (clearedBlob) {
      await this.flushClearedBlobRanges('quota enforcement');
    }
  }

  /**
   * Clear the main and thumbnail Hypercore block ranges for a cached seed.
   * @param {SeedInfo & { blobId?: string | object | null, blobsCoreKey?: string | null, thumbnailBlobId?: string | object | null, thumbnailBlobsCoreKey?: string | null }} seed
   * @returns {Promise<boolean>}
   */
  async clearSeedBlob(seed) {
    const refs = [
      normalizeSeedBlobRef(seed),
      normalizeSeedBlobRef({
        blobId: seed?.thumbnailBlobId,
        blobsCoreKey: seed?.thumbnailBlobsCoreKey
      })
    ].filter(Boolean)
    const seen = new Set()
    let cleared = false

    for (const ref of refs) {
      const refKey = `${ref.blobsCoreKey}:${ref.blobId}`
      if (seen.has(refKey)) continue
      seen.add(refKey)

      let core = null;
      try {
        core = this.store.get(Buffer.from(ref.blobsCoreKey, 'hex'));
        await core.ready?.();
        const start = ref.blob.blockOffset;
        const end = ref.blob.blockOffset + ref.blob.blockLength;
        if (typeof core.clear === 'function') {
          await core.clear(start, end);
          cleared = true
          console.log('[SeedingManager] Cleared cached blob range:', ref.blobsCoreKey.slice(0, 16), start, end);
        }
      } catch (err) {
        console.log('[SeedingManager] Failed to clear cached blob range:', err?.message);
      } finally {
        // store.get() opened a fresh session for this clear; release it so
        // evictions don't accumulate open core sessions.
        try { await core?.close?.(); } catch { /* best effort */ }
      }
    }

    return cleared;
  }

  /**
   * Clear persisted partial download intents that reserve cache storage but may
   * not have been promoted into activeSeeds yet.
   * @param {{ excludeKeys?: Set<string> | string[] }} [options]
   * @returns {Promise<{ clearedBytes: number, clearedCount: number, clearedBlob: boolean }>}
   */
  async clearDownloadIntents(options = {}) {
    const excludeKeys = normalizeProtectedSeedKeys(options.excludeKeys)
    const downloadIntents = this.metaSubspaces?.downloadIntents
    if (typeof downloadIntents?.createReadStream !== 'function') {
      return { clearedBytes: 0, clearedCount: 0, clearedBlob: false }
    }

    const entries = []
    for await (const entry of downloadIntents.createReadStream()) {
      const intent = entry?.value
      if (!intent?.driveKey || !intent?.videoPath) continue
      const seedKey = `${intent.driveKey}:${intent.videoPath}`
      if (isProtectedSeedReason(intent.reason) || excludeKeys.has(seedKey) || this.shouldSkipSeedClear(intent)) continue
      // entry.key is the decoded sub key (`${driveKey}:${videoPath}`).
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
      await downloadIntents.del(entry.key)
      this.activeSeeds.delete(entry.seedKey)
    }

    if (entries.length > 0) await this.persistSeeds()
    return { clearedBytes: Math.round(clearedBytes), clearedCount: entries.length, clearedBlob }
  }

  /**
   * Persist seeds to database
   */
  async persistSeeds() {
    // Any direct persist supersedes a pending throttled flush.
    if (this._seedPersistTimer) {
      clearTimeout(this._seedPersistTimer);
      this._seedPersistTimer = null;
    }
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
    const preview = this._planStorageLimit(
      gb * 1024 * 1024 * 1024,
      { ...options, ignoreTransientProtection: true }
    ).preview
    if (!preview.success || !preview.feasible) return preview;
    this.config.maxStorageGB = gb;
    await this.metaDb.put('seeding-config', this.config);
    console.log('[SeedingManager] Set max storage to', gb, 'GB');
    if (gb < previousMaxStorageGB) {
      const partials = await this.clearDownloadIntents()
      if (partials.clearedBlob) {
        await this.flushClearedBlobRanges('partial download intent clear');
      }
    }
    // Enforce quota with the new limit after any lower-limit partial cleanup.
    await this.enforceQuota();
    return preview;
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

  /**
   * The most recent on-disk measurement, taken at most once per
   * QUOTA_MEASUREMENT_TTL_MS. Walking the storage tree costs a stat per file,
   * which is fine occasionally and not fine on every admission check.
   *
   * A failed measurement keeps the previous reading rather than reverting to
   * "nothing is stored": an unmeasurable disk must never read as empty, or the
   * limit silently stops existing.
   * @returns {Promise<number | null>}
   */
  async getMeasuredStorageBytes({ maxAgeMs = QUOTA_MEASUREMENT_TTL_MS } = {}) {
    const now = Date.now()
    if (this._measuredStorageAt > 0 && now - this._measuredStorageAt < maxAgeMs) {
      return this._measuredStorageBytes
    }
    const measured = await this.getTotalStorageBytes()
    if (measured === null) return this._measuredStorageBytes
    this._measuredStorageBytes = measured
    this._measuredStorageAt = now
    return measured
  }

  /**
   * Storage budget snapshot for admission control: how much room is left under
   * the configured storage limit.
   *
   * Usage is whichever is larger, the tracked cache or what is actually on
   * disk. Tracked seeds alone described only content cached from the network,
   * so a relay whose content is published media - every relay now - reported
   * zero usage and admitted downloads until the disk filled. The limit binds
   * the storage directory, whatever is in it and however it got there.
   *
   * Tracked usage remains the floor, so an unmeasurable runtime is no less
   * strict than before.
   * @returns {Promise<{ maxBytes: number, usageBytes: number, headroomBytes: number, trackedBytes: number, measuredBytes: number | null }>}
   */
  async getQuotaBudget() {
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    const trackedBytes = Math.round(this.calculateStorage());
    const measuredBytes = await this.getMeasuredStorageBytes();
    const usageBytes = Math.max(trackedBytes, measuredBytes ?? 0);
    return {
      maxBytes,
      usageBytes,
      headroomBytes: Math.max(0, maxBytes - usageBytes),
      trackedBytes,
      measuredBytes: measuredBytes ?? null
    };
  }

  buildTrackedStorageCategoryUsage() {
    const usage = buildStorageCategoryTotals()
    for (const seed of this.activeSeeds.values()) {
      const bytes = normalizeStorageBytes(seed.bytes)
      if (seed.reason === 'pledged' || seed.reason === 'archive') {
        usage.pledgedArchiveBytes += bytes
      } else if (seed.reason === 'pinned') {
        usage.immutablePublicationBytes += bytes
      } else {
        usage.localCacheBytes += bytes
      }
      usage.thumbnailBytes += normalizeStorageBytes(seed.thumbnailBytes)
    }
    return usage
  }

  async loadAdditionalStorageCategoryUsage() {
    if (!this.getStorageCategoryUsage) return {}
    try {
      const usage = await this.getStorageCategoryUsage()
      return usage && typeof usage === 'object' ? usage : {}
    } catch (err) {
      console.log('[SeedingManager] Failed to measure storage categories:', err?.message)
      return {}
    }
  }

  buildStorageStats(totalStorageBytes = null, additionalCategoryUsage = {}) {
    const usedBytes = Math.round(this.calculateStorage());
    const maxBytes = this.config.maxStorageGB * 1024 * 1024 * 1024;
    const trackedUsage = this.buildTrackedStorageCategoryUsage()
    const combinedUsage = {}
    for (const field of STORAGE_CATEGORY_FIELDS) {
      combinedUsage[field] = normalizeStorageBytes(trackedUsage[field])
        + normalizeStorageBytes(additionalCategoryUsage[field])
    }
    let categories = buildStorageCategoryTotals(combinedUsage)
    const measuredTotal = Number.isFinite(totalStorageBytes) && totalStorageBytes >= 0
      ? Math.round(totalStorageBytes)
      : Math.max(usedBytes, categories.totalCategorizedBytes);
    const uncategorizedBytes = Math.max(0, measuredTotal - categories.totalCategorizedBytes)
    if (uncategorizedBytes > 0) {
      categories = buildStorageCategoryTotals({
        ...categories,
        ownedOriginalBytes: categories.ownedOriginalBytes + uncategorizedBytes
      })
    }
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
      untrackedStorageGB: formatBytesAsGB(untrackedStorageBytes),
      ...categories
    };
  }

  getStorageStatsSync() {
    return this.buildStorageStats(null);
  }

  /**
   * Get storage stats for UI display
   * @returns {Promise<Object>}
   */
  async getStorageStats() {
    // Shares the admission cache deliberately: the periodic status write keeps
    // the number the storage limit is enforced against warm, and a burst of
    // stats calls does not walk the tree once each.
    const [totalStorageBytes, additionalCategoryUsage] = await Promise.all([
      this.getMeasuredStorageBytes(),
      this.loadAdditionalStorageCategoryUsage()
    ])
    return this.buildStorageStats(totalStorageBytes, additionalCategoryUsage);
  }

  /**
   * Clear all ordinary cache while preserving pinned and archive commitments.
   * @returns {Promise<{ clearedBytes: number, totalStorageBytes: number, totalStorageGB: string, untrackedStorageBytes: number, untrackedStorageGB: string }>} bytes cleared and post-clear total storage snapshot
   */
  async clearCache(options = {}) {
    this.assertAuthorizedMutation(options)
    // Snapshot real on-disk usage up front. Tracked `seed.bytes` can be stale
    // (it is updated in-memory during playback and not always re-persisted), so
    // summing it alone under-reports — and showed "0 GB cleared" on mobile even
    // when blob ranges were actually freed.
    const preTotalStorageBytes = await this.getTotalStorageBytes();
    let clearedBytes = 0;
    const toRemove = [];
    let clearedBlob = false;

    for (const [key, seed] of this.activeSeeds.entries()) {
      if (!isProtectedSeedReason(seed.reason) && !this.shouldSkipSeedClear(seed)) {
        clearedBytes += normalizeStorageBytes(seed.bytes) + normalizeStorageBytes(seed.thumbnailBytes);
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
      // Flush synchronously so cleared ranges are durable, then defer RocksDB
      // compaction until playback is idle. Compacting immediately can contend
      // with blob-server range reads and make the next stream crawl.
      await this.flushClearedBlobRanges('cache clear');
    }

    const postTotalStorageBytes = await this.getTotalStorageBytes();
    // Prefer the measured on-disk delta when it is available and larger than the
    // tracked sum (which can lag). Note: RocksDB compaction is deferred to the
    // background, so the delta may under-count until compaction lands — hence we
    // never report *less* than the tracked bytes we know we cleared.
    const measuredFreed = Number.isFinite(preTotalStorageBytes) && Number.isFinite(postTotalStorageBytes)
      ? Math.max(0, preTotalStorageBytes - postTotalStorageBytes)
      : 0;
    const reportedClearedBytes = Math.round(Math.max(clearedBytes, measuredFreed));
    console.log('[SeedingManager] Cleared cache:', reportedClearedBytes, 'bytes from', toRemove.length, 'seeds');
    const stats = this.buildStorageStats(postTotalStorageBytes);
    return {
      clearedBytes: reportedClearedBytes,
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
