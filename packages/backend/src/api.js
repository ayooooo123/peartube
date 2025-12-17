/**
 * Core API Module - Shared backend API methods
 *
 * These methods are used by both mobile and desktop backends.
 * They operate on the storage context and return results.
 */

import b4a from 'b4a';
import { loadDrive, createDrive, getVideoUrl, waitForDriveSync, loadChannel, pairDevice as pairChannelDevice } from './storage.js';
import { SemanticFinder } from './search/semantic-finder.js';
import { FederatedSearch } from './search/federated-search.js';
import { Recommender } from './recommendations/recommender.js';

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

  function isHyperdriveDecodeError(err) {
    const msg = (err && err.message) ? String(err.message) : ''
    // hypercore / hyperbee / hyperdrive tend to surface this exact message for schema mismatch or corruption
    return msg.includes('DECODING_ERROR') || msg.includes('Decoded message is not valid')
  }

  async function markAsMultiWriterChannel(channelKey) {
    try {
      await ctx.metaDb.put(`mw-channel:${channelKey}`, { kind: 'autobase', discoveredAt: Date.now() })
    } catch {}
  }

  // ------------------------------------------------------------
  // Lightweight in-memory caching (worker-local)
  // ------------------------------------------------------------
  // The app UI (home tab) re-mounts on navigation and calls getChannelMeta/listVideos each time.
  // Cache recent results in the backend worker so back-navigation is instant.
  const LIST_VIDEOS_CACHE_TTL_MS = 15_000
  const CHANNEL_META_CACHE_TTL_MS = 30_000

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

  return {
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
        if (await isMultiWriterChannelKey(driveKey)) {
          const channel = await loadChannel(ctx, driveKey)
          const meta = await channel.getMetadata()
          return {
            name: meta?.name || 'Channel',
            description: meta?.description || '',
            avatar: meta?.avatar || null,
            createdAt: meta?.createdAt || Date.now(),
            publicKey: meta?.createdBy || null
          }
        }

        try {
          const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });
          const metaBuf = await drive.get('/channel.json');
          if (metaBuf) {
            const result = JSON.parse(b4a.toString(metaBuf));
            console.log('[API] Got channel:', result.name);
            return result;
          }
          return { name: 'Unknown Channel' };
        } catch (err) {
          // If the key is actually an Autobase (multi-writer) channel key, Hyperdrive will throw a decoding error.
          if (isHyperdriveDecodeError(err)) {
            console.log('[API] GET_CHANNEL: Hyperdrive decode error; retrying as multi-writer channel')
            const channel = await loadChannel(ctx, driveKey).catch(() => null)
            if (channel) {
              await markAsMultiWriterChannel(driveKey)
              const meta = await channel.getMetadata().catch(() => null)
              return {
                name: meta?.name || 'Channel',
                description: meta?.description || '',
                avatar: meta?.avatar || null,
                createdAt: meta?.createdAt || Date.now(),
                publicKey: meta?.createdBy || null
              }
            }
          }
          throw err
        }
      } catch (err) {
        console.error('[API] GET_CHANNEL error:', err.message);
        return { name: 'Unknown Channel', error: err.message };
      }
    },

    /**
     * Update channel metadata
     * @param {string} driveKey
     * @param {string} name
     * @param {string} [description]
     * @returns {Promise<{success: boolean}>}
     */
    async updateChannel(driveKey, name, description) {
      console.log('[API] UPDATE_CHANNEL:', driveKey?.slice(0, 16));
      try {
        if (await isMultiWriterChannelKey(driveKey)) {
          const channel = await loadChannel(ctx, driveKey)
          await channel.updateMetadata({ name, description: description || '', avatar: null })
          return { success: true }
        }

        const drive = ctx.drives.get(driveKey);
        if (!drive || !drive.writable) {
          throw new Error('Channel not found or not writable');
        }

        // Get existing metadata
        const metaBuf = await drive.get('/channel.json');
        let meta = {};
        if (metaBuf) {
          meta = JSON.parse(b4a.toString(metaBuf));
        }

        // Update fields
        if (name !== undefined) meta.name = name;
        if (description !== undefined) meta.description = description;
        meta.updatedAt = Date.now();

        await drive.put('/channel.json', Buffer.from(JSON.stringify(meta)));
        console.log('[API] Updated channel:', meta.name);

        return { success: true };
      } catch (err) {
        console.error('[API] UPDATE_CHANNEL error:', err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get channel metadata with video count (for public feed)
     * @param {string} driveKey
     * @returns {Promise<ChannelMetadata>}
     */
    async getChannelMeta(driveKey) {
      console.log('[API] GET_CHANNEL_META:', driveKey?.slice(0, 16));
      try {
        const cached = channelMetaCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < CHANNEL_META_CACHE_TTL_MS) {
          return cloneObject(cached.value)
        }

        // Fast path for known multi-writer channels.
        if (await isMultiWriterChannelKey(driveKey)) {
          const channel = await loadChannel(ctx, driveKey)
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
        }

        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });

        let metaBuf = null;
        try {
          const entryPromise = drive.entry('/channel.json', { wait: true });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Entry fetch timeout')), 5000)
          );
          const entry = await Promise.race([entryPromise, timeoutPromise]);
          if (entry) {
            metaBuf = await drive.get('/channel.json');
          }
        } catch (err) {
          console.log('[API] Entry wait error:', err.message, 'trying direct get...');
          metaBuf = await drive.get('/channel.json');
        }

        if (metaBuf) {
          const meta = JSON.parse(b4a.toString(metaBuf));

          // Count videos
          let videoCount = 0;
          try {
            for await (const entry of drive.readdir('/videos')) {
              if (entry.endsWith('.json')) videoCount++;
            }
          } catch {}

          console.log('[API] Got channel meta:', meta.name, 'videos:', videoCount);
          const result = {
            ...meta,
            videoCount,
            driveKey
          };
          channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneObject(result)
        }

        console.log('[API] No channel.json found for:', driveKey?.slice(0, 16));
        const result = {
          driveKey,
          name: 'Unknown Channel',
          description: '',
          videoCount: 0
        };
        channelMetaCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneObject(result)
      } catch (err) {
        // If this key is actually an Autobase (multi-writer) channel key, treating it like a Hyperdrive
        // will surface as a decoding error. Retry as multi-writer and persist the marker.
        if (isHyperdriveDecodeError(err)) {
          console.log('[API] GET_CHANNEL_META: Hyperdrive decode error; retrying as multi-writer channel')
          const channel = await loadChannel(ctx, driveKey).catch(() => null)
          if (channel) {
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
          }
        }
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
     * @returns {Promise<VideoMetadata[]>}
     */
    async listVideos(driveKey) {
      console.log('[API] LIST_VIDEOS for:', driveKey?.slice(0, 16));
      try {
        const cached = listVideosCache.get(driveKey)
        if (cached && (Date.now() - cached.ts) < LIST_VIDEOS_CACHE_TTL_MS) {
          return cloneArrayOfObjects(cached.value)
        }

        const isMW = await isMultiWriterChannelKey(driveKey)
        console.log('[API] LIST_VIDEOS isMultiWriterChannel:', isMW, 'cached:', ctx.channels?.has(driveKey))
        if (isMW) {
          const channel = await loadChannel(ctx, driveKey)
          console.log('[API] LIST_VIDEOS channel loaded, calling listVideos...')

          // IMPORTANT: Never block listVideos on network sync.
          // Mobile has a 30s init timeout, and pairing/DHT discovery can exceed that.
          // Return current materialized view immediately; the UI already retries.
          const videos = await channel.listVideos()
          console.log('[API] LIST_VIDEOS returning', videos?.length, 'videos from channel')
          const result = (videos || []).map(v => ({ ...v, channelKey: driveKey }))
          listVideosCache.set(driveKey, { ts: Date.now(), value: result })
          return cloneArrayOfObjects(result)
        }

        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 8000 });
        const videos = [];

        try {
          for await (const entry of drive.readdir('/videos')) {
            if (entry.endsWith('.json')) {
              const metaBuf = await drive.get(`/videos/${entry}`);
              if (metaBuf) {
                const video = JSON.parse(b4a.toString(metaBuf));
                video.channelKey = driveKey;
                videos.push(video);
              }
            }
          }
        } catch (e) {
          console.log('[API] Error listing videos:', e.message);
          // If the key we got from discovery is actually an Autobase channel key, Hyperdrive will throw a decoding error.
          // Retry as multi-writer channel and persist the marker so later calls (e.g. getVideoUrl) use the correct path.
          if (isHyperdriveDecodeError(e)) {
            console.log('[API] LIST_VIDEOS: Hyperdrive decode error; retrying as multi-writer channel')
            const channel = await loadChannel(ctx, driveKey).catch(() => null)
            if (channel) {
              await markAsMultiWriterChannel(driveKey)
              const mwVideos = await channel.listVideos().catch(() => [])
              console.log('[API] LIST_VIDEOS: multi-writer retry returned', mwVideos?.length || 0, 'videos')
              const result = (mwVideos || []).map(v => ({ ...v, channelKey: driveKey }))
              listVideosCache.set(driveKey, { ts: Date.now(), value: result })
              return cloneArrayOfObjects(result)
            }
          }
        }

        const result = videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        console.log('[API] Found', result.length, 'videos');
        listVideosCache.set(driveKey, { ts: Date.now(), value: result })
        return cloneArrayOfObjects(result)
      } catch (err) {
        console.error('[API] LIST_VIDEOS error:', err.message);
        return [];
      }
    },

    /**
     * Get video stream URL
     * @param {string} driveKey
     * @param {string} videoPath
     * @returns {Promise<{url: string}>}
     */
    async getVideoUrl(driveKey, videoPath) {
      console.log('[API] getVideoUrl:', driveKey?.slice(0, 16), videoPath);

      if (await isMultiWriterChannelKey(driveKey)) {
        console.log('[API] getVideoUrl: is multi-writer channel');
        const meta = await this.getVideoData(driveKey, videoPath)
        console.log('[API] getVideoUrl meta:', meta?.id, 'blobDriveKey:', meta?.blobDriveKey?.slice(0, 16), 'path:', meta?.path)
        if (!meta) {
          console.log('[API] getVideoUrl: no metadata found');
          throw new Error('Video metadata not found')
        }
        const blobDriveKey = meta.blobDriveKey || meta.blobDrive || null
        if (!blobDriveKey || !meta.path) {
          console.log('[API] getVideoUrl: missing blobDriveKey or path');
          throw new Error('Video is missing blob location (not synced yet)')
        }

        // Get blob drive from channel (uses channel's corestore and blobDrives cache)
        const channel = await loadChannel(ctx, driveKey)
        if (!channel) {
          console.log('[API] getVideoUrl: failed to load channel');
          throw new Error('Failed to load channel')
        }

        // Join swarm for blob drive if it's from another device
        if (channel.joinBlobDrive) {
          await channel.joinBlobDrive(blobDriveKey).catch(() => {})
        }

        // Get the blob drive from the channel's cache
        const blobDrive = await channel.getBlobDrive(blobDriveKey)
        console.log('[API] getVideoUrl: got blob drive from channel, calling storage.getVideoUrl with blobDriveKey:', blobDriveKey?.slice(0, 16), 'path:', meta.path);
        return getVideoUrl(ctx, blobDriveKey, meta.path, { drive: blobDrive })
      }
      // Legacy Hyperdrive channels: accept either a full path (/videos/{id}.ext) or a video id.
      let resolvedPath = videoPath
      try {
        if (typeof resolvedPath === 'string' && resolvedPath && !resolvedPath.startsWith('/')) {
          const meta = await this.getVideoData(driveKey, resolvedPath)
          if (meta?.path) resolvedPath = meta.path
        }
      } catch {}
      return getVideoUrl(ctx, driveKey, resolvedPath);
    },

    /**
     * Get video metadata by ID or path
     * @param {string} driveKey
     * @param {string} videoId - Video ID or full path
     * @returns {Promise<VideoMetadata|null>}
     */
    async getVideoData(driveKey, videoId) {
      console.log('[API] GET_VIDEO_DATA:', driveKey?.slice(0, 16), videoId);
      try {
        const isMW = await isMultiWriterChannelKey(driveKey)
        console.log('[API] GET_VIDEO_DATA isMultiWriter:', isMW)
        if (isMW) {
          const channel = await loadChannel(ctx, driveKey)
          console.log('[API] GET_VIDEO_DATA channel loaded')

          let id = videoId
          if (typeof videoId === 'string' && videoId.startsWith('/videos/')) {
            const match = videoId.match(/\/videos\/([^.]+)/)
            if (match) id = match[1]
          }
          console.log('[API] GET_VIDEO_DATA looking up id:', id)

          const v = await channel.getVideo(id)
          console.log('[API] GET_VIDEO_DATA result:', v?.id, 'blobDriveKey:', v?.blobDriveKey?.slice(0, 16), 'path:', v?.path)
          if (!v) return null
          return { ...v, channelKey: driveKey }
        }

        const drive = await loadDrive(ctx, driveKey, { waitForSync: true, syncTimeout: 5000 });

        // videoId could be a full path like /videos/xxx.mp4 or just the id
        let metaPath;
        if (videoId.startsWith('/videos/')) {
          // Extract ID from path
          const match = videoId.match(/\/videos\/([^.]+)/);
          if (match) {
            metaPath = `/videos/${match[1]}.json`;
          } else {
            return null;
          }
        } else {
          metaPath = `/videos/${videoId}.json`;
        }

        const metaBuf = await drive.get(metaPath);
        if (metaBuf) {
          const video = JSON.parse(b4a.toString(metaBuf));
          video.channelKey = driveKey;
          return video;
        }
        return null;
      } catch (err) {
        console.error('[API] GET_VIDEO_DATA error:', err.message);
        return null;
      }
    },

/**
     * Delete a video from a channel drive
     * @param {import('hyperdrive')} drive - The writable drive
     * @param {string} videoId - Video ID to delete
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async deleteVideo(drive, videoId) {
      console.log('[API] DELETE_VIDEO:', videoId);

      if (!drive || !drive.writable) {
        return { success: false, error: 'Drive not writable' };
      }

      try {
        // Delete video metadata
        const metaPath = `/videos/${videoId}.json`;
        const metaBuf = await drive.get(metaPath);

        if (!metaBuf) {
          return { success: false, error: 'Video not found' };
        }

        const meta = JSON.parse(b4a.toString(metaBuf));

        // Delete the video file
        if (meta.path) {
          try {
            await drive.del(meta.path);
            console.log('[API] Deleted video file:', meta.path);
          } catch (e) {
            console.log('[API] Could not delete video file:', e.message);
          }
        }

        // Delete thumbnail if exists
        if (meta.thumbnail) {
          try {
            await drive.del(meta.thumbnail);
            console.log('[API] Deleted thumbnail:', meta.thumbnail);
          } catch (e) {
            console.log('[API] Could not delete thumbnail:', e.message);
          }
        }

        // Also try common thumbnail paths
        const thumbnailPaths = [
          `/thumbnails/${videoId}.jpg`,
          `/thumbnails/${videoId}.png`,
          `/thumbnails/${videoId}.webp`,
          `/thumbnails/${videoId}.jpeg`
        ];

        for (const thumbPath of thumbnailPaths) {
          try {
            await drive.del(thumbPath);
          } catch (e) {
            // Ignore - file might not exist
          }
        }

        // Delete the metadata file
        await drive.del(metaPath);
        console.log('[API] Deleted video metadata:', metaPath);

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
      console.log('[API] GET_VIDEO_THUMBNAIL:', driveKey?.slice(0, 16), videoId);
      try {
        let sourceDriveKey = driveKey
        let resolvedId = videoId
        let preferredThumbPath = null

        if (await isMultiWriterChannelKey(driveKey)) {
          const meta = await this.getVideoData(driveKey, videoId)
          if (meta?.blobDriveKey) sourceDriveKey = meta.blobDriveKey
          if (meta?.id) resolvedId = meta.id
          if (typeof meta?.thumbnail === 'string' && meta.thumbnail.startsWith('/')) {
            preferredThumbPath = meta.thumbnail
          }
        } else if (typeof videoId === 'string' && videoId.startsWith('/videos/')) {
          const match = videoId.match(/\/videos\/([^.]+)/)
          if (match) resolvedId = match[1]
        }

        const drive = await loadDrive(ctx, sourceDriveKey, { waitForSync: true, syncTimeout: 5000 });

        const thumbnailPaths = [
          ...(preferredThumbPath ? [preferredThumbPath] : []),
          `/thumbnails/${resolvedId}.jpg`,
          `/thumbnails/${resolvedId}.png`,
          `/thumbnails/${resolvedId}.webp`,
          `/thumbnails/${resolvedId}.jpeg`,
          `/thumbnails/${resolvedId}.gif`
        ];

        for (const thumbPath of thumbnailPaths) {
          const entry = await drive.entry(thumbPath).catch(() => null);
          const mime = thumbPath.endsWith('.png') ? 'image/png' :
                       thumbPath.endsWith('.webp') ? 'image/webp' :
                       thumbPath.endsWith('.gif') ? 'image/gif' : 'image/jpeg';

          if (entry && entry.value?.blob) {
            const blobsCore = await drive.getBlobs();
            if (blobsCore) {
              const url = ctx.blobServer.getLink(blobsCore.core.key, {
                blob: entry.value.blob,
                type: mime,
                host: ctx.blobServerHost || '127.0.0.1',
                port: ctx.blobServer?.port || ctx.blobServerPort
              });
              console.log('[API] Thumbnail URL:', url);
              return { url, exists: true };
            }
          } else if (entry) {
            // Inline entry - return data URL without mutating the drive
            const buf = await drive.get(thumbPath).catch(() => null);
            if (buf) {
              const dataUrl = `data:${mime};base64,${b4a.from(buf).toString('base64')}`;
              return { url: dataUrl, dataUrl, exists: true };
            }
          }
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
      // Don't let loadDrive hang forever - use a 5s timeout
      // If it times out, we still add to subscriptions (data will sync later when peers are found)
      try {
        await Promise.race([
          loadDrive(ctx, driveKey),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Drive load timeout')), 5000))
        ]);
      } catch (err) {
        console.log('[API] subscribeChannel: drive load warning:', err.message, '- continuing anyway');
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
        const drive = ctx.drives.get(sub.driveKey);
        let name = 'Unknown';
        if (drive) {
          try {
            const meta = await drive.get('/channel.json');
            if (meta) {
              name = JSON.parse(b4a.toString(meta)).name;
            }
          } catch (e) {}
        }
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
      const feed = publicFeed.getFeed();
      const stats = publicFeed.getStats();
      console.log(`[API] Returning ${feed.length} feed entries (${stats.peerCount} peers)`);
      return { entries: feed, stats };
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
        await publicFeed.submitChannel(driveKey);
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
    async prefetchVideo(driveKey, videoPath) {
      const prefetchStart = Date.now();

      console.log('[API] ===== STARTING PREFETCH =====');
      console.log('[API] Drive:', driveKey?.slice(0, 16));
      console.log('[API] Path:', videoPath);

      // Check if corestore is still open
      if (ctx.store.closed) {
        console.log('[API] Corestore is closed, skipping prefetch');
        return { success: false, error: 'Corestore is closed' };
      }

      // Multi-writer channels: resolve the blob source drive+path (per-writer Hyperdrive)
      let resolvedDriveKey = driveKey
      let resolvedPath = videoPath
      let isMultiWriter = await isMultiWriterChannelKey(driveKey)
      let channel = null
      if (isMultiWriter) {
        const v = await this.getVideoData(driveKey, videoPath)
        if (v?.blobDriveKey && v?.path) {
          resolvedDriveKey = v.blobDriveKey
          resolvedPath = v.path

          // Get channel for blob drive access
          channel = await loadChannel(ctx, driveKey)
          // Join swarm for blob drive if it's from another device
          if (channel?.joinBlobDrive) {
            await channel.joinBlobDrive(resolvedDriveKey).catch(() => {})
          }
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
        // For multi-writer channels, get blob drive from channel's cache
        // For legacy drives, use loadDrive from storage
        let drive;
        if (isMultiWriter && channel) {
          drive = await channel.getBlobDrive(resolvedDriveKey);
          console.log('[API] Prefetch: using blob drive from channel');
        } else {
          drive = await loadDrive(ctx, resolvedDriveKey, { waitForSync: true, syncTimeout: 10000 });
        }
        const peerCount = ctx.swarm?.connections?.size || 0;
        console.log('[API] Active swarm connections:', peerCount);

        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { peerCount, status: 'resolving' });
        }

        // Get the blob entry
        const entry = await drive.entry(resolvedPath);
        if (!entry || !entry.value?.blob) {
          throw new Error('Video not found in drive');
        }

        const blob = entry.value.blob;
        console.log('[API] Blob info:', JSON.stringify(blob));

        const blobsCore = await drive.getBlobs();
        if (!blobsCore) {
          throw new Error('Could not get blobs core');
        }

        const core = blobsCore.core;
        const startBlock = blob.blockOffset;
        const endBlock = blob.blockOffset + blob.blockLength;
        const totalBlocks = blob.blockLength;
        const totalBytes = blob.byteLength;

        // Count initial blocks already available
        let initialAvailable = 0;
        for (let i = startBlock; i < endBlock; i++) {
          if (core.has(i)) initialAvailable++;
        }
        console.log(`[API] Initial: ${initialAvailable}/${totalBlocks} blocks (${Math.round(initialAvailable/totalBlocks*100)}%)`);

        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, {
            status: initialAvailable === totalBlocks ? 'complete' : 'downloading',
            totalBlocks,
            totalBytes,
            initialBlocks: initialAvailable,
            downloadedBlocks: 0
          });
          videoStats.emitStats(driveKey, videoPath);
        }

        // If already complete, skip download
        if (initialAvailable === totalBlocks) {
          console.log('[API] Already fully cached');
          if (seedingManager) {
            await seedingManager.addSeed(resolvedDriveKey, resolvedPath, 'watched', blob);
          }
          return {
            success: true,
            totalBlocks,
            totalBytes,
            peerCount,
            cached: true,
            message: 'Video already fully cached'
          };
        }

        // Create monitor for progress tracking
        const monitor = drive.monitor(resolvedPath);
        await monitor.ready();

        let lastLoggedProgress = Math.round((initialAvailable / totalBlocks) * 100);
        let markedAsCached = false;

        const onUpdate = async () => {
          try {
            const stats = monitor.downloadStats;
            const downloadedBlocks = stats.blocks;
            const totalDownloaded = initialAvailable + downloadedBlocks;
            const progress = Math.round((totalDownloaded / totalBlocks) * 100);
            const isComplete = totalDownloaded >= totalBlocks;

            if (videoStats) {
              videoStats.updateStats(driveKey, videoPath, {
                downloadedBlocks,
                peerCount: stats.peers || ctx.swarm?.connections?.size || 0,
                status: isComplete ? 'complete' : 'downloading'
              });
              videoStats.emitStats(driveKey, videoPath);
            }

            if (progress >= lastLoggedProgress + 10 || progress === 100) {
              const speed = monitor.downloadSpeed();
              console.log(`[API] Progress: ${progress}% (${totalDownloaded}/${totalBlocks} blocks, ${(speed / (1024 * 1024)).toFixed(2)} MB/s)`);
              lastLoggedProgress = progress;
            }

            if (isComplete && !markedAsCached) {
              markedAsCached = true;
              console.log('[API] 100% complete');
              if (seedingManager) {
                await seedingManager.addSeed(resolvedDriveKey, resolvedPath, 'watched', blob);
              }
            }
          } catch (e) {
            // Ignore errors during progress check
          }
        };

        monitor.on('update', onUpdate);

        if (videoStats) {
          videoStats.registerMonitor(driveKey, videoPath, monitor, () => monitor.off('update', onUpdate));
        }

        // Start downloading all blocks
        const downloadRange = core.download({ start: startBlock, end: endBlock });

        // Handle completion (async, don't await)
        downloadRange.done().then(async () => {
          console.log('[API] Download complete');
          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, { status: 'complete' });
            // Clean up after delay
            setTimeout(() => videoStats.cleanupMonitor(driveKey, videoPath), 30000);
          }
        }).catch(err => {
          // Don't log as error if corestore was closed (expected during app shutdown)
          if (err.message?.includes('closed') || ctx.store.closed) {
            console.log('[API] Prefetch cancelled (corestore closed)');
          } else {
            console.error('[API] Prefetch error:', err.message);
          }
          if (videoStats) {
            videoStats.updateStats(driveKey, videoPath, { status: 'cancelled' });
            videoStats.cleanupMonitor(driveKey, videoPath);
          }
        });

        return {
          success: true,
          totalBlocks,
          totalBytes,
          peerCount,
          initialBlocks: initialAvailable,
          message: 'Prefetch started'
        };
      } catch (err) {
        console.error('[API] Prefetch error:', err.message);
        if (videoStats) {
          videoStats.updateStats(driveKey, videoPath, { status: 'error', error: err.message });
          videoStats.cleanupMonitor(driveKey, videoPath);
        }
        return { success: false, error: err.message };
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
        await loadDrive(ctx, driveKey);
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
        drivesLoaded: ctx.drives.size,
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

      // Initialize semantic finder if not already done
      if (!ctx.semanticFinder) {
        ctx.semanticFinder = new SemanticFinder()
        await ctx.semanticFinder.init()
      }

      // Ensure channel vectors are loaded into the local index (multi-writer channels persist vectors in the view)
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
          const channel = await loadChannel(ctx, channelKey)
          await ctx.semanticFinder.ensureIndexedFromChannelView(channelKey, channel)

          // Backfill missing vector records (writable peers only), limited per call to avoid DoS.
          // Read-only peers will still be able to search whatever vectors exist in the view.
          if (channel?.writable) {
            try {
              const videos = await channel.listVideos().catch(() => [])
              let backfilled = 0
              for (const v of videos) {
                if (!v?.id) continue
                if (backfilled >= 3) break
                const existing = await channel.view.get(`vectors/${v.id}`).catch(() => null)
                if (existing?.value?.vector) continue
                const res = await this.indexVideoVectors(channelKey, v.id)
                if (res?.success) backfilled++
              }
            } catch {}
          }
        }
      } catch {}

      // Initialize federated search if not already done
      if (!ctx.federatedSearch && ctx.swarm) {
        ctx.federatedSearch = new FederatedSearch(ctx.swarm, ctx.semanticFinder, {
          ensureIndexed: async (ck) => {
            try {
              const ch = await loadChannel(ctx, ck)
              await ctx.semanticFinder.ensureIndexedFromChannelView(ck, ch)
            } catch {}
          }
        })
        const channelKeyBuf = b4a.from(channelKey, 'hex')
        ctx.federatedSearch.setupTopic(channelKeyBuf)
      }

      // Use federated search if available, otherwise local only
      if (ctx.federatedSearch && federated) {
        return await ctx.federatedSearch.search(query, { topK, federated, timeout: 5000, channelKey })
      } else {
        return await ctx.semanticFinder.search(query, topK, { channelKey })
      }
    },

    /**
     * Index a video for semantic search
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

        // Initialize semantic finder if not already done
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

        // Index the video
        await ctx.semanticFinder.indexVideo(
          videoId,
          video.title || '',
          video.description || '',
          { channelKey, ...video }
        )

        // Store vector index op in Autobase (for replication)
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (isMW) {
          const channel = await loadChannel(ctx, channelKey)
          const embedding = await ctx.semanticFinder.embed(`${video.title || ''} ${video.description || ''}`)
          const vectorBase64 = b4a.toString(Buffer.from(embedding.buffer), 'base64')

          await channel.appendOp({
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
    // Comments Operations
    // ============================================

    /**
     * Add a comment to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} text
     * @param {string} [parentId]
     * @returns {Promise<{success: boolean, commentId?: string, error?: string}>}
     */
    async addComment(channelKey, videoId, text, parentId = null) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Comments only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.comments) {
          return { success: false, error: 'Comments not initialized' }
        }

        const result = await channel.comments.addComment(videoId, text, parentId)
        return { success: true, commentId: result.commentId }
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
     * @returns {Promise<{comments: Array, success: boolean, error?: string}>}
     */
    async listComments(channelKey, videoId, options = {}) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, comments: [], error: 'Comments only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.comments) {
          return { success: false, comments: [], error: 'Comments not initialized' }
        }

        const comments = await channel.comments.listComments(videoId, options)
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
    async hideComment(channelKey, videoId, commentId) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Comments only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.comments) {
          return { success: false, error: 'Comments not initialized' }
        }

        await channel.comments.hideComment(videoId, commentId)
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
    async removeComment(channelKey, videoId, commentId) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Comments only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.comments) {
          return { success: false, error: 'Comments not initialized' }
        }

        await channel.comments.removeComment(videoId, commentId)
        return { success: true }
      } catch (err) {
        console.error('[API] removeComment error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ============================================
    // Reactions Operations
    // ============================================

    /**
     * Add a reaction to a video
     * @param {string} channelKey
     * @param {string} videoId
     * @param {string} reactionType
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async addReaction(channelKey, videoId, reactionType) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Reactions only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.reactions) {
          return { success: false, error: 'Reactions not initialized' }
        }

        await channel.reactions.addReaction(videoId, reactionType)
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
    async removeReaction(channelKey, videoId) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, error: 'Reactions only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.reactions) {
          return { success: false, error: 'Reactions not initialized' }
        }

        await channel.reactions.removeReaction(videoId)
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
    async getReactions(channelKey, videoId) {
      try {
        const isMW = await isMultiWriterChannelKey(channelKey)
        if (!isMW) {
          return { success: false, counts: {}, userReaction: null, error: 'Reactions only supported for multi-writer channels' }
        }

        const channel = await loadChannel(ctx, channelKey)
        if (!channel.reactions) {
          return { success: false, counts: {}, userReaction: null, error: 'Reactions not initialized' }
        }

        const result = await channel.reactions.getReactions(videoId)
        return { success: true, ...result }
      } catch (err) {
        console.error('[API] getReactions error:', err.message)
        return { success: false, counts: {}, userReaction: null, error: err.message }
      }
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

        // Initialize semantic finder if needed
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

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

        // Initialize semantic finder if needed
        if (!ctx.semanticFinder) {
          ctx.semanticFinder = new SemanticFinder()
          await ctx.semanticFinder.init()
        }

        // Initialize recommender (watch logger may be null, that's ok)
        const watchLogger = channel.watchLogger || null
        const recommender = new Recommender(channel, ctx.semanticFinder, watchLogger)
        const recommendations = await recommender.getVideoRecommendations(videoId, limit)

        return { success: true, recommendations }
      } catch (err) {
        console.error('[API] getVideoRecommendations error:', err.message)
        return { success: false, recommendations: [], error: err.message }
      }
    }
  };
}
