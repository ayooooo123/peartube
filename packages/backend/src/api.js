/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import HypercoreID from 'hypercore-id-encoding';
import z32 from 'z32';
import c from 'compact-encoding';
import { getVideoUrlFromBlob, loadChannel, loadPublicBee, pairDevice as pairChannelDevice, retainSwarmDiscovery, suspendNetworking, resumeNetworking, getNetworkStats, getNetworkStatsReadable } from './storage.js';
import { SemanticFinder } from './search/semantic-finder.js';
import { FederatedSearch } from './search/federated-search.js';
import { Recommender } from './recommendations/recommender.js';
import { getVideoToolboxDecodeSettings, setVideoToolboxDecodeEnabled, setVideoToolboxHwMapEnabled } from './transcode/videotoolbox-settings.mjs';

/**
 * @typedef {import('./types.js').StorageContext} StorageContext
 * @typedef {import('./types.js').Identity} Identity
 * @typedef {import('./types.js').VideoMetadata} VideoMetadata
 * @typedef {import('./types.js').ChannelMetadata} ChannelMetadata
 */

/**
 * Create the API object with all shared methods
 *
 * @param {Object} deps
 * @param {StorageContext} deps.ctx - Storage context
 * @param {import('./public-feed.js').PublicFeedManager} [deps.publicFeed] - Public feed manager
 * @param {import('./seeding.js').SeedingManager} [deps.seedingManager] - Seeding manager
 * @param {import('./video-stats.js').VideoStatsTracker} [deps.videoStats] - Video stats tracker
 * @returns {Object}
 */
export function createApi({ ctx, publicFeed, seedingManager, videoStats }) {
  async function isMultiWriterChannelKey(channelKey) {
    try {
      const res = await ctx.metaDb.get(`mw-channel:${channelKey}`)
      return Boolean(res?.value)
    } catch {
      // Fall through to other checks
    }

    // Fallback: if channel is already loaded in-memory, treat it as multi-writer.
    if (ctx.channels && ctx.channels.has(channelKey)) return true

    // Fallback: if this channel key exists in identities as a channelKey, treat as multi-writer.
    try {
      const stored = await ctx.metaDb.get('identities')
      const identities = stored?.value || []
      if (identities.some((i) => i?.channelKey === channelKey || i?.driveKey === channelKey)) {
        // Backfill marker so future checks are fast
        try { await ctx.metaDb.put(`mw-channel:${channelKey}`, { kind: 'autobase', backfilledAt: Date.now() }) } catch {}
        return true
      }
    } catch {}

    return false
  }

  async function markAsMultiWriterChannel(channelKey) {
    try {
      await ctx.metaDb.put(`mw-channel:${channelKey}`, { kind: 'autobase', discoveredAt: Date.now() })
    } catch {}
  }

  /**
   * Ensure SemanticFinder is initialized with persistence
   * YouTube-Fast: loads persisted index on first use for instant search
   */
  async function ensureSemanticFinder(context) {
    if (!context.semanticFinder) {
      context.semanticFinder = new SemanticFinder({ metaDb: context.metaDb })
      await context.semanticFinder.init()
      await context.semanticFinder.loadIndex()
      console.log('[API] SemanticFinder initialized, index size:', context.semanticFinder.globalSize())
    }
    return context.semanticFinder
  }

  /**
   * Background index videos for search (non-blocking)
   * YouTube-Fast: proactively indexes videos when they're listed
   */
  function backgroundIndexVideos(videos, channelKey) {
    if (!videos || videos.length === 0) return

    // Run indexing in background (don't await)
    ;(async () => {
      try {
        const finder = await ensureSemanticFinder(ctx)
        let indexed = 0
        for (const video of videos) {
          if (!finder.hasVideo(video.id)) {
            await finder.indexFromMetadata(video, channelKey)
            indexed++
          }
        }
        if (indexed > 0) {
          console.log('[API] Background indexed', indexed, 'videos from channel:', channelKey?.slice(0, 16))
        }
      } catch (err) {
        // Silently fail - indexing is best-effort
        console.log('[API] Background indexing error:', err?.message)
      }
    })()
  }

  // ------------------------------------------------------------
  // Lightweight in-memory caching (worker-local)
  // ------------------------------------------------------------
  // The app UI (home tab) re-mounts on navigation and calls getChannelMeta/listVideos each time.
  // Cache recent results in the backend worker so back-navigation is instant.
  const LIST_VIDEOS_CACHE_TTL_MS = 15_000
  const LIST_VIDEOS_EMPTY_CACHE_TTL_MS = 1_000
  const CHANNEL_META_CACHE_TTL_MS = 30_000
  /** @type {Map<string, Promise<any>>} */
  const prefetchInFlight = new Map()
  const activeRangeRequests = new Map() // key: `${driveKey}:${videoPath}`, value: { ranges: [], core, onDownload, onUpload }

  /** @type {Map<string, { ts: number, value: any[] }>} */
  const listVideosCache = new Map()
  /** @type {Map<string, { ts: number, value: any }>} */
  const channelMetaCache = new Map()

  function cloneArrayOfObjects(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map((v) => (v && typeof v === 'object') ? { ...v } : v)
  }

  function cloneObject(obj) {
    if (!obj || typeof obj !== 'object') return obj
    return { ...obj }
  }

  function invalidateChannelCaches(driveKey) {
    try { listVideosCache.delete(driveKey) } catch {}
    try { channelMetaCache.delete(driveKey) } catch {}
  }

  // ============================================
  // Download Intent Persistence Helpers
  // ============================================

  /**
   * Save a download intent to metaDb
   * @param {StorageContext} ctx
   * @param {Object} intent - Download intent object
   * @param {string} intent.driveKey
   * @param {string} intent.videoPath
   * @param {string} intent.blobsCoreKey
   * @param {string} intent.blobId
   * @param {number} intent.startBlock
   * @param {number} intent.endBlock
   * @param {number} intent.totalBlocks
   * @param {number} intent.totalBytes
   * @param {string} intent.mimeType
   * @param {number} intent.startedAt
   * @returns {Promise<void>}
   */
  async function saveDownloadIntent(ctx, intent) {
    const key = `download-intent:${intent.driveKey}:${intent.videoPath}`
    await ctx.metaDb.put(key, intent)
  }

  /**
   * Load a download intent from metaDb
   * @param {StorageContext} ctx
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<Object|null>}
   */
  async function loadDownloadIntent(ctx, driveKey, videoPath) {
    const key = `download-intent:${driveKey}:${videoPath}`
    const entry = await ctx.metaDb.get(key)
    return entry?.value || null
  }

  /**
   * Delete a download intent from metaDb
   * @param {StorageContext} ctx
   * @param {string} driveKey
   * @param {string} videoPath
   * @returns {Promise<void>}
   */
  async function deleteDownloadIntent(ctx, driveKey, videoPath) {
    const key = `download-intent:${driveKey}:${videoPath}`
    await ctx.metaDb.del(key)
  }

  /**
   * Load all download intents from metaDb
   * @param {StorageContext} ctx
   * @returns {Promise<Array<Object>>}
   */
  async function loadAllDownloadIntents(ctx) {
    const intents = []
    for await (const entry of ctx.metaDb.createReadStream({ gte: 'download-intent:', lt: 'download-intent:~' })) {
      if (entry.value) {
        intents.push(entry.value)
      }
    }
    return intents
  }

  return {
    invalidateChannelCaches,
    // ============================================
    // Channel Operations
    // ============================================

    /**
     * Get channel metadata
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannel(driveKey) {
      console.log('[API] GET_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const channel = await loadChannel(ctx, driveKey)
        await markAsMultiWriterChannel(driveKey)
        const meta = await channel.getMetadata().catch(() => null)
        return {
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
          createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null
        }
      } catch (err) {
        console.error('[API] GET_CHANNEL error:', err.message);
        return { name: 'Unknown Channel', error: err.message };
      }
    },

    async updateChannel(driveKey, { name, description, avatar } = {}) {
      console.log('[API] UPDATE_CHANNEL:', driveKey?.slice(0, 16));
      try {
        const channel = await loadChannel(ctx, driveKey)
        const updates = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (avatar !== undefined) updates.avatar = avatar
        await channel.updateMetadata(updates)
        invalidateChannelCaches(driveKey)
        const meta = await channel.getMetadata?.() || {}
        return {
          success: true,
          channel: {
            name: meta.name || name,
            description: meta.description || description,
            avatar: meta.avatar || avatar
          }
        }
      } catch (err) {
        console.error('[API] updateChannel error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    async updateVideoMetadata(channelKey, videoId, { title, description, category } = {}) {
      console.log('[API] UPDATE_VIDEO_METADATA:', channelKey?.slice(0, 16), videoId)
      try {
        const channel = await loadChannel(ctx, channelKey)
        const updates = {}
        if (title !== undefined) updates.title = title
        if (description !== undefined) updates.description = description
        if (category !== undefined) updates.category = category
        await channel.updateVideo(videoId, updates)
        invalidateChannelCaches(channelKey)
        return { success: true }
      } catch (err) {
        console.error('[API] updateVideoMetadata error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    async updateChannelAvatar(driveKey, imageBuffer, mimeType) {
      console.log('[API] UPDATE_CHANNEL_AVATAR:', driveKey?.slice(0, 16))
      try {
        const channel = await loadChannel(ctx, driveKey)

        const extensionByMime = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp'
        }
        const ext = extensionByMime[mimeType] || 'png'
        const avatarPath = `/avatars/channel.${ext}`

        const imageData = b4a.isBuffer(imageBuffer) ? imageBuffer : b4a.from(imageBuffer || [])

        let avatarUrl = null

        if (channel?.drive && typeof channel.drive.put === 'function') {
          await channel.drive.put(avatarPath, imageData)
          if (ctx.blobServer && channel.drive.core?.key) {
            const byteLength = imageData.byteLength || imageData.length || 0
            avatarUrl = ctx.blobServer.getLink(channel.drive.core.key, {
              blob: {
                blockOffset: 0,
                blockLength: channel.drive.core.length || 1,
                byteOffset: 0,
                byteLength
              },
              type: mimeType || 'image/png',
              host: ctx.blobServerHost || '127.0.0.1',
              port: ctx.blobServer?.port || ctx.blobServerPort
            })
          }
        }

        if (!avatarUrl) {
          const blob = await channel.putBlob(imageData)
          avatarUrl = ctx.blobServer.getLink(channel.blobsKey, {
            blob: {
              blockOffset: blob.blockOffset,
              blockLength: blob.blockLength,
              byteOffset: blob.byteOffset,
              byteLength: blob.byteLength
            },
            type: mimeType || 'image/png',
            host: ctx.blobServerHost || '127.0.0.1',
            port: ctx.blobServer?.port || ctx.blobServerPort
          })
        }

        await channel.updateMetadata({ avatar: avatarUrl })
        invalidateChannelCaches(driveKey)
        return { success: true, avatarUrl }
      } catch (err) {
        console.error('[API] updateChannelAvatar error:', err?.message)
        return { success: false, error: err?.message }
      }
    },

    /**
     * Get channel metadata with video count (for public feed)
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannelMeta(driveKey, publicBeeKey = null) {
      console.log('[API] GET_CHANNEL_META:', driveKey?.slice(0, 16));
      try {
        const cached = channelMetaCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < CHANNEL_META_CACHE_TTL_MS) {
          return cloneObject(cached.value)
        }
        // Fast/public-feed path: if publicBeeKey is provided, don't load Autobase.
        // Viewers should be able to list metadata/videos via the auto-replicating PublicBee.
        if (publicBeeKey) {
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const meta = await publicBee.getMetadata().catch(() => null)
          const videos = await publicBee.listVideos().catch(() => [])
          const result = {
            driveKey,
            name: meta?.name || 'Channel',
            description: meta?.description || '',
            avatar: meta?.avatar || null,
            createdAt: meta?.createdAt || Date.now(),
            publicKey: meta?.createdBy || null,
            videoCount: videos?.length || 0
          }
          channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneObject(result)
        }

        const channel = await loadChannel(ctx, driveKey)
        await markAsMultiWriterChannel(driveKey)
        const meta = await channel.getMetadata().catch(() => null)
        const videos = await channel.listVideos().catch(() => [])
        const result = {
          driveKey,
          name: meta?.name || 'Channel',
          description: meta?.description || '',
          avatar: meta?.avatar || null,
          createdAt: meta?.createdAt || Date.now(),
          publicKey: meta?.createdBy || null,
          videoCount: videos?.length || 0
        }
        channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneObject(result)
      } catch (err) {
        console.error('[API] GET_CHANNEL_META error:', err.message);
        return {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0,
          error: err.message
        };
      }
    },

    // ============================================
    // Video Operations
    // ============================================

    /**
     * List videos in a channel
     * @param {string} driveKey
     * @param {string} [publicBeeKey] - Optional PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata[]>}
     */
    async listVideos(driveKey, publicBeeKey) {
      console.log('[API] LIST_VIDEOS for:', driveKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        const cached = listVideosCache.get(driveKey)
        if (cached) {
          const ttl = Array.isArray(cached.value) && cached.value.length === 0
            ? LIST_VIDEOS_EMPTY_CACHE_TTL_MS
            : LIST_VIDEOS_CACHE_TTL_MS
          if ((Date.now() - cached.ts) < ttl) {
          return cloneArrayOfObjects(cached.value)
          }
        }

        const extractVideoId = (video) => {
          if (!video) return null
          if (video.id) return video.id
          if (video.path && typeof video.path === 'string') {
            const match = video.path.match(/\/videos\/([^.\/]+)/)
            if (match?.[1]) return match[1]
            const base = video.path.split('/').pop() || ''
            return base.replace(/\.[^./]+$/, '') || null
          }
          return null
        }

        const enrichMissingBlobMeta = async (videos, fetcher) => {
          const missing = (videos || []).filter(v => !v?.blobId || !v?.blobsCoreKey)
          if (missing.length === 0) return videos

          const MAX_ENRICH = 10
          const ids = Array.from(new Set(
            missing
              .slice(0, MAX_ENRICH)
              .map(v => extractVideoId(v))
              .filter(Boolean)
          ))
          if (ids.length === 0) return videos

          const metaById = new Map()
          await Promise.all(ids.map(async (id) => {
            try {
              const meta = await fetcher(id)
              if (meta) metaById.set(id, meta)
            } catch {}
          }))

          if (metaById.size === 0) return videos

          return (videos || []).map((v) => {
            if (!v || (v.blobId && v.blobsCoreKey)) return v
            const id = extractVideoId(v)
            const meta = id ? metaById.get(id) : null
            if (!meta) return v
            return {
              ...v,
              blobId: v.blobId || meta.blobId,
              blobsCoreKey: v.blobsCoreKey || meta.blobsCoreKey,
              mimeType: v.mimeType || meta.mimeType,
              size: v.size || meta.size,
              byteLength: v.byteLength || meta.byteLength,
            }
          })
        }

        // FAST PATH: If publicBeeKey is provided, read directly from PublicBee
        // This is the preferred path for public feed viewers - no Autobase sync needed
        // IMPORTANT: If publicBeeKey is provided, this is definitely a multi-writer channel,
        // so we should not fall back to legacy storage paths.
        if (publicBeeKey) {
          console.log('[API] LIST_VIDEOS: using PublicBee fast path')
          // Mark as multi-writer since PublicBee is only used with multi-writer channels
          await markAsMultiWriterChannel(driveKey)
          try {
            const publicBee = await loadPublicBee(ctx, publicBeeKey)
            const videos = await publicBee.listVideos()
            console.log('[API] LIST_VIDEOS: PublicBee returned', videos?.length, 'videos')
            const result = (videos || []).map(v => ({ ...v, channelKey: driveKey, publicBeeKey }))
            const enriched = await enrichMissingBlobMeta(result, (id) => publicBee.getVideo(id))
            listVideosCache.set(driveKey, { ts: Date.now(), value: enriched })
            // YouTube-Fast: background index for search
            backgroundIndexVideos(enriched, driveKey)
            return cloneArrayOfObjects(enriched)
          } catch (err) {
            console.log('[API] LIST_VIDEOS: PublicBee fast path failed:', err.message, '- trying channel directly')
            // If PublicBee fails, try loading the channel directly (for paired devices or when PublicBee isn't synced)
            try {
              const channel = await loadChannel(ctx, driveKey)
              const videos = await channel.listVideos()
              console.log('[API] LIST_VIDEOS: channel fallback returned', videos?.length, 'videos')
              const result = (videos || []).map(v => ({ ...v, channelKey: driveKey, publicBeeKey }))
              const enriched = await enrichMissingBlobMeta(result, (id) => channel.getVideo(id))
              listVideosCache.set(driveKey, { ts: Date.now(), value: enriched })
              // YouTube-Fast: background index for search
              backgroundIndexVideos(enriched, driveKey)
              return cloneArrayOfObjects(enriched)
            } catch (channelErr) {
              console.log('[API] LIST_VIDEOS: channel fallback also failed:', channelErr.message)
              // Return empty - do NOT fall through to legacy paths since this is a multi-writer channel
              return []
            }
          }
        }

        const channel = await loadChannel(ctx, driveKey)
        await markAsMultiWriterChannel(driveKey)
        console.log('[API] LIST_VIDEOS channel loaded, calling listVideos...')

        // IMPORTANT: Never block listVideos on network sync.
        // Mobile has a 30s init timeout, and pairing/DHT discovery can exceed that.
        // Return current materialized view immediately; the UI already retries.
        const videos = await channel.listVideos()
        console.log('[API] LIST_VIDEOS returning', videos?.length, 'videos from channel')
        const result = (videos || []).map(v => ({ ...v, channelKey: driveKey }))
        const enriched = await enrichMissingBlobMeta(result, (id) => channel.getVideo(id))
        listVideosCache.set(driveKey, { ts: Date.now(), value: enriched })
        // YouTube-Fast: background index for search
        backgroundIndexVideos(enriched, driveKey)
        return cloneArrayOfObjects(enriched)
      } catch (err) {
        console.error('[API] LIST_VIDEOS error:', err.message);
        return [];
      }
    },

    /**
     * Get video stream URL
     * @param {string} driveKey
     * @param {string} videoPath
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @param {string} [blobId] - Direct blobId (skip metadata fetch if provided)
     * @param {string} [blobsCoreKey] - Direct blobsCoreKey (skip metadata fetch if provided)
     * @param {string} [mimeType] - MIME type
     * @returns {Promise<{url: string}>}
     */
    async getVideoUrl(driveKey, videoPath, publicBeeKey, blobId, blobsCoreKey, mimeType) {
      console.log('[API] getVideoUrl:', driveKey?.slice(0, 16), videoPath);

      // INSTANT PATH: If we already have blobId and blobsCoreKey, skip metadata fetch entirely
      if (blobId && blobsCoreKey) {
        console.log('[API] getVideoUrl: INSTANT - using direct blobId/blobsCoreKey');

        // Join swarm in background (don't wait)
        if (ctx.swarm) {
          try {
            const keyBuf = b4a.from(blobsCoreKey, 'hex')
            const discoveryKey = crypto.discoveryKey(keyBuf)
            retainSwarmDiscovery(ctx, discoveryKey, {
              label: `blobs:${String(blobsCoreKey).slice(0, 16)}`
            })
          } catch {}
        }

        // Return URL instantly
        return getVideoUrlFromBlob(ctx, blobsCoreKey, blobId, {
          mimeType: mimeType || 'video/mp4',
          instant: false
        })
      }

      const meta = await this.getVideoData(driveKey, videoPath, publicBeeKey)
      console.log('[API] getVideoUrl meta:', meta?.id, 'blobId:', meta?.blobId, 'blobsCoreKey:', meta?.blobsCoreKey?.slice(0, 16))
      if (!meta) {
        console.log('[API] getVideoUrl: no metadata found');
        throw new Error('Video metadata not found')
      }

      if (!meta.blobId) {
        console.log('[API] getVideoUrl: missing blobId');
        throw new Error('Video is missing blobId (not synced yet)')
      }

      // Fast path: if we have blobsCoreKey from PublicBee, use it directly
      // Use instant mode for zero-wait URL generation - blob server fetches on-demand
      if (meta.blobsCoreKey) {
        console.log('[API] getVideoUrl: INSTANT mode - generating URL immediately');
        const blobsKeyHex = meta.blobsCoreKey;

        // Join swarm in background (don't wait)
        if (ctx.swarm) {
          try {
            const keyBuf = b4a.from(blobsKeyHex, 'hex')
            const discoveryKey = crypto.discoveryKey(keyBuf)
            retainSwarmDiscovery(ctx, discoveryKey, {
              label: `blobs:${String(blobsKeyHex).slice(0, 16)}`
            })
          } catch {}
        }

        // Return URL instantly - blob server handles fetching
        return getVideoUrlFromBlob(ctx, blobsKeyHex, meta.blobId, {
          mimeType: meta.mimeType,
          instant: false
        })
      }

      // Fallback: load channel to get blob entry (slower)
      console.log('[API] getVideoUrl: loading channel for blob entry (slow path)');
      const channel = await loadChannel(ctx, driveKey)
      if (!channel) {
        console.log('[API] getVideoUrl: failed to load channel');
        throw new Error('Failed to load channel')
      }

      const blobEntry = await channel.getBlobEntry(meta)
      if (!blobEntry?.blobsKey) {
        console.log('[API] getVideoUrl: failed to get blob entry');
        throw new Error('Video blob not accessible (not synced yet)')
      }

      // Join swarm for blobs core to ensure we can download from peers
      if (ctx.swarm && blobEntry.blobsKey) {
        try {
          const discoveryKey = crypto.discoveryKey(blobEntry.blobsKey)
          retainSwarmDiscovery(ctx, discoveryKey, {
            label: `blobs:${blobsKeyHex.slice(0, 16)}`
          })
        } catch {}
      }

      const blobsKeyHex = b4a.toString(blobEntry.blobsKey, 'hex')
      console.log('[API] getVideoUrl: blobsKey:', blobsKeyHex.slice(0, 16), 'blobId:', meta.blobId);
      return getVideoUrlFromBlob(ctx, blobsKeyHex, blobEntry.blobId, { mimeType: meta.mimeType })
    },

    /**
     * Download video to a local file path
     * @param {string} channelKey - Channel key (hex)
     * @param {string} videoId - Video ID
     * @param {string} destPath - Destination file path
     * @param {Object} fsModule - File system module (bare-fs or node:fs)
     * @param {Function} [onProgress] - Progress callback (progress, bytesWritten, totalBytes)
     * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
     */
    async downloadVideo(channelKey, videoId, destPath, fsModule, onProgress) {
      console.log('[API] downloadVideo:', channelKey?.slice(0, 16), videoId, 'to:', destPath);
      try {
        const meta = await this.getVideoData(channelKey, videoId);
        if (!meta) {
          return { success: false, error: 'Video metadata not found' };
        }

        if (!meta.blobId || !meta.blobsCoreKey) {
          return { success: false, error: 'Video missing blobId or blobsCoreKey' };
        }

        // Parse blobId
        const parts = meta.blobId.split(':').map(Number);
        if (parts.length !== 4) {
          return { success: false, error: 'Invalid blob ID format' };
        }
        const blob = {
          blockOffset: parts[0],
          blockLength: parts[1],
          byteOffset: parts[2],
          byteLength: parts[3]
        };

        // Load channel and get blobs core
        const channel = await loadChannel(ctx, channelKey);
        if (!channel) {
          return { success: false, error: 'Failed to load channel' };
        }

        const blobEntry = await channel.getBlobEntry(meta);
        if (!blobEntry?.blobsKey) {
          return { success: false, error: 'Video blob not accessible (not synced yet)' };
        }

        // Load the blobs Hypercore
        const blobsCore = ctx.store.get(blobEntry.blobsKey);
        await blobsCore.ready();

        // Create Hyperblobs reader
        const Hyperblobs = (await import('hyperblobs')).default;
        const blobs = new Hyperblobs(blobsCore);
        await blobs.ready();

        // Stream the blob to the destination file
        const totalBytes = blob.byteLength;
        let bytesWritten = 0;

        console.log('[API] Creating write stream for:', destPath);
        const readStream = blobs.createReadStream(blob);
        const writeStream = fsModule.createWriteStream(destPath);

        await new Promise((resolve, reject) => {
          readStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
            if (onProgress) {
              const progress = Math.round((bytesWritten / totalBytes) * 100);
              onProgress(progress, bytesWritten, totalBytes);
            }
          });
          readStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('close', resolve);
          readStream.pipe(writeStream);
        });

        console.log('[API] downloadVideo complete:', destPath);
        return { success: true, filePath: destPath, size: totalBytes };
      } catch (err) {
        console.error('[API] downloadVideo failed:', err?.message);
        return { success: false, error: err?.message || 'Download failed' };
      }
    },

    /**
     * Get video metadata by ID or path
     * @param {string} driveKey
     * @param {string} videoId - Video ID or full path
     * @param {string} [publicBeeKey] - PublicBee key for fast viewer access
     * @returns {Promise<VideoMetadata|null>}
     */
    async getVideoData(driveKey, videoId, publicBeeKey) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoId, 'publicBeeKey:', publicBeeKey?.slice(0, 16));
      try {
        // Parse videoId to extract the actual ID
        let id = videoId
        if (typeof videoId === 'string' && videoId.startsWith('/videos/')) {
          const match = videoId.match(/\/videos\/([^.]+)/)
          if (match) id = match[1]
        }

        // Fast path: use PublicBee if we have the key (for viewers)
        if (publicBeeKey) {
          console.log('[API] GET_VIDEO_DATA: using PublicBee fast path')
          const publicBee = await loadPublicBee(ctx, publicBeeKey)
          const v = await publicBee.getVideo(id)
          console.log('[API] GET_VIDEO_DATA PublicBee result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
          if (v) return { ...v, channelKey: driveKey }
          // Fall through to other methods if not found
        }

      const channel = await loadChannel(ctx, driveKey)
      console.log('[API] GET_VIDEO_DATA channel loaded')
      console.log('[API] GET_VIDEO_DATA looking up id:', id)

      const v = await channel.getVideo(id)
      console.log('[API] GET_VIDEO_DATA result:', v?.id, 'blobId:', v?.blobId, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16))
      if (!v) return null
      return { ...v, channelKey: driveKey }
      } catch (err) {
        console.error('[API] GET_VIDEO_DATA error:', err.message);
        return null;
      }
    },

    /**
     * Delete a video from a channel
     * @param {string} channelKey
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(channelKey, videoId) {
      console.log('[API] DELETE_VIDEO:', channelKey?.slice(0, 16), videoId);

      if (!channelKey) {
        return { success: false, error: 'Channel key required' };
      }

      try {
        const channel = await loadChannel(ctx, channelKey)
        if (!channel) {
          return { success: false, error: 'Failed to load channel' };
        }
        await channel.deleteVideo(videoId)

        if (ctx.semanticFinder) {
          try { ctx.semanticFinder.removeVideo(videoId) } catch {}
        }

        return { success: true };
      } catch (err) {
        console.error('[API] DELETE_VIDEO error:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get video thumbnail URL
     * @param {string} driveKey
     * @param {string} videoId
     * @returns {Promise<{url?: string, exists: boolean}>}
     */
    async getVideoThumbnail(driveKey, videoId) {
      try {
        const normalizeVideoId = (value) => {
          if (!value || typeof value !== 'string') return value
          if (value.startsWith('/videos/')) {
            const match = value.match(/\/videos\/([^.\/]+)/)
            if (match?.[1]) return match[1]
          }
          return value
        }

        const targetVideoId = normalizeVideoId(videoId)

        const getThumbnailMetaFromCachedList = () => {
          const cached = listVideosCache.get(driveKey)
          const items = Array.isArray(cached?.value) ? cached.value : []
          if (!items.length) return null

          const match = items.find((v) => {
            if (!v || typeof v !== 'object') return false
            const cachedId = normalizeVideoId(v.id || v.videoId || v.path)
            return cachedId === targetVideoId
          })

          if (!match || typeof match !== 'object') return null

          if (match.thumbnailBlobId && match.thumbnailBlobsCoreKey) {
            return {
              thumbnailBlobId: match.thumbnailBlobId,
              thumbnailBlobsCoreKey: match.thumbnailBlobsCoreKey,
              thumbnailMimeType: match.thumbnailMimeType,
              thumbnail: match.thumbnail,
            }
          }

          if (typeof match.thumbnail === 'string' && match.thumbnail.length > 0) {
            return { thumbnail: match.thumbnail }
          }

          return null
        }

        let resolvedPublicBeeKey = null;
        try {
          const feedManager = publicFeed && typeof publicFeed === 'object' ? publicFeed : null;
          const feed = feedManager && typeof feedManager.getFeed === 'function'
            ? feedManager.getFeed()
            : [];
          const entry = Array.isArray(feed)
            ? feed.find((e) => {
                const key = e && typeof e === 'object'
                  ? (e.channelKey || e.driveKey || null)
                  : null;
                return key === driveKey;
              })
            : null;
          resolvedPublicBeeKey = entry && typeof entry === 'object' ? (entry.publicBeeKey || null) : null;
        } catch {}

        let meta = null;
        const cachedMeta = getThumbnailMetaFromCachedList()
        if (cachedMeta) {
          meta = cachedMeta
        }

        if (resolvedPublicBeeKey) {
          meta = meta || await this.getVideoData(driveKey, targetVideoId, resolvedPublicBeeKey);
        }
        if (!meta) {
          meta = await this.getVideoData(driveKey, targetVideoId);
        }
        if (!meta) {
          return { exists: false };
        }

        if (!meta.thumbnailBlobId && !meta.thumbnailBlobsCoreKey && typeof meta.thumbnail === 'string' && meta.thumbnail.length > 0) {
          return { url: meta.thumbnail, exists: true };
        }

        // New Hyperblobs-based thumbnail
        if (meta.thumbnailBlobId && meta.thumbnailBlobsCoreKey) {
          const keyBuffer = b4a.from(meta.thumbnailBlobsCoreKey, 'hex');
          
          let blobsCore;
          try {
            blobsCore = ctx.store.get(keyBuffer);
            await blobsCore.ready();
          } catch (storeErr) {
            console.error('[API] GET_VIDEO_THUMBNAIL: store.get/ready failed:', storeErr.message);
            throw storeErr;
          }

          // Join swarm for thumbnail core
          if (ctx.swarm && blobsCore.discoveryKey) {
            try { ctx.swarm.join(blobsCore.discoveryKey) } catch {}
          }

          try {
            await Promise.race([
              blobsCore.update({ wait: true }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail core update timeout')), 1500))
            ]);
          } catch {}

          // Parse blobId string to blob object
          const parts = meta.thumbnailBlobId.split(':').map(Number);
          const blob = {
            blockOffset: parts[0],
            blockLength: parts[1],
            byteOffset: parts[2],
            byteLength: parts[3]
          };

          const thumbnailMimeType = typeof meta.thumbnailMimeType === 'string' && meta.thumbnailMimeType.length > 0
            ? meta.thumbnailMimeType
            : 'image/webp';

          const url = ctx.blobServer.getLink(blobsCore.key, {
            blob,
          type: thumbnailMimeType,
          host: ctx.blobServerHost || '127.0.0.1',
          port: ctx.blobServer?.port || ctx.blobServerPort
          });
          return { url, exists: true };
        }

        return { exists: false };
      } catch (err) {
        console.error('[API] GET_VIDEO_THUMBNAIL error:', err.message);
        return { exists: false, error: err.message };
      }
    },

    // ============================================
    // Subscription Operations
    // ============================================

    /**
     * Subscribe to a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async subscribeChannel(driveKey) {
      // Don't let loadChannel hang forever - use a 5s timeout
      // If it times out, we still add to subscriptions (data will sync later when peers are found)
      try {
        await Promise.race([
          loadChannel(ctx, driveKey),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Channel load timeout')), 5000))
        ]);
      } catch (err) {
        console.log('[API] subscribeChannel: channel load warning:', err.message, '- continuing anyway');
      }

      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      if (!subs.find(s => s.driveKey === driveKey)) {
        subs.push({
          driveKey,
          subscribedAt: Date.now()
        });
        await ctx.metaDb.put('subscriptions', subs);
      }

      return { success: true };
    },

    /**
     * Unsubscribe from a channel
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unsubscribeChannel(driveKey) {
      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      const filtered = subs.filter(s => s.driveKey !== driveKey);
      await ctx.metaDb.put('subscriptions', filtered);

      return { success: true };
    },

    /**
     * Get subscriptions list with channel names
     * @returns {Promise<Array<{driveKey: string, name: string, subscribedAt?: number}>>}
     */
    async getSubscriptions() {
      const existing = await ctx.metaDb.get('subscriptions');
      const subs = existing?.value || [];

      const enriched = [];
      for (const sub of subs) {
        let name = 'Unknown';
        try {
          const channel = await loadChannel(ctx, sub.driveKey)
          const meta = await channel?.getMetadata().catch(() => null)
          if (meta?.name) name = meta.name
        } catch (e) {}
        enriched.push({ ...sub, name });
      }

      return enriched;
    },

    // ============================================
    // Public Feed Operations
    // ============================================

    /**
     * Get public feed entries
     * @returns {{entries: Array, stats: Object}}
     */
    getPublicFeed() {
      if (!publicFeed) {
        return { entries: [], stats: { totalEntries: 0, hiddenCount: 0, peerCount: 0 } };
      }
      const rawFeed = publicFeed.getFeed();
      const feed = rawFeed
        .map((entry) => ({
          channelKey: entry?.channelKey || entry?.driveKey || '',
          publicBeeKey: entry?.publicBeeKey || null,
          channelName: entry?.channelName || null,
          videoCount: entry?.videoCount || 0,
          peerCount: entry?.peerCount || 0,
          lastSeen: entry?.lastSeen || entry?.addedAt || 0,
        }))
        .filter((entry) => typeof entry.channelKey === 'string' && entry.channelKey.length > 0)
      const stats = publicFeed.getStats();
      const keyedEntries = feed.filter((e) => typeof e.publicBeeKey === 'string' && e.publicBeeKey.length > 0).length;
      const unkeyedEntries = feed.length - keyedEntries;
      console.log(
        `[API] Returning ${feed.length} feed entries (${stats.peerCount} peers, keyed=${keyedEntries}, fallback=${unkeyedEntries}, raw=${rawFeed.length})`
      );
      return {
        entries: feed,
        stats: {
          ...stats,
          keyedEntries,
          unkeyedEntries,
        },
      };
    },

    /**
     * Refresh feed from peers
     * @returns {{success: boolean, peerCount: number}}
     */
    refreshFeed() {
      console.log('[API] Refreshing feed...');
      let peerCount = 0;
      if (publicFeed) {
        peerCount = publicFeed.requestFeedsFromPeers();
      }
      return { success: true, peerCount };
    },

    /**
     * Submit channel to public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async submitToFeed(driveKey) {
      console.log('[API] Submitting channel to feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        // Get publicBeeKey from the channel for fast viewer access
        let publicBeeKey = null;
        try {
          const channel = await loadChannel(ctx, driveKey);
          publicBeeKey = channel?.publicBeeKey || await channel?.getPublicBeeKey();
          console.log('[API] submitToFeed: got publicBeeKey:', publicBeeKey?.slice(0, 16));

          // Use channel's CommentsAutobase directly - it's already initialized in _open()
          // and has the key stored in channel metadata + synced to PublicBee
          const commentsBase = await channel.getCommentsAutobase();
          if (commentsBase?.keyHex) {
            console.log('[API] submitToFeed: CommentsAutobase key:', commentsBase.keyHex.slice(0, 16));

            // Ensure PublicBee has the commentsAutobaseKey synced
            if (channel.publicBee?.writable) {
              const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}));
              if (!pubMeta?.commentsAutobaseKey) {
                await channel.publicBee.setMetadata({
                  ...pubMeta,
                  commentsAutobaseKey: commentsBase.keyHex
                });
                console.log('[API] submitToFeed: synced commentsAutobaseKey to PublicBee');
              }
            }
          }
        } catch (err) {
          console.log('[API] submitToFeed: channel/comments init error:', err?.message);
        }
        await publicFeed.submitChannel(driveKey, publicBeeKey);
      }
      return { success: true };
    },

    /**
     * Unpublish channel from public feed
     * @param {string} driveKey
     * @returns {Promise<{success: boolean}>}
     */
    async unpublishFromFeed(driveKey) {
      console.log('[API] Unpublishing channel from feed:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        await publicFeed.unpublishChannel(driveKey);
      }
      return { success: true };
    },

    /**
     * Check if channel is published to feed
     * @param {string} driveKey
     * @returns {{published: boolean}}
     */
    isChannelPublished(driveKey) {
      if (publicFeed && driveKey) {
        return { published: publicFeed.isChannelPublished(driveKey) };
      }
      return { published: false };
    },

    /**
     * Hide channel from feed
     * @param {string} driveKey
     * @returns {{success: boolean}}
     */
    hideChannel(driveKey) {
      console.log('[API] Hiding channel:', driveKey?.slice(0, 16));
      if (publicFeed && driveKey) {
        publicFeed.hideChannel(driveKey);
      }
      return { success: true };
    },

    // ============================================
    // Prefetch and Stats Operations
    // ============================================

    /**
     * Prefetch a video - download all blocks for smooth seeking
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Promise<Object>}
     */
    async prefetchVideo(driveKey, videoPath, publicBeeKey = null) {
      const prefetchKey = `${driveKey}:${videoPath}`
      const existing = prefetchInFlight.get(prefetchKey)
      if (existing) return existing

      // Cancel any orphaned range requests from a previous prefetch session
      const existingRanges = activeRangeRequests.get(prefetchKey)
      if (existingRanges) {
        console.log('[API] Cancelling orphaned range requests for:', videoPath)
        existingRanges.ranges.forEach(r => { try { r?.destroy?.() } catch {} })
        if (existingRanges.core) {
          try { existingRanges.core.off('download', existingRanges.onDownload) } catch {}
          try { existingRanges.core.off('upload', existingRanges.onUpload) } catch {}
        }
        activeRangeRequests.delete(prefetchKey)
      }

      const prefetchPromise = (async () => {
        const prefetchStart = Date.now();

      const getHeadBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 16)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const minHeadBytes = 4 * 1024 * 1024
        const maxHeadBytes = 32 * 1024 * 1024
        const adaptiveBytes = Math.round(totalBytes * 0.02)
        const headTargetBytes = Math.min(maxHeadBytes, Math.max(minHeadBytes, adaptiveBytes))
        const headBlocks = Math.ceil(headTargetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, headBlocks))
      }

      // Some containers (notably MP4 without faststart, MKV cues, etc.) may require reads
      // from the end or middle of the file during demuxer init. If the blob server supports
      // Range requests (or the player seeks), having these blocks available dramatically
      // reduces startup time.
      const getTailBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 16)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const minTailBytes = 2 * 1024 * 1024
        const maxTailBytes = 16 * 1024 * 1024
        const adaptiveBytes = Math.round(totalBytes * 0.01)
        const tailTargetBytes = Math.min(maxTailBytes, Math.max(minTailBytes, adaptiveBytes))
        const tailBlocks = Math.ceil(tailTargetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, tailBlocks))
      }

      const getMidBlockCount = (totalBlocks, totalBytes) => {
        if (!totalBlocks || totalBlocks <= 0) return 0
        if (!totalBytes || totalBytes <= 0) {
          return Math.min(totalBlocks, 8)
        }
        const bytesPerBlock = totalBytes / totalBlocks
        const targetBytes = 2 * 1024 * 1024
        const midBlocks = Math.ceil(targetBytes / bytesPerBlock)
        return Math.max(1, Math.min(totalBlocks, midBlocks))
      }

      console.log('[API] ===== STARTING PREFETCH =====');
      console.log('[API] Channel:', driveKey?.slice(0, 16));
      console.log('[API] Path:', videoPath);
      if (publicBeeKey) {
        console.log('[API] Prefetch publicBeeKey:', publicBeeKey?.slice(0, 16));
      }

      // Check if corestore is still open
      if (ctx.store.closed) {
        console.log('[API] Corestore is closed, skipping prefetch');
        return { success: false, error: 'Corestore is closed' };
      }

      const existingIntent = await loadDownloadIntent(ctx, driveKey, videoPath)
      let blobMeta = null
      let v = null

      if (existingIntent) {
        console.log('[API] Resuming download from intent:', videoPath)
        blobMeta = {
          blobsCoreKey: existingIntent.blobsCoreKey,
          blobId: existingIntent.blobId,
          byteLength: existingIntent.totalBytes || 0
        }
      } else {
        // Resolve the blob source from metadata
        v = await this.getVideoData(driveKey, videoPath, publicBeeKey)
        console.log('[API] Prefetch video data:', v?.id, 'blobsCoreKey:', v?.blobsCoreKey?.slice(0, 16), 'path:', v?.path)
        if (v?.blobsCoreKey && v?.blobId) {
          blobMeta = {
            blobsCoreKey: v.blobsCoreKey,
            blobId: v.blobId,
            byteLength: v?.size || v?.byteLength || 0
          }
          console.log('[API] Prefetch using blobsCoreKey:', v.blobsCoreKey?.slice(0, 16))
        } else {
          console.log('[API] Prefetch: video missing blobsCoreKey or blobId, v:', JSON.stringify(v)?.slice(0, 200))
        }
      }

      // Clean up any existing monitor
      if (videoStats) {
        videoStats.cleanupMonitor(driveKey, videoPath);
        videoStats.updateStats(driveKey, videoPath, {
          status: 'connecting',
          startTime: prefetchStart
        });
      }

      try {
        // Prefetch directly from blobs core using blobId.
        if (blobMeta?.blobsCoreKey && blobMeta?.blobId) {
          const keyBuf = b4a.from(blobMeta.blobsCoreKey, 'hex')
          const core = ctx.store.get({ key: keyBuf })
          await core.ready()

          if (ctx.swarm && core.discoveryKey) {
            try {
              retainSwarmDiscovery(ctx, core.discoveryKey, {
                label: `prefetch:${blobMeta.blobsCoreKey.slice(0, 16)}`
              })
            } catch {}
          }

          let blobId = blobMeta.blobId
          if (typeof blobId === 'string') {
            const parts = blobId.split(':').map(Number)
            if (parts.length !== 4) throw new Error('Invalid blob ID format')
            blobId = {
              blockOffset: parts[0],
              blockLength: parts[1],
              byteOffset: parts[2],
              byteLength: parts[3]
            }
          }

          const startBlock = blobId.blockOffset
          const endBlock = blobId.blockOffset + blobId.blockLength
          const totalBlocks = blobId.blockLength
          const totalBytes = blobId.byteLength || blobMeta.byteLength || 0

          if (!existingIntent && blobMeta?.blobsCoreKey) {
            await saveDownloadIntent(ctx, {
              driveKey,
              videoPath,
              blobsCoreKey: blobMeta.blobsCoreKey,
              blobId: typeof blobMeta.blobId === 'string'
                ? blobMeta.blobId
                : `${blobId.blockOffset}:${blobId.blockLength}:${blobId.byteOffset}:${blobId.byteLength}`,
              startBlock,
              endBlock,
              totalBlocks,
              totalBytes,
              mimeType: v?.mimeType || existingIntent?.mimeType || '',
              startedAt: Date.now()
            }).catch(err => console.log('[API] Failed to save download intent:', err?.message))
          }

          // Count initial blocks already available
          // For large videos, use sampling instead of all-or-nothing has(start, end)
          let initialAvailable = 0
          const fullyCached = await core.has(startBlock, endBlock)
          if (fullyCached) {
            initialAvailable = totalBlocks
          } else if (totalBlocks <= 512) {
            // Small video: exact block-by-block count
            for (let i = startBlock; i < endBlock; i++) {
              if (await core.has(i)) initialAvailable++
            }
          } else {
            // Large video: sample to estimate (same pattern as checkVideoSync)
            const sampleSize = Math.min(totalBlocks, 20)
            const step = Math.max(1, Math.floor(totalBlocks / sampleSize))
            let sampledHits = 0
            let sampledTotal = 0
            for (let i = startBlock; i < endBlock; i += step) {
              if (await core.has(i)) sampledHits++
              sampledTotal++
            }
            initialAvailable = sampledTotal > 0 ? Math.round((sampledHits / sampledTotal) * totalBlocks) : 0
          }
          console.log(`[API] Initial: ${initialAvailable}/${totalBlocks} blocks (${Math.round(initialAvailable/totalBlocks*100)}%)`)

          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, {
              status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
              totalBlocks,
              totalBytes,
              initialBlocks: initialAvailable,
              downloadedBlocks: 0,
              peerCount: core.peers?.length || 0
            })
            videoStats.emitStats(driveKey, videoPath, true) // force=true for initial stats
          }

          const wasCached = initialAvailable === totalBlocks && totalBlocks > 0
          if (wasCached) {
            console.log('[API] Already fully cached (blobs)')
          }

          const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0
          const headBlocks = getHeadBlockCount(totalBlocks, totalBytes)
          const tailBlocks = getTailBlockCount(totalBlocks, totalBytes)
          const midBlocks = getMidBlockCount(totalBlocks, totalBytes)
          let playbackReadyResolved = false
          let playbackReadyTimeout = null
          let resolvePlaybackReady = null
          const playbackReady = new Promise((resolve) => {
            resolvePlaybackReady = () => {
              if (playbackReadyResolved) return
              playbackReadyResolved = true
              if (playbackReadyTimeout) clearTimeout(playbackReadyTimeout)
              resolve()
            }
          })
          playbackReadyTimeout = setTimeout(() => {
            console.log('[API] Playback startup prefetch timed out, continuing with current availability')
            resolvePlaybackReady?.()
          }, 5000)

          if (initialAvailable > 0) {
            resolvePlaybackReady?.()
          }

          let downloadedBlocks = 0
          let downloadedBytesTotal = initialAvailable * bytesPerBlock
          let downloadSpeed = 0
          let lastSpeedTime = Date.now()
          let lastSpeedBytes = downloadedBytesTotal
          let uploadSpeed = 0
          let uploadedBytesTotal = 0
          let lastUploadTime = Date.now()
          let lastUploadBytes = 0
          const downloadedIndices = new Set()
          let assumedComplete = wasCached

          const onDownload = (index, byteLength) => {
            if (typeof index !== 'number') return
            if (index < startBlock || index >= endBlock) return
            if (assumedComplete) {
              assumedComplete = false
              initialAvailable = 0
              downloadedBytesTotal = 0
              lastSpeedBytes = 0
              if (videoStats) {
                videoStats.updateStats(driveKey, videoPath, { initialBlocks: 0 })
              }
            }
            if (!downloadedIndices.has(index)) {
              downloadedIndices.add(index)
              downloadedBlocks = downloadedIndices.size
            }
            resolvePlaybackReady?.()
            const chunkBytes =
              typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
                ? byteLength
                : bytesPerBlock
            downloadedBytesTotal += chunkBytes
            const totalDownloaded = initialAvailable + downloadedBlocks
            const now = Date.now()
            const elapsed = (now - lastSpeedTime) / 1000
            if (elapsed >= 0.5) {
              const deltaBytes = downloadedBytesTotal - lastSpeedBytes
              downloadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
              lastSpeedBytes = downloadedBytesTotal
              lastSpeedTime = now
            }

            const isComplete = totalDownloaded >= totalBlocks
            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                downloadedBlocks,
                peerCount: core.peers?.length || 0,
                status: isComplete ? 'complete' : 'downloading',
                initialBlocks: initialAvailable
              })
              // Use force=true on completion, otherwise let throttle work
              videoStats.emitStats(driveKey, videoPath, isComplete)
            }
          }

          const onUpload = (index, byteLength) => {
            if (typeof index !== 'number') return
            if (index < startBlock || index >= endBlock) return
            const chunkBytes =
              typeof byteLength === 'number' && Number.isFinite(byteLength) && byteLength > 0
                ? byteLength
                : bytesPerBlock
            uploadedBytesTotal += chunkBytes
            const now = Date.now()
            const elapsed = (now - lastUploadTime) / 1000
            if (elapsed >= 0.5) {
              const deltaBytes = uploadedBytesTotal - lastUploadBytes
              uploadSpeed = elapsed > 0 ? deltaBytes / elapsed : 0
              lastUploadBytes = uploadedBytesTotal
              lastUploadTime = now
            }

            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                peerCount: core.peers?.length || 0
              })
              videoStats.emitStats(driveKey, videoPath)
            }
          }

          const monitor = {
            downloadSpeed: () => (Date.now() - lastSpeedTime > 2000 ? 0 : downloadSpeed),
            uploadSpeed: () => (Date.now() - lastUploadTime > 2000 ? 0 : uploadSpeed)
          }

          core.on('download', onDownload)
          core.on('upload', onUpload)
          if (videoStats) {
            videoStats.registerMonitor(driveKey, videoPath, monitor, () => {
              core.off('download', onDownload)
              core.off('upload', onUpload)
            })
          }

          // Initialize range tracking entry (ranges added as they're created)
          activeRangeRequests.set(prefetchKey, { ranges: [], core, onDownload, onUpload })

          if (!wasCached) {
            let fullDownloadStarted = false
            const startFullDownload = () => {
              if (fullDownloadStarted) return
              fullDownloadStarted = true
              const downloadRange = core.download({ start: startBlock, end: endBlock })
              activeRangeRequests.get(prefetchKey)?.ranges.push(downloadRange)
              downloadRange.done().then(async () => {
                console.log('[API] Download complete (blobs)')
                await deleteDownloadIntent(ctx, driveKey, videoPath).catch(err =>
                  console.log('[API] Failed to delete download intent:', err?.message)
                )
                downloadSpeed = 0
                if (videoStats) {
                  videoStats.updateStats(driveKey, videoPath, { status: 'complete' })
                  videoStats.emitStats(driveKey, videoPath, true) // force=true for completion
                  setTimeout(() => videoStats.cleanupMonitor(driveKey, videoPath), 30000)
                }
                activeRangeRequests.delete(prefetchKey)
                // Register completed download as a seed for quota tracking
                if (seedingManager) {
                  seedingManager.addSeed(driveKey, videoPath, 'watched', {
                    blockLength: totalBlocks,
                    byteLength: totalBytes
                  }).catch(err => console.log('[API] Failed to register seed:', err?.message))
                }
              }).catch(err => {
                if (err.message?.includes('closed') || ctx.store.closed) {
                  console.log('[API] Prefetch cancelled (corestore closed)')
                } else {
                  console.error('[API] Prefetch error:', err.message)
                }
                if (videoStats) {
                  videoStats.updateStats(driveKey, videoPath, { status: 'cancelled' })
                  videoStats.emitStats(driveKey, videoPath, true) // force=true for cancellation
                  videoStats.cleanupMonitor(driveKey, videoPath)
                }
                activeRangeRequests.delete(prefetchKey)
              })
            }

            const startInitPrefetch = () => {
              // Head prefetch: prioritize container headers and early samples.
              if (headBlocks > 0 && headBlocks < totalBlocks) {
                const headEnd = Math.min(endBlock, startBlock + headBlocks)
                console.log('[API] Prefetch head range (blobs):', (headEnd - startBlock), 'blocks')
                const headRange = core.download({ start: startBlock, end: headEnd })
                activeRangeRequests.get(prefetchKey).ranges.push(headRange)
                let headTimeout = null
                headTimeout = setTimeout(() => {
                  console.log('[API] Head prefetch slow, starting full download in parallel')
                  startFullDownload()
                }, 1500)
                headRange.done().then(() => {
                  console.log('[API] Head prefetch complete (blobs)')
                  resolvePlaybackReady?.()
                  if (headTimeout) clearTimeout(headTimeout)
                  startFullDownload()
                }).catch(err => {
                  console.log('[API] Head prefetch error (blobs):', err?.message)
                  if (headTimeout) clearTimeout(headTimeout)
                  startFullDownload()
                })
              } else {
                startFullDownload()
              }

              // Tail prefetch: helps players that seek for indices (MP4 moov-at-end, MKV cues).
              if (tailBlocks > 0 && tailBlocks < totalBlocks) {
                const tailStart = Math.max(startBlock, endBlock - tailBlocks)
                // Avoid duplicating the head range on tiny files.
                if (tailStart > startBlock + Math.max(1, headBlocks)) {
                  console.log('[API] Prefetch tail range (blobs):', (endBlock - tailStart), 'blocks')
                  const tailRange = core.download({ start: tailStart, end: endBlock })
                  activeRangeRequests.get(prefetchKey).ranges.push(tailRange)
                  tailRange.done().then(() => {
                    console.log('[API] Tail prefetch complete (blobs)')
                  }).catch(err => {
                    console.log('[API] Tail prefetch error (blobs):', err?.message)
                  })
                }
              }

              // Mid prefetch: some files place indexes/headers in the middle; keep it small.
              if (midBlocks > 0 && midBlocks < totalBlocks && totalBlocks > (headBlocks + tailBlocks + midBlocks + 4)) {
                const midCenter = startBlock + Math.floor(totalBlocks / 2)
                const midStart = Math.max(startBlock, Math.min(endBlock - 1, midCenter - Math.floor(midBlocks / 2)))
                const midEnd = Math.min(endBlock, midStart + midBlocks)
                const headEnd = Math.min(endBlock, startBlock + headBlocks)
                const tailStart = Math.max(startBlock, endBlock - tailBlocks)
                const overlapsHead = midStart < headEnd && midEnd > startBlock
                const overlapsTail = midStart < endBlock && midEnd > tailStart
                if (!overlapsHead && !overlapsTail && midEnd > midStart) {
                  console.log('[API] Prefetch mid range (blobs):', (midEnd - midStart), 'blocks')
                  const midRange = core.download({ start: midStart, end: midEnd })
                  activeRangeRequests.get(prefetchKey).ranges.push(midRange)
                  midRange.done().then(() => {
                    console.log('[API] Mid prefetch complete (blobs)')
                  }).catch(err => {
                    console.log('[API] Mid prefetch error (blobs):', err?.message)
                  })
                }
              }
            }

            startInitPrefetch()
          } else if (videoStats) {
            // Keep stats fresh for cached videos so upload speeds can update.
            videoStats.emitStats(driveKey, videoPath, true) // force=true for cached videos
            // Clean up any stale download intent and register as seed (video is already fully cached)
            deleteDownloadIntent(ctx, driveKey, videoPath).catch(() => {})
            if (seedingManager) {
              seedingManager.addSeed(driveKey, videoPath, 'watched', {
                blockLength: totalBlocks,
                byteLength: totalBytes
              }).catch(() => {})
            }
          }

          await playbackReady

          return {
            success: true,
            totalBlocks,
            totalBytes,
            peerCount: core.peers?.length || 0,
            initialBlocks: initialAvailable,
            cached: wasCached,
            message: wasCached ? 'Video already fully cached' : 'Prefetch started'
          }
        }

        return { success: false, error: 'Video missing blob metadata' }
      } catch (err) {
        console.error('[API] Prefetch error:', err.message);
        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { status: 'error', error: err.message });
          videoStats.cleanupMonitor(driveKey, videoPath);
        }
        activeRangeRequests.delete(prefetchKey)
        return { success: false, error: err.message };
      }
      })()

      prefetchInFlight.set(prefetchKey, prefetchPromise)
      try {
        return await prefetchPromise
      } finally {
        prefetchInFlight.delete(prefetchKey)
      }
    },

    /**
     * Prefetch next videos in a channel for smooth playback.
     * Called when a video starts playing to preload upcoming content.
     *
     * @param {string} channelKey - Channel key
     * @param {string} currentVideoId - Current video ID being watched
     * @param {number} [count=3] - Number of next videos to prefetch
     * @returns {Promise<{success: boolean, prefetchedCount?: number, error?: string}>}
     */
    async prefetchNextVideos(channelKey, currentVideoId, count = 3) {
      console.log('[API] prefetchNextVideos: channel:', channelKey?.slice(0, 16), 'current:', currentVideoId, 'count:', count)

      try {
        // Get list of videos for this channel
        const videosResult = await this.listVideos({ channelKey })
        const videos = videosResult?.videos || []

        if (videos.length === 0) {
          console.log('[API] prefetchNextVideos: no videos found')
          return { success: true, prefetchedCount: 0 }
        }

        // Find current video index
        const currentIndex = videos.findIndex(v =>
          v.id === currentVideoId ||
          v.videoId === currentVideoId ||
          v.path?.includes(currentVideoId)
        )

        if (currentIndex === -1) {
          console.log('[API] prefetchNextVideos: current video not found in list')
          // Fall back to prefetching first N videos
          const toPreload = videos.slice(0, count)
          for (const video of toPreload) {
            const videoRef = video.id || video.videoId || video.path
            // Fire and forget - don't wait for each prefetch
            this.prefetchVideo(channelKey, videoRef).catch(() => {})
          }
          return { success: true, prefetchedCount: toPreload.length }
        }

        // Get next N videos after current
        const nextVideos = videos.slice(currentIndex + 1, currentIndex + 1 + count)
        console.log('[API] prefetchNextVideos: found', nextVideos.length, 'videos to prefetch')

        // Start prefetching in background (fire and forget)
        let prefetchedCount = 0
        for (const video of nextVideos) {
          const videoRef = video.id || video.videoId || video.path
          console.log('[API] prefetchNextVideos: starting prefetch for:', videoRef)
          // Don't await - run in background
          this.prefetchVideo(channelKey, videoRef).catch(err => {
            console.log('[API] prefetchNextVideos: prefetch error for', videoRef, ':', err?.message)
          })
          prefetchedCount++
        }

        return { success: true, prefetchedCount }
      } catch (err) {
        console.error('[API] prefetchNextVideos error:', err.message)
        return { success: false, prefetchedCount: 0, error: err.message }
      }
    },

    /**
     * Get video stats
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Object}
     */
    getVideoStats(driveKey, videoPath) {
      if (videoStats) {
        const stats = videoStats.getStats(driveKey, videoPath);
        if (stats) {
          stats.swarmConnections = ctx.swarm?.connections?.size || 0;
          return stats;
        }
      }

      return {
        status: 'unknown',
        progress: 0,
        totalBlocks: 0,
        downloadedBlocks: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        peerCount: ctx.swarm?.connections?.size || 0,
        swarmConnections: ctx.swarm?.connections?.size || 0,
        speedMBps: '0',
        elapsed: 0,
        isComplete: false
      };
    },

    /**
     * Check if a video blob is fully synced (all blocks locally available)
     * @param {string} blobUrl - Full blob server URL
     * @returns {Promise<{isComplete: boolean, progress: number, availableBlocks: number, totalBlocks: number, byteLength: number}>}
     */
    async checkVideoSync(blobUrl) {
      console.log('[API] CHECK_VIDEO_SYNC:', blobUrl?.slice(0, 180));
      try {
        const parsed = new URL(blobUrl);
        const keyParam = parsed.searchParams.get('key');
        const blobParam = parsed.searchParams.get('blob');
        
        console.log('[API] CHECK_VIDEO_SYNC: key param:', keyParam?.slice(0, 16), 'blob param:', blobParam?.slice(0, 30));

        if (!keyParam) {
          console.log('[API] CHECK_VIDEO_SYNC: missing key param, all params:', Array.from(parsed.searchParams.keys()).join(', '));
          // If video is cached in UI, assume it's complete (can't check without key)
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        // Parse blob ID - BlobServer uses z32-encoded compact-encoding format
        // blobId codec matches hypercore-blob-server's format
        const blobIdCodec = {
          preencode(state, b) {
            c.uint.preencode(state, b.blockOffset)
            c.uint.preencode(state, b.blockLength)
            c.uint.preencode(state, b.byteOffset)
            c.uint.preencode(state, b.byteLength)
          },
          encode(state, b) {
            c.uint.encode(state, b.blockOffset)
            c.uint.encode(state, b.blockLength)
            c.uint.encode(state, b.byteOffset)
            c.uint.encode(state, b.byteLength)
          },
          decode(state) {
            return {
              blockOffset: c.uint.decode(state),
              blockLength: c.uint.decode(state),
              byteOffset: c.uint.decode(state),
              byteLength: c.uint.decode(state)
            }
          }
        };

        let blob = null;
        if (blobParam) {
          try {
            // Decode z32-encoded blob ID
            const decoded = z32.decode(blobParam);
            blob = c.decode(blobIdCodec, decoded);
            console.log('[API] CHECK_VIDEO_SYNC: decoded blob:', JSON.stringify(blob));
          } catch (decodeErr) {
            console.log('[API] CHECK_VIDEO_SYNC: blob decode failed:', decodeErr?.message);
          }
        }

        if (!blob) {
          console.log('[API] CHECK_VIDEO_SYNC: missing or invalid blob param, all params:', Array.from(parsed.searchParams.keys()).join(', '));
          // If video is cached in UI, assume it's complete (can't check without blob info)
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        // Load the blobs core - key is HypercoreID encoded (z32-based), not hex
        let keyBuffer;
        try {
          keyBuffer = HypercoreID.decode(keyParam);
          console.log('[API] CHECK_VIDEO_SYNC: decoded key buffer length:', keyBuffer.length);
        } catch (keyErr) {
          console.log('[API] CHECK_VIDEO_SYNC: key decode failed:', keyErr?.message);
          return { isComplete: true, progress: 100, availableBlocks: 0, totalBlocks: 0, byteLength: 0, assumed: true };
        }

        const blobsCore = ctx.store.get(keyBuffer);
        await blobsCore.ready();

        // Debug: check core state
        console.log('[API] CHECK_VIDEO_SYNC: core ready, length:', blobsCore.length, 'contiguousLength:', blobsCore.contiguousLength);

        // Check how many blocks are locally available
        const startBlock = blob.blockOffset;
        const endBlock = blob.blockOffset + blob.blockLength;
        const totalBlocks = blob.blockLength;
        
        console.log('[API] CHECK_VIDEO_SYNC: checking blocks', startBlock, 'to', endBlock, '(', totalBlocks, 'total)');

        // Quick check: if core.contiguousLength >= endBlock, all blocks are available
        if (blobsCore.contiguousLength >= endBlock) {
          console.log('[API] CHECK_VIDEO_SYNC: contiguousLength covers all blocks - COMPLETE');
          return {
            isComplete: true,
            progress: 100,
            availableBlocks: totalBlocks,
            totalBlocks,
            byteLength: blob.byteLength,
            // Return blob info for direct Hypercore access (HypercoreIOReader)
            blobInfo: blob,
            blobsCoreKey: keyBuffer.toString('hex')
          };
        }

        // IMPORTANT: In Hypercore v10+, has() is async!
        // For large videos, check a sample of blocks instead of all
        let availableBlocks = 0;
        const sampleSize = Math.min(totalBlocks, 20); // Check up to 20 blocks for speed
        const step = Math.max(1, Math.floor(totalBlocks / sampleSize));
        
        for (let i = startBlock; i < endBlock; i += step) {
          try {
            const hasBlock = await blobsCore.has(i);
            if (hasBlock) {
              availableBlocks++;
            }
          } catch (e) {
            console.log('[API] CHECK_VIDEO_SYNC: has() error at block', i, ':', e?.message);
          }
        }

        // Extrapolate from sample
        const sampledBlocks = Math.ceil((endBlock - startBlock) / step);
        const allSampledAvailable = availableBlocks >= sampledBlocks; // All sampled blocks available
        const progress = sampledBlocks > 0 ? Math.round((availableBlocks / sampledBlocks) * 100) : 0;

        // IMPORTANT: Sampling can give false positives!
        // Even if all sampled blocks are available, the video may not be complete
        // because we only check every Nth block. For true completion, contiguousLength must cover all blocks.
        // Only mark as complete if BOTH conditions are met:
        // 1. All sampled blocks are available (sample check passed)
        // 2. Core's contiguousLength is at least at startBlock (data is contiguous from beginning)
        //    AND contiguousLength is close to endBlock (within reasonable margin)
        const contiguousCoversStart = blobsCore.contiguousLength >= startBlock;
        const contiguousNearEnd = blobsCore.contiguousLength >= endBlock - Math.min(100, totalBlocks * 0.01);
        const isComplete = allSampledAvailable && contiguousCoversStart && contiguousNearEnd;

        console.log('[API] CHECK_VIDEO_SYNC: sampled', availableBlocks, '/', sampledBlocks, 'blocks (' + progress + '%)',
          'contiguous:', blobsCore.contiguousLength, 'need:', endBlock,
          isComplete ? 'COMPLETE' : 'INCOMPLETE');

        return {
          isComplete,
          progress,
          availableBlocks,
          totalBlocks,
          byteLength: blob.byteLength,
          // Return blob info for direct Hypercore access (HypercoreIOReader)
          blobInfo: blob,
          // Return hex-encoded key (not z32) for store.get(Buffer.from(key, 'hex'))
          blobsCoreKey: keyBuffer.toString('hex')
        };
      } catch (err) {
        console.error('[API] CHECK_VIDEO_SYNC error:', err?.message);
        return { isComplete: false, progress: 0, availableBlocks: 0, totalBlocks: 0, byteLength: 0, error: err?.message };
      }
    },

    // ============================================
    // Seeding Operations
    // ============================================

    /**
     * Get seeding status
     * @returns {Promise<Object>}
     */
    async getSeedingStatus() {
      if (seedingManager) {
        return seedingManager.getStatus();
      }
      return { error: 'Seeding manager not initialized' };
    },

    // ============================================
    // Transcode Settings
    // ============================================

    /**
     * Get transcoder settings for troubleshooting
     * @returns {Promise<{ settings: { videoToolboxDecodeEnabled: boolean, videoToolboxDecodeLocked: boolean, videoToolboxDecodeDefault: boolean, videoToolboxDecodeSource: string, videoToolboxHwMapEnabled: boolean, videoToolboxHwMapLocked: boolean, videoToolboxHwMapDefault: boolean, videoToolboxHwMapSource: string } }>}
     */
    async getTranscodeSettings() {
      return { settings: getVideoToolboxDecodeSettings() };
    },

    /**
     * Update transcoder settings for troubleshooting
     * @param {Object} req
     * @param {boolean} [req.videoToolboxDecodeEnabled]
     * @param {boolean} [req.videoToolboxHwMapEnabled]
     * @returns {Promise<{ success: boolean, error?: string, settings: object }>}
     */
    async setTranscodeSettings(req) {
      const decodeEnabled = req?.videoToolboxDecodeEnabled;
      const hwMapEnabled = req?.videoToolboxHwMapEnabled;
      const hasDecode = typeof decodeEnabled === 'boolean';
      const hasHwMap = typeof hwMapEnabled === 'boolean';
      if (!hasDecode && !hasHwMap) {
        return { success: false, error: 'Invalid request', settings: getVideoToolboxDecodeSettings() };
      }

      let settings = getVideoToolboxDecodeSettings();
      if (hasDecode) settings = setVideoToolboxDecodeEnabled(decodeEnabled, 'ui');
      if (hasHwMap) settings = setVideoToolboxHwMapEnabled(hwMapEnabled, 'ui');

      if (hasDecode && settings.videoToolboxDecodeLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_DECODE', settings };
      }
      if (hasHwMap && settings.videoToolboxHwMapLocked) {
        return { success: false, error: 'Locked by PEARTUBE_ENABLE_VT_HWMAP', settings };
      }

      try {
        await ctx.metaDb.put('transcode-settings', {
          videoToolboxDecodeEnabled: settings.videoToolboxDecodeEnabled,
          videoToolboxHwMapEnabled: settings.videoToolboxHwMapEnabled
        });
      } catch (err) {
        console.log('[API] Failed to persist transcode settings:', err?.message);
      }

      return { success: true, settings };
    },

    /**
     * Set seeding config
     * @param {Object} config
     * @returns {Promise<Object>}
     */
    async setSeedingConfig(config) {
      if (seedingManager) {
        await seedingManager.setConfig(config);
        return { success: true, config: seedingManager.config };
      }
      return { success: false, error: 'Seeding manager not initialized' };
    },

    /**
     * Pin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async pinChannel(driveKey) {
      console.log('[API] PIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        await seedingManager.pinChannel(driveKey);
        await loadChannel(ctx, driveKey);
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Unpin a channel
     * @param {string} driveKey
     * @returns {Promise<Object>}
     */
    async unpinChannel(driveKey) {
      console.log('[API] UNPIN_CHANNEL:', driveKey?.slice(0, 16));
      if (seedingManager && driveKey) {
        await seedingManager.unpinChannel(driveKey);
        return { success: true };
      }
      return { success: false, error: 'Invalid request' };
    },

    /**
     * Get pinned channels
     * @returns {{channels: string[]}}
     */
    getPinnedChannels() {
      if (seedingManager) {
        return { channels: seedingManager.getPinnedChannels() };
      }
      return { channels: [] };
    },

    // ============================================
    // Storage Management Operations
    // ============================================

    /**
     * Get storage stats for peer content
     * @returns {{ usedBytes: number, maxBytes: number, usedGB: string, maxGB: number, seedCount: number, pinnedCount: number }}
     */
    getStorageStats() {
      if (seedingManager) {
        return seedingManager.getStorageStats();
      }
      return {
        usedBytes: 0,
        maxBytes: 5 * 1024 * 1024 * 1024,
        usedGB: '0.00',
        maxGB: 5,
        seedCount: 0,
        pinnedCount: 0
      };
    },

    /**
     * Set storage limit in GB
     * @param {number} maxGB
     * @returns {Promise<{ success: boolean }>}
     */
    async setStorageLimit(maxGB) {
      console.log('[API] SET_STORAGE_LIMIT:', maxGB, 'GB');
      if (seedingManager) {
        await seedingManager.setMaxStorageGB(maxGB);
        return { success: true };
      }
      return { success: false };
    },

    /**
     * Clear all cached peer content (non-pinned)
     * @returns {Promise<{ success: boolean, clearedBytes: number }>}
     */
    async clearCache() {
      console.log('[API] CLEAR_CACHE');
      if (seedingManager) {
        const clearedBytes = await seedingManager.clearCache();
        return { success: true, clearedBytes };
      }
      return { success: false, clearedBytes: 0 };
    },

    // ============================================
    // Status Operations
    // ============================================

    /**
     * Get backend status
     * @returns {Object}
     */
    getStatus() {
      return {
        connected: true,
        peers: ctx.swarm?.connections?.size || 0,
        blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
        blobServerHost: ctx.blobServerHost || '127.0.0.1',
        version: '0.1.0'
      };
    },

    /**
     * Get swarm status for debugging
     * @returns {Object}
     */
    getSwarmStatus() {
      const topicHex = publicFeed ? b4a.toString(publicFeed.feedTopic, 'hex') : 'not initialized';
      return {
        swarmConnections: ctx.swarm?.connections?.size || 0,
        swarmPeers: ctx.swarm?.peers?.size || 0,
        feedConnections: publicFeed?.feedConnections?.size || 0,
        feedEntries: publicFeed?.entries?.size || 0,
        feedTopicHex: topicHex,
        swarmPublicKey: ctx.swarm?.keyPair?.publicKey
          ? b4a.toString(ctx.swarm.keyPair.publicKey, 'hex').slice(0, 32)
          : 'unknown',
        channelsLoaded: ctx.channels?.size || 0,
      };
    }

    ,
    // ============================================
    // Multi-device pairing (Multi-writer channels)
    // ============================================

    /**
     * Create a device invite code for a multi-writer channel.
     * @param {string} channelKey
     * @returns {Promise<{inviteCode: string}>}
     */
    async createDeviceInvite(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const inviteCode = await channel.createInvite({})
      return { inviteCode }
    },

    /**
     * Pair this device to an existing channel using an invite code.
     * @param {string} inviteCode
     * @param {string} [deviceName]
     * @returns {Promise<{success: boolean, channelKey: string, syncState?: string, videoCount?: number}>}
     */
    async pairDevice(inviteCode, deviceName = '') {
      const { channel, channelKeyHex } = await pairChannelDevice(ctx, inviteCode, { deviceName })

      // Use smart sync - waits for peer connection first, then polls for data
      console.log('[API] pairDevice: starting smart sync...')
      const syncResult = await channel.waitForInitialSync({
        peerTimeout: 30000,  // 30s for DHT discovery
        dataTimeout: 20000,  // 20s for data sync after connected
        onProgress: (state, detail) => {
          console.log('[API] pairDevice sync progress:', state, detail)
        }
      })

      console.log('[API] pairDevice: sync result:', syncResult)

      return {
        success: true,
        channelKey: channelKeyHex,
        syncState: syncResult.state,
        videoCount: syncResult.videoCount
      }
    },

    /**
     * Retry syncing a channel that may have failed initial sync.
     * @param {string} channelKey
     * @returns {Promise<{success: boolean, state: string, videoCount: number}>}
     */
    async retrySyncChannel(channelKey) {
      const channel = await loadChannel(ctx, channelKey)

      console.log('[API] retrySyncChannel: starting sync for', channelKey?.slice(0, 16))
      const result = await channel.waitForInitialSync({
        peerTimeout: 30000,
        dataTimeout: 20000,
        onProgress: (state, detail) => {
          console.log('[API] retrySyncChannel progress:', state, detail)
        }
      })

      return {
        success: result.success,
        state: result.state,
        videoCount: result.videoCount
      }
    },

    /**
     * List known devices/writers for a channel.
     * @param {string} channelKey
     * @returns {Promise<{devices: Array<{keyHex: string, role?: string, deviceName?: string, addedAt?: number, blobDriveKey?: string|null}>}>}
     */
    async listDevices(channelKey) {
      const channel = await loadChannel(ctx, channelKey)
      const devices = await channel.listWriters()
      return { devices }
    },

    // ============================================
    // Search Operations
    // ============================================

    /**
     * Search videos in a channel using semantic search
     * @param {string} channelKey
     * @param {string} query
     * @param {Object} [options]
     * @param {number} [options.topK=10]
     * @param {boolean} [options.federated=true]
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async searchVideos(channelKey, query, options = {}) {
      const { topK = 10, federated = true } = options

      // Ensure semantic finder is initialized with persistence
      await ensureSemanticFinder(ctx)

      // Initialize federated search if not already done
      if (!ctx.federatedSearch && ctx.swarm) {
        ctx.federatedSearch = new FederatedSearch(ctx.swarm, ctx.semanticFinder)
        const channelKeyBuf = b4a.from(channelKey, 'hex')
        ctx.federatedSearch.setupTopic(channelKeyBuf)
      }

      // Use federated search if available, otherwise local only
      if (ctx.federatedSearch && federated) {
        return await ctx.federatedSearch.search(query, { topK, federated, timeout: 5000 })
      } else {
        return await ctx.semanticFinder.search(query, topK)
      }
    },

    /**
     * Global search across ALL discovered channels (YouTube-Fast)
     * Uses pre-built global index for O(1) search instead of iterating channels
     * @param {string} query - Search query
     * @param {Object} [options]
     * @param {number} [options.topK=50] - Max results to return
     * @returns {Promise<Array<{id: string, score: number, metadata: any}>>}
     */
    async globalSearchVideos(query, options = {}) {
      const { topK = 50 } = options

      console.log('[API] globalSearchVideos:', query, 'topK:', topK)

      // Ensure semantic finder is initialized with persistence
      const finder = await ensureSemanticFinder(ctx)

      // Best-effort: import replicated vectors from any loaded channels.
      if (ctx.channels && ctx.channels.size > 0) {
        ;(async () => {
          for (const [channelKey, channel] of ctx.channels.entries()) {
            try {
              await finder.ensureGlobalIndexedFromChannelView(channelKey, channel)
            } catch {}
          }
        })()
      }

      // Fast global search - O(1) not O(channels)
      const results = await finder.globalSearch(query, topK)
      console.log('[API] globalSearchVideos: found', results.length, 'results in global index')

      // Validate results exist and lazily prune stale entries
      const validated = []
      const staleIds = []
      for (const r of results) {
        const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
        const channelKey = meta.channelKey || meta.driveKey
        if (!channelKey) { validated.push(r); continue }
        try {
          const video = await this.getVideoData(channelKey, r.id, meta.publicBeeKey)
          if (video) { validated.push(r); continue }
        } catch {}
        staleIds.push(r.id)
      }

      if (staleIds.length > 0) {
        console.log('[API] globalSearchVideos: pruning', staleIds.length, 'stale entries')
        for (const id of staleIds) {
          try { finder.removeVideo(id) } catch {}
        }
      }

      return validated
    },

    /**
     * Index a video for semantic search (YouTube-Fast)
     * Uses global index with persistence for instant search
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean}>}
     */
    async indexVideoVectors(channelKey, videoId) {
      try {
        // Get video data
        const video = await this.getVideoData(channelKey, videoId)
        if (!video) {
          return { success: false, error: 'Video not found' }
        }

        // Ensure semantic finder is initialized with persistence
        const finder = await ensureSemanticFinder(ctx)

        // Skip if already indexed
        if (finder.hasVideo(videoId)) {
          return { success: true, alreadyIndexed: true }
        }

        // Index to global index (YouTube-Fast)
        await finder.indexFromMetadata({ ...video, id: videoId }, channelKey)

        // Store vector index op in Autobase (for replication to other peers)
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
          const channel = await loadChannel(ctx, channelKey)
          const embedding = await finder.embed(`${video.title || ''} ${video.description || ''}`)
          const vectorBase64 = b4a.toString(
            b4a.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            'base64'
          )

          await channel.base.append({
            type: 'add-vector-index',
            schemaVersion: 1,
            videoId,
            vector: vectorBase64,
            text: `${video.title || ''} ${video.description || ''}`,
            metadata: JSON.stringify({ channelKey, title: video.title }),
            indexedAt: Date.now()
          })
        }

        return { success: true }
      } catch (err) {
        console.error('[API] indexVideoVectors error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Comments Operations (using separate CommentsAutobase)
    // ============================================

    /**
     * Get or create CommentsAutobase for a channel
     * @param {string} channelKey
     * @param {string} [publicBeeKey] - PublicBee key for looking up commentsAutobaseKey
     * @returns {Promise<import('./channel/comments-autobase.js').CommentsAutobase>}
     */
    async _getCommentsAutobase(channelKey, publicBeeKey = null) {
      console.log('[API] _getCommentsAutobase: START channelKey:', channelKey?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      // Lazy import to avoid circular deps
      console.log('[API] _getCommentsAutobase: importing comments-autobase...')
      const { getOrCreateCommentsAutobase } = await import('./channel/comments-autobase.js')
      console.log('[API] _getCommentsAutobase: import complete')

      // Cache key
      const cacheKey = `comments:${channelKey}`
      if (!ctx._commentsCache) ctx._commentsCache = new Map()

      // IMPORTANT: listComments + getReactions are commonly called in parallel.
      // If we don't cache the in-flight open, we'll instantiate multiple Autobase
      // instances for the same key on the same Corestore, which can lead to flaky
      // replication / empty reads.
      const cached = ctx._commentsCache.get(cacheKey)
      if (cached) {
        console.log('[API] _getCommentsAutobase: found cached promise, waiting with 12s timeout...')
        // Add timeout to prevent hanging forever on a stuck promise
        // Must be longer than CommentsAutobase internal timeout (8s for viewer ready)
        const result = await Promise.race([
          cached,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cached CommentsAutobase promise timed out after 12s')), 12000))
        ]).catch(err => {
          console.log('[API] _getCommentsAutobase: cached promise failed:', err?.message)
          // Clear the bad cache entry so next call can retry
          ctx._commentsCache.delete(cacheKey)
          throw err
        })
        console.log('[API] _getCommentsAutobase: cached promise resolved')

        // FIX: Try to update admin key on cached instance if not already set
        // This handles the case where the instance was cached before admin key was available
        if (!result._adminKeyHex && publicBeeKey) {
          try {
            const pubBee = await Promise.race([
              loadPublicBee(ctx, publicBeeKey),
              new Promise((resolve) => setTimeout(() => resolve(null), 2000))
            ])
            if (pubBee) {
              const meta = await Promise.race([
                pubBee.getMetadata(),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000))
              ]).catch(() => null)
              if (meta?.commentsAdminKey) {
                result.setAdminKey?.(meta.commentsAdminKey)
                console.log('[API] _getCommentsAutobase: updated admin key on cached instance')
              }
            }
          } catch (err) {
            console.log('[API] _getCommentsAutobase: could not update admin key on cached instance:', err?.message)
          }
        }

        return result
      }

      const openPromise = (async () => {
        console.log('[API] _getCommentsAutobase: openPromise STARTED')
        let resolvedPublicBeeKey = (typeof publicBeeKey === 'string' && publicBeeKey.length > 0) ? publicBeeKey : null
        let commentsAutobaseKey = null
        let commentsAdminKey = null
        /** @type {any|null} */
        let pubBee = null

        // FIRST: Try to get publicBeeKey from public feed (fastest path for viewers)
        // Do this BEFORE trying to load any channels to avoid hangs
        console.log('[API] _getCommentsAutobase: checking public feed for publicBeeKey...')
        if (!resolvedPublicBeeKey && publicFeed) {
          console.log('[API] _getCommentsAutobase: publicFeed exists, calling getFeed()...')
          try {
            const feed = publicFeed.getFeed()
            console.log('[API] _getCommentsAutobase: got feed with', feed?.length, 'entries')
            const entry = feed.find(e => e.channelKey === channelKey || e.driveKey === channelKey)
            if (entry?.publicBeeKey) {
              resolvedPublicBeeKey = entry.publicBeeKey
              console.log('[API] _getCommentsAutobase: found publicBeeKey in feed:', resolvedPublicBeeKey?.slice(0, 16))
            } else {
              console.log('[API] _getCommentsAutobase: channel not found in feed or no publicBeeKey')
            }
          } catch (err) {
            console.log('[API] _getCommentsAutobase: feed lookup error:', err?.message)
          }
        } else if (!publicFeed) {
          console.log('[API] _getCommentsAutobase: publicFeed is not available')
        }

        // Check if we have a local identity for this channel (owner/paired device)
        console.log('[API] _getCommentsAutobase: checking local identity...')
        let hasLocalIdentity = false
        try {
          const identities = await ctx.metaDb?.get('identities').catch(() => null)
          hasLocalIdentity = identities?.value?.some(i =>
            i.channelKey === channelKey || i.driveKey === channelKey
          ) || false
        } catch (err) {
          console.log('[API] _getCommentsAutobase: identity check error:', err?.message)
        }
        console.log('[API] _getCommentsAutobase: hasLocalIdentity:', hasLocalIdentity)

        // Only try loading the full channel Autobase when we have a local identity (owner/paired device)
        // Do NOT load channel just because it's in ctx.channels - that could be a stale/incomplete viewer load
        /** @type {any|null} */
        let localChannel = null
        if (hasLocalIdentity) {
          console.log('[API] _getCommentsAutobase: loading local channel (owner/paired device)...')
          try {
            // Don't block forever: if the channel is slow to open, fall back to PublicBee.
            localChannel = await Promise.race([
              loadChannel(ctx, channelKey),
              new Promise((_, reject) => setTimeout(() => reject(new Error('loadChannel timeout')), 3000))
            ])
            console.log('[API] _getCommentsAutobase: local channel loaded')

            // If the channel already has a CommentsAutobase instance, use it (fast path for owners).
            if (localChannel?.commentsAutobase) {
              console.log('[API] _getCommentsAutobase: using channel.commentsAutobase')
              const commentsBase = localChannel.commentsAutobase
              const isPublishingDevice = Boolean(localChannel.publicBee?.writable)
              if (isPublishingDevice) commentsBase.setIsChannelOwner?.(true)

              const meta = await Promise.race([
                localChannel?.getMetadata?.(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getMetadata timeout')), 2000))
              ]).catch(() => null)
              const metaAdminKey = meta?.commentsAdminKey || null
              if (metaAdminKey) {
                commentsBase.setAdminKey?.(metaAdminKey)
              }

              const adminKeyHex = commentsBase.localWriterKeyHex
              if (!metaAdminKey && adminKeyHex) {
                commentsBase.setAdminKey?.(adminKeyHex)
              }

              if (isPublishingDevice && adminKeyHex && (!metaAdminKey || metaAdminKey !== adminKeyHex)) {
                try {
                  await localChannel.updateMetadata({ commentsAdminKey: adminKeyHex })
                } catch (err) {
                  console.log('[API] _getCommentsAutobase: could not store admin key in channel metadata:', err?.message)
                }
                try {
                  await localChannel.publicBee?.setMetadata({ commentsAdminKey: adminKeyHex })
                  console.log('[API] _getCommentsAutobase: published commentsAdminKey to PublicBee')
                } catch (err) {
                  console.log('[API] _getCommentsAutobase: could not publish admin key:', err?.message)
                }
              }

              return commentsBase
            }

            // Prefer canonical keys from channel metadata / PublicBee if available.
            const meta = await Promise.race([
              localChannel?.getMetadata?.(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('getMetadata timeout')), 2000))
            ]).catch(() => null)
            commentsAutobaseKey = meta?.commentsAutobaseKey || null
            commentsAdminKey = meta?.commentsAdminKey || null
            resolvedPublicBeeKey = resolvedPublicBeeKey ||
              localChannel?.publicBeeKey ||
              null

            // Only try getPublicBeeKey if we still don't have it
            if (!resolvedPublicBeeKey) {
              resolvedPublicBeeKey = await Promise.race([
                localChannel?.getPublicBeeKey?.(),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000))
              ]).catch(() => null)
            }
            console.log('[API] _getCommentsAutobase: from local channel - commentsAutobaseKey:', commentsAutobaseKey?.slice(0, 16) || 'null')
          } catch (err) {
            console.log('[API] _getCommentsAutobase: local channel lookup failed:', err?.message)
          }
        }

        // Without a PublicBee key, viewers cannot discover comments.
        console.log('[API] _getCommentsAutobase: resolvedPublicBeeKey is:', resolvedPublicBeeKey?.slice(0, 16) || 'null')
        if (!resolvedPublicBeeKey) {
          console.log('[API] _getCommentsAutobase: no publicBeeKey found, throwing error')
          throw new Error('Comments unavailable (missing publicBeeKey)')
        }

        // Load the PublicBee and read the published commentsAutobaseKey.
        // The PublicBee writer (single device) is also the only device allowed to create/publish the comments key.
        let isPublishingDevice = false
        console.log('[API] _getCommentsAutobase: about to load PublicBee:', resolvedPublicBeeKey?.slice(0, 16))
        try {
          console.log('[API] _getCommentsAutobase: calling loadPublicBee with 5s timeout...')
          pubBee = await Promise.race([
            loadPublicBee(ctx, resolvedPublicBeeKey),
            new Promise((_, reject) => setTimeout(() => reject(new Error('loadPublicBee timeout after 5s')), 5000))
          ])
          console.log('[API] _getCommentsAutobase: loadPublicBee completed')
          isPublishingDevice = Boolean(pubBee?.writable)
          console.log('[API] _getCommentsAutobase: PublicBee loaded, writable:', isPublishingDevice)

          if (!commentsAutobaseKey) {
            console.log('[API] _getCommentsAutobase: getting metadata from PublicBee...')
            const meta = await Promise.race([
              pubBee.getMetadata(),
              new Promise((resolve) => setTimeout(() => resolve(null), 2000))
            ]).catch(() => null)
            commentsAutobaseKey = meta?.commentsAutobaseKey || null
            commentsAdminKey = commentsAdminKey || meta?.commentsAdminKey || null
            console.log('[API] _getCommentsAutobase: commentsAutobaseKey from PublicBee:', commentsAutobaseKey?.slice(0, 16) || 'null')
          }
        } catch (err) {
          console.log('[API] _getCommentsAutobase: PublicBee lookup failed:', err?.message)
        }

        // IMPORTANT: non-publishing devices must never create a new CommentsAutobase implicitly.
        // Creating by `{ name }` is deterministic per-device (not globally) and will fork comments.
        if (!isPublishingDevice && !commentsAutobaseKey) {
          throw new Error('Comments unavailable (commentsAutobaseKey not published yet)')
        }

        console.log('[API] _getCommentsAutobase: creating CommentsAutobase, isOwner:', isPublishingDevice, 'key:', commentsAutobaseKey?.slice(0, 16) || 'new')
        console.log('[API] _getCommentsAutobase: swarm connections:', ctx.swarm?.connections?.size || 0)

        let commentsBase
        try {
          commentsBase = await getOrCreateCommentsAutobase(ctx.store, {
            channelKey,
            commentsAutobaseKey,
            commentsAdminKey,
            isChannelOwner: isPublishingDevice,
            swarm: ctx.swarm
          })
        } catch (err) {
          // Provide a user-friendly error for viewers when owner is offline
          if (err?.message?.includes('timeout') && !isPublishingDevice) {
            throw new Error('Comments unavailable - channel owner may be offline. Try again later.')
          }
          throw err
        }
        console.log('[API] _getCommentsAutobase: CommentsAutobase ready, key:', commentsBase.keyHex?.slice(0, 16))
        if (commentsAdminKey) {
          commentsBase.setAdminKey?.(commentsAdminKey)
        }

        // Publishing device: publish the key to PublicBee if it wasn't there yet.
        if (isPublishingDevice && pubBee?.writable && commentsBase.keyHex && !commentsAutobaseKey) {
          try {
            await pubBee.setMetadata({ commentsAutobaseKey: commentsBase.keyHex })
            console.log('[API] _getCommentsAutobase: published commentsAutobaseKey to PublicBee')
          } catch (err) {
            console.log('[API] _getCommentsAutobase: could not publish key to PublicBee:', err?.message)
          }
        }

        // Publishing device: publish admin key if missing or stale.
        if (isPublishingDevice && pubBee?.writable && commentsBase.localWriterKeyHex) {
          const adminKeyHex = commentsBase.localWriterKeyHex
          if (!commentsAdminKey || commentsAdminKey !== adminKeyHex) {
            try {
              await pubBee.setMetadata({ commentsAdminKey: adminKeyHex })
              console.log('[API] _getCommentsAutobase: published commentsAdminKey to PublicBee')
            } catch (err) {
              console.log('[API] _getCommentsAutobase: could not publish admin key:', err?.message)
            }
          }
          if (localChannel) {
            try {
              await localChannel.updateMetadata({ commentsAdminKey: adminKeyHex })
            } catch (err) {
              console.log('[API] _getCommentsAutobase: could not store admin key in channel metadata:', err?.message)
            }
          }
        }

        return commentsBase
      })()

      ctx._commentsCache.set(cacheKey, openPromise)
      try {
        return await openPromise
      } catch (err) {
        ctx._commentsCache.delete(cacheKey)
        throw err
      }
    },

    /**
     * Add a comment to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} text
     * @param {string} [parentId]
     * @param {string} [publicBeeKey]
     * @returns {Promise<{success: boolean, commentId?: string, error?: string}>}
     */
    async addComment(channelKey, videoId, text, parentId = null, publicBeeKey = null) {
      // SYNC LOG - this should ALWAYS appear immediately
      console.log('[API] ====== addComment ENTERED ======')
      console.log('[API] addComment: channelKey:', channelKey?.slice(0, 16), 'videoId:', videoId?.slice(0, 16), 'publicBeeKey:', publicBeeKey?.slice(0, 16) || 'null')

      try {
        console.log('[API] addComment: getting CommentsAutobase...')
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        console.log('[API] addComment: got CommentsAutobase, adding comment...')
        const result = await commentsBase.addComment(videoId, text, parentId)
        const peerCount = commentsBase?.swarm?.connections?.size || 0
        const queued = typeof result?.queued === 'boolean'
          ? result.queued
          : (!commentsBase?.writable && peerCount === 0)
        console.log('[API] addComment: comment added:', result.commentId?.slice(0, 8))
        return { success: true, commentId: result.commentId, queued }
      } catch (err) {
        console.error('[API] addComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * List comments for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.page=0]
     * @param {number} [options.limit=50]
     * @param {string} [options.publicBeeKey]
     * @returns {Promise<{comments: Array, success: boolean, error?: string}>}
     */
    async listComments(channelKey, videoId, options = {}) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, options.publicBeeKey)
        const comments = await commentsBase.listComments(videoId, options)
        return { success: true, comments }
      } catch (err) {
        console.error('[API] listComments error:', err.message)
        return { success: false, comments: [], error: err.message }
      }
    },

    /**
     * Hide a comment (moderator action)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async hideComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.hideComment(videoId, commentId)
        return { success: true }
      } catch (err) {
        console.error('[API] hideComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a comment (moderator or author)
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} commentId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeComment(channelKey, videoId, commentId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.removeComment(videoId, commentId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Reactions Operations (using separate CommentsAutobase)
    // ============================================

    /**
     * Add a reaction to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} reactionType
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async addReaction(channelKey, videoId, reactionType, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.addReaction(videoId, reactionType)
        return { success: true }
      } catch (err) {
        console.error('[API] addReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Remove a reaction from a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeReaction(channelKey, videoId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        await commentsBase.removeReaction(videoId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeReaction error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get reactions for a video
     * @param {string} channelKey
     * @param {string} videoId
     * @returns {Promise<{counts: Record<string, number>, userReaction: string|null, success: boolean, error?: string}>}
     */
    async getReactions(channelKey, videoId, publicBeeKey = null) {
      try {
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        const result = await commentsBase.getReactionCounts(videoId)
        return { success: true, counts: { like: result.likes, dislike: result.dislikes }, userReaction: result.userReaction }
      } catch (err) {
        console.error('[API] getReactions error:', err.message)
        return { success: false, counts: {}, userReaction: null, error: err.message }
      }
    },

    /**
     * Get debug info about the comments system for a channel
     * @param {string} channelKey
     * @param {string} [publicBeeKey]
     * @returns {Promise<Object>}
     */
    async getCommentsDebugInfo(channelKey, publicBeeKey = null) {
      const debugInfo = {
        success: false,
        // Connection
        swarmPeers: ctx.swarm?.connections?.size || 0,
        commentsConnected: false,

        // CommentsAutobase
        commentsAutobaseKey: null,
        isWriter: false,
        isChannelOwner: false,
        localWriterKey: null,

        // Channel info
        channelKey: channelKey?.slice(0, 16) || null,
        publicBeeKey: publicBeeKey?.slice(0, 16) || null,
        hasPublicBee: false,
        publicBeeHasCommentsKey: false,

        // Data
        viewLength: 0,

        // Errors
        lastError: null
      }

      try {
        // Try to load channel first
        let channel = null
        try {
          channel = await loadChannel(ctx, channelKey)
          debugInfo.hasChannel = true
          debugInfo.channelWritable = channel.writable

          // Check if channel has PublicBee
          if (channel.publicBee) {
            debugInfo.hasPublicBee = true
            const pubMeta = await channel.publicBee.getMetadata().catch(() => ({}))
            debugInfo.publicBeeHasCommentsKey = Boolean(pubMeta?.commentsAutobaseKey)
          }

          // Check if channel has CommentsAutobase
          if (channel.commentsAutobase) {
            const ca = channel.commentsAutobase
            debugInfo.commentsAutobaseKey = ca.keyHex?.slice(0, 16) || null
            debugInfo.isWriter = ca.writable
            debugInfo.isChannelOwner = ca.isChannelOwner()
            debugInfo.localWriterKey = ca.localWriterKeyHex?.slice(0, 16) || null
            debugInfo.viewLength = ca.view?.core?.length || 0
            debugInfo.commentsConnected = true
            debugInfo.success = true
            return debugInfo
          }
        } catch (err) {
          debugInfo.channelError = err?.message
        }

        // Try to get CommentsAutobase via API method
        const commentsBase = await this._getCommentsAutobase(channelKey, publicBeeKey)
        debugInfo.commentsAutobaseKey = commentsBase?.keyHex?.slice(0, 16) || null
        debugInfo.isWriter = commentsBase?.writable || false
        debugInfo.isChannelOwner = commentsBase?.isChannelOwner?.() || false
        debugInfo.localWriterKey = commentsBase?.localWriterKeyHex?.slice(0, 16) || null
        debugInfo.viewLength = commentsBase?.view?.core?.length || 0
        debugInfo.commentsConnected = true
        debugInfo.success = true
      } catch (err) {
        debugInfo.lastError = err?.message || 'Unknown error'
      }

      return debugInfo
    },

    // ============================================
    // Recommendations Operations
    // ============================================

    /**
     * Log a watch event for recommendations
     * @param {string} channelKey
     * @param {string} videoId
     * @param {Object} [options]
     * @param {number} [options.duration]
     * @param {boolean} [options.completed]
     * @param {boolean} [options.share=false]
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async logWatchEvent(channelKey, videoId, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Watch events only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, error: 'Watch logger not initialized' }
        }

        await channel.watchLogger.logWatchEvent(videoId, options)
        return { success: true }
      } catch (err) {
        console.error('[API] logWatchEvent error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get video recommendations
     * @param {string} channelKey
     * @param {Object} [options]
     * @param {number} [options.limit=10]
     * @param {string[]} [options.excludeVideoIds]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getRecommendations(channelKey, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.watchLogger) {
          return { success: false, recommendations: [], error: 'Watch logger not initialized' }
        }

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender
        const recommender = new Recommender(channel, ctx.semanticFinder, channel.watchLogger)
        const recommendations = await recommender.generateRecommendations(options)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    /**
     * Get recommendations for a specific video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {number} [limit=5]
     * @returns {Promise<{recommendations: Array, success: boolean, error?: string}>}
     */
    async getVideoRecommendations(channelKey, videoId, limit = 5) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, recommendations: [], error: 'Recommendations only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)

        // Ensure semantic finder is initialized with persistence
        await ensureSemanticFinder(ctx)

        // Initialize recommender (watch logger may be null, that's ok)
        const watchLogger = channel.watchLogger || null
        const recommender = new Recommender(channel, ctx.semanticFinder, watchLogger)
        const recommendations = await recommender.getVideoRecommendations(videoId, limit)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getVideoRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    },

    // ============================================
    // Network Lifecycle Management
    // ============================================

    /**
     * Suspend networking for mobile background state.
     * Call this when the app goes to background to save battery.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async suspendNetwork() {
      try {
        await suspendNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] suspendNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Resume networking when app returns to foreground.
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async resumeNetwork() {
      try {
        await resumeNetworking()
        return { success: true }
      } catch (err) {
        console.error('[API] resumeNetwork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get network stats for debugging.
     * @returns {{stats: Object|null, readable: string}}
     */
    getNetworkDebugStats() {
      return {
        stats: getNetworkStats(),
        readable: getNetworkStatsReadable()
      }
    }
  };
}
